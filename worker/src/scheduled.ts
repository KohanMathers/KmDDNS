import type { Env, ClientRecord } from './types.js';
import { putClient, getStaleEnabledClients, purgeExpired } from './db.js';
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
  const staleBeforeISO = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000).toISOString();

  const staleRecords = await getStaleEnabledClients(env.kmddns, staleBeforeISO);

  for (const record of staleRecords) {
    await withdrawDnsRecords(env, record);
    record.enabled = false;
    await putClient(env.kmddns, record);
    ctx.waitUntil(sendStaleEmail(env, record));
  }

  ctx.waitUntil(purgeExpired(env.kmddns));
}
