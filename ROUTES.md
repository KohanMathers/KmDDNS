# KmDDNS – API Routes

Base URL: `https://api.ddns.{yourdomain}/v1`

All error responses follow: `{ "error": "<code>", "message": "<human readable>" }`

---

## Auth

| Scheme       | Header                          | Used on       |
| ------------ | ------------------------------- | ------------- |
| Bearer token | `Authorization: Bearer <token>` | Client routes |
| Admin secret | `X-Admin-Secret: <secret>`      | Admin routes  |

---

## Routes

### `GET /v1/health`

**Auth:** None

Returns worker status and uptime.

**Response `200`**
```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptime": 42
}
```

---

### `POST /v1/register`

**Auth:** None

Claim a subdomain and receive a one-time bearer token.

**Request body**
```json
{
  "subdomain": "myserver",
  "owner_email": "me@example.com",
  "port": 25565,
  "srv": "_minecraft._tcp",
  "ttl": 60,
  "tags": ["minecraft", "prod"],
  "redirect_http": false
}
```

Only `subdomain` is required. `port` and `srv` must be provided together (one without the other is rejected). `srv` must match `_service._proto` format (e.g. `_minecraft._tcp`, `_http._tcp`).

**Response `201`**
```json
{
  "token": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "subdomain": "myserver",
  "fqdn": "myserver.ddns.yourdomain.tld",
  "srv_record": "_minecraft._tcp.myserver.ddns.yourdomain.tld"
}
```

`srv_record` is `null` when no port is registered. Save the token — it is returned **once only** and stored hashed.

**Error responses**

| Status | Code                | Reason                                        |
| ------ | ------------------- | --------------------------------------------- |
| 400    | `invalid_body`      | Request body is not valid JSON                |
| 400    | `invalid_subdomain` | Fails regex or is a reserved word             |
| 400    | `missing_srv`       | `port` provided without `srv`                 |
| 400    | `invalid_srv`       | `srv` does not match `_service._proto` format |
| 409    | `subdomain_taken`   | Subdomain already registered                  |
| 429    | `rate_limited`      | More than 3 registrations/hour from this IP   |

---

### `GET /v1/update`

**Auth:** `token` query parameter (plain token, not hashed)

Simple one-liner update designed for cron jobs and wget. IP is auto-detected from the connecting address unless overridden.

**Query parameters**

| Parameter | Required | Description                                         |
| --------- | -------- | --------------------------------------------------- |
| `token`   | Yes      | Plain bearer token                                  |
| `ip`      | No       | IPv4 address; defaults to `CF-Connecting-IP`        |
| `port`    | No       | Port override (1–65535); keeps existing if omitted  |
| `dry`     | No       | `true` to preview changes without applying them     |

**Response `200`** — plain text
```
OK
```
or
```
NOCHG
```

**Error responses**

| Status | Code               | Reason                                     |
| ------ | ------------------ | ------------------------------------------ |
| 400    | `invalid_ip`       | IP is not a valid public IPv4 address      |
| 400    | `invalid_port`     | Port outside 1–65535                       |
| 401    | `missing_token`    | `token` query parameter not provided       |
| 401    | `invalid_token`    | Token not recognised                       |
| 403    | `account_disabled` | Account is disabled                        |
| 403    | `ip_not_allowed`   | Source IP not in `allowed_update_ips` ACL  |
| 429    | `rate_limited`     | More than 1 update per 30 seconds          |

---

### `POST /v1/update`

**Auth:** `Authorization: Bearer <token>`

Full JSON update. All fields are optional; omitted fields are unchanged. `metadata` keys are merged into the existing map.

**Request body**
```json
{
  "ip": "203.0.113.5",
  "ipv6": "2001:db8::1",
  "port": 25565,
  "metadata": {
    "motd": "Welcome!"
  }
}
```

`ip` defaults to `CF-Connecting-IP` if omitted. Set `ipv6` to `null` to remove the stored IPv6 address. Set `port` to `null` to remove the stored port.

**Response `200`** — full updated client record (token hash and webhook secret omitted)
```json
{
  "subdomain": "myserver",
  "ip": "203.0.113.5",
  "ipv6": "2001:db8::1",
  "port": 25565,
  "last_seen": "2025-03-11T12:00:00Z"
}
```

**Error responses**

| Status | Code               | Reason                                        |
| ------ | ------------------ | --------------------------------------------- |
| 400    | `invalid_body`     | Request body is not valid JSON                |
| 400    | `invalid_ip`       | IP is not a valid public address              |
| 400    | `invalid_port`     | Port outside 1–65535                          |
| 401    | `missing_token`    | No Authorization header                       |
| 401    | `invalid_token`    | Token not recognised                          |
| 403    | `account_disabled` | Account is disabled                           |
| 403    | `ip_not_allowed`   | Source IP not in `allowed_update_ips` ACL     |
| 429    | `rate_limited`     | More than 1 update per 30 seconds             |

