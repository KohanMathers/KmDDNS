import type { AppContext } from '../types.js';
import { getBySubdomain, getClient } from '../db.js';

/** GET /v1/lookup/:subdomain — public read-only endpoint; exposes only safe fields. */
export async function handleLookup(c: AppContext): Promise<Response> {
  const subdomain = c.req.param('subdomain')!;

  const token = await getBySubdomain(c.env.kmddns, subdomain);
  if (token === null) {
    return c.json({ error: 'not_found', message: 'Subdomain not found' }, 404);
  }

  const record = await getClient(c.env.kmddns, token);
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
    tunnel_enabled: record.tunnel_enabled,
  });
}
