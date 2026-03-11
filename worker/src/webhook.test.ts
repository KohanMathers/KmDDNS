import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dispatchWebhook } from './webhook.js';
import type { ClientRecord } from './types.js';

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

function makeCtx() {
  const waits: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      waits.push(p);
    },
  } as ExecutionContext;
  return { ctx, waits };
}

describe('dispatchWebhook allowlist', () => {
  const fetchMock = vi.fn(async () => new Response('', { status: 200 }));

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    fetchMock.mockClear();
    vi.unstubAllGlobals();
  });

  it('allows any hostname when allowAll is true', async () => {
    const { ctx, waits } = makeCtx();
    const record = { ...BASE_RECORD, webhook_url: 'https://hooks.example.com/ddns' };
    dispatchWebhook(ctx, record, 'ip_changed', { oldIp: null, newIp: '1.1.1.1', oldPort: null, newPort: null }, true, new Set(), []);
    await Promise.all(waits);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('allows exact host match', async () => {
    const { ctx, waits } = makeCtx();
    const record = { ...BASE_RECORD, webhook_url: 'https://hooks.example.com/ddns' };
    dispatchWebhook(ctx, record, 'ip_changed', { oldIp: null, newIp: '1.1.1.1', oldPort: null, newPort: null }, false, new Set(['hooks.example.com']), []);
    await Promise.all(waits);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('allows suffix match', async () => {
    const { ctx, waits } = makeCtx();
    const record = { ...BASE_RECORD, webhook_url: 'https://hooks.example.com/ddns' };
    dispatchWebhook(ctx, record, 'ip_changed', { oldIp: null, newIp: '1.1.1.1', oldPort: null, newPort: null }, false, new Set(), ['.example.com']);
    await Promise.all(waits);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects hostname when not allowlisted', async () => {
    const { ctx, waits } = makeCtx();
    const record = { ...BASE_RECORD, webhook_url: 'https://hooks.example.com/ddns' };
    dispatchWebhook(ctx, record, 'ip_changed', { oldIp: null, newIp: '1.1.1.1', oldPort: null, newPort: null }, false, new Set(), []);
    await Promise.all(waits);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it('allows public IPv4 literal without allowlist', async () => {
    const { ctx, waits } = makeCtx();
    const record = { ...BASE_RECORD, webhook_url: 'https://1.2.3.4/ddns' };
    dispatchWebhook(ctx, record, 'ip_changed', { oldIp: null, newIp: '1.1.1.1', oldPort: null, newPort: null }, false, new Set(), []);
    await Promise.all(waits);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects private IPv4 literal', async () => {
    const { ctx, waits } = makeCtx();
    const record = { ...BASE_RECORD, webhook_url: 'https://127.0.0.1/ddns' };
    dispatchWebhook(ctx, record, 'ip_changed', { oldIp: null, newIp: '1.1.1.1', oldPort: null, newPort: null }, true, new Set(), []);
    await Promise.all(waits);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});
