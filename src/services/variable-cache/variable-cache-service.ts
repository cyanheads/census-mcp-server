/**
 * @fileoverview Census variable cache service. Fetches and caches variables.json per dataset+year
 * with a configurable TTL, then performs client-side keyword search across label and concept fields.
 * @module services/variable-cache/variable-cache-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, type RequestContext, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getDiscoveryConfig } from '@/config/server-config.js';
import { censusHttpError, yearNotAvailable } from '@/services/census-api/errors.js';
import type {
  CensusVariable,
  PredicateCheck,
  RawVariablesJson,
  RecordDimension,
  UnsetPredicate,
} from './types.js';

const CENSUS_API_BASE = 'https://api.census.gov/data';

/**
 * Vintages each dataset can be queried for, and the only place they are written down —
 * `KNOWN_DATASETS`, `DATASET_LATEST_YEARS`, and the `available_years` census_list_datasets
 * advertises all derive from it, so a caller cannot be pointed at a year the query path refuses.
 *
 * The list is what a query here can answer with, which is narrower than what the Census API
 * hosts, for two separate reasons. A vintage can be absent upstream: `pep/charv` publishes the
 * 2023 vintage alone, and its 2020 through 2022 numbers are values of that vintage's own `YEAR`
 * dimension, so `variables.json` 404s for those paths. Or it can exist upstream and reject the
 * `NAME` column every query here requests, which is `cbp` before 2012 and `nonemp` 2008 through
 * 2011. `yearNotAvailable` therefore says a year cannot be queried rather than that the dataset
 * does not publish it, which would be false for the second kind.
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
  'pep/charv': [2023],
  'dec/pl': [2000, 2010, 2020],
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
  return { entries, example: `{"${first[0]}": "${first[1].at(-1)?.code ?? ''}"}` };
}

/**
 * Word the warning that one geography came back on several rows. Each is a separate record the
 * dataset publishes, not a repeat of the same number, so reading either one as "the" answer picks
 * a record the query never asked for. The values observed in the response are what a caller pins
 * the record with.
 */
