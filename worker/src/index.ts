import { Hono } from 'hono';
import type { Env, Variables } from './types.js';
import { bearerAuth } from './auth.js';
import { handleRegister } from './handlers/register.js';
import { handleUpdateGet, handleUpdatePost } from './handlers/update.js';
import { handleGetClient, handlePatchClient, handleRotateToken, handleDeleteClient } from './handlers/client.js';
import { handleLookup } from './handlers/lookup.js';
import { handlePostCustomDomain, handleVerifyCustomDomain, handleDeleteCustomDomain } from './handlers/customdomain.js';
import { handleAdminListClients, handleAdminDeleteClient, handleAdminBan, handleAdminStats } from './handlers/admin.js';
import { adminAuth } from './auth.js';
import { checkGlobalLimit } from './ratelimit.js';
import { handleScheduled } from './scheduled.js';
import { getClient, getBySubdomain } from './db.js';
export { TunnelSession } from './tunnel.js';

const VERSION = '0.1.0';
const startTime = Date.now();

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function isHttpsRequest(c: { req: { url: string; raw: Request } }): boolean {
  const url = new URL(c.req.url);
  if (url.protocol === 'https:') return true;
  const cf = (c.req.raw as Request & { cf?: { tlsVersion?: string } }).cf;
  return Boolean(cf?.tlsVersion);
}

app.use('*', async (c, next) => {
  if (!isHttpsRequest(c)) {
    return c.json({ error: 'invalid_scheme', message: 'HTTPS is required' }, 400);
  }
  return next();
});

// 300 req/min per IP across all endpoints
app.use('*', async (c, next) => {
  const ip = c.req.header('CF-Connecting-IP') ?? '0.0.0.0';
  const { allowed, retryAfter } = await checkGlobalLimit(c.env.kmddns, ip);
  if (!allowed) {
    return c.json(
      { error: 'rate_limited', message: 'Too many requests' },
      429,
      { 'Retry-After': String(retryAfter) },
    );
  }
  return next();
});

app.post('/v1/register', handleRegister);
app.get('/v1/update', handleUpdateGet);
app.post('/v1/update', bearerAuth, handleUpdatePost);

app.get('/v1/client', bearerAuth, handleGetClient);
app.patch('/v1/client', bearerAuth, handlePatchClient);
app.post('/v1/client/rotate-token', bearerAuth, handleRotateToken);
app.delete('/v1/client', bearerAuth, handleDeleteClient);

app.post('/v1/custom-domain', bearerAuth, handlePostCustomDomain);
app.get('/v1/custom-domain/verify', bearerAuth, handleVerifyCustomDomain);
app.delete('/v1/custom-domain', bearerAuth, handleDeleteCustomDomain);

app.get('/v1/lookup/:subdomain', handleLookup);

app.get('/admin/clients', adminAuth, handleAdminListClients);
app.delete('/admin/client/:token', adminAuth, handleAdminDeleteClient);
app.post('/admin/ban', adminAuth, handleAdminBan);
app.get('/admin/stats', adminAuth, handleAdminStats);

/**
 * GET /v1/tunnel — host (mod) WebSocket connection, authenticated via Bearer token.
 * Upgrades to WebSocket and forwards to the TunnelSession Durable Object.
 */
app.get('/v1/tunnel', bearerAuth, async (c) => {
  const client = c.get('client')!;
  if (!client.tunnel_enabled) {
    return c.json({ error: 'tunnel_disabled', message: 'Tunnel is not enabled for this client' }, 403);
  }

  const id = c.env.TUNNEL_SESSION.idFromName(client.token);
  const stub = c.env.TUNNEL_SESSION.get(id);
  return stub.fetch(c.req.raw);
});

/**
 * GET /v1/tunnel/relay/:subdomain — relay WebSocket connection, authenticated via X-Relay-Secret header.
 * Upgrades to WebSocket and forwards to the TunnelSession Durable Object.
 */
app.get('/v1/tunnel/relay/:subdomain', async (c) => {
  const secret = c.req.header('X-Relay-Secret');
  if (!secret || secret !== c.env.RELAY_SECRET) {
    return c.json({ error: 'unauthorized', message: 'Invalid relay secret' }, 401);
  }

  const subdomain = c.req.param('subdomain');
  const token = await getBySubdomain(c.env.kmddns, subdomain);
  if (token === null) {
    return c.json({ error: 'not_found', message: 'Subdomain not found' }, 404);
  }

  const record = await getClient(c.env.kmddns, token);
  if (record === null || !record.enabled || !record.tunnel_enabled) {
    return c.json({ error: 'not_found', message: 'Tunnel not active for this subdomain' }, 404);
  }

  const id = c.env.TUNNEL_SESSION.idFromName(token);
  const stub = c.env.TUNNEL_SESSION.get(id);

  const url = new URL(c.req.url);
  url.pathname = '/relay';
  return stub.fetch(new Request(url.toString(), c.req.raw));
});

app.get('/v1/health', (c) => {
  return c.json({
    status: 'ok',
    version: VERSION,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
});

// Workers reset on cold start, so uptime resets per isolate — expected behaviour.
app.notFound((c) => c.json({ error: 'not_found', message: 'Unknown route' }, 404));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'internal_error', message: 'An unexpected error occurred' }, 500);
});

export default {
  fetch: app.fetch.bind(app),
  scheduled: handleScheduled,
};
