import type { Env, ClientRecord } from './types.js';
import { getClient, putClient, readClientSummaryFromMetadata } from './kv.js';
import { withdrawDnsRecords } from './dns.js';

async function sendStaleEmail(env: Env, record: ClientRecord): Promise<void> {
  if (!env.RESEND_API_KEY || !record.owner_email) return;

  const fqdn = `${record.subdomain}.${env.BASE_DOMAIN}`;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `KmDDNS <noreply@${env.BASE_DOMAIN}>`,
      to: [record.owner_email],
      subject: `Your KmDDNS record for ${fqdn} has been withdrawn`,
      text: [
        `Your KmDDNS record for ${fqdn} has not been updated in over ${env.STALE_DAYS} days.`,
        '',
        'DNS records have been withdrawn. To restore them, send an update from your client.',
        'If you no longer need this record, you can delete your account at any time.',
      ].join('\n'),
    }),
  });
}

/** Cron handler — runs daily at 03:00 UTC via the `scheduled` export in index.ts. */
export async function handleScheduled(
  _event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const staleDays = parseInt(env.STALE_DAYS, 10);
  const staleBefore = Date.now() - staleDays * 24 * 60 * 60 * 1000;

  let cursor: string | undefined;

  async function processStale(record: ClientRecord): Promise<void> {
    await withdrawDnsRecords(env, record);
    record.enabled = false;
    await putClient(env.DDNS_KV, record);
    ctx.waitUntil(sendStaleEmail(env, record));
  }

  do {
    const opts: KVNamespaceListOptions = { prefix: 'client:', limit: 100 };
    if (cursor !== undefined) opts.cursor = cursor;

    const page = await env.DDNS_KV.list(opts);

    const tokensNeedingFetch: string[] = [];
    const staleTokens: string[] = [];
    const fetchedRecords = new Map<string, ClientRecord>();

    for (const key of page.keys) {
      const token = key.name.slice('client:'.length);
      const summary = readClientSummaryFromMetadata(key.metadata);
      if (!summary) {
        tokensNeedingFetch.push(token);
        continue;
      }
      if (!summary.enabled) continue;
      const lastActivity = summary.last_seen ?? summary.created_at;
      if (new Date(lastActivity).getTime() <= staleBefore) {
        staleTokens.push(token);
      }
    }

    if (tokensNeedingFetch.length > 0) {
      const fetched = await Promise.all(tokensNeedingFetch.map(token => getClient(env.DDNS_KV, token)));
      for (const record of fetched) {
        if (record === null) continue;
        fetchedRecords.set(record.token, record);
        if (!record.enabled) continue;
        const lastActivity = record.last_seen ?? record.created_at;
        if (new Date(lastActivity).getTime() <= staleBefore) {
          staleTokens.push(record.token);
        }
      }
    }

    if (staleTokens.length > 0) {
      const staleRecords = await Promise.all(
        staleTokens.map(token => fetchedRecords.get(token) ?? getClient(env.DDNS_KV, token)),
      );
      for (const record of staleRecords) {
        if (record === null) continue;
        if (!record.enabled) continue;
        const lastActivity = record.last_seen ?? record.created_at;
        if (new Date(lastActivity).getTime() > staleBefore) continue;
        await processStale(record);
      }
    }

    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor !== undefined);
}
