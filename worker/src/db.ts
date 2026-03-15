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

export interface PendingCustomDomain {
  token: string;
  challenge: string;
  expires_at: number;
}

interface ClientRow {
  token: string;
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
  tags: string;
  metadata: string;
  webhook_url: string | null;
  webhook_secret: string | null;
  allowed_update_ips: string | null;
  custom_domains: string;
  enabled: number;
  redirect_http: number;
  notes: string | null;
  tunnel_enabled: number;
}

function rowToRecord(row: ClientRow): ClientRecord {
  return {
    token: row.token,
    subdomain: row.subdomain,
    owner_email: row.owner_email,
    created_at: row.created_at,
    last_seen: row.last_seen,
    ip: row.ip,
    ipv6: row.ipv6,
    port: row.port,
    srv_prefix: row.srv_prefix,
    ttl: row.ttl,
    update_interval: row.update_interval,
    tags: JSON.parse(row.tags) as string[],
    metadata: JSON.parse(row.metadata) as Record<string, string>,
    webhook_url: row.webhook_url,
    webhook_secret: row.webhook_secret,
    allowed_update_ips: row.allowed_update_ips ? (JSON.parse(row.allowed_update_ips) as string[]) : null,
    custom_domains: JSON.parse(row.custom_domains) as string[],
    enabled: row.enabled === 1,
    redirect_http: row.redirect_http === 1,
    notes: row.notes,
    tunnel_enabled: row.tunnel_enabled === 1,
  };
}

export async function getClient(db: D1Database, token: string): Promise<ClientRecord | null> {
  const row = await db.prepare('SELECT * FROM clients WHERE token = ?').bind(token).first<ClientRow>();
  if (row === null) return null;
  return rowToRecord(row);
}

export async function putClient(db: D1Database, record: ClientRecord): Promise<void> {
  await db.prepare(`
    INSERT INTO clients (token, subdomain, owner_email, created_at, last_seen, ip, ipv6, port,
      srv_prefix, ttl, update_interval, tags, metadata, webhook_url, webhook_secret,
      allowed_update_ips, custom_domains, enabled, redirect_http, notes, tunnel_enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET
      subdomain = excluded.subdomain,
      owner_email = excluded.owner_email,
      created_at = excluded.created_at,
      last_seen = excluded.last_seen,
      ip = excluded.ip,
      ipv6 = excluded.ipv6,
      port = excluded.port,
      srv_prefix = excluded.srv_prefix,
      ttl = excluded.ttl,
      update_interval = excluded.update_interval,
      tags = excluded.tags,
      metadata = excluded.metadata,
      webhook_url = excluded.webhook_url,
      webhook_secret = excluded.webhook_secret,
      allowed_update_ips = excluded.allowed_update_ips,
      custom_domains = excluded.custom_domains,
      enabled = excluded.enabled,
      redirect_http = excluded.redirect_http,
      notes = excluded.notes,
      tunnel_enabled = excluded.tunnel_enabled
  `).bind(
    record.token,
    record.subdomain,
    record.owner_email,
    record.created_at,
    record.last_seen,
    record.ip,
    record.ipv6,
    record.port,
    record.srv_prefix,
    record.ttl,
    record.update_interval,
    JSON.stringify(record.tags),
    JSON.stringify(record.metadata),
    record.webhook_url,
    record.webhook_secret,
    record.allowed_update_ips ? JSON.stringify(record.allowed_update_ips) : null,
    JSON.stringify(record.custom_domains),
    record.enabled ? 1 : 0,
    record.redirect_http ? 1 : 0,
    record.notes,
    record.tunnel_enabled ? 1 : 0,
  ).run();
}

export async function deleteClient(db: D1Database, token: string): Promise<void> {
  // custom_domains rows cascade via FK ON DELETE CASCADE
  await db.prepare('DELETE FROM clients WHERE token = ?').bind(token).run();
}

/** Update the token PK; ON UPDATE CASCADE propagates the change to custom_domains. */
export async function rotateClientToken(db: D1Database, oldToken: string, newToken: string): Promise<void> {
  await db.prepare('UPDATE clients SET token = ? WHERE token = ?').bind(newToken, oldToken).run();
}

export async function getBySubdomain(db: D1Database, label: string): Promise<string | null> {
  const row = await db.prepare('SELECT token FROM clients WHERE subdomain = ?').bind(label).first<{ token: string }>();
  return row?.token ?? null;
}

/** No-op: subdomain is stored as a column in the clients table. */
export async function putSubdomainIndex(_db: D1Database, _label: string, _token: string): Promise<void> {}

export async function getByCustomDomain(db: D1Database, hostname: string): Promise<string | null> {
  const row = await db.prepare('SELECT token FROM custom_domains WHERE hostname = ?').bind(hostname).first<{ token: string }>();
  return row?.token ?? null;
}

export async function putCustomDomainIndex(db: D1Database, hostname: string, token: string): Promise<void> {
  await db.prepare(`
    INSERT INTO custom_domains (hostname, token) VALUES (?, ?)
    ON CONFLICT(hostname) DO UPDATE SET token = excluded.token
  `).bind(hostname, token).run();
}

