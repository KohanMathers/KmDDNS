import type { ClientRecord, AuditEntry } from './types.js';

export interface ClientSummary {
  subdomain: string;
  owner_email: string | null;
  created_at: string;
  last_seen: string | null;
  ip: string | null;
  ipv6: string | null;
  port: number | null;
  srv_prefix: string | null;
  ttl: number;
  update_interval: number;
  tags: string[];
  enabled: boolean;
  redirect_http: boolean;
}

export interface ClientMetadata {
  safe?: Omit<ClientRecord, 'webhook_secret'>;
  summary?: ClientSummary;
}

export interface PendingCustomDomain {
  token: string;
  challenge: string;
  expires_at: number;
}

// KV metadata limits are small; keep a safe buffer under the hard cap.
const CLIENT_METADATA_SAFE_MAX_BYTES = 900;

const k = {
  client:              (token: string)               => `client:${token}`,
  subdomain:           (label: string)               => `subdomain:${label}`,
  customDomain:        (hostname: string)            => `customdomain:${hostname}`,
  customDomainPending: (hostname: string)            => `customdomain-pending:${hostname}`,
  audit:               (token: string, ts: string)   => `audit:${token}:${ts}`,
  rateLimit:           (key: string, win: number)    => `ratelimit:${key}:${win}`,
};

export async function getClient(kv: KVNamespace, token: string): Promise<ClientRecord | null> {
  const raw = await kv.get(k.client(token));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as ClientRecord;
  } catch {
    return null;
  }
}

export async function putClient(kv: KVNamespace, record: ClientRecord): Promise<void> {
  const { webhook_secret: _secret, ...safe } = record;
  const safeJson = JSON.stringify(safe);
  const metadata: ClientMetadata = {};
  if (safeJson.length <= CLIENT_METADATA_SAFE_MAX_BYTES) {
    metadata.safe = safe;
  } else {
    metadata.summary = {
      subdomain: record.subdomain,
      owner_email: record.owner_email,
      created_at: record.created_at,
      last_seen: record.last_seen,
      ip: record.ip,
      ipv6: record.ipv6,
      port: record.port,
      srv_prefix: record.srv_prefix,
      ttl: record.ttl,
      update_interval: record.update_interval,
      tags: record.tags,
      enabled: record.enabled,
      redirect_http: record.redirect_http,
    };
  }

  await kv.put(k.client(record.token), JSON.stringify(record), { metadata });
}

export function toClientSummary(record: ClientRecord): ClientSummary {
  return {
    subdomain: record.subdomain,
    owner_email: record.owner_email,
    created_at: record.created_at,
    last_seen: record.last_seen,
    ip: record.ip,
    ipv6: record.ipv6,
    port: record.port,
    srv_prefix: record.srv_prefix,
    ttl: record.ttl,
    update_interval: record.update_interval,
    tags: record.tags,
    enabled: record.enabled,
    redirect_http: record.redirect_http,
  };
}

export function readClientSummaryFromMetadata(meta: unknown): ClientSummary | null {
  if (!meta || typeof meta !== 'object') return null;
  const m = meta as ClientMetadata;
  if (m.safe) return toClientSummary(m.safe as ClientRecord);
  return m.summary ?? null;
}

export function readClientSafeFromMetadata(meta: unknown): ClientRecord | null {
  if (!meta || typeof meta !== 'object') return null;
  const m = meta as ClientMetadata;
  return m.safe ? (m.safe as ClientRecord) : null;
}

export function readClientRecordFromMetadata(meta: unknown, token: string): ClientRecord | null {
  if (!meta || typeof meta !== 'object') return null;
  const m = meta as ClientMetadata;
  if (m.safe) return m.safe as ClientRecord;
  if (!m.summary) return null;
  const s = m.summary as ClientSummary;
  return {
    token,
    subdomain: s.subdomain,
    owner_email: s.owner_email,
    created_at: s.created_at,
    last_seen: s.last_seen,
    ip: s.ip,
    ipv6: s.ipv6,
    port: s.port,
    srv_prefix: s.srv_prefix,
    ttl: s.ttl,
    update_interval: s.update_interval,
    tags: s.tags,
    metadata: {},
    webhook_url: null,
    webhook_secret: null,
    allowed_update_ips: null,
    custom_domains: [],
    enabled: s.enabled,
    redirect_http: s.redirect_http,
    notes: null,
  };
}

