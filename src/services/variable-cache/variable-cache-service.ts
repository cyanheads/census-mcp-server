/**
 * @fileoverview Census variable cache service. Fetches and caches variables.json per dataset+year
 * with a configurable TTL, then performs client-side keyword search across label and concept
 * fields. Attribute columns and table universes, which variables.json does not carry, are fetched
 * on first lookup and cached with it.
 * @module services/variable-cache/variable-cache-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError, notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, type RequestContext, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getDiscoveryConfig } from '@/config/server-config.js';
import type { WildcardColumn } from '@/services/census-api/census-api-service.js';
import { censusHttpError, yearNotAvailable } from '@/services/census-api/errors.js';
import type {
  CensusVariable,
  PredicateCheck,
  RawGroupsJson,
  RawVariableRecord,
  RawVariablesJson,
  RecordDimension,
  UnsetPredicate,
} from './types.js';
import { rankVariables, type VariableSearchResult } from './variable-search.js';

const CENSUS_API_BASE = 'https://api.census.gov/data';

/**
 * Vintages each dataset can be queried for, and the only place they are written down —
 * `KNOWN_DATASETS`, `DATASET_LATEST_YEARS`, and the `available_years` census_list_datasets
 * advertises all derive from it, so a caller cannot be pointed at a year the query path refuses.
 *
 * The list is what a query here can answer with, which is narrower than what the Census API
 * hosts, for three separate reasons. A vintage can be absent upstream: `pep/charv` publishes the
 * 2023 vintage alone, and its 2020 through 2022 numbers are values of that vintage's own `YEAR`
 * dimension, so `variables.json` 404s for those paths. It can exist upstream and reject the
 * `NAME` column every query here requests, which is `cbp` before 2012 and `nonemp` 2008 through
 * 2011. Or upstream can fail on it: `acs/acs1/spp` answers HTTP 500 to `POPGROUP_LABEL` on 2008
 * and to every `us` query on 2010. `yearNotAvailable` therefore says a year cannot be queried
 * rather than that the dataset does not publish it, which would be false for the last two kinds.
 *
 * A vintage the Census publishes that is missing here is refused before the network, so the
 * lists are checked against `api.census.gov/data/<year>.json` — the per-vintage catalog — rather
 * than trimmed by hand. Adding a vintage the Census releases is an edit here; until it is made,
 * the new year fails with `year_not_available`.
 */
export const DATASET_AVAILABLE_YEARS: Record<string, number[]> = {
  'acs/acs5': [
    2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024,
  ],
  'acs/acs5/profile': [
    2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024,
  ],
  'acs/acs5/subject': [
    2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024,
  ],
  'acs/acs1': [
    2005, 2006, 2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2021,
    2022, 2023, 2024,
  ],
  'acs/acs1/profile': [
    2005, 2006, 2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2021,
    2022, 2023, 2024,
  ],
  'acs/acs1/subject': [
    2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024,
  ],
  'acs/acs5/cprofile': [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024],
  'acs/acs1/cprofile': [
    2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024,
  ],
  'acs/acsse': [2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024],
  'acs/acs1/spp': [
    2009, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024,
  ],
  'pep/charv': [2023],
  'dec/pl': [2000, 2010, 2020],
  'dec/dhc': [2020],
  'dec/dp': [2020],
  'dec/sdhc': [2020],
  'dec/ddhca': [2020],
  cbp: [2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023],
  ecnbasic: [2012, 2017, 2022],
  nonemp: [
    1997, 1998, 1999, 2000, 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2012, 2013, 2014, 2015, 2016,
    2017, 2018, 2019, 2020, 2021, 2022, 2023,
  ],
};

/** Known dataset codes for validation. */
export const KNOWN_DATASETS = new Set(Object.keys(DATASET_AVAILABLE_YEARS));

/** The recovery every `dataset_not_found` carries. */
const DATASET_RECOVERY = {
  hint: 'Call census_list_datasets to discover valid dataset codes like acs/acs5.',
};

/**
 * Resolve a caller's dataset code to the registered one, or throw `dataset_not_found`.
 *
 * The input is trimmed and lowercased — every registered code is lowercase, so each code accepted
 * as spelled still resolves to itself. A blank input is `fallback` when the tool's dataset is
 * optional and an error when it is required. A single segment resolves when it is the second
 * segment of exactly one two-segment code (`acs5` is `acs/acs5`, `pl` is `dec/pl`). A third segment
 * (`profile`, `subject`) never resolves, because it is or can become shared — acs/acs5/subject
 * stopped being the only `subject` when acs/acs1/subject was added — so its error names the codes
 * that end in it instead.
 */