export async function deleteCustomDomainIndex(db: D1Database, hostname: string): Promise<void> {
  await db.prepare('DELETE FROM custom_domains WHERE hostname = ?').bind(hostname).run();
}

export async function getPendingCustomDomain(db: D1Database, hostname: string): Promise<PendingCustomDomain | null> {
  const row = await db
    .prepare('SELECT token, challenge, expires_at FROM pending_custom_domains WHERE hostname = ?')
    .bind(hostname)
    .first<PendingCustomDomain>();
  return row ?? null;
}

export async function putPendingCustomDomain(db: D1Database, hostname: string, data: PendingCustomDomain): Promise<void> {
  await db.prepare(`
    INSERT INTO pending_custom_domains (hostname, token, challenge, expires_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(hostname) DO UPDATE SET
      token = excluded.token,
      challenge = excluded.challenge,
      expires_at = excluded.expires_at
  `).bind(hostname, data.token, data.challenge, data.expires_at).run();
}

export async function deletePendingCustomDomain(db: D1Database, hostname: string): Promise<void> {
  await db.prepare('DELETE FROM pending_custom_domains WHERE hostname = ?').bind(hostname).run();
}

export async function writeAudit(db: D1Database, token: string, entry: AuditEntry): Promise<void> {
  await db.prepare(
    'INSERT INTO audit (token, action, source_ip, timestamp, details) VALUES (?, ?, ?, ?, ?)',
  ).bind(token, entry.action, entry.source_ip, entry.timestamp, JSON.stringify(entry.details)).run();
}

/** Returns true when the rate limit is exceeded (i.e. the caller should reject). */
export async function isRateLimitExceeded(
  db: D1Database,
  key: string,
  max: number,
  windowSecs: number,
): Promise<boolean> {
  const window = Math.floor(Date.now() / 1000 / windowSecs);
  const dbKey = `${key}:${window}`;
  const expiresAt = (window + 1) * windowSecs;

  const results = await db.batch([
    db.prepare(`
      INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET count = count + 1
    `).bind(dbKey, expiresAt),
    db.prepare('SELECT count FROM rate_limits WHERE key = ?').bind(dbKey),
  ]);

  const countRow = results[1].results[0] as { count: number } | undefined;
  return (countRow?.count ?? 1) > max;
}

export async function isBannedSubdomain(db: D1Database, label: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 FROM bans WHERE type = 'subdomain' AND value = ?").bind(label).first();
  return row !== null;
}

export async function isBannedIp(db: D1Database, ip: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 FROM bans WHERE type = 'ip' AND value = ?").bind(ip).first();
  return row !== null;
}

export async function writeBanSubdomain(db: D1Database, label: string): Promise<void> {
  await db.prepare("INSERT OR IGNORE INTO bans (type, value) VALUES ('subdomain', ?)").bind(label).run();
}

export async function writeBanIp(db: D1Database, ip: string): Promise<void> {
  await db.prepare("INSERT OR IGNORE INTO bans (type, value) VALUES ('ip', ?)").bind(ip).run();
}

export async function incrementHourlyUpdates(db: D1Database): Promise<void> {
  const window = Math.floor(Date.now() / 1000 / 3600);
  const expiresAt = (window + 2) * 3600;
  await db.prepare(`
    INSERT INTO stats (window, count, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(window) DO UPDATE SET count = count + 1
  `).bind(window, expiresAt).run();
}

export async function getHourlyUpdates(db: D1Database): Promise<number> {
  const window = Math.floor(Date.now() / 1000 / 3600);
  const row = await db.prepare('SELECT count FROM stats WHERE window = ?').bind(window).first<{ count: number }>();
  return row?.count ?? 0;
}

export async function listClients(
  db: D1Database,
  limit: number,
  offset: number,
): Promise<{ records: ClientRecord[]; total: number }> {
  const [countResult, rowsResult] = await db.batch([
    db.prepare('SELECT COUNT(*) as total FROM clients'),
    db.prepare('SELECT * FROM clients ORDER BY created_at DESC LIMIT ? OFFSET ?').bind(limit, offset),
  ]);
  const total = (countResult.results[0] as { total: number } | undefined)?.total ?? 0;
  const records = (rowsResult.results as ClientRow[]).map(rowToRecord);
  return { records, total };
}

export async function countClients(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) as total FROM clients').first<{ total: number }>();
  return row?.total ?? 0;
}

export async function countBans(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) as total FROM bans').first<{ total: number }>();
  return row?.total ?? 0;
}

export async function getStaleEnabledClients(db: D1Database, beforeISO: string): Promise<ClientRecord[]> {
  const { results } = await db
    .prepare(`SELECT * FROM clients WHERE enabled = 1 AND COALESCE(last_seen, created_at) <= ?`)
    .bind(beforeISO)
    .all<ClientRow>();
  return results.map(rowToRecord);
}

/** Purge expired rows from rate_limits, stats, and pending_custom_domains. Run from scheduled handler. */
export async function purgeExpired(db: D1Database): Promise<void> {
  const nowSecs = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();
  await db.batch([
    db.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(nowSecs),
    db.prepare('DELETE FROM stats WHERE expires_at < ?').bind(nowSecs),
    db.prepare('DELETE FROM pending_custom_domains WHERE expires_at < ?').bind(nowMs),
  ]);
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
