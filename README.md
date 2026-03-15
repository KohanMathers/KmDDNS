# KmDDNS

Free and open-source dynamic DNS built on Cloudflare Workers and D1. Gives servers and services a stable subdomain that tracks their public IP, with optional tunnel mode so no port forwarding is needed.

---

## Repository layout

| Directory                          | What it is                                                         |
| ---------------------------------- | ------------------------------------------------------------------ |
| [`worker/`](worker/)               | Cloudflare Worker — the API, DNS management, tunnel Durable Object |
| [`client-lib/`](client-lib/)       | TypeScript/JS client SDK for Node, Deno, and browsers              |
| [`minecraft-mod/`](minecraft-mod/) | Fabric/NeoForge server-side mod                                    |
| [`relay/`](relay/)                 | Go TCP relay for tunnel mode                                       |

---

## How it works

```
┌─────────────────────────────────────────────┐
│                 Cloudflare                  │
│                                             │
│   Worker (Hono)  ──►  D1 Database           │
│        │                                    │
│        └──►  TunnelSession (Durable Object) │
└──────────────────────────────────────────────┘
         ▲                    ▲
         │ DDNS updates       │ WebSocket (tunnel)
         │                    │
   Your server           Relay VPS
   (mod / SDK)           (Go binary)
                              ▲
                              │ TCP :25565
                          Players
```

**Standard DDNS:** Your server periodically calls `POST /v1/update`. The Worker updates the A record on Cloudflare DNS. Players resolve the subdomain and connect directly.

**Tunnel mode:** Your server keeps a persistent WebSocket to the Worker's Durable Object. A relay VPS accepts TCP connections from players, proxies them through the DO over WebSocket, and the mod forwards traffic to the local server. No port forwarding required.

---

## Components

### Worker
The central API. Handles registration, DDNS updates, client config, custom domains, admin operations, and the tunnel WebSocket routing. See [`worker/`](worker/) for deployment instructions and [`ROUTES.md`](ROUTES.md) for full API documentation.

### Client SDK
TypeScript library for Node.js, Deno, and browsers. Auto-detects your public IP and keeps the DDNS record updated. See [`client-lib/`](client-lib/) for usage.

### Minecraft mod
Server-side Fabric/NeoForge mod with an in-game setup wizard and tunnel support. See [`minecraft-mod/`](minecraft-mod/).

### Relay
Stateless Go binary. Reads the Minecraft handshake packet to extract the target subdomain, then proxies the TCP connection through the Worker's tunnel WebSocket. Deploy one instance per region.

---

## Quick start

1. Deploy the Worker (see [`worker/README.md`](worker/README.md))
2. Register a subdomain:
   ```bash
   curl -X POST https://your-worker.example.com/v1/register \
     -H "Content-Type: application/json" \
     -d '{"subdomain": "myserver"}'
   ```
3. Save the returned token — it is shown **once only**
4. Start sending updates via the SDK, mod, or a simple cron:
   ```bash
   curl "https://your-worker.example.com/v1/update?token=YOUR_TOKEN"
   ```

---

## Self-hosting

Everything here is designed to run on your own Cloudflare account. The Worker uses only free-tier primitives (Workers, D1, Durable Objects). The relay is a single static Go binary.

Full deployment instructions are in [`worker/README.md`](worker/README.md).

---

## License

MIT

---


### A quick note

I build these tools for fun and for the community. Keeping everything running does have real maintenance costs, and even $1 goes a long way.

If you enjoy the tools and want to give back, you can support me here: [Buy me a coffee](https://buymeacoffee.com/kohanmathers). No pressure either way — thanks for being here.