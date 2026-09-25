/**
 * @fileoverview Tool to query a Census dataset for variables at a specific geography.
 * @module mcp-server/tools/definitions/census-query-data
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { getDiscoveryConfig } from '@/config/server-config.js';
import {
  renderVariable,
  toVariableEntry,
  type VariableEntry,
} from '@/mcp-server/tools/variable-entry.js';
import {
  describeColumnBudget,
  describeColumnLimit,
  getCensusApiService,
  normalizePredicates,
  normalizeVariableCodes,
  observeRecordValues,
  padFips,
  planQueryColumns,
} from '@/services/census-api/census-api-service.js';
import type { CensusDataRow, SuppliedParent } from '@/services/census-api/types.js';
import {
  DATASET_LATEST_YEARS,
  defaultLabelColumnsFor,
  describeEmptyPredicatedResult,
  describeRecordRows,
  describeUnsetPredicates,
  flagColumnsFor,
  getVariableCacheService,
  KNOWN_DATASETS,
  recordLabelColumnsFor,
  wildcardColumnsFor,
} from '@/services/variable-cache/variable-cache-service.js';

/** Most rows one call can return — the `limit` input's maximum. */
const MAX_LIMIT = 500;

/** The input that supplies each parent a query can be scoped by. */
const SCOPE_INPUTS = {
  state: 'parent_fips',
  county: 'county_fips',
  tract: 'tract_fips',
} as const satisfies Record<SuppliedParent, string>;

/**
 * Put rows in the order pages are cut from: GEOID, then the code of each record column in column
 * name order. The Census documents no row order, and the category order within one geography has
 * changed between identical requests, so an order that kept the upstream sequence inside a
 * geography could repeat one row and skip another across two pages — each page is its own request.
 */
