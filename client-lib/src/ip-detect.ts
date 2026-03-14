/** Options needed for IP detection. */
export interface IpDetectOptions {
  token: string;
  apiBase: string;
  staticIp?: string;
}

/**
 * Attempts to get the reflected external IP from the KmDDNS server using dry=true.
 * Uses GET with token in the query string (acceptable here since it's read-only and dry).
 */
async function detectViaServerReflect(token: string, apiBase: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const url = `${apiBase}/update?token=${encodeURIComponent(token)}&dry=true`;
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return null;
    const ip = (await resp.text()).trim();
    return ip.length > 0 ? ip : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Attempts to resolve the external IP via STUN using RTCPeerConnection.
 * Browser-only — silently returns null in Node.js / Deno.
 */
async function detectViaStun(): Promise<string | null> {
  if (typeof RTCPeerConnection === 'undefined') return null;
  return new Promise<string | null>(resolve => {
    const timeout = setTimeout(() => {
      try { pc.close(); } catch { /* ignore */ }
      resolve(null);
    }, 5000);

    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    } catch {
      clearTimeout(timeout);
      resolve(null);
      return;
    }

    const candidates: string[] = [];
    pc.createDataChannel('');
    pc.onicecandidate = e => {
      if (e.candidate) {
        const match = /([0-9]{1,3}(?:\.[0-9]{1,3}){3})/.exec(e.candidate.candidate);
        if (match) candidates.push(match[1]);
      } else {
        clearTimeout(timeout);
        try { pc.close(); } catch { /* ignore */ }
        const ip = candidates.find(c => !isPrivateIpv4(c));
        resolve(ip ?? null);
      }
    };

    pc.createOffer()
      .then(offer => pc.setLocalDescription(offer))
      .catch(() => {
        clearTimeout(timeout);
        try { pc.close(); } catch { /* ignore */ }
        resolve(null);
      });
  });
}

/** Fetches the external IPv4 address from ipify.org as a final fallback. */
async function detectViaIpify(): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const resp = await fetch('https://api4.ipify.org/', { signal: controller.signal });
    if (!resp.ok) return null;
    const ip = (await resp.text()).trim();
    return ip.length > 0 ? ip : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Returns true if the IPv4 address falls within a private, loopback, link-local,
 * CGNAT, or unspecified range that should never be treated as a public address.
 *
 * Ranges checked:
 *   0.0.0.0/8       — "this" network
 *   10.0.0.0/8      — RFC-1918
 *   100.64.0.0/10   — CGNAT (RFC-6598)
 *   127.0.0.0/8     — loopback
 *   169.254.0.0/16  — link-local (RFC-3927)
 *   172.16.0.0/12   — RFC-1918 (172.16–172.31 only)
 *   192.168.0.0/16  — RFC-1918
 */
function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return true;
  const [a, b] = parts.map(Number);
  if (a === 0) return true;                        // 0.0.0.0/8
  if (a === 10) return true;                       // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10
  if (a === 127) return true;                      // 127.0.0.0/8
  if (a === 169 && b === 254) return true;         // 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;         // 192.168.0.0/16
  return false;
}

/**
 * Resolves the external IP address using the following detection chain:
 *
 * 1. `staticIp` constructor override
 * 2. `kmddns_IP` environment variable (Node.js / Deno)
 * 3. Server-reflected IP via `GET /v1/update?dry=true`
 * 4. STUN via RTCPeerConnection (browser only)
 * 5. ipify.org fallback
 *
 * Throws if no method succeeds.
 */
export async function detectIp(opts: IpDetectOptions): Promise<string> {
  if (opts.staticIp) return opts.staticIp;

  const envIp = readEnvIp();
  if (envIp) return envIp;

  const reflected = await detectViaServerReflect(opts.token, opts.apiBase);
  if (reflected) return reflected;

  const stun = await detectViaStun();
  if (stun) return stun;

  const ipify = await detectViaIpify();
  if (ipify) return ipify;

  throw new Error('KmDDNS: unable to detect external IP address via any method');
}

/** Reads `kmddns_IP` from the environment in Node.js or Deno. */
function readEnvIp(): string | null {
  if (typeof process !== 'undefined' && typeof process.env === 'object') {
    const v = process.env['kmddns_IP'];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  try {
    const deno = (globalThis as Record<string, unknown>)['Deno'] as
      | { env: { get(key: string): string | undefined } }
      | undefined;
    const v = deno?.env.get('kmddns_IP');
    if (typeof v === 'string' && v.length > 0) return v;
  } catch {
    // Deno.env.get can throw if permissions are not granted — treat as absent.
  }
  return null;
}
