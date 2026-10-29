/**
 * @fileoverview Census Bureau Data API service. Handles data queries, response parsing,
 * and suppression code resolution for api.census.gov/data endpoints.
 * @module services/census-api/census-api-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError, serviceUnavailable, unauthorized } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, type RequestContext, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getDiscoveryConfig, getServerConfig } from '@/config/server-config.js';
import {
  DATASET_AVAILABLE_YEARS,
  describeSiblingHolders,
  getVariableCacheService,
  isAcsDataset,
} from '@/services/variable-cache/variable-cache-service.js';
import { censusDeadlineError, censusHttpError, FIRST_UNKNOWN_ONLY } from './errors.js';
import type {
  CensusDataRow,
  CensusGeographyLevel,
  CensusPredicateValue,
  CensusRawResponse,
  CensusVariableValue,
  GeographyCheck,
  SuppliedParent,
} from './types.js';
import {
  ACS_CONTROLLED_MOE,
  ACS_OPEN_ENDED_MOE,
  ACS_SENTINEL_REASONS,
  CENSUS_FLAGS,
} from './types.js';

const CENSUS_API_BASE = 'https://api.census.gov/data';

/** The Census API rejects a request whose `get=` list names more than this many columns. */
const GET_COLUMN_LIMIT = 50;

/** Longest one data-endpoint attempt may run, response body included. */
const DATA_ATTEMPT_TIMEOUT_MS = 15_000;

/**
 * Time a data-endpoint request gets, every attempt and backoff included. Without it a hung
 * endpoint held the call through four 15-second attempts and their backoff, about 67 s — past the
 * 60-second request timeout MCP SDK clients default to, so the caller saw a client timeout rather
 * than this server's error. Every California block group on acs/acs5 2024 with 49 variables
 * answered in 11–14 s end to end, so the first attempt keeps its full 15 s and a second full
 * attempt still fits after a fast transient failure. A hung endpoint settles here, 20 s inside the
 * client default once the metadata requests ahead of it are cached; those requests carry no
 * deadline of their own.
 */
const DATA_REQUEST_DEADLINE_MS = 40_000;

/**
 * Zero-pad a fixed-width parent FIPS code to the width the Census API matches on, returning
 * undefined for a blank value so it reads as omitted. State codes are 2 digits and county codes
 * 3; the API compares them literally, so `state:5` finds nothing where `state:05` finds Arkansas.
 *
 * `*` is a scope, not a code — `in=state:53 county:*` is the only way to reach every block group
 * in a state — so it passes through untouched rather than becoming `00*`.
 */
export function padFips(value: string | undefined, width: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return;
  return trimmed === '*' ? trimmed : trimmed.padStart(width, '0');
}

/**
 * Canonicalize caller variable codes to the uppercase form they are compared and deduplicated in.
 * The Census API matches `get=` case-sensitively — `b19013_001e` is a 400 — and every column is
 * uppercase except the comparison profiles' significance columns (`CP03_2024to2019_062SS`), so the
 * data tools pass these codes through `VariableCacheService.resolveSpellings` for the spelling the
 * request sends and the response is keyed by. No two columns collide once uppercased, so the
 * mapping is one-to-one. A blank code names no column, so it is dropped the way a blank scope input
 * is, and a repeat is dropped because the response is keyed by code and can hold each one once.
 */
export function normalizeVariableCodes(codes: readonly string[]): string[] {
  return [...new Set(codes.map((code) => code.trim().toUpperCase()).filter(Boolean))];
}

/**
 * Canonicalize a caller's predicate map. Keys are uppercased, since no supported dataset defines a
 * lowercase variable and `naics2017` has exactly one meaning. Values are trimmed, and a blank value
 * is dropped: the Census API reads `NAICS2017=` as a group-by over every category, the same as
 * `*`, while a blank is what a form-based client sends for a field it left empty — and "blank is
 * treated as omitted" is the rule the scope inputs already follow.
 *
 * `*` stays. A per-category breakdown of one geography is a real query, so its dimensions are
 * returned as `wildcards` for the rows to be labelled with the category each one is.
 */
export function normalizePredicates(input: Record<string, string> | undefined): {
  predicates: Record<string, string>;
  wildcards: string[];
} {
  const predicates: Record<string, string> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    const trimmed = value.trim();
    if (trimmed) predicates[key.trim().toUpperCase()] = trimmed;
  }
  return {
    predicates,
    wildcards: Object.keys(predicates).filter((code) => predicates[code] === '*'),
  };
}

/**
 * A dimension a predicate set to `*`. The API echoes its code on every row; `labelColumn` is the
 * dimension's own `_LABEL`/`_DESC` attribute, requested alongside when the dataset publishes one.
 */
export interface WildcardColumn {
  code: string;
  labelColumn?: string;
}

/** Every family of column a data query can put in `get=`, beyond `NAME`. */
export interface QueryColumns {
  /** Label attribute per filter dimension the query left unset, keyed by dimension code. */
  defaultLabelColumns?: Record<string, string>;
  /** Flag column per measure, keyed by the measure's code (e.g. `{ RCPTOT: 'RCPTOT_F' }`). */
  flagColumns?: Record<string, string>;
  /** Label column per record dimension, keyed by dimension code; both are requested. */
  recordColumns?: Record<string, string>;
  /** The caller's variable codes. */
  variables: string[];
  /** Dimensions a predicate set to `*`; only their label columns are requested. */
  wildcardColumns?: WildcardColumn[];
}