export function resolveDataset(input: string | undefined, fallback?: string): string {
  const trimmed = input?.trim() ?? '';
  if (!trimmed) {
    if (fallback) return fallback;
    throw notFound(
      'No dataset code was given. Pass a dataset code such as "acs/acs5"; census_list_datasets lists them all.',
      { reason: 'dataset_not_found', dataset: trimmed, recovery: DATASET_RECOVERY },
    );
  }

  const code = trimmed.toLowerCase();
  if (KNOWN_DATASETS.has(code)) return code;

  if (!code.includes('/')) {
    const segments = [...KNOWN_DATASETS].map((known) => known.split('/'));
    const [only, ...others] = segments.filter((s) => s.length === 2 && s[1] === code);
    if (only && others.length === 0) return only.join('/');

    const endingIn = segments
      .filter((s) => s.length === 3 && s[2] === code)
      .map((s) => s.join('/'));
    if (endingIn.length > 0) {
      throw notFound(
        `Unknown dataset: "${trimmed}" is the last segment of ${listCodes(endingIn)}, not a dataset code of its own. Pass the full code.`,
        { reason: 'dataset_not_found', dataset: trimmed, recovery: DATASET_RECOVERY },
      );
    }
  }

  throw notFound(
    `Unknown dataset: "${trimmed}". Use census_list_datasets to see valid dataset codes.`,
    { reason: 'dataset_not_found', dataset: trimmed, recovery: DATASET_RECOVERY },
  );
}

/** Map of dataset to latest available year. */
export const DATASET_LATEST_YEARS: Record<string, number> = Object.fromEntries(
  Object.entries(DATASET_AVAILABLE_YEARS).map(([dataset, years]) => [dataset, Math.max(...years)]),
);

/**
 * True for the ACS dataset family, the only family where the `E` estimate / `M` margin-of-error
 * suffix convention holds. ACS omits its `M` codes from variables.json but serves them from the
 * data API, so they are inferred; other families use `E`-final codes for unrelated fields
 * (`ecnbasic` `INVTOTE`, `cbp` `STATE`) that have no margin of error at all.
 */
export function isAcsDataset(dataset: string): boolean {
  return dataset.startsWith('acs/');
}

/**
 * True for the ACS datasets that publish a margin of error beside each estimate. The comparison
 * profiles (`acs/acs5/cprofile`, `acs/acs1/cprofile`) publish none — the data API answers
 * `CP03_2024_062M` with HTTP 400 — so inferring M codes there advertises columns that cannot be
 * queried. They still write ACS sentinels, which `isAcsDataset` keeps decoding.
 */
function publishesMarginsOfError(dataset: string): boolean {
  return isAcsDataset(dataset) && !dataset.endsWith('/cprofile');
}

/**
 * Required predicates that carry no subject-matter choice. `GEOCOMP` selects a geography's
 * component and defaults to the whole geography, and every Census dataset declares it — listing
 * it beside real filter dimensions like `NAICS2017` would bury the ones that change the answer.
 */
export const NON_FILTERING_PREDICATES = new Set(['GEOCOMP']);

/** Join codes into readable prose: `A`, `A and B`, `A, B, and C`. */
function listCodes(codes: string[]): string {
  if (codes.length <= 1) return codes[0] ?? '';
  if (codes.length === 2) return `${codes[0]} and ${codes[1]}`;
  return `${codes.slice(0, -1).join(', ')}, and ${codes.at(-1)}`;
}

/**
 * Map each unset dimension to the attribute column that echoes back the label of the default
 * the Census API applied, skipping the dimensions that publish none. Both data tools share it
 * so the row echo and the warning wording cannot drift apart.
 *
 * Requesting the bare predicate code instead of its attribute would flip the API from applying
 * one default to enumerating every category of it.
 */
export function defaultLabelColumnsFor(unset: UnsetPredicate[]): Record<string, string> {
  return Object.fromEntries(
    unset.flatMap((p) => (p.labelAttribute ? [[p.code, p.labelAttribute]] : [])),
  );
}

/** Map each record dimension to the attribute column carrying its per-row label. */
export function recordLabelColumnsFor(dimensions: RecordDimension[]): Record<string, string> {
  return Object.fromEntries(dimensions.map((d) => [d.code, d.labelAttribute]));
}

/**
 * Map each requested measure that publishes a flag column to that column. A withheld business
 * value holds `0`, so the flag is what the response needs to read the number at all.
 */
export function flagColumnsFor(
  codes: readonly string[],
  metadata: ReadonlyMap<string, CensusVariable>,
): Record<string, string> {
  return Object.fromEntries(
    codes.flatMap((code) => {
      const flag = metadata.get(code)?.flagAttribute;
      return flag ? [[code, flag]] : [];
    }),
  );
}

/**
 * The wildcarded dimensions to label, each with its own `_LABEL`/`_DESC` column when the dataset
 * publishes one. A dimension that is already a record column is labelled that way and skipped.
 */
export function wildcardColumnsFor(
  wildcards: readonly string[],
  recordColumns: Record<string, string>,
  metadata: ReadonlyMap<string, CensusVariable>,
): WildcardColumn[] {
  return wildcards
    .filter((code) => !Object.hasOwn(recordColumns, code))
    .map((code) => {
      const labelColumn = metadata.get(code)?.labelAttribute;
      return labelColumn ? { code, labelColumn } : { code };
    });
}

