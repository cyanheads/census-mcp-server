/**
 * @fileoverview Shared upstream-work budget and transport boundary for Census calls.
 * @module services/census-api/census-request
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { type RetryAttempt, type RetryOptions, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { censusDeadlineError } from './errors.js';

const CALL_DEADLINE_MS = 50_000;

/** The original caller context plus an explicit budget shared by every upstream stage. */
export interface CensusRequestContext extends Context {
  readonly censusBudget?: { readonly startedAtMs: number; readonly expiresAtMs: number };
}

/** Preserve Context's symbol stores, accessors and methods without changing its caller signal. */
export function censusCallContext<T extends Context>(ctx: T): T & CensusRequestContext {
  const startedAtMs = Date.now();
  return Object.create(Object.getPrototypeOf(ctx), {
    ...Object.getOwnPropertyDescriptors(ctx),
    censusBudget: { value: { startedAtMs, expiresAtMs: startedAtMs + CALL_DEADLINE_MS } },
  });
}

type Scope = {
  dataset: string;
  year: number;
  variables?: readonly string[];
  reason?: 'variables_unavailable';
};

/** Total-call expiry is fatal even at a best-effort metadata boundary. */
export function isCensusCallDeadline(error: unknown): boolean {
  return error instanceof McpError && error.data?.callDeadlineExceeded === true;
}

function callDeadlineError(
  budget: NonNullable<CensusRequestContext['censusBudget']>,
  scope: Scope,
  cause?: unknown,
): McpError {
  return serviceUnavailable(
    `The Census API did not finish answering for ${scope.dataset} (${scope.year}) within the call's ${CALL_DEADLINE_MS / 1000} s upstream budget.`,
    {
      reason: scope.reason ?? 'upstream_error',
      retryable: true,
      dataset: scope.dataset,
      year: scope.year,
      deadlineMs: CALL_DEADLINE_MS,
      elapsedMs: Date.now() - budget.startedAtMs,
      callDeadlineExceeded: true,
      recovery: {
        hint: 'Retry the request once. If it persists, the Census API is temporarily unavailable; request a narrower geography or fewer variables per call.',
      },
    },
    cause === undefined ? undefined : { cause },
  );
}

/** Remaining time for an optional probe; an exhausted invocation cannot begin another stage. */
export function censusRemainingMs(ctx: CensusRequestContext, scope: Scope): number {
  const remainingMs = ctx.censusBudget
    ? ctx.censusBudget.expiresAtMs - Date.now()
    : Number.POSITIVE_INFINITY;
  if (ctx.censusBudget && remainingMs <= 0 && !ctx.signal.aborted)
    throw callDeadlineError(ctx.censusBudget, scope);
  // An already-cancelled caller still reaches the transport's existing cancellation boundary.
  return Math.max(1, remainingMs);
}

/** Retry the whole exchange within both its local ceiling and the shared invocation budget. */
export async function withCensusRetry<T>(
  fn: (attempt: RetryAttempt) => Promise<T>,
  options: RetryOptions,
  ctx: CensusRequestContext,
  scope: Scope,
): Promise<T> {
  const remainingMs = censusRemainingMs(ctx, scope);
  const deadlineMs = Math.min(options.deadlineMs ?? Number.POSITIVE_INFINITY, remainingMs);
  try {
    return await withRetry(fn, { ...options, ...(Number.isFinite(deadlineMs) && { deadlineMs }) });
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    if (error instanceof McpError && error.data?.reason === 'retry_deadline_exceeded') {
      if (ctx.censusBudget && remainingMs <= (options.deadlineMs ?? Number.POSITIVE_INFINITY)) {
        throw callDeadlineError(ctx.censusBudget, scope, error);
      }
      throw censusDeadlineError(error, scope);
    }
    if (
      error instanceof McpError &&
      ['FetchNetworkErrorWrapper', 'FetchTimeout', 'CensusBodyReadError'].includes(
        String(error.data?.errorSource),
      )
    ) {
      throw serviceUnavailable(
        `The Census API could not finish answering for ${scope.dataset} (${scope.year}).`,
        {
          ...(typeof error.data?.retryAttempts === 'number' && {
            retryAttempts: error.data.retryAttempts,
          }),
          reason: scope.reason ?? 'upstream_error',
          retryable: true,
          dataset: scope.dataset,
          year: scope.year,
          recovery: {
            hint: 'Retry the request; if it persists, the Census API is temporarily unavailable for this dataset and year.',
          },
        },
        { cause: error },
      );
    }
    throw error;
  }
}

/** Body-stream failures are transport failures; JSON parsing remains the caller's boundary. */
export async function readCensusText(
  response: Response,
  ctx: CensusRequestContext,
): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    if (ctx.signal.aborted || error instanceof McpError) throw error;
    throw serviceUnavailable(
      'The Census API response body could not be read.',
      { errorSource: 'CensusBodyReadError' },
      { cause: error },
    );
  }
}