function pageOrder(rows: CensusDataRow[]): CensusDataRow[] {
  const keyed = rows.map((row) => ({
    row,
    key: [
      row.geographyGeoid,
      ...Object.keys(row.record ?? {})
        .sort()
        .map((column) => row.record?.[column]?.code ?? ''),
    ],
  }));
  keyed.sort((a, b) => {
    for (let i = 0; i < Math.max(a.key.length, b.key.length); i++) {
      const x = a.key[i] ?? '';
      const y = b.key[i] ?? '';
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  });
  return keyed.map(({ row }) => row);
}

/**
 * Word which rows a page holds when offset or limit left some out, and how to reach the rest. The
 * order is GEOID order, so the first rows are the lowest codes rather than the largest or a sample.
 * Only the ways that apply are offered: `openScopes` names the scope inputs the query left spanning
 * everything, and `rankable` is false for a `"*"` breakdown, which a ranking cannot hold.
 */
function describePage(page: {
  offset: number;
  limit: number;
  shown: number;
  total: number;
  openScopes: string[];
  rankable: boolean;
}): string {
  const n = (value: number) => value.toLocaleString('en-US');
  const { offset, limit, shown, total } = page;
  if (shown === 0) {
    const lastPage = Math.max(total - limit, 0);
    return `offset ${n(offset)} is past the last of the ${n(total)} rows this query matched, so no rows are returned. Pass an offset below ${n(total)} — offset: ${lastPage} returns the last ${n(Math.min(limit, total))}.`;
  }
  const end = offset + shown;
  const range = `Rows ${n(offset + 1)}–${n(end)} of ${n(total)}, in GEOID order — not a ranking or a sample.`;
  if (end >= total) {
    return `${range} This is the last page; offset: 0 starts from the first row.`;
  }
  const ways = [
    `call again with offset: ${end} for the next page`,
    ...(limit < MAX_LIMIT ? [`raise limit (max ${MAX_LIMIT})`] : []),
    ...(page.openScopes.length > 0
      ? [`narrow the scope with ${page.openScopes.join(' or ')}`]
      : []),
    ...(page.rankable ? ['use census_compare_geographies to rank rather than list'] : []),
  ];
  const options = ways.length > 1 ? `${ways.slice(0, -1).join(', ')}, or ${ways.at(-1)}` : ways[0];
  return `${range} To see more, ${options}.`;
}

export const censusQueryData = tool('census_query_data', {
  title: 'Query Census Data',
  description:
    'Query a Census dataset for one or more variables at a specific geography. Accepts FIPS codes for the target geography — use census_resolve_geography to convert place names to FIPS when needed. On ACS datasets, labeled estimates and margin-of-error values are returned together, and the negative sentinel values the Census writes for an estimate or margin of error it cannot publish are decoded into the meanings the Census gives them rather than passed through as raw numbers. A value cbp, ecnbasic, or nonemp withheld is stored as 0 beside a flag, and is reported as withheld, with the meaning of its flag, rather than as a zero. Pass geography_fips as "*" for every geography at the level within the parent: rows come back in GEOID order, up to limit per call (default 50, max 500), with totalCount giving how many matched and offset reaching the rest — the order is not a ranking, so use census_compare_geographies to rank. On the business datasets (cbp, ecnbasic, nonemp), pep/charv, and dec/ddhca, use predicates to filter by industry, size class, or population group — a query that omits one is answered with a default the Census API picks, which is an all-categories total on some dimensions and a single category on others. Each row names the defaults that were applied in applied_filters, and census_list_predicate_values enumerates the codes a dimension accepts. One geography can also come back on more than one row: pep/charv publishes an April estimates base alongside its July estimate, and each row carries a record field saying which it is.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    variables: z
      .array(z.string())
      .describe(
        'Variable codes to retrieve (e.g., ["B19013_001E", "B19013_001M"]). Codes are uppercased before the request, so "b19013_001e" reads as B19013_001E and the response is keyed by the uppercase code. At most 49 per call: the Census API accepts 50 columns per request and every query also sends NAME. On datasets where a label column is added for each filter dimension left unset, or record columns are added (cbp, ecnbasic, nonemp, pep/charv, dec/ddhca), the maximum is lower, and too_many_variables states the exact number for the query. Use census_search_variables to find codes. On ACS datasets only, each estimate has a margin-of-error counterpart at the same code with the E suffix swapped for M — request both to get the margin alongside the estimate. Other dataset families (pep, dec, cbp, ecnbasic, nonemp) publish no margins of error, and an E-final code there is an ordinary code with no M sibling. A code can also name a text column rather than a measure — GEO_ID, on every dataset, is the nationally unique geography identifier and comes back under value with estimate null, which is the code to request when a stable join key is what is wanted.',
      ),
    geography_level: z
      .string()
      .describe(
        'Level of the target geography (e.g., "county", "tract", "state", "zip code tabulation area"). Use census_list_geographies to see valid values for the dataset.',
      ),
    geography_fips: z
      .string()
      .describe(
        'FIPS code for the target geography (e.g., "033" for a county, "*" for every geography at the level within the parent, returned up to limit rows per call and paged with offset). Use census_resolve_geography to obtain this value — it is returned as fips_summary. The Census API matches this literally and its width follows geography_level, so it is passed through unpadded: a county is 3 digits ("051", not "51") and a tract is 6. parent_fips and county_fips are zero-padded for you; this one is not.',
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
    tract_fips: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(/^\d{6}$/)
          .describe('Exactly 6 digits — never padded here, and never "*".'),
      ])
      .optional()
      .describe(
        'Census tract code scoping the query to one tract (e.g., "007101" for Census Tract 71.01), for the levels that sit within a tract — block group on acs/acs5, block group and block on dec/pl. census_resolve_geography returns it as tract_fips, and for a street address also returns the block_group_fips to pass as geography_fips. A tract code is unique only within its county, so it needs parent_fips and a concrete county_fips (not "*"). It is exactly 6 digits and is not padded, since "7101" and "71" do not name one tract. A level that does not sit within a tract rejects it. Blank is treated as omitted.',
      ),
    predicates: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Filter values keyed by variable code, sent as extra query parameters — e.g. {"NAICS2017": "5112"} to count only software publishers in cbp. The business datasets (cbp, ecnbasic, nonemp), pep/charv, and dec/ddhca declare filter dimensions such as industry (NAICS2017/NAICS2022), legal form (LFO), size class (EMPSZES/RCPSZES), tax status (TAXSTAT), operation type (TYPOP), sex (SEX), age (AGE), and population group (POPGROUP). Leaving one unset is not an error: the Census API substitutes its own default, which is the all-categories total on cbp NAICS2017 but a single population group on dec/ddhca POPGROUP and a single sector on ecnbasic NAICS2022 — so an unfiltered value can read like a total without being one. Every unset dimension is named in the response notice and its applied default is echoed per row in applied_filters. Keys are matched case-insensitively, and a blank value is treated as omitted. A value of "*" returns one row per category of that dimension for each geography, each row labelled with its category in record (e.g. {"NAICS2017": "*"} gives King County one row per industry) — a breakdown that can run to over a thousand rows. Code names vary by dataset and vintage — cbp 2023 uses NAICS2017 while nonemp 2023 uses NAICS2022 — so read them from the notice or from census_search_variables. Call census_list_predicate_values for the codes a dimension accepts; NAICS values are standard North American Industry Classification System codes at any depth (51 information, 5112 software publishers).',
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
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe(
        'Most rows to return (default: 50, max: 500). Rows come in GEOID order, a geography\'s records or categories in code order, and each one counts, so a geography returned as several records (pep/charv April and July) or as one row per category of a "*" predicate takes one row each. totalCount says how many rows matched.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Rows to skip before returning up to limit (default: 0). Pages run in GEOID order, so offset 50 with limit 50 returns rows 51–100, and the notice names the offset of the next page. An offset at or past totalCount returns no rows.',
      ),
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
                'Map of variable code to value entry. Each key is a variable code from the variables input, uppercased; each value has: estimate (number|null), moe (number|null, optional), label (string), suppressed (boolean), suppression_reason (string, optional), open_ended (true, optional), flag ({code, meaning}, optional), value (string, optional). An estimate of null means one of three things and the other fields say which: suppressed true is a number the Census withheld, a value field is a cell holding text rather than a number (GEO_ID returns "0500000US53033"; the older ACS profile vintages write not-applicable as "(X)" in a column that is a number elsewhere), and neither is a cell with nothing in it. suppression_reason carries the meaning the Census publishes for the sentinel or flag. On ACS, a margin of error the Census treats as zero (a controlled estimate) is moe 0, not a suppression. open_ended true marks an ACS median that falls in the lowest or highest interval of an open-ended distribution, so the estimate is that interval\'s boundary (250001 for "250,000+", 9999 for "10,000-") rather than the median itself — it appears only when the matching M code was requested, since that margin of error is the only signal, and it does not say which end. flag is the symbol a business dataset (cbp, ecnbasic, nonemp) published beside the value: a withholding flag (D, S, an employment or sales range letter) comes with suppressed true, and so does a noise or data-quality band (G/H/J, 0-9) beside a 0, which is the range a range column such as EMP_N or RCPTOT_IMP publishes in place of a number; a quality note (r revised, s high relative standard error) keeps the estimate.',
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
                'Which record this row is, when one geography comes back on more than one row — keyed by the column that separates them, each value carrying a code and a label (e.g. {"MONTH": {"code": "7", "label": "July"}}). pep/charv publishes an April estimates base and a July estimate, so one geography comes back on two rows whose numbers differ; this field is what says which is which. A dimension set to "*" in predicates lands here too, one row per category (e.g. {"NAICS2017": {"code": "11", "label": "Agriculture, forestry, fishing and hunting"}}), with the code as its label when the dimension publishes no label column. Pass the code back in predicates (e.g. {"MONTH": "7"}) to return that record alone. Absent on the datasets that return one row per geography.',
              ),
          })
          .describe('Data for one geography — name, FIPS, and variable values.'),
      )
      .describe(
        'One row per geography, or per record or category where a geography has several. When geography_fips is "*", the rows from offset up to limit of every geography at the level within the parent, in GEOID order.',
      ),
  }),

  enrichment: {
    totalRows: z.number().describe('Number of rows returned.'),
    totalCount: z
      .number()
      .describe('Number of rows the query matched, before offset and limit were applied.'),
    truncated: z
      .boolean()
      .describe(
        'True when rows were left out by offset or limit — totalCount exceeds the rows returned.',
      ),
    dataset: z.string().describe('Dataset queried.'),
    year: z.number().describe('Vintage year queried.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Warning that the dataset declares filter dimensions the query left unset, naming each one alongside the label of the default the Census API applied to it. That default is an all-categories total on some dimensions and one ordinary category on others, so the label is what says which. Also carries the warning that a geography came back on more than one row, naming the column that separates the records and the values it took; the range of rows returned when offset or limit left some out, with the offset of the next page; and any variable codes whose flags could not be checked because the request had no room left under the Census 50-column limit — a withheld value there reads as 0.',
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
      thrownBy: 'service',
      recovery:
        'Set the CENSUS_API_KEY environment variable and restart the server. Register a free key at api.census.gov/data/key_signup.html.',
    },
    {
      reason: 'year_not_available',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The dataset does not serve the requested vintage year.',
      thrownBy: 'service',
      recovery:
        'Retry with a year from available_years in census_list_datasets; the error names the years this dataset serves.',
    },
    {
      reason: 'variable_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The Census API rejected a variable code as unknown for the requested dataset and year. It names only the first unknown code in a request.',
      thrownBy: 'service',
      recovery:
        'Call census_search_variables or census_get_variable to confirm codes for this dataset and year.',
    },
    {
      reason: 'variables_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The variable metadata endpoint returned an unparseable response for this dataset and year.',
      retryable: true,
      thrownBy: 'service',
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
      when: 'The geography level requires a parent FIPS code but parent_fips was not provided, a tract/block-group level requires county_fips but it was omitted, a single block group requires tract_fips, or tract_fips was set without a concrete county_fips.',
      recovery:
        'Add parent_fips (state FIPS) from census_resolve_geography state_fips. For tract or block-group levels also add county_fips from census_resolve_geography county_fips, and for a single block group add tract_fips.',
    },
    {
      reason: 'parent_not_accepted',
      code: JsonRpcErrorCode.ValidationError,
      when: 'parent_fips, county_fips, or tract_fips names a parent the geography level does not sit within.',
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
      when: 'The variable codes plus NAME and the label and record columns added for the dataset exceed the 50 columns the Census API accepts per request.',
      recovery:
        'Split the codes across several calls of at most the maximum the error states — 49 on ACS, fewer where label or record columns are added.',
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
      thrownBy: 'service',
      recovery:
        'Retry the request; if the error persists, the Census API may be temporarily unavailable.',
    },
  ],

  async handler(input, ctx) {
    const variables = normalizeVariableCodes(input.variables);
    if (variables.length === 0) {
      throw validationError(
        'At least one variable code is required. Use census_search_variables to find codes.',
        { variableCount: 0 },
      );
    }

    const dataset = input.dataset?.trim() || 'acs/acs5';
    if (!KNOWN_DATASETS.has(dataset)) {
      throw ctx.fail(
        'dataset_not_found',
        `Unknown dataset: "${dataset}". Call census_list_datasets to discover valid dataset codes.`,
        { dataset, ...ctx.recoveryFor('dataset_not_found') },
      );
    }
    const { defaultYear } = getDiscoveryConfig();
    const year = input.year ?? DATASET_LATEST_YEARS[dataset] ?? defaultYear;

    const variableCacheService = getVariableCacheService();
    // Ahead of the geography check, which is the first request this handler makes. A vintage the
    // dataset does not serve has no geography metadata either, so leaving the check downstream
    // spends a round trip and reports the wrong problem for a year that is simply wrong.
    variableCacheService.validateYear(dataset, year);

    ctx.log.info('Querying Census data', {
      variables,
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
    // A tract has no fixed-width shorthand to pad from — "7101" and "71" are both Tract 71.01 as a
    // person writes it — so the schema takes exactly 6 digits and only a blank is read here.
    const tractFips = input.tract_fips || undefined;

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
        ...(tractFips !== undefined && { tractFips }),
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
      const stepFor = (parent: string) => {
        if (parent === 'state') {
          // The resolver's ZCTA layer has no STATE, so it cannot supply this parent.
          return input.geography_level === 'zip code tabulation area'
            ? "add parent_fips set to the 2-digit FIPS of the ZCTA's state — census_resolve_geography returns no state_fips for a ZCTA, so resolve the state's name for it"
            : 'add parent_fips (census_resolve_geography returns it as state_fips)';
        }
        if (parent === 'county') {
          // A tract code repeats across counties, so a tract scope needs the one it sits in.
          return countyFips === '*'
            ? 'set county_fips to the 3-digit county the tract sits in instead of "*" (census_resolve_geography returns it as county_fips)'
            : 'add county_fips (census_resolve_geography returns it as county_fips)';
        }
        if (parent === 'tract') {
          return 'add tract_fips (census_resolve_geography returns it as tract_fips, and for a street address also returns the block group as block_group_fips)';
        }
        return check.wildcardRelaxes
          ? `drop the ${parent} scope by setting geography_fips to "*", which returns every ${input.geography_level} under the parents you did supply`
          : `scope the query by ${parent}, which this tool has no input for — call census_list_geographies and pick a level whose only parents are state, county, and tract`;
      };
      const steps = missing.map(stepFor);
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
      const inputs = check.unacceptedParents.map((parent) => SCOPE_INPUTS[parent]);
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
    const { predicates, wildcards } = normalizePredicates(input.predicates);
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

    // Labels, flag columns, and wildcard label columns all come from the same metadata. A code
    // with no entry just has none of them — the data API accepts columns variables.json lists only
    // inside another entry's attributes, and it is the authority on which codes exist.
    const metadata = await variableCacheService.lookupVariables(
      [...variables, ...wildcards],
      dataset,
      year,
      ctx,
    );

    // Count every column the request will send against the Census API's 50-column limit before
    // spending it. Label columns for "*" dimensions and flag columns are fitted into what is left.
    const plan = planQueryColumns({
      variables,
      defaultLabelColumns,
      recordColumns,
      wildcardColumns: wildcardColumnsFor(wildcards, recordColumns, metadata),
      flagColumns: flagColumnsFor(variables, metadata),
    });
    if (plan.status === 'over_limit') {
      throw ctx.fail('too_many_variables', describeColumnLimit(variables.length, plan), {
        requested: variables.length,
        maxVariables: plan.maxVariables,
        addedColumns: plan.addedColumns,
        recovery: {
          hint: `Split the codes across calls of at most ${plan.maxVariables} each.`,
        },
      });
    }

    const rows = await apiService.queryData(
      {
        variables,
        geographyLevel: input.geography_level,
        geographyFips: input.geography_fips,
        ...(parentFips !== undefined && { parentFips }),
        ...(countyFips !== undefined && { countyFips }),
        ...(tractFips !== undefined && { tractFips }),
        ...(Object.keys(predicates).length > 0 && { predicates }),
        ...(Object.keys(defaultLabelColumns).length > 0 && { defaultLabelColumns }),
        ...(Object.keys(recordColumns).length > 0 && { recordColumns }),
        ...(plan.wildcardColumns.length > 0 && { wildcardColumns: plan.wildcardColumns }),
        ...(Object.keys(plan.flagColumns).length > 0 && { flagColumns: plan.flagColumns }),
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

    const ordered = pageOrder(rows);
    const limit = input.limit ?? 50;
    const offset = input.offset ?? 0;
    const page = ordered.slice(offset, offset + limit);
    const truncated = page.length < ordered.length;

    const enrichedRows = page.map((row) => {
      const enrichedVariables: Record<string, VariableEntry> = {};
      for (const [code, val] of Object.entries(row.variables)) {
        enrichedVariables[code] = toVariableEntry(val, metadata.get(code)?.label ?? val.label);
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

    ctx.enrich({
      totalRows: enrichedRows.length,
      totalCount: ordered.length,
      truncated,
      dataset,
      year,
    });

    // One notice field, written once: every warning below describes the same response.
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
        describeRecordRows(
          dataset,
          year,
          maxRowsPerGeography,
          observeRecordValues(rows),
          wildcards,
        ),
      );
    }
    if (truncated) {
      // A scope input narrows only when the level takes that parent and the query left it open.
      // Without geography metadata nothing is known about the parents, so none is suggested. A
      // tract sits inside one county, so it is offered only once the county is concrete — with
      // the county open, narrowing to one is the step that comes first.
      const accepted = check.acceptedParents ?? [];
      const open = (fips: string | undefined) => fips === undefined || fips === '*';
      const openScopes = [
        ...(accepted.includes('state') && open(parentFips) ? ['parent_fips'] : []),
        ...(accepted.includes('county') && open(countyFips) ? ['county_fips'] : []),
        ...(accepted.includes('tract') && !open(countyFips) && tractFips === undefined
          ? ['tract_fips']
          : []),
      ];
      notices.push(
        describePage({
          offset,
          limit,
          shown: page.length,
          total: ordered.length,
          openScopes,
          rankable: wildcards.length === 0,
        }),
      );
    }
    const budget = describeColumnBudget(plan);
    if (budget) notices.push(budget);
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return { rows: enrichedRows };
  },

  format: (result) => {
    const count = result.rows.length;
    const lines: string[] = [
      `## Census Data`,
      `**${count} geography ${count === 1 ? 'row' : 'rows'}**\n`,
    ];

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
      for (const [code, entry] of Object.entries(row.variables)) {
        lines.push(...renderVariable(code, entry as VariableEntry));
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
