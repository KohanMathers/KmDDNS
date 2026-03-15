# KmDDNS Worker

The Cloudflare Worker that powers KmDDNS. Handles the REST API, DNS management via the Cloudflare API, and WebSocket tunnel routing through a Durable Object.

---

## Stack

- **Runtime:** Cloudflare Workers
- **Framework:** Hono
- **Database:** D1 (SQLite)
- **Tunnel routing:** Durable Objects (hibernatable WebSockets)
- **DNS management:** Cloudflare DNS API

---

## Prerequisites

- A Cloudflare account with Workers and D1 enabled
- A domain managed by Cloudflare
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) installed (`npm i -g wrangler`)

---

## Deployment

### 1. Clone and install

```bash
cd worker
npm install
```

### 2. Create the D1 database

```bash
wrangler d1 create kmddns
```

Copy the `database_id` from the output into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "kmddns"
database_name = "kmddns"
database_id = "YOUR_DATABASE_ID_HERE"
```

### 3. Run migrations

```bash
wrangler d1 migrations apply kmddns
```

### 4. Configure `wrangler.toml`

```toml
[vars]
BASE_DOMAIN = "ddns.yourdomain.com"   # subdomains register under this
DEFAULT_TTL = "60"
STALE_DAYS  = "30"
RELAY_IP    = ""                       # IP of your relay VPS (set if using tunnel mode)
RELAY_PORT  = "25565"
```

### 5. Set secrets

```bash
wrangler secret put CF_API_TOKEN    # Cloudflare API token — Zone:DNS:Edit + Zone:Zone:Read
wrangler secret put CF_ZONE_ID      # Zone ID of your domain
wrangler secret put ADMIN_SECRET    # Long random string for admin routes
wrangler secret put RELAY_SECRET    # Shared secret with the relay binary
wrangler secret put RESEND_API_KEY  # (optional) Resend key for stale-record emails
```

### 6. Deploy

```bash
wrangler deploy
```

---

## Configuration reference

| Variable | Required | Description |
|---|---|---|
| `BASE_DOMAIN` | Yes | Domain subdomains are created under, e.g. `ddns.example.com` |
| `MAX_SUBDOMAIN_LENGTH` | No | Max subdomain label length (default `63`) |
| `DEFAULT_TTL` | No | DNS TTL for new records in seconds (default `60`) |
| `STALE_DAYS` | No | Days before an inactive record is withdrawn (default `30`) |
| `RELAY_IP` | Tunnel only | Public IP of the relay VPS |
| `RELAY_PORT` | Tunnel only | Port the relay listens on (default `25565`) |
| `ALLOW_PRIVATE_IPS` | No | Set `true` to allow private IPs in updates (default `false`) |
| `WEBHOOK_HOST_ALLOWLIST` | No | Comma-separated hostnames allowed as webhook targets; `*` for any |
| `CF_API_TOKEN` | Yes | Secret — Cloudflare API token |
| `CF_ZONE_ID` | Yes | Secret — Cloudflare zone ID |
| `ADMIN_SECRET` | Yes | Secret — admin route authentication |
| `RELAY_SECRET` | Tunnel only | Secret — shared with relay binary |
| `RESEND_API_KEY` | No | Secret — Resend API key for email notifications |

---

## Tunnel mode

To enable tunnel mode:

1. Set `RELAY_IP` (in `wrangler.toml` or via `wrangler secret put RELAY_IP`) to the public IP of your relay VPS.
2. Set `RELAY_SECRET` on both the Worker and the relay binary.
3. Deploy the [relay binary](../relay/) on the VPS.
4. Enable tunnel on a client's account:
   ```bash
   curl -X PATCH https://your-worker.example.com/v1/client \
     -H "Authorization: Bearer YOUR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"tunnel_enabled": true}'
   ```
   This also updates the client's A record to point at the relay IP.

---

## Development

```bash
wrangler dev           # local dev with remote D1
wrangler dev --local   # fully local (uses local D1 replica)
```

Run tests:

```bash
npm test
```

---

## API

See [`../ROUTES.md`](../ROUTES.md) for full API documentation.

---

## Scheduled jobs

The Worker runs a daily cron at 03:00 UTC (`0 3 * * *`) that:
- Withdraws DNS records and disables accounts that haven't updated in `STALE_DAYS` days
- Sends an email via Resend if `RESEND_API_KEY` and an owner email are set
- Purges expired rows from rate limit and pending verification tables
