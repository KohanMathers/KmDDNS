import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, bearerAuth, adminAuth } from './auth.js';
import { putClient } from './db.js';
import type { ClientRecord, Env, Variables } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(__dirname, '../migrations/0001_initial.sql'), 'utf8');

function makeDb(): D1Database {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(SCHEMA);

  function boundStmt(sql: string, params: unknown[]) {
    return {
      async first<T>() {
        return (sqlite.prepare(sql).get(params as unknown[]) as T | null) ?? null;
      },
      async all<T>() {
        return { results: sqlite.prepare(sql).all(params as unknown[]) as T[], meta: {} };
      },
      async run() {
        sqlite.prepare(sql).run(params as unknown[]);
        return { results: [], success: true, meta: { last_row_id: 0, changes: 0 } };
      },
      _sql: sql,
      _params: params,
    };
  }

  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) { return boundStmt(sql, params); },
      } as unknown as D1PreparedStatement;
    },
    async batch(statements: ReturnType<typeof boundStmt>[]) {
      const results: { results: unknown[]; success: boolean; meta: object }[] = [];
      const tx = sqlite.transaction(() => {
        for (const s of statements) {
          let rows: unknown[];
          try {
            rows = sqlite.prepare(s._sql).all(s._params as unknown[]);
          } catch {
            sqlite.prepare(s._sql).run(s._params as unknown[]);
            rows = [];
          }
          results.push({ results: rows, success: true, meta: {} });
        }
      });
      tx();
      return results as Awaited<ReturnType<D1Database['batch']>>;
    },
    async dump() { return new ArrayBuffer(0); },
    async exec(sql: string) { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  } as unknown as D1Database;
}

function makeEnv(db: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    kmddns: db,
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

let db: D1Database;
beforeEach(() => { db = makeDb(); });

function makeApp(adminSecret = 'super-secret') {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('/protected/*', bearerAuth);
  app.use('/admin/*', adminAuth);
  app.get('/protected/me', (c) => c.json({ subdomain: c.get('client').subdomain }));
  app.get('/admin/stats', (c) => c.json({ ok: true }));
  return { app, env: makeEnv(db, { ADMIN_SECRET: adminSecret }) };
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
    const { app, env } = makeApp();
    const res = await app.request('/protected/me', {}, env);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'missing_token' });
  });

  it('returns 401 missing_token for non-Bearer scheme', async () => {
    const { app, env } = makeApp();
    const res = await app.request('/protected/me', {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    }, env);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'missing_token' });
  });

  it('returns 401 invalid_token for an unknown token', async () => {
    const { app, env } = makeApp();
    const res = await app.request('/protected/me', {
      headers: { Authorization: 'Bearer unknown-token' },
    }, env);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'invalid_token' });
  });

  it('resolves to the correct ClientRecord and attaches it to context', async () => {
    const plainToken = 'my-plain-token';
    const hash = await sha256(plainToken);
    const record: ClientRecord = { ...BASE_RECORD, token: hash };
    await putClient(db, record);

    const { app, env } = makeApp();
    const res = await app.request('/protected/me', {
      headers: { Authorization: `Bearer ${plainToken}` },
    }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subdomain: 'myserver' });
  });

  it('returns 403 account_disabled when enabled is false', async () => {
    const plainToken = 'disabled-token';
    const hash = await sha256(plainToken);
    await putClient(db, { ...BASE_RECORD, token: hash, enabled: false });

    const { app, env } = makeApp();
    const res = await app.request('/protected/me', {
      headers: { Authorization: `Bearer ${plainToken}` },
    }, env);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'account_disabled' });
  });
});

describe('adminAuth', () => {
  it('returns 403 when X-Admin-Secret is missing', async () => {
    const { app, env } = makeApp();
    const res = await app.request('/admin/stats', {}, env);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'forbidden' });
  });

  it('returns 403 for a wrong secret', async () => {
    const { app, env } = makeApp();
    const res = await app.request('/admin/stats', {
      headers: { 'X-Admin-Secret': 'wrong' },
    }, env);
    expect(res.status).toBe(403);
  });

  it('passes through with the correct secret', async () => {
    const { app, env } = makeApp();
    const res = await app.request('/admin/stats', {
      headers: { 'X-Admin-Secret': 'super-secret' },
    }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
