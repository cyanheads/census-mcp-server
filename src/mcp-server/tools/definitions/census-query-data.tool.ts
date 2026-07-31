/**
 * @fileoverview Tool to query a Census dataset for variables at a specific geography.
 * @module mcp-server/tools/definitions/census-query-data
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { getDiscoveryConfig } from '@/config/server-config.js';
import {
  getCensusApiService,
  observeRecordValues,
  padFips,
} from '@/services/census-api/census-api-service.js';
import {
  DATASET_LATEST_YEARS,
  defaultLabelColumnsFor,
  describeEmptyPredicatedResult,
  describeRecordRows,
  describeUnsetPredicates,
  getVariableCacheService,
  KNOWN_DATASETS,
  recordLabelColumnsFor,
} from '@/services/variable-cache/variable-cache-service.js';

export const censusQueryData = tool('census_query_data', {
  title: 'Query Census Data',
  description:
    'Query a Census dataset for one or more variables at a specific geography. Accepts FIPS codes for the target geography — use census_resolve_geography to convert place names to FIPS when needed. On ACS datasets, labeled estimates and margin-of-error values are returned together. Suppression codes (geography too small, data not collected) are decoded into human-readable reasons rather than passed through as raw negative numbers. Pass geography_fips as "*" to return all geographies at the level within the parent. On the business datasets (cbp, ecnbasic, nonemp), pep/charv, and dec/ddhca, use predicates to filter by industry, size class, or population group — a query that omits one is answered with a default the Census API picks, which is an all-categories total on some dimensions and a single category on others. Each row names the defaults that were applied in applied_filters, and census_list_predicate_values enumerates the codes a dimension accepts. One geography can also come back on more than one row: pep/charv publishes an April estimates base alongside its July estimate, and each row carries a record field saying which it is.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    variables: z
      .array(z.string())
      .describe(
        'Variable codes to retrieve (e.g., ["B19013_001E", "B19013_001M"]). Max 50 per request. Use census_search_variables to find codes. On ACS datasets only, each estimate has a margin-of-error counterpart at the same code with the E suffix swapped for M — request both to get the margin alongside the estimate. Other dataset families (pep, dec, cbp, ecnbasic, nonemp) publish no margins of error, and an E-final code there is an ordinary code with no M sibling. A code can also name a text column rather than a measure — GEO_ID, on every dataset, is the nationally unique geography identifier and comes back under value with estimate null, which is the code to request when a stable join key is what is wanted.',
      ),
    geography_level: z
      .string()
      .describe(
        'Level of the target geography (e.g., "county", "tract", "state", "zip code tabulation area"). Use census_list_geographies to see valid values for the dataset.',
      ),
    geography_fips: z
      .string()
      .describe(
        'FIPS code for the target geography (e.g., "033" for a county, "*" for all geographies at the level within the parent). Use census_resolve_geography to obtain this value — it is returned as fips_summary. The Census API matches this literally and its width follows geography_level, so it is passed through unpadded: a county is 3 digits ("051", not "51") and a tract is 6. parent_fips and county_fips are zero-padded for you; this one is not.',
      ),
    parent_fips: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(/^(\*|\d{1,2})$/)
          .describe('1 to 2 digits, zero-padded here to the 2 the Census stores, or "*".'),
      ])
      .optional()
      .describe(
        'State FIPS code when querying sub-state levels (e.g., "53" for Washington). Required for county, tract, and block-group queries. census_resolve_geography returns this as state_fips. Pass "*" to span every state. Blank is treated as omitted.',
      ),
    county_fips: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(/^(\*|\d{1,3})$/)
          .describe('1 to 3 digits, zero-padded here to the 3 the Census stores, or "*".'),
      ])
      .optional()
      .describe(
        'County FIPS code when querying tracts or block groups within a specific county (e.g., "033" for King County within WA). Required for tract and block-group queries scoped to a county — use alongside parent_fips (state). census_resolve_geography returns this as county_fips. Pass "*" to span every county in the state, which is the only way a block-group query reaches a whole state. Blank is treated as omitted.',
      ),
    predicates: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Filter values keyed by variable code, sent as extra query parameters — e.g. {"NAICS2017": "5112"} to count only software publishers in cbp. The business datasets (cbp, ecnbasic, nonemp), pep/charv, and dec/ddhca declare filter dimensions such as industry (NAICS2017/NAICS2022), legal form (LFO), size class (EMPSZES/RCPSZES), tax status (TAXSTAT), operation type (TYPOP), sex (SEX), age (AGE), and population group (POPGROUP). Leaving one unset is not an error: the Census API substitutes its own default, which is the all-categories total on cbp NAICS2017 but a single population group on dec/ddhca POPGROUP and a single sector on ecnbasic NAICS2022 — so an unfiltered value can read like a total without being one. Every unset dimension is named in the response notice and its applied default is echoed per row in applied_filters. Code names vary by dataset and vintage — cbp 2023 uses NAICS2017 while nonemp 2023 uses NAICS2022 — so read them from the notice or from census_search_variables. Call census_list_predicate_values for the codes a dimension accepts; NAICS values are standard North American Industry Classification System codes at any depth (51 information, 5112 software publishers).',
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
                'FIPS code for this geography at the queried level only, without its parents (e.g., "033" for King County). Pass back as the geography_fips parameter in census_query_data — alongside the same parent_fips/county_fips — for follow-up queries.',
              ),
            geography_geoid: z
              .string()
              .describe(
                'Full GEOID — the queried level concatenated with its parent levels (e.g., "53033" for King County, "53033000101" for a tract). Nationally unique, unlike geography_fips. Pass these to the geographies filter in census_compare_geographies to compare geographies across different states.',
              ),
            variables: z
              .object({})
              .passthrough()
              .describe(
                'Map of variable code to value entry. Each key is a variable code from the variables input; each value has: estimate (number|null), moe (number|null, optional), label (string), suppressed (boolean), suppression_reason (string, optional), value (string, optional). An estimate of null means one of three things and the other fields say which: suppressed true is a number the Census withheld, a value field is a cell holding text rather than a number (GEO_ID returns "0500000US53033"; the older ACS profile vintages write not-applicable as "(X)" in a column that is a number elsewhere), and neither is a cell with nothing in it.',
              ),
            applied_filters: z
              .object({})
              .passthrough()
              .optional()
              .describe(
                'Filter dimensions the query left unset, mapped to the label of the default the Census API applied (e.g. {"POPGROUP": "European alone"}). Present only on datasets that declare filter dimensions. The label is what tells an all-categories total apart from one ordinary category — dec/ddhca defaults POPGROUP to a single population group, so a value carrying "European alone" is that group\'s count and not the geography\'s population. Set the dimension in predicates to choose it yourself.',
              ),
            record: z
              .object({})
              .passthrough()
              .optional()
              .describe(
                'Which record this row is, for a dataset that publishes more than one per geography — keyed by the column that separates them, each value carrying a code and a label (e.g. {"MONTH": {"code": "7", "label": "July"}}). pep/charv publishes an April estimates base and a July estimate, so one geography comes back on two rows whose numbers differ; this field is what says which is which. Pass the code back in predicates (e.g. {"MONTH": "7"}) to return that record alone. Absent on the datasets that return one row per geography.',
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
    notice: z
      .string()
      .optional()
      .describe(
        'Warning that the dataset declares filter dimensions the query left unset, naming each one alongside the label of the default the Census API applied to it. That default is an all-categories total on some dimensions and one ordinary category on others, so the label is what says which. Also carries the warning that a geography came back on more than one row, naming the column that separates the records and the values it took.',
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
      reason: 'year_not_available',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The dataset does not serve the requested vintage year.',
      recovery:
        'Retry with a year from available_years in census_list_datasets; the error names the years this dataset serves.',
    },
    {
      reason: 'variable_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'One or more variable codes do not exist in the requested dataset and year.',
      recovery:
        'Call census_search_variables or census_get_variable to confirm codes for this dataset and year.',
    },
    {
      reason: 'variables_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The variable metadata endpoint returned an unparseable response for this dataset and year.',
      retryable: true,
      recovery:
        'Retry the request; if it persists, the Census metadata endpoint is temporarily unavailable.',
    },
    {
      reason: 'geography_not_supported',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The requested geography level does not exist in this dataset and year.',
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
      reason: 'parent_not_accepted',
      code: JsonRpcErrorCode.ValidationError,
      when: 'parent_fips or county_fips names a parent the geography level does not sit within.',
      recovery:
        'Drop the parent this level does not name. Levels such as zip code tabulation area, urban area, and metropolitan statistical area/micropolitan statistical area are queried with no parent at all; census_list_geographies shows the parents each level takes.',
    },
    {
      reason: 'no_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'The query returned no rows.',
      recovery:
        'Confirm the FIPS codes exist for this dataset and year — census_resolve_geography returns them for a place name, and census_list_geographies confirms the level is supported.',
    },
    {
      reason: 'too_many_variables',
      code: JsonRpcErrorCode.ValidationError,
      when: 'More than 50 variable codes were requested.',
      recovery: 'Split the request into multiple calls with at most 50 variables each.',
    },
    {
      reason: 'predicate_not_supported',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A key in predicates is not a variable in this dataset and year.',
      recovery:
        'Remove the unrecognized key. Call census_search_variables on this dataset and year for the codes it does define — predicate names are vintage-specific, so NAICS2017 and NAICS2022 belong to different years.',
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

    const variableCacheService = getVariableCacheService();
    // Ahead of the geography check, which is the first request this handler makes. A vintage the
    // dataset does not serve has no geography metadata either, so leaving the check downstream
    // spends a round trip and reports the wrong problem for a year that is simply wrong.
    variableCacheService.validateYear(dataset, year);

    ctx.log.info('Querying Census data', {
      variables: input.variables,
      geographyLevel: input.geography_level,
      geographyFips: input.geography_fips,
      dataset,
      year,
    });

    const apiService = getCensusApiService();
    // The Census API matches FIPS literally — `county:51` and `county:051` are different
    // queries and the short one answers 204. Both parents have a fixed width, so padding is
    // unambiguous; census_resolve_geography already pads the codes it hands back. `*` is a
    // scope rather than a code and passes through unpadded.
    const parentFips = padFips(input.parent_fips, 2);
    const countyFips = padFips(input.county_fips, 3);

    // Validate the level and its parents against the dataset's own geography.json before
    // spending a data query the Census API would reject with an opaque 400.
    const check = await apiService.checkGeography(
      {
        dataset,
        year,
        geographyLevel: input.geography_level,
        geographyFips: input.geography_fips,
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
          ? 'add parent_fips (census_resolve_geography returns it as state_fips)'
          : parent === 'county'
            ? 'add county_fips (census_resolve_geography returns it as county_fips)'
            : check.wildcardRelaxes
              ? `drop the ${parent} scope by setting geography_fips to "*", which returns every ${input.geography_level} under the parents you did supply`
              : `scope the query by ${parent}, which this tool has no input for — call census_list_geographies and pick a level whose only parents are state and county`,
      );
      throw ctx.fail(
        'parent_required',
        `Geography level "${input.geography_level}" in ${dataset} (${year}) must be scoped by ${missing.join(' and ')}.`,
        {
          dataset,
          year,
          geographyLevel: input.geography_level,
          missingParents: missing,
          recovery: { hint: `To query this level, ${steps.join(', and ')}.` },
        },
      );
    }

    if (check.status === 'parent_not_accepted') {
      const inputs = check.unacceptedParents.map((parent) =>
        parent === 'state' ? 'parent_fips' : 'county_fips',
      );
      const scope =
        check.acceptedParents.length > 0
          ? `it sits within ${check.acceptedParents.join(' and ')} only`
          : 'it sits within no parent geography';
      throw ctx.fail(
        'parent_not_accepted',
        `Geography level "${input.geography_level}" in ${dataset} (${year}) does not accept ${check.unacceptedParents.join(' or ')} as a parent.`,
        {
          dataset,
          year,
          geographyLevel: input.geography_level,
          unacceptedParents: check.unacceptedParents,
          acceptedParents: check.acceptedParents,
          recovery: {
            hint: `Drop ${inputs.join(' and ')} — ${scope}, so the query needs no other scope. Call census_list_geographies to see the parents each level takes.`,
          },
        },
      );
    }

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
    const defaultLabelColumns = defaultLabelColumnsFor(unfiltered);

    // A dataset that publishes several records per geography answers with one row each. Requesting
    // the columns that separate them is what makes a row attributable to a record rather than one
    // of two identical-looking answers; it does not change which rows come back.
    const recordDimensions = await variableCacheService.getRecordDimensions(dataset, year, ctx);
    const recordColumns = recordLabelColumnsFor(recordDimensions);

    // Fetch variable labels for enrichment (best-effort — don't fail if cache is cold)
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
        geographyFips: input.geography_fips,
        ...(parentFips !== undefined && { parentFips }),
        ...(countyFips !== undefined && { countyFips }),
        ...(Object.keys(predicates).length > 0 && { predicates }),
        ...(Object.keys(defaultLabelColumns).length > 0 && { defaultLabelColumns }),
        ...(Object.keys(recordColumns).length > 0 && { recordColumns }),
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
        ? `${predicateHint} Otherwise confirm the FIPS codes with census_resolve_geography.`
        : dataset.startsWith('acs/acs1')
          ? `ACS1 only covers geographies with 65,000+ population — switch to dataset "acs/acs5" for smaller geographies, or confirm the FIPS codes with census_resolve_geography.`
          : `Confirm the FIPS codes exist in ${dataset} (${year}) — census_resolve_geography returns them for a place name. The Census API matches geography_fips literally at the width of its level, so a short code finds nothing: a county is "051", not "51". If the level itself is in doubt, call census_list_geographies.`;
      throw ctx.fail(
        'no_data',
        `No data returned for ${input.geography_level} in ${dataset} (${year}).`,
        {
          dataset,
          year,
          geographyLevel: input.geography_level,
          recovery: { hint },
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
          value?: string;
        }
      > = {};

      for (const [code, val] of Object.entries(row.variables)) {
        enrichedVariables[code] = {
          estimate: val.estimate,
          ...(val.moe !== undefined && { moe: val.moe }),
          label: variableLabels.get(code) ?? val.label,
          suppressed: val.suppressed,
          ...(val.suppressionReason && { suppression_reason: val.suppressionReason }),
          ...(val.value !== undefined && { value: val.value }),
        };
      }

      return {
        geography_name: row.geographyName,
        geography_fips: row.geographyFips,
        geography_geoid: row.geographyGeoid,
        variables: enrichedVariables,
        ...(row.appliedFilters && { applied_filters: row.appliedFilters }),
        ...(row.record && { record: row.record }),
      };
    });

    ctx.enrich({ totalRows: enrichedRows.length, dataset, year });

    const notices: string[] = [];
    if (unfiltered.length > 0) {
      // The API applies the same default to every row, so the first one names them all.
      notices.push(
        describeUnsetPredicates(unfiltered, dataset, year, rows[0]?.appliedFilters ?? {}),
      );
    }
    // Several rows for one geography are several records, not several geographies. Reading one of
    // them as the answer is wrong, so the response has to say a choice is being made.
    const perGeography = new Map<string, number>();
    for (const row of rows) {
      perGeography.set(row.geographyGeoid, (perGeography.get(row.geographyGeoid) ?? 0) + 1);
    }
    const maxRowsPerGeography = Math.max(...perGeography.values());
    if (maxRowsPerGeography > 1) {
      notices.push(
        describeRecordRows(dataset, year, maxRowsPerGeography, observeRecordValues(rows)),
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return { rows: enrichedRows };
  },

  format: (result) => {
    const lines: string[] = [`## Census Data`, `**${result.rows.length} geography rows**\n`];

    for (const row of result.rows) {
      const record = Object.entries(row.record ?? {}) as Array<
        [string, { code: string; label: string }]
      >;
      // Without the record on the heading, two rows for one geography render as the same heading
      // twice with different numbers under it.
      const recordSuffix =
        record.length > 0
          ? ` — ${record.map(([code, value]) => `${code} ${value.code} (${value.label})`).join(' · ')}`
          : '';
      lines.push(`### ${row.geography_name}${recordSuffix}`);
      lines.push(`**FIPS:** \`${row.geography_fips}\` · **GEOID:** \`${row.geography_geoid}\``);
      for (const [code, rawVal] of Object.entries(row.variables)) {
        const val = rawVal as {
          estimate: number | null;
          moe?: number | null;
          label: string;
          suppressed: boolean;
          suppression_reason?: string;
          value?: string;
        };
        if (val.suppressed) {
          lines.push(
            `- **${code}:** Suppressed${val.suppression_reason ? ` (${val.suppression_reason})` : ''}`,
          );
        } else if (val.value !== undefined) {
          lines.push(`- **${code}:** ${val.value}`);
        } else {
          const moePart = val.moe != null ? ` ± ${val.moe.toLocaleString()}` : '';
          lines.push(`- **${code}:** ${val.estimate?.toLocaleString() ?? 'N/A'}${moePart}`);
        }
        if (val.label && val.label !== code) {
          lines.push(`  *${val.label}*`);
        }
      }
      const applied = Object.entries(row.applied_filters ?? {});
      if (applied.length > 0) {
        lines.push(
          `**Applied filter defaults:** ${applied.map(([code, label]) => `${code} = ${String(label)}`).join(' · ')}`,
        );
      }
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
