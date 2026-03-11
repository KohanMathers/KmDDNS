import type { ClientRecord } from './types.js';
import { ipv4IsPublic, ipv6IsPublic, parseIPv4, parseIPv6 } from './ip.js';

export interface ChangeSnapshot {
  oldIp: string | null;
  newIp: string | null;
  oldPort: number | null;
  newPort: number | null;
}

/** HMAC-SHA256 hex digest for webhook payload signing. */
async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function isHostnameAllowlisted(
  hostname: string,
  allowAll: boolean,
  exact: Set<string>,
  suffixes: string[],
): boolean {
  if (allowAll) return true;
  if (exact.has(hostname)) return true;
  return suffixes.some(entry => hostname.endsWith(entry));
}

/**
 * Fires a signed POST to the client's webhook_url.
 * Uses waitUntil so the update response is never delayed by the webhook call.
 * A dead or slow webhook endpoint must not poison the update, failures are silently dropped.
 */
export function dispatchWebhook(
  ctx: ExecutionContext,
  record: ClientRecord,
  event: string,
  change: ChangeSnapshot,
  allowAll: boolean,
  allowlistExact: Set<string>,
  allowlistSuffixes: string[],
): void {
  if (!record.webhook_url) return;

  const payload = {
    event,
    subdomain: record.subdomain,
    old_ip: change.oldIp,
    new_ip: change.newIp,
    old_port: change.oldPort,
    new_port: change.newPort,
    timestamp: new Date().toISOString(),
  };
  const body = JSON.stringify(payload);
  const url = record.webhook_url;
  const secret = record.webhook_secret;

  ctx.waitUntil(
    (async () => {
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        return;
      }

      const hostname = target.hostname.toLowerCase();
      const isIpv4 = parseIPv4(hostname) !== null;
      const isIpv6 = parseIPv6(hostname) !== null;
      if (isIpv4 && !ipv4IsPublic(hostname)) return;
      if (isIpv6 && !ipv6IsPublic(hostname)) return;
      if (!isIpv4 && !isIpv6 && !isHostnameAllowlisted(hostname, allowAll, allowlistExact, allowlistSuffixes)) return;

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (secret) {
        const sig = await hmacSha256Hex(secret, body);
        headers['X-KmDDNS-Signature'] = `sha256=${sig}`;
      }
      try {
        await fetch(url, { method: 'POST', headers, body });
      } catch {
        // Fire-and-forget: swallow all errors.
      }
    })(),
  );
}
