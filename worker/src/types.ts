import type { Context } from 'hono';

/** Cloudflare Worker environment bindings and secrets. */
export interface Env {
  kmddns: D1Database;
  BASE_DOMAIN: string;
  MAX_SUBDOMAIN_LENGTH: string;
  DEFAULT_TTL: string;
  STALE_DAYS: string;
  CF_API_TOKEN: string;
  CF_ZONE_ID: string;
  ADMIN_SECRET: string;
  ALLOW_PRIVATE_IPS?: string;
  WEBHOOK_HOST_ALLOWLIST?: string;
  RESEND_API_KEY?: string;
}

/** Full state record stored under `client:{sha256(token)}`. */
export interface ClientRecord {
  token: string;
  subdomain: string;
  owner_email: string | null;
  created_at: string;
  last_seen: string | null;
  ip: string | null;
  ipv6: string | null;
  port: number | null;
  srv_prefix: string | null;
  ttl: number;
  update_interval: number;
  tags: string[];
  metadata: Record<string, string>;
  webhook_url: string | null;
  webhook_secret: string | null;
  allowed_update_ips: string[] | null;
  custom_domains: string[];
  enabled: boolean;
  redirect_http: boolean;
  notes: string | null;
}

/** Hono context variables set by auth middleware. */
export interface Variables {
  client: ClientRecord;
}

/** Hono context type shared by all route handlers. */
export type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

/** Immutable audit entry stored under `audit:{token}:{timestamp}`. */
export interface AuditEntry {
  action: string;
  source_ip: string;
  timestamp: string;
  details: Record<string, string | number | boolean | null>;
}
