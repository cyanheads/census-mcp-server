/**
 * @fileoverview Pins the wire-facing input contract every tool inherits from the
 * framework: inputs are strict, that strictness is advertised to clients as
 * `additionalProperties: false`, and a rejected call comes back as the
 * `InvalidParams` error envelope a client actually receives.
 *
 * mcp-ts-core 0.12.0 made tool inputs strict. Before it, an undeclared key was
 * silently stripped and the call proceeded; now it is rejected. A caller that
 * sends a typo'd or stale argument gets a validation error instead of a result
 * computed from arguments it did not supply — so the strictness is the tool's
 * observable behavior, not an implementation detail, and regressing it would
 * change what every client sees without failing any per-tool test.
 *
 * Two layers, deliberately both: `input.safeParse` pins the schema, and
 * `runToolContract` pins what reaches the client through the production
 * rejection path — the `-32602` code, `data.reason`, and the recovery hint and
 * reason terms appended to `content[0].text`. The schema alone no longer tells
 * the whole story, because 0.13.4 added a pre-validation step that drops
 * client-added root keys before the schema ever sees them.
 *
 * Text assertions check containment, never equality: the framework owns the
 * exact wording and has moved it twice (0.13.3 appended `Recovery: …`, 0.13.5
 * appended the reason term).
 *
 * @module tests/tools/tool-input-contract.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { censusCompareGeographies } from '@/mcp-server/tools/definitions/census-compare-geographies.tool.js';
import { censusListDatasets } from '@/mcp-server/tools/definitions/census-list-datasets.tool.js';
import { censusListGeographies } from '@/mcp-server/tools/definitions/census-list-geographies.tool.js';
import { censusListPredicateValues } from '@/mcp-server/tools/definitions/census-list-predicate-values.tool.js';
import { censusQueryData } from '@/mcp-server/tools/definitions/census-query-data.tool.js';
import { censusSearchVariables } from '@/mcp-server/tools/definitions/census-search-variables.tool.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';

/** JSON-RPC code for an argument rejection, as a client reads it off the wire. */
const INVALID_PARAMS = -32602;

interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: { error?: { code?: number; data?: Record<string, unknown> } };
}

const errorOf = (result: unknown) => {
  const typed = result as ToolResult;
  return {
    isError: typed.isError,
    text: typed.content?.[0]?.text ?? '',
    code: typed.structuredContent?.error?.code,
    data: typed.structuredContent?.error?.data ?? {},
  };
};

describe('tool input contract', () => {
  it.each(allToolDefinitions.map((d) => [d.name, d] as const))(
    '%s rejects an undeclared input key rather than stripping it',
    (_name, definition) => {
      const result = definition.input.safeParse({ undeclaredKey: 'x' });

      expect(result.success).toBe(false);
      // Asserting on the issue, not just the throw: a tool with required fields
      // would fail this input either way, so only the unrecognized-key issue
      // distinguishes strict rejection from incidental failure.
      expect(result.error?.issues.map((i) => i.code)).toContain('unrecognized_keys');
    },
  );

  it.each(allToolDefinitions.map((d) => [d.name, d] as const))(
    '%s advertises additionalProperties: false so clients see the strictness',
    (_name, definition) => {
      const schema = definition.input.toJSONSchema() as { additionalProperties?: unknown };
      expect(schema.additionalProperties).toBe(false);
    },
  );

  it.each(allToolDefinitions.map((d) => [d.name, d] as const))(
    '%s surfaces an undeclared key as an InvalidParams envelope naming the key',
    async (_name, definition) => {
      // The handler never runs on a rejected call, so no tool reaches its upstream API here.
      const { isError, text, code, data } = errorOf(
        await runToolContract(definition, { undeclaredKey: 'x' } as never),
      );

      expect(isError).toBe(true);
      expect(code).toBe(INVALID_PARAMS);
      expect(data.reason).toBe('invalid_arguments');
      expect(data.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'unrecognized_keys' })]),
      );
      expect(text).toContain('undeclaredKey');
    },
  );

  it('appends the synthesized recovery hint and reason term to the rejection text', async () => {
    const { text, data } = errorOf(
      await runToolContract(censusListDatasets, { filter: 1 } as never),
    );

    expect(text).toContain('filter');
    expect(text).toContain('Recovery:');
    expect(text).toContain('(reason invalid_arguments');
    expect(data.recovery).toEqual(expect.objectContaining({ hint: expect.any(String) }));
  });

  it('drops an underscore-prefixed client key instead of rejecting the call', async () => {
    // No declared input starts with `_`, so the framework reads such a key as client
    // bookkeeping and strips it pre-validation — the opposite of the schema's verdict above.
    const result = (await runToolContract(censusListDatasets, {
      filter: 'acs',
      _clientCallId: 'abc',
    } as never)) as ToolResult;

    expect(result.isError).toBeFalsy();
  });

  it('carries the declared recovery hint and reason for a handler-thrown failure', async () => {
    const { isError, text, code, data } = errorOf(
      await runToolContract(censusListGeographies, { dataset: 'nope/nope' } as never),
    );

    expect(isError).toBe(true);
    expect(code).not.toBe(INVALID_PARAMS);
    expect(data.reason).toBe('dataset_not_found');
    expect(text).toContain('Call census_list_datasets to discover valid dataset codes');
    expect(text).toContain('(reason dataset_not_found');
  });
});

