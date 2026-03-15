# kmddns

TypeScript/JavaScript client SDK for [KmDDNS](https://ddns.kmathers.co.uk). Keeps your dynamic DNS record updated automatically. Works in Node.js, Deno, and browsers.

---

## Installation

```bash
npm install kmddns
```

---

## Quick start

```ts
import { KmDDNSClient } from 'kmddns';

const client = new KmDDNSClient({
  token: 'your-token',
  apiBase: 'https://ddns.kmathers.co.uk/v1',
});

client.start(); // begins heartbeat loop — first update fires within milliseconds
```

To stop cleanly (e.g. on process exit):

```ts
await client.stop();
```

---

## Options

```ts
new KmDDNSClient({
  token: string;               // Bearer token from POST /v1/register
  apiBase: string;             // Must end with /v1
  port?: number;               // Port to advertise in the SRV record (1–65535)
  updateIntervalSeconds?: number; // Heartbeat interval (default: 300)
  staticIp?: string;           // Skip detection and always send this IP
  onIpChanged?: (oldIp: string, newIp: string) => void; // Called on IP change
})
```

---

## Methods

| Method | Description |
|---|---|
| `client.start()` | Start the heartbeat loop. No-op if already running. |
| `await client.stop()` | Stop the loop and wait for any in-flight request to finish. |
| `await client.forceUpdate()` | Send one update immediately, outside the loop. Returns `'OK'` or `'NOCHG'`. |

---

## IP detection

The SDK resolves your public IP using a chain of methods, stopping at the first success:

1. `staticIp` constructor option
2. `kmddns_IP` environment variable (Node.js or Deno)
3. Server-reflected IP via `GET /v1/update?dry=true` (uses your token, no changes made)
4. STUN via `RTCPeerConnection` (browser only)
5. [ipify.org](https://www.ipify.org/) as a final fallback

You can also call `detectIp` directly if you need the IP without using the full client:

```ts
import { detectIp } from 'kmddns';

const ip = await detectIp({
  token: 'your-token',
  apiBase: 'https://ddns.kmathers.co.uk/v1',
});
```

Or skip detection entirely with a static IP:

```ts
const client = new KmDDNSClient({
  token: 'your-token',
  apiBase: 'https://ddns.kmathers.co.uk/v1',
  staticIp: '203.0.113.5',
});
```

---

## Examples

### With port and change callback

```ts
const client = new KmDDNSClient({
  token: 'your-token',
  apiBase: 'https://ddns.kmathers.co.uk/v1',
  port: 25565,
  updateIntervalSeconds: 120,
  onIpChanged: (old, next) => {
    console.log(`IP updated: ${old} → ${next}`);
  },
});

client.start();
```

### One-shot update (cron / serverless)

```ts
const client = new KmDDNSClient({
  token: process.env.KMDDNS_TOKEN!,
  apiBase: 'https://ddns.kmathers.co.uk/v1',
});

const result = await client.forceUpdate();
console.log(result); // 'OK' or 'NOCHG'
```

### Graceful shutdown in Node.js

```ts
process.on('SIGTERM', async () => {
  await client.stop();
  process.exit(0);
});
```

---

## Building from source

```bash
npm install
npm run build    # outputs to dist/
npm test
```

---

## License

MIT
