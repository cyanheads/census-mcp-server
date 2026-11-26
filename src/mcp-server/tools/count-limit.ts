/**
 * @fileoverview The `limit` input of the four tools that page a list — census_query_data,
 * census_compare_geographies, census_search_variables, and census_list_predicate_values — and the
 * clamp that serves it. With CENSUS_CLAMP_LIMITS on (the default), a limit above a tool's cap is
 * served at the cap, disclosed in the notice, logged, and counted on `census.limit.clamped`; off,
 * the schema advertises the cap as its maximum and rejects anything above it. Shaped like the
 * framework's planned `countLimit` helper (a factory returning `schema` and `apply`), so adopting
 * that replaces this module.
 * @module mcp-server/tools/count-limit
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { z } from '@cyanheads/mcp-ts-core';
import { ATTR_MCP_TOOL_NAME, createCounter } from '@cyanheads/mcp-ts-core/utils';
import { activeDiscoveryConfig } from '@/config/server-config.js';

/** The tools whose `limit` this module serves. */
type CountLimitTool =
  | 'census_compare_geographies'
  | 'census_list_predicate_values'
  | 'census_query_data'
  | 'census_search_variables';

interface CountLimitOptions {
  /** The most items one call returns. */
  cap: number;
  /** The page a call that omits `limit` gets. */
  default: number;
  /**
   * The field description around the bounds sentence, which follows the switch: "Default 50; a
   * larger value returns at most 500 and says so." while clamping, "Default 50, max 500." while not.
   */
  describe: (bounds: string) => string;
  tool: CountLimitTool;
  /** What one item is called, singular then plural — `['row', 'rows']`. */
  unit: readonly [string, string];
}

/** The limit a page is cut with, and the sentence a clamp puts ahead of the paging sentence. */
export interface AppliedLimit {
  /** Present only when the caller's limit was above the cap and served at it. */
  clampNotice?: string;
  limit: number;
}

/**
 * Binds to the global meter on each `add`, so module scope is safe: it records once
 * `createApp()` has started telemetry, and is a no-op before.
 */
const clampedCounter = createCounter(
  'census.limit.clamped',
  'Tool calls whose limit above the tool cap was served at the cap',
  '{calls}',
);

const n = (value: number) => value.toLocaleString('en-US');

/** True while an over-cap limit is served at the cap rather than rejected. */
const clamping = () => activeDiscoveryConfig().clampLimits;

/**
 * A tool's `limit`: the optional schema, whose maximum and description follow CENSUS_CLAMP_LIMITS
 * on every parse and every JSON Schema emission (the SDK converts input schemas on each
 * `tools/list`), and `apply`, which serves the caller's value or the cap.
 */
export function countLimit(options: CountLimitOptions) {
  const {
    tool,
    cap,
    unit: [one, many],
  } = options;

  const schema = z
    .number()
    .min(1)
    .check((payload) => {
      // Not `.int()`: it also caps the value at Number.MAX_SAFE_INTEGER, so a limit of 1e20 would be
      // rejected instead of served at the cap. The issue shape is `.int()`'s, which the framework
      // answers with its integer recovery hint.
      if (!Number.isInteger(payload.value)) {
        payload.issues.push({ code: 'invalid_type', expected: 'int', input: payload.value });
      } else if (!clamping() && payload.value > cap) {
        payload.issues.push({
          code: 'too_big',
          origin: 'number',
          maximum: cap,
          inclusive: true,
          input: payload.value,
        });
      }
    })
    .optional()
    .meta({
      type: 'integer',
      get maximum() {
        return clamping() ? undefined : cap;
      },
      get description() {
        return options.describe(
          clamping()
            ? `Default ${n(options.default)}; a larger value returns at most ${n(cap)} and says so.`
            : `Default ${n(options.default)}, max ${n(cap)}.`,
        );
      },
    });

  /**
   * The limit to page with: the caller's, the default when omitted, or the cap for a larger one —
   * which logs one info line, adds 1 to `census.limit.clamped` for the tool, and returns the
   * sentence disclosing it. Called before any upstream request, so a call that later fails still
   * counts.
   */
  function apply(ctx: Context, requested: number | undefined): AppliedLimit {
    if (requested === undefined) return { limit: options.default };
    if (requested <= cap) return { limit: requested };
    ctx.log.info('Limit above the cap served at the cap', { tool, requested, served: cap });
    clampedCounter.add(1, { [ATTR_MCP_TOOL_NAME]: tool });
    return {
      limit: cap,
      clampNotice: `limit ${n(requested)} is over the ${n(cap)}-${one} cap, so this page holds up to ${n(cap)} ${many}.`,
    };
  }

  return { cap, schema, apply };
}
