import type { Context } from 'hono';
import type { Env, Variables, AuditEntry } from '../types.js';
import {
  getByCustomDomain,
  putCustomDomainIndex,
  deleteCustomDomainIndex,
  putClient,
  getPendingCustomDomain,
  putPendingCustomDomain,
  deletePendingCustomDomain,
  writeAudit,
} from '../kv.js';
import { upsertCNAME, getRecordId, deleteRecord } from '../dns.js';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

const HOSTNAME_REGEX = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

interface DoHResponse {
  Answer?: { type: number; data: string }[];
}

async function resolveTxtRecords(name: string): Promise<string[]> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`;
  const res = await fetch(url, { headers: { Accept: 'application/dns-json' } });
  if (!res.ok) return [];
  const body = (await res.json()) as DoHResponse;
  //CF's DoH sometimes wraps data in quotes so strip them.
  return (body.Answer ?? [])
    .filter(r => r.type === 16)
    .map(r => r.data.replace(/^"|"$/g, ''));
}

/** POST /v1/custom-domain — initiate TXT-based ownership verification for a hostname. */
export async function handlePostCustomDomain(c: AppContext): Promise<Response> {
  const client = c.get('client')!;

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }

  const hostname = typeof body.hostname === 'string' ? body.hostname.toLowerCase() : '';
  if (!hostname || !HOSTNAME_REGEX.test(hostname)) {
    return c.json({ error: 'invalid_hostname', message: 'hostname must be a valid domain name' }, 400);
  }

  const existingOwner = await getByCustomDomain(c.env.DDNS_KV, hostname);
  if (existingOwner !== null && existingOwner !== client.token) {
    return c.json({ error: 'domain_already_verified', message: 'This hostname is already claimed by another account' }, 409);
  }

  const challenge = crypto.randomUUID().replace(/-/g, '');
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000;

  await putPendingCustomDomain(c.env.DDNS_KV, hostname, {
    token: client.token,
    challenge,
    expires_at: expiresAt,
  });

  return c.json(
    {
      verification_record: {
        type: 'TXT',
        name: `_kmddns-verify.${hostname}`,
        value: `kmddns-verify=${challenge}`,
      },
      instructions: `Add the TXT record above, then call GET /v1/custom-domain/verify?hostname=${hostname}`,
    },
    202,
  );
}

/** GET /v1/custom-domain/verify — resolve the TXT record via DoH and activate CNAME on match. */
export async function handleVerifyCustomDomain(c: AppContext): Promise<Response> {
  const client = c.get('client')!;
  const hostname = (c.req.query('hostname') ?? '').toLowerCase();

  if (!hostname || !HOSTNAME_REGEX.test(hostname)) {
    return c.json({ error: 'invalid_hostname', message: 'hostname must be a valid domain name' }, 400);
  }

  const existingOwner = await getByCustomDomain(c.env.DDNS_KV, hostname);
  if (existingOwner !== null && existingOwner !== client.token) {
    return c.json({ error: 'domain_already_verified', message: 'This hostname is already claimed by another account' }, 409);
  }

  const pending = await getPendingCustomDomain(c.env.DDNS_KV, hostname);
  if (pending === null || pending.token !== client.token) {
    return c.json({ error: 'verification_failed', message: 'No pending verification found for this hostname' }, 422);
  }

  // Challenge TTL is enforced at KV expiry, but we double-check in case of clock drift.
  if (Date.now() > pending.expires_at) {
    return c.json({ error: 'verification_failed', message: 'Verification challenge has expired — start again with POST /v1/custom-domain' }, 422);
  }

  const txtRecords = await resolveTxtRecords(`_kmddns-verify.${hostname}`);
  const expected = `kmddns-verify=${pending.challenge}`;
  if (!txtRecords.includes(expected)) {
    return c.json({ error: 'verification_failed', message: 'TXT record not found or value mismatch' }, 422);
  }

  const target = `${client.subdomain}.${c.env.BASE_DOMAIN}`;
  await upsertCNAME(c.env, hostname, target);
  await putCustomDomainIndex(c.env.DDNS_KV, hostname, client.token);
  await deletePendingCustomDomain(c.env.DDNS_KV, hostname);

  if (!client.custom_domains.includes(hostname)) {
    const updated = { ...client, custom_domains: [...client.custom_domains, hostname] };
    await putClient(c.env.DDNS_KV, updated);
  }

  const now = new Date().toISOString();
  const entry: AuditEntry = {
    action: 'custom_domain_verified',
    source_ip: c.req.header('CF-Connecting-IP') ?? '0.0.0.0',
    timestamp: now,
    details: { hostname },
  };
  await writeAudit(c.env.DDNS_KV, client.token, entry);

  return c.json({ hostname, cname_target: target });
}

/** DELETE /v1/custom-domain — remove a verified custom domain and its CNAME record. */
export async function handleDeleteCustomDomain(c: AppContext): Promise<Response> {
  const client = c.get('client')!;

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }

  const hostname = typeof body.hostname === 'string' ? body.hostname.toLowerCase() : '';
  if (!hostname || !HOSTNAME_REGEX.test(hostname)) {
    return c.json({ error: 'invalid_hostname', message: 'hostname must be a valid domain name' }, 400);
  }

  if (!client.custom_domains.includes(hostname)) {
    return c.json({ error: 'not_found', message: 'Custom domain not found on this account' }, 404);
  }

  const cnameId = await getRecordId(c.env, hostname, 'CNAME');
  if (cnameId) await deleteRecord(c.env, cnameId);

  await deleteCustomDomainIndex(c.env.DDNS_KV, hostname);

  const updated = { ...client, custom_domains: client.custom_domains.filter(d => d !== hostname) };
  await putClient(c.env.DDNS_KV, updated);

  const now = new Date().toISOString();
  const entry: AuditEntry = {
    action: 'custom_domain_deleted',
    source_ip: c.req.header('CF-Connecting-IP') ?? '0.0.0.0',
    timestamp: now,
    details: { hostname },
  };
  await writeAudit(c.env.DDNS_KV, client.token, entry);

  return new Response(null, { status: 204 });
}
