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
import { beforeAll, describe, expect, it } from 'vitest';
import { censusCompareGeographies } from '@/mcp-server/tools/definitions/census-compare-geographies.tool.js';
import { censusGetVariable } from '@/mcp-server/tools/definitions/census-get-variable.tool.js';
import { censusListDatasets } from '@/mcp-server/tools/definitions/census-list-datasets.tool.js';
import { censusListGeographies } from '@/mcp-server/tools/definitions/census-list-geographies.tool.js';
import { censusListPredicateValues } from '@/mcp-server/tools/definitions/census-list-predicate-values.tool.js';
import { censusQueryData } from '@/mcp-server/tools/definitions/census-query-data.tool.js';
import { censusResolveGeography } from '@/mcp-server/tools/definitions/census-resolve-geography.tool.js';
import { censusSearchVariables } from '@/mcp-server/tools/definitions/census-search-variables.tool.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { initGeographyService } from '@/services/geography/geography-service.js';

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
    // A boolean, not a number: since mcp-ts-core 0.13.9 an integer sent for a string field is
    // repaired to its digits before validation, so only a boolean keeps the wrong-type intent.
    const { text, data } = errorOf(
      await runToolContract(censusListDatasets, { filter: true } as never),
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

  it('fills the declared recovery hint for a bare ctx.fail throw', async () => {
    // The handler throws `ctx.fail('sort_by_not_requested', …)` with no recovery of its own; the
    // framework fills the hint from the errors[] entry. The check runs before any request.
    const { isError, text, data } = errorOf(
      await runToolContract(censusCompareGeographies, {
        variables: ['B19013_001E'],
        geography_level: 'state',
        sort_by: 'B01001_001E',
      } as never),
    );

    expect(isError).toBe(true);
    expect(data.reason).toBe('sort_by_not_requested');
    expect(data.recovery).toEqual(
      expect.objectContaining({ hint: expect.stringContaining('Set sort_by to one of the codes') }),
    );
    expect(text).toContain('Set sort_by to one of the codes');
  });
});

/**
 * Every count input is bounded below in the schema, so the bound reaches the published JSON Schema
 * a client renders and an out-of-range value never reaches a handler. A bound that lives only in
 * the describe prose lets a negative limit slice from the end of a list, 0 return an empty page,
 * and a fraction pass through. A `limit` above its tool's cap is served at the cap rather than
 * rejected (#95), so with CENSUS_CLAMP_LIMITS at its default no `limit` publishes a maximum.
 */
