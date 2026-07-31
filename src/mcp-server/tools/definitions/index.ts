/**
 * @fileoverview Barrel export for all census-mcp-server tool definitions.
 * @module mcp-server/tools/definitions/index
 */

import { censusCompareGeographies } from './census-compare-geographies.tool.js';
import { censusGetVariable } from './census-get-variable.tool.js';
import { censusListDatasets } from './census-list-datasets.tool.js';
import { censusListGeographies } from './census-list-geographies.tool.js';
import { censusListPredicateValues } from './census-list-predicate-values.tool.js';
import { censusQueryData } from './census-query-data.tool.js';
import { censusResolveGeography } from './census-resolve-geography.tool.js';
import { censusSearchVariables } from './census-search-variables.tool.js';

export {
  censusCompareGeographies,
  censusGetVariable,
  censusListDatasets,
  censusListGeographies,
  censusListPredicateValues,
  censusQueryData,
  censusResolveGeography,
  censusSearchVariables,
};

export const allToolDefinitions = [
  censusListDatasets,
  censusListGeographies,
  censusSearchVariables,
  censusGetVariable,
  censusListPredicateValues,
  censusResolveGeography,
  censusQueryData,
  censusCompareGeographies,
];
