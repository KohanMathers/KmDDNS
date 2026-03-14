import type { AppContext, AuditEntry, ClientRecord } from '../types.js';
import {
  getClient,
  deleteClient,
  writeBanSubdomain,
  writeBanIp,
  getHourlyUpdates,
  writeAudit,
  readClientSafeFromMetadata,
  toClientSummary,
  putClient,
} from '../kv.js';
import { withdrawDnsRecords } from '../dns.js';

/** GET /admin/clients — paginated list of all registered clients. */
export async function handleAdminListClients(c: AppContext): Promise<Response> {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 100);
  const cursorParam = c.req.query('cursor');
  const summaryMode = c.req.query('summary') === 'true';

  const listOpts: KVNamespaceListOptions = { prefix: 'client:', limit };
  if (cursorParam !== undefined) listOpts.cursor = cursorParam;

  const result = await c.env.DDNS_KV.list(listOpts);

  async function readClient(token: string, meta: unknown): Promise<ClientRecord | null> {
    const safeFromMeta = readClientSafeFromMetadata(meta);
    if (safeFromMeta) return safeFromMeta;
    const record = await getClient(c.env.DDNS_KV, token);
    if (record === null) return null;
    // Backfill metadata so future list calls can avoid the extra read.
    c.executionCtx.waitUntil(putClient(c.env.DDNS_KV, record));
    const { webhook_secret: _s, ...safe } = record;
    return { ...safe, webhook_secret: null };
  }

  const clients = await Promise.all(
    result.keys.map(async (k) => {
      const token = k.name.slice('client:'.length);
      const record = await readClient(token, k.metadata);
      if (record === null) return null;
      if (summaryMode) {
        return { token: record.token, ...toClientSummary(record) };
      }
      return record;
    }),
  );

  return c.json({
    clients: clients.filter(Boolean),
    next_cursor: result.list_complete ? null : result.cursor,
  });
}

/** DELETE /admin/client/:token — force-delete any client by token hash. */
export async function handleAdminDeleteClient(c: AppContext): Promise<Response> {
  const tokenHash = c.req.param('token')!;
  const record = await getClient(c.env.DDNS_KV, tokenHash);

  if (record === null) {
    return c.json({ error: 'not_found', message: 'Client not found' }, 404);
  }

  await withdrawDnsRecords(c.env, record);
  await deleteClient(c.env.DDNS_KV, tokenHash);

  const now = new Date().toISOString();
  const entry: AuditEntry = {
    action: 'admin_delete',
    source_ip: c.req.header('CF-Connecting-IP') ?? '0.0.0.0',
    timestamp: now,
    details: { token_hash: tokenHash, subdomain: record.subdomain },
  };
  await writeAudit(c.env.DDNS_KV, tokenHash, entry);

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
  if (subdomain !== null) ops.push(writeBanSubdomain(c.env.DDNS_KV, subdomain));
  if (ip !== null) ops.push(writeBanIp(c.env.DDNS_KV, ip));
  await Promise.all(ops);

  const now = new Date().toISOString();
  const entry: AuditEntry = {
    action: 'admin_ban',
    source_ip: c.req.header('CF-Connecting-IP') ?? '0.0.0.0',
    timestamp: now,
    details: { subdomain: subdomain ?? '', ip: ip ?? '' },
  };
  await writeAudit(c.env.DDNS_KV, 'admin:ban', entry);

  return c.json({ banned: { subdomain, ip } });
}

/** GET /admin/stats — aggregate platform stats. */
export async function handleAdminStats(c: AppContext): Promise<Response> {
  async function countPrefix(prefix: string): Promise<number> {
    let count = 0;
    let nextCursor: string | undefined = undefined;
    while (true) {
      const opts: KVNamespaceListOptions = { prefix, limit: 1000 };
      if (nextCursor !== undefined) opts.cursor = nextCursor;
      const page: KVNamespaceListResult<unknown, string> = await c.env.DDNS_KV.list(opts);
      count += page.keys.length;
      if (page.list_complete) break;
      nextCursor = page.cursor;
    }
    return count;
  }

  const [total_clients, banned_count, updates_last_hour] = await Promise.all([
    countPrefix('client:'),
    countPrefix('ban:'),
    getHourlyUpdates(c.env.DDNS_KV),
  ]);

  return c.json({ total_clients, updates_last_hour, banned_count });
}
