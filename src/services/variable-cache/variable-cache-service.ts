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
import {
  codeToken,
  isSharedAcrossTables,
  looksLikeCode,
  rankVariables,
  tableOf,
  type VariableSearchResult,
} from './variable-search.js';

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
  'dec/ddhcb': [2020],
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
 * stopped being the only `subject` when acs/acs1/subject was added — so its recovery names the
 * codes that end in it instead.
 */
export function resolveDataset(input: string | undefined, fallback?: string): string {
  const trimmed = input?.trim() ?? '';
  if (!trimmed) {
    if (fallback) return fallback;
    throw notFound('No dataset code was given.', {
      reason: 'dataset_not_found',
      dataset: trimmed,
      recovery: DATASET_RECOVERY,
    });
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
        `Unknown dataset: "${trimmed}" is the last segment of a dataset code, not a dataset code of its own.`,
        {
          reason: 'dataset_not_found',
          dataset: trimmed,
          recovery: { hint: `Pass the full code — ${listCodes(endingIn, 'or')}.` },
        },
      );
    }
  }

  throw notFound(`Unknown dataset: "${trimmed}".`, {
    reason: 'dataset_not_found',
    dataset: trimmed,
    recovery: DATASET_RECOVERY,
  });
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

/** Join codes into readable prose: `A`, `A and B`, `A, B, and C` (or `A or B` for alternatives). */
function listCodes(codes: readonly string[], conjunction: 'and' | 'or' = 'and'): string {
  if (codes.length <= 1) return codes[0] ?? '';
  if (codes.length === 2) return `${codes[0]} ${conjunction} ${codes[1]}`;
  return `${codes.slice(0, -1).join(', ')}, ${conjunction} ${codes.at(-1)}`;
}

/**
 * Tables that split a dataset's `POPGROUP` groups between them. At each geography a group is
 * published in only one table of a family, so a table answers for some groups there and not for
 * others, and which one holds a group changes from geography to geography (api.census.gov,
 * 2026-10-13). On `dec/ddhca` the sex-by-age tables `T02001`–`T02003` publish 295, 573, and 551
 * groups nationally with none in two of them, while `T01001` publishes all 2,996 and splits nothing.
 * On `dec/ddhcb` household type (`T03001`–`T03004`) and tenure (`T04001`–`T04002`) each split the
 * same 2,996 groups, and no table publishes them all.
 *
 * Read off the published rows rather than variables.json, which describes the tables without
 * saying which groups each one serves — so the list is written down here, per dataset.
 */
const POPGROUP_TABLE_FAMILIES: Readonly<Record<string, ReadonlyArray<readonly string[]>>> = {
  'dec/ddhca': [['T02001', 'T02002', 'T02003']],
  'dec/ddhcb': [
    ['T03001', 'T03002', 'T03003', 'T03004'],
    ['T04001', 'T04002'],
  ],
};

/**
 * Word why a result on tables that split `POPGROUP` groups can lack a group, a geography, or a
 * value, naming the other tables of each family a requested code belongs to. Costs no request: the
 * exact table a group sits in at a geography takes up to three requests per geography to find, so
 * the guidance names where to look instead.
 *
 * Returns `''` when no requested code is in such a table, or when `singleCell` says the request
 * named one geography and one group and its codes come from one table — a value came back and
 * nothing beside it can be missing. Codes from several tables always get the guidance: the Census
 * answers only where the first-listed table publishes the group, so a later table that does not
 * publish it there reads null, and the reverse order returns nothing. Only a measure code — a table
 * prefix with a digit, then `_` — names a table: `GEO_ID` and `NAME` are columns of every table and
 * play no part in which rows come back.
 */
