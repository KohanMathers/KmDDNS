import type { AppContext, ClientRecord, AuditEntry, Env } from '../types.js';
import { putClient, deleteClient, rotateClientToken, writeAudit } from '../db.js';
import { sha256 } from '../auth.js';
import { upsertARecord, upsertAAAARecord, upsertSRVRecord, withdrawDnsRecords, withdrawSRVRecord } from '../dns.js';
import { dispatchWebhook } from '../webhook.js';
import { getConfig } from '../config.js';
import { ipv4IsPublic, ipv6IsPublic, parseIPv4, parseIPv6 } from '../ip.js';
import { validateAllowedUpdateIps, validateMetadata, validateSrvPrefix, validateTags } from '../validation.js';

function isSafeWebhookUrl(
  value: string,
  allowlist: string[],
): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;

  const hostname = url.hostname.toLowerCase();
  if (!hostname) return false;
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.localdomain') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.intranet')
  ) {
    return false;
  }

  if (parseIPv4(hostname) !== null) {
    return ipv4IsPublic(hostname);
  }
  if (parseIPv6(hostname) !== null) {
    return ipv6IsPublic(hostname);
  }

  if (allowlist.includes('*')) return true;
  return allowlist.some(entry => entry === hostname || (entry.startsWith('.') && hostname.endsWith(entry)));
}

async function restoreDnsRecords(env: Env, record: ClientRecord): Promise<void> {
  const ops: Promise<void>[] = [];

  if (record.ip !== null) {
    ops.push(upsertARecord(env, record.subdomain, record.ip, record.ttl));
  }
  if (record.ipv6 !== null) {
    ops.push(upsertAAAARecord(env, record.subdomain, record.ipv6, record.ttl));
  }
  if (record.port !== null && record.srv_prefix !== null) {
    ops.push(upsertSRVRecord(env, record.subdomain, record.srv_prefix, record.port, record.ttl));
  }

  await Promise.all(ops);
}

/** GET /v1/client — returns full config; token hash and webhook secret are never exposed. */
export function handleGetClient(c: AppContext): Response {
  const client = c.get('client')!;
  const { token: _t, webhook_secret: _s, ...publicRecord } = client;
  return c.json(publicRecord);
}

