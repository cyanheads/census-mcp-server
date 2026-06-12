/**
 * @fileoverview Tool to query a Census dataset for variables at a specific geography.
 * @module mcp-server/tools/definitions/census-query-data
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { getDiscoveryConfig } from '@/config/server-config.js';
import { getCensusApiService } from '@/services/census-api/census-api-service.js';
import {
  DATASET_LATEST_YEARS,
  getVariableCacheService,
  KNOWN_DATASETS,
} from '@/services/variable-cache/variable-cache-service.js';

export const censusQueryData = tool('census_query_data', {
  title: 'Query Census Data',
  description:
    'Query a Census dataset for one or more variables at a specific geography. Accepts FIPS codes for the target geography — use census_resolve_geography to convert place names to FIPS when needed. Labeled estimates and margin-of-error values are returned together. Suppression codes (geography too small, data not collected) are decoded into human-readable reasons rather than passed through as raw negative numbers. Pass geography_fips as "*" to return all geographies at the level within the parent.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    variables: z
      .array(z.string())
      .describe(
        'Variable codes to retrieve (e.g., ["B19013_001E", "B19013_001M"]). Max 50 per request. Use census_search_variables to find codes. Include the MOE counterpart (swap E → M suffix) to get margin-of-error alongside each estimate.',
      ),
    geography_level: z
      .string()
      .describe(
        'Level of the target geography (e.g., "county", "tract", "state", "zip code tabulation area"). Use census_list_geographies to see valid values for the dataset.',
      ),
    geography_fips: z
      .string()
      .describe(
        'FIPS code for the target geography (e.g., "033" for a county, "*" for all geographies at the level within the parent). Use census_resolve_geography to obtain this value — it is returned as fips_summary.',
      ),
    parent_fips: z
      .string()
      .optional()
      .describe(
        'State FIPS code when querying sub-state levels (e.g., "53" for Washington). Required for county, tract, and block-group queries. census_resolve_geography returns this as state_fips.',
      ),
    county_fips: z
      .string()
      .optional()
      .describe(
        'County FIPS code (3 digits) when querying tracts or block groups within a specific county (e.g., "033" for King County within WA). Required for tract and block-group queries scoped to a county — use alongside parent_fips (state). census_resolve_geography returns this as county_fips.',
      ),
    dataset: z
      .string()
      .optional()
      .describe(
        'Dataset to query (default: "acs/acs5"). Use census_list_datasets to discover valid values.',
      ),
    year: z
      .number()
      .optional()
      .describe('Vintage year (default: latest available for the dataset).'),
  }),
  output: z.object({
    rows: z
      .array(
        z
          .object({
            geography_name: z
              .string()
              .describe('Human-readable geography name (e.g., "King County, Washington").'),
            geography_fips: z
              .string()
              .describe(
                'FIPS code for this geography at the queried level. Matches the geography_fips parameter in census_query_data for follow-up queries.',
              ),
            variables: z
              .object({})
              .passthrough()
              .describe(
                'Map of variable code to value entry. Each key is a variable code from the variables input; each value has: estimate (number|null), moe (number|null, optional), label (string), suppressed (boolean), suppression_reason (string, optional).',
              ),
          })
          .describe('Data for one geography — name, FIPS, and variable values.'),
      )
      .describe(
        'One row per geography. When geography_fips is "*", includes all geographies at the level within the parent.',
      ),
  }),

  enrichment: {
    totalRows: z.number().describe('Number of geography rows returned.'),
    dataset: z.string().describe('Dataset queried.'),
    year: z.number().describe('Vintage year queried.'),
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
      reason: 'variable_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'One or more variable codes do not exist in the requested dataset and year.',
      recovery:
        'Call census_search_variables or census_get_variable to confirm codes for this dataset and year.',
    },
    {
      reason: 'geography_not_supported',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The requested geography level is not available for this dataset and year.',
      recovery: 'Call census_list_geographies to see supported geography levels for this dataset.',
    },
    {
      reason: 'parent_required',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The geography level requires a parent FIPS code but parent_fips was not provided, or a tract/block-group level requires county_fips but it was omitted.',
      recovery:
        'Add parent_fips (state FIPS) from census_resolve_geography state_fips. For tract or block-group levels also add county_fips from census_resolve_geography county_fips.',
    },
    {
      reason: 'no_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'The query returned no rows.',
      recovery:
        'ACS1 only covers geographies with 65K+ population — switch to acs/acs5, or check census_list_geographies for supported levels.',
    },
    {
      reason: 'too_many_variables',
      code: JsonRpcErrorCode.ValidationError,
      when: 'More than 50 variable codes were requested.',
      recovery: 'Split the request into multiple calls with at most 50 variables each.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Census API returned an error or was unreachable.',
      retryable: true,
      recovery:
        'Retry the request; if the error persists, the Census API may be temporarily unavailable.',
    },
  ],

  async handler(input, ctx) {
    if (input.variables.length === 0) {
      throw validationError(
        'At least one variable code is required. Use census_search_variables to find codes.',
        { variableCount: 0 },
      );
    }

    if (input.variables.length > 50) {
      throw ctx.fail(
        'too_many_variables',
        `${input.variables.length} variables requested; maximum is 50.`,
        { requested: input.variables.length, ...ctx.recoveryFor('too_many_variables') },
      );
    }

    if (!KNOWN_DATASETS.has(input.dataset ?? 'acs/acs5')) {
      throw ctx.fail(
        'dataset_not_found',
        `Unknown dataset: "${input.dataset}". Call census_list_datasets to discover valid dataset codes.`,
        { dataset: input.dataset, ...ctx.recoveryFor('dataset_not_found') },
      );
    }

    const dataset = input.dataset?.trim() || 'acs/acs5';
    const { defaultYear } = getDiscoveryConfig();
    const year = input.year ?? DATASET_LATEST_YEARS[dataset] ?? defaultYear;

    ctx.log.info('Querying Census data', {
      variables: input.variables,
      geographyLevel: input.geography_level,
      geographyFips: input.geography_fips,
      dataset,
      year,
    });

    // Fetch variable labels for enrichment (best-effort — don't fail if cache is cold)
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

    const apiService = getCensusApiService();
    const parentFips = input.parent_fips?.trim() || undefined;
    const countyFips = input.county_fips?.trim() || undefined;
    const rows = await apiService.queryData(
      {
        variables: input.variables,
        geographyLevel: input.geography_level,
        geographyFips: input.geography_fips,
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
        `No data returned for ${input.geography_level} in ${dataset} (${year}).`,
        {
          dataset,
          year,
          geographyLevel: input.geography_level,
          ...ctx.recoveryFor('no_data'),
        },
      );
    }

    const enrichedRows = rows.map((row) => {
      const enrichedVariables: Record<
        string,
        {
          estimate: number | null;
          moe?: number | null;
          label: string;
          suppressed: boolean;
          suppression_reason?: string;
        }
      > = {};

      for (const [code, val] of Object.entries(row.variables)) {
        enrichedVariables[code] = {
          estimate: val.estimate,
          ...(val.moe !== undefined && { moe: val.moe }),
          label: variableLabels.get(code) ?? val.label,
          suppressed: val.suppressed,
          ...(val.suppressionReason && { suppression_reason: val.suppressionReason }),
        };
      }

      return {
        geography_name: row.geographyName,
        geography_fips: row.geographyFips,
        variables: enrichedVariables,
      };
    });

    ctx.enrich({ totalRows: enrichedRows.length, dataset, year });

    return { rows: enrichedRows };
  },

  format: (result) => {
    const lines: string[] = [`## Census Data`, `**${result.rows.length} geography rows**\n`];

    for (const row of result.rows) {
      lines.push(`### ${row.geography_name}`);
      lines.push(`**FIPS:** \`${row.geography_fips}\``);
      for (const [code, rawVal] of Object.entries(row.variables)) {
        const val = rawVal as {
          estimate: number | null;
          moe?: number | null;
          label: string;
          suppressed: boolean;
          suppression_reason?: string;
        };
        if (val.suppressed) {
          lines.push(
            `- **${code}:** Suppressed${val.suppression_reason ? ` (${val.suppression_reason})` : ''}`,
          );
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
