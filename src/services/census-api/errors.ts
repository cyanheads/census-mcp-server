/**
 * @fileoverview Turns a failed Census API request into an error a caller can act on, and keeps
 * the upstream error page out of the response whatever the status was.
 * @module services/census-api/errors
 */

import { McpError, validationError } from '@cyanheads/mcp-ts-core/errors';

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
 * The vintage a query named is not one this server can query the dataset for.
 *
 * Two causes, one answer: the Census API publishes no such vintage at all (`pep/charv` serves
 * 2023 alone, and 2020 through 2022 are values of its own `YEAR` dimension inside that vintage),
 * or it publishes one that rejects the `NAME` column every query here sends (`cbp` before 2012,
 * `nonemp` 2008 through 2011). The wording says the year cannot be queried rather than that the
 * dataset does not publish it, because the second kind is published — it just cannot be read in
 * the shape every query here takes.
 */
export function yearNotAvailable(
  dataset: string,
  year: number,
  availableYears: number[] | undefined,
): McpError {
  const years = availableYears?.length ? formatYears(availableYears) : undefined;
  return validationError(
    years
      ? `${dataset} cannot be queried for ${year}. Years available: ${years}.`
      : `${dataset} cannot be queried for ${year}.`,
    {
      reason: 'year_not_available',
      dataset,
      year,
      ...(availableYears?.length && { availableYears }),
      recovery: {
        hint: years
          ? `Retry with a year ${dataset} serves: ${years}. census_list_datasets returns the same list as available_years for every dataset.`
          : `Call census_list_datasets and retry with a year listed under available_years for ${dataset}.`,
      },
    },
  );
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

/** Statuses `withRetry` treats as transient, so the hint can tell a retry from a rejection. */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 502, 503, 504]);

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
 * caller can act on. Every other status keeps the status-mapped code it already had, which is
 * what decides whether `withRetry` tries again. Anything that is not an HTTP failure (timeout,
 * abort, network error) is returned unchanged for its own handling.
 *
 * Returns the error to throw rather than throwing, so the call site reads as a `throw`.
 */
export function censusHttpError(
  error: unknown,
  scope: { dataset: string; year: number; availableYears?: number[] | undefined },
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
      recovery: {
        hint: retryable
          ? `Retry the request; if it persists, the Census API is temporarily unavailable for ${scope.dataset} (${scope.year}).`
          : `The Census API rejected this request rather than failing transiently${upstream ? `: ${upstream}` : ''}. Change the query — retrying it unchanged returns the same status.`,
      },
    },
  );
}