/**
 * Most values a notice quotes for one record column. A wildcarded dimension can split one
 * geography into over a thousand rows (`cbp` `NAICS2017: "*"` gives 1,552 for one county), and a
 * list of every code would be longer than the data it describes.
 */
const QUOTED_VALUE_LIMIT = 10;

/** Quote a column's values as `"4" (April) and "7" (July)`, the tail past the limit as a count. */
function quoteValues(values: Array<{ code: string; label: string }>): string {
  const quoted = values.slice(0, QUOTED_VALUE_LIMIT).map((v) => `"${v.code}" (${v.label})`);
  const rest = values.length - quoted.length;
  return rest > 0
    ? `${quoted.join(', ')}, and ${rest.toLocaleString('en-US')} more`
    : quoted.join(' and ');
}

/**
 * The record columns that actually split the response, with the predicate a caller pins one with.
 * A column that took a single value labelled the rows without separating them, so naming it as a
 * cause would send the caller to a predicate that changes nothing. Returns `undefined` when no
 * column took more than one value, which is the caller's cue that the split is unexplained.
 */
function splittingRecordColumns(
  observed: Record<string, Array<{ code: string; label: string }>>,
):
  | { entries: Array<[string, Array<{ code: string; label: string }>]>; example: string }
  | undefined {
  const entries = Object.entries(observed).filter(([, values]) => values.length > 1);
  const first = entries[0];
  if (!first) return;
  const example = first[1].slice(0, QUOTED_VALUE_LIMIT).at(-1)?.code ?? '';
  return { entries, example: `{"${first[0]}": "${example}"}` };
}

/**
 * Word the warning that one geography came back on several rows. Each is a separate record the
 * dataset publishes, not a repeat of the same number, so reading either one as "the" answer picks
 * a record the query never asked for. The values observed in the response are what a caller pins
 * the record with.
 *
 * A dimension the caller set to `"*"` splits the rows too, but that split is the breakdown the
 * caller asked for, so it is worded as one row per category rather than as a choice to make.
 */
export function describeRecordRows(
  dataset: string,
  year: number,
  rowsPerGeography: number,
  observed: Record<string, Array<{ code: string; label: string }>>,
  wildcards: readonly string[] = [],
): string {
  const rows = rowsPerGeography.toLocaleString('en-US');
  const breakdowns = Object.entries(observed).filter(([code]) => wildcards.includes(code));
  const splitting = splittingRecordColumns(
    Object.fromEntries(Object.entries(observed).filter(([code]) => !wildcards.includes(code))),
  );
  const breakdown =
    breakdowns.length > 0
      ? `Each geography came back on ${rows} rows: ${breakdowns
          .map(
            ([code, values]) =>
              `one row per category of ${code}, because predicates set it to "*" — the record field on each row names its category, taking ${quoteValues(values)}`,
          )
          .join('; ')}.`
      : undefined;
  if (!splitting) {
    return (
      breakdown ??
      `${dataset} (${year}) returned ${rows} rows for a single geography and nothing in the response separates them. Set the dataset's filter dimensions explicitly in predicates to pin one — census_list_predicate_values enumerates the codes each one accepts.`
    );
  }
  const named = splitting.entries
    .map(([code, values]) => `${code} separates them, taking ${quoteValues(values)}`)
    .join('; ');
  const records = `${dataset} (${year}) also publishes more than one record for each, and the record field on each row says which: ${named}. The numbers differ between them, so pick the record you want rather than the first row — add it to predicates, e.g. ${splitting.example}.`;
  return breakdown
    ? `${breakdown} ${records}`
    : `Each geography came back on ${rows} rows, one per record ${dataset} (${year}) publishes for it, and the record field on each row says which: ${named}. The numbers differ between them, so pick the record you want rather than the first row — add it to predicates, e.g. ${splitting.example}.`;
}

/**
 * Word the failure that a comparison came back with several rows per geography. A rank is a
 * statement about one geography, so a ranking that lists the same one twice with two different
 * numbers is wrong however the rows are labelled — the fix is to pin the record, and the values
 * observed in the response are what the caller pins it to.
 */
export function describeAmbiguousRows(
  dataset: string,
  year: number,
  rowsPerGeography: number,
  observed: Record<string, Array<{ code: string; label: string }>>,
): string {
  const rows = rowsPerGeography.toLocaleString('en-US');
  const splitting = splittingRecordColumns(observed);
  if (!splitting) {
    return `${dataset} (${year}) returned ${rows} rows for a single geography, so a rank cannot identify which one it refers to. Set the dataset's filter dimensions explicitly in predicates — census_list_predicate_values enumerates the codes each one accepts — or query one geography at a time with census_query_data.`;
  }
  const named = splitting.entries
    .map(([code, values]) => `${code} took ${quoteValues(values)}`)
    .join('; ');
  return `${dataset} (${year}) publishes several records per geography and this comparison pinned none of them, so every geography came back on ${rows} rows with different values: ${named}. Add the one you want to predicates, e.g. ${splitting.example}. census_query_data returns every record for a single geography, each labelled, if you want to see them side by side first.`;
}

