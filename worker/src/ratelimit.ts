import { isRateLimitExceeded } from './db.js';
import { RATE_LIMITS } from './config.js';

export interface RateLimitResult {
  allowed: boolean;
  retryAfter: number;
}

export async function checkGlobalLimit(db: D1Database, ip: string): Promise<RateLimitResult> {
  const exceeded = await isRateLimitExceeded(db, `global:${ip}`, RATE_LIMITS.globalPerMinute, 60);
  return { allowed: !exceeded, retryAfter: 60 };
}

export async function checkRegistrationLimit(db: D1Database, ip: string): Promise<RateLimitResult> {
  const exceeded = await isRateLimitExceeded(db, `reg:${ip}`, RATE_LIMITS.registrationPerHour, 3600);
  return { allowed: !exceeded, retryAfter: 3600 };
}

export async function checkUpdateLimit(db: D1Database, token: string): Promise<RateLimitResult> {
  const exceeded = await isRateLimitExceeded(
    db,
    `update:${token}`,
    RATE_LIMITS.updatePerWindow,
    RATE_LIMITS.updateWindowSecs,
  );
  return { allowed: !exceeded, retryAfter: RATE_LIMITS.updateWindowSecs };
}
