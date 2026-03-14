import type { AppContext, AuditEntry } from '../types.js';
import {
  getClient,
  deleteClient,
  writeBanSubdomain,
  writeBanIp,
  getHourlyUpdates,
  writeAudit,
  toClientSummary,
  listClients,
  countClients,
  countBans,
} from '../db.js';
import { withdrawDnsRecords } from '../dns.js';

/** GET /admin/clients — paginated list of all registered clients. */
export async function handleAdminListClients(c: AppContext): Promise<Response> {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 100);
  const offset = parseInt(c.req.query('cursor') ?? '0', 10);
  const summaryMode = c.req.query('summary') === 'true';

  const { records, total } = await listClients(c.env.kmddns, limit, offset);

  const clients = records.map(record => {
    if (summaryMode) {
      return { token: record.token, ...toClientSummary(record) };
    }
    const { webhook_secret: _s, ...safe } = record;
    return { ...safe, webhook_secret: null };
  });

  const nextOffset = offset + limit;
  return c.json({
    clients,
    next_cursor: nextOffset < total ? String(nextOffset) : null,
  });
}

/** DELETE /admin/client/:token — force-delete any client by token hash. */
export async function handleAdminDeleteClient(c: AppContext): Promise<Response> {
  const tokenHash = c.req.param('token')!;
  const record = await getClient(c.env.kmddns, tokenHash);

  if (record === null) {
    return c.json({ error: 'not_found', message: 'Client not found' }, 404);
  }

  await withdrawDnsRecords(c.env, record);
  await deleteClient(c.env.kmddns, tokenHash);

  const now = new Date().toISOString();
  const entry: AuditEntry = {
    action: 'admin_delete',
    source_ip: c.req.header('CF-Connecting-IP') ?? '0.0.0.0',
    timestamp: now,
    details: { token_hash: tokenHash, subdomain: record.subdomain },
  };
  await writeAudit(c.env.kmddns, tokenHash, entry);

  return new Response(null, { status: 204 });
}

/** POST /admin/ban — ban a subdomain label, an IP, or both. */
export async function handleAdminBan(c: AppContext): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }

  const subdomain = typeof body.subdomain === 'string' ? body.subdomain : null;
  const ip = typeof body.ip === 'string' ? body.ip : null;

  if (subdomain === null && ip === null) {
    return c.json({ error: 'invalid_body', message: 'At least one of subdomain or ip is required' }, 400);
  }

  const ops: Promise<void>[] = [];
  if (subdomain !== null) ops.push(writeBanSubdomain(c.env.kmddns, subdomain));
  if (ip !== null) ops.push(writeBanIp(c.env.kmddns, ip));
  await Promise.all(ops);

  const now = new Date().toISOString();
  const entry: AuditEntry = {
    action: 'admin_ban',
    source_ip: c.req.header('CF-Connecting-IP') ?? '0.0.0.0',
    timestamp: now,
    details: { subdomain: subdomain ?? '', ip: ip ?? '' },
  };
  await writeAudit(c.env.kmddns, 'admin:ban', entry);

  return c.json({ banned: { subdomain, ip } });
}

/** GET /admin/stats — aggregate platform stats. */
export async function handleAdminStats(c: AppContext): Promise<Response> {
  const [total_clients, banned_count, updates_last_hour] = await Promise.all([
    countClients(c.env.kmddns),
    countBans(c.env.kmddns),
    getHourlyUpdates(c.env.kmddns),
  ]);

  return c.json({ total_clients, updates_last_hour, banned_count });
}