/**
 * Word the warning that a query left filter dimensions unset. Both data tools share it so the
 * two cannot drift into warning about the same silent default with different force.
 *
 * The default the Census API substitutes is not one shape: `cbp` defaults `NAICS2017` to the
 * all-industries total, while `dec/ddhca` defaults `POPGROUP` to a single population group and
 * `ecnbasic` defaults its NAICS dimension to one sector. Calling every default an all-category
 * total would be wrong, so `applied` carries the label the API echoed back per dimension and the
 * warning names it — that label is what separates a total from one ordinary category.
 *
 * A dimension that publishes no label attribute (`pep/charv` `YEAR`, the `nonemp` NAICS codes
 * before 2012) echoes nothing, so it is named as unreadable rather than left looking like a
 * dimension no default was applied to.
 */
export function describeUnsetPredicates(
  unset: UnsetPredicate[],
  dataset: string,
  year: number,
  applied: Record<string, string> = {},
): string {
  const named = unset
    .map((p) => {
      const label = applied[p.code];
      return label
        ? `${p.code} (${p.label}) — the API applied "${label}"`
        : `${p.code} (${p.label}) — which value the API applied is not visible, since this dimension publishes no label`;
    })
    .join('; ');
  const example = unset[0]?.code ?? '';
  const echo =
    Object.keys(applied).length > 0
      ? ' The labels quoted above are repeated on every row under applied_filters, and reading them is what separates a value that is a total from one that is not: a default is the all-categories total on some dimensions and one ordinary category on others.'
      : ' A default is the all-categories total on some dimensions and one ordinary category on others, and nothing in the response says which this one is.';
  return `${dataset} (${year}) filters on dimensions this query left unset: ${named}. The Census API applied its own default to each rather than rejecting the query.${echo} Set a dimension explicitly to control what the numbers cover, e.g. {"${example}": "<code>"}; census_list_predicate_values enumerates the codes each one accepts.`;
}

/**
 * Word why a predicated query came back empty, for the `no_data` recovery hint. Covers both
 * causes: a dimension left unset (`ecnbasic` publishes nothing below the national level until an
 * industry is named) and a supplied value that does not exist (an unknown `NAICS2017` value is a
 * `204`, not a `400`). Returns `''` when neither applies, so the caller falls back to its own
 * dataset-aware hint.
 */
export function describeEmptyPredicatedResult(
  unset: UnsetPredicate[],
  supplied: string[],
  dataset: string,
  year: number,
): string {
  const parts: string[] = [];

  if (unset.length > 0) {
    const codes = unset.map((p) => p.code);
    parts.push(
      `${dataset} (${year}) may publish nothing at this level until ${listCodes(codes)} ${unset.length === 1 ? 'is' : 'are'} set — add predicates, e.g. {"${codes[0]}": "<code>"}.`,
    );
  }

  if (supplied.length > 0) {
    parts.push(
      `A predicate value that does not exist in ${dataset} (${year}) also returns nothing rather than an error, so check the ${listCodes(supplied)} ${supplied.length === 1 ? 'value' : 'values'} this query sent — census_list_predicate_values enumerates the codes each dimension accepts.`,
    );
  }

  return parts.join(' ');
}

/**
 * True for a `group` naming more than one table (`"B17015,B18104,…"`). Such a column's concept
 * joins every one of those tables' concepts, so it describes none of them.
 */
function isSharedAcrossTables(group: string | undefined): boolean {
  return group?.includes(',') ?? false;
}

/** The one table a variable belongs to, or undefined for shared and table-less columns. */
function tableOf(variable: CensusVariable): string | undefined {
  const { group } = variable;
  return group && group !== 'N/A' && !isSharedAcrossTables(group) ? group : undefined;
}

/**
 * The label the Census publishes for an estimate's margin-of-error column: the estimate label with
 * its `Estimate` segment replaced by `Margin of Error`, wherever it sits (`Estimate!!Total` on
 * current vintages, `Number!!Estimate!!…` and `Total!!Estimate!!…` on older ones). A current
 * profile percent column has no such segment and opens with `Percent!!`, which becomes
 * `Percent Margin of Error!!`. A label with neither is prefixed whole.
 */
function marginOfErrorLabel(estimateLabel: string): string {
  const segments = estimateLabel.split('!!');
  const estimate = segments.indexOf('Estimate');
  if (estimate !== -1) return segments.with(estimate, 'Margin of Error').join('!!');
  if (segments[0] === 'Percent')
    return ['Percent Margin of Error', ...segments.slice(1)].join('!!');
  return `Margin of Error!!${estimateLabel}`;
}

/** Per-variable requests in flight at once when one lookup names several attribute columns. */
const ATTRIBUTE_FETCH_CONCURRENCY = 4;