describe('bounded count inputs', () => {
  /** Each bounded input, the smallest valid call around it, its minimum, and a limit's cap. */
  const bounded = [
    {
      definition: censusSearchVariables,
      field: 'limit',
      base: { query: 'median household income' },
      minimum: 1,
      cap: 3_000,
    },
    {
      definition: censusCompareGeographies,
      field: 'limit',
      base: { variables: ['B19013_001E'], geography_level: 'state' },
      minimum: 1,
      cap: 500,
    },
    {
      definition: censusListPredicateValues,
      field: 'limit',
      base: { predicate: 'NAICS2017', dataset: 'cbp' },
      minimum: 1,
      cap: 10_000,
    },
    {
      definition: censusQueryData,
      field: 'limit',
      base: { variables: ['B19013_001E'], geography_level: 'county', geography_fips: '*' },
      minimum: 1,
      cap: 500,
    },
    {
      definition: censusQueryData,
      field: 'offset',
      base: { variables: ['B19013_001E'], geography_level: 'county', geography_fips: '*' },
      minimum: 0,
      cap: undefined,
    },
    {
      definition: censusCompareGeographies,
      field: 'offset',
      base: { variables: ['B19013_001E'], geography_level: 'county' },
      minimum: 0,
      cap: undefined,
    },
  ] as const;

  const label = (entry: (typeof bounded)[number]) => `${entry.definition.name} ${entry.field}`;

  it.each(bounded.map((entry) => [label(entry), entry] as const))(
    '%s publishes an integer with its minimum and no maximum',
    (_label, { definition, field, minimum, cap }) => {
      const schema = definition.input.toJSONSchema() as {
        properties: Record<string, { type?: string; minimum?: number; maximum?: number }>;
      };
      const property = schema.properties[field];

      expect(property?.type).toBe('integer');
      expect(property?.minimum).toBe(minimum);
      if (cap === undefined) {
        // `.int()` alone would publish Number.MAX_SAFE_INTEGER; an offset has no bound to state.
        expect(property?.maximum ?? Number.MAX_SAFE_INTEGER).toBe(Number.MAX_SAFE_INTEGER);
      } else {
        expect(property).not.toHaveProperty('maximum');
      }
    },
  );

  const rejected = bounded.flatMap((entry) =>
    [entry.minimum - 1, -1, 2.5]
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
    '%s accepts its minimum and an omitted value, and a limit its cap and anything above it',
    (_label, { definition, field, base, minimum, cap }) => {
      expect(definition.input.safeParse(base).success).toBe(true);
      expect(definition.input.safeParse({ ...base, [field]: minimum }).success).toBe(true);
      if (cap !== undefined) {
        for (const value of [cap, cap + 1, 1e20]) {
          expect(definition.input.safeParse({ ...base, [field]: value }).data).toMatchObject({
            [field]: value,
          });
        }
      }
    },
  );

  /** Each tool's own default and cap reach the limit description a client renders. */
  it.each([
    {
      definition: censusSearchVariables,
      bounds: 'Variables per page. Default 20; a larger value returns at most 3,000 and says so.',
    },
    {
      definition: censusCompareGeographies,
      bounds: 'Geographies per page. Default 50; a larger value returns at most 500 and says so.',
    },
    {
      definition: censusListPredicateValues,
      bounds: 'Codes per page. Default 50; a larger value returns at most 10,000 and says so.',
    },
    {
      definition: censusQueryData,
      bounds: 'Rows per page. Default 50; a larger value returns at most 500 and says so.',
    },
  ])('$definition.name limit describes its default and its cap', ({ definition, bounds }) => {
    const schema = definition.input.toJSONSchema() as {
      properties: Record<string, { description?: string }>;
    };

    expect(schema.properties.limit?.description).toContain(bounds);
  });
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

  it('names the 6-digit form when a dec/pl 2000 row lists the tract in 4 digits', async () => {
    // dec/pl 2000 rows carry a whole-number tract as 4 digits ("0071"), which tract_fips rejects.
    const { text, data } = errorOf(
      await runToolContract(censusQueryData, {
        variables: ['PL001001'],
        dataset: 'dec/pl',
        year: 2000,
        geography_level: 'block',
        geography_fips: '*',
        parent_fips: '53',
        county_fips: '033',
        tract_fips: '0071',
      } as never),
    );

    expect((data.recovery as { hint?: string } | undefined)?.hint).toContain('"007100"');
    expect(text).toContain('"007100"');
  });

  it('publishes the 6-digit pattern and the blank alternative', () => {
    const schema = censusQueryData.input.toJSONSchema() as {
      properties: Record<string, { anyOf?: Array<{ const?: string; pattern?: string }> }>;
    };
    const variants = schema.properties.tract_fips?.anyOf ?? [];

    expect(variants.map((v) => v.const ?? v.pattern)).toEqual(['', '^\\d{6}$']);
  });
});

/**
 * #99: a caller copying a name another tool emits — census_list_datasets' dataset_id,
 * census_resolve_geography's state_fips, fips_summary, and geography_type — or a sibling tool's
 * spelling of the same input reaches the declared key instead of failing as an unrecognized one.
 * Each case proves the rewrite by what the value then causes at the target, so none reaches an
 * upstream API: a handler failure where one precedes the first request, otherwise the target's
 * own schema rejection, which names the target's path and reports the rewrite.
 */
