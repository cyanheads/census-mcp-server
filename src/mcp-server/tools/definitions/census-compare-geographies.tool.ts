/**
 * @fileoverview Tool to compare variables across multiple geographies at the same level.
 * @module mcp-server/tools/definitions/census-compare-geographies
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
import {
  DATASET_LATEST_YEARS,
  defaultLabelColumnsFor,
  describeAmbiguousRows,
  describeEmptyPredicatedResult,
  describeUnsetPredicates,
  flagColumnsFor,
  getVariableCacheService,
  KNOWN_DATASETS,
  recordLabelColumnsFor,
  wildcardColumnsFor,
} from '@/services/variable-cache/variable-cache-service.js';

export const censusCompareGeographies = tool('census_compare_geographies', {
  title: 'Compare Census Geographies',
  description:
    'Compare one or more variables across multiple geographies at the same level — all counties in a state, all states nationally, or a named set of specific geographies — ranked on the value of one of them. Covers queries like "compare median income across WA counties" or "which states have the most people below the poverty line." A count ranks geographies by size, not by rate, so to rank a rate, rank a published percentage: S1701_C03_001E (percent below the poverty level, dataset acs/acs5/subject), DP03_0128PE (the same percentage, acs/acs5/profile), or DP04_0047PE (percent of occupied housing units that are renter-occupied, acs/acs5/profile). Profile and subject tables reach tracts but not block groups. Omit within to compare all geographies nationally at the level. Suppressed values are decoded to human-readable labels rather than passed through as raw negative sentinels. On the business datasets (cbp, ecnbasic, nonemp), pep/charv, and dec/ddhca, use predicates to rank within one industry, size class, or population group — a comparison that omits one ranks on a default the Census API picks, which is an all-categories total on some dimensions and a single category on others. Each row names the defaults that were applied in applied_filters, and census_list_predicate_values enumerates the codes a dimension accepts. A dataset that publishes several records per geography cannot be ranked until one is pinned: pep/charv publishes an April estimates base and a July estimate, so a comparison that pins neither fails with ambiguous_rows rather than giving every geography two ranks — pass predicates {"MONTH": "7"} for the July estimate.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    variables: z
      .array(z.string())
      .describe(
        'Variable codes to compare (e.g., ["B19013_001E", "B19013_001M"]); the ranking is on one of them, set by sort_by. Codes are uppercased before the request, and each row is keyed by the uppercase code. At most 49 per call: the Census API accepts 50 columns per request and every query also sends NAME. On datasets where a label column is added for each filter dimension left unset, or record columns are added (cbp, ecnbasic, nonemp, pep/charv, dec/ddhca), the maximum is lower, and too_many_variables states the exact number for the comparison. On ACS datasets, add the margin-of-error counterpart of a code (same code, E suffix swapped for M) for reliability context. Other dataset families (pep, dec, cbp, ecnbasic, nonemp) publish no margins of error.',
      ),
    geography_level: z
      .string()
      .describe(
        'The level to compare across (e.g., "state", "county", "tract"). Use census_list_geographies to see valid values for the dataset.',
      ),
    within: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(/^(\*|\d{1,2})$/)
          .describe('1 to 2 digits, zero-padded here to the 2 the Census stores, or "*".'),
      ])
      .optional()
      .describe(
        'State FIPS to constrain results (e.g., "53" to compare counties or tracts within WA only). Omit to compare all geographies at the level nationally. Use census_resolve_geography to get state_fips. Pass "*" to span every state. Blank is treated as omitted.',
      ),
    within_county: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(/^(\*|\d{1,3})$/)
          .describe('1 to 3 digits, zero-padded here to the 3 the Census stores, or "*".'),
      ])
      .optional()
      .describe(
        'County FIPS to constrain tract or block-group comparisons to a single county within the state specified by within (e.g., "033" for King County). Required when geography_level is "tract" or "block group" and you want county-scoped results. census_resolve_geography returns this as county_fips. Pass "*" to span every county in the state, which is the only way a block-group comparison reaches a whole state. Blank is treated as omitted.',
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
        'Filter values keyed by variable code, applied to every geography in the comparison — e.g. {"NAICS2017": "5112"} to rank counties by their software-publisher establishment count in cbp. The business datasets (cbp, ecnbasic, nonemp), pep/charv, and dec/ddhca declare filter dimensions such as industry (NAICS2017/NAICS2022), legal form (LFO), size class (EMPSZES/RCPSZES), tax status (TAXSTAT), operation type (TYPOP), sex (SEX), age (AGE), and population group (POPGROUP). Leaving one unset is not an error: the Census API substitutes its own default, which is the all-categories total on cbp NAICS2017 but a single population group on dec/ddhca POPGROUP and a single sector on ecnbasic NAICS2022 — so a ranking can read like an overall one without being it. Every unset dimension is named in the response notice and its applied default is echoed per row in applied_filters. Keys are matched case-insensitively, and a blank value is treated as omitted. A value of "*" returns every geography once per category of that dimension, which a ranking cannot hold, so it fails with ambiguous_rows naming the dimension to pin — use census_query_data for a per-category breakdown. Code names vary by dataset and vintage — cbp 2023 uses NAICS2017 while nonemp 2023 uses NAICS2022 — so read them from the notice or from census_search_variables. Call census_list_predicate_values for the codes a dimension accepts; NAICS values are standard North American Industry Classification System codes at any depth (51 information, 5112 software publishers).',
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
        "Variable code to rank on (default: the first code in variables), uppercased like the variables. Must be one of the requested codes, or the call fails with sort_by_not_requested. Geographies rank on that code's own value, so a count ranks by size and only a published percentage such as S1701_C03_001E or DP03_0128PE ranks by rate.",
      ),
    sort_dir: z
      .enum(['asc', 'desc'])
      .optional()
      .describe('Sort direction (default: "desc" — highest value first).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe(
        'Maximum geographies to return (default: 50, max: 500). When results are truncated, totalCount says how many matched.',
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
                'Map of variable code to value entry. Each key is a variable code from the variables input, uppercased; each value has: estimate (number|null), moe (number|null, optional), label (string), suppressed (boolean), suppression_reason (string, optional), open_ended (true, optional), flag ({code, meaning}, optional), value (string, optional). An estimate of null means one of three things and the other fields say which: suppressed true is a number the Census withheld, a value field is a cell holding text rather than a number (GEO_ID returns "0500000US53033"; the older ACS profile vintages write not-applicable as "(X)" in a column that is a number elsewhere), and neither is a cell with nothing in it. suppression_reason carries the meaning the Census publishes for the sentinel or flag, and a suppressed value ranks after every number in either sort direction. On ACS, a margin of error the Census treats as zero (a controlled estimate) is moe 0. open_ended true marks an ACS median that falls in the lowest or highest interval of an open-ended distribution, so the estimate is that interval\'s boundary (250001 for "250,000+") — it ranks by that figure, so geographies sharing it are tied, and it appears only when the matching M code was requested. flag is the symbol a business dataset (cbp, ecnbasic, nonemp) published beside the value: a withholding flag comes with suppressed true, and so does a noise or data-quality band beside a 0, which is the range a range column such as EMP_N or RCPTOT_IMP publishes in place of a number; a quality note keeps the estimate. Text has no ordering, so sorting on a column of it leaves every row tied and ranked in the order the Census returned them, and the notice says so.',
              ),
            applied_filters: z
              .object({})
              .passthrough()
              .optional()
              .describe(
                'Filter dimensions the comparison left unset, mapped to the label of the default the Census API applied (e.g. {"POPGROUP": "European alone"}). Present only on datasets that declare filter dimensions. The label is what tells an all-categories total apart from one ordinary category, so a ranking whose rows carry "European alone" ranks that group rather than total population. Set the dimension in predicates to choose it yourself.',
              ),
            record: z
              .object({})
              .passthrough()
              .optional()
              .describe(
                'Which record the ranking is over, for a dataset that publishes more than one per geography — keyed by the column that separates them, each value carrying a code and a label (e.g. {"MONTH": {"code": "7", "label": "July"}}). Present on every row whenever the dataset publishes such a column, whether predicates pinned it or another predicate narrowed the result to one record per geography. A comparison that would put each geography on several rows fails with ambiguous_rows instead of ranking it, so a ranking that returned at all is a ranking of the single record named here. Absent on the datasets that publish one record per geography.',
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
    sortVariable: z
      .string()
      .describe('Variable code the rows are ranked on, uppercased as it appears in variables.'),
    dataset: z.string().describe('Dataset queried.'),
    year: z.number().describe('Vintage year queried.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when results were truncated, when the sort column holds no number on any row (so the rows are in the order the Census returned them rather than ranked), when geographies entries matched no row, when a bare level code matched more than one state, or when the dataset declares filter dimensions the comparison left unset — how to narrow scope, raise the limit, correct the FIPS codes, or add the predicates that pin what the ranking covers. For an unset dimension it also quotes the label of the default the Census API applied, which is what says whether the ranking is on a total or on one category. Also names any variable codes whose flags could not be checked because the request had no room left under the Census 50-column limit — a withheld value there reads as 0 and ranks as one.',
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
      reason: 'parent_not_accepted',
      code: JsonRpcErrorCode.ValidationError,
      when: 'within or within_county names a parent the geography level does not sit within.',
      recovery:
        'Drop the parent this level does not name. Levels such as urban area, zip code tabulation area, and metropolitan statistical area/micropolitan statistical area are compared nationally with no scope at all; census_list_geographies shows the parents each level takes.',
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
      when: 'The Census API rejected a variable code as unknown for this dataset and year. It names only the first unknown code in a request.',
      thrownBy: 'service',
      recovery:
        'Use census_search_variables or census_get_variable to confirm codes for this dataset and year.',
    },
    {
      reason: 'too_many_variables',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The variable codes plus NAME and the label and record columns added for the dataset exceed the 50 columns the Census API accepts per request.',
      recovery:
        'Split the codes across several comparisons of at most the maximum the error states — 49 on ACS, fewer where label or record columns are added.',
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
      reason: 'predicate_not_supported',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A key in predicates is not a variable in this dataset and year.',
      recovery:
        'Remove the unrecognized key. Call census_search_variables on this dataset and year for the codes it does define — predicate names are vintage-specific, so NAICS2017 and NAICS2022 belong to different years.',
    },
    {
      reason: 'sort_by_not_requested',
      code: JsonRpcErrorCode.ValidationError,
      when: 'sort_by names a code that is not among the requested variables, so no column exists to rank on.',
      recovery:
        'Set sort_by to one of the codes in variables, or add that code to variables and rank on it.',
    },
    {
      reason: 'ambiguous_rows',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The dataset publishes several records per geography and the comparison pinned none of them, so every geography would occupy several ranks with different values.',
      recovery:
        'Add the record column named in the error to predicates to pin one record — on pep/charv that is MONTH, where "7" selects the July estimate and "4" the April estimates base. census_query_data returns every record for a single geography if you need to see them first.',
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
      throw ctx.fail('dataset_not_found', `Unknown dataset: "${dataset}"`, {
        dataset,
        ...ctx.recoveryFor('dataset_not_found'),
      });
    }
    const { defaultYear } = getDiscoveryConfig();
    const year = input.year ?? DATASET_LATEST_YEARS[dataset] ?? defaultYear;
    const limit = input.limit ?? 50;
    const sortDir = input.sort_dir ?? 'desc';
    // Rows are keyed by the uppercase code, so a sort key left in the caller's casing would
    // match nothing and leave every row tied.
    const sortBy = input.sort_by?.trim().toUpperCase() || (variables[0] as string);
    // A sort key that names no requested column leaves every row tied, and the Census return order
    // would come back labelled as a ranking. Only the input is needed to tell, so no request is spent.
    if (!variables.includes(sortBy)) {
      throw ctx.fail(
        'sort_by_not_requested',
        `sort_by "${sortBy}" is not one of the requested variables (${variables.join(', ')}), so there is nothing to rank on.`,
        { sortBy, variables, ...ctx.recoveryFor('sort_by_not_requested') },
      );
    }

    const variableCacheService = getVariableCacheService();
    // Ahead of the geography check, which is the first request this handler makes. A vintage the
    // dataset does not serve has no geography metadata either, so leaving the check downstream
    // spends a round trip and reports the wrong problem for a year that is simply wrong.
    variableCacheService.validateYear(dataset, year);

    ctx.log.info('Comparing geographies', {
      variables,
      geographyLevel: input.geography_level,
      within: input.within,
      dataset,
      year,
    });

    // Every geography at the level is fetched with a wildcard, then filtered client-side.
    const geographyFips = '*';
    // The Census API matches FIPS literally — `state:5` finds nothing where `state:05` finds
    // Arkansas. Both scopes have a fixed width, so padding is unambiguous. `*` is a scope
    // rather than a code and passes through unpadded.
    const parentFips = padFips(input.within, 2);
    const countyFips = padFips(input.within_county, 3);

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

    if (check.status === 'parent_not_accepted') {
      const inputs = check.unacceptedParents.map((parent) =>
        parent === 'state' ? 'within' : 'within_county',
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
            hint: `Drop ${inputs.join(' and ')} — ${scope}, so the comparison runs unscoped. Call census_list_geographies to see the parents each level takes.`,
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

    // A dataset that publishes several records per geography answers with one row each. The
    // columns that separate them are requested so an ambiguous ranking can name what to pin.
    const recordDimensions = await variableCacheService.getRecordDimensions(dataset, year, ctx);
    const recordColumns = recordLabelColumnsFor(recordDimensions);

    // Labels, flag columns, and wildcard label columns all come from the same metadata. A code
    // with no entry just has none of them — the data API is the authority on which codes exist.
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
          hint: `Split the codes across comparisons of at most ${plan.maxVariables} each.`,
        },
      });
    }

    const rows = await apiService.queryData(
      {
        variables,
        geographyLevel: input.geography_level,
        geographyFips,
        ...(parentFips !== undefined && { parentFips }),
        ...(countyFips !== undefined && { countyFips }),
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

    // A rank is a statement about one geography. When the dataset publishes several records per
    // geography and the query pinned none, every geography occupies several ranks with several
    // different values — a ranking that cannot be read correctly, whatever the rows are labelled
    // with. Refusing it and naming what to pin is the only answer that is not misleading.
    const rowsPerGeography = new Map<string, number>();
    for (const row of rows) {
      rowsPerGeography.set(row.geographyGeoid, (rowsPerGeography.get(row.geographyGeoid) ?? 0) + 1);
    }
    const maxRowsPerGeography = Math.max(...rowsPerGeography.values());
    if (maxRowsPerGeography > 1) {
      const observed = observeRecordValues(rows);
      throw ctx.fail(
        'ambiguous_rows',
        `${dataset} (${year}) returned ${maxRowsPerGeography.toLocaleString('en-US')} rows for each ${input.geography_level}, so a ranking would list every one of them more than once with different values.`,
        {
          dataset,
          year,
          geographyLevel: input.geography_level,
          rowsPerGeography: maxRowsPerGeography,
          recordValues: observed,
          recovery: { hint: describeAmbiguousRows(dataset, year, maxRowsPerGeography, observed) },
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
        rank: idx + 1,
      };
    });

    ctx.enrich({ totalCount, truncated, sortVariable: sortBy, dataset, year });

    const notices: string[] = [];
    // Lead with the unfiltered-dimension warning: it says the ranking answers a different
    // question, which outranks advice about how much of that ranking was shown.
    if (unfiltered.length > 0) {
      // The API applies the same default to every row, so the first one names them all.
      notices.push(
        describeUnsetPredicates(unfiltered, dataset, year, rows[0]?.appliedFilters ?? {}),
      );
    }
    // Text, or a column the Census withheld on every row, has no ordering: every row ties and the
    // ranks are just the order the rows arrived in.
    const ranked = filteredRows.some((row) => typeof row.variables[sortBy]?.estimate === 'number');
    if (!ranked) {
      notices.push(
        `No row carries a number for ${sortBy} — it holds text or was withheld on every row — so the rows are not ranked: rank follows the order the Census returned them. Set sort_by to a numeric code among the variables to rank on it.`,
      );
    }
    if (truncated) {
      // A scope input narrows only when the level takes that parent and the comparison left it
      // open; without geography metadata nothing is known about the parents, so none is offered.
      const accepted = check.acceptedParents ?? [];
      const open = (fips: string | undefined) => fips === undefined || fips === '*';
      const scopes = [
        ...(accepted.includes('state') && open(parentFips) ? ['within'] : []),
        ...(accepted.includes('county') && open(countyFips) ? ['within_county'] : []),
      ];
      const ways = [
        ...(limit < 500 ? ['increase the limit parameter (max 500)'] : []),
        ...(scopes.length > 0 ? [`use ${scopes.join(' or ')} to narrow the scope`] : []),
        ...(ranked ? ['flip sort_dir to see the other end of the ranking'] : []),
      ];
      const hidden = totalCount - sliced.length;
      const options =
        ways.length > 1 ? `${ways.slice(0, -1).join(', ')}, or ${ways.at(-1)}` : ways[0];
      notices.push(
        `Results truncated — ${hidden.toLocaleString('en-US')} more ${hidden === 1 ? 'geography' : 'geographies'} not shown.${options ? ` To see more, ${options}.` : ''}`,
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
    const budget = describeColumnBudget(plan);
    if (budget) notices.push(budget);
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return { rows: resultRows };
  },

  format: (result) => {
    const lines: string[] = [`## Geography Comparison\n`];

    for (const row of result.rows) {
      const record = Object.entries(row.record ?? {}) as Array<
        [string, { code: string; label: string }]
      >;
      // A ranking on a dataset that publishes several records per geography is a ranking of one
      // of them. Without the record on the heading, content[] readers see a bare rank and cannot
      // tell which record the numbers came from.
      const recordSuffix =
        record.length > 0
          ? ` — ${record.map(([code, value]) => `${code} ${value.code} (${value.label})`).join(' · ')}`
          : '';
      lines.push(`### ${row.rank}. ${row.geography_name}${recordSuffix}`);
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
