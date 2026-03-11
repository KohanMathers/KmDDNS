import type { AppContext, ClientRecord, AuditEntry, Env } from '../types.js';
import { getClient, putClient, writeAudit, isBannedIp, incrementHourlyUpdates } from '../kv.js';
import { sha256 } from '../auth.js';
import { upsertARecord, upsertAAAARecord, upsertSRVRecord, withdrawAAAARecord, withdrawSRVRecord } from '../dns.js';
import { dispatchWebhook } from '../webhook.js';
import { checkUpdateLimit } from '../ratelimit.js';
import { cidrContains, ipv4IsAllowed, ipv6IsPublic } from '../ip.js';
import { getConfig } from '../config.js';
import { validateMetadata } from '../validation.js';

async function commitUpdate(
  env: Env,
  ctx: ExecutionContext,
  client: ClientRecord,
  newIp: string,
  newIpv6: string | null | undefined,
  newPort: number | null | undefined,
  newMetadata: Record<string, string> | undefined,
  dry: boolean,
  sourceIp: string,
  webhookAllowAll: boolean,
  webhookAllowlistExact: Set<string>,
  webhookAllowlistSuffixes: string[],
): Promise<{ changed: boolean; updated: ClientRecord }> {
  const resolvedIpv6 = newIpv6 !== undefined ? newIpv6 : client.ipv6;
  const resolvedPort = newPort !== undefined ? newPort : client.port;
  const resolvedMetadata =
    newMetadata !== undefined ? { ...client.metadata, ...newMetadata } : client.metadata;

  const ipChanged = newIp !== client.ip;
  const ipv6Changed = resolvedIpv6 !== client.ipv6;
  const portChanged = resolvedPort !== client.port;
  const changed = ipChanged || ipv6Changed || portChanged || newMetadata !== undefined;

  const now = new Date().toISOString();
  const updated: ClientRecord = {
    ...client,
    ip: newIp,
    ipv6: resolvedIpv6,
    port: resolvedPort,
    metadata: resolvedMetadata,
    last_seen: now,
  };

  if (!dry) {
    if (ipChanged) {
      await upsertARecord(env, client.subdomain, newIp, client.ttl);
    }
    if (ipv6Changed) {
      if (resolvedIpv6 === null) {
        await withdrawAAAARecord(env, client.subdomain);
      } else {
        await upsertAAAARecord(env, client.subdomain, resolvedIpv6, client.ttl);
      }
    }
    if (portChanged && client.srv_prefix !== null) {
      if (resolvedPort === null) {
        await withdrawSRVRecord(env, client.subdomain, client.srv_prefix);
      } else {
        await upsertSRVRecord(env, client.subdomain, client.srv_prefix, resolvedPort, client.ttl);
      }
    }

    await putClient(env.DDNS_KV, updated);

    const entry: AuditEntry = {
      action: 'update',
      source_ip: sourceIp,
      timestamp: now,
      details: {
        old_ip: client.ip,
        new_ip: newIp,
        old_port: client.port,
        new_port: resolvedPort,
        changed,
      },
    };
    await writeAudit(env.DDNS_KV, client.token, entry);

    if (ipChanged || portChanged) {
      dispatchWebhook(
        ctx,
        updated,
        ipChanged ? 'ip_changed' : 'port_changed',
        {
          oldIp: client.ip,
          newIp,
          oldPort: client.port,
          newPort: resolvedPort,
        },
        webhookAllowAll,
        webhookAllowlistExact,
        webhookAllowlistSuffixes,
      );
    }
  }

  return { changed, updated };
}

