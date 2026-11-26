/**
 * @fileoverview The shared `limit` mechanism of census_query_data, census_compare_geographies,
 * census_search_variables, and census_list_predicate_values (#95), tabled once at its seam: the
 * schema and the JSON Schema `tools/list` advertises from it in both CENSUS_CLAMP_LIMITS settings,
 * the clamp, its notice sentence, its log line, and its counter. Each case loads the modules fresh,
 * with the config parsed the way `setup()` parses it, after the tool modules load; the per-tool
 * suites prove only the wiring.
 * @module tests/tools/count-limit.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, type MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface CounterAdd {
  attributes: unknown;
  name: string;
  value: number;
}

/**
 * Fresh `server-config` and `count-limit` modules, with `createCounter` recording what it adds.
 * CENSUS_CLAMP_LIMITS is stubbed before the import; `setup` parses the config after it, as
 * `createApp()` runs `setup()` after the tool modules load — left false, the config stays unparsed.
 */
async function load({ env, setup = true }: { env?: string | undefined; setup?: boolean } = {}) {
  vi.resetModules();
  vi.stubEnv('CENSUS_CLAMP_LIMITS', env);
  const added: CounterAdd[] = [];
  vi.doMock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
    createCounter: (name: string) => ({
      add: (value: number, attributes: unknown) => added.push({ name, value, attributes }),
    }),
  }));
  const config = await import('@/config/server-config.js');
  const { countLimit } = await import('@/mcp-server/tools/count-limit.js');
  const rows = countLimit({
    tool: 'census_query_data',
    default: 50,
    cap: 500,
    unit: ['row', 'rows'],
    describe: (bounds) => `Rows per page. ${bounds} Rows come in GEOID order.`,
  });
  const codes = countLimit({
    tool: 'census_list_predicate_values',
    default: 50,
    cap: 10_000,
    unit: ['code', 'codes'],
    describe: (bounds) => `Codes per page. ${bounds}`,
  });
  const runSetup = () => config.getServerConfig();
  if (setup) runSetup();
  return { added, codes, rows, runSetup };
}

/**
 * The `limit` property as a `tools/list` reply carries it: the SDK converts the schema through
 * `~standard`, and the reply is JSON, so a key holding `undefined` never reaches a client.
 */
const advertised = (limit: z.ZodType) => {
  const { properties } = z.object({ limit })['~standard'].jsonSchema.input({
    target: 'draft-2020-12',
  });
  return JSON.parse(JSON.stringify((properties as Record<string, unknown>).limit));
};

afterEach(() => {
  vi.doUnmock('@cyanheads/mcp-ts-core/utils');
  vi.unstubAllEnvs();
});

