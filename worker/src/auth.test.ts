import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { sha256, bearerAuth, adminAuth } from './auth.js';
import { putClient } from './kv.js';
import type { ClientRecord, Env, Variables } from './types.js';

function makeKv() {
  const store = new Map<string, string>();
  return {
    store,
    kv: {
      async get(key: string) { return store.get(key) ?? null; },
      async put(key: string, value: string) { store.set(key, value); },
      async delete(key: string) { store.delete(key); },
    } as unknown as KVNamespace,
  };
}

function makeEnv(kv: KVNamespace, overrides: Partial<Env> = {}): Env {
  return {
    DDNS_KV: kv,
    BASE_DOMAIN: 'ddns.example.com',
    MAX_SUBDOMAIN_LENGTH: '63',
    DEFAULT_TTL: '60',
    STALE_DAYS: '30',
    CF_API_TOKEN: 'tok',
    CF_ZONE_ID: 'zone',
    ADMIN_SECRET: 'super-secret',
    ...overrides,
  };
}

const BASE_RECORD: ClientRecord = {
  token: '',
  subdomain: 'myserver',
  owner_email: null,
  created_at: '2025-01-01T00:00:00Z',
  last_seen: null,
  ip: null,
  ipv6: null,
  port: null,
  srv_prefix: null,
  ttl: 60,
  update_interval: 300,
  tags: [],
  metadata: {},
  webhook_url: null,
  webhook_secret: null,
  allowed_update_ips: null,
  custom_domains: [],
  enabled: true,
  redirect_http: false,
  notes: null,
};

function makeApp(kv: KVNamespace, adminSecret = 'super-secret') {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('/protected/*', bearerAuth);
  app.use('/admin/*', adminAuth);
  app.get('/protected/me', (c) => c.json({ subdomain: c.get('client').subdomain }));
  app.get('/admin/stats', (c) => c.json({ ok: true }));
  return { app, env: makeEnv(kv, { ADMIN_SECRET: adminSecret }) };
}

describe('sha256', () => {
  it('produces a 64-char lowercase hex string', async () => {
    const hash = await sha256('hello');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic', async () => {
    expect(await sha256('token-abc')).toBe(await sha256('token-abc'));
  });

  it('differs for different inputs', async () => {
    expect(await sha256('a')).not.toBe(await sha256('b'));
  });
});

describe('bearerAuth', () => {
  it('returns 401 missing_token when Authorization header is absent', async () => {
    const { app, env } = makeApp(makeKv().kv);
    const res = await app.request('/protected/me', {}, env);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'missing_token' });
  });

  it('returns 401 missing_token for non-Bearer scheme', async () => {
    const { app, env } = makeApp(makeKv().kv);
    const res = await app.request('/protected/me', {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    }, env);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'missing_token' });
  });

  it('returns 401 invalid_token for an unknown token', async () => {
    const { app, env } = makeApp(makeKv().kv);
    const res = await app.request('/protected/me', {
      headers: { Authorization: 'Bearer unknown-token' },
    }, env);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'invalid_token' });
  });

  it('resolves to the correct ClientRecord and attaches it to context', async () => {
    const { kv } = makeKv();
    const plainToken = 'my-plain-token';
    const hash = await sha256(plainToken);
    const record: ClientRecord = { ...BASE_RECORD, token: hash };
    await putClient(kv, record);

    const { app, env } = makeApp(kv);
    const res = await app.request('/protected/me', {
      headers: { Authorization: `Bearer ${plainToken}` },
    }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subdomain: 'myserver' });
  });

  it('returns 403 account_disabled when enabled is false', async () => {
    const { kv } = makeKv();
    const plainToken = 'disabled-token';
    const hash = await sha256(plainToken);
    await putClient(kv, { ...BASE_RECORD, token: hash, enabled: false });

    const { app, env } = makeApp(kv);
    const res = await app.request('/protected/me', {
      headers: { Authorization: `Bearer ${plainToken}` },
    }, env);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'account_disabled' });
  });
});

describe('adminAuth', () => {
  it('returns 403 when X-Admin-Secret is missing', async () => {
    const { app, env } = makeApp(makeKv().kv);
    const res = await app.request('/admin/stats', {}, env);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'forbidden' });
  });

  it('returns 403 for a wrong secret', async () => {
    const { app, env } = makeApp(makeKv().kv);
    const res = await app.request('/admin/stats', {
      headers: { 'X-Admin-Secret': 'wrong' },
    }, env);
    expect(res.status).toBe(403);
  });

  it('passes through with the correct secret', async () => {
    const { app, env } = makeApp(makeKv().kv);
    const res = await app.request('/admin/stats', {
      headers: { 'X-Admin-Secret': 'super-secret' },
    }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