/** Deletes only the client's own KV key without touching index keys. */
export async function deleteClientKey(kv: KVNamespace, token: string): Promise<void> {
  await kv.delete(k.client(token));
}

export async function deleteClient(kv: KVNamespace, token: string): Promise<void> {
  const record = await getClient(kv, token);
  const ops: Promise<void>[] = [kv.delete(k.client(token))];
  if (record !== null) {
    ops.push(kv.delete(k.subdomain(record.subdomain)));
    for (const hostname of record.custom_domains) {
      ops.push(kv.delete(k.customDomain(hostname)));
    }
  }
  await Promise.all(ops);
}

export function getBySubdomain(kv: KVNamespace, label: string): Promise<string | null> {
  return kv.get(k.subdomain(label));
}

export async function putSubdomainIndex(kv: KVNamespace, label: string, token: string): Promise<void> {
  await kv.put(k.subdomain(label), token);
}

export function getByCustomDomain(kv: KVNamespace, hostname: string): Promise<string | null> {
  return kv.get(k.customDomain(hostname));
}

export async function putCustomDomainIndex(kv: KVNamespace, hostname: string, token: string): Promise<void> {
  await kv.put(k.customDomain(hostname), token);
}

export async function deleteCustomDomainIndex(kv: KVNamespace, hostname: string): Promise<void> {
  await kv.delete(k.customDomain(hostname));
}

export async function getPendingCustomDomain(kv: KVNamespace, hostname: string): Promise<PendingCustomDomain | null> {
  const raw = await kv.get(k.customDomainPending(hostname));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as PendingCustomDomain;
  } catch {
    return null;
  }
}

export async function putPendingCustomDomain(kv: KVNamespace, hostname: string, data: PendingCustomDomain): Promise<void> {
  await kv.put(k.customDomainPending(hostname), JSON.stringify(data), { expirationTtl: 24 * 60 * 60 });
}

export async function deletePendingCustomDomain(kv: KVNamespace, hostname: string): Promise<void> {
  await kv.delete(k.customDomainPending(hostname));
}

export async function writeAudit(kv: KVNamespace, token: string, entry: AuditEntry): Promise<void> {
  await kv.put(k.audit(token, entry.timestamp), JSON.stringify(entry));
}

/** Returns true when the rate limit is exceeded (i.e. the caller should reject). */
export async function isRateLimitExceeded(
  kv: KVNamespace,
  key: string,
  max: number,
  windowSecs: number,
): Promise<boolean> {
  const window = Math.floor(Date.now() / 1000 / windowSecs);
  const kvKey = k.rateLimit(key, window);
  const raw = await kv.get(kvKey);
  const count = raw === null ? 0 : parseInt(raw, 10);
  if (count >= max) return true;
  await kv.put(kvKey, String(count + 1), { expirationTtl: windowSecs });
  return false;
}

export async function isBannedSubdomain(kv: KVNamespace, label: string): Promise<boolean> {
  return (await kv.get(`ban:${label}`)) !== null;
}

export async function isBannedIp(kv: KVNamespace, ip: string): Promise<boolean> {
  return (await kv.get(`ban:ip:${ip}`)) !== null;
}

export async function writeBanSubdomain(kv: KVNamespace, label: string): Promise<void> {
  await kv.put(`ban:${label}`, '1');
}

export async function writeBanIp(kv: KVNamespace, ip: string): Promise<void> {
  await kv.put(`ban:ip:${ip}`, '1');
}

export async function incrementHourlyUpdates(kv: KVNamespace): Promise<void> {
  const window = Math.floor(Date.now() / 1000 / 3600);
  const key = `stats:updates:${window}`;
  const raw = await kv.get(key);
  const count = raw === null ? 0 : parseInt(raw, 10);
  await kv.put(key, String(count + 1), { expirationTtl: 7200 });
}

export async function getHourlyUpdates(kv: KVNamespace): Promise<number> {
  const window = Math.floor(Date.now() / 1000 / 3600);
  const raw = await kv.get(`stats:updates:${window}`);
  return raw === null ? 0 : parseInt(raw, 10);
}
