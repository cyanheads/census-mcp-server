/**
 * @fileoverview Server-specific configuration for census-mcp-server.
 * Parses Census Bureau API env vars with Zod validation.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/**
 * Discovery config — no API key required. Used by tools that access public endpoints
 * (TIGERweb, variables.json) or in-process caches without calling the Census Data API.
 */
const DiscoveryConfigSchema = z.object({
  variableCacheTtlHours: z.coerce
    .number()
    .default(24)
    .describe('Hours to cache variables.json per dataset+year'),
  clampLimits: z
    .stringbool()
    .default(true)
    .describe(
      'Serves a limit above the cap of census_query_data, census_compare_geographies, census_search_variables, or census_list_predicate_values at the cap, with a notice saying so, instead of rejecting it. False advertises and enforces each cap as the schema maximum.',
    ),
});

/** The variable each discovery field is read from, shared by both configs. */
const DISCOVERY_ENV = {
  variableCacheTtlHours: 'CENSUS_VARIABLE_CACHE_TTL_HOURS',
  clampLimits: 'CENSUS_CLAMP_LIMITS',
} as const;

export type DiscoveryConfig = z.infer<typeof DiscoveryConfigSchema>;

/** Every discovery field at its default: the config before `setup()` parses the environment. */
const DISCOVERY_DEFAULTS: DiscoveryConfig = DiscoveryConfigSchema.parse({});

let _discoveryConfig: DiscoveryConfig | undefined;

export function getDiscoveryConfig(): DiscoveryConfig {
  _discoveryConfig ??= parseEnvConfig(DiscoveryConfigSchema, DISCOVERY_ENV);
  return _discoveryConfig;
}

/**
 * Full server config — adds CENSUS_API_KEY. Parsed by `setup()` before any transport binds, then
 * read only by the Census API service's two keyed methods: `queryData` (census_query_data,
 * census_compare_geographies) and `fetchPredicateValues` (census_list_predicate_values, both its
 * live route and its dictionary publication check). The key is optional here so an unset one
 * reaches those paths as a typed `missing_api_key` rather than failing the parse; a malformed TTL
 * or clamp switch still fails it, and so stops startup.
 */
const ServerConfigSchema = DiscoveryConfigSchema.extend({
  censusApiKey: z
    .string()
    .optional()
    .describe('Census Bureau API key from api.census.gov/data/key_signup.html'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    ...DISCOVERY_ENV,
    censusApiKey: 'CENSUS_API_KEY',
  });
  return _config;
}

/**
 * The discovery config an input schema reads when it validates or is emitted: what `setup()`
 * parsed, or the schema defaults before it runs. Never parses the environment itself, since
 * `tool()` emits every input schema when its definition module is imported — before
 * `createApp()` has loaded `.env` under Node — and a parse cached then would ignore that file.
 */
export function activeDiscoveryConfig(): DiscoveryConfig {
  return _config ?? _discoveryConfig ?? DISCOVERY_DEFAULTS;
}