interface CacheEntry {
  /**
   * Every column named in some entry's `attributes` list — `B19013_001EA`, `EMP_F`,
   * `NAICS2017_LABEL`. variables.json gives these no entry of their own, so this index is what
   * separates a column the dataset has from a code it does not.
   */
  attributeNames: Set<string>;
  /** Attribute columns already resolved from the per-variable endpoint. */
  attributes: Map<string, CensusVariable>;
  fetchedAt: number;
  /**
   * The dataset's spelling of each column name that is not all uppercase, keyed by its uppercase
   * form. Only the comparison profiles have any (`CP03_2024to2019_062SS`), and upstream rejects
   * the uppercased spelling.
   */
  spellings: Map<string, string>;
  /** Universe per table from groups.json, loaded on the first lookup that needs one. */
  universes?: Map<string, string>;
  variables: Map<string, CensusVariable>;
}

export class VariableCacheService {
  private readonly cache = new Map<string, CacheEntry>();

  /**
   * Search variables by keyword across label and concept fields. `rankVariables` holds the
   * matching and ordering rule.
   */
  async searchVariables(
    params: { query: string; dataset: string; year: number; limit: number },
    ctx: Context,
  ): Promise<VariableSearchResult> {
    const { variables } = await this.getEntry(params.dataset, params.year, ctx);
    return rankVariables(variables, params.query, params.limit);
  }

  /**
   * Get metadata for specific variable codes, in the order given, with each one's table universe.
   * Throws `variable_not_found` naming every code the dataset has no column for, before any
   * further request goes out.
   *
   * A code variables.json lists only inside an entry's `attributes` is resolved from the
   * per-variable endpoint, which publishes its label and the column it belongs to. An uppercased
   * code resolves to the dataset's own spelling where that differs.
   */
  async getVariablesByCode(
    requested: string[],
    dataset: string,
    year: number,
    ctx: Context,
  ): Promise<CensusVariable[]> {
    const entry = await this.getEntry(dataset, year, ctx);
    const codes = requested.map((code) => entry.spellings.get(code) ?? code);
    const missing = codes.filter(
      (code) => !entry.variables.has(code) && !entry.attributeNames.has(code),
    );

    if (missing.length > 0) {
      throw notFound(`Variable codes not found in ${dataset} (${year}): ${missing.join(', ')}`, {
        reason: 'variable_not_found',
        missingCodes: missing,
        dataset,
        year,
        recovery: {
          hint: `Use census_search_variables to find valid codes for ${dataset} ${year}.`,
        },
      });
    }

    const unresolved = [
      ...new Set(codes.filter((code) => !entry.variables.has(code) && !entry.attributes.has(code))),
    ];
    for (let i = 0; i < unresolved.length; i += ATTRIBUTE_FETCH_CONCURRENCY) {
      await Promise.all(
        unresolved.slice(i, i + ATTRIBUTE_FETCH_CONCURRENCY).map(async (code) => {
          entry.attributes.set(code, await this.fetchAttribute(code, dataset, year, ctx));
        }),
      );
    }

    const resolved = codes.flatMap((code) => {
      const variable = entry.variables.get(code) ?? entry.attributes.get(code);
      return variable ? [variable] : [];
    });

    const universes = resolved.some((v) => tableOf(v))
      ? await this.getUniverses(entry, dataset, year, ctx)
      : undefined;

    return resolved.map((variable) => {
      const table = tableOf(variable);
      const universe = table ? universes?.get(table) : undefined;
      return universe ? { ...variable, universe } : variable;
    });
  }

  /**
   * Check a caller's predicate map against the dataset's own variables.json.
   *
   * Census datasets mark some variables `required`, but the API does not enforce them: a query
   * that omits one succeeds and silently returns the aggregate across that whole dimension. A
   * `cbp` establishment count without `NAICS2017` is every industry, not the one that was asked
   * for. Reporting the unset dimensions is the only way a caller can tell those apart.
   */
  async checkPredicates(
    params: { dataset: string; year: number; supplied: string[] },
    ctx: Context,
  ): Promise<PredicateCheck> {
    const variables = await this.getVariables(params.dataset, params.year, ctx);
    const supplied = new Set(params.supplied);

    const unset: UnsetPredicate[] = [];
    for (const variable of variables.values()) {
      if (!variable.required || NON_FILTERING_PREDICATES.has(variable.code)) continue;
      if (!supplied.has(variable.code)) {
        unset.push({
          code: variable.code,
          label: variable.label,
          ...(variable.labelAttribute && { labelAttribute: variable.labelAttribute }),
        });
      }
    }
    unset.sort((a, b) => a.code.localeCompare(b.code));

    return { unset, unknown: params.supplied.filter((code) => !variables.has(code)) };
  }

  /**
   * Look up each code on its own, leaving out the ones the dataset's `variables.json` has no entry
   * for rather than failing the rest. The data API accepts columns that file lists only inside an
   * entry's `attributes` (`B19013_001EA`, `EMP_F`), so a miss here says nothing about whether a
   * query will succeed — it only means there is no label to show.
   */
  async lookupVariables(
    codes: readonly string[],
    dataset: string,
    year: number,
    ctx: Context,
  ): Promise<Map<string, CensusVariable>> {
    const variables = await this.getVariables(dataset, year, ctx);
    const found = new Map<string, CensusVariable>();
    for (const code of codes) {
      const variable = variables.get(code);
      if (variable) found.set(code, variable);
    }
    return found;
  }