---

### `GET /v1/client`

**Auth:** `Authorization: Bearer <token>`

Returns the full client config. Token hash and webhook secret are never included.

**Response `200`**
```json
{
  "subdomain": "myserver",
  "owner_email": null,
  "created_at": "2025-03-11T12:00:00Z",
  "last_seen": "2025-03-11T12:05:00Z",
  "ip": "203.0.113.5",
  "ipv6": null,
  "port": 25565,
  "srv_prefix": "_minecraft._tcp",
  "ttl": 60,
  "update_interval": 300,
  "tags": ["minecraft"],
  "metadata": {},
  "webhook_url": null,
  "allowed_update_ips": null,
  "custom_domains": [],
  "enabled": true,
  "redirect_http": false,
  "notes": null
}
```

**Error responses**

| Status | Code               | Reason                          |
| ------ | ------------------ | ------------------------------- |
| 401    | `missing_token`    | No Authorization header         |
| 401    | `invalid_token`    | Token not recognised            |
| 403    | `account_disabled` | Account is disabled             |

---

### `PATCH /v1/client`

**Auth:** `Authorization: Bearer <token>`

Partial update — only supplied fields are changed. All fields are optional. Setting `enabled: false` withdraws DNS records; setting it back to `true` restores them.

**Patchable fields and constraints**

| Field                | Type              | Constraint                                |
| -------------------- | ----------------- | ----------------------------------------- |
| `ttl`                | number            | 30–3600                                   |
| `port`               | number \| null    | 1–65535 or null                           |
| `update_interval`    | number            | 30–86400                                  |
| `tags`               | string[]          | Max 10 items, 32 chars each               |
| `metadata`           | object            | Max 20 keys, values up to 256 chars       |
| `webhook_url`        | string \| null    | Must start with `https://` or null        |
| `allowed_update_ips` | string[] \| null  | Valid CIDR notation or null               |
| `enabled`            | boolean           | false withdraws DNS; true restores        |
| `redirect_http`      | boolean           |                                           |
| `notes`              | string \| null    | Max 500 chars or null                     |

**Request body example**
```json
{ "ttl": 120, "tags": ["minecraft", "prod"] }
```

**Response `200`** — full updated record (same shape as `GET /v1/client`)

**Error responses**

| Status | Code               | Reason                                  |
| ------ | ------------------ | --------------------------------------- |
| 400    | `invalid_body`     | Request body is not valid JSON          |
| 400    | `invalid_field`    | A field value failed validation         |
| 401    | `missing_token`    | No Authorization header                 |
| 401    | `invalid_token`    | Token not recognised                    |
| 403    | `account_disabled` | Account is disabled                     |

---

### `POST /v1/client/rotate-token`

**Auth:** `Authorization: Bearer <token>`

Issues a new token and immediately invalidates the old one. Save the returned token — it is shown once only.

**Response `200`**
```json
{ "token": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" }
```

**Error responses**

| Status | Code               | Reason                          |
| ------ | ------------------ | ------------------------------- |
| 401    | `missing_token`    | No Authorization header         |
| 401    | `invalid_token`    | Token not recognised            |
| 403    | `account_disabled` | Account is disabled             |

---

### `DELETE /v1/client`

**Auth:** `Authorization: Bearer <token>`

Permanently deletes the account, all KV index keys, and all DNS records. The subdomain becomes available for re-registration immediately.

**Response `204`** — no body

**Error responses**

| Status | Code               | Reason                          |
| ------ | ------------------ | ------------------------------- |
| 401    | `missing_token`    | No Authorization header         |
| 401    | `invalid_token`    | Token not recognised            |
| 403    | `account_disabled` | Account is disabled             |

---

### `GET /v1/lookup/{subdomain}`

**Auth:** None

Returns the public record for a subdomain. Does not expose `webhook_secret`, `allowed_update_ips`, or `notes`.

**Response `200`**
```json
{
  "subdomain": "myserver",
  "ip": "203.0.113.5",
  "ipv6": null,
  "port": 25565,
  "ttl": 60,
  "tags": ["minecraft"],
  "metadata": { "motd": "Welcome!" },
  "last_seen": "2025-03-11T12:00:00Z"
}
```

**Error responses**

| Status | Code        | Reason                                        |
| ------ | ----------- | --------------------------------------------- |
| 404    | `not_found` | Subdomain does not exist or account is disabled |
| 429    | `rate_limited` | Global rate limit exceeded (300 req/min)    |

---

### `POST /v1/custom-domain`

**Auth:** `Authorization: Bearer <token>`

Begin TXT-based ownership verification for a custom hostname. The returned TXT record must be added at the user's DNS registrar before calling `/verify`.

**Request body**
```json
{ "hostname": "mc.example.com" }
```