/** PATCH /v1/client — partial update with per-field validation. */
export async function handlePatchClient(c: AppContext): Promise<Response> {
  const client = c.get('client')!;
  const config = getConfig(c.env);

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }

  if ('ip' in body || 'ipv6' in body || 'custom_domains' in body) {
    return c.json(
      {
        error: 'invalid_field',
        message: 'ip, ipv6, and custom_domains are not patchable via /client',
      },
      400,
    );
  }

  const updated: ClientRecord = { ...client };

  if ('ttl' in body) {
    if (typeof body.ttl !== 'number' || body.ttl < 30 || body.ttl > 3600) {
      return c.json({ error: 'invalid_field', message: 'ttl must be between 30 and 3600' }, 400);
    }
    updated.ttl = body.ttl;
  }

  if ('owner_email' in body) {
    if (body.owner_email === null) {
      updated.owner_email = null;
    } else if (typeof body.owner_email === 'string') {
      updated.owner_email = body.owner_email;
    } else {
      return c.json({ error: 'invalid_field', message: 'owner_email must be a string or null' }, 400);
    }
  }

  if ('webhook_secret' in body) {
    if (body.webhook_secret === null) {
      updated.webhook_secret = null;
    } else if (typeof body.webhook_secret === 'string') {
      updated.webhook_secret = body.webhook_secret;
    } else {
      return c.json({ error: 'invalid_field', message: 'webhook_secret must be a string or null' }, 400);
    }
  }

  if ('port' in body) {
    if (body.port === null) {
      updated.port = null;
    } else if (typeof body.port === 'number' && body.port >= 1 && body.port <= 65535) {
      updated.port = body.port;
    } else {
      return c.json({ error: 'invalid_field', message: 'port must be 1–65535 or null' }, 400);
    }
  }

  if ('srv_prefix' in body) {
    const result = validateSrvPrefix(body.srv_prefix);
    if (!result.ok) {
      return c.json({ error: 'invalid_field', message: result.message }, 400);
    }
    updated.srv_prefix = result.value;
  }

  if ('port' in body || 'srv_prefix' in body) {
    if (
      (updated.port === null && updated.srv_prefix !== null) ||
      (updated.port !== null && updated.srv_prefix === null)
    ) {
      return c.json({ error: 'missing_srv', message: 'port and srv_prefix must be provided together' }, 400);
    }
  }

  if ('update_interval' in body) {
    if (typeof body.update_interval !== 'number' || body.update_interval < 30 || body.update_interval > 86400) {
      return c.json({ error: 'invalid_field', message: 'update_interval must be between 30 and 86400' }, 400);
    }
    updated.update_interval = body.update_interval;
  }

  if ('tags' in body) {
    const result = validateTags(body.tags);
    if (!result.ok) {
      return c.json({ error: 'invalid_field', message: result.message }, 400);
    }
    updated.tags = result.value;
  }

  if ('metadata' in body) {
    const result = validateMetadata(body.metadata);
    if (!result.ok) {
      return c.json({ error: 'invalid_field', message: result.message }, 400);
    }
    updated.metadata = result.value;
  }

  if ('webhook_url' in body) {
    if (body.webhook_url === null) {
      updated.webhook_url = null;
    } else if (typeof body.webhook_url === 'string') {
      if (!isSafeWebhookUrl(body.webhook_url, config.webhookAllowlist)) {
        return c.json({ error: 'invalid_field', message: 'webhook_url must be a public HTTPS URL or null' }, 400);
      }
      updated.webhook_url = body.webhook_url;
    } else {
      return c.json({ error: 'invalid_field', message: 'webhook_url must be a public HTTPS URL or null' }, 400);
    }
  }

  if ('allowed_update_ips' in body) {
    const result = validateAllowedUpdateIps(body.allowed_update_ips);
    if (!result.ok) {
      return c.json({ error: 'invalid_field', message: result.message }, 400);
    }
    updated.allowed_update_ips = result.value;
  }

  if ('enabled' in body) {
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'invalid_field', message: 'enabled must be a boolean' }, 400);
    }
    if (client.enabled && !body.enabled) {
      await withdrawDnsRecords(c.env, client);
      dispatchWebhook(
        c.executionCtx,
        client,
        'disabled',
        { oldIp: client.ip, newIp: client.ip, oldPort: client.port, newPort: client.port },
        config.webhookAllowAll,
        config.webhookAllowlistExact,
        config.webhookAllowlistSuffixes,
      );
    } else if (!client.enabled && body.enabled) {
      await restoreDnsRecords(c.env, updated);
      dispatchWebhook(
        c.executionCtx,
        updated,
        'enabled',
        { oldIp: client.ip, newIp: client.ip, oldPort: client.port, newPort: client.port },
        config.webhookAllowAll,
        config.webhookAllowlistExact,
        config.webhookAllowlistSuffixes,
      );
    }
    updated.enabled = body.enabled;
  }

  if ('ttl' in body && updated.enabled) {
    if (updated.ip !== null) {
      await upsertARecord(c.env, updated.subdomain, updated.ip, updated.ttl);
    }
    if (updated.ipv6 !== null) {
      await upsertAAAARecord(c.env, updated.subdomain, updated.ipv6, updated.ttl);
    }
    if (updated.port !== null && updated.srv_prefix !== null) {
      await upsertSRVRecord(c.env, updated.subdomain, updated.srv_prefix, updated.port, updated.ttl);
    }
  }

  const portChanged = updated.port !== client.port;
  const srvChanged = updated.srv_prefix !== client.srv_prefix;
  const isDisabling = client.enabled && updated.enabled === false;
  const isEnabling = !client.enabled && updated.enabled === true;
  if (!isDisabling && !isEnabling && updated.enabled && (portChanged || srvChanged)) {
    if (client.srv_prefix !== null && client.port !== null) {
      await withdrawSRVRecord(c.env, client.subdomain, client.srv_prefix);
    }
    if (updated.srv_prefix !== null && updated.port !== null) {
      await upsertSRVRecord(c.env, client.subdomain, updated.srv_prefix, updated.port, updated.ttl);
    }
  }

  if ('redirect_http' in body) {
    if (typeof body.redirect_http !== 'boolean') {
      return c.json({ error: 'invalid_field', message: 'redirect_http must be a boolean' }, 400);
    }
    updated.redirect_http = body.redirect_http;
  }

  if ('notes' in body) {
    if (body.notes === null) {
      updated.notes = null;
    } else if (typeof body.notes === 'string' && body.notes.length <= 500) {
      updated.notes = body.notes;
    } else {
      return c.json({ error: 'invalid_field', message: 'notes must be a string of at most 500 characters or null' }, 400);
    }
  }

  await putClient(c.env.kmddns, updated);

  const now = new Date().toISOString();
  const entry: AuditEntry = {
    action: 'config_update',
    source_ip: c.req.header('CF-Connecting-IP') ?? '0.0.0.0',
    timestamp: now,
    details: { fields: Object.keys(body).join(',') },
  };
  await writeAudit(c.env.kmddns, client.token, entry);

  const { token: _t, webhook_secret: _s, ...publicRecord } = updated;
  return c.json(publicRecord);
}

/** POST /v1/client/rotate-token — invalidates the old token and issues a fresh one. */
export async function handleRotateToken(c: AppContext): Promise<Response> {
  const client = c.get('client')!;
  const oldHash = client.token;

  const plainToken = crypto.randomUUID();
  const newHash = await sha256(plainToken);

  await rotateClientToken(c.env.kmddns, oldHash, newHash);

  const now = new Date().toISOString();
  const entry: AuditEntry = {
    action: 'rotate_token',
    source_ip: c.req.header('CF-Connecting-IP') ?? '0.0.0.0',
    timestamp: now,
    details: {},
  };
  await writeAudit(c.env.kmddns, newHash, entry);

  return c.json({ token: plainToken });
}

/** DELETE /v1/client — removes the account, index keys, and all DNS records. */
export async function handleDeleteClient(c: AppContext): Promise<Response> {
  const client = c.get('client')!;

  await withdrawDnsRecords(c.env, client);
  await deleteClient(c.env.kmddns, client.token);

  const now = new Date().toISOString();
  const entry: AuditEntry = {
    action: 'self_delete',
    source_ip: c.req.header('CF-Connecting-IP') ?? '0.0.0.0',
    timestamp: now,
    details: { subdomain: client.subdomain },
  };
  await writeAudit(c.env.kmddns, client.token, entry);

  return new Response(null, { status: 204 });
}
