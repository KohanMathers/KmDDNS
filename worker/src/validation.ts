import { isValidCidr } from './ip.js';

type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string };
const SRV_PREFIX_REGEX = /^_[a-z][a-z0-9-]*\._[a-z][a-z0-9-]*$/;

export function validateTags(value: unknown): ValidationResult<string[]> {
  if (
    !Array.isArray(value) ||
    value.length > 10 ||
    !value.every(v => typeof v === 'string' && v.length <= 32)
  ) {
    return { ok: false, message: 'tags must be an array of up to 10 strings (max 32 chars each)' };
  }
  return { ok: true, value: value as string[] };
}

export function validateMetadata(value: unknown): ValidationResult<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, message: 'metadata must be an object' };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 20 || !entries.every(([, v]) => typeof v === 'string' && v.length <= 256)) {
    return {
      ok: false,
      message: 'metadata must have at most 20 keys with values up to 256 chars',
    };
  }
  return { ok: true, value: Object.fromEntries(entries as [string, string][]) };
}

export function validateAllowedUpdateIps(value: unknown): ValidationResult<string[] | null> {
  if (value === null) return { ok: true, value: null };
  if (Array.isArray(value) && value.every(v => typeof v === 'string' && isValidCidr(v))) {
    return { ok: true, value: value as string[] };
  }
  return {
    ok: false,
    message: 'allowed_update_ips must be an array of valid CIDR strings or null',
  };
}

export function validateSrvPrefix(value: unknown): ValidationResult<string | null> {
  if (value === null) return { ok: true, value: null };
  if (typeof value === 'string' && SRV_PREFIX_REGEX.test(value)) {
    return { ok: true, value };
  }
  return { ok: false, message: 'srv_prefix must be in _service._proto format or null' };
}
