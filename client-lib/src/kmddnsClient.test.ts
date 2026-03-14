import { describe, it, expect } from 'vitest';
import { KmDDNSClient } from './kmddnsClient.js';

const VALID_BASE = { token: 'test-token', apiBase: 'https://api.example.com/v1' };

describe('KmDDNSClient constructor', () => {
  it('accepts a valid apiBase ending with /v1', () => {
    expect(() => new KmDDNSClient(VALID_BASE)).not.toThrow();
  });

  it('throws when apiBase is missing /v1 suffix', () => {
    expect(() => new KmDDNSClient({ ...VALID_BASE, apiBase: 'https://api.example.com' }))
      .toThrow(/apiBase must end with "\/v1"/);
  });

  it('throws when apiBase has a trailing slash after /v1', () => {
    expect(() => new KmDDNSClient({ ...VALID_BASE, apiBase: 'https://api.example.com/v1/' }))
      .toThrow(/apiBase must end with "\/v1"/);
  });

  it('accepts a valid port', () => {
    expect(() => new KmDDNSClient({ ...VALID_BASE, port: 25565 })).not.toThrow();
    expect(() => new KmDDNSClient({ ...VALID_BASE, port: 1 })).not.toThrow();
    expect(() => new KmDDNSClient({ ...VALID_BASE, port: 65535 })).not.toThrow();
  });

  it('throws when port is 0', () => {
    expect(() => new KmDDNSClient({ ...VALID_BASE, port: 0 }))
      .toThrow(/port must be an integer between 1 and 65535/);
  });

  it('throws when port is 65536', () => {
    expect(() => new KmDDNSClient({ ...VALID_BASE, port: 65536 }))
      .toThrow(/port must be an integer between 1 and 65535/);
  });

  it('throws when port is negative', () => {
    expect(() => new KmDDNSClient({ ...VALID_BASE, port: -1 }))
      .toThrow(/port must be an integer between 1 and 65535/);
  });

  it('throws when port is a float', () => {
    expect(() => new KmDDNSClient({ ...VALID_BASE, port: 25565.5 }))
      .toThrow(/port must be an integer between 1 and 65535/);
  });
});
