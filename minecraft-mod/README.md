Automatically keeps your [KmDDNS](https://ddns.kmathers.co.uk) record up to date so players can always find your server — even when your IP changes.

No router config. No static IP. Just install and run.

---

### What it does

KmDDNS gives your Minecraft server a permanent address like `myserver.ddns.kmathers.co.uk`. Whenever your server starts, the mod checks your current public IP and updates the DNS record automatically. Players always connect to the same address.

**Tunnel mode** takes this further — if you can't or don't want to forward ports, the mod connects to a relay that routes player traffic through KmDDNS infrastructure. No port forwarding required at all.

---

### Features

- Keeps your subdomain pointing at your current IP automatically
- Sends your server's MOTD and player count to the KmDDNS API (shown on the lookup page)
- **Tunnel mode** — no port forwarding needed, traffic is proxied through a relay
- In-game setup wizard — register or configure everything without leaving the game
- `/kmddns status` to see your current address, IP, and connection state at a glance
- Configurable heartbeat interval, port, and tags

---

### Setup

#### 1. Get a subdomain

Run `/kmddns setup` in-game to open the wizard. You can:

- **Register a new subdomain** — pick a name and get a token on the spot
- **Use an existing token** — if you already have a KmDDNS account

The wizard walks you through port detection, update interval, and whether to use tunnel mode. When you confirm, it saves the config and starts immediately.

#### 2. That's it

Your server will now appear at `yourname.ddns.kmathers.co.uk`. Players connect using that address.

---

### Tunnel mode

If you're behind CGNAT, a strict firewall, or just don't want to mess with port forwarding, enable tunnel mode during setup.

In tunnel mode:
- The mod keeps a WebSocket connection open to KmDDNS
- When a player connects to your subdomain, the relay routes them through to your server
- Your server doesn't need to be reachable from the internet directly

Enable it during `/kmddns setup`, or set `tunnel = true` in the config and toggle it on via the API.

---

### Commands

| Command                       | Description                                                    |
| ----------------------------- | -------------------------------------------------------------- |
| `/kmddns status`              | Show current IP, subdomain, tunnel state, and last update time |
| `/kmddns setup`               | Open the interactive setup wizard                              |
| `/kmddns setup token <token>` | Configure with an existing token                               |
| `/kmddns setup new`           | Register a new subdomain                                       |

---

### Config

The config file is created automatically at `config/kmddns.toml` on first launch.

```toml
[kmddns]
enabled = true
token = "your-token-here"
api_base = "https://ddns.kmathers.co.uk/v1"
port = 0                  # 0 = auto-detect from server.properties
update_interval = 300     # seconds between heartbeats (minimum 30)
tags = ["minecraft"]
metadata_motd = true      # send server MOTD to the API
metadata_player_count = true
log_updates = true
tunnel = false            # set true to use tunnel mode
```

---

### Requirements

- **Server-side only** — players do not need this mod
- Fabric or NeoForge
- Minecraft 1.21.1, 1.21.4, 1.21.5, or 1.21.11
- A KmDDNS account (free, created via `/kmddns setup new`)

---

### A quick note

I build these tools for fun and for the community. Keeping everything running does have real maintenance costs, and even $1 goes a long way.

If you enjoy the tools and want to give back, you can support me here: [Buy me a coffee](https://buymeacoffee.com/kohanmathers). No pressure either way — thanks for being here.
