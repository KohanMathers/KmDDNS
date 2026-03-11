import type { Env, ClientRecord } from './types.js';

const CF_API = 'https://api.cloudflare.com/client/v4/zones';

interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
}

interface CfApiResponse<T> {
  success: boolean;
  result: T;
  errors: { code: number; message: string }[];
}

function headers(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${env.CF_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

async function cfFetch<T>(env: Env, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${CF_API}/${env.CF_ZONE_ID}/dns_records${path}`, {
    ...init,
    headers: headers(env),
  });

  const body = (await res.json()) as CfApiResponse<T>;

  if (!body.success) {
    const msg = body.errors?.[0]?.message ?? 'unknown error';
    // CF returned a non-success response; surface it as a typed error so callers can wrap it in 500.
    throw new Error(`Cloudflare API error: ${msg}`);
  }

  return body.result;
}

/** Finds the CF record ID for an exact name+type match, or null if not found. */
export async function getRecordId(
  env: Env,
  name: string,
  type: string,
): Promise<string | null> {
  const records = await cfFetch<CfDnsRecord[]>(
    env,
    `?type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}`,
  );
  return records[0]?.id ?? null;
}

/** Deletes a DNS record by its CF record ID. */
export async function deleteRecord(env: Env, recordId: string): Promise<void> {
  await cfFetch<unknown>(env, `/${recordId}`, { method: 'DELETE' });
}

async function upsert(
  env: Env,
  name: string,
  type: string,
  content: string,
  ttl: number,
  extra?: Record<string, unknown>,
): Promise<void> {
  const existing = await getRecordId(env, name, type);
  const payload = JSON.stringify({ type, name, content, ttl, proxied: false, ...extra });

  if (existing) {
    await cfFetch<unknown>(env, `/${existing}`, { method: 'PUT', body: payload });
  } else {
    await cfFetch<unknown>(env, '', { method: 'POST', body: payload });
  }
}

export async function upsertARecord(env: Env, subdomain: string, ip: string, ttl: number): Promise<void> {
  const name = `${subdomain}.${env.BASE_DOMAIN}`;
  await upsert(env, name, 'A', ip, ttl);
}

export async function upsertAAAARecord(env: Env, subdomain: string, ipv6: string, ttl: number): Promise<void> {
  const name = `${subdomain}.${env.BASE_DOMAIN}`;
  await upsert(env, name, 'AAAA', ipv6, ttl);
}

/** Removes all active DNS records (A, AAAA, SRV) for a client. */
export async function withdrawDnsRecords(env: Env, record: ClientRecord): Promise<void> {
  const base = `${record.subdomain}.${env.BASE_DOMAIN}`;

  async function deleteIfExists(name: string, type: string): Promise<void> {
    const id = await getRecordId(env, name, type);
    if (id) await deleteRecord(env, id);
  }

  const ops: Promise<void>[] = [];
  if (record.ip !== null) ops.push(deleteIfExists(base, 'A'));
  if (record.ipv6 !== null) ops.push(deleteIfExists(base, 'AAAA'));
  if (record.port !== null && record.srv_prefix !== null) {
    ops.push(deleteIfExists(`${record.srv_prefix}.${base}`, 'SRV'));
  }

  await Promise.all(ops);
}

export async function withdrawAAAARecord(env: Env, subdomain: string): Promise<void> {
  const base = `${subdomain}.${env.BASE_DOMAIN}`;
  const id = await getRecordId(env, base, 'AAAA');
  if (id) await deleteRecord(env, id);
}

export async function withdrawSRVRecord(env: Env, subdomain: string, srvPrefix: string): Promise<void> {
  const target = `${subdomain}.${env.BASE_DOMAIN}`;
  const name = `${srvPrefix}.${target}`;
  const id = await getRecordId(env, name, 'SRV');
  if (id) await deleteRecord(env, id);
}

/**
 * Upserts a SRV record for `{srvPrefix}.{subdomain}.{baseDomain}`.
 * SRV data must go in the `data` field, not `content` — CF's API quirk prevents
 * reuse of the shared upsert() helper which always emits a `content` key.
 */
export async function upsertSRVRecord(
  env: Env,
  subdomain: string,
  srvPrefix: string,
  port: number,
  ttl: number,
): Promise<void> {
  const target = `${subdomain}.${env.BASE_DOMAIN}`;
  const name = `${srvPrefix}.${target}`;

  const existing = await getRecordId(env, name, 'SRV');
  const payload = JSON.stringify({
    type: 'SRV',
    name,
    ttl,
    data: { priority: 0, weight: 5, port, target },
  });

  if (existing) {
    await cfFetch<unknown>(env, `/${existing}`, { method: 'PUT', body: payload });
  } else {
    await cfFetch<unknown>(env, '', { method: 'POST', body: payload });
  }
}

export async function upsertTXTRecord(env: Env, subdomain: string, value: string, ttl: number): Promise<void> {
  const name = `${subdomain}.${env.BASE_DOMAIN}`;
  await upsert(env, name, 'TXT', value, ttl);
}

export async function upsertCNAME(env: Env, hostname: string, target: string): Promise<void> {
  // TTL 1 = automatic on Cloudflare; CNAME target must be a FQDN.
  await upsert(env, hostname, 'CNAME', target, 1);
}