  /** Look up one variable, returning undefined rather than throwing when it is not defined. */
  async findVariable(
    code: string,
    dataset: string,
    year: number,
    ctx: Context,
  ): Promise<CensusVariable | undefined> {
    const variables = await this.getVariables(dataset, year, ctx);
    return variables.get(code);
  }

  /** The dataset's filter dimensions — every variable it marks required that changes the answer. */
  async getFilterDimensions(
    dataset: string,
    year: number,
    ctx: Context,
  ): Promise<CensusVariable[]> {
    const variables = await this.getVariables(dataset, year, ctx);
    return [...variables.values()]
      .filter((v) => v.required && !NON_FILTERING_PREDICATES.has(v.code))
      .sort((a, b) => a.code.localeCompare(b.code));
  }

  /**
   * Columns a geography's rows vary over that the dataset does not mark required — the reason
   * one geography can come back on more than one row. See `RecordDimension` for how they are
   * recognized and why the shape is read off variables.json instead of a per-dataset list.
   */
  async getRecordDimensions(
    dataset: string,
    year: number,
    ctx: Context,
  ): Promise<RecordDimension[]> {
    const variables = await this.getVariables(dataset, year, ctx);
    return [...variables.values()]
      .filter((v) => !v.required && v.labelAttribute)
      .map((v) => ({ code: v.code, label: v.label, labelAttribute: v.labelAttribute as string }))
      .sort((a, b) => a.code.localeCompare(b.code));
  }

  /**
   * Pick the measure variable to probe with when checking which of a dimension's codes the
   * dataset actually publishes rows for.
   *
   * A wildcard group-by answers from the dataset's published value map when every requested
   * column can be served from metadata, and only reads the data file when a measure is among
   * them — so which measure is requested decides the answer. Coverage is per table and nests:
   * on `dec/ddhca` the total-population table publishes 2,996 population groups where the
   * 23-category sex-by-age table publishes 551 of the same ones. The coarsest table therefore
   * gives the widest set, and cell count is what says which table is coarsest.
   */
  async findPublicationProbe(
    dataset: string,
    year: number,
    ctx: Context,
  ): Promise<string | undefined> {
    const variables = await this.getVariables(dataset, year, ctx);
    const tables = new Map<string, string[]>();
    for (const v of variables.values()) {
      // Geography and metadata columns carry `group: "N/A"` and measure nothing.
      if (v.required || v.predicateType !== 'int' || !v.group || v.group === 'N/A') continue;
      const members = tables.get(v.group) ?? [];
      members.push(v.code);
      tables.set(v.group, members);
    }
    const coarsest = [...tables.entries()].sort(
      ([aName, aVars], [bName, bVars]) => aVars.length - bVars.length || aName.localeCompare(bName),
    )[0];
    return coarsest?.[1].sort()[0];
  }

  /**
   * Validate that a dataset serves the requested vintage, before a query spends a round trip on
   * a path the Census API answers with a 404 and an HTML error page. Every data and discovery
   * path runs through the variable cache, so this is the one place the check has to sit.
   */
  validateYear(dataset: string, year: number): void {
    const years = DATASET_AVAILABLE_YEARS[dataset];
    if (years && !years.includes(year)) throw yearNotAvailable(dataset, year, years);
  }

  /** Validate that a dataset code is known. */
  validateDataset(dataset: string): void {
    if (!KNOWN_DATASETS.has(dataset)) {
      throw notFound(
        `Unknown dataset: "${dataset}". Use census_list_datasets to see valid dataset codes.`,
        { reason: 'dataset_not_found', dataset, recovery: DATASET_RECOVERY },
      );
    }
  }

  /** The variable map for a dataset+year. */
  private async getVariables(
    dataset: string,
    year: number,
    ctx: Context,
  ): Promise<Map<string, CensusVariable>> {
    return (await this.getEntry(dataset, year, ctx)).variables;
  }

