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
  describeEmptyPredicatedResult,
  describeUnsetPredicates,
  getVariableCacheService,
  KNOWN_DATASETS,
} from '@/services/variable-cache/variable-cache-service.js';

export const censusCompareGeographies = tool('census_compare_geographies', {
  title: 'Compare Census Geographies',
  description:
    'Compare one or more variables across multiple geographies at the same level — all counties in a state, all states nationally, or a named set of specific geographies. Results are sorted and ranked. Covers queries like "rank states by poverty rate", "compare median income across WA counties", or "which census tracts in King County have the highest renter rate." Omit within to compare all geographies nationally at the level. Suppressed values are decoded to human-readable labels rather than passed through as raw negative sentinels. On the business datasets (cbp, ecnbasic, nonemp) and pep/charv, use predicates to rank within one industry, size class, or demographic dimension — a comparison that omits them ranks on the total across every category, which the response notice names.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    variables: z
      .array(z.string())
      .describe(
        'Variable codes to compare (e.g., ["B17001_002E", "B17001_001E"]). On ACS datasets, add the margin-of-error counterpart of a code (same code, E suffix swapped for M) for reliability context. Other dataset families (pep, dec, cbp, ecnbasic, nonemp) publish no margins of error.',
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
        'Optional list of specific geographies to include; only these are returned. Prefer full GEOIDs — the level concatenated with its parents, e.g. "53033" for King County WA and "06037" for Los Angeles County CA — which are nationally unique and so work across states. Bare level codes ("033") are also accepted but match that code in every state unless within scopes them to one. A GEOID is easiest taken from the geography_geoid field of a census_query_data or census_compare_geographies row; from census_resolve_geography, concatenate state_fips, then county_fips when it is present, then fips_summary. Entries that match nothing, and bare codes that match more than one state, are named in the response notice.',
      ),
    predicates: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Filter values keyed by variable code, applied to every geography in the comparison — e.g. {"NAICS2017": "5112"} to rank counties by their software-publisher establishment count in cbp. The business datasets (cbp, ecnbasic, nonemp) and pep/charv declare filter dimensions such as industry (NAICS2017/NAICS2022), legal form (LFO), size class (EMPSZES/RCPSZES), tax status (TAXSTAT), operation type (TYPOP), sex (SEX), and age (AGE). Leaving one unset is not an error: the Census API ranks on the total across every category of that dimension, so a ranking of all industries comes back looking like the industry-specific one. Any dimension left unset is named in the response notice. Code names vary by dataset and vintage — cbp 2023 uses NAICS2017 while nonemp 2023 uses NAICS2022 — so read them from the notice or from census_search_variables. NAICS values are standard North American Industry Classification System codes at any depth (51 information, 5112 software publishers); the other dimensions use short Census category codes documented with the dataset.',
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
                'FIPS code for this geography at the compared level only, without its parents (e.g., "033" for King County). Pass back as the geography_fips parameter in census_query_data — alongside within as parent_fips — for follow-up variable queries.',
              ),
            geography_geoid: z
              .string()
              .describe(
                'Full GEOID — the compared level concatenated with its parent levels (e.g., "53033" for King County, "53033000101" for a tract). Nationally unique, unlike geography_fips, so this is the value to pass back in the geographies filter.',
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
      .describe(
        'Guidance when results were truncated, when geographies entries matched no row, when a bare level code matched more than one state, or when the dataset declares filter dimensions the query left unset — how to narrow scope, raise the limit, correct the FIPS codes, or add the predicates that make the ranking specific rather than an all-categories total.',
      ),
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
      when: 'The requested geography level does not exist in this dataset and year.',
      recovery:
        'Call census_list_geographies to see supported geography levels for this dataset and year.',
    },
    {
      reason: 'parent_required',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The geography level requires a parent FIPS but within, or within_county, was not provided.',
      recovery:
        'Add the within parameter with the state FIPS from census_resolve_geography state_fips. For tract or block-group levels also add within_county from census_resolve_geography county_fips.',
    },
    {
      reason: 'variable_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'One or more variable codes are not found in this dataset and year.',
      recovery:
        'Use census_search_variables or census_get_variable to confirm codes for this dataset and year.',
    },
    {
      reason: 'predicate_not_supported',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A key in predicates is not a variable in this dataset and year.',
      recovery:
        'Remove the unrecognized key. Call census_search_variables on this dataset and year for the codes it does define — predicate names are vintage-specific, so NAICS2017 and NAICS2022 belong to different years.',
    },
    {
      reason: 'no_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'No geographies were returned for the query, or no row matched any entry in the geographies list.',
      recovery:
        'Confirm the level is populated for this dataset and year with census_list_geographies, and that any geographies entries are valid FIPS codes from census_resolve_geography.',
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

    // Every geography at the level is fetched with a wildcard, then filtered client-side.
    const geographyFips = '*';
    const parentFips = input.within?.trim() || undefined;
    const countyFips = input.within_county?.trim() || undefined;

    const apiService = getCensusApiService();

    // Validate the level and its parents against the dataset's own geography.json before
    // spending a data query the Census API would reject with an opaque 400.
    const check = await apiService.checkGeography(
      {
        dataset,
        year,
        geographyLevel: input.geography_level,
        geographyFips,
        ...(parentFips !== undefined && { parentFips }),
        ...(countyFips !== undefined && { countyFips }),
      },
      ctx,
    );

    if (check.status === 'level_not_supported') {
      throw ctx.fail(
        'geography_not_supported',
        `Geography level "${input.geography_level}" does not exist in ${dataset} (${year}).`,
        {
          dataset,
          year,
          geographyLevel: input.geography_level,
          availableLevels: check.availableLevels,
          ...ctx.recoveryFor('geography_not_supported'),
        },
      );
    }

    if (check.status === 'parent_required') {
      const missing = check.missingParents;
      const steps = missing.map((parent) =>
        parent === 'state'
          ? 'add within (census_resolve_geography returns it as state_fips)'
          : parent === 'county'
            ? 'add within_county (census_resolve_geography returns it as county_fips)'
            : `scope the comparison by ${parent}, which this tool has no input for — call census_list_geographies and pick a level whose only parents are state and county`,
      );
      throw ctx.fail(
        'parent_required',
        `Geography level "${input.geography_level}" in ${dataset} (${year}) must be scoped by ${missing.join(' and ')}.`,
        {
          dataset,
          year,
          geographyLevel: input.geography_level,
          missingParents: missing,
          recovery: { hint: `To compare at this level, ${steps.join(', and ')}.` },
        },
      );
    }

    const variableCacheService = getVariableCacheService();

    // Reject unknown predicate keys before spending the call — the Census API answers them with
    // a 400 whose surfaced message names only the request URL, never which key it rejected.
    const predicates = input.predicates ?? {};
    const predicateCheck = await variableCacheService.checkPredicates(
      { dataset, year, supplied: Object.keys(predicates) },
      ctx,
    );

    if (predicateCheck.unknown.length > 0) {
      throw ctx.fail(
        'predicate_not_supported',
        `${predicateCheck.unknown.join(', ')} ${predicateCheck.unknown.length === 1 ? 'is not a variable' : 'are not variables'} in ${dataset} (${year}).`,
        {
          dataset,
          year,
          unknownPredicates: predicateCheck.unknown,
          ...ctx.recoveryFor('predicate_not_supported'),
        },
      );
    }

    const unfiltered = predicateCheck.unset;

    // Fetch variable labels for enrichment (best-effort)
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

    const rows = await apiService.queryData(
      {
        variables: input.variables,
        geographyLevel: input.geography_level,
        geographyFips,
        ...(parentFips !== undefined && { parentFips }),
        ...(countyFips !== undefined && { countyFips }),
        ...(Object.keys(predicates).length > 0 && { predicates }),
        dataset,
        year,
      },
      ctx,
    );

    if (rows.length === 0) {
      // Only steer toward acs/acs5 from a dataset that actually covers less than it does.
      // Predicates can empty a result on their own — ecnbasic publishes nothing at county level
      // until an industry is named, and an unknown value is a 204 — so they take priority.
      const predicateHint = describeEmptyPredicatedResult(
        unfiltered,
        Object.keys(predicates),
        dataset,
        year,
      );
      const hint = predicateHint
        ? `${predicateHint} Otherwise confirm the level with census_list_geographies.`
        : dataset.startsWith('acs/acs1')
          ? `ACS1 only covers geographies with 65,000+ population — switch to dataset "acs/acs5" for smaller geographies, or confirm the level with census_list_geographies.`
          : `Confirm ${input.geography_level} is populated in ${dataset} (${year}) with census_list_geographies, and that within names a valid state FIPS.`;
      throw ctx.fail(
        'no_data',
        `No geographies returned for ${input.geography_level} in ${dataset} (${year}).`,
        {
          dataset,
          year,
          geographyLevel: input.geography_level,
          recovery: { hint },
        },
      );
    }

    let filteredRows = rows;
    let unmatchedGeographies: string[] = [];
    let ambiguousGeographies: string[] = [];
    if (input.geographies && input.geographies.length > 0) {
      // Accept both the full GEOID and the bare level code — the latter only disambiguates
      // when within scopes the comparison to a single state.
      const requested = [...new Set(input.geographies.map((g) => g.trim()).filter(Boolean))];
      const geoSet = new Set(requested);
      filteredRows = rows.filter(
        (r) => geoSet.has(r.geographyGeoid) || geoSet.has(r.geographyFips),
      );

      const matched = new Set(filteredRows.flatMap((r) => [r.geographyGeoid, r.geographyFips]));
      unmatchedGeographies = requested.filter((g) => !matched.has(g));
      // A bare code carries no parent, so an unscoped comparison matches it in every state.
      // The rows are real, but they are not the one geography the caller named.
      const bareMatches = new Map<string, number>();
      for (const r of filteredRows) {
        if (r.geographyGeoid !== r.geographyFips && geoSet.has(r.geographyFips)) {
          bareMatches.set(r.geographyFips, (bareMatches.get(r.geographyFips) ?? 0) + 1);
        }
      }
      ambiguousGeographies = requested.filter((g) => (bareMatches.get(g) ?? 0) > 1);

      if (filteredRows.length === 0) {
        throw ctx.fail(
          'no_data',
          `None of the ${requested.length} requested geographies matched a ${input.geography_level} in ${dataset} (${year}): ${requested.join(', ')}.`,
          {
            dataset,
            year,
            geographyLevel: input.geography_level,
            unmatchedGeographies,
            recovery: {
              hint: `The geographies filter matches a row's full GEOID (level plus parents, e.g. "53033" for a WA county) or its bare level code ("033") when within scopes the comparison to one state. Take a GEOID from the geography_geoid field of a census_query_data row, or build it from census_resolve_geography by concatenating state_fips, then county_fips when present, then fips_summary.`,
            },
          },
        );
      }
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
        geography_geoid: row.geographyGeoid,
        variables: enrichedVariables,
        rank: idx + 1,
      };
    });

    ctx.enrich({ totalCount, truncated, sortVariable: sortBy, dataset, year });

    const notices: string[] = [];
    // Lead with the unfiltered-dimension warning: it says the ranking answers a different
    // question, which outranks advice about how much of that ranking was shown.
    if (unfiltered.length > 0) {
      notices.push(describeUnsetPredicates(unfiltered, dataset, year));
    }
    if (truncated) {
      notices.push(
        `Results truncated — ${totalCount - sliced.length} more geographies not shown. Increase the limit parameter or use within to narrow the scope.`,
      );
    }
    if (unmatchedGeographies.length > 0) {
      notices.push(
        `No ${input.geography_level} matched ${unmatchedGeographies.length} of the requested geographies: ${unmatchedGeographies.join(', ')}. Entries must be a full GEOID (level plus parents, e.g. "53033"), or a bare level code when within scopes the comparison to one state.`,
      );
    }
    if (ambiguousGeographies.length > 0) {
      notices.push(
        `${ambiguousGeographies.join(', ')} matched a ${input.geography_level} in more than one state because bare level codes carry no parent. Add within to scope the comparison to one state, or pass full GEOIDs (e.g. "53033") to name exactly the geographies you want.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return { rows: resultRows };
  },

  format: (result) => {
    const lines: string[] = [`## Geography Comparison\n`];

    for (const row of result.rows) {
      lines.push(`### ${row.rank}. ${row.geography_name}`);
      lines.push(`**FIPS:** \`${row.geography_fips}\` · **GEOID:** \`${row.geography_geoid}\``);
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
