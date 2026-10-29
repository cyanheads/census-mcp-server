/**
 * @fileoverview Tests for the server config parse. The key is optional here — the Census API
 * service turns an absent key into a typed `missing_api_key` on the paths that need it — while
 * the vintage and cache settings keep failing the parse when malformed.
 * @module tests/config/server-config.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A fresh copy of the module, so each test parses the environment it stubs. */
const loadConfig = async () => {
  vi.resetModules();
  return await import('@/config/server-config.js');
};

beforeEach(() => {
  vi.stubEnv('CENSUS_DEFAULT_YEAR', undefined);
  vi.stubEnv('CENSUS_VARIABLE_CACHE_TTL_HOURS', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getServerConfig', () => {
  it('reads a configured key', async () => {
    vi.stubEnv('CENSUS_API_KEY', 'abc123');
    const { getServerConfig } = await loadConfig();

    expect(getServerConfig()).toEqual({
      censusApiKey: 'abc123',
      defaultYear: 2024,
      variableCacheTtlHours: 24,
    });
  });

  /**
   * An MCPB or plugin install with the key left empty passes `""`, or the unsubstituted
   * `${user_config.CENSUS_API_KEY}` placeholder, rather than leaving the variable unset.
   */
  it.each([
    ['unset', undefined],
    ['blank', ''],
    ['whitespace', '   '],
    // Escaped, so the placeholder is the literal text a host leaves behind, not an interpolation.
    ['an unsubstituted placeholder', `\${user_config.CENSUS_API_KEY}`],
  ])('parses with no key when CENSUS_API_KEY is %s', async (_label, value) => {
    vi.stubEnv('CENSUS_API_KEY', value);
    const { getServerConfig } = await loadConfig();

    const config = getServerConfig();
    expect(config.censusApiKey).toBeUndefined();
    expect(config.defaultYear).toBe(2024);
  });

  it.each([
    ['set', 'abc123'],
    ['unset', undefined],
  ])('still fails on an invalid CENSUS_DEFAULT_YEAR with the key %s', async (_label, key) => {
    vi.stubEnv('CENSUS_API_KEY', key);
    vi.stubEnv('CENSUS_DEFAULT_YEAR', 'not-a-year');
    const { getServerConfig } = await loadConfig();

    expect(() => getServerConfig()).toThrow(
      expect.objectContaining({
        code: JsonRpcErrorCode.ConfigurationError,
        message: expect.stringContaining('CENSUS_DEFAULT_YEAR'),
      }),
    );
  });
});
