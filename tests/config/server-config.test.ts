/**
 * @fileoverview Tests for the server config parse. The key is optional here — the Census API
 * service turns an absent key into a typed `missing_api_key` on the paths that need it — while
 * the cache TTL and the limit-clamp switch keep failing the parse when malformed.
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
  vi.stubEnv('CENSUS_CLAMP_LIMITS', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getServerConfig', () => {
  it('reads a configured key', async () => {
    vi.stubEnv('CENSUS_API_KEY', 'abc123');
    const { getServerConfig } = await loadConfig();

    expect(getServerConfig()).toStrictEqual({
      censusApiKey: 'abc123',
      variableCacheTtlHours: 24,
      clampLimits: true,
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
    expect(config.variableCacheTtlHours).toBe(24);
  });

  it.each([
    ['set', 'abc123'],
    ['unset', undefined],
  ])(
    'still fails on an invalid CENSUS_VARIABLE_CACHE_TTL_HOURS with the key %s',
    async (_label, key) => {
      vi.stubEnv('CENSUS_API_KEY', key);
      vi.stubEnv('CENSUS_VARIABLE_CACHE_TTL_HOURS', 'abc');
      const { getServerConfig } = await loadConfig();

      expect(() => getServerConfig()).toThrow(
        expect.objectContaining({
          code: JsonRpcErrorCode.ConfigurationError,
          message: expect.stringContaining('CENSUS_VARIABLE_CACHE_TTL_HOURS'),
        }),
      );
    },
  );
});

/**
 * #96: every registered dataset has a newest vintage, so a configured default year could never be
 * reached, and parsing it only let a malformed value fail six tools. The variable is not read.
 */
describe('CENSUS_DEFAULT_YEAR', () => {
  it.each([['not-a-year'], ['2019']])('is not parsed when set to %s', async (value) => {
    vi.stubEnv('CENSUS_API_KEY', 'abc123');
    vi.stubEnv('CENSUS_DEFAULT_YEAR', value);
    const { getDiscoveryConfig, getServerConfig } = await loadConfig();

    expect(getServerConfig()).toStrictEqual({
      censusApiKey: 'abc123',
      variableCacheTtlHours: 24,
      clampLimits: true,
    });
    expect(getDiscoveryConfig()).toStrictEqual({ variableCacheTtlHours: 24, clampLimits: true });
  });
});

describe('CENSUS_CLAMP_LIMITS', () => {
  it.each([
    ['unset', true, undefined],
    ['blank', true, ''],
    ['true', true, 'true'],
    ['ON', true, 'ON'],
    ['false', false, 'false'],
    ['0', false, '0'],
    ['no', false, 'no'],
  ])('reads %s as clampLimits %s in both configs', async (_label, expected, value) => {
    vi.stubEnv('CENSUS_CLAMP_LIMITS', value);
    const { getDiscoveryConfig, getServerConfig } = await loadConfig();

    expect(getServerConfig().clampLimits).toBe(expected);
    expect(getDiscoveryConfig().clampLimits).toBe(expected);
  });

  it('fails on a value that is not a boolean, naming the variable', async () => {
    vi.stubEnv('CENSUS_CLAMP_LIMITS', 'maybe');
    const { getServerConfig } = await loadConfig();

    expect(() => getServerConfig()).toThrow(
      expect.objectContaining({
        code: JsonRpcErrorCode.ConfigurationError,
        message: expect.stringContaining('CENSUS_CLAMP_LIMITS (clampLimits)'),
      }),
    );
  });
});

/**
 * Input schemas read the config through `activeDiscoveryConfig()` when they are emitted, and
 * `tool()` emits each one when its definition module is imported — before `createApp()` has
 * loaded `.env` under Node, and before `setup()` parses. So it reads defaults until a parse has
 * run, and never parses the environment itself.
 */
describe('activeDiscoveryConfig', () => {
  it('reads the schema defaults before any parse, whatever the environment holds', async () => {
    vi.stubEnv('CENSUS_CLAMP_LIMITS', 'false');
    vi.stubEnv('CENSUS_VARIABLE_CACHE_TTL_HOURS', 'abc');
    const { activeDiscoveryConfig } = await loadConfig();

    expect(activeDiscoveryConfig()).toStrictEqual({ variableCacheTtlHours: 24, clampLimits: true });
  });

  it('reads what getServerConfig parsed', async () => {
    vi.stubEnv('CENSUS_CLAMP_LIMITS', 'false');
    vi.stubEnv('CENSUS_VARIABLE_CACHE_TTL_HOURS', '6');
    const { activeDiscoveryConfig, getServerConfig } = await loadConfig();
    getServerConfig();

    expect(activeDiscoveryConfig()).toMatchObject({ variableCacheTtlHours: 6, clampLimits: false });
  });
});
