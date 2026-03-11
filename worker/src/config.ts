import type { Env } from './types.js';

/** Build runtime config from env vars. All numeric values are parsed once here. */
export function getConfig(env: Env) {
  const rawAllowlist = (env.WEBHOOK_HOST_ALLOWLIST ?? '').trim();
  const webhookAllowlist = rawAllowlist
    ? rawAllowlist.split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean)
    : [];
  const webhookAllowAll = webhookAllowlist.includes('*');
  const webhookAllowlistExact = new Set(
    webhookAllowlist.filter(entry => entry !== '*' && !entry.startsWith('.')),
  );
  const webhookAllowlistSuffixes = webhookAllowlist.filter(entry => entry.startsWith('.'));
  return {
    baseDomain: env.BASE_DOMAIN,
    maxSubdomainLength: parseInt(env.MAX_SUBDOMAIN_LENGTH, 10),
    defaultTtl: parseInt(env.DEFAULT_TTL, 10),
    staleDays: parseInt(env.STALE_DAYS, 10),
    allowPrivateIps: env.ALLOW_PRIVATE_IPS === 'true',
    webhookAllowlist,
    webhookAllowAll,
    webhookAllowlistExact,
    webhookAllowlistSuffixes,
  };
}

export const RESERVED_SUBDOMAINS = new Set([
  'www', 'mail', 'ftp', 'smtp', 'pop', 'imap',
  'api', 'admin', 'dashboard', 'dash', 'panel',
  'blog', 'shop', 'store', 'app', 'dev', 'staging',
  'test', 'beta', 'static', 'cdn', 'assets',
  'ns', 'ns1', 'ns2', 'mx', 'relay',
  'vpn', 'proxy', 'gateway', 'router',
  'cloudflare', 'cf', 'health', 'status',
  'help', 'support', 'docs', 'portal',
]);

export const SUBDOMAIN_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export const RATE_LIMITS = {
  globalPerMinute: 300,
  registrationPerHour: 3,
  updatePerWindow: 1,
  updateWindowSecs: 30,
} as const;
