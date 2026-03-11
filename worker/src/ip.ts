type ParsedCidr =
  | { version: 4; base: number; prefix: number }
  | { version: 6; base: bigint; prefix: number };

const IPV4_RFC1918_RANGES: Array<[number, number]> = [
  [0x0a000000, 0x0affffff], // 10.0.0.0/8
  [0xac100000, 0xac1fffff], // 172.16.0.0/12
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
];

const IPV4_RESERVED_RANGES: Array<[number, number]> = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16
  [0xe0000000, 0xffffffff], // 224.0.0.0/4
];

function parseIPv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

function ipv4IsAllowed(ip: string, allowPrivate: boolean): boolean {
  const value = parseIPv4(ip);
  if (value === null) return false;
  for (const [start, end] of IPV4_RESERVED_RANGES) {
    if (value >= start && value <= end) return false;
  }
  if (!allowPrivate) {
    for (const [start, end] of IPV4_RFC1918_RANGES) {
      if (value >= start && value <= end) return false;
    }
  }
  return true;
}

function ipv4IsPublic(ip: string): boolean {
  return ipv4IsAllowed(ip, false);
}

function parseIPv6(ip: string): bigint | null {
  if (ip.includes('%')) return null;
  const parts = ip.split('::');
  if (parts.length > 2) return null;

  const leftRaw = parts[0] ? parts[0].split(':').filter(Boolean) : [];
  const rightRaw = parts.length === 2 && parts[1] ? parts[1].split(':').filter(Boolean) : [];

  const left: number[] = [];
  const right: number[] = [];

  const expandIpv4 = (segment: string): number[] | null => {
    const v4 = parseIPv4(segment);
    if (v4 === null) return null;
    return [(v4 >>> 16) & 0xffff, v4 & 0xffff];
  };

  for (let i = 0; i < leftRaw.length; i++) {
    const segment = leftRaw[i];
    if (segment.includes('.')) {
      if (i !== leftRaw.length - 1) return null;
      const expanded = expandIpv4(segment);
      if (expanded === null) return null;
      left.push(...expanded);
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(segment)) return null;
    left.push(parseInt(segment, 16));
  }

  for (let i = 0; i < rightRaw.length; i++) {
    const segment = rightRaw[i];
    if (segment.includes('.')) {
      if (i !== rightRaw.length - 1) return null;
      const expanded = expandIpv4(segment);
      if (expanded === null) return null;
      right.push(...expanded);
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(segment)) return null;
    right.push(parseInt(segment, 16));
  }

  const total = left.length + right.length;
  if (parts.length === 1) {
    if (total !== 8) return null;
  } else {
    if (total > 8) return null;
  }

  const zeros = parts.length === 2 ? new Array(8 - total).fill(0) : [];
  const hextets = [...left, ...zeros, ...right];
  if (hextets.length !== 8) return null;

  let value = 0n;
  for (const h of hextets) {
    value = (value << 16n) | BigInt(h);
  }
  return value;
}

function ipv6IsPublic(ip: string): boolean {
  const value = parseIPv6(ip);
  if (value === null) return false;

  if (value === 0n) return false; // ::
  if (value === 1n) return false; // ::1

  const high8 = Number(value >> 120n);
  if (high8 === 0xff) return false; // ff00::/8 multicast

  const high7 = Number(value >> 121n);
  if (high7 === 0x7e || high7 === 0x7f) return false; // fc00::/7 unique local

  const high10 = Number(value >> 118n);
  if (high10 === 0x3fa) return false; // fe80::/10 link-local

  const docPrefix = 0x20010db8n << 96n;
  if ((value >> 96n) === (docPrefix >> 96n)) return false; // 2001:db8::/32

  const ipv4MappedPrefix = 0xffffn;
  if ((value >> 32n) === ipv4MappedPrefix) return false; // ::ffff:0:0/96

  return true;
}

function parseCidr(cidr: string): ParsedCidr | null {
  const slashIdx = cidr.indexOf('/');
  const baseStr = slashIdx === -1 ? cidr : cidr.slice(0, slashIdx);
  const prefixStr = slashIdx === -1 ? null : cidr.slice(slashIdx + 1);

  const v4 = parseIPv4(baseStr);
  if (v4 !== null) {
    const prefix = prefixStr === null ? 32 : Number(prefixStr);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
    return { version: 4, base: v4, prefix };
  }

  const v6 = parseIPv6(baseStr);
  if (v6 !== null) {
    const prefix = prefixStr === null ? 128 : Number(prefixStr);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null;
    return { version: 6, base: v6, prefix };
  }

  return null;
}

function cidrContains(ip: string, cidr: string): boolean {
  const parsed = parseCidr(cidr);
  if (!parsed) return false;

  if (parsed.version === 4) {
    const ipNum = parseIPv4(ip);
    if (ipNum === null) return false;
    if (parsed.prefix === 0) return true;
    const mask = (0xffffffff << (32 - parsed.prefix)) >>> 0;
    return (ipNum & mask) === (parsed.base & mask);
  }

  const ipNum = parseIPv6(ip);
  if (ipNum === null) return false;
  if (parsed.prefix === 0) return true;
  const shift = BigInt(128 - parsed.prefix);
  return (ipNum >> shift) === (parsed.base >> shift);
}

function isValidCidr(value: string): boolean {
  return parseCidr(value) !== null;
}

export {
  parseIPv4,
  parseIPv6,
  ipv4IsPublic,
  ipv4IsAllowed,
  ipv6IsPublic,
  parseCidr,
  cidrContains,
  isValidCidr,
};