  /**
   * GET one Census metadata document and parse it, retrying transient failures. `mapError`
   * translates a failed fetch (unchanged by default); an HTML page or unparseable body is
   * `variables_unavailable`.
   */
  private fetchMetadata(
    url: string,
    what: string,
    scope: { dataset: string; year: number },
    ctx: Context,
    mapError: (error: unknown) => unknown = (error) => error,
  ): Promise<unknown> {
    return withRetry(
      async () => {
        let response: Response;
        try {
          response = await fetchWithTimeout(url, 30_000, ctx as unknown as RequestContext, {
            signal: ctx.signal,
            // A 404 is an answer here, not a fault — a dropped vintage, or a dataset that
            // publishes no groups.json — so it is logged at debug and handled by the caller.
            expectedStatuses: [404],
          });
        } catch (error) {
          throw mapError(error);
        }
        const text = await response.text();

        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable(
            `Census ${what} returned HTML for ${scope.dataset} (${scope.year}).`,
            { reason: 'variables_unavailable', ...ctx.recoveryFor('variables_unavailable') },
          );
        }

        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw serviceUnavailable(
            `Census ${what} could not be parsed for ${scope.dataset} (${scope.year}).`,
            { reason: 'variables_unavailable', ...ctx.recoveryFor('variables_unavailable') },
          );
        }
      },
      {
        operation: 'VariableCacheService.getVariables',
        context: ctx as unknown as RequestContext,
        baseDelayMs: 2000,
        signal: ctx.signal,
      },
    );
  }

  /** The metadata a failed per-variable or groups.json fetch leaves the lookup without. */
  private metadataUnavailable(
    what: string,
    scope: { dataset: string; year: number },
    ctx: Context,
    cause: unknown,
  ): McpError {
    const status =
      cause instanceof McpError ? (cause.data?.status as number | undefined) : undefined;
    return serviceUnavailable(
      `Census ${what} could not be fetched for ${scope.dataset} (${scope.year})${status ? `: HTTP ${status}` : ''}.`,
      {
        reason: 'variables_unavailable',
        dataset: scope.dataset,
        year: scope.year,
        ...(status !== undefined && { status }),
        ...ctx.recoveryFor('variables_unavailable'),
      },
      { cause },
    );
  }

  /**
   * Resolve one attribute column from the per-variable endpoint. Any failure is
   * `variables_unavailable`: the code was found in the dataset's own attributes index, so a miss
   * here is the endpoint failing rather than the code not existing.
   */
  private async fetchAttribute(
    code: string,
    dataset: string,
    year: number,
    ctx: Context,
  ): Promise<CensusVariable> {
    const url = `${CENSUS_API_BASE}/${year}/${dataset}/variables/${encodeURIComponent(code)}.json`;
    const what = `variable metadata for ${code}`;
    let raw: RawVariableRecord;
    try {
      raw = (await this.fetchMetadata(url, what, { dataset, year }, ctx)) as RawVariableRecord;
    } catch (error) {
      throw this.metadataUnavailable(what, { dataset, year }, ctx, error);
    }

    const variable: CensusVariable = {
      code,
      label: raw.label ?? '',
      predicateType: raw.predicateType ?? 'string',
    };
    if (raw.concept && !isSharedAcrossTables(raw.group)) variable.concept = raw.concept;
    if (raw.group) variable.group = raw.group;
    if (raw['attribute of']) variable.attributeOf = raw['attribute of'];
    if (raw['attribute type']) variable.attributeType = raw['attribute type'];
    return variable;
  }

  /**
   * Universe per table, from groups.json, cached on the entry so it expires with variables.json.
   * A dataset that publishes no groups.json (a 404) has no universes; any other failure is
   * `variables_unavailable`, since leaving the field out would claim the table publishes none.
   */
  private async getUniverses(
    entry: CacheEntry,
    dataset: string,
    year: number,
    ctx: Context,
  ): Promise<Map<string, string>> {
    if (entry.universes) return entry.universes;

    const universes = new Map<string, string>();
    let raw: RawGroupsJson | undefined;
    try {
      raw = (await this.fetchMetadata(
        `${CENSUS_API_BASE}/${year}/${dataset}/groups.json`,
        'groups.json',
        { dataset, year },
        ctx,
      )) as RawGroupsJson;
    } catch (error) {
      const notPublished = error instanceof McpError && error.data?.status === 404;
      if (!notPublished)
        throw this.metadataUnavailable('groups.json', { dataset, year }, ctx, error);
    }

    for (const group of raw?.groups ?? []) {
      // The Census spells the key with a trailing space; the unpadded spelling is read too.
      const universe = (group['universe '] ?? group.universe)?.trim();
      if (group.name && universe) universes.set(group.name, universe);
    }

    entry.universes = universes;
    return universes;
  }

  /** Get or fetch the cache entry for a dataset+year. Cached in-memory with TTL. */
  private async getEntry(dataset: string, year: number, ctx: Context): Promise<CacheEntry> {
    this.validateDataset(dataset);
    this.validateYear(dataset, year);

    const { variableCacheTtlHours } = getDiscoveryConfig();
    const ttlMs = variableCacheTtlHours * 60 * 60 * 1000;
    const cacheKey = `${dataset}|${year}`;
    const existing = this.cache.get(cacheKey);

    if (existing && Date.now() - existing.fetchedAt < ttlMs) {
      ctx.log.debug('Variable cache hit', { dataset, year });
      return existing;
    }

    ctx.log.info('Fetching variables.json', { dataset, year });
    const raw = (await this.fetchMetadata(
      `${CENSUS_API_BASE}/${year}/${dataset}/variables.json`,
      'variables.json',
      { dataset, year },
      ctx,
      (error) =>
        censusHttpError(error, { dataset, year, availableYears: DATASET_AVAILABLE_YEARS[dataset] }),
    )) as RawVariablesJson;

    const variables = new Map<string, CensusVariable>();
    const attributeNames = new Set<string>();
    const rawVars = raw.variables ?? {};
    // The E/M suffix convention is an ACS table convention, not a Census-wide one — inferring
    // it elsewhere, or on the ACS comparison profiles, invents codes the dataset does not have.
    const inferMargins = publishesMarginsOfError(dataset);

    for (const [code, entry] of Object.entries(rawVars)) {
      if (code === 'for' || code === 'in' || code === 'ucgid') continue;

      const variable: CensusVariable = {
        code,
        label: entry.label ?? '',
        predicateType: entry.predicateType ?? 'string',
      };

      if (entry.concept && !isSharedAcrossTables(entry.group)) variable.concept = entry.concept;
      if (entry.required != null) variable.required = true;
      if (entry.values?.item) variable.values = entry.values.item;
      if (entry.group) variable.group = entry.group;

      // `attributes` is a comma-separated list mixing flag columns with the label column
      // (e.g. "NAICS2017_F,NAICS2017_LABEL,NAICS2017_F").
      const attributes =
        entry.attributes
          ?.split(',')
          .map((name) => name.trim())
          .filter(Boolean) ?? [];
      for (const name of attributes) attributeNames.add(name);
      // `_TTL` labels a filter dimension on some vintages (`acs/acs1/spp` 2012–2017 `POPGROUP_TTL`).
      // It is read only on a required dimension, since a labelled column that is not required is
      // taken as a record dimension, and requesting one changes which rows a query returns.
      const labelAttribute = attributes.find(
        (name) =>
          name === `${code}_LABEL` ||
          name === `${code}_DESC` ||
          (variable.required === true && name === `${code}_TTL`),
      );
      if (labelAttribute) variable.labelAttribute = labelAttribute;

      // A measure's flag column is named in `attributes` on current vintages and published as a
      // variable of its own on the older `nonemp` ones (`NESTAB_F`). Numeric measures only: the
      // same suffix flags a dimension (`NAICS2017_F`) and footnotes a text column (`GEO_ID_F`),
      // neither of which withholds a value.
      const flagAttribute = `${code}_F`;
      if (
        (entry.predicateType === 'int' || entry.predicateType === 'float') &&
        (attributes.includes(flagAttribute) || Object.hasOwn(rawVars, flagAttribute))
      ) {
        variable.flagAttribute = flagAttribute;
      }

      // Infer E↔M sibling codes by suffix pattern. ACS variables.json omits M-suffix
      // (MOE) variables, but within ACS the pattern is reliable: B*E estimates always have a
      // B*M counterpart accessible via the data API. Check rawVars first (some datasets do
      // include M codes), then fall back to pattern-based inference for E-suffix codes.
      // A geography column (`STATE`, `PLACE`, `LSAD_NAME`) sits beside the estimates with
      // `group: "N/A"`; it can end in E, but it is no estimate and has no margin.
      if (inferMargins && entry.group !== 'N/A') {
        if (code.endsWith('M')) {
          const estimateCode = `${code.slice(0, -1)}E`;
          if (rawVars[estimateCode]) {
            variable.estimateCode = estimateCode;
            variable.attributeOf = estimateCode;
            variable.attributeType = 'MARGIN_OF_ERROR';
          }
        } else if (code.endsWith('E')) {
          const moeCode = `${code.slice(0, -1)}M`;
          // Set moeCode regardless of whether the M code appears in variables.json —
          // M-suffix variables work in census_query_data even though they aren't listed.
          variable.moeCode = moeCode;
        }
      }

      variables.set(code, variable);
    }

    // Synthesize the M entries variables.json leaves out, as the Census publishes each one in its
    // own per-variable record, so a lookup or search of an M code needs no further request.
    for (const [code, variable] of variables) {
      if (variable.moeCode && !variables.has(variable.moeCode)) {
        variables.set(variable.moeCode, {
          code: variable.moeCode,
          label: marginOfErrorLabel(variable.label),
          ...(variable.concept !== undefined && { concept: variable.concept }),
          ...(variable.group && { group: variable.group }),
          // A margin is an integer unless its estimate is fractional: the year medians are typed
          // `string`, but their published margins are `int`.
          predicateType: variable.predicateType === 'float' ? 'float' : 'int',
          estimateCode: code,
          attributeOf: code,
          attributeType: 'MARGIN_OF_ERROR',
        });
      }
    }

    const spellings = new Map<string, string>();
    for (const name of [...variables.keys(), ...attributeNames]) {
      const upper = name.toUpperCase();
      if (upper !== name) spellings.set(upper, name);
    }

    const fresh: CacheEntry = {
      variables,
      attributeNames,
      attributes: new Map(),
      fetchedAt: Date.now(),
      spellings,
    };
    this.cache.set(cacheKey, fresh);
    ctx.log.info('Variable cache populated', { dataset, year, variableCount: variables.size });
    return fresh;
  }
}

// --- Init/accessor pattern ---

let _service: VariableCacheService | undefined;

export function initVariableCacheService(): void {
  _service = new VariableCacheService();
}

export function getVariableCacheService(): VariableCacheService {
  if (!_service) {
    throw new Error(
      'VariableCacheService not initialized — call initVariableCacheService() in setup()',
    );
  }
  return _service;
}
