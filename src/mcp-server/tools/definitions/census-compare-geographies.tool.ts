/**
 * @fileoverview Tool to compare variables across multiple geographies at the same level.
 * @module mcp-server/tools/definitions/census-compare-geographies
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getDiscoveryConfig } from '@/config/server-config.js';
import { getCensusApiService } from '@/services/census-api/census-api-service.js';
import {
  DATASET_LATEST_YEARS,
  getVariableCacheService,
  KNOWN_DATASETS,
} from '@/services/variable-cache/variable-cache-service.js';

export const censusCompareGeographies = tool('census_compare_geographies', {
  title: 'Compare Census Geographies',
  description:
    'Compare one or more variables across multiple geographies at the same level — all counties in a state, all states nationally, or a named set of specific geographies. Results are sorted and ranked. Covers queries like "rank states by poverty rate", "compare median income across WA counties", or "which census tracts in King County have the highest renter rate." Omit within to compare all geographies nationally at the level. Suppressed values are decoded to human-readable labels rather than passed through as raw negative sentinels.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    variables: z
      .array(z.string())
      .describe(
        'Variable codes to compare (e.g., ["B17001_002E", "B17001_001E"]). Include MOE counterparts (M suffix) for reliability context.',
      ),
    geography_level: z
      .string()
      .describe(
        'The level to compare across (e.g., "state", "county", "tract"). Use census_list_geographies to see valid values for the dataset.',
      ),
    within: z
      .string()
      .optional()
      .describe(
        'State FIPS to constrain results (e.g., "53" to compare counties or tracts within WA only). Omit to compare all geographies at the level nationally. Use census_resolve_geography to get state_fips.',
      ),
    within_county: z
      .string()
      .optional()
      .describe(
        'County FIPS (3 digits) to constrain tract or block-group comparisons to a single county within the state specified by within (e.g., "033" for King County). Required when geography_level is "tract" or "block group" and you want county-scoped results. census_resolve_geography returns this as county_fips.',
      ),
    geographies: z
      .array(z.string())
      .optional()
      .describe(
        'Optional list of specific geography FIPS codes to include. When provided, only these geographies are returned. Omit to return all geographies within the level. Use census_resolve_geography for each place name to get its FIPS.',
      ),
    dataset: z
      .string()
      .optional()
      .describe(
        'Dataset to query (default: "acs/acs5"). Use census_list_datasets for valid values.',
      ),
    year: z
      .number()
      .optional()
      .describe('Vintage year (default: latest available for the dataset).'),
    sort_by: z
      .string()
      .optional()
      .describe(
        'Variable code to sort by (default: first variable in the list). Must be one of the requested variable codes.',
      ),
    sort_dir: z
      .enum(['asc', 'desc'])
      .optional()
      .describe('Sort direction (default: "desc" — highest value first).'),
    limit: z
      .number()
      .optional()
      .describe(
        'Maximum geographies to return (default: 50, max: 500). When results are truncated, total_count indicates how many matched.',
      ),
  }),
  output: z.object({
    rows: z
      .array(
        z
          .object({
            geography_name: z.string().describe('Human-readable geography name.'),
            geography_fips: z
              .string()
              .describe(
                'FIPS code for this geography. Matches the geography_fips parameter in census_query_data for follow-up variable queries.',
              ),
            variables: z
              .object({})
              .passthrough()
              .describe(
                'Map of variable code to value entry. Each key is a variable code from the variables input; each value has: estimate (number|null), moe (number|null, optional), label (string), suppressed (boolean).',
              ),
            rank: z
              .number()
              .describe(
                'Rank of this geography by the sort variable (1 = highest when sort_dir is desc).',
              ),
          })
          .describe('One ranked geography row with variable values.'),
      )
      .describe('Geographies sorted by the requested variable. Suppressed values are labeled.'),
  }),

  enrichment: {
    totalCount: z
      .number()
      .describe('Total number of geographies matched before the limit was applied.'),
    truncated: z
      .boolean()
      .describe('True when totalCount exceeds the limit and results were cut off.'),
    sortVariable: z.string().describe('Variable code used for sorting.'),
    dataset: z.string().describe('Dataset queried.'),
    year: z.number().describe('Vintage year queried.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when results were truncated — how to narrow scope or increase limit.'),
  },

  errors: [
    {
      reason: 'dataset_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Dataset code is not recognized.',
      recovery: 'Call census_list_datasets to discover valid dataset codes like acs/acs5.',
    },
    {
      reason: 'missing_api_key',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'CENSUS_API_KEY is not configured or the key is invalid.',
      recovery:
        'Set the CENSUS_API_KEY environment variable and restart the server. Register a free key at api.census.gov/data/key_signup.html.',
    },
    {
      reason: 'geography_not_supported',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The requested geography level is not available for this dataset and year.',
      recovery:
        'Call census_list_geographies to see supported geography levels for this dataset and year.',
    },
    {
      reason: 'parent_required',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The geography level requires a parent FIPS but within was not provided.',
      recovery:
        'Add the within parameter with the parent FIPS — use census_resolve_geography to get the state_fips.',
    },
    {
      reason: 'variable_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'One or more variable codes are not found in this dataset and year.',
      recovery:
        'Use census_search_variables or census_get_variable to confirm codes for this dataset and year.',
    },
    {
      reason: 'no_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'No geographies were returned for the query.',
      recovery:
        'ACS1 only covers geographies with 65K+ population — switch to acs/acs5, or verify the geographies list contains valid FIPS codes for this dataset.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Census API was unreachable or returned an error.',
      retryable: true,
      recovery:
        'Retry the request; if the error persists, the Census API may be temporarily unavailable.',
    },
  ],

  async handler(input, ctx) {
    if (input.dataset && !KNOWN_DATASETS.has(input.dataset)) {
      throw ctx.fail('dataset_not_found', `Unknown dataset: "${input.dataset}"`, {
        dataset: input.dataset,
        ...ctx.recoveryFor('dataset_not_found'),
      });
    }

    const dataset = input.dataset?.trim() || 'acs/acs5';
    const { defaultYear } = getDiscoveryConfig();
    const year = input.year ?? DATASET_LATEST_YEARS[dataset] ?? defaultYear;
    const limit = Math.min(input.limit ?? 50, 500);
    const sortDir = input.sort_dir ?? 'desc';
    const sortBy = input.sort_by?.trim() || input.variables[0] || '';

    ctx.log.info('Comparing geographies', {
      variables: input.variables,
      geographyLevel: input.geography_level,
      within: input.within,
      dataset,
      year,
    });

    // Fetch variable labels for enrichment (best-effort)
    const variableCacheService = getVariableCacheService();
    const variableLabels: Map<string, string> = new Map();
    try {
      const meta = await variableCacheService.getVariablesByCode(
        input.variables,
        dataset,
        year,
        ctx,
      );
      for (const v of meta) {
        variableLabels.set(v.code, v.label);
      }
    } catch {
      ctx.log.debug('Variable label enrichment skipped', { dataset, year });
    }

    // Determine geography_fips — use wildcard to get all geographies at the level
    const geographyFips = '*';
    const parentFips = input.within?.trim() || undefined;
    const countyFips = input.within_county?.trim() || undefined;

    const apiService = getCensusApiService();
    const rows = await apiService.queryData(
      {
        variables: input.variables,
        geographyLevel: input.geography_level,
        geographyFips,
        ...(parentFips !== undefined && { parentFips }),
        ...(countyFips !== undefined && { countyFips }),
        dataset,
        year,
      },
      ctx,
    );

    if (rows.length === 0) {
      throw ctx.fail(
        'no_data',
        `No geographies returned for ${input.geography_level} in ${dataset} (${year}).`,
        {
          dataset,
          year,
          geographyLevel: input.geography_level,
          ...ctx.recoveryFor('no_data'),
        },
      );
    }

    let filteredRows = rows;
    if (input.geographies && input.geographies.length > 0) {
      const geoSet = new Set(input.geographies.map((g) => g.trim()));
      filteredRows = rows.filter((r) => geoSet.has(r.geographyFips));
    }

    // Sort by sort_by variable (non-suppressed values first, then suppressed at end)
    const sorted = [...filteredRows].sort((a, b) => {
      const aVal = a.variables[sortBy]?.estimate;
      const bVal = b.variables[sortBy]?.estimate;

      if (aVal === null && bVal === null) return 0;
      if (aVal === null) return 1;
      if (bVal === null) return -1;
      if (aVal === undefined && bVal === undefined) return 0;
      if (aVal === undefined) return 1;
      if (bVal === undefined) return -1;

      return sortDir === 'desc' ? bVal - aVal : aVal - bVal;
    });

    const totalCount = sorted.length;
    const truncated = totalCount > limit;
    const sliced = sorted.slice(0, limit);

    const resultRows = sliced.map((row, idx) => {
      const enrichedVariables: Record<
        string,
        {
          estimate: number | null;
          moe?: number | null;
          label: string;
          suppressed: boolean;
        }
      > = {};

      for (const [code, val] of Object.entries(row.variables)) {
        enrichedVariables[code] = {
          estimate: val.estimate,
          ...(val.moe !== undefined && { moe: val.moe }),
          label: variableLabels.get(code) ?? val.label,
          suppressed: val.suppressed,
        };
      }

      return {
        geography_name: row.geographyName,
        geography_fips: row.geographyFips,
        variables: enrichedVariables,
        rank: idx + 1,
      };
    });

    ctx.enrich({ totalCount, truncated, sortVariable: sortBy, dataset, year });
    if (truncated) {
      ctx.enrich.notice(
        `Results truncated — ${totalCount - sliced.length} more geographies not shown. Increase the limit parameter or use within to narrow the scope.`,
      );
    }

    return { rows: resultRows };
  },

  format: (result) => {
    const lines: string[] = [`## Geography Comparison\n`];

    for (const row of result.rows) {
      lines.push(`### ${row.rank}. ${row.geography_name}`);
      lines.push(`**FIPS:** \`${row.geography_fips}\``);
      for (const [code, rawVal] of Object.entries(row.variables)) {
        const val = rawVal as {
          estimate: number | null;
          moe?: number | null;
          label: string;
          suppressed: boolean;
        };
        if (val.suppressed) {
          lines.push(`- **${code}:** Suppressed`);
        } else {
          const moePart = val.moe != null ? ` ± ${val.moe.toLocaleString()}` : '';
          lines.push(`- **${code}:** ${val.estimate?.toLocaleString() ?? 'N/A'}${moePart}`);
        }
        if (val.label && val.label !== code) {
          lines.push(`  *${val.label}*`);
        }
      }
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
