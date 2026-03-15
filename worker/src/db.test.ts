import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getClient, putClient, deleteClient,
  getBySubdomain,
  getByCustomDomain, putCustomDomainIndex, deleteCustomDomainIndex,
  rotateClientToken,
  writeAudit, isRateLimitExceeded,
} from './db.js';
import type { ClientRecord, AuditEntry } from './types.js';

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

const BASE_RECORD: ClientRecord = {
  token: 'abc123hash',
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
  tunnel_enabled: false,
};

let db: D1Database;
beforeEach(() => { db = makeDb(); });

describe('getClient / putClient', () => {
  it('round-trips a record with no data loss', async () => {
    const record: ClientRecord = { ...BASE_RECORD, port: 25565, tags: ['minecraft'] };
    await putClient(db, record);
    expect(await getClient(db, record.token)).toEqual(record);
  });

  it('returns null for a missing key', async () => {
    expect(await getClient(db, 'nosuchtoken')).toBeNull();
  });

  it('upserts correctly on second write', async () => {
    await putClient(db, BASE_RECORD);
    const updated = { ...BASE_RECORD, ip: '1.2.3.4' };
    await putClient(db, updated);
    expect((await getClient(db, BASE_RECORD.token))?.ip).toBe('1.2.3.4');
  });
});

describe('deleteClient', () => {
  it('removes the record', async () => {
    await putClient(db, BASE_RECORD);
    await deleteClient(db, BASE_RECORD.token);
    expect(await getClient(db, BASE_RECORD.token)).toBeNull();
  });

  it('cascades to custom_domains', async () => {
    const record: ClientRecord = { ...BASE_RECORD, custom_domains: ['mc.example.com'] };
    await putClient(db, record);
    await putCustomDomainIndex(db, 'mc.example.com', record.token);
    await deleteClient(db, record.token);
    expect(await getByCustomDomain(db, 'mc.example.com')).toBeNull();
  });

  it('does not throw when record is already missing', async () => {
    await expect(deleteClient(db, 'nosuchtoken')).resolves.toBeUndefined();
  });
});

describe('subdomain lookup', () => {
  it('returns token for a registered subdomain', async () => {
    await putClient(db, BASE_RECORD);
    expect(await getBySubdomain(db, 'myserver')).toBe('abc123hash');
  });

  it('returns null for unknown subdomain', async () => {
    expect(await getBySubdomain(db, 'unknown')).toBeNull();
  });
});

describe('custom domain index', () => {
  it('round-trips hostname to token', async () => {
    await putClient(db, BASE_RECORD);
    await putCustomDomainIndex(db, 'mc.example.com', BASE_RECORD.token);
    expect(await getByCustomDomain(db, 'mc.example.com')).toBe('abc123hash');
  });

  it('deleteCustomDomainIndex removes the entry', async () => {
    await putClient(db, BASE_RECORD);
    await putCustomDomainIndex(db, 'mc.example.com', BASE_RECORD.token);
    await deleteCustomDomainIndex(db, 'mc.example.com');
    expect(await getByCustomDomain(db, 'mc.example.com')).toBeNull();
  });
});

describe('rotateClientToken', () => {
  it('updates the token and preserves custom domains', async () => {
    const record: ClientRecord = { ...BASE_RECORD, custom_domains: ['mc.example.com'] };
    await putClient(db, record);
    await putCustomDomainIndex(db, 'mc.example.com', record.token);

    await rotateClientToken(db, 'abc123hash', 'newhash456');

    expect(await getClient(db, 'newhash456')).not.toBeNull();
    expect(await getClient(db, 'abc123hash')).toBeNull();
    expect(await getByCustomDomain(db, 'mc.example.com')).toBe('newhash456');
  });
});

describe('writeAudit', () => {
  it('stores entry without error', async () => {
    const entry: AuditEntry = {
      action: 'update',
      source_ip: '1.2.3.4',
      timestamp: '2025-01-01T00:00:00.000Z',
      details: { ip: '1.2.3.4' },
    };
    await expect(writeAudit(db, 'abc123hash', entry)).resolves.toBeUndefined();
  });
});

describe('isRateLimitExceeded', () => {
  it('allows requests below the limit', async () => {
    expect(await isRateLimitExceeded(db, 'ip:1.2.3.4', 3, 60)).toBe(false);
    expect(await isRateLimitExceeded(db, 'ip:1.2.3.4', 3, 60)).toBe(false);
    expect(await isRateLimitExceeded(db, 'ip:1.2.3.4', 3, 60)).toBe(false);
  });

  it('rejects when the limit is reached', async () => {
    await isRateLimitExceeded(db, 'ip:1.2.3.4', 2, 60);
    await isRateLimitExceeded(db, 'ip:1.2.3.4', 2, 60);
    expect(await isRateLimitExceeded(db, 'ip:1.2.3.4', 2, 60)).toBe(true);
  });

  it('increments correctly and stops at max', async () => {
    expect(await isRateLimitExceeded(db, 'tok:xyz', 1, 60)).toBe(false);
    expect(await isRateLimitExceeded(db, 'tok:xyz', 1, 60)).toBe(true);
  });

  it('isolates different rate limit keys', async () => {
    await isRateLimitExceeded(db, 'ip:1.1.1.1', 1, 60);
    expect(await isRateLimitExceeded(db, 'ip:2.2.2.2', 1, 60)).toBe(false);
    expect(await isRateLimitExceeded(db, 'ip:1.1.1.1', 1, 60)).toBe(true);
  });
});