/**
 * Every count input is bounded in the schema, so the bound reaches the published JSON Schema a
 * client renders and an out-of-range value never reaches a handler. A bound that lives only in
 * the describe prose lets a negative limit slice from the end of a list, 0 return an empty page,
 * and a fraction pass through.
 */
describe('bounded count inputs', () => {
  /** Each bounded input, the smallest valid call around it, and its published bounds. */
  const bounded = [
    {
      definition: censusSearchVariables,
      field: 'limit',
      base: { query: 'median household income' },
      minimum: 1,
      maximum: 100,
    },
    {
      definition: censusCompareGeographies,
      field: 'limit',
      base: { variables: ['B19013_001E'], geography_level: 'state' },
      minimum: 1,
      maximum: 500,
    },
    {
      definition: censusListPredicateValues,
      field: 'limit',
      base: { predicate: 'NAICS2017', dataset: 'cbp' },
      minimum: 1,
      maximum: 500,
    },
    {
      definition: censusQueryData,
      field: 'limit',
      base: { variables: ['B19013_001E'], geography_level: 'county', geography_fips: '*' },
      minimum: 1,
      maximum: 500,
    },
    {
      definition: censusQueryData,
      field: 'offset',
      base: { variables: ['B19013_001E'], geography_level: 'county', geography_fips: '*' },
      minimum: 0,
      maximum: undefined,
    },
  ] as const;

  const label = (entry: (typeof bounded)[number]) => `${entry.definition.name} ${entry.field}`;

  it.each(bounded.map((entry) => [label(entry), entry] as const))(
    '%s publishes an integer with its bounds',
    (_label, { definition, field, minimum, maximum }) => {
      const schema = definition.input.toJSONSchema() as {
        properties: Record<string, { type?: string; minimum?: number; maximum?: number }>;
      };
      const property = schema.properties[field];

      expect(property?.type).toBe('integer');
      expect(property?.minimum).toBe(minimum);
      if (maximum === undefined) {
        // `.int()` alone would publish Number.MAX_SAFE_INTEGER; an offset has no bound to state.
        expect(property?.maximum ?? Number.MAX_SAFE_INTEGER).toBe(Number.MAX_SAFE_INTEGER);
      } else {
        expect(property?.maximum).toBe(maximum);
      }
    },
  );

  const rejected = bounded.flatMap((entry) =>
    [entry.minimum - 1, -1, 2.5, ...(entry.maximum === undefined ? [] : [entry.maximum + 1])]
      .filter((value, index, all) => all.indexOf(value) === index)
      .map((value) => [label(entry), value, entry] as const),
  );

  it.each(rejected)(
    '%s rejects %s as an InvalidParams envelope naming the field',
    async (_label, value, { definition, field, base }) => {
      // The handler never runs on a rejected call, so no tool reaches its upstream API here.
      const { isError, text, code, data } = errorOf(
        await runToolContract(definition as never, { ...base, [field]: value } as never),
      );

      expect(isError).toBe(true);
      expect(code).toBe(INVALID_PARAMS);
      expect(data.reason).toBe('invalid_arguments');
      expect(data.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: [field] })]),
      );
      expect(text).toContain(field);
    },
  );

  it.each(bounded.map((entry) => [label(entry), entry] as const))(
    '%s accepts its bounds and an omitted value',
    (_label, { definition, field, base, minimum, maximum }) => {
      expect(definition.input.safeParse(base).success).toBe(true);
      expect(definition.input.safeParse({ ...base, [field]: minimum }).success).toBe(true);
      if (maximum !== undefined) {
        expect(definition.input.safeParse({ ...base, [field]: maximum }).success).toBe(true);
      }
    },
  );
});

/**
 * A tract code is exactly 6 digits with no padding and no wildcard: `*` under a concrete block
 * group is an upstream 400, and "7101" or "71" could each mean Tract 71.01 or another tract.
 */
describe('census_query_data tract_fips', () => {
  const base = {
    variables: ['B19013_001E'],
    geography_level: 'block group',
    geography_fips: '2',
    parent_fips: '53',
    county_fips: '033',
  };

  it.each(['*', '7101', '0071011', '71.01'])(
    'rejects %j as an InvalidParams envelope naming tract_fips',
    async (tract_fips) => {
      const { isError, text, code, data } = errorOf(
        await runToolContract(censusQueryData, { ...base, tract_fips } as never),
      );

      expect(isError).toBe(true);
      expect(code).toBe(INVALID_PARAMS);
      expect(data.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: ['tract_fips'] })]),
      );
      expect(text).toContain('tract_fips');
    },
  );

  it('publishes the 6-digit pattern and the blank alternative', () => {
    const schema = censusQueryData.input.toJSONSchema() as {
      properties: Record<string, { anyOf?: Array<{ const?: string; pattern?: string }> }>;
    };
    const variants = schema.properties.tract_fips?.anyOf ?? [];

    expect(variants.map((v) => v.const ?? v.pattern)).toEqual(['', '^\\d{6}$']);
  });
});
