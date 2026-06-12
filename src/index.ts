#!/usr/bin/env node
/**
 * @fileoverview census-mcp-server MCP server entry point.
 * Registers all Census Bureau tools and initializes domain services.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { initCensusApiService } from './services/census-api/census-api-service.js';
import { initGeographyService } from './services/geography/geography-service.js';
import { initVariableCacheService } from './services/variable-cache/variable-cache-service.js';

await createApp({
  name: 'census-mcp-server',
  title: 'census-mcp-server',
  tools: allToolDefinitions,
  instructions:
    'US Census Bureau data server. Recommended workflow:\n1. census_list_datasets — discover available datasets and their years\n2. census_search_variables — find variable codes from human-readable concepts\n3. census_resolve_geography — convert place names to FIPS codes\n4. census_query_data — retrieve estimates for one geography\n5. census_compare_geographies — rank and compare across many geographies\nCENSUS_API_KEY is required for all data queries (census_query_data, census_compare_geographies). Variable search and geography resolution work without a key.',
  landing: { requireAuth: false },
  setup() {
    initCensusApiService();
    initVariableCacheService();
    initGeographyService();
  },
});
