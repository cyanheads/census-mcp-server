/**
 * @fileoverview Turns a failed Census API request into an error a caller can act on, and keeps
 * the upstream error page out of the response whatever the status was.
 * @module services/census-api/errors
 */

import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';

/**
 * Render a year list with contiguous runs collapsed — `[2005…2019, 2021…2024]` reads as
 * "2005-2019, 2021-2024". The lists run to fifteen vintages, and a caller looking for the
 * gap in a flat sequence of numbers has to find it by eye.
 */
export function formatYears(years: number[]): string {
  const sorted = [...new Set(years)].sort((a, b) => a - b);
  const runs: Array<[number, number]> = [];
  for (const year of sorted) {
    const last = runs.at(-1);
    if (last && year === last[1] + 1) last[1] = year;
    else runs.push([year, year]);
  }
  return runs.map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`)).join(', ');
}

/**
 * Most levels a `geography_not_supported` message spells out; `acs/acs5` 2024 publishes 43 (in 65
 * geography.json entries, one per parent hierarchy — `census_list_geographies` counts the same 43).
 */
const LEVELS_NAMED_LIMIT = 12;

/**
 * Message for a geography level a dataset and vintage do not publish. A short level list is
 * spelled out, so a caller that sees only the text answer can retry without another call; a
 * long one is counted, and the contract's recovery points at `census_list_geographies` for it.
 */
export function levelNotSupportedMessage(
  level: string,
  dataset: string,
  year: number,
  availableLevels: string[],
): string {
  const head = `Geography level "${level}" does not exist in ${dataset} (${year}).`;
  return availableLevels.length <= LEVELS_NAMED_LIMIT
    ? `${head} Available levels: ${availableLevels.join(', ')}.`
    : `${head} It publishes ${availableLevels.length} geography levels.`;
}

/**
 * The vintage a query named is not one this server can query the dataset for.
 *
 * Two causes, one answer: the Census API publishes no such vintage at all (`pep/charv` serves
 * 2023 alone, and 2020 through 2022 are values of its own `YEAR` dimension inside that vintage),
 * or it publishes one that rejects the `NAME` column every query here sends (`cbp` before 2012,
 * `nonemp` 2008 through 2011). The wording says the year cannot be queried rather than that the
 * dataset does not publish it, because the second kind is published — it just cannot be read in
 * the shape every query here takes. The years are what the caller retries with, so they sit in
 * the hint alone.
 */
export function yearNotAvailable(
  dataset: string,
  year: number,
  availableYears: number[] | undefined,
): McpError {
  const years = availableYears?.length ? formatYears(availableYears) : undefined;
  return validationError(`${dataset} cannot be queried for ${year}.`, {
    reason: 'year_not_available',
    dataset,
    year,
    ...(availableYears?.length && { availableYears }),
    recovery: {
      hint: years
        ? `Retry with a year this dataset serves: ${years}.`
        : 'Call census_list_datasets and retry with a year listed under available_years for this dataset.',
    },
  });
}

/** Longest upstream message worth putting in front of a caller. */
const UPSTREAM_MESSAGE_LIMIT = 200;

/**
 * The upstream body, when it is a short line of prose rather than a page of markup.
 *
 * The Census API answers a rejected query with one `text/plain` line — `error: unknown variable
 * 'NAME'`, `error: unknown/unsupported geography hierarchy` — which is the whole diagnosis and
 * has no other route to the caller. It answers a path that does not exist with a servlet
 * container's HTML page, which is several hundred bytes of styling and says nothing. Length and
 * the absence of markup separate the two.
 */
function upstreamMessage(body: unknown): string | undefined {
  if (typeof body !== 'string') return;
  const text = body.trim();
  if (text === '' || text.length > UPSTREAM_MESSAGE_LIMIT || /[<>]/.test(text)) return;
  return text;
}

/** How every data-request `variable_not_found` recovery ends: upstream stops at the first miss. */
export const FIRST_UNKNOWN_ONLY =
  'The Census API names only the first unknown code in a request, so check the others before retrying.';

/** Statuses `withRetry` treats as transient, so the hint can tell a retry from a rejection. */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 502, 503, 504]);

/** The next step for a data-endpoint failure that a later call can get past. */
const RETRY_LATER_HINT =
  'Retry the request; if it persists, the Census API is temporarily unavailable for this dataset and year.';

/**
 * The next step for a data query that spent its deadline. Each attempt is capped, response body
 * included, so a response too large to arrive inside one attempt is cut off on every retry: every
 * Los Angeles County block on dec/dhc 2020 with 49 variables is 28.7 MB, its first byte arriving
 * at about 10 s and its last at 42 s. Retrying cannot tell that apart from an outage; asking for
 * less per call can, and fewer rows is what counts most: the same blocks with 5 variables still run
 * out the deadline, while one tract's blocks with all 49 answer in about 5 s.
 */
const DATA_DEADLINE_HINT =
  'Retry the request once. If it fails the same way, request a narrower geography or fewer variables per call: a response too large to arrive within one attempt fails on every retry. Otherwise the Census API is temporarily unavailable for this dataset and year.';

/**
 * The data request's spent deadline as the retryable `upstream_error` the keyed tools declare; any
 * other error unchanged.
 *
 * `withRetry` rejects an expired `deadlineMs` with a `Timeout` carrying `reason:
 * 'retry_deadline_exceeded'`, a reason no tool contract declares, so it would reach the caller with
 * no recovery hint. A caller's own cancellation never takes this shape — `withRetry` passes it
 * through ahead of the deadline — so it stays a cancellation. A data query (`scope.variables`
 * present) is told to ask for less as well as to retry; an enumeration's response is small, so its
 * spent deadline reads as an outage.
 */
export function censusDeadlineError(
  error: unknown,
  scope: { dataset: string; year: number; variables?: readonly string[] },
): unknown {
  if (!(error instanceof McpError) || error.data?.reason !== 'retry_deadline_exceeded')
    return error;
  const { deadlineMs, elapsedMs, retryAttempts } = error.data as {
    deadlineMs: number;
    elapsedMs: number;
    retryAttempts: number;
  };
  return new McpError(
    JsonRpcErrorCode.ServiceUnavailable,
    `The Census API did not finish answering for ${scope.dataset} (${scope.year}) within ${deadlineMs / 1000} s, across ${retryAttempts} attempt${retryAttempts === 1 ? '' : 's'}.`,
    {
      reason: 'upstream_error',
      retryable: true,
      dataset: scope.dataset,
      year: scope.year,
      deadlineMs,
      elapsedMs,
      retryAttempts,
      recovery: { hint: scope.variables ? DATA_DEADLINE_HINT : RETRY_LATER_HINT },
    },
    { cause: error },
  );
}

/**
 * The Census API's rejection of a `get=` column it does not publish. Anchored on both ends so
 * `error: unknown predicate variable: 'FOO'` — a filter key, not a column — does not match.
 */
const UNKNOWN_VARIABLE = /^error: unknown variable '([^']+)'$/;

/**
 * Translate a thrown Census API fetch failure.
 *
 * `fetchWithTimeout` attaches the first 500 bytes of the response body to `data.body` and
 * `data.responseBody`. That body is worth keeping when it is the Census API's one-line rejection
 * and worth dropping when it is the servlet container's HTML error page, so it is read rather
 * than forwarded or stripped wholesale: a short unmarked-up line becomes `upstreamMessage` and
 * lands in the error text, and anything else is discarded. Either way `body` and `responseBody`
 * are gone, so no markup reaches a caller from any status.
 *
 * A 404 on a vintage the catalog does not list is `year_not_available`. A 404 on one it does
 * list is not — the years were validated before the request, so the catalog has drifted from the
 * API and answering "no such vintage" while naming that vintage as available says nothing a
 * caller can act on.
 *
 * A 400 reading `error: unknown variable '<code>'` that names one of `requestedCodes` is
 * `variable_not_found`. The upstream rejection is the authority on which columns exist:
 * `variables.json` lists the annotation and flag columns the API accepts only inside each entry's
 * `attributes` string, so a pre-check against it would refuse `B19013_001EA`, `EMP_F`, and every
 * other column of that kind. A code the caller did not send — `NAME`, or a label, record, or flag
 * column the server added — stays `upstream_error`, since naming it as the caller's mistake would
 * send them looking for a code they never passed. The API names only the first unknown column.
 * Its recovery points at variable search here; `queryData` swaps in the sibling dataset that
 * publishes the code when a lookup confirms one, once its retries are over.
 *
 * Every other status keeps the status-mapped code it already had, which is what decides whether
 * `withRetry` tries again. Anything that is not an HTTP failure (timeout, abort, network error)
 * is returned unchanged for its own handling.
 *
 * Returns the error to throw rather than throwing, so the call site reads as a `throw`.
 */
export function censusHttpError(
  error: unknown,
  scope: {
    dataset: string;
    year: number;
    availableYears?: number[] | undefined;
    /** Variable codes the caller supplied, the only ones an unknown-variable rejection can blame. */
    requestedCodes?: readonly string[] | undefined;
  },
): unknown {
  if (!(error instanceof McpError) || error.data?.errorSource !== 'FetchHttpError') return error;

  const {
    status,
    body,
    responseBody: _responseBody,
    ...rest
  } = error.data as {
    status?: number;
    body?: unknown;
    responseBody?: unknown;
  } & Record<string, unknown>;

  if (status === 404 && !scope.availableYears?.includes(scope.year)) {
    return yearNotAvailable(scope.dataset, scope.year, scope.availableYears);
  }

  const upstream = upstreamMessage(body);

  const unknownCode = status === 400 ? upstream?.match(UNKNOWN_VARIABLE)?.[1] : undefined;
  if (unknownCode && scope.requestedCodes?.includes(unknownCode)) {
    return notFound(
      `Variable code not found in ${scope.dataset} (${scope.year}): ${unknownCode}.`,
      {
        reason: 'variable_not_found',
        missingCodes: [unknownCode],
        dataset: scope.dataset,
        year: scope.year,
        status,
        upstreamMessage: upstream,
        recovery: {
          hint: `Call census_search_variables to find valid codes for this dataset and year, or census_get_variable to confirm one. ${FIRST_UNKNOWN_ONLY}`,
        },
      },
    );
  }

  const retryable = status === undefined || RETRYABLE_STATUSES.has(status) || status >= 500;

  return new McpError(
    error.code,
    `Census API returned HTTP ${status ?? 'error'} for ${scope.dataset} (${scope.year}).${
      upstream ? ` Upstream: ${upstream}` : ''
    }`,
    {
      ...rest,
      reason: 'upstream_error',
      dataset: scope.dataset,
      year: scope.year,
      ...(status !== undefined && { status }),
      ...(upstream && { upstreamMessage: upstream }),
      // The upstream line is the diagnosis, carried by the message; the hint is the next step.
      recovery: {
        hint: retryable
          ? RETRY_LATER_HINT
          : 'Change the query — the Census API rejected it rather than failing transiently, so retrying it unchanged returns the same status.',
      },
    },
  );
}