describe('countLimit schema', () => {
  it.each([
    ['clamp', undefined, 1],
    ['clamp', undefined, 500],
    ['clamp', undefined, 501],
    // Past Number.MAX_SAFE_INTEGER, which `.int()` would have rejected.
    ['clamp', undefined, 1e20],
    ['strict', 'false', 1],
    ['strict', 'false', 500],
  ] as const)('%s mode accepts %s=%s unchanged', async (_mode, env, value) => {
    const { rows } = await load({ env });
    const result = rows.schema.safeParse(value);

    expect(result.success).toBe(true);
    expect(result.data).toBe(value);
  });

  it.each([
    ['clamp', undefined, 0, { code: 'too_small', minimum: 1 }],
    ['clamp', undefined, -1, { code: 'too_small', minimum: 1 }],
    ['clamp', undefined, 2.5, { code: 'invalid_type', expected: 'int' }],
    ['strict', 'false', 0, { code: 'too_small', minimum: 1 }],
    ['strict', 'false', 2.5, { code: 'invalid_type', expected: 'int' }],
    ['strict', 'false', 501, { code: 'too_big', maximum: 500 }],
    ['strict', 'false', 1e20, { code: 'too_big', maximum: 500 }],
  ] as const)('%s mode rejects %s=%s', async (_mode, env, value, issue) => {
    const { rows } = await load({ env });
    const result = rows.schema.safeParse(value);

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([expect.objectContaining(issue)]);
  });

  it('says why a strict rejection failed in the message the framework relays', async () => {
    const { rows } = await load({ env: 'false' });

    expect(rows.schema.safeParse(501).error?.issues[0]?.message).toBe(
      'Too big: expected number to be <=500',
    );
    expect(rows.schema.safeParse(2.5).error?.issues[0]?.message).toBe(
      'Invalid input: expected int, received number',
    );
  });

  it('advertises an integer with a minimum and no maximum while clamping', async () => {
    const { codes, rows } = await load();

    expect(advertised(rows.schema)).toStrictEqual({
      type: 'integer',
      minimum: 1,
      description:
        'Rows per page. Default 50; a larger value returns at most 500 and says so. Rows come in GEOID order.',
    });
    expect(advertised(codes.schema)).toStrictEqual({
      type: 'integer',
      minimum: 1,
      description: 'Codes per page. Default 50; a larger value returns at most 10,000 and says so.',
    });
  });

  it('advertises the cap as the maximum with CENSUS_CLAMP_LIMITS=false', async () => {
    const { codes, rows } = await load({ env: 'false' });

    expect(advertised(rows.schema)).toStrictEqual({
      type: 'integer',
      minimum: 1,
      maximum: 500,
      description: 'Rows per page. Default 50, max 500. Rows come in GEOID order.',
    });
    expect(advertised(codes.schema)).toStrictEqual({
      type: 'integer',
      minimum: 1,
      maximum: 10_000,
      description: 'Codes per page. Default 50, max 10,000.',
    });
  });

  /**
   * `tool()` emits every input schema when its module is imported, before `setup()` has parsed
   * the environment, so the schema reads defaults until then and follows the parse after it.
   */
  it('reads the defaults until setup parses the switch, then follows it', async () => {
    const { rows, runSetup } = await load({ env: 'false', setup: false });

    expect(advertised(rows.schema)).not.toHaveProperty('maximum');
    expect(rows.schema.safeParse(501).success).toBe(true);

    runSetup();

    expect(advertised(rows.schema)).toMatchObject({ maximum: 500 });
    expect(rows.schema.safeParse(501).success).toBe(false);
  });
});

describe('countLimit apply', () => {
  it.each([
    ['omitted', undefined, 50],
    ['1', 1, 1],
    ['the cap', 500, 500],
  ] as const)(
    'serves %s as %s with no notice, log line, or count',
    async (_label, value, served) => {
      const { added, rows } = await load();
      const ctx = createMockContext();

      expect(rows.apply(ctx, value)).toStrictEqual({ limit: served });
      expect((ctx.log as MockContextLogger).calls).toEqual([]);
      expect(added).toEqual([]);
    },
  );

  it.each([
    [501, 'limit 501 is over the 500-row cap, so this page holds up to 500 rows.'],
    [
      1e20,
      'limit 100,000,000,000,000,000,000 is over the 500-row cap, so this page holds up to 500 rows.',
    ],
  ])('serves %s at the cap and says so', async (value, sentence) => {
    const { rows } = await load();

    expect(rows.apply(createMockContext(), value)).toStrictEqual({
      limit: 500,
      clampNotice: sentence,
    });
  });

  it('names the unit and formats the cap in the sentence', async () => {
    const { codes } = await load();

    expect(codes.apply(createMockContext(), 10_001).clampNotice).toBe(
      'limit 10,001 is over the 10,000-code cap, so this page holds up to 10,000 codes.',
    );
  });

  it('logs one info line naming the tool and both values, and adds 1 to census.limit.clamped', async () => {
    const { added, rows } = await load();
    const ctx = createMockContext();

    rows.apply(ctx, 600);

    expect((ctx.log as MockContextLogger).calls).toEqual([
      {
        level: 'info',
        msg: 'Limit above the cap served at the cap',
        data: { tool: 'census_query_data', requested: 600, served: 500 },
      },
    ]);
    expect(added).toEqual([
      {
        name: 'census.limit.clamped',
        value: 1,
        attributes: { 'mcp.tool.name': 'census_query_data' },
      },
    ]);
  });
});