/**
 * The `get=` list a query sends, in order. `queryData` builds its request from this and
 * `planQueryColumns` counts it, so the count cannot drift from what goes over the wire.
 *
 * Each column appears once. A caller can name a column the server adds anyway — `MONTH_DESC` on
 * `pep/charv`, a flag or label column — and sending it twice would spend a second slot of the
 * 50-column limit on nothing.
 */
export function getColumnsFor(columns: QueryColumns): string[] {
  return [
    ...new Set([
      'NAME',
      ...columns.variables,
      ...Object.values(columns.defaultLabelColumns ?? {}),
      ...Object.entries(columns.recordColumns ?? {}).flat(),
      ...(columns.wildcardColumns ?? []).flatMap((w) => (w.labelColumn ? [w.labelColumn] : [])),
      ...Object.values(columns.flagColumns ?? {}),
    ]),
  ];
}

/** Outcome of fitting a query's columns under `GET_COLUMN_LIMIT`. */
export type ColumnPlan =
  | {
      status: 'over_limit';
      /** Columns the query would need, counting every one the server adds. */
      columnCount: number;
      /** Most variable codes this query can carry once the added columns are counted. */
      maxVariables: number;
      /** The columns the server adds that count against the limit: NAME, label, and record columns. */
      addedColumns: string[];
    }
  | {
      status: 'ok';
      /** Wildcard dimensions to send, each with its label column only when it fit. */
      wildcardColumns: WildcardColumn[];
      /** Flag columns that fit. */
      flagColumns: Record<string, string>;
      /** Wildcarded dimensions whose label column did not fit — their rows carry the code alone. */
      unlabelledWildcards: string[];
      /** Measures whose flag column did not fit — a withheld value among them cannot be told apart. */
      uncheckedFlags: string[];
    };

/**
 * Fit a query's columns under the Census API's 50-column `get=` limit.
 *
 * `NAME`, the caller's codes, and the default-label and record columns are sent whatever the
 * dataset, so they decide whether the query can run at all; past the limit, the plan says how many
 * codes it can carry instead. Wildcard label columns and then flag columns are extras: they take
 * whatever room is left, in that order, and the ones that do not fit are named rather than sent.
 * Adding them never turns a query that fit into one the API rejects.
 */
export function planQueryColumns(columns: QueryColumns): ColumnPlan {
  const { wildcardColumns = [], flagColumns = {}, ...fixed } = columns;
  const required = getColumnsFor(fixed);
  if (required.length > GET_COLUMN_LIMIT) {
    const addedColumns = getColumnsFor({ ...fixed, variables: [] });
    return {
      status: 'over_limit',
      columnCount: required.length,
      maxVariables: GET_COLUMN_LIMIT - addedColumns.length,
      addedColumns,
    };
  }

  let room = GET_COLUMN_LIMIT - required.length;
  // An optional column already on the list — the caller named it — costs nothing more to keep.
  const sent = new Set(required);
  const fits = (column: string) => {
    if (sent.has(column)) return true;
    if (room === 0) return false;
    sent.add(column);
    room--;
    return true;
  };

  const fittedWildcards: WildcardColumn[] = [];
  const unlabelledWildcards: string[] = [];
  for (const wildcard of wildcardColumns) {
    if (!wildcard.labelColumn || fits(wildcard.labelColumn)) {
      fittedWildcards.push(wildcard);
    } else {
      fittedWildcards.push({ code: wildcard.code });
      unlabelledWildcards.push(wildcard.code);
    }
  }

  const fittedFlags: Record<string, string> = {};
  const uncheckedFlags: string[] = [];
  for (const [code, column] of Object.entries(flagColumns)) {
    if (fits(column)) {
      fittedFlags[code] = column;
    } else {
      uncheckedFlags.push(code);
    }
  }

  return {
    status: 'ok',
    wildcardColumns: fittedWildcards,
    flagColumns: fittedFlags,
    unlabelledWildcards,
    uncheckedFlags,
  };
}

/** Word a query that would exceed the column limit, naming the real per-call maximum and why. */
export function describeColumnLimit(
  requested: number,
  plan: { maxVariables: number; addedColumns: string[] },
): string {
  const added = plan.addedColumns.filter((column) => column !== 'NAME');
  const addedPart =
    added.length > 0
      ? `, plus the ${added.length} label and record column${added.length === 1 ? '' : 's'} added for this dataset (${added.join(', ')})`
      : '';
  return `${requested} variable codes requested, but this query can carry at most ${plan.maxVariables}: the Census API accepts ${GET_COLUMN_LIMIT} columns per request, and every query also sends NAME${addedPart}.`;
}

/**
 * Word what the column limit left out of a query that still ran, or `undefined` when nothing was.
 * A missing flag column is the serious one: a value the Census withheld reads as a real `0`
 * without it, so the codes it covers are named.
 */