**Response `202`**
```json
{
  "verification_record": {
    "type": "TXT",
    "name": "_kmddns-verify.mc.example.com",
    "value": "kmddns-verify=<challenge-token>"
  },
  "instructions": "Add the TXT record above, then call GET /v1/custom-domain/verify?hostname=mc.example.com"
}
```

**Error responses**

| Status | Code                      | Reason                                            |
| ------ | ------------------------- | ------------------------------------------------- |
| 400    | `invalid_body`            | Request body is not valid JSON                    |
| 400    | `invalid_hostname`        | hostname is missing or not a valid domain name    |
| 401    | `missing_token`           | No Authorization header                           |
| 401    | `invalid_token`           | Token not recognised                              |
| 409    | `domain_already_verified` | Hostname is already claimed by another account    |

---

### `GET /v1/custom-domain/verify`

**Auth:** `Authorization: Bearer <token>`

Resolves `_kmddns-verify.{hostname}` via Cloudflare DNS-over-HTTPS and activates a CNAME on success. The challenge expires 24 hours after `POST /v1/custom-domain`.

**Query parameters**

| Parameter  | Required | Description                  |
| ---------- | -------- | ---------------------------- |
| `hostname` | Yes      | The hostname being verified  |

**Response `200`**
```json
{
  "hostname": "mc.example.com",
  "cname_target": "myserver.ddns.yourdomain.tld"
}
```

**Error responses**

| Status | Code                      | Reason                                                       |
| ------ | ------------------------- | ------------------------------------------------------------ |
| 400    | `invalid_hostname`        | hostname query parameter is missing                          |
| 401    | `missing_token`           | No Authorization header                                      |
| 401    | `invalid_token`           | Token not recognised                                         |
| 409    | `domain_already_verified` | Hostname is already claimed by another account               |
| 422    | `verification_failed`     | No pending verification, challenge expired, or TXT mismatch  |

---

### `DELETE /v1/custom-domain`

**Auth:** `Authorization: Bearer <token>`

Removes a verified custom domain: deletes the CNAME from Cloudflare, removes the reverse-lookup index, and removes the hostname from the account's `custom_domains` list.

**Request body**
```json
{ "hostname": "mc.example.com" }
```

**Response `204`** — no body

**Error responses**

| Status | Code           | Reason                                    |
| ------ | -------------- | ----------------------------------------- |
| 400    | `invalid_body` | Request body is not valid JSON or missing hostname |
| 401    | `missing_token`| No Authorization header                   |
| 401    | `invalid_token`| Token not recognised                      |
| 404    | `not_found`    | Hostname not found on this account        |

---

### `GET /admin/clients`

**Auth:** `X-Admin-Secret: <secret>`

Returns a paginated list of all registered clients. `webhook_secret` is never included.

**Query parameters**

| Parameter | Required | Description                                      |
| --------- | -------- | ------------------------------------------------ |
| `limit`   | No       | Max results per page (1–100, default 50)         |
| `cursor`  | No       | Pagination cursor from a previous response       |

**Response `200`**
```json
{
  "clients": [ { "subdomain": "myserver", "ip": "203.0.113.5", "..." : "..." } ],
  "next_cursor": "opaque-cursor-string-or-null"
}
```

**Error responses**

| Status | Code        | Reason                          |
| ------ | ----------- | ------------------------------- |
| 403    | `forbidden` | Missing or wrong admin secret   |

---

### `DELETE /admin/client/{token}`

**Auth:** `X-Admin-Secret: <secret>`

Force-deletes any client by token hash. Removes the KV record, all index keys, and all DNS records. The subdomain becomes available for re-registration immediately.

**Response `204`** — no body

**Error responses**

| Status | Code        | Reason                          |
| ------ | ----------- | ------------------------------- |
| 403    | `forbidden` | Missing or wrong admin secret   |
| 404    | `not_found` | Token hash not found            |

---

### `POST /admin/ban`

**Auth:** `X-Admin-Secret: <secret>`

Bans a subdomain label, an IP address, or both. Banned subdomains cannot be registered; banned IPs cannot register or submit updates.

**Request body**
```json
{ "subdomain": "badactor", "ip": "203.0.113.99" }
```

At least one of `subdomain` or `ip` must be provided.

**Response `200`**
```json
{ "banned": { "subdomain": "badactor", "ip": "203.0.113.99" } }
```

**Error responses**

| Status | Code           | Reason                                      |
| ------ | -------------- | ------------------------------------------- |
| 400    | `invalid_body` | Body is not valid JSON or both fields absent |
| 403    | `forbidden`    | Missing or wrong admin secret               |

---

### `GET /admin/stats`

**Auth:** `X-Admin-Secret: <secret>`

Returns aggregate platform statistics.

**Response `200`**
```json
{
  "total_clients": 142,
  "updates_last_hour": 37,
  "banned_count": 5
}
```

**Error responses**

| Status | Code        | Reason                          |
| ------ | ----------- | ------------------------------- |
| 403    | `forbidden` | Missing or wrong admin secret   |