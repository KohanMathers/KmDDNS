import type { AppContext, ClientRecord } from '../types.js';
import { getConfig, RESERVED_SUBDOMAINS, SUBDOMAIN_REGEX } from '../config.js';
import { getBySubdomain, putClient, putSubdomainIndex, isBannedSubdomain, isBannedIp } from '../db.js';
import { sha256 } from '../auth.js';
import { upsertARecord, upsertSRVRecord } from '../dns.js';
import { checkRegistrationLimit } from '../ratelimit.js';
import { validateSrvPrefix, validateTags } from '../validation.js';

/** POST /v1/register — claim a subdomain and receive a one-time plain token. */
export async function handleRegister(c: AppContext): Promise<Response> {
  const ip = c.req.header('CF-Connecting-IP') ?? '0.0.0.0';

  if (await isBannedIp(c.env.kmddns, ip)) {
    return c.json({ error: 'banned', message: 'This IP has been banned' }, 403);
  }

  const { allowed, retryAfter } = await checkRegistrationLimit(c.env.kmddns, ip);
  if (!allowed) {
    return c.json(
      { error: 'rate_limited', message: 'Too many registrations from this IP' },
      429,
      { 'Retry-After': String(retryAfter) },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }

  const subdomain = typeof body.subdomain === 'string' ? body.subdomain : '';
  const config = getConfig(c.env);

  if (
    !SUBDOMAIN_REGEX.test(subdomain) ||
    RESERVED_SUBDOMAINS.has(subdomain) ||
    subdomain.length > config.maxSubdomainLength
  ) {
    return c.json({ error: 'invalid_subdomain', message: 'Subdomain is invalid or reserved' }, 400);
  }

  if (await isBannedSubdomain(c.env.kmddns, subdomain)) {
    return c.json({ error: 'banned', message: 'This subdomain has been banned' }, 403);
  }

  const existing = await getBySubdomain(c.env.kmddns, subdomain);
  if (existing !== null) {
    return c.json({ error: 'subdomain_taken', message: 'Subdomain is already registered' }, 409);
  }

  const port =
    typeof body.port === 'number' && body.port >= 1 && body.port <= 65535 ? body.port : null;

  let srvPrefix: string | null = null;
  if (port !== null) {
    if (typeof body.srv !== 'string') {
      return c.json({ error: 'missing_srv', message: 'srv is required when port is specified' }, 400);
    }
    const result = validateSrvPrefix(body.srv);
    if (!result.ok || result.value === null) {
      return c.json({ error: 'invalid_srv', message: 'srv must be in _service._proto format (e.g. _minecraft._tcp)' }, 400);
    }
    srvPrefix = result.value;
  }

  const plainToken = crypto.randomUUID();
  const tokenHash = await sha256(plainToken);

  const now = new Date().toISOString();
  const ttl = typeof body.ttl === 'number' ? Math.max(30, Math.min(3600, body.ttl)) : config.defaultTtl;
  let tags: string[] = [];
  if ('tags' in body) {
    const result = validateTags(body.tags);
    if (!result.ok) {
      return c.json({ error: 'invalid_field', message: result.message }, 400);
    }
    tags = result.value;
  }

  const record: ClientRecord = {
    token: tokenHash,
    subdomain,
    owner_email: typeof body.owner_email === 'string' ? body.owner_email : null,
    created_at: now,
    last_seen: null,
    ip: null,
    ipv6: null,
    port,
    srv_prefix: srvPrefix,
    ttl,
    update_interval: 300,
    tags,
    metadata: {},
    webhook_url: null,
    webhook_secret: null,
    allowed_update_ips: null,
    custom_domains: [],
    enabled: true,
    redirect_http: body.redirect_http === true,
    notes: null,
  };

  await putClient(c.env.kmddns, record);
  await putSubdomainIndex(c.env.kmddns, subdomain, tokenHash);

  await upsertARecord(c.env, subdomain, '0.0.0.0', ttl);
  if (port !== null && srvPrefix !== null) {
    await upsertSRVRecord(c.env, subdomain, srvPrefix, port, ttl);
  }

  const fqdn = `${subdomain}.${config.baseDomain}`;

  return c.json(
    {
      token: plainToken,
      subdomain,
      fqdn,
      srv_record: srvPrefix !== null ? `${srvPrefix}.${fqdn}` : null,
    },
    201,
  );
}
