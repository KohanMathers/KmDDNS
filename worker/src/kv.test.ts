import { describe, it, expect } from 'vitest';
import {
  getClient, putClient, deleteClient,
  getBySubdomain, putSubdomainIndex,
  getByCustomDomain, putCustomDomainIndex, deleteCustomDomainIndex,
  writeAudit, isRateLimitExceeded,
} from './kv.js';
import type { ClientRecord, AuditEntry } from './types.js';

function makeKv() {
  const store = new Map<string, string>();
  const kv = {
    store,
    async get(key: string): Promise<string | null> { return store.get(key) ?? null; },
    async put(key: string, value: string): Promise<void> { store.set(key, value); },
    async delete(key: string): Promise<void> { store.delete(key); },
  };
  return { kv: kv as unknown as KVNamespace, store };
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
};

describe('getClient / putClient', () => {
  it('round-trips a record with no data loss', async () => {
    const { kv } = makeKv();
    const record: ClientRecord = { ...BASE_RECORD, port: 25565, tags: ['minecraft'] };
    await putClient(kv, record);
    expect(await getClient(kv, record.token)).toEqual(record);
  });

  it('returns null for a missing key', async () => {
    const { kv } = makeKv();
    expect(await getClient(kv, 'nosuchtoken')).toBeNull();
  });
});

describe('deleteClient', () => {
  it('removes the record and subdomain index', async () => {
    const { kv } = makeKv();
    await putClient(kv, BASE_RECORD);
    await putSubdomainIndex(kv, BASE_RECORD.subdomain, BASE_RECORD.token);

    await deleteClient(kv, BASE_RECORD.token);

    expect(await getClient(kv, BASE_RECORD.token)).toBeNull();
    expect(await getBySubdomain(kv, BASE_RECORD.subdomain)).toBeNull();
  });

  it('removes custom domain index keys', async () => {
    const { kv } = makeKv();
    const record: ClientRecord = { ...BASE_RECORD, custom_domains: ['mc.example.com'] };
    await putClient(kv, record);
    await putCustomDomainIndex(kv, 'mc.example.com', record.token);

    await deleteClient(kv, record.token);

    expect(await getByCustomDomain(kv, 'mc.example.com')).toBeNull();
  });

  it('does not throw when record is already missing', async () => {
    const { kv } = makeKv();
    await expect(deleteClient(kv, 'nosuchtoken')).resolves.toBeUndefined();
  });
});

describe('subdomain index', () => {
  it('returns correct token for a registered label', async () => {
    const { kv } = makeKv();
    await putSubdomainIndex(kv, 'myserver', 'abc123hash');
    expect(await getBySubdomain(kv, 'myserver')).toBe('abc123hash');
  });

  it('returns null for unknown label', async () => {
    const { kv } = makeKv();
    expect(await getBySubdomain(kv, 'unknown')).toBeNull();
  });
});

describe('custom domain index', () => {
  it('round-trips hostname to token', async () => {
    const { kv } = makeKv();
    await putCustomDomainIndex(kv, 'mc.example.com', 'abc123hash');
    expect(await getByCustomDomain(kv, 'mc.example.com')).toBe('abc123hash');
  });

  it('deleteCustomDomainIndex removes the entry', async () => {
    const { kv } = makeKv();
    await putCustomDomainIndex(kv, 'mc.example.com', 'abc123hash');
    await deleteCustomDomainIndex(kv, 'mc.example.com');
    expect(await getByCustomDomain(kv, 'mc.example.com')).toBeNull();
  });
});

describe('writeAudit', () => {
  it('stores entry under the correct key', async () => {
    const { kv, store } = makeKv();
    const entry: AuditEntry = {
      action: 'update',
      source_ip: '1.2.3.4',
      timestamp: '2025-01-01T00:00:00.000Z',
      details: { ip: '1.2.3.4' },
    };
    await writeAudit(kv, 'abc123hash', entry);
    const raw = store.get('audit:abc123hash:2025-01-01T00:00:00.000Z');
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toEqual(entry);
  });
});

describe('isRateLimitExceeded', () => {
  it('allows requests below the limit', async () => {
    const { kv } = makeKv();
    expect(await isRateLimitExceeded(kv, 'ip:1.2.3.4', 3, 60)).toBe(false);
    expect(await isRateLimitExceeded(kv, 'ip:1.2.3.4', 3, 60)).toBe(false);
    expect(await isRateLimitExceeded(kv, 'ip:1.2.3.4', 3, 60)).toBe(false);
  });

  it('rejects when the limit is reached', async () => {
    const { kv } = makeKv();
    await isRateLimitExceeded(kv, 'ip:1.2.3.4', 2, 60);
    await isRateLimitExceeded(kv, 'ip:1.2.3.4', 2, 60);
    expect(await isRateLimitExceeded(kv, 'ip:1.2.3.4', 2, 60)).toBe(true);
  });

  it('increments correctly and stops at max', async () => {
    const { kv } = makeKv();
    expect(await isRateLimitExceeded(kv, 'tok:xyz', 1, 60)).toBe(false);
    expect(await isRateLimitExceeded(kv, 'tok:xyz', 1, 60)).toBe(true);
  });

  it('isolates different rate limit keys', async () => {
    const { kv } = makeKv();
    await isRateLimitExceeded(kv, 'ip:1.1.1.1', 1, 60);
    expect(await isRateLimitExceeded(kv, 'ip:2.2.2.2', 1, 60)).toBe(false);
    expect(await isRateLimitExceeded(kv, 'ip:1.1.1.1', 1, 60)).toBe(true);
  });
});
