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
  defaultYear: z.coerce.number().default(2024).describe('Default vintage year for queries'),
  variableCacheTtlHours: z.coerce
    .number()
    .default(24)
    .describe('Hours to cache variables.json per dataset+year'),
});

export type DiscoveryConfig = z.infer<typeof DiscoveryConfigSchema>;

let _discoveryConfig: DiscoveryConfig | undefined;

export function getDiscoveryConfig(): DiscoveryConfig {
  _discoveryConfig ??= parseEnvConfig(DiscoveryConfigSchema, {
    defaultYear: 'CENSUS_DEFAULT_YEAR',
    variableCacheTtlHours: 'CENSUS_VARIABLE_CACHE_TTL_HOURS',
  });
  return _discoveryConfig;
}

/**
 * Full server config — adds CENSUS_API_KEY. Read only by the Census API service's two keyed
 * methods: `queryData` (census_query_data, census_compare_geographies) and `fetchPredicateValues`
 * (census_list_predicate_values, both its live route and its dictionary publication check). The
 * key is optional here so an unset one reaches those paths as a typed `missing_api_key` rather
 * than failing the parse; a malformed year or TTL still fails it.
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
    censusApiKey: 'CENSUS_API_KEY',
    defaultYear: 'CENSUS_DEFAULT_YEAR',
    variableCacheTtlHours: 'CENSUS_VARIABLE_CACHE_TTL_HOURS',
  });
  return _config;
}
