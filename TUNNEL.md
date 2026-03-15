# KmDDNS – Tunnel Mode Setup

Tunnel mode lets a Minecraft server behind NAT be reachable without port forwarding.
Players connect normally; traffic routes through the KmDDNS infrastructure.

---

## How it works

```
Player (TCP :25565)
  → Relay VPS (reads MC handshake, routes by subdomain)
    → Cloudflare Durable Object (TunnelSession, one per active host)
      → Mod WebSocket (persistent, opened on server start)
        → Local Minecraft server (127.0.0.1:port)
```

When tunnel mode is enabled for a client:
- The **A record** is pointed at the relay VPS instead of the user's IP
- The **SRV record** port is set to the relay's listening port (default 25565)
- The mod **stops sending heartbeat IP updates** and opens a persistent WebSocket instead

---

## Prerequisites

- The Worker deployed and working normally
- A VPS with a public IP (any cheap cloud VM works)
- Docker installed on the VPS (or Go 1.22+ if building from source)

---

## Step 1 — Deploy the relay

### Using Docker

```bash
docker run -d \
  --name kmddns-relay \
  --restart unless-stopped \
  -p 25565:25565 \
  -e WORKER_URL=https://ddns.kmathers.co.uk/v1 \
  -e RELAY_SECRET=<your-relay-secret> \
  ghcr.io/kohanmathers/kmddns-relay:latest
```

### Using the systemd unit (non-Docker)

Build the binary:

```bash
cd relay
go build -o /usr/local/bin/kmddns-relay .
```

Create `/etc/kmddns-relay/env`:

```
WORKER_URL=https://ddns.kmathers.co.uk/v1
RELAY_SECRET=<your-relay-secret>
LISTEN_PORT=25565
```

Install and start:

```bash
cp relay/kmddns-relay.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now kmddns-relay
```

---

## Step 2 — Configure the Worker

Set the relay's public IP and the shared secret:

```bash
# In your worker/ directory
wrangler secret put RELAY_SECRET
# Enter the same secret you used above

# Set the relay's public IP in wrangler.toml:
# RELAY_IP = "1.2.3.4"
# RELAY_PORT = "25565"   (default, change if you used a different port)
```

Then deploy:

```bash
wrangler deploy
```

Apply the D1 migration (adds the `tunnel_enabled` column):

```bash
wrangler d1 migrations apply kmddns
```

---

## Step 3 — Enable tunnel for a client

### Via the in-game setup wizard

Run `/kmddns setup` on your Minecraft server. After the port and interval steps you will be asked:

```
Would you like to enable tunnel mode? (no port forwarding required)
▶ [Yes — use tunnel]
▶ [No — I'll forward my port]
```

Choose **Yes**. The mod will set `tunnel = true` in `config/kmddns.toml` and open the tunnel WebSocket on next server start.

### Via the API (manual)

```bash
curl -X PATCH https://ddns.kmathers.co.uk/v1/client \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"tunnel_enabled": true}'
```

To disable:

```bash
curl -X PATCH https://ddns.kmathers.co.uk/v1/client \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"tunnel_enabled": false}'
```

---

## Step 4 — `kmddns.toml` config

When `tunnel = true` the mod behaves differently:

```toml
[kmddns]
enabled = true
token = "<your-token>"
tunnel = true          # enables tunnel mode
port = 25565           # your local MC port (used for the local connection only)
update_interval = 300  # ignored in tunnel mode
```

- IP heartbeats are **not sent** (the relay IP is set by the Worker)
- The mod opens a WebSocket to `wss://ddns.kmathers.co.uk/v1/tunnel` on startup
- `/kmddns status` shows `Tunnel: connected` or `Tunnel: disconnected`

---

## Relay environment variables

| Variable       | Required | Default | Description                                                   |
| -------------- | -------- | ------- | ------------------------------------------------------------- |
| `WORKER_URL`   | Yes      | —       | Base URL of the Worker, e.g. `https://ddns.kmathers.co.uk/v1` |
| `RELAY_SECRET` | Yes      | —       | Shared secret; must match the Worker's `RELAY_SECRET`         |
| `LISTEN_PORT`  | No       | `25565` | TCP port the relay listens on                                 |

---

## Worker environment variables (tunnel-related)

Set in `wrangler.toml` under `[vars]`:

| Variable     | Default   | Description                |
| ------------ | --------- | -------------------------- |
| `RELAY_IP`   | `""`      | Public IP of the relay VPS |
| `RELAY_PORT` | `"25565"` | Port the relay listens on  |

Set via `wrangler secret put`:

| Secret         | Description                                    |
| -------------- | ---------------------------------------------- |
| `RELAY_SECRET` | Shared secret between the relay and the Worker |

---

## Player capacity

The tunnel routes through a Cloudflare Durable Object using the WebSocket Hibernation API, so the DO sleeps between frames. On the free tier (~128 KB/s egress per DO) expect comfortable support for **10–15 simultaneous players** per tunnel. This is not enforced in code.