export function describeTableSplit(
  codes: readonly string[],
  dataset: string,
  singleCell: boolean,
): string {
  const tables = [...new Set(codes.filter((code) => /^[A-Z]+\d\w*_/.test(code)).map(tableOfCode))];
  const families = (POPGROUP_TABLE_FAMILIES[dataset] ?? []).flatMap((family) => {
    const requested = tables.filter((table) => family.includes(table));
    return requested.length > 0 ? [{ family, requested }] : [];
  });
  if (families.length === 0 || (singleCell && tables.length === 1)) return '';

  const only = families.map(({ family }) => `only one of ${listCodes(family)}`).join(', and in ');
  const elsewhere = families
    .map(({ family, requested }, i) => {
      const others = family.filter((table) => !requested.includes(table));
      const candidates = others.length > 0 ? listCodes(others, 'or') : 'another of them';
      return i === 0
        ? `a group or geography missing from ${listCodes(requested, 'or')} may be published in ${candidates} at that geography instead`
        : `one missing from ${listCodes(requested, 'or')} in ${candidates}`;
    })
    .join(', ');
  const parts = [
    `Each geography publishes a POPGROUP group in ${only}, so ${elsewhere}, or not at all.`,
  ];
  if (tables.length > 1) {
    parts.push(
      `With codes from more than one table, rows follow the first-listed one, ${tables[0]}: a group or geography it does not publish has no row, and a later table that does not publish the group there reads null. Query each table on its own to see every group it publishes.`,
    );
  }
  return parts.join(' ');
}

/**
 * The datasets that can publish a code, by its table prefix. ACS splits its table families across
 * datasets, so a code asked of the wrong one is unknown there and present in a sibling: `S1701`
 * lives in the subject tables, `S0201` alone in `acs/acs1/spp`, `DP1` in `dec/dp`. A prefix counts
 * only when a digit follows it, so `SEX`, `STATE`, and `CPOP` match no row and `CP03` is never read
 * as a `C` table. Decennial `P`/`H` tables sit in several `dec/*` datasets at once and the
 * business and estimate datasets carry no table prefix, so neither has a row.
 */
const SIBLING_CANDIDATES: ReadonlyArray<readonly [prefix: string, datasets: readonly string[]]> = [
  ['CP', ['acs/acs5/cprofile', 'acs/acs1/cprofile']],
  ['DP', ['acs/acs5/profile', 'acs/acs1/profile', 'dec/dp']],
  ['B', ['acs/acs5', 'acs/acs1']],
  ['C', ['acs/acs5', 'acs/acs1']],
  ['S', ['acs/acs5/subject', 'acs/acs1/subject', 'acs/acs1/spp']],
  ['K', ['acs/acsse']],
];

/** Most tables one failed lookup probes siblings for. */
const SIBLING_LOOKUP_TABLE_LIMIT = 5;

/**
 * The one deadline every sibling probe for an error shares. A per-variable lookup measured
 * 0.30–0.77 s, so 2.5 s covers the longest chain — three candidates — at the slowest of them; tables
 * are probed in parallel, so more tables do not lengthen it.
 */
export const SIBLING_LOOKUP_DEADLINE_MS = 2_500;

/** `acs/acs5/subject` and `acs/acs5` are one survey; `acs/acs1/spp` is another. */
function surveyOf(dataset: string): string {
  return dataset.split('/').slice(0, 2).join('/');
}

/** The table a variable code belongs to: `S1701` for `S1701_C03_001E`. */
function tableOfCode(code: string): string {
  return code.split('_')[0] ?? code;
}

/**
 * A code as the per-variable endpoint spells it. That endpoint matches case, and every column is
 * uppercase except the comparison profiles' significance columns (`CP03_2024to2019_062SS`), so the
 * uppercased form a missing code arrives in would 404 in the very dataset that publishes it.
 */
function publishedSpelling(code: string): string {
  return code.replace(/^(CP\d{2}(?:PR)?_\d{4})TO(\d{4}_\d+SS)$/, '$1to$2');
}

/**
 * The datasets to probe for a code missing from `dataset`, in order: the requested dataset left
 * out, only those listed for `year`, and the requested survey's own datasets first.
 */
