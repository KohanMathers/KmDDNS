CREATE TABLE clients (
  token              TEXT    PRIMARY KEY,
  subdomain          TEXT    NOT NULL UNIQUE,
  owner_email        TEXT,
  created_at         TEXT    NOT NULL,
  last_seen          TEXT,
  ip                 TEXT,
  ipv6               TEXT,
  port               INTEGER,
  srv_prefix         TEXT,
  ttl                INTEGER NOT NULL DEFAULT 60,
  update_interval    INTEGER NOT NULL DEFAULT 300,
  tags               TEXT    NOT NULL DEFAULT '[]',
  metadata           TEXT    NOT NULL DEFAULT '{}',
  webhook_url        TEXT,
  webhook_secret     TEXT,
  allowed_update_ips TEXT,
  custom_domains     TEXT    NOT NULL DEFAULT '[]',
  enabled            INTEGER NOT NULL DEFAULT 1,
  redirect_http      INTEGER NOT NULL DEFAULT 0,
  notes              TEXT
);

CREATE TABLE custom_domains (
  hostname TEXT PRIMARY KEY,
  token    TEXT NOT NULL REFERENCES clients(token) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE pending_custom_domains (
  hostname   TEXT    PRIMARY KEY,
  token      TEXT    NOT NULL,
  challenge  TEXT    NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE audit (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  token     TEXT    NOT NULL,
  action    TEXT    NOT NULL,
  source_ip TEXT    NOT NULL,
  timestamp TEXT    NOT NULL,
  details   TEXT    NOT NULL DEFAULT '{}'
);

CREATE TABLE rate_limits (
  key        TEXT    PRIMARY KEY,
  count      INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER NOT NULL
);

CREATE TABLE bans (
  type  TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (type, value)
);

CREATE TABLE stats (
  window     INTEGER PRIMARY KEY,
  count      INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_audit_token ON audit(token);
