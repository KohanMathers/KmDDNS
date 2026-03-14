import { detectIp } from './ip-detect.js';

/** Constructor options for {@link KmDDNSClient}. */
export interface KmDDNSClientOptions {
  /** Bearer token issued by `POST /v1/register`. */
  token: string;
  /** Base URL of the KmDDNS API **including `/v1`**, e.g. `https://api.ddns.example.com/v1`. */
  apiBase: string;
  /** Port to advertise in the SRV record. Omit if the client has no `srv_prefix`. */
  port?: number;
  /** How often to send heartbeats, in seconds. Defaults to 300 (5 minutes). */
  updateIntervalSeconds?: number;
  /**
   * Skip all IP detection and always send this address.
   * Useful for servers with a known static IP or when a custom detection mechanism is used.
   */
  staticIp?: string;
  /**
   * Called once each time the recorded IP transitions to a new value.
   * Not called on `NOCHG` (i.e. when the IP has not changed since the last update).
   */
  onIpChanged?: (oldIp: string, newIp: string) => void;
}

/** Result returned by {@link KmDDNSClient.forceUpdate}. */
export type UpdateResult = 'OK' | 'NOCHG';

/**
 * KmDDNS TypeScript client.
 *
 * @example
 * ```ts
 * const client = new KmDDNSClient({
 *   token: 'my-token',
 *   apiBase: 'https://api.ddns.example.com/v1',
 *   port: 25565,
 *   onIpChanged: (old, next) => console.log(`IP changed: ${old} → ${next}`),
 * });
 *
 * client.start();                // begins heartbeat loop
 * await client.forceUpdate();    // one-shot update
 * await client.stop();           // graceful shutdown
 * ```
 */
export class KmDDNSClient {
  private readonly options: KmDDNSClientOptions;
  private timer: ReturnType<typeof setTimeout> | undefined = undefined;
  private stopRequested = false;
  private currentTick: Promise<UpdateResult> | undefined = undefined;
  private lastIp: string | null = null;

  constructor(options: KmDDNSClientOptions) {
    if (!options.apiBase.endsWith('/v1')) {
      throw new Error(
        `KmDDNS: apiBase must end with "/v1" (got "${options.apiBase}"). ` +
        'Example: "https://api.ddns.example.com/v1"',
      );
    }
    if (options.port !== undefined && (options.port < 1 || options.port > 65535 || !Number.isInteger(options.port))) {
      throw new Error(`KmDDNS: port must be an integer between 1 and 65535 (got ${options.port})`);
    }
    this.options = options;
  }

  /**
   * Begins the heartbeat loop.
   *
   * The first update is dispatched within a few milliseconds of this call.
   * Subsequent updates fire every `updateIntervalSeconds` seconds (+ a random
   * jitter of up to 10 s to prevent thundering-herd on shared infrastructure).
   *
   * Calling `start()` while already running is a no-op.
   */
  start(): void {
    if (!this.stopRequested && this.timer !== undefined) return;
    this.stopRequested = false;
    this.scheduleNext(0);
  }

  /**
   * Stops the heartbeat loop.
   *
   * Clears the pending timer and waits for any in-flight tick to finish
   * before resolving, so the returned promise is safe to `await` in teardown
   * code.
   */
  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.currentTick !== undefined) {
      await this.currentTick.catch(() => undefined);
      this.currentTick = undefined;
    }
  }

  /**
   * Performs a single update immediately, regardless of the heartbeat loop.
   *
   * Returns `'OK'` if the recorded IP changed (or this is the first update),
   * or `'NOCHG'` if the IP is identical to the previous update sent by this
   * client instance.
   */
  async forceUpdate(): Promise<UpdateResult> {
    return this.tick();
  }

  private scheduleNext(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.stopRequested) return;

      this.currentTick = this.tick();
      this.currentTick
        .then(() => {
          this.currentTick = undefined;
          if (!this.stopRequested) {
            const intervalMs = (this.options.updateIntervalSeconds ?? 300) * 1000;
            const jitterMs = Math.floor(Math.random() * 10_000);
            this.scheduleNext(intervalMs + jitterMs);
          }
        })
        .catch(err => {
          this.currentTick = undefined;
          if (typeof console !== 'undefined') {
            console.error('[KmDDNS] update error:', err instanceof Error ? err.message : err);
          }
          if (!this.stopRequested) {
            this.scheduleNext(60_000);
          }
        });
    }, delayMs);
  }

  private async tick(): Promise<UpdateResult> {
    const ip = await detectIp({
      token: this.options.token,
      apiBase: this.options.apiBase,
      staticIp: this.options.staticIp,
    });

    const body: Record<string, unknown> = { ip };
    if (this.options.port !== undefined) body['port'] = this.options.port;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let resp: Response;
    try {
      resp = await fetch(`${this.options.apiBase}/update`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`KmDDNS update failed (HTTP ${resp.status}): ${detail}`);
    }

    const updated = (await resp.json()) as { ip?: string };
    const newIp = (typeof updated.ip === 'string' && updated.ip.length > 0) ? updated.ip : ip;

    const changed = this.lastIp === null || this.lastIp !== newIp;

    if (changed && this.lastIp !== null && this.options.onIpChanged) {
      this.options.onIpChanged(this.lastIp, newIp);
    }

    this.lastIp = newIp;
    return changed ? 'OK' : 'NOCHG';
  }
}