/** GET /v1/update — cron/wget-friendly; token in query string, plain-text response. */
export async function handleUpdateGet(c: AppContext): Promise<Response> {
  const rawToken = c.req.query('token');
  if (!rawToken) {
    return c.json({ error: 'missing_token', message: 'token query parameter is required' }, 401);
  }

  const hash = await sha256(rawToken);
  const client = await getClient(c.env.DDNS_KV, hash);
  if (client === null) {
    return c.json({ error: 'invalid_token', message: 'Token not recognised' }, 401);
  }
  if (!client.enabled) {
    return c.json({ error: 'account_disabled', message: 'This account has been disabled' }, 403);
  }

  const { allowed, retryAfter } = await checkUpdateLimit(c.env.DDNS_KV, hash);
  if (!allowed) {
    return c.json(
      { error: 'rate_limited', message: 'Update rate limit exceeded' },
      429,
      { 'Retry-After': String(retryAfter) },
    );
  }

  const sourceIp = c.req.header('CF-Connecting-IP') ?? '0.0.0.0';

  if (await isBannedIp(c.env.DDNS_KV, sourceIp)) {
    return c.json({ error: 'banned', message: 'This IP has been banned' }, 403);
  }

  if (
    client.allowed_update_ips !== null &&
    !client.allowed_update_ips.some(cidr => cidrContains(sourceIp, cidr))
  ) {
    return c.json({ error: 'ip_not_allowed', message: 'Source IP is not in the allowed list' }, 403);
  }

  await incrementHourlyUpdates(c.env.DDNS_KV);

  const config = getConfig(c.env);
  const ip = c.req.query('ip') ?? sourceIp;
  if (!ipv4IsAllowed(ip, config.allowPrivateIps)) {
    const message = config.allowPrivateIps
      ? 'IP must be a valid IPv4 address (private IPs allowed by admin)'
      : 'IP must be a public IPv4 address';
    return c.json({ error: 'invalid_ip', message }, 400);
  }

  const portParam = c.req.query('port');
  let port: number | undefined = undefined;
  if (portParam !== undefined) {
    const parsed = parseInt(portParam, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
      return c.json({ error: 'invalid_port', message: 'Port must be between 1 and 65535' }, 400);
    }
    port = parsed;
  }
  if (port !== undefined && client.srv_prefix === null) {
    return c.json({ error: 'missing_srv', message: 'port is not allowed without srv_prefix' }, 400);
  }

  const dry = c.req.query('dry') === 'true';
  if (dry) {
    return c.text(ip);
  }

  const { changed } = await commitUpdate(
    c.env,
    c.executionCtx,
    client,
    ip,
    undefined,
    port,
    undefined,
    false,
    sourceIp,
    config.webhookAllowAll,
    config.webhookAllowlistExact,
    config.webhookAllowlistSuffixes,
  );

  const warnHeader =
    'Using a token in query params can leak via logs or referrers. Prefer Authorization header.';
  return c.text(changed ? 'OK' : 'NOCHG', 200, { 'X-KmDDNS-Warn': warnHeader });
}

/** POST /v1/update — full JSON update; token in Authorization header, JSON response. */
export async function handleUpdatePost(c: AppContext): Promise<Response> {
  const client = c.get('client')!;
  const sourceIp = c.req.header('CF-Connecting-IP') ?? '0.0.0.0';

  const { allowed, retryAfter } = await checkUpdateLimit(c.env.DDNS_KV, client.token);
  if (!allowed) {
    return c.json(
      { error: 'rate_limited', message: 'Update rate limit exceeded' },
      429,
      { 'Retry-After': String(retryAfter) },
    );
  }

  if (await isBannedIp(c.env.DDNS_KV, sourceIp)) {
    return c.json({ error: 'banned', message: 'This IP has been banned' }, 403);
  }

  if (
    client.allowed_update_ips !== null &&
    !client.allowed_update_ips.some(cidr => cidrContains(sourceIp, cidr))
  ) {
    return c.json({ error: 'ip_not_allowed', message: 'Source IP is not in the allowed list' }, 403);
  }

  await incrementHourlyUpdates(c.env.DDNS_KV);

  let body: Record<string, unknown> = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }

  const config = getConfig(c.env);
  const ip = typeof body.ip === 'string' ? body.ip : sourceIp;
  if (!ipv4IsAllowed(ip, config.allowPrivateIps)) {
    const message = config.allowPrivateIps
      ? 'IP must be a valid IPv4 address (private IPs allowed by admin)'
      : 'IP must be a public IPv4 address';
    return c.json({ error: 'invalid_ip', message }, 400);
  }

  let ipv6: string | null | undefined = undefined;
  if ('ipv6' in body) {
    if (body.ipv6 === null) {
      ipv6 = null;
    } else if (typeof body.ipv6 === 'string') {
      if (!ipv6IsPublic(body.ipv6)) {
        return c.json({ error: 'invalid_ip', message: 'IPv6 address must be a public address' }, 400);
      }
      ipv6 = body.ipv6;
    }
  }

  let port: number | null | undefined = undefined;
  if ('port' in body) {
    if (body.port === null) {
      port = null;
    } else if (typeof body.port === 'number') {
      if (body.port < 1 || body.port > 65535) {
        return c.json({ error: 'invalid_port', message: 'Port must be between 1 and 65535' }, 400);
      }
      port = body.port;
    }
  }
  if (port !== undefined && client.srv_prefix === null) {
    return c.json({ error: 'missing_srv', message: 'port is not allowed without srv_prefix' }, 400);
  }

  let metadata: Record<string, string> | undefined = undefined;
  if ('metadata' in body) {
    const result = validateMetadata(body.metadata);
    if (!result.ok) {
      return c.json({ error: 'invalid_field', message: result.message }, 400);
    }
    metadata = result.value;
  }

  const { updated } = await commitUpdate(
    c.env,
    c.executionCtx,
    client,
    ip,
    ipv6,
    port,
    metadata,
    false,
    sourceIp,
    config.webhookAllowAll,
    config.webhookAllowlistExact,
    config.webhookAllowlistSuffixes,
  );

  const { token: _token, webhook_secret: _secret, ...publicRecord } = updated;
  return c.json(publicRecord);
}
