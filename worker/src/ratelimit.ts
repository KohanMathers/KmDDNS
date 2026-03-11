import { isRateLimitExceeded } from './kv.js';
import { RATE_LIMITS } from './config.js';

export interface RateLimitResult {
  allowed: boolean;
  retryAfter: number;
}

export async function checkGlobalLimit(kv: KVNamespace, ip: string): Promise<RateLimitResult> {
  const exceeded = await isRateLimitExceeded(kv, `global:${ip}`, RATE_LIMITS.globalPerMinute, 60);
  return { allowed: !exceeded, retryAfter: 60 };
}

export async function checkRegistrationLimit(kv: KVNamespace, ip: string): Promise<RateLimitResult> {
  const exceeded = await isRateLimitExceeded(kv, `reg:${ip}`, RATE_LIMITS.registrationPerHour, 3600);
  return { allowed: !exceeded, retryAfter: 3600 };
}

export async function checkUpdateLimit(kv: KVNamespace, token: string): Promise<RateLimitResult> {
  const exceeded = await isRateLimitExceeded(
    kv,
    `update:${token}`,
    RATE_LIMITS.updatePerWindow,
    RATE_LIMITS.updateWindowSecs,
  );
  return { allowed: !exceeded, retryAfter: RATE_LIMITS.updateWindowSecs };
}
