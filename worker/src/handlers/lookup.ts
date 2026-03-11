import type { AppContext } from '../types.js';
import { getBySubdomain, getClient } from '../kv.js';

/** GET /v1/lookup/:subdomain — public read-only endpoint; exposes only safe fields. */
export async function handleLookup(c: AppContext): Promise<Response> {
  const subdomain = c.req.param('subdomain')!;

  const token = await getBySubdomain(c.env.DDNS_KV, subdomain);
  if (token === null) {
    return c.json({ error: 'not_found', message: 'Subdomain not found' }, 404);
  }

  const record = await getClient(c.env.DDNS_KV, token);
  if (record === null || !record.enabled) {
    return c.json({ error: 'not_found', message: 'Subdomain not found' }, 404);
  }

  return c.json({
    subdomain: record.subdomain,
    ip: record.ip,
    ipv6: record.ipv6,
    port: record.port,
    ttl: record.ttl,
    tags: record.tags,
    metadata: record.metadata,
    last_seen: record.last_seen,
  });
}
