import type { MiddlewareHandler } from 'hono';
import { getClient } from './kv.js';
import type { Env, Variables } from './types.js';

type AppMiddleware = MiddlewareHandler<{ Bindings: Env; Variables: Variables }>;

export async function sha256(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export const bearerAuth: AppMiddleware = async (c, next) => {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    return c.json({ error: 'missing_token', message: 'Authorization header required' }, 401);
  }

  const hash = await sha256(header.slice(7));
  const record = await getClient(c.env.DDNS_KV, hash);

  if (record === null) {
    return c.json({ error: 'invalid_token', message: 'Token not recognised' }, 401);
  }
  if (!record.enabled) {
    return c.json({ error: 'account_disabled', message: 'This account has been disabled' }, 403);
  }

  c.set('client', record);
  return next();
};

export const adminAuth: AppMiddleware = async (c, next) => {
  const submitted = c.req.header('X-Admin-Secret') ?? '';
  if (!timingSafeEqual(submitted, c.env.ADMIN_SECRET)) {
    return c.json({ error: 'forbidden', message: 'Invalid or missing admin secret' }, 403);
  }
  return next();
};

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}