export function describeRecordRows(
  dataset: string,
  year: number,
  rowsPerGeography: number,
  observed: Record<string, Array<{ code: string; label: string }>>,
): string {
  const splitting = splittingRecordColumns(observed);
  if (!splitting) {
    return `${dataset} (${year}) returned ${rowsPerGeography} rows for a single geography and nothing in the response separates them. Set the dataset's filter dimensions explicitly in predicates to pin one — census_list_predicate_values enumerates the codes each one accepts.`;
  }
  const named = splitting.entries
    .map(
      ([code, values]) =>
        `${code} separates them, taking ${values.map((v) => `"${v.code}" (${v.label})`).join(' and ')}`,
    )
    .join('; ');
  return `Each geography came back on ${rowsPerGeography} rows, one per record ${dataset} (${year}) publishes for it, and the record field on each row says which: ${named}. The numbers differ between them, so pick the record you want rather than the first row — add it to predicates, e.g. ${splitting.example}.`;
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
  const splitting = splittingRecordColumns(observed);
  if (!splitting) {
    return `${dataset} (${year}) returned ${rowsPerGeography} rows for a single geography, so a rank cannot identify which one it refers to. Set the dataset's filter dimensions explicitly in predicates — census_list_predicate_values enumerates the codes each one accepts — or query one geography at a time with census_query_data.`;
  }
  const named = splitting.entries
    .map(
      ([code, values]) =>
        `${code} took ${values.map((v) => `"${v.code}" (${v.label})`).join(' and ')}`,
    )
    .join('; ');
  return `${dataset} (${year}) publishes several records per geography and this comparison pinned none of them, so every geography came back on ${rowsPerGeography} rows with different values: ${named}. Add the one you want to predicates, e.g. ${splitting.example}. census_query_data returns every record for a single geography, each labelled, if you want to see them side by side first.`;
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

interface CacheEntry {
  fetchedAt: number;
  variables: Map<string, CensusVariable>;
}

export class VariableCacheService {
  private readonly cache = new Map<string, CacheEntry>();

  /**
   * Search variables by keyword across label and concept fields.
   * Returns variables sorted by relevance (exact concept match > label match > partial).
   */
  async searchVariables(
    params: { query: string; dataset: string; year: number; limit: number },
    ctx: Context,
  ): Promise<{ variables: CensusVariable[]; totalMatches: number }> {
    const variables = await this.getVariables(params.dataset, params.year, ctx);
    const queryLower = params.query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter(Boolean);

    const scored: Array<{ variable: CensusVariable; score: number }> = [];

    for (const variable of variables.values()) {
      const labelLower = variable.label.toLowerCase();
      const conceptLower = variable.concept.toLowerCase();

      let score = 0;
      if (conceptLower === queryLower) score += 100;
      else if (conceptLower.includes(queryLower)) score += 50;
      if (labelLower === queryLower) score += 80;
      else if (labelLower.includes(queryLower)) score += 40;
      for (const term of queryTerms) {
        if (conceptLower.includes(term)) score += 10;
        if (labelLower.includes(term)) score += 5;
      }

      if (score > 0) scored.push({ variable, score });
    }

    scored.sort((a, b) => b.score - a.score);

    return {
      variables: scored.slice(0, params.limit).map((s) => s.variable),
      totalMatches: scored.length,
    };
  }

  /**
   * Get metadata for specific variable codes. Throws if any code is not found.
   */
  async getVariablesByCode(
    codes: string[],
    dataset: string,
    year: number,
    ctx: Context,
  ): Promise<CensusVariable[]> {
    const variables = await this.getVariables(dataset, year, ctx);
    const results: CensusVariable[] = [];
    const missing: string[] = [];

    for (const code of codes) {
      const variable = variables.get(code);
      if (variable) {
        results.push(variable);
      } else {
        missing.push(code);
      }
    }

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

    return results;
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
        {
          reason: 'dataset_not_found',
          dataset,
          recovery: {
            hint: 'Call census_list_datasets to discover valid dataset codes like acs/acs5.',
          },
        },
      );
    }
  }

  /** Get or fetch the variable map for a dataset+year. Cached in-memory with TTL. */
  private async getVariables(
    dataset: string,
    year: number,
    ctx: Context,
  ): Promise<Map<string, CensusVariable>> {
    this.validateDataset(dataset);
    this.validateYear(dataset, year);

    const { variableCacheTtlHours } = getDiscoveryConfig();
    const ttlMs = variableCacheTtlHours * 60 * 60 * 1000;
    const cacheKey = `${dataset}|${year}`;
    const existing = this.cache.get(cacheKey);

    if (existing && Date.now() - existing.fetchedAt < ttlMs) {
      ctx.log.debug('Variable cache hit', { dataset, year });
      return existing.variables;
    }

    ctx.log.info('Fetching variables.json', { dataset, year });
    const url = `${CENSUS_API_BASE}/${year}/${dataset}/variables.json`;

    const raw = await withRetry(
      async () => {
        let response: Response;
        try {
          response = await fetchWithTimeout(url, 30_000, ctx as unknown as RequestContext, {
            signal: ctx.signal,
            // A vintage this catalog lists that the API has since dropped is an expected
            // outcome, not a fault — log it at debug and answer with year_not_available.
            expectedStatuses: [404],
          });
        } catch (error) {
          throw censusHttpError(error, {
            dataset,
            year,
            availableYears: DATASET_AVAILABLE_YEARS[dataset],
          });
        }
        const text = await response.text();

        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable(
            `Census variables.json returned HTML for ${dataset} (${year}).`,
            { reason: 'variables_unavailable' },
          );
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw serviceUnavailable(
            `Census variables.json could not be parsed for ${dataset} (${year}).`,
            { reason: 'variables_unavailable' },
          );
        }

        return parsed as RawVariablesJson;
      },
      {
        operation: 'VariableCacheService.getVariables',
        context: ctx as unknown as RequestContext,
        baseDelayMs: 2000,
        signal: ctx.signal,
      },
    );

    const variables = new Map<string, CensusVariable>();
    const rawVars = raw.variables ?? {};
    // The E/M suffix convention is an ACS table convention, not a Census-wide one — inferring
    // it elsewhere invents codes the dataset does not have.
    const acsFamily = isAcsDataset(dataset);

    for (const [code, entry] of Object.entries(rawVars)) {
      if (code === 'for' || code === 'in' || code === 'ucgid') continue;

      const variable: CensusVariable = {
        code,
        label: entry.label ?? '',
        concept: entry.concept ?? '',
        predicateType: entry.predicateType ?? 'string',
      };

      if (entry.universe) variable.universe = entry.universe;
      if (entry.required != null) variable.required = true;
      if (entry.values?.item) variable.values = entry.values.item;
      if (entry.group) variable.group = entry.group;

      // `attributes` is a comma-separated list mixing flag columns with the label column
      // (e.g. "NAICS2017_F,NAICS2017_LABEL,NAICS2017_F") — only the label one is useful here.
      const labelAttribute = entry.attributes
        ?.split(',')
        .map((name) => name.trim())
        .find((name) => name === `${code}_LABEL` || name === `${code}_DESC`);
      if (labelAttribute) variable.labelAttribute = labelAttribute;

      // Infer E↔M sibling codes by suffix pattern. ACS variables.json omits M-suffix
      // (MOE) variables, but within ACS the pattern is reliable: B*E estimates always have a
      // B*M counterpart accessible via the data API. Check rawVars first (some datasets do
      // include M codes), then fall back to pattern-based inference for E-suffix codes.
      if (acsFamily) {
        if (code.endsWith('M')) {
          const estimateCode = `${code.slice(0, -1)}E`;
          if (rawVars[estimateCode]) variable.estimateCode = estimateCode;
        } else if (code.endsWith('E')) {
          const moeCode = `${code.slice(0, -1)}M`;
          // Set moeCode regardless of whether the M code appears in variables.json —
          // M-suffix variables work in census_query_data even though they aren't listed.
          variable.moeCode = moeCode;
        }
      }

      variables.set(code, variable);
    }

    // Synthesize M-suffix entries for E-suffix variables so direct lookup of B*M codes works.
    // These synthetic entries let census_get_variable resolve M codes without a variables_not_found error.
    for (const [code, variable] of variables) {
      if (variable.moeCode && !variables.has(variable.moeCode)) {
        variables.set(variable.moeCode, {
          code: variable.moeCode,
          label: `Margin of Error — ${variable.label}`,
          concept: variable.concept,
          predicateType: 'int',
          estimateCode: code,
        });
      }
    }

    this.cache.set(cacheKey, { variables, fetchedAt: Date.now() });
    ctx.log.info('Variable cache populated', { dataset, year, variableCount: variables.size });
    return variables;
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