export function describeColumnBudget(plan: {
  uncheckedFlags: string[];
  unlabelledWildcards: string[];
}): string | undefined {
  const parts: string[] = [];
  if (plan.uncheckedFlags.length > 0) {
    parts.push(
      `Flags were not checked for ${plan.uncheckedFlags.join(', ')}: the Census API accepts ${GET_COLUMN_LIMIT} columns per request and this one had no room left for their flag columns, so a value the Census withheld there reads as 0 rather than as withheld. Query those codes in a call with fewer variables to check them.`,
    );
  }
  if (plan.unlabelledWildcards.length > 0) {
    parts.push(
      `No room was left under the ${GET_COLUMN_LIMIT}-column limit for the label column of ${plan.unlabelledWildcards.join(', ')}, so each row's record carries that category's code as its label. Query fewer variables to get the labels.`,
    );
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * The distinct values each record column took across a response, keyed by column code. A column
 * that took one value did not split anything; one that took several is why a geography came back
 * on several rows, and its codes are what a caller pins the record with.
 */
export function observeRecordValues(
  rows: CensusDataRow[],
): Record<string, Array<{ code: string; label: string }>> {
  const observed = new Map<string, Map<string, string>>();
  for (const row of rows) {
    for (const [column, value] of Object.entries(row.record ?? {})) {
      const values = observed.get(column) ?? new Map<string, string>();
      values.set(value.code, value.label);
      observed.set(column, values);
    }
  }
  return Object.fromEntries(
    [...observed].map(([column, values]) => [
      column,
      [...values]
        .map(([code, label]) => ({ code, label }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    ]),
  );
}

/**
 * Read one cell of a Census response into a value entry.
 *
 * Not every cell a caller can request is a number. `GEO_ID` carries `"0500000US53033"` on every
 * dataset and `pep/charv` `UNIVERSE` carries `"R"`; coercing those with `Number` produces `NaN`,
 * which serializes to the same `null` the response uses for a geography that has no value — so
 * the text is lost and what is left cannot be told apart from missing data. Text is kept under
 * `value` instead, leaving `estimate` null and `suppressed` false: `value` present means the cell
 * is text, `suppressed` means the Census withheld the number, and a bare null means the cell was
 * empty.
 *
 * The read is per cell rather than per variable for two reasons. The dataset's own declared type
 * does not survive contact with the data: `variables.json` declares the ACS median-year-built
 * codes (`B25035_001E` and the `B25037`/`B25039` families) `predicateType: "string"`, and they
 * serve ordinary years like `"1983"` that callers rank and average. And text is not always a
 * property of the whole column — the older ACS profile vintages write "not applicable" as the
 * literal `"(X)"` in a column that is a number everywhere else, which reaches the caller as that
 * annotation rather than as an unexplained null.
 *
 * A number below −100,000,000 is a Census sentinel, never a measurement. On ACS it resolves by
 * numeric value against the Census table, so the float form the subject and profile percent
 * columns use (`-666666666.0`) reads like the integer one, and the controlled-estimate MOE
 * (`-555555555`) is the number zero the Census says to treat it as. Outside ACS the value is still
 * withheld, but carries no reason: that table is ACS's, and the other families withhold through
 * flag columns instead.
 */
function readValue(rawValue: string | null, varCode: string, acs: boolean): CensusVariableValue {
  const text = rawValue?.trim() ?? '';
  const numValue = text === '' ? null : Number(text);
  const isNumber = numValue !== null && !Number.isNaN(numValue);

  if (acs && numValue === ACS_CONTROLLED_MOE) {
    return { estimate: 0, label: varCode, suppressed: false };
  }

  const suppressed = isNumber && numValue < -100_000_000;
  const suppressionReason = acs && isNumber ? ACS_SENTINEL_REASONS.get(numValue) : undefined;

  return {
    estimate: suppressed || !isNumber ? null : numValue,
    label: varCode,
    suppressed,
    ...(suppressionReason && { suppressionReason }),
    ...(!isNumber && text !== '' && { value: text }),
  };
}

/**
 * Apply the business-dataset flag published beside a measure. A withheld cell holds `0` in the
 * measure, so the flag is the only thing that separates it from a real zero: a withholding symbol
 * replaces the number with a suppression, and an annotating one (revised, a high relative standard
 * error) keeps the figure and rides along with it. A range symbol (a noise or data-quality band)
 * beside a `0` is the value a range column publishes, so the zero is a placeholder and the band is
 * reported in its place; beside a nonzero figure it annotates. A symbol with no published meaning
 * is treated as withholding — reading its zero as a measurement is the failure this exists to stop.
 */
function applyFlag(
  value: CensusVariableValue,
  rawFlag: string | null | undefined,
): CensusVariableValue {
  const code = rawFlag?.trim();
  if (!code) return value;

  const known = CENSUS_FLAGS.get(code);
  const flag = {
    code,
    meaning:
      known?.meaning ??
      `Flagged "${code}", a symbol the Census documentation for this dataset does not define, so the value beside it is not read as a number`,
  };
  const placeholder = value.estimate === 0 || value.estimate === null;
  if (known?.effect === 'annotates' || (known?.effect === 'ranges' && !placeholder)) {
    return { ...value, flag };
  }
  return {
    estimate: null,
    label: value.label,
    suppressed: true,
    suppressionReason:
      known?.effect === 'ranges'
        ? `Published as a range rather than a number: ${flag.meaning}`
        : flag.meaning,
    flag,
  };
}

/**
 * Read a data-endpoint body into rows. Both keyed requests answer the same way, so both read it
 * here, inside their retry loops.
 *
 * An HTML page in place of JSON is one of two things. api.census.gov redirects a request whose key
 * it refuses to a page naming the key signup form, which no retry changes, so that page is
 * `missing_api_key` and ends the loop on its first answer. Any other page is an outage page, worth
 * retrying as `upstream_error`.
 */
function parseDataBody(status: number, text: string): CensusRawResponse {
  // A well-formed query that matches nothing answers 204 with an empty body — the caller's
  // problem is no data, not an unparseable upstream response worth retrying.
  if (status === 204 || text.trim() === '') return [];

  if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
    if (text.includes('Invalid Key') || text.includes('key_signup')) {
      throw unauthorized('The Census API rejected CENSUS_API_KEY as invalid.', {
        reason: 'missing_api_key',
      });
    }
    throw serviceUnavailable('Census API returned HTML instead of JSON.', {
      reason: 'upstream_error',
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw serviceUnavailable('Census API returned unparseable response.', {
      reason: 'upstream_error',
    });
  }

  if (!Array.isArray(parsed)) {
    throw serviceUnavailable('Census API response was not an array.', {
      reason: 'upstream_error',
    });
  }

  return parsed as CensusRawResponse;
}

/** What one geography.json entry makes of a call, and the changes that would satisfy it. */
interface EntryVerdict {
  check: Exclude<GeographyCheck, { status: 'level_not_supported' }>;
  /** Parents the call would have to add, as it stands. */
  missing: string[];
  /** Parents it would have to add with a `*` target. */
  missingUnderWildcard: string[];
  /** Supplied parents it would have to drop. */
  unaccepted: SuppliedParent[];
}

/** Judge a call against one entry for its level, by the entry's own `requires` list. */
function judgeEntry(
  level: CensusGeographyLevel,
  call: {
    geographyFips: string;
    supplied: SuppliedParent[];
    parentFips?: string;
    countyFips?: string;
    tractFips?: string;
  },
): EntryVerdict {
  const required = level.requires ?? [];
  // A `*` target lets the Census API infer the innermost optional parent and everything
  // below it — `optionalWithWCFor` names where that cutoff starts. Without it, or with a
  // concrete FIPS target, every required parent must be supplied.
  const cutoff = level.optionalWithWCFor ? required.indexOf(level.optionalWithWCFor) : -1;
  const underWildcard = cutoff >= 0 ? required.slice(0, cutoff) : required;
  const effective = call.geographyFips === '*' ? underWildcard : required;

  // A `*` parent stands in for every code only where the entry lists that parent under
  // `wildcard`; the Census API answers any other with a 400 ("wildcard not allowed for 'state'
  // in geography hierarchy"). Under a concrete tract it refuses `county:*` whatever the list says
  // ("wildcard mismatch"), since a tract code is unique only inside its county — including the
  // tract a single block group still has to add, so one retry names both. Either way the parent
  // needs a concrete code, so it counts as one still to add.
  const wildcards = level.wildcard ?? [];
  const starRefused = (name: string, mandatory: string[]) =>
    (name === 'state' && call.parentFips === '*' && !wildcards.includes('state')) ||
    (name === 'county' &&
      call.countyFips === '*' &&
      (!wildcards.includes('county') ||
        (required.includes('tract') &&
          (call.tractFips !== undefined || mandatory.includes('tract')))));
  const lacking = (mandatory: string[]) => (name: string) =>
    starRefused(name, mandatory) ||
    (mandatory.includes(name) && !call.supplied.some((parent) => parent === name));

  const missing = required.filter(lacking(effective));
  const missingUnderWildcard = required.filter(lacking(underWildcard));
  // The mirror of the missing-parent case: a parent the level never names produces an
  // `in=` clause the Census API answers with an opaque 400. Acceptance is a property of
  // the level, so it is checked against the full `requires` list rather than `effective` —
  // the `*` wildcard relaxes which parents are mandatory, never which ones are allowed.
  const unaccepted = call.supplied.filter((name) => !required.includes(name));
  const changes = { missing, missingUnderWildcard, unaccepted };

  if (missing.length > 0) {
    // A concrete target can demand parents (e.g. block group needs its tract) that a `*`
    // target would not — worth telling the caller, since `*` is an input they control.
    const wildcardRelaxes =
      call.geographyFips !== '*' && missingUnderWildcard.length < missing.length;
    // A parent to drop rides along, so one retry satisfies the entry rather than meeting
    // `parent_not_accepted` once the additions are in.
    return {
      ...changes,
      check: {
        status: 'parent_required',
        missingParents: missing,
        wildcardRelaxes,
        ...(unaccepted.length > 0 && { unacceptedParents: unaccepted }),
      },
    };
  }

  if (unaccepted.length > 0) {
    return {
      ...changes,
      check: {
        status: 'parent_not_accepted',
        unacceptedParents: unaccepted,
        acceptedParents: required,
      },
    };
  }

  return { ...changes, check: { status: 'ok', acceptedParents: required } };
}

interface GeographyLevelsCacheEntry {
  fetchedAt: number;
  levels: CensusGeographyLevel[];
}

interface PredicateValuesCacheEntry {
  fetchedAt: number;
  values: CensusPredicateValue[];
}

export class CensusApiService {
  /** geography.json per dataset+year — immutable upstream, cached for the discovery TTL. */
  private readonly geographyLevelsCache = new Map<string, GeographyLevelsCacheEntry>();

  /** Wildcard group-by enumerations per dataset+year+dimension+NAICS scope. */
  private readonly predicateValuesCache = new Map<string, PredicateValuesCacheEntry>();

  /**
   * The configured Census API key, read by each method that sends one before it builds a request.
   * The config parse leaves an unset, blank, or unsubstituted key undefined, so the keyless tools
   * keep working; here it becomes the `missing_api_key` the keyed tools declare.
   */
  private requireApiKey(): string {
    const { censusApiKey } = getServerConfig();
    if (!censusApiKey) {
      throw unauthorized(
        'CENSUS_API_KEY is not set, so this call cannot reach the Census data API.',
        {
          reason: 'missing_api_key',
        },
      );
    }
    return censusApiKey;
  }

  /**
   * Query a Census dataset for variables at a specific geography.
   * Returns parsed rows with sentinels and flags resolved.
   *
   * The caller is responsible for fitting the columns under `GET_COLUMN_LIMIT` first —
   * `planQueryColumns` says which optional columns fit.
   */
  async queryData(
    params: QueryColumns & {
      geographyLevel: string;
      geographyFips: string;
      /** State FIPS code — required for sub-state geography levels. */
      parentFips?: string;
      /** County FIPS code — required when querying tracts or block groups within a specific county. */
      countyFips?: string;
      /** 6-digit tract code — scopes a block-group or block query to one tract of the county. */
      tractFips?: string;
      /**
       * Dataset-specific filter values sent as extra query parameters, keyed by variable code
       * (e.g. `{ NAICS2017: '5112' }`). Omitting one the dataset requires is not an error
       * upstream — the API returns the aggregate across that dimension instead.
       */
      predicates?: Record<string, string>;
      dataset: string;
      year: number;
    },
    ctx: Context,
  ): Promise<CensusDataRow[]> {
    const censusApiKey = this.requireApiKey();

    /**
     * Beyond the caller's codes, `get=` carries: the label attribute of each filter dimension the
     * query left unset (`POPGROUP_LABEL` — requesting the bare code instead would flip the API
     * from applying one default to enumerating every category); both columns of each record
     * dimension (`MONTH`, `MONTH_DESC`), which name the record a row is without changing which
     * rows come back; the label column of each wildcarded dimension, whose code the API already
     * echoes; and each measure's flag column.
     */
    const varList = getColumnsFor(params).join(',');
    const forClause = `${params.geographyLevel}:${params.geographyFips}`;

    // Build compound in= clause, outermost scope first: state, then county, then tract.
    // checkGeography has already refused a tract without a concrete county.
    let inClause = '';
    if (params.parentFips) {
      inClause = `&in=state:${params.parentFips}`;
      if (params.countyFips) inClause += `%20county:${params.countyFips}`;
      if (params.tractFips) inClause += `%20tract:${params.tractFips}`;
    }

    const predicateKeys = Object.keys(params.predicates ?? {});
    const predicateClause = Object.entries(params.predicates ?? {})
      .map(([key, value]) => `&${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('');

    const url = `${CENSUS_API_BASE}/${params.year}/${params.dataset}?get=${encodeURIComponent(varList)}&for=${encodeURIComponent(forClause)}${inClause}${predicateClause}&key=${censusApiKey}`;

    ctx.log.debug('Census API query', {
      dataset: params.dataset,
      year: params.year,
      variables: params.variables,
      geographyLevel: params.geographyLevel,
      geographyFips: params.geographyFips,
      predicates: predicateKeys,
    });

    const raw = await withRetry(
      async ({ signal, remainingMs }) => {
        let response: Response;
        try {
          response = await fetchWithTimeout(
            url,
            Math.min(DATA_ATTEMPT_TIMEOUT_MS, remainingMs),
            ctx as unknown as RequestContext,
            { signal },
          );
        } catch (error) {
          throw censusHttpError(error, {
            dataset: params.dataset,
            year: params.year,
            availableYears: DATASET_AVAILABLE_YEARS[params.dataset],
            requestedCodes: params.variables,
          });
        }
        return parseDataBody(response.status, await response.text());
      },
      {
        operation: 'CensusApiService.queryData',
        context: ctx as unknown as RequestContext,
        baseDelayMs: 1000,
        signal: ctx.signal,
        deadlineMs: DATA_REQUEST_DEADLINE_MS,
      },
    ).catch(async (error: unknown) => {
      throw await this.pointAtSibling(censusDeadlineError(error, params), params, ctx);
    });

    return this.parseResponse(raw, params, ctx);
  }

  /**
   * A `variable_not_found` whose code a sibling dataset publishes, with a recovery naming that
   * dataset; any other error unchanged. Runs once, after the retry loop has given up, so the
   * sibling probes spend none of its budget.
   */
  private async pointAtSibling(
    error: unknown,
    scope: { dataset: string; year: number },
    ctx: Context,
  ): Promise<unknown> {
    if (!(error instanceof McpError) || error.data?.reason !== 'variable_not_found') return error;
    const holders = await getVariableCacheService().findSiblingDatasets(
      error.data.missingCodes as string[],
      scope.dataset,
      scope.year,
      ctx,
    );
    if (holders.size === 0) return error;
    return new McpError(error.code, error.message, {
      ...error.data,
      recovery: { hint: `${describeSiblingHolders(holders)} ${FIRST_UNKNOWN_ONLY}` },
    });
  }

  /**
   * Check a geography level and its supplied parents against the dataset's own
   * geography.json before spending a data query on a request the Census API will reject.
   *
   * geography.json can list one level name under several hierarchies — `new england city and
   * town area` sits both under a combined NECTA and on its own, and `state (or part)` ten ways on
   * acs/acs5 2020 — each entry a hierarchy the level can be queried in. Every entry
   * with the name is judged, and the call runs when any one accepts it, with that entry's parents
   * as the scopes left to narrow by. No served dataset-year has two entries accepting one call.
   *
   * When none accepts, the outcome reported is that of the entry the caller can satisfy with the
   * fewest changes to `scopeParents` — adding a parent ahead of dropping one, since a supplied
   * parent is the caller's intent. Failing that, an entry a `*` target would put within reach, since
   * `*` is also an input the caller has; only when neither exists is a parent out of reach named.
   * A level listed once has one entry to report, whatever it says. A `parent_required` outcome
   * also names the supplied parents that entry does not take, so one retry can satisfy it.
   *
   * Returns `ok` when the dataset has no metadata for the year — the data call then
   * reports the real problem rather than this check guessing at one.
   */
  async checkGeography(
    params: {
      dataset: string;
      year: number;
      geographyLevel: string;
      /** The `for=` value — `*` relaxes the innermost required parent. */
      geographyFips: string;
      /** The parents the calling tool has a scope input for. */
      scopeParents: readonly SuppliedParent[];
      /** State FIPS, when supplied by the caller. */
      parentFips?: string;
      /** County FIPS, when supplied by the caller. */
      countyFips?: string;
      /** Tract code, when supplied by the caller. */
      tractFips?: string;
    },
    ctx: Context,
  ): Promise<GeographyCheck> {
    const levels = await this.fetchGeographyLevels(params.dataset, params.year, ctx);
    if (levels.length === 0) return { status: 'ok' };

    const target = params.geographyLevel.trim().toLowerCase();
    const entries = levels.filter((l) => l.name.toLowerCase() === target);
    if (entries.length === 0) {
      return {
        status: 'level_not_supported',
        availableLevels: [...new Set(levels.map((l) => l.name))],
      };
    }

    // state, county, and tract are the only parents the `in=` clause can express.
    const supplied: SuppliedParent[] = [];
    if (params.parentFips) supplied.push('state');
    if (params.countyFips) supplied.push('county');
    if (params.tractFips) supplied.push('tract');

    const verdicts = entries.map((entry) => judgeEntry(entry, { ...params, supplied }));
    const accepting = verdicts.find((verdict) => verdict.check.status === 'ok');
    if (accepting) return accepting.check;

    const reachable = (parents: string[]) =>
      parents.every((parent) => params.scopeParents.some((scope) => scope === parent));
    const rank = (verdict: EntryVerdict) => [
      reachable(verdict.missing)
        ? 0
        : params.geographyFips !== '*' && reachable(verdict.missingUnderWildcard)
          ? 1
          : 2,
      verdict.missing.length + verdict.unaccepted.length,
      verdict.unaccepted.length,
    ];
    const closer = (a: number[], b: number[]) => {
      const at = a.findIndex((value, i) => value !== b[i]);
      return at >= 0 && (a[at] as number) < (b[at] as number);
    };
    // Entry order breaks a tie, so a level listed once reports its only entry.
    return verdicts.reduce((best, verdict) => (closer(rank(verdict), rank(best)) ? verdict : best))
      .check;
  }

  /**
   * Fetch the list of geography levels supported by a dataset+year from the Census API.
   * Cached in-memory per dataset+year with the discovery TTL.
   */
  async fetchGeographyLevels(
    dataset: string,
    year: number,
    ctx: Context,
  ): Promise<CensusGeographyLevel[]> {
    const ttlMs = getDiscoveryConfig().variableCacheTtlHours * 60 * 60 * 1000;
    const cacheKey = `${dataset}|${year}`;
    const cached = this.geographyLevelsCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < ttlMs) {
      ctx.log.debug('Geography levels cache hit', { dataset, year });
      return cached.levels;
    }

    const url = `${CENSUS_API_BASE}/${year}/${dataset}/geography.json`;

    ctx.log.debug('Fetching geography levels', { dataset, year });

    const levels = await withRetry(
      async () => {
        let response: Response;
        try {
          response = await fetchWithTimeout(url, 10_000, ctx as unknown as RequestContext, {
            signal: ctx.signal,
            // A 404 here is an expected outcome, not a fault — log it at debug.
            expectedStatuses: [404],
          });
        } catch (err) {
          // 404 means the year has no data for this dataset — return empty so the handler
          // can throw year_not_available instead of a generic upstream error.
          if (err instanceof McpError && (err.data as { status?: number })?.status === 404) {
            return [];
          }
          throw censusHttpError(err, {
            dataset,
            year,
            availableYears: DATASET_AVAILABLE_YEARS[dataset],
          });
        }

        const text = await response.text();

        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable('Census API geography endpoint returned HTML.', {
            reason: 'upstream_error',
          });
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw serviceUnavailable('Census API geography response unparseable.', {
            reason: 'upstream_error',
          });
        }

        const obj = parsed as { fips?: CensusGeographyLevel[] };
        return obj.fips ?? [];
      },
      {
        operation: 'CensusApiService.fetchGeographyLevels',
        context: ctx as unknown as RequestContext,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );

    this.geographyLevelsCache.set(cacheKey, { levels, fetchedAt: Date.now() });
    return levels;
  }

  /**
   * Enumerate the codes a filter dimension accepts, by wildcarding it on the data endpoint.
   *
   * Setting `<CODE>=*` turns the predicate into a group-by, so the response carries one row
   * per code the dimension takes for the scope queried. `variables.json` publishes a
   * `values.item` map for only two dimensions across the whole catalog, so this is the only
   * route to the rest. Cached per dataset+year+dimension+scope with the discovery TTL.
   *
   * The scope matters: on `ecnbasic` the codes `TAXSTAT` and `TYPOP` take are published per
   * industry, so an unscoped call returns only the all-establishments row and a `naicsScope`
   * is what makes the enumeration useful — and complete only for that industry.
   *
   * What lands in `get=` decides what the wildcard answers from. A dimension's own label column
   * can be served from the dataset's published value map, so on `dec/ddhca` a label-only request
   * hands back all 5,543 declared `POPGROUP` codes; naming a `measure` instead forces the read
   * against the data file, which answers with the 2,996 the dataset publishes rows for.
   */
  async fetchPredicateValues(
    params: {
      dataset: string;
      year: number;
      /** The filter dimension to enumerate (e.g. "EMPSZES"). */
      code: string;
      /** Attribute column carrying each code's label (e.g. "EMPSZES_LABEL"), when published. */
      labelAttribute?: string;
      /**
       * Measure variable to request instead of the label column, forcing the enumeration to
       * read the data file. Codes come back unlabelled, so this is for checking which codes the
       * dataset publishes rather than for building a list to show.
       */
      measure?: string;
      /** NAICS dimension code and industry value to scope the enumeration by. */
      naicsScope?: { code: string; value: string };
      /**
       * Time every attempt and backoff get together — the data-request deadline unless a caller
       * that can answer without this sets a shorter one.
       */
      deadlineMs?: number;
      /** Ends the request early alongside the caller's own signal — a sibling request failing. */
      signal?: AbortSignal;
    },
    ctx: Context,
  ): Promise<CensusPredicateValue[]> {
    const censusApiKey = this.requireApiKey();
    const ttlMs = getDiscoveryConfig().variableCacheTtlHours * 60 * 60 * 1000;
    const scopeKey = params.naicsScope
      ? `${params.naicsScope.code}=${params.naicsScope.value}`
      : '';
    const cacheKey = `${params.dataset}|${params.year}|${params.code}|${scopeKey}|${params.measure ?? ''}`;
    const cached = this.predicateValuesCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < ttlMs) {
      ctx.log.debug('Predicate values cache hit', { dataset: params.dataset, code: params.code });
      return cached.values;
    }

    const scopeClause = params.naicsScope
      ? `&${encodeURIComponent(params.naicsScope.code)}=${encodeURIComponent(params.naicsScope.value)}`
      : '';
    const getColumn = params.measure ?? params.labelAttribute ?? params.code;
    const url = `${CENSUS_API_BASE}/${params.year}/${params.dataset}?get=${encodeURIComponent(getColumn)}&${encodeURIComponent(params.code)}=*${scopeClause}&for=us:1&key=${censusApiKey}`;

    ctx.log.debug('Enumerating predicate values', {
      dataset: params.dataset,
      year: params.year,
      code: params.code,
    });

    const raw = await withRetry(
      async ({ signal, remainingMs }) => {
        let response: Response;
        try {
          response = await fetchWithTimeout(
            url,
            Math.min(DATA_ATTEMPT_TIMEOUT_MS, remainingMs),
            ctx as unknown as RequestContext,
            { signal },
          );
        } catch (error) {
          throw censusHttpError(error, {
            dataset: params.dataset,
            year: params.year,
            availableYears: DATASET_AVAILABLE_YEARS[params.dataset],
          });
        }
        // A dimension with nothing to enumerate under this scope answers 204 with no body.
        return parseDataBody(response.status, await response.text());
      },
      {
        operation: 'CensusApiService.fetchPredicateValues',
        context: ctx as unknown as RequestContext,
        baseDelayMs: 1000,
        signal: params.signal ? AbortSignal.any([ctx.signal, params.signal]) : ctx.signal,
        deadlineMs: params.deadlineMs ?? DATA_REQUEST_DEADLINE_MS,
      },
    ).catch((error: unknown) => {
      throw censusDeadlineError(error, params);
    });

    const values: CensusPredicateValue[] = [];
    if (raw.length > 1) {
      const headers = raw[0] as string[];
      const codeIdx = headers.indexOf(params.code);
      const labelIdx = params.labelAttribute ? headers.indexOf(params.labelAttribute) : -1;
      const seen = new Set<string>();

      for (let i = 1; i < raw.length; i++) {
        const row = raw[i] as string[];
        const code = codeIdx >= 0 ? (row[codeIdx] ?? '') : '';
        // A wildcarded dimension repeats codes across the other dimensions' rows.
        if (!code || seen.has(code)) continue;
        seen.add(code);
        values.push({ code, label: (labelIdx >= 0 ? row[labelIdx] : undefined) || code });
      }
      values.sort((a, b) => a.code.localeCompare(b.code));
    }

    this.predicateValuesCache.set(cacheKey, { values, fetchedAt: Date.now() });
    ctx.log.info('Predicate values enumerated', { code: params.code, valueCount: values.length });
    return values;
  }

  private parseResponse(
    raw: CensusRawResponse,
    params: Parameters<CensusApiService['queryData']>[0],
    ctx: Context,
  ): CensusDataRow[] {
    if (raw.length < 1) return [];

    const headers = raw[0] as string[];
    const acs = isAcsDataset(params.dataset);
    const defaultLabelColumns = params.defaultLabelColumns ?? {};
    const recordColumns = params.recordColumns ?? {};
    const flagColumns = params.flagColumns ?? {};
    const nameIdx = headers.indexOf('NAME');
    // The Census API echoes the level name in its own casing, so match it the way
    // checkGeography does rather than requiring the caller's exact spelling.
    const geoTarget = params.geographyLevel.trim().toLowerCase();
    const geoIdx = headers.findIndex((h) => h.toLowerCase() === geoTarget);

    // The Census API appends one column per geography level in the resolved hierarchy —
    // a county query returns state + county, a tract query state + county + tract. It also
    // echoes back every predicate that was filtered on. Once every requested column and those
    // echoed predicates are excluded, what remains is the geography hierarchy, and
    // concatenating it in order composes the full GEOID.
    const nonGeoColumns = new Set([
      ...getColumnsFor(params),
      ...Object.keys(params.predicates ?? {}),
    ]);
    const geoColumnIdxs = headers.flatMap((header, idx) =>
      nonGeoColumns.has(header) ? [] : [idx],
    );
    const variableIdxs = params.variables
      .map((code) => {
        const flagColumn = flagColumns[code];
        return [
          code,
          headers.indexOf(code),
          flagColumn ? headers.indexOf(flagColumn) : -1,
        ] as const;
      })
      .filter(([, idx]) => idx >= 0);
    const appliedFilterIdxs = Object.entries(defaultLabelColumns)
      .map(([code, column]) => [code, headers.indexOf(column)] as const)
      .filter(([, idx]) => idx >= 0);
    // A wildcarded dimension labels its rows the way a record dimension does: its code arrives as
    // the predicate echo, its label from the dimension's own label column when that was requested.
    const recordIdxs = [
      ...Object.entries(recordColumns).map(
        ([code, column]) => [code, headers.indexOf(code), headers.indexOf(column)] as const,
      ),
      ...(params.wildcardColumns ?? [])
        .filter((w) => !Object.hasOwn(recordColumns, w.code))
        .map(
          (w) =>
            [
              w.code,
              headers.indexOf(w.code),
              w.labelColumn ? headers.indexOf(w.labelColumn) : -1,
            ] as const,
        ),
    ].filter(([, codeIdx]) => codeIdx >= 0);

    const rows: CensusDataRow[] = [];

    for (let i = 1; i < raw.length; i++) {
      const row = raw[i] as string[];
      const geographyName = nameIdx >= 0 ? (row[nameIdx] ?? '') : '';
      const geographyFips = geoIdx >= 0 ? (row[geoIdx] ?? '') : '';
      const geographyGeoid = geoColumnIdxs.map((idx) => row[idx] ?? '').join('') || geographyFips;

      const variables: Record<string, CensusVariableValue> = {};
      const rawValues = new Map<string, string | null>();

      for (const [varCode, idx, flagIdx] of variableIdxs) {
        const rawValue = row[idx] ?? null;
        rawValues.set(varCode, rawValue);
        const value = readValue(rawValue, varCode, acs);
        variables[varCode] = flagIdx >= 0 ? applyFlag(value, row[flagIdx]) : value;
      }

      // Pair each requested estimate with its margin of error. Only ACS uses the E/M suffix
      // for that relationship — elsewhere an E-final code is just a code, so pairing two of
      // them would attach a margin of error to a value that has none.
      if (acs) {
        for (const varCode of params.variables) {
          if (!varCode.endsWith('E')) continue;
          const moeCode = `${varCode.slice(0, -1)}M`;
          const est = variables[varCode];
          const moe = variables[moeCode];
          if (!est || !moe) continue;
          est.moe = moe.estimate;
          // The open-ended MOE sentinel is the only signal that the estimate is a boundary.
          if (est.estimate !== null && Number(rawValues.get(moeCode)) === ACS_OPEN_ENDED_MOE) {
            est.openEnded = true;
          }
        }
      }

      const appliedFilters: Record<string, string> = {};
      for (const [code, idx] of appliedFilterIdxs) {
        const label = row[idx];
        if (label) appliedFilters[code] = label;
      }

      const record: Record<string, { code: string; label: string }> = {};
      for (const [code, codeIdx, labelIdx] of recordIdxs) {
        const value = row[codeIdx];
        if (value) record[code] = { code: value, label: (labelIdx >= 0 && row[labelIdx]) || value };
      }

      rows.push({
        geographyName,
        geographyFips,
        geographyGeoid,
        variables,
        ...(Object.keys(appliedFilters).length > 0 && { appliedFilters }),
        ...(Object.keys(record).length > 0 && { record }),
      });
    }

    ctx.log.info('Census API response parsed', { rowCount: rows.length });
    return rows;
  }
}

// --- Init/accessor pattern ---

let _service: CensusApiService | undefined;

export function initCensusApiService(): void {
  _service = new CensusApiService();
}

export function getCensusApiService(): CensusApiService {
  if (!_service) {
    throw new Error('CensusApiService not initialized — call initCensusApiService() in setup()');
  }
  return _service;
}