function siblingCandidates(code: string, dataset: string, year: number): string[] {
  const row = SIBLING_CANDIDATES.find(
    ([prefix]) => code.startsWith(prefix) && /\d/.test(code.charAt(prefix.length)),
  );
  const listed = (row?.[1] ?? []).filter(
    (candidate) => candidate !== dataset && DATASET_AVAILABLE_YEARS[candidate]?.includes(year),
  );
  const survey = surveyOf(dataset);
  return [
    ...listed.filter((candidate) => surveyOf(candidate) === survey),
    ...listed.filter((candidate) => surveyOf(candidate) !== survey),
  ];
}

/**
 * The recovery sentence for missing codes a sibling dataset was confirmed to hold:
 * `S1701_C03_001E is in acs/acs5/subject — query that dataset instead.` The dataset and year that
 * lack them are the diagnosis the paired message already states, and the sibling was confirmed for
 * that same year, so neither is named again.
 */
export function describeSiblingHolders(holders: ReadonlyMap<string, string>): string {
  const bySibling = Map.groupBy(holders, ([, sibling]) => sibling);
  const parts = [...bySibling].map(([sibling, entries]) => {
    const codes = entries.map(([code]) => code);
    return `${listCodes(codes)} ${codes.length === 1 ? 'is' : 'are'} in ${sibling}`;
  });
  return `${listCodes(parts)} — query ${bySibling.size === 1 ? 'that dataset' : 'those datasets'} instead.`;
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
 * Word the recovery for a comparison that came back with several rows per geography. A rank is a
 * statement about one geography, so a ranking that lists the same one twice with two different
 * numbers is wrong however the rows are labelled — the fix is to pin the record, and the values
 * observed in the response are what the caller pins it to. The row count is the diagnosis, which
 * the paired message states, so the hint carries only the pin and the values to pick from.
 */
export function describeAmbiguousRows(
  observed: Record<string, Array<{ code: string; label: string }>>,
): string {
  const splitting = splittingRecordColumns(observed);
  if (!splitting) {
    return "Set the dataset's filter dimensions explicitly in predicates — census_list_predicate_values enumerates the codes each one accepts — or query one geography at a time with census_query_data.";
  }
  const named = splitting.entries
    .map(([code, values]) => `${code} took ${quoteValues(values)}`)
    .join('; ');
  return `Add the record you want to predicates, e.g. ${splitting.example} — ${named} in this response. census_query_data returns every record for a single geography, each labelled, if you want to see them side by side first.`;
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
 * Word why a predicated query came back empty, for the `no_data` recovery hint. Covers three
 * causes: a requested table that does not publish the group at that geography while a sibling
 * table does (`dec/ddhca` `T02003` lacks `1360`, which `T02002` publishes), a dimension left unset
 * (`ecnbasic` publishes nothing below the national level until an industry is named), and a
 * supplied value that does not exist (an unknown `NAICS2017` value is a `204`, not a `400`). The
 * sibling tables lead, since the value is usually valid there. Returns `''` when none applies, so
 * the caller falls back to its own dataset-aware hint.
 */
export function describeEmptyPredicatedResult(
  unset: UnsetPredicate[],
  supplied: string[],
  dataset: string,
  year: number,
  variables: readonly string[],
): string {
  const split = describeTableSplit(variables, dataset, false);
  const parts: string[] = split ? [split] : [];

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

/**
 * Time groups.json gets, every attempt and backoff included. It only adds `universe`, so a stalled
 * one must not hold the call past the 60-second request timeout MCP SDK clients default to — four
 * 30-second attempt timeouts plus backoff came to 139 s. Four fast failures and their 2/4/8 s
 * backoff (at most 17.5 s with jitter) still fit; a fetch measured under 2 s.
 */
const UNIVERSE_DEADLINE_MS = 20_000;

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
  /**
   * Universe per table from groups.json, loaded on the first lookup that needs one. Unset after a
   * failed read, so the next lookup tries again.
   */
  universes?: Map<string, string>;
  variables: Map<string, CensusVariable>;
}

/** The entry's spelling of a code given in any case, or the code uppercased when it lists none. */
function spellingIn(entry: CacheEntry, code: string): string {
  const upper = code.toUpperCase();
  return entry.spellings.get(upper) ?? upper;
}

/**
 * Why a query shaped like a code matched nothing, in the dataset's spelling of the code: a column
 * the dataset lists only as an attribute, a code a sibling dataset was confirmed to hold, or
 * neither.
 */
export type CodeMiss =
  | { kind: 'attribute'; code: string }
  | { kind: 'sibling'; code: string; sibling: string }
  | { kind: 'absent'; code: string };

export class VariableCacheService {
  private readonly cache = new Map<string, CacheEntry>();

  /**
   * Search variables by a code or by keywords across label and concept fields. `rankVariables`
   * holds the matching and ordering rule; a single-token query also reaches it as a code, in the
   * dataset's own spelling.
   *
   * A single token shaped like a code (`looksLikeCode`) that matched no code and no variable
   * whole — nothing at all, or only some of its words (`CP03_2024_062E` shares "2024" with every
   * income label) — gets a `codeMiss`: an attribute column the dataset lists (no request), or else
   * the sibling dataset that holds it (`findSiblingDatasets`, a variable code by
   * `variables/<code>.json` and a table ID by `groups/<id>.json`). Either one replaces the
   * most-words keyword results, which hold only fragments of the code. A code neither one
   * explains keeps those results, or is `absent` when there were none. Only this path sends a
   * request past variables.json, and a lookup that fails counts as no sibling rather than failing
   * the search.
   */
  async searchVariables(
    params: { query: string; dataset: string; year: number; limit: number },
    ctx: Context,
  ): Promise<VariableSearchResult & { codeMiss?: CodeMiss }> {
    const { dataset, year } = params;
    const entry = await this.getEntry(dataset, year, ctx);
    const token = codeToken(params.query);
    const code = token === undefined ? undefined : spellingIn(entry, token);
    const result = rankVariables(entry.variables, params.query, params.limit, code);
    const unmatched = result.totalMatches === 0 || result.matchedTermCount < result.termCount;
    if (!unmatched || code === undefined || !looksLikeCode(code)) return result;

    const empty = { ...result, variables: [], totalMatches: 0, matchedTermCount: 0 };
    if (entry.attributeNames.has(code)) return { ...empty, codeMiss: { kind: 'attribute', code } };
    const kind = code.includes('_') ? 'variables' : 'groups';
    const sibling = (await this.findSiblingDatasets([code], dataset, year, ctx, kind)).get(code);
    if (sibling) return { ...empty, codeMiss: { kind: 'sibling', code, sibling } };
    return result.totalMatches > 0 ? result : { ...result, codeMiss: { kind: 'absent', code } };
  }

  /**
   * The dataset's own spelling of each code, matched regardless of case. Every column is uppercase
   * except the comparison profiles' significance columns (`CP03_2024to2019_062SS`), whose
   * uppercased form the Census API rejects. A code the dataset does not list comes back
   * uppercased, so a rejection names it the way it names the caller's other codes. Reads the
   * cached variables.json, so it spends a request only when nothing has loaded it yet.
   */
  async resolveSpellings(
    codes: readonly string[],
    dataset: string,
    year: number,
    ctx: Context,
  ): Promise<string[]> {
    const entry = await this.getEntry(dataset, year, ctx);
    return codes.map((code) => spellingIn(entry, code));
  }

  /**
   * Find the sibling dataset that publishes each code `dataset` lacks, for a recovery hint.
   * Returns each confirmed code mapped to the sibling that holds it; a code with no confirmed
   * sibling is left out.
   *
   * The code's table prefix picks the candidates (`SIBLING_CANDIDATES`), and each candidate is
   * asked for the code on its own: `variables/<code>.json` for a variable, `groups/<id>.json` for a
   * table ID, where a 200 holds it and a 404 does not. One chain runs per table — the first code of
   * each — for at most the first five tables, all under one deadline. The probes are a hint, never
   * the answer: one that fails or runs out of time ends its chain and leaves that code out, and they
   * go outside `withRetry`, so a probe expected to 404 spends no retry budget. A caller's
   * cancellation is rethrown, never answered with a partial result.
   */
  async findSiblingDatasets(
    codes: readonly string[],
    dataset: string,
    year: number,
    ctx: Context,
    kind: 'variables' | 'groups' = 'variables',
  ): Promise<Map<string, string>> {
    const chains = new Map<string, { code: string; candidates: string[] }>();
    for (const code of codes) {
      const table = kind === 'groups' ? code : tableOfCode(code);
      if (chains.has(table)) continue;
      const candidates = siblingCandidates(code, dataset, year);
      if (candidates.length > 0) chains.set(table, { code, candidates });
      if (chains.size === SIBLING_LOOKUP_TABLE_LIMIT) break;
    }
    if (chains.size === 0) return new Map();

    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new Error('Sibling dataset lookup ran out of time.')),
      SIBLING_LOOKUP_DEADLINE_MS,
    );
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, deadline.signal]) : deadline.signal;
    try {
      const found = await Promise.all(
        [...chains.values()].map(async ({ code, candidates }) => {
          for (const candidate of candidates) {
            const outcome = await this.probeSibling(
              candidate,
              year,
              kind,
              publishedSpelling(code),
              signal,
              ctx,
            );
            if (outcome === 'holds') return [[code, candidate] as const];
            if (outcome === 'failed') return [];
          }
          return [];
        }),
      );
      return new Map(found.flat());
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Get metadata for specific variable codes, in the order given, with each one's table universe.
   * Throws `variable_not_found` naming every code the dataset has no column for, before any
   * further request to it goes out; its recovery names the sibling dataset that publishes a
   * missing code where one is confirmed (`findSiblingDatasets`).
   *
   * A code variables.json lists only inside an entry's `attributes` is resolved from the
   * per-variable endpoint, which publishes its label and the column it belongs to. A code in any
   * case resolves to the dataset's own spelling.
   *
   * When groups.json fails (`getUniverses`), each variable that belongs to a single table comes
   * back without `universe` and marked `universeUnavailable`, rather than failing the lookup.
   */
  async getVariablesByCode(
    requested: string[],
    dataset: string,
    year: number,
    ctx: Context,
  ): Promise<CensusVariable[]> {
    const entry = await this.getEntry(dataset, year, ctx);
    const codes = requested.map((code) => spellingIn(entry, code));
    const missing = codes.filter(
      (code) => !entry.variables.has(code) && !entry.attributeNames.has(code),
    );

    if (missing.length > 0) {
      const holders = await this.findSiblingDatasets(missing, dataset, year, ctx);
      const search = 'census_search_variables to find valid codes for this dataset and year.';
      // One probe runs per table, so a code whose table a probe placed in a sibling is pointed
      // there too — never back at the dataset that cannot hold it.
      const tableHolders = new Map(
        [...holders].map(([code, sibling]) => [tableOfCode(code), sibling]),
      );
      const rest = missing.filter((code) => !holders.has(code));
      const sameTable = Map.groupBy(
        rest.filter((code) => tableHolders.has(tableOfCode(code))),
        (code) => tableHolders.get(tableOfCode(code)) as string,
      );
      const unplaced = rest.filter((code) => !tableHolders.has(tableOfCode(code)));
      const hints = [
        ...(holders.size > 0 ? [describeSiblingHolders(holders)] : []),
        ...[...sameTable].map(
          ([sibling, sameCodes]) =>
            `${listCodes(sameCodes)} ${sameCodes.length === 1 ? 'is' : 'are'} from a table found in ${sibling}; look ${sameCodes.length === 1 ? 'it' : 'them'} up there.`,
        ),
        ...(unplaced.length === 0
          ? []
          : [holders.size === 0 ? `Use ${search}` : `For ${listCodes(unplaced)}, use ${search}`]),
      ];
      throw notFound(`Variable codes not found in ${dataset} (${year}): ${missing.join(', ')}`, {
        reason: 'variable_not_found',
        missingCodes: missing,
        dataset,
        year,
        recovery: { hint: hints.join(' ') },
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
      : new Map<string, string>();

    return resolved.map((variable) => {
      const table = tableOf(variable);
      if (!table) return variable;
      if (!universes) return { ...variable, universeUnavailable: true };
      const universe = universes.get(table);
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
   * Pick the measure variables to probe with when checking which of a dimension's codes the
   * dataset actually publishes rows for; the published set is the union of what each one returns.
   *
   * A wildcard group-by answers from the dataset's published value map when every requested
   * column can be served from metadata, and only reads the data file when a measure is among
   * them — so which measure is requested decides the answer. Coverage is per table. On
   * `dec/ddhca` the total-population table publishes 2,996 population groups and every
   * sex-by-age table a subset of them, so one measure from the coarsest table, which cell count
   * identifies, gives the widest set.
   *
   * The sex-by-age tables do not nest among themselves, though — each publishes groups the others
   * do not (see `POPGROUP_TABLE_FAMILIES`) — and on `dec/ddhcb` every table belongs to such a
   * family, so no single table holds every group. When the coarsest table is one of them, the
   * check probes one measure per table of the dataset's smallest family instead: each family
   * splits the same groups, so the one with the fewest tables is the cheapest complete union, at
   * one request per table per cache refresh.
   */
  async findPublicationProbes(dataset: string, year: number, ctx: Context): Promise<string[]> {
    const variables = await this.getVariables(dataset, year, ctx);
    const tables = new Map<string, string[]>();
    for (const v of variables.values()) {
      // Geography and metadata columns carry `group: "N/A"` and measure nothing.
      if (v.required || v.predicateType !== 'int' || !v.group || v.group === 'N/A') continue;
      const members = tables.get(v.group) ?? [];
      members.push(v.code);
      tables.set(v.group, members);
    }
    const firstMeasureOf = (table: string) => tables.get(table)?.sort().slice(0, 1) ?? [];
    const [coarsest] = [...tables.keys()].sort(
      (a, b) => (tables.get(a)?.length ?? 0) - (tables.get(b)?.length ?? 0) || a.localeCompare(b),
    );
    if (coarsest === undefined) return [];

    const families = POPGROUP_TABLE_FAMILIES[dataset] ?? [];
    if (!families.some((family) => family.includes(coarsest))) return firstMeasureOf(coarsest);
    const [smallest] = [...families].sort((a, b) => a.length - b.length);
    return (smallest ?? []).flatMap(firstMeasureOf);
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
      throw notFound(`Unknown dataset: "${dataset}".`, {
        reason: 'dataset_not_found',
        dataset,
        recovery: DATASET_RECOVERY,
      });
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
   * `variables_unavailable`. `deadlineMs` bounds every attempt and backoff together, for a
   * document the lookup can answer without.
   */
  private fetchMetadata(
    url: string,
    what: string,
    scope: { dataset: string; year: number },
    ctx: Context,
    {
      mapError = (error) => error,
      deadlineMs,
    }: { mapError?: (error: unknown) => unknown; deadlineMs?: number } = {},
  ): Promise<unknown> {
    return withRetry(
      async ({ signal, remainingMs }) => {
        let response: Response;
        try {
          const timeoutMs = Math.min(30_000, remainingMs);
          response = await fetchWithTimeout(url, timeoutMs, ctx as unknown as RequestContext, {
            signal,
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
            { reason: 'variables_unavailable' },
          );
        }

        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw serviceUnavailable(
            `Census ${what} could not be parsed for ${scope.dataset} (${scope.year}).`,
            { reason: 'variables_unavailable' },
          );
        }
      },
      {
        operation: 'VariableCacheService.getVariables',
        context: ctx as unknown as RequestContext,
        baseDelayMs: 2000,
        signal: ctx.signal,
        ...(deadlineMs !== undefined && { deadlineMs }),
      },
    );
  }

  /** The attribute record a failed per-variable fetch leaves the lookup without. */
  private metadataUnavailable(
    what: string,
    scope: { dataset: string; year: number },
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
      },
      { cause },
    );
  }

  /**
   * Ask one sibling dataset whether it publishes `code`, in a single request. A 404 is the
   * expected "no", logged at debug; anything else that fails is `failed`, unless the caller has
   * gone, which is rethrown.
   */
  private async probeSibling(
    sibling: string,
    year: number,
    kind: 'variables' | 'groups',
    code: string,
    signal: AbortSignal,
    ctx: Context,
  ): Promise<'holds' | 'absent' | 'failed'> {
    const url = `${CENSUS_API_BASE}/${year}/${sibling}/${kind}/${encodeURIComponent(code)}.json`;
    try {
      // Past the shared deadline, so that deadline — not a per-probe timeout — ends a slow probe.
      const response = await fetchWithTimeout(
        url,
        SIBLING_LOOKUP_DEADLINE_MS * 2,
        ctx as unknown as RequestContext,
        { signal, expectedStatuses: [404] },
      );
      await response.body?.cancel();
      return 'holds';
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      return error instanceof McpError && error.data?.status === 404 ? 'absent' : 'failed';
    }
  }

  /**
   * Resolve one attribute column from the per-variable endpoint. Any failure is
   * `variables_unavailable`: the code was found in the dataset's own attributes index, so a miss
   * here is the endpoint failing rather than the code not existing. A caller's cancellation is
   * rethrown as it arrived.
   *
   * `attribute type` is the one published value normalized here, to upper-snake case: vintages
   * spell the same kind `Annotation` and `ANNOTATION`, `Margin of Error` and `MARGIN_OF_ERROR`.
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
      if (ctx.signal?.aborted) throw error;
      throw this.metadataUnavailable(what, { dataset, year }, error);
    }

    const variable: CensusVariable = {
      code,
      label: raw.label ?? '',
      predicateType: raw.predicateType ?? 'string',
    };
    if (raw.concept && !isSharedAcrossTables(raw.group)) variable.concept = raw.concept;
    if (raw.group) variable.group = raw.group;
    if (raw['attribute of']) variable.attributeOf = raw['attribute of'];
    const attributeType = raw['attribute type']?.trim().toUpperCase().replace(/\s+/g, '_');
    if (attributeType) variable.attributeType = attributeType;
    return variable;
  }

  /**
   * Universe per table, from groups.json, cached on the entry so it expires with variables.json.
   * A dataset that publishes no groups.json (a 404) has no universes. Any other failure — once
   * retries are spent or `UNIVERSE_DEADLINE_MS` has passed, or a body with no `groups` list —
   * returns `undefined` and caches nothing, so the next lookup asks again; the variables are still
   * answered from variables.json. A caller's cancellation is rethrown, never turned into a lookup
   * without universes.
   */
  private async getUniverses(
    entry: CacheEntry,
    dataset: string,
    year: number,
    ctx: Context,
  ): Promise<Map<string, string> | undefined> {
    if (entry.universes) return entry.universes;

    const universes = new Map<string, string>();
    let raw: RawGroupsJson | undefined;
    try {
      raw = (await this.fetchMetadata(
        `${CENSUS_API_BASE}/${year}/${dataset}/groups.json`,
        'groups.json',
        { dataset, year },
        ctx,
        { deadlineMs: UNIVERSE_DEADLINE_MS },
      )) as RawGroupsJson;
      // Every dataset answers with a `groups` array, empty where it publishes no tables.
      if (!Array.isArray(raw?.groups)) {
        throw serviceUnavailable(
          `Census groups.json for ${dataset} (${year}) carried no groups list.`,
          { reason: 'variables_unavailable' },
        );
      }
    } catch (error) {
      // Checked on the signal: an abort during the retry backoff rethrows its raw reason.
      if (ctx.signal?.aborted) throw error;
      if (!(error instanceof McpError && error.data?.status === 404)) {
        ctx.log.warning('groups.json could not be fetched; returning variables without universe', {
          dataset,
          year,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
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
      {
        mapError: (error) =>
          censusHttpError(error, {
            dataset,
            year,
            availableYears: DATASET_AVAILABLE_YEARS[dataset],
          }),
      },
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