describe('input aliases (#99)', () => {
  beforeAll(() => {
    initGeographyService();
  });

  const queryBase = { variables: ['B01003_001E'], geography_level: 'state', geography_fips: '53' };
  const compareBase = { variables: ['B01003_001E'], geography_level: 'state' };

  it.each(
    (
      [
        [censusQueryData, queryBase],
        [censusCompareGeographies, compareBase],
        [censusListGeographies, {}],
        [censusGetVariable, { variables: ['B01003_001E'] }],
        [censusSearchVariables, { query: 'poverty' }],
        [censusListPredicateValues, { predicate: 'NAICS2017' }],
      ] as const
    ).map(([definition, base]) => [definition.name, definition, base] as const),
  )('%s reads dataset_id as dataset', async (_name, definition, base) => {
    const { isError, text, code, data } = errorOf(
      await runToolContract(definition as never, { ...base, dataset_id: 'nope/nope' } as never),
    );

    expect(isError).toBe(true);
    expect(code).not.toBe(INVALID_PARAMS);
    expect(data.reason).toBe('dataset_not_found');
    expect(text).toContain('Unknown dataset: "nope/nope"');
  });

  it.each(['place_name', 'place', 'query'])(
    'census_resolve_geography reads %s as name',
    async (alias) => {
      const { isError, text, code } = errorOf(
        await runToolContract(censusResolveGeography, { [alias]: ' ' } as never),
      );

      expect(isError).toBe(true);
      expect(code).not.toBe(INVALID_PARAMS);
      expect(text).toContain('Place name is required.');
    },
  );

  it('census_resolve_geography reads geography_level as geography_type', async () => {
    // An explicit place level leaves county_fips nothing to scope, refused before any request;
    // auto-detection would have tried county too.
    const { isError, data } = errorOf(
      await runToolContract(censusResolveGeography, {
        name: 'Seattle, WA',
        geography_level: 'place',
        county_fips: '033',
      } as never),
    );

    expect(isError).toBe(true);
    expect(data.reason).toBe('county_scope_unsupported');
    expect(data.geographyType).toBe('place');
  });

  it.each(
    (
      [
        [censusQueryData, queryBase, 'geography_type', 'geography_level', true],
        [censusQueryData, queryBase, 'fips_summary', 'geography_fips', true],
        [censusQueryData, queryBase, 'state_fips', 'parent_fips', 'abc'],
        [censusQueryData, queryBase, 'within', 'parent_fips', 'abc'],
        [censusQueryData, queryBase, 'within_county', 'county_fips', 'abcd'],
        [censusCompareGeographies, compareBase, 'geography_type', 'geography_level', true],
        [censusCompareGeographies, compareBase, 'state_fips', 'within', 'abc'],
        [censusCompareGeographies, compareBase, 'parent_fips', 'within', 'abc'],
        [censusCompareGeographies, compareBase, 'county_fips', 'within_county', 'abcd'],
        [censusSearchVariables, { query: 'poverty' }, 'keyword', 'query', true],
        [
          censusListPredicateValues,
          { predicate: 'NAICS2017', dataset: 'cbp' },
          'keyword',
          'query',
          true,
        ],
      ] as const
    ).map(
      ([definition, base, alias, target, value]) =>
        [definition.name, alias, target, { definition, base, value }] as const,
    ),
  )('%s validates %s as %s', async (_name, alias, target, { definition, base, value }) => {
    // The target is dropped from the base call, so the alias is the only key naming it.
    const call: Record<string, unknown> = { ...base, [alias]: value };
    delete call[target];
    const { isError, text, code, data } = errorOf(
      await runToolContract(definition as never, call as never),
    );

    expect(isError).toBe(true);
    expect(code).toBe(INVALID_PARAMS);
    expect(data.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: [target] })]),
    );
    expect(data.input).toMatchObject({ aliased: [{ alias, target }] });
    expect(text).toContain(`Validated ${alias} as ${target}.`);
  });

  it('rejects an alias sent beside its target, naming it as an alias', async () => {
    const { isError, text, code } = errorOf(
      await runToolContract(censusQueryData, {
        ...queryBase,
        dataset: 'acs/acs5',
        dataset_id: 'acs/acs5',
      } as never),
    );

    expect(isError).toBe(true);
    expect(code).toBe(INVALID_PARAMS);
    expect(text).toContain('dataset_id is an alias of dataset; send one of them, not both.');
  });

  it('rejects two aliases of one target, naming both as aliases', async () => {
    const { isError, text, code } = errorOf(
      await runToolContract(censusQueryData, {
        variables: ['B01003_001E'],
        geography_level: 'county',
        geography_fips: '119',
        state_fips: '37',
        within: '37',
      } as never),
    );

    expect(isError).toBe(true);
    expect(code).toBe(INVALID_PARAMS);
    expect(text).toContain('state_fips and within are aliases of parent_fips');
  });

  it('matches an alias only as written', async () => {
    const { isError, code, data, text } = errorOf(
      await runToolContract(censusSearchVariables, { Keyword: 'poverty' } as never),
    );

    expect(isError).toBe(true);
    expect(code).toBe(INVALID_PARAMS);
    expect(data.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'unrecognized_keys' })]),
    );
    expect(text).toContain('Keyword');
  });

  /** Aliases are accepted, never advertised: the canonical key stays the one a client is told. */
  it.each(allToolDefinitions.map((d) => [d.name, d] as const))(
    '%s advertises its targets and none of its aliases',
    (_name, definition) => {
      const schema = definition.input.toJSONSchema() as { properties: Record<string, unknown> };
      const aliases = Object.entries(definition.inputAliases ?? {});

      for (const [alias, target] of aliases) {
        expect(schema.properties).toHaveProperty(target);
        expect(schema.properties).not.toHaveProperty(alias);
      }
      expect(aliases.length > 0).toBe(definition !== censusListDatasets);
    },
  );
});
