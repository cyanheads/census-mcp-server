/**
 * @fileoverview Tests for census_search_variables tool.
 * @module tests/tools/census-search-variables.tool.test
 */

import {
  createMockContext,
  getEnrichment,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { censusSearchVariables } from '@/mcp-server/tools/definitions/census-search-variables.tool.js';

// Mock the variable cache service and server config; dataset and default-year resolution stay real.
vi.mock('@/services/variable-cache/variable-cache-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/variable-cache/variable-cache-service.js')>()),
  getVariableCacheService: vi.fn(),
}));

vi.mock('@/config/server-config.js', () => ({
  activeDiscoveryConfig: vi.fn(() => ({ variableCacheTtlHours: 24, clampLimits: true })),
  getDiscoveryConfig: vi.fn(() => ({ variableCacheTtlHours: 24, clampLimits: true })),
}));

const mockSearchVariables = vi.fn();

beforeEach(async () => {
  vi.clearAllMocks();
  const { getVariableCacheService } = await import(
    '@/services/variable-cache/variable-cache-service.js'
  );
  vi.mocked(getVariableCacheService).mockReturnValue({
    searchVariables: mockSearchVariables,
  } as never);
});

describe('censusSearchVariables', () => {
  it('keeps genuine absent-code recovery (characterization)', async () => {
    mockSearchVariables.mockResolvedValue({
      variables: [],
      totalMatches: 0,
      termCount: 1,
      matchedTermCount: 0,
      codeMiss: { kind: 'absent', code: 'NOPE_1' },
    });
    const result = await runToolContract(censusSearchVariables, { query: 'NOPE_1' });
    expect(result.structuredContent).toMatchObject({
      totalMatches: 0,
      notice: expect.stringContaining('No variable or table'),
    });
  });

  it('passes offset to ranking and exposes continuation on both surfaces', async () => {
    mockSearchVariables.mockResolvedValue({
      variables: [{ code: 'C24010_051E', label: 'Estimate!!Total', predicateType: 'int' }],
      totalMatches: 146,
      codeMatches: 146,
      termCount: 1,
      matchedTermCount: 1,
    });
    const result = await runToolContract(censusSearchVariables, {
      query: 'C24010',
      limit: 1,
      offset: 100,
    });
    expect(mockSearchVariables).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 100 }),
      expect.anything(),
    );
    expect(result.structuredContent).toMatchObject({
      totalMatches: 146,
      nextOffset: 101,
      truncated: true,
    });
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).toContain('C24010_051E');
    expect(text).toContain('offset: 101');
  });

  it.each([2, 3])(
    'treats an empty existing match page at offset %s as past-end',
    async (offset) => {
      mockSearchVariables.mockResolvedValue({
        variables: [],
        totalMatches: 2,
        codeMatches: 2,
        termCount: 1,
        matchedTermCount: 1,
      });
      const result = await runToolContract(censusSearchVariables, {
        query: 'B19013',
        limit: 1,
        offset,
      });
      expect(result.structuredContent).toMatchObject({
        totalMatches: 2,
        truncated: false,
        notice: expect.stringContaining('past the'),
      });
      expect(result.structuredContent).not.toHaveProperty('nextOffset');
      expect(result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')).not.toContain(
        'No variables matched',
      );
    },
  );

  it.each([-1, 0.5])('rejects offset %s', (offset) => {
    expect(censusSearchVariables.input.safeParse({ query: 'income', offset }).success).toBe(false);
  });
  it('returns matching variables for a keyword query', async () => {
    mockSearchVariables.mockResolvedValue({
      variables: [
        {
          code: 'B19013_001E',
          label: 'Estimate!!Median household income in the past 12 months',
          concept: 'MEDIAN HOUSEHOLD INCOME IN THE PAST 12 MONTHS',
          predicateType: 'int',
          moeCode: 'B19013_001M',
        },
      ],
      totalMatches: 1,
    });

    const ctx = createMockContext({ errors: censusSearchVariables.errors });
    const input = censusSearchVariables.input.parse({ query: 'median household income' });
    const result = await censusSearchVariables.handler(input, ctx);

    expect(result.variables).toHaveLength(1);
    expect(result.variables[0]?.variable_code).toBe('B19013_001E');
    expect(result.variables[0]?.moe_code).toBe('B19013_001M');
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalMatches).toBe(1);
    expect(enrichment.dataset).toBe('acs/acs5');
    expect(enrichment.year).toBe(2024);
  });

  it('uses defaults when dataset and year are omitted', async () => {
    mockSearchVariables.mockResolvedValue({ variables: [], totalMatches: 0 });

    const ctx = createMockContext({ errors: censusSearchVariables.errors });
    const input = censusSearchVariables.input.parse({ query: 'poverty' });
    await censusSearchVariables.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.dataset).toBe('acs/acs5');
    expect(enrichment.year).toBe(2024);
    expect(mockSearchVariables).toHaveBeenCalledWith(
      expect.objectContaining({ dataset: 'acs/acs5', year: 2024 }),
      expect.anything(),
    );
  });

  /** #95: a limit above the 3,000 cap is served at the cap and said so; at the cap, it is not. */
  it.each([
    [
      3001,
      'limit 3,001 is over the 3,000-variable cap, so this page holds up to 3,000 variables. ',
    ],
    [3000, ''],
  ])('serves limit %i at 3,000, without advising a larger page', async (requested, clamp) => {
    mockSearchVariables.mockResolvedValue({
      variables: Array.from({ length: 3000 }, (_, i) => ({
        code: `B01001_${String(i).padStart(4, '0')}E`,
        label: 'Sex by age',
        concept: 'SEX BY AGE',
        predicateType: 'int',
      })),
      totalMatches: 19423,
    });

    const ctx = createMockContext({ errors: censusSearchVariables.errors });
    const input = censusSearchVariables.input.parse({ query: 'income', limit: requested });
    await censusSearchVariables.handler(input, ctx);

    expect(mockSearchVariables).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 3000 }),
      expect.anything(),
    );
    const enrichment = getEnrichment(ctx);
    expect(enrichment.cap).toBe(3000);
    expect(enrichment.notice).toBe(
      `${clamp}19,423 variables matched — 16,423 not shown. Call again with offset: 3000, keeping query, dataset, year and limit unchanged, for the next page. Narrow the query for fewer matches.`,
    );
  });

  /** `n` variables of one table, in code order. */
  const tableOf = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      code: `B01001_${String(i + 1).padStart(4, '0')}E`,
      label: 'Sex by age',
      concept: 'SEX BY AGE',
      predicateType: 'int',
    }));

  const CLAMP =
    'limit 3,001 is over the 3,000-variable cap, so this page holds up to 3,000 variables.';

  /** #95: a clamped limit is disclosed whichever notice the search ends on, not only a cut page. */
  it.each([
    [
      'no letters',
      { query: '!!!' },
      { variables: [], totalMatches: 0, termCount: 0, matchedTermCount: 0 },
      `${CLAMP} "!!!" has no letters or digits to match. Search with words from a variable's label or concept, such as "median household income".`,
    ],
    [
      'an offset past the end',
      { query: 'income', offset: 5 },
      { variables: [], totalMatches: 2, termCount: 1, matchedTermCount: 1 },
      `${CLAMP} offset 5 is past the last of the 2 matching variables. Pass an offset below 2, or offset: 0 to start again.`,
    ],
    [
      'no match',
      { query: 'xyzzy' },
      { variables: [], totalMatches: 0, termCount: 1, matchedTermCount: 0 },
      `${CLAMP} No variables matched "xyzzy". Try broader keywords or a different dataset.`,
    ],
    [
      'the last page',
      { query: 'income', offset: 2 },
      { variables: tableOf(1), totalMatches: 3, termCount: 1, matchedTermCount: 1 },
      `${CLAMP} This is the last page of 3 matching variables; offset: 0 starts again.`,
    ],
    [
      'a partial match on one page',
      { query: 'median tract' },
      { variables: tableOf(1), totalMatches: 1, termCount: 2, matchedTermCount: 1 },
      `No variable contains every word of "median tract"; these are the 1 that contain 1 of its 2 words, and each can be missing a different one. Change or drop a word to match them all. ${CLAMP}`,
    ],
    [
      'every match on one page',
      { query: 'income' },
      { variables: tableOf(1), totalMatches: 1, termCount: 1, matchedTermCount: 1 },
      CLAMP,
    ],
    [
      'a cut page of partial matches',
      { query: 'median income tract' },
      { variables: tableOf(3000), totalMatches: 19423, termCount: 3, matchedTermCount: 2 },
      `No variable contains every word of "median income tract"; these are the 19,423 that contain 2 of its 3 words, and each can be missing a different one. Change or drop a word to match them all. ${CLAMP} 19,423 variables matched — 16,423 not shown. Call again with offset: 3000, keeping query, dataset, year and limit unchanged, for the next page. Narrow the query for fewer matches.`,
    ],
  ])('discloses limit 3001 served at 3,000 on %s', async (_label, call, found, notice) => {
    mockSearchVariables.mockResolvedValue(found);

    const ctx = createMockContext({ errors: censusSearchVariables.errors });
    await censusSearchVariables.handler(
      censusSearchVariables.input.parse({ ...call, limit: 3001 }),
      ctx,
    );

    expect(getEnrichment(ctx).notice).toBe(notice);
  });

  it.each([
    [
      'an offset past the end',
      { query: 'income', offset: 20000 },
      { variables: [], totalMatches: 19423, termCount: 1, matchedTermCount: 1 },
      'offset 20,000 is past the last of the 19,423 matching variables. Pass an offset below 19,423, or offset: 0 to start again.',
    ],
    [
      'the last page',
      { query: 'income', offset: 1000, limit: 3000 },
      { variables: tableOf(200), totalMatches: 1200, termCount: 1, matchedTermCount: 1 },
      'This is the last page of 1,200 matching variables; offset: 0 starts again.',
    ],
    [
      'a partial match',
      { query: 'median tract', limit: 3000 },
      { variables: tableOf(1200), totalMatches: 1200, termCount: 2, matchedTermCount: 1 },
      'No variable contains every word of "median tract"; these are the 1,200 that contain 1 of its 2 words, and each can be missing a different one. Change or drop a word to match them all.',
    ],
  ])('groups the counts in the notice on %s', async (_label, call, found, notice) => {
    mockSearchVariables.mockResolvedValue(found);

    const ctx = createMockContext({ errors: censusSearchVariables.errors });
    await censusSearchVariables.handler(censusSearchVariables.input.parse(call), ctx);

    expect(getEnrichment(ctx).notice).toBe(notice);
  });

  it('logs the limit a clamped search was served with', async () => {
    mockSearchVariables.mockResolvedValue({
      variables: [],
      totalMatches: 0,
      termCount: 1,
      matchedTermCount: 0,
    });

    const ctx = createMockContext({ errors: censusSearchVariables.errors });
    await censusSearchVariables.handler(
      censusSearchVariables.input.parse({ query: 'income', limit: 3001 }),
      ctx,
    );

    expect((ctx.log as MockContextLogger).calls).toContainEqual({
      level: 'info',
      msg: 'Searching Census variables',
      data: { query: 'income', dataset: 'acs/acs5', year: 2024, limit: 3000 },
    });
  });

  it('returns empty variables list when no match', async () => {
    mockSearchVariables.mockResolvedValue({ variables: [], totalMatches: 0 });

    const ctx = createMockContext({ errors: censusSearchVariables.errors });
    const input = censusSearchVariables.input.parse({ query: 'xyzzy_nonexistent' });
    const result = await censusSearchVariables.handler(input, ctx);

    expect(result.variables).toHaveLength(0);
    expect(getEnrichment(ctx).totalMatches).toBe(0);
  });

  it('formats output with variable codes and concepts', () => {
    const output = {
      variables: [
        {
          variable_code: 'B19013_001E',
          label: 'Median household income',
          concept: 'MEDIAN HOUSEHOLD INCOME',
          predicate_type: 'int',
          moe_code: 'B19013_001M',
        },
      ],
    };
    const blocks = censusSearchVariables.format!(output);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('B19013_001E');
    expect(text).toContain('MEDIAN HOUSEHOLD INCOME');
    expect(text).toContain('B19013_001M');
  });

  it('throws dataset_not_found for an unknown dataset, before the service is called', async () => {
    const { JsonRpcErrorCode: codes } = await import('@cyanheads/mcp-ts-core/errors');
    const ctx = createMockContext({ errors: censusSearchVariables.errors });
    const input = censusSearchVariables.input.parse({ query: 'income', dataset: 'bogus/ds' });
    await expect(censusSearchVariables.handler(input, ctx)).rejects.toMatchObject({
      code: codes.NotFound,
      data: { reason: 'dataset_not_found', dataset: 'bogus/ds' },
    });
    expect(mockSearchVariables).not.toHaveBeenCalled();
  });

  it('throws variables_unavailable when service is down', async () => {
    const { McpError, JsonRpcErrorCode: codes } = await import('@cyanheads/mcp-ts-core/errors');
    mockSearchVariables.mockRejectedValue(
      new McpError(codes.ServiceUnavailable, 'Variable metadata fetch failed', {
        reason: 'variables_unavailable',
      }),
    );
    const ctx = createMockContext({ errors: censusSearchVariables.errors });
    const input = censusSearchVariables.input.parse({ query: 'poverty' });
    await expect(censusSearchVariables.handler(input, ctx)).rejects.toMatchObject({
      code: codes.ServiceUnavailable,
    });
  });

  it('sets notice enrichment when no variables matched', async () => {
    const { getEnrichment } = await import('@cyanheads/mcp-ts-core/testing');
    mockSearchVariables.mockResolvedValue({ variables: [], totalMatches: 0 });
    const ctx = createMockContext({ errors: censusSearchVariables.errors });
    const input = censusSearchVariables.input.parse({ query: 'zzznomatch' });
    await censusSearchVariables.handler(input, ctx);
    expect(getEnrichment(ctx).notice).toContain('zzznomatch');
  });

  it('keeps the keyword advice for a query that is not shaped like a code (characterization)', async () => {
    mockSearchVariables.mockResolvedValue({
      variables: [],
      totalMatches: 0,
      matchedTermCount: 0,
      termCount: 1,
    });
    const ctx = createMockContext({ errors: censusSearchVariables.errors });
    await censusSearchVariables.handler(censusSearchVariables.input.parse({ query: 'xyzzy' }), ctx);
    expect(getEnrichment(ctx).notice).toBe(
      'No variables matched "xyzzy". Try broader keywords or a different dataset.',
    );
  });

  describe('an empty result for a code (#63)', () => {
    const noticeFor = async (
      query: string,
      codeMiss: unknown,
      scope: { dataset?: string; year?: number } = {},
    ) => {
      mockSearchVariables.mockResolvedValue({
        variables: [],
        totalMatches: 0,
        matchedTermCount: 0,
        termCount: 2,
        codeMiss,
      });
      const ctx = createMockContext({ errors: censusSearchVariables.errors });
      await censusSearchVariables.handler(
        censusSearchVariables.input.parse({ query, ...scope }),
        ctx,
      );
      return getEnrichment(ctx).notice as string;
    };

    it('names the sibling dataset that holds the code', async () => {
      const notice = await noticeFor('s1701_c03_001e', {
        kind: 'sibling',
        code: 'S1701_C03_001E',
        sibling: 'acs/acs5/subject',
      });
      expect(notice).toBe(
        'No variables matched "s1701_c03_001e" in acs/acs5 (2024). S1701_C03_001E is in acs/acs5/subject — query that dataset instead.',
      );
    });

    /** The code is named as the dataset spells it, never as the query typed it. */
    it('points a significance column at census_get_variable, in its published spelling', async () => {
      const notice = await noticeFor(
        'cp03_2024to2019_062ss',
        { kind: 'attribute', code: 'CP03_2024to2019_062SS' },
        { dataset: 'acs/acs5/cprofile', year: 2024 },
      );
      expect(notice).toBe(
        'CP03_2024to2019_062SS is an attribute column of acs/acs5/cprofile (2024) — an annotation, flag, label, or significance column published beside a variable, which search does not list. Call census_get_variable with CP03_2024to2019_062SS for its label and the variable it belongs to.',
      );
    });

    it('says the code is not in the dataset, without the keyword advice', async () => {
      const notice = await noticeFor('nope_1', { kind: 'absent', code: 'NOPE_1' });
      expect(notice).toBe(
        'No variable or table in acs/acs5 (2024) has the code "NOPE_1", and no label or concept contains it. Codes differ by dataset and vintage: check the code and year, or search with words from the variable\'s label.',
      );
    });
  });

  it('adds no partial-match notice when the query matched as a code (#63)', async () => {
    mockSearchVariables.mockResolvedValue({
      variables: [
        {
          code: 'B19013_001E',
          label: 'Estimate!!Median household income',
          predicateType: 'int',
          moeCode: 'B19013_001M',
        },
      ],
      totalMatches: 1,
      matchedTermCount: 2,
      termCount: 2,
    });
    const ctx = createMockContext({ errors: censusSearchVariables.errors });
    await censusSearchVariables.handler(
      censusSearchVariables.input.parse({ query: 'b19013_001e' }),
      ctx,
    );
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('discloses truncation enrichment when total_matches exceeds the limit', async () => {
    mockSearchVariables.mockResolvedValue({
      variables: [
        {
          code: 'B19013_001E',
          label: 'Median household income',
          concept: 'MEDIAN HOUSEHOLD INCOME',
          predicateType: 'int',
        },
      ],
      totalMatches: 42,
    });
    const ctx = createMockContext({ errors: censusSearchVariables.errors });
    const input = censusSearchVariables.input.parse({ query: 'income', limit: 1 });
    await censusSearchVariables.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(1);
    expect(enrichment.cap).toBe(1);
    expect(enrichment.notice).toContain('42');
  });

  it('says where a table cut at the limit continues, not to narrow the query (#63)', async () => {
    const shown = ['S1701_C01_001E', 'S1701_C01_001M', 'S1701_C02_001E', 'S1701_C02_001M'];
    mockSearchVariables.mockResolvedValue({
      variables: shown.map((code) => ({ code, label: 'Estimate!!Total', predicateType: 'int' })),
      totalMatches: 372,
      codeMatches: 372,
      matchedTermCount: 1,
      termCount: 1,
    });
    const ctx = createMockContext({ errors: censusSearchVariables.errors });
    await censusSearchVariables.handler(
      censusSearchVariables.input.parse({ query: 'S1701', limit: 4 }),
      ctx,
    );
    expect(getEnrichment(ctx).notice).toBe(
      '372 variables matched — 368 not shown; the table continues in code order after S1701_C02_001M. Call again with offset: 4, keeping query, dataset, year and limit unchanged, for the next page. Raise limit (max 3,000) for a larger page.',
    );

    const atMax = createMockContext({ errors: censusSearchVariables.errors });
    mockSearchVariables.mockResolvedValue({
      variables: Array.from({ length: 3000 }, (_, i) => ({
        code: `S1701_C01_${String(i + 1).padStart(4, '0')}E`,
        label: 'Estimate!!Total',
        predicateType: 'int',
      })),
      totalMatches: 3372,
      codeMatches: 3372,
      matchedTermCount: 1,
      termCount: 1,
    });
    await censusSearchVariables.handler(
      censusSearchVariables.input.parse({ query: 'S1701', limit: 3000 }),
      atMax,
    );
    const notice = getEnrichment(atMax).notice as string;
    expect(notice).toContain('after S1701_C01_3000E. Call again with offset: 3000');
    expect(notice).not.toMatch(/narrow|raise limit/i);
  });

  it('keeps the narrowing advice when the cut falls among keyword matches (#63)', async () => {
    mockSearchVariables.mockResolvedValue({
      variables: [{ code: 'GEO_ID', label: 'Geography', predicateType: 'string' }],
      totalMatches: 2,
      codeMatches: 1,
      matchedTermCount: 2,
      termCount: 2,
    });
    const ctx = createMockContext({ errors: censusSearchVariables.errors });
    await censusSearchVariables.handler(
      censusSearchVariables.input.parse({ query: 'GEO_ID', limit: 1 }),
      ctx,
    );
    expect(getEnrichment(ctx).notice).toBe(
      '2 variables matched — 1 not shown. Call again with offset: 1, keeping query, dataset, year and limit unchanged, for the next page. Narrow the query or raise limit (max 3,000).',
    );
  });

  it('passes custom year to variable cache service', async () => {
    mockSearchVariables.mockResolvedValue({ variables: [], totalMatches: 0 });
    const ctx = createMockContext({ errors: censusSearchVariables.errors });
    const input = censusSearchVariables.input.parse({ query: 'income', year: 2020 });
    await censusSearchVariables.handler(input, ctx);
    expect(mockSearchVariables).toHaveBeenCalledWith(
      expect.objectContaining({ year: 2020 }),
      expect.anything(),
    );
  });

  it('applies minimum limit of 1 without crashing', async () => {
    mockSearchVariables.mockResolvedValue({ variables: [], totalMatches: 0 });
    const ctx = createMockContext({ errors: censusSearchVariables.errors });
    const input = censusSearchVariables.input.parse({ query: 'income', limit: 1 });
    await censusSearchVariables.handler(input, ctx);
    expect(mockSearchVariables).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1 }),
      expect.anything(),
    );
  });

  it('format includes estimate_code when present', () => {
    const output = {
      variables: [
        {
          variable_code: 'B19013_001M',
          label: 'Margin of error!!Median household income',
          concept: 'MEDIAN HOUSEHOLD INCOME',
          predicate_type: 'int',
          estimate_code: 'B19013_001E',
        },
      ],
    };
    const blocks = censusSearchVariables.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('B19013_001E');
  });

  it('format output never contains API key', () => {
    const output = {
      variables: [
        {
          variable_code: 'B19013_001E',
          label: 'Median income',
          concept: 'MEDIAN INCOME',
          predicate_type: 'int',
        },
      ],
    };
    const blocks = censusSearchVariables.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).not.toMatch(/CENSUS_API_KEY/);
    expect(text).not.toMatch(/api.key/i);
  });

  it('injection attempt in query string is safely passed to service', async () => {
    mockSearchVariables.mockResolvedValue({ variables: [], totalMatches: 0 });
    const ctx = createMockContext({ errors: censusSearchVariables.errors });
    const injectionPayload = "'; DROP TABLE vars; --";
    const input = censusSearchVariables.input.parse({ query: injectionPayload });
    const result = await censusSearchVariables.handler(input, ctx);
    expect(result.variables).toHaveLength(0);
    // Query was forwarded as-is — no sanitization error
    expect(mockSearchVariables).toHaveBeenCalledWith(
      expect.objectContaining({ query: injectionPayload }),
      expect.anything(),
    );
  });
});
