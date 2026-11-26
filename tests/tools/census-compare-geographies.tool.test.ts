/**
 * @fileoverview Tests for census_compare_geographies tool.
 * @module tests/tools/census-compare-geographies.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { censusCompareGeographies } from '@/mcp-server/tools/definitions/census-compare-geographies.tool.js';
import { yearNotAvailable } from '@/services/census-api/errors.js';
import { DATASET_AVAILABLE_YEARS } from '@/services/variable-cache/variable-cache-service.js';
import { readVariableLabels } from '../helpers/variable-labels-readback.js';

vi.mock('@/services/census-api/census-api-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/census-api/census-api-service.js')>()),
  getCensusApiService: vi.fn(),
}));

vi.mock('@/services/variable-cache/variable-cache-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/variable-cache/variable-cache-service.js')>()),
  getVariableCacheService: vi.fn(),
}));

vi.mock('@/config/server-config.js', () => ({
  activeDiscoveryConfig: vi.fn(() => ({ variableCacheTtlHours: 24, clampLimits: true })),
  getDiscoveryConfig: vi.fn(() => ({ variableCacheTtlHours: 24, clampLimits: true })),
  getServerConfig: vi.fn(() => ({
    censusApiKey: 'test-key',
    variableCacheTtlHours: 24,
    clampLimits: true,
  })),
}));

/** Every text block of a tool result's content[], joined. */
const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((block) => block.text ?? '').join('\n');

const mockQueryData = vi.fn();
const mockCheckGeography = vi.fn();
const mockLookupVariables = vi.fn();
const mockCheckPredicates = vi.fn();
const mockGetRecordDimensions = vi.fn();
const mockValidateYear = vi.fn();
const mockResolveSpellings = vi.fn();

describe('comparison ranking and paging contract', () => {
  const base = { variables: ['B19013_001E'], geography_level: 'county' };
  const fixture = () =>
    (
      [
        ['53005', 20],
        ['53009', null],
        ['53001', 30],
        ['53003', 20],
        ['53007', 10],
      ] as const
    ).map(([geoid, estimate]) => ({
      geographyName: `County ${geoid}`,
      geographyFips: String(geoid).slice(2),
      geographyGeoid: String(geoid),
      variables: { B19013_001E: { estimate, suppressed: estimate === null } },
    }));

  it.each([
    ['desc', ['53001', '53003', '53005', '53007', '53009']],
    ['asc', ['53007', '53003', '53005', '53001', '53009']],
  ] as const)(
    'shares numeric competition ranks in %s order with nulls last',
    async (sort_dir, ids) => {
      mockQueryData.mockResolvedValue(fixture());
      const result = await runToolContract(censusCompareGeographies, { ...base, sort_dir });
      expect(result.isError).toBeFalsy();
      const data = result.structuredContent as {
        rows: Array<{ geography_geoid: string; rank: number }>;
        nextOffset?: number;
        scopeCount?: number;
        truncated: boolean;
      };
      expect(data.rows.map((row) => row.geography_geoid)).toEqual(ids);
      expect(data.rows.map((row) => row.rank)).toEqual([1, 2, 2, 4, 5]);
      expect(data.truncated).toBe(false);
      expect(data).not.toHaveProperty('nextOffset');
      expect(data).not.toHaveProperty('scopeCount');
      const text = result.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      expect(text).toContain(`### 2. County ${ids[1]}`);
      expect(text).toContain(`### 2. County ${ids[2]}`);
    },
  );

  it.each([
    [
      1000,
      'Rows 1,001–1,200 of 1,200. This is the last page; offset: 0 starts from the first row.',
    ],
    [
      1200,
      'offset 1,200 is at or past the last of the 1,200 matched rows, so no rows are returned. Pass an offset below 1,200; offset: 0 starts from the first row.',
    ],
  ])('groups the counts in the terminal notice at offset %i', async (offset, notice) => {
    mockQueryData.mockResolvedValue(
      Array.from({ length: 1200 }, (_, i) => {
        const geoid = `53${String(i).padStart(3, '0')}`;
        return {
          geographyName: `County ${geoid}`,
          geographyFips: geoid.slice(2),
          geographyGeoid: geoid,
          variables: { B19013_001E: { estimate: i, suppressed: false } },
        };
      }),
    );
    const result = await runToolContract(censusCompareGeographies, { ...base, limit: 500, offset });

    expect((result.structuredContent as { notice?: string }).notice).toContain(notice);
  });

  it('pages through a numeric tie without overlap and retains ranks and terminal notices', async () => {
    mockQueryData.mockResolvedValue(fixture());
    const pages = [];
    for (const offset of [0, 2, 4, 5, 9]) {
      const result = await runToolContract(censusCompareGeographies, {
        ...base,
        limit: 2,
        offset,
      });
      expect(result.isError).toBeFalsy();
      const data = result.structuredContent as {
        rows: Array<{ geography_geoid: string; rank: number }>;
        totalCount: number;
        truncated: boolean;
        nextOffset?: number;
        notice?: string;
      };
      const text = result.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      expect(data.totalCount).toBe(5);
      expect(data.truncated).toBe(offset < 4);
      if (offset < 4) {
        expect(data.nextOffset).toBe(offset + 2);
        expect(text).toContain('nextOffset');
      } else expect(data).not.toHaveProperty('nextOffset');
      if (offset === 0 || offset === 2) {
        expect(data.notice).toContain('tie');
        expect(text).toContain('tie');
      }
      if (offset === 4) {
        expect(data.notice).toContain('last page');
        expect(text).toContain('last page');
      }
      if (offset >= 5) {
        expect(data.rows).toEqual([]);
        expect(data.notice).toContain('past');
        expect(text).toContain('past');
      }
      pages.push(data.rows);
    }
    expect(
      pages
        .slice(0, 3)
        .flat()
        .map((row) => [row.geography_geoid, row.rank]),
    ).toEqual([
      ['53001', 1],
      ['53003', 2],
      ['53005', 2],
      ['53007', 4],
      ['53009', 5],
    ]);
  });

  it.each(['asc', 'desc'] as const)(
    'keeps subset and scope competition ranks distinct in %s order',
    async (sort_dir) => {
      mockQueryData.mockResolvedValue(fixture());
      const result = await runToolContract(censusCompareGeographies, {
        ...base,
        sort_dir,
        within: '53',
        geographies: ['53005', '53003'],
      });
      expect(result.isError).toBeFalsy();
      const data = result.structuredContent as {
        rows: Array<{ rank: number; scope_rank?: number }>;
        scopeCount: number;
        totalCount: number;
      };
      expect(data.rows.map((row) => [row.rank, row.scope_rank])).toEqual([
        [1, 2],
        [1, 2],
      ]);
      expect(data.scopeCount).toBe(5);
      expect(data.totalCount).toBe(2);
      const text = result.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      expect(text).toContain('Scope rank');
      expect(text).toContain('scopeCount');
    },
  );

  it('keeps scope ranks before filtering and subset ranks before paging', async () => {
    mockQueryData.mockResolvedValue(fixture());
    const result = await runToolContract(censusCompareGeographies, {
      ...base,
      geographies: ['53003', '53005', '53007'],
      offset: 1,
      limit: 1,
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as {
      rows: Array<{ geography_geoid: string; rank: number; scope_rank?: number }>;
      scopeCount: number;
      totalCount: number;
      nextOffset?: number;
    };
    expect(data.rows.map((row) => [row.geography_geoid, row.rank, row.scope_rank])).toEqual([
      ['53005', 1, 2],
    ]);
    expect(data).toMatchObject({ scopeCount: 5, totalCount: 3, nextOffset: 2 });
  });

  it('ties open-ended boundaries and warns when the cap cuts through them', async () => {
    mockQueryData.mockResolvedValue(
      fixture()
        .slice(0, 3)
        .map((row) => ({
          ...row,
          variables: {
            B19013_001E: { estimate: 250001, openEnded: true, suppressed: false },
          },
        })),
    );
    const result = await runToolContract(censusCompareGeographies, { ...base, limit: 2 });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as {
      rows: Array<{ rank: number; variables: Record<string, { open_ended?: boolean }> }>;
      notice: string;
    };
    expect(data.rows.map((row) => row.rank)).toEqual([1, 1]);
    expect(data.rows.map((row) => row.variables.B19013_001E?.open_ended)).toEqual([true, true]);
    expect(data.notice).toContain('tie');
    expect(
      result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'),
    ).toContain('open-ended');
  });

  it('retains no_data and its recovery on both surfaces for an unmatched subset', async () => {
    mockQueryData.mockResolvedValue(fixture());
    const result = await runToolContract(censusCompareGeographies, {
      ...base,
      geographies: ['99999'],
    });
    const data = result.structuredContent as {
      error: { data: { reason: string; recovery: { hint: string } } };
    };
    expect(result.isError).toBe(true);
    expect(data.error.data.reason).toBe('no_data');
    expect(data.error.data.recovery.hint).toContain('full GEOID');
    expect(
      result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'),
    ).toContain('full GEOID');
  });

  it('omits continuation and scope data when the entire result fits exactly at the cap', async () => {
    mockQueryData.mockResolvedValue(fixture());
    const result = await runToolContract(censusCompareGeographies, { ...base, limit: 5 });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as {
      rows: Array<{ scope_rank?: number }>;
      truncated: boolean;
    };
    expect(data.truncated).toBe(false);
    expect(data).not.toHaveProperty('nextOffset');
    expect(data).not.toHaveProperty('scopeCount');
    expect(data.rows.every((row) => !Object.hasOwn(row, 'scope_rank'))).toBe(true);
    expect(
      result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'),
    ).not.toContain('nextOffset');
  });

  it('preserves return-order ordinals when every estimate is nonnumeric', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'Z',
        geographyFips: '003',
        geographyGeoid: '53003',
        variables: { GEO_ID: { estimate: null, value: 'Z', suppressed: false } },
      },
      {
        geographyName: 'A',
        geographyFips: '001',
        geographyGeoid: '53001',
        variables: { GEO_ID: { estimate: null, value: 'A', suppressed: false } },
      },
    ]);
    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const out = await censusCompareGeographies.handler(
      censusCompareGeographies.input.parse({ variables: ['GEO_ID'], geography_level: 'county' }),
      ctx,
    );
    expect(out.rows.map((row) => [row.geography_geoid, row.rank])).toEqual([
      ['53003', 1],
      ['53001', 2],
    ]);
    expect(getEnrichment(ctx).notice).toContain('rows are not ranked');
  });
});

beforeEach(async () => {
  vi.clearAllMocks();

  const { getCensusApiService } = await import('@/services/census-api/census-api-service.js');
  vi.mocked(getCensusApiService).mockReturnValue({
    queryData: mockQueryData,
    checkGeography: mockCheckGeography,
  } as never);

  // Default: the level and its parents are valid for the dataset.
  mockCheckGeography.mockResolvedValue({ status: 'ok' });

  const { getVariableCacheService } = await import(
    '@/services/variable-cache/variable-cache-service.js'
  );
  vi.mocked(getVariableCacheService).mockReturnValue({
    lookupVariables: mockLookupVariables,
    checkPredicates: mockCheckPredicates,
    getRecordDimensions: mockGetRecordDimensions,
    validateYear: mockValidateYear,
    resolveSpellings: mockResolveSpellings,
  } as never);

  // Default: the dataset spells every code in uppercase, as every non-comparison-profile one does.
  mockResolveSpellings.mockImplementation(async (codes: string[]) =>
    codes.map((code) => code.toUpperCase()),
  );

  /**
   * The real check, not a stub: a test that asserts the year is refused before the first
   * request is only meaningful if the mock refuses the same years the service does.
   */
  mockValidateYear.mockImplementation((dataset: string, year: number) => {
    const years = DATASET_AVAILABLE_YEARS[dataset];
    if (years && !years.includes(year)) throw yearNotAvailable(dataset, year, years);
  });

  // Default: the dataset declares no filter dimensions, so nothing is unset or unknown.
  mockCheckPredicates.mockResolvedValue({ filterDimensions: [], unset: [], unknown: [] });

  // Default: the dataset publishes one row per geography, so nothing separates records.
  mockGetRecordDimensions.mockResolvedValue([]);

  // Default: the variable cache has no entry for any requested code, so none has a label.
  mockLookupVariables.mockResolvedValue(new Map());
});

describe('censusCompareGeographies', () => {
  it('returns ranked rows sorted by sort variable descending', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'King County, WA',
        geographyFips: '033',
        geographyGeoid: '53033',
        variables: {
          B19013_001E: { estimate: 105000, suppressed: false },
        },
      },
      {
        geographyName: 'Pierce County, WA',
        geographyFips: '053',
        geographyGeoid: '53053',
        variables: {
          B19013_001E: { estimate: 72000, suppressed: false },
        },
      },
      {
        geographyName: 'Spokane County, WA',
        geographyFips: '063',
        geographyGeoid: '53063',
        variables: {
          B19013_001E: { estimate: 65000, suppressed: false },
        },
      },
    ]);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      within: '53',
    });
    const result = await censusCompareGeographies.handler(input, ctx);

    expect(result.rows).toHaveLength(3);
    // Default sort is desc — rank 1 should be the highest value
    expect(result.rows[0]?.geography_name).toBe('King County, WA');
    expect(result.rows[0]?.rank).toBe(1);
    expect(result.rows[1]?.rank).toBe(2);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.sortVariable).toBe('B19013_001E');
    expect(enrichment.totalCount).toBe(3);
    expect(enrichment.truncated).toBe(false);
  });

  it('sorts ascending when sort_dir is asc', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'King County, WA',
        geographyFips: '033',
        geographyGeoid: '53033',
        variables: {
          B19013_001E: { estimate: 105000, suppressed: false },
        },
      },
      {
        geographyName: 'Spokane County, WA',
        geographyFips: '063',
        geographyGeoid: '53063',
        variables: {
          B19013_001E: { estimate: 65000, suppressed: false },
        },
      },
    ]);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      sort_dir: 'asc',
    });
    const result = await censusCompareGeographies.handler(input, ctx);

    // Ascending: lowest value is rank 1
    expect(result.rows[0]?.geography_name).toBe('Spokane County, WA');
    expect(result.rows[0]?.rank).toBe(1);
  });

  /**
   * A nationwide county query returns the bare level code in geographyFips ("033") and
   * the state-qualified GEOID in geographyGeoid ("53033") — the shape
   * CensusApiService.parseResponse actually produces. Fixtures that pre-compose
   * geographyFips hide the cross-state filter bug instead of exercising it.
   */
  const nationwideCounties = () => [
    {
      geographyName: 'King County, Washington',
      geographyFips: '033',
      geographyGeoid: '53033',
      variables: { B19013_001E: { estimate: 105000, suppressed: false } },
    },
    {
      geographyName: 'Los Angeles County, California',
      geographyFips: '037',
      geographyGeoid: '06037',
      variables: { B19013_001E: { estimate: 82000, suppressed: false } },
    },
    {
      geographyName: 'Autauga County, Alabama',
      geographyFips: '001',
      geographyGeoid: '01001',
      variables: { B19013_001E: { estimate: 69000, suppressed: false } },
    },
  ];

  it('filters to full GEOIDs spanning more than one state', async () => {
    mockQueryData.mockResolvedValue(nationwideCounties());

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      geographies: ['53033', '06037'],
    });
    const result = await censusCompareGeographies.handler(input, ctx);

    expect(result.rows.map((r) => r.geography_name)).toEqual([
      'King County, Washington',
      'Los Angeles County, California',
    ]);
    expect(result.rows.map((r) => r.geography_geoid)).toEqual(['53033', '06037']);
    // The bare level code stays intact for the census_query_data round-trip.
    expect(result.rows[0]?.geography_fips).toBe('033');
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('filters to bare level codes when within scopes the comparison to one state', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'King County, Washington',
        geographyFips: '033',
        geographyGeoid: '53033',
        variables: { B19013_001E: { estimate: 105000, suppressed: false } },
      },
      {
        geographyName: 'Pierce County, Washington',
        geographyFips: '053',
        geographyGeoid: '53053',
        variables: { B19013_001E: { estimate: 72000, suppressed: false } },
      },
    ]);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      within: '53',
      geographies: ['033'],
    });
    const result = await censusCompareGeographies.handler(input, ctx);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.geography_name).toBe('King County, Washington');
  });

  it('notices the geographies entries that matched no row', async () => {
    mockQueryData.mockResolvedValue(nationwideCounties());

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      geographies: ['53033', '99999'],
    });
    const result = await censusCompareGeographies.handler(input, ctx);

    expect(result.rows).toHaveLength(1);
    // Only the entry that matched nothing is named — the matched one is not.
    expect(getEnrichment(ctx).notice).toContain('1 of the requested geographies: 99999');
  });

  it('notices a bare level code that matched a geography in more than one state', async () => {
    mockCheckGeography.mockResolvedValue({ status: 'ok', acceptedParents: ['state'] });
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'King County, Washington',
        geographyFips: '033',
        geographyGeoid: '53033',
        variables: { B19013_001E: { estimate: 105000, suppressed: false } },
      },
      {
        geographyName: "Prince George's County, Maryland",
        geographyFips: '033',
        geographyGeoid: '24033',
        variables: { B19013_001E: { estimate: 97000, suppressed: false } },
      },
    ]);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      geographies: ['033'],
    });
    const result = await censusCompareGeographies.handler(input, ctx);

    // The rows are real counties, so nothing is unmatched — the ambiguity is the finding.
    expect(result.rows).toHaveLength(2);
    expect(getEnrichment(ctx).notice).toContain(
      '033 matched more than one county because a bare level code carries no parent. Use within to scope the comparison, or pass full GEOIDs (e.g. "53033") to name exactly the geographies you want.',
    );
  });

  it('points a bare block group code that matched under several tracts at full GEOIDs alone', async () => {
    mockCheckGeography.mockResolvedValue({
      status: 'ok',
      acceptedParents: ['state', 'county', 'tract'],
    });
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'Block Group 1, Census Tract 71, King County, Washington',
        geographyFips: '1',
        geographyGeoid: '530330071001',
        variables: { B19013_001E: { estimate: 105000, suppressed: false } },
      },
      {
        geographyName: 'Block Group 1, Census Tract 72, King County, Washington',
        geographyFips: '1',
        geographyGeoid: '530330072001',
        variables: { B19013_001E: { estimate: 97000, suppressed: false } },
      },
    ]);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'block group',
      within: '53',
      within_county: '033',
      geographies: ['1'],
    });
    await censusCompareGeographies.handler(input, ctx);

    // Both parents the comparison takes are already set, so no scope input narrows it further.
    expect(getEnrichment(ctx).notice).toContain(
      '1 matched more than one block group because a bare level code carries no parent. Pass full GEOIDs (e.g. "53033") to name exactly the geographies you want.',
    );
  });

  /** #97: a bare 6-digit tract matched in the 4 digits dec/pl 2000 lists it by is named as written. */
  it('names a bare dec/pl 2000 tract entry that matched more than one tract as written', async () => {
    mockCheckGeography.mockResolvedValue({ status: 'ok', acceptedParents: ['state', 'county'] });
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'Census Tract 71, King County, Washington',
        geographyFips: '0071',
        geographyGeoid: '530330071',
        variables: { PL001001: { estimate: 1809, suppressed: false } },
      },
      {
        geographyName: 'Census Tract 71, Snohomish County, Washington',
        geographyFips: '0071',
        geographyGeoid: '530610071',
        variables: { PL001001: { estimate: 2400, suppressed: false } },
      },
    ]);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['PL001001'],
      dataset: 'dec/pl',
      year: 2000,
      geography_level: 'tract',
      within: '53',
      geographies: ['007100'],
    });
    const result = await censusCompareGeographies.handler(input, ctx);

    expect(result.rows).toHaveLength(2);
    // within names the state, so the parent left open is the county.
    expect(getEnrichment(ctx).notice).toContain(
      '007100 matched more than one tract because a bare level code carries no parent. Use within_county to scope the comparison, or pass full GEOIDs (e.g. "53033") to name exactly the geographies you want.',
    );
  });

  it('stays silent when within scopes a bare level code to a single match', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'King County, Washington',
        geographyFips: '033',
        geographyGeoid: '53033',
        variables: { B19013_001E: { estimate: 105000, suppressed: false } },
      },
    ]);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      within: '53',
      geographies: ['033'],
    });
    await censusCompareGeographies.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('throws no_data when the geographies filter drops every row', async () => {
    mockQueryData.mockResolvedValue(nationwideCounties());

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      geographies: ['99998', '99999'],
    });
    await expect(censusCompareGeographies.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_data', unmatchedGeographies: ['99998', '99999'] },
    });
  });

  it('truncates results when count exceeds limit', async () => {
    const manyRows = Array.from({ length: 60 }, (_, i) => ({
      geographyName: `County ${i}`,
      geographyFips: String(i).padStart(5, '0'),
      geographyGeoid: String(i).padStart(5, '0'),
      variables: {
        B19013_001E: {
          estimate: 50000 + i * 100,
          suppressed: false,
        },
      },
    }));
    mockQueryData.mockResolvedValue(manyRows);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      limit: 10,
    });
    const result = await censusCompareGeographies.handler(input, ctx);

    expect(result.rows).toHaveLength(10);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.totalCount).toBe(60);
  });

  it('passes countyFips to apiService when within_county is provided', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'Census Tract 1, King County, Washington',
        geographyFips: '000100',
        geographyGeoid: '53033000100',
        variables: {
          B19013_001E: { estimate: 98000, suppressed: false },
        },
      },
    ]);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'tract',
      within: '53',
      within_county: '033',
    });
    await censusCompareGeographies.handler(input, ctx);

    expect(mockQueryData).toHaveBeenCalledWith(
      expect.objectContaining({ parentFips: '53', countyFips: '033' }),
      expect.anything(),
    );
  });

  it('omits countyFips from apiService when within_county is not provided', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'King County, WA',
        geographyFips: '033',
        geographyGeoid: '53033',
        variables: {
          B19013_001E: { estimate: 105000, suppressed: false },
        },
      },
    ]);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      within: '53',
    });
    await censusCompareGeographies.handler(input, ctx);

    const callArgs = mockQueryData.mock.calls[0]?.[0];
    expect(callArgs).not.toHaveProperty('countyFips');
  });

  it('throws dataset_not_found for unknown dataset', async () => {
    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      dataset: 'invalid/dataset',
    });
    await expect(censusCompareGeographies.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'dataset_not_found' },
    });
  });

  it('throws no_data when API returns empty rows', async () => {
    mockQueryData.mockResolvedValue([]);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
    });
    await expect(censusCompareGeographies.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_data' },
    });
  });

  describe('no_data recovery for a predicated comparison (#101)', () => {
    const hintOf = async (input: Record<string, unknown>) => {
      const result = await runToolContract(censusCompareGeographies, input as never);
      const { reason, recovery } = (
        result.structuredContent as {
          error: { data: { reason: string; recovery: { hint: string } } };
        }
      ).error.data;
      return { reason, hint: recovery.hint, text: textOf(result as never) };
    };

    it('names an unset ecnbasic NAICS dimension', async () => {
      mockCheckPredicates.mockResolvedValue({
        unset: [
          { code: 'NAICS2022', label: '2022 NAICS code' },
          { code: 'TAXSTAT', label: 'Tax status code' },
        ],
        unknown: [],
      });
      mockQueryData.mockResolvedValue([]);

      const { reason, hint } = await hintOf({
        variables: ['ESTAB'],
        geography_level: 'county',
        within: '53',
        dataset: 'ecnbasic',
        year: 2022,
      });

      expect(reason).toBe('no_data');
      expect(hint).toContain('until NAICS2022 is set');
      expect(hint).not.toContain('TAXSTAT');
    });

    it('names the NAICS range a two-digit code sits in, on both surfaces, and not EMPSZES or LFO', async () => {
      mockCheckPredicates.mockResolvedValue({
        unset: [
          { code: 'EMPSZES', label: 'Employment size of establishments code' },
          { code: 'LFO', label: 'Legal form of organization code' },
        ],
        unknown: [],
      });
      mockQueryData.mockResolvedValue([]);

      const { reason, hint, text } = await hintOf({
        variables: ['ESTAB'],
        geography_level: 'county',
        within: '53',
        dataset: 'cbp',
        year: 2021,
        predicates: { NAICS2017: '48' },
      });

      expect(reason).toBe('no_data');
      expect(hint).toContain('so NAICS2017 "48" returns no row — send "48-49"');
      expect(hint).toContain('check the NAICS2017 value');
      expect(hint).not.toMatch(/EMPSZES|LFO/);
      expect(text).toContain('send "48-49" for the whole sector');
    });

    it('documents the three NAICS ranges in the predicates description', () => {
      const schema = censusCompareGeographies.input.toJSONSchema() as {
        properties: Record<string, { description?: string }>;
      };
      const description = schema.properties.predicates?.description ?? '';

      for (const range of ['31-33', '44-45', '48-49']) expect(description).toContain(range);
      expect(description).not.toContain('at any depth');
    });
  });

  it('throws parent_required before querying when within is missing', async () => {
    mockCheckGeography.mockResolvedValue({ status: 'parent_required', missingParents: ['state'] });

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'tract',
    });
    await expect(censusCompareGeographies.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'parent_required', missingParents: ['state'] },
    });
    expect(mockQueryData).not.toHaveBeenCalled();
  });

  it('parent_required names within_county when the county parent is missing', async () => {
    mockCheckGeography.mockResolvedValue({ status: 'parent_required', missingParents: ['county'] });

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'block group',
      within: '53',
    });
    await expect(censusCompareGeographies.handler(input, ctx)).rejects.toMatchObject({
      data: { recovery: { hint: expect.stringContaining('within_county') } },
    });
  });

  /**
   * `urban area` names no parent, so a `within` scope builds a hierarchy the Census API answers
   * with an untyped 400 that names neither the offending input nor a way forward.
   */
  it('throws parent_not_accepted naming within as the input to drop', async () => {
    mockCheckGeography.mockResolvedValue({
      status: 'parent_not_accepted',
      unacceptedParents: ['state'],
      acceptedParents: [],
    });

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'urban area',
      within: '53',
    });
    await expect(censusCompareGeographies.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'parent_not_accepted',
        unacceptedParents: ['state'],
        recovery: { hint: expect.stringContaining('Drop within') },
      },
    });
    expect(mockQueryData).not.toHaveBeenCalled();
  });

  it('parent_not_accepted names within_county and the scope the level does take', async () => {
    mockCheckGeography.mockResolvedValue({
      status: 'parent_not_accepted',
      unacceptedParents: ['county'],
      acceptedParents: ['state'],
    });

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'place',
      within: '53',
      within_county: '033',
    });
    await expect(censusCompareGeographies.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'parent_not_accepted',
        acceptedParents: ['state'],
        recovery: { hint: expect.stringContaining('Drop within_county') },
      },
    });
    expect(mockQueryData).not.toHaveBeenCalled();
  });

  it('throws geography_not_supported before querying for a level the dataset lacks', async () => {
    mockCheckGeography.mockResolvedValue({
      status: 'level_not_supported',
      availableLevels: ['us', 'state', 'county'],
    });

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'tract',
      dataset: 'acs/acs1',
    });
    await expect(censusCompareGeographies.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('Available levels: us, state, county.'),
      data: { reason: 'geography_not_supported', availableLevels: ['us', 'state', 'county'] },
    });
    expect(mockQueryData).not.toHaveBeenCalled();
  });

  it('names a long level list by count instead of spelling it out in the message', async () => {
    const availableLevels = Array.from({ length: 13 }, (_, i) => `level ${i}`);
    mockCheckGeography.mockResolvedValue({ status: 'level_not_supported', availableLevels });

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'tract',
      dataset: 'acs/acs1',
    });
    const error = await Promise.resolve(censusCompareGeographies.handler(input, ctx)).catch(
      (e: unknown) => e,
    );
    // #62: census_list_geographies is the contract recovery's step, so the message leaves it out.
    // #96: no year given, so the vintage is acs/acs1's newest.
    expect((error as Error).message).toBe(
      'Geography level "tract" does not exist in acs/acs1 (2025). It publishes 13 geography levels.',
    );
    expect(error).toMatchObject({ data: { availableLevels } });
  });

  it('no_data recovery does not tell an acs/acs5 caller to switch to acs/acs5', async () => {
    mockQueryData.mockResolvedValue([]);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      dataset: 'acs/acs5',
    });
    await expect(censusCompareGeographies.handler(input, ctx)).rejects.toMatchObject({
      data: { recovery: { hint: expect.not.stringContaining('switch to') } },
    });
  });

  it('no_data recovery suggests acs/acs5 when the caller is on acs/acs1', async () => {
    mockQueryData.mockResolvedValue([]);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      dataset: 'acs/acs1',
    });
    await expect(censusCompareGeographies.handler(input, ctx)).rejects.toMatchObject({
      data: { recovery: { hint: expect.stringContaining('acs/acs5') } },
    });
  });

  it('puts suppressed values at end of ranking', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'Tiny County',
        geographyFips: '099',
        geographyGeoid: '53099',
        variables: {
          B19013_001E: { estimate: null, suppressed: true },
        },
      },
      {
        geographyName: 'King County, WA',
        geographyFips: '033',
        geographyGeoid: '53033',
        variables: {
          B19013_001E: { estimate: 105000, suppressed: false },
        },
      },
    ]);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
    });
    const result = await censusCompareGeographies.handler(input, ctx);

    // Non-suppressed should rank first
    expect(result.rows[0]?.geography_name).toBe('King County, WA');
    expect(result.rows[1]?.geography_name).toBe('Tiny County');
  });

  it('uses sort_by variable when provided', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'County A',
        geographyFips: '001',
        geographyGeoid: '53001',
        variables: {
          B17001_002E: { estimate: 5000, suppressed: false },
          B01001_001E: { estimate: 100000, suppressed: false },
        },
      },
      {
        geographyName: 'County B',
        geographyFips: '002',
        geographyGeoid: '53002',
        variables: {
          B17001_002E: { estimate: 8000, suppressed: false },
          B01001_001E: { estimate: 200000, suppressed: false },
        },
      },
    ]);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B17001_002E', 'B01001_001E'],
      geography_level: 'county',
      sort_by: 'B01001_001E',
    });
    const result = await censusCompareGeographies.handler(input, ctx);

    // Sort by B01001_001E desc — County B (200K) should be rank 1
    expect(result.rows[0]?.geography_name).toBe('County B');
    const enrichment = getEnrichment(ctx);
    expect(enrichment.sortVariable).toBe('B01001_001E');
  });

  /** #95: a limit above the 500 cap is served at the cap, said so ahead of the paging sentence. */
  it('serves limit 501 at 500 and says so ahead of the truncation notice', async () => {
    mockQueryData.mockResolvedValue(
      Array.from({ length: 600 }, (_, i) => ({
        geographyName: `County ${i}`,
        geographyFips: String(i).padStart(5, '0'),
        geographyGeoid: String(i).padStart(5, '0'),
        variables: { B19013_001E: { estimate: i * 1000, suppressed: false } },
      })),
    );

    const result = await runToolContract(censusCompareGeographies, {
      variables: ['B19013_001E'],
      geography_level: 'county',
      limit: 501,
    });

    const out = result.structuredContent as {
      rows: unknown[];
      nextOffset?: number;
      notice?: string;
    };
    expect(out.rows).toHaveLength(500);
    expect(out.nextOffset).toBe(500);
    const sentence =
      'limit 501 is over the 500-geography cap, so this page holds up to 500 geographies. Results truncated — 100 more geographies not shown.';
    expect(out.notice).toContain(sentence);
    expect(out.notice).not.toContain('increase the limit parameter');
    expect(textOf(result)).toContain(sentence);
  });

  it('serves limit 501 at 500 and says so when every geography fits the page', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'King County, WA',
        geographyFips: '033',
        geographyGeoid: '53033',
        variables: { B19013_001E: { estimate: 105000, suppressed: false } },
      },
      {
        geographyName: 'Pierce County, WA',
        geographyFips: '053',
        geographyGeoid: '53053',
        variables: { B19013_001E: { estimate: 72000, suppressed: false } },
      },
    ]);

    const result = await runToolContract(censusCompareGeographies, {
      variables: ['B19013_001E'],
      geography_level: 'county',
      limit: 501,
    });

    const out = result.structuredContent as { rows: unknown[]; notice?: string };
    expect(out.rows).toHaveLength(2);
    expect(out.notice).toBe(
      'limit 501 is over the 500-geography cap, so this page holds up to 500 geographies.',
    );
  });

  it('returns 500 rows at limit 500 and does not advise raising the limit past it', async () => {
    const manyRows = Array.from({ length: 600 }, (_, i) => ({
      geographyName: `County ${i}`,
      geographyFips: String(i).padStart(5, '0'),
      geographyGeoid: String(i).padStart(5, '0'),
      variables: {
        B19013_001E: { estimate: i * 1000, suppressed: false },
      },
    }));
    mockQueryData.mockResolvedValue(manyRows);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      limit: 500,
    });
    const result = await censusCompareGeographies.handler(input, ctx);

    expect(result.rows).toHaveLength(500);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.totalCount).toBe(600);
    expect(enrichment.notice).toContain('100 more geographies not shown');
    expect(enrichment.notice).not.toContain('increase the limit parameter');
    expect(enrichment.notice).not.toContain('is over the');
  });

  it('sets truncated=false when results fit within limit', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'King County, WA',
        geographyFips: '033',
        geographyGeoid: '53033',
        variables: {
          B19013_001E: { estimate: 105000, suppressed: false },
        },
      },
    ]);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      limit: 50,
    });
    await censusCompareGeographies.handler(input, ctx);
    expect(getEnrichment(ctx).truncated).toBe(false);
  });

  it('sets truncation notice enrichment when results truncated', async () => {
    const manyRows = Array.from({ length: 60 }, (_, i) => ({
      geographyName: `County ${i}`,
      geographyFips: String(i).padStart(5, '0'),
      geographyGeoid: String(i).padStart(5, '0'),
      variables: {
        B19013_001E: { estimate: i * 1000, suppressed: false },
      },
    }));
    mockQueryData.mockResolvedValue(manyRows);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      limit: 10,
    });
    await censusCompareGeographies.handler(input, ctx);
    expect(getEnrichment(ctx).notice).toContain('truncated');
  });

  it('throws upstream_error when api service rejects', async () => {
    const { McpError, JsonRpcErrorCode: codes } = await import('@cyanheads/mcp-ts-core/errors');
    mockQueryData.mockRejectedValue(
      new McpError(codes.ServiceUnavailable, 'Census API unavailable', {
        reason: 'upstream_error',
      }),
    );

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
    });
    await expect(censusCompareGeographies.handler(input, ctx)).rejects.toMatchObject({
      code: codes.ServiceUnavailable,
    });
  });

  it('enriches with dataset and year', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'State A',
        geographyFips: '01',
        geographyGeoid: '01',
        variables: {
          B19013_001E: { estimate: 50000, suppressed: false },
        },
      },
    ]);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'state',
      dataset: 'acs/acs5',
      year: 2022,
    });
    await censusCompareGeographies.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.dataset).toBe('acs/acs5');
    expect(enrichment.year).toBe(2022);
  });

  /** A row used to label such a code with the code itself, a label that says nothing. */
  it('ranks a code the variable cache has no entry for, with no label at all', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'County X',
        geographyFips: '001',
        geographyGeoid: '53001',
        variables: {
          B19013_001E: { estimate: 80000, suppressed: false },
        },
      },
    ]);

    const result = await runToolContract(censusCompareGeographies, {
      variables: ['B19013_001E'],
      geography_level: 'county',
    });
    const data = result.structuredContent as {
      variable_labels: Record<string, string>;
      rows: Array<{ rank: number; variables: Record<string, object> }>;
    };
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]?.rank).toBe(1);
    expect(data.variable_labels).toEqual({});
    expect(data.rows[0]?.variables.B19013_001E).not.toHaveProperty('label');
    expect(readVariableLabels(textOf(result))).toBeUndefined();
  });

  /**
   * Each row used to repeat every variable's label, so on a multi-row result the labels outweighed
   * the data. `B19013_001EA` keys row values, but variables.json lists it only inside another entry.
   */
  it('states each label once in variable_labels and the legend, and on no row', async () => {
    const labels = {
      B19013_001E: 'Estimate!!Median household income in the past 12 months',
      B19013_001M: 'Margin of Error!!Median household income in the past 12 months',
    };
    mockLookupVariables.mockResolvedValue(
      new Map(
        Object.entries(labels).map(([code, label]) => [
          code,
          { code, label, predicateType: 'int' },
        ]),
      ),
    );
    mockQueryData.mockResolvedValue(
      [
        ['King County, Washington', '033', 122148, 1808],
        ['Pierce County, Washington', '053', 98321, 1525],
      ].map(([name, fips, estimate, moe]) => ({
        geographyName: name,
        geographyFips: fips,
        geographyGeoid: `53${fips}`,
        variables: {
          B19013_001E: { estimate, moe, suppressed: false },
          B19013_001M: { estimate: moe, suppressed: false },
          B19013_001EA: { estimate: null, suppressed: false },
        },
      })),
    );

    const result = await runToolContract(censusCompareGeographies, {
      variables: ['B19013_001E', 'B19013_001M', 'B19013_001EA'],
      geography_level: 'county',
      within: '53',
    });
    const data = result.structuredContent as {
      variable_labels: Record<string, string>;
      rows: Array<{ geography_geoid: string; rank: number; variables: Record<string, object> }>;
    };

    expect(data.variable_labels).toEqual(labels);
    expect(Object.keys(data.variable_labels)).toEqual(['B19013_001E', 'B19013_001M']);
    expect(data.rows.map((row) => [row.geography_geoid, row.rank])).toEqual([
      ['53033', 1],
      ['53053', 2],
    ]);
    for (const row of data.rows) {
      expect(Object.keys(row.variables)).toEqual(['B19013_001E', 'B19013_001M', 'B19013_001EA']);
      for (const entry of Object.values(row.variables)) expect(entry).not.toHaveProperty('label');
    }
    const text = textOf(result);
    expect(readVariableLabels(text)).toEqual(labels);
    for (const label of Object.values(labels)) {
      expect(JSON.stringify(result.structuredContent).split(label)).toHaveLength(2);
      expect(text.split(label)).toHaveLength(2);
    }
  });

  it.each([0, 1, 2, 3, 9])(
    'carries the same variable_labels on every page, offset %i included',
    async (offset) => {
      mockLookupVariables.mockResolvedValue(
        new Map([
          ['B01003_001E', { code: 'B01003_001E', label: 'Estimate!!Total', predicateType: 'int' }],
        ]),
      );
      mockQueryData.mockResolvedValue(
        ['001', '003', '005'].map((fips) => ({
          geographyName: `County ${fips}`,
          geographyFips: fips,
          geographyGeoid: `53${fips}`,
          variables: { B01003_001E: { estimate: Number(fips), suppressed: false } },
        })),
      );

      const result = await runToolContract(censusCompareGeographies, {
        variables: ['B01003_001E'],
        geography_level: 'county',
        within: '53',
        limit: 1,
        offset,
      });
      const data = result.structuredContent as {
        variable_labels: Record<string, string>;
        rows: unknown[];
      };

      expect(data.rows).toHaveLength(offset < 3 ? 1 : 0);
      expect(data.variable_labels).toEqual({ B01003_001E: 'Estimate!!Total' });
      expect(readVariableLabels(textOf(result))).toEqual({ B01003_001E: 'Estimate!!Total' });
    },
  );

  /** A bare toLocaleString() stopped at three decimals: a Gini index read 0.469 ± 0.002. */
  it('renders every digit structuredContent carries in content[]', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'San Juan County, Washington',
        geographyFips: '055',
        geographyGeoid: '53055',
        variables: {
          B19083_001E: { estimate: 0.532, moe: 0.0196, suppressed: false },
          B19083_001M: { estimate: 0.0196, suppressed: false },
        },
      },
    ]);

    const result = await runToolContract(censusCompareGeographies, {
      variables: ['B19083_001E', 'B19083_001M'],
      geography_level: 'county',
      within: '53',
    });
    const data = result.structuredContent as {
      rows: Array<{ variables: Record<string, { estimate: number; moe?: number }> }>;
    };

    expect(data.rows[0]?.variables.B19083_001E).toMatchObject({ estimate: 0.532, moe: 0.0196 });
    expect(data.rows[0]?.variables.B19083_001M).toMatchObject({ estimate: 0.0196 });
    const text = textOf(result);
    expect(text).toContain('- **B19083_001E:** 0.532 ± 0.0196\n');
    expect(text).toContain('- **B19083_001M:** 0.0196\n');
  });

  it('format output never contains API key or secrets', () => {
    const output = {
      variable_labels: { B19013_001E: 'Median income' },
      rows: [
        {
          geography_name: 'King County, WA',
          geography_fips: '033',
          geography_geoid: '53033',
          variables: {
            B19013_001E: { estimate: 105000, suppressed: false },
          },
          rank: 1,
        },
      ],
    };
    const blocks = censusCompareGeographies.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).not.toMatch(/CENSUS_API_KEY/);
    expect(text).not.toMatch(/api.key/i);
    expect(text).not.toMatch(/secret/i);
  });

  /**
   * The check has to sit ahead of the geography check, which is the handler's first request —
   * a year the dataset does not serve has no geography metadata either. Nothing here is stubbed
   * to reject: the refusal has to come from the handler calling validateYear itself.
   */
  it('refuses a year the dataset does not serve before any request goes out', async () => {
    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['POP'],
      geography_level: 'state',
      dataset: 'pep/charv',
      year: 2021,
    });

    await expect(censusCompareGeographies.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'year_not_available', availableYears: [2023] },
    });
    expect(mockCheckGeography).not.toHaveBeenCalled();
    expect(mockQueryData).not.toHaveBeenCalled();
  });

  /**
   * The ranking is on the numeric variable; the text one rides along as a join key and has to
   * arrive readable rather than as the null a geography with no value gets.
   */
  it('carries a text value through onto every ranked row', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'King County, WA',
        geographyFips: '033',
        geographyGeoid: '53033',
        variables: {
          B19013_001E: { estimate: 122148, suppressed: false },
          GEO_ID: {
            estimate: null,
            suppressed: false,
            value: '0500000US53033',
          },
        },
      },
    ]);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E', 'GEO_ID'],
      geography_level: 'county',
      within: '53',
    });
    const result = await censusCompareGeographies.handler(input, ctx);

    const variables = result.rows[0]?.variables as Record<
      string,
      { estimate: number | null; suppressed: boolean; value?: string }
    >;
    expect(variables.GEO_ID?.value).toBe('0500000US53033');
    expect(variables.B19013_001E?.value).toBeUndefined();
    expect(result.rows[0]?.rank).toBe(1);
  });

  it('format renders a text value rather than the N/A a missing one gets', () => {
    const output = {
      variable_labels: { GEO_ID: 'Geography', B19013_001M: 'Margin of error' },
      rows: [
        {
          geography_name: 'King County, WA',
          geography_fips: '033',
          geography_geoid: '53033',
          variables: {
            GEO_ID: {
              estimate: null,
              suppressed: false,
              value: '0500000US53033',
            },
            B19013_001M: { estimate: null, suppressed: false },
          },
          rank: 1,
        },
      ],
    };

    const blocks = censusCompareGeographies.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;

    expect(text).toContain('**GEO_ID:** 0500000US53033');
    expect(text).toContain('**B19013_001M:** N/A');
  });

  it('format shows moe alongside estimate when present', () => {
    const output = {
      variable_labels: { B19013_001E: 'Median income' },
      rows: [
        {
          geography_name: 'King County, WA',
          geography_fips: '033',
          geography_geoid: '53033',
          variables: {
            B19013_001E: { estimate: 105000, moe: 500, suppressed: false },
          },
          rank: 1,
        },
      ],
    };
    const blocks = censusCompareGeographies.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('±');
    expect(text).toContain('500');
  });

  it('injection attempt in geography_level is safely forwarded to service', async () => {
    const { McpError, JsonRpcErrorCode: codes } = await import('@cyanheads/mcp-ts-core/errors');
    mockQueryData.mockRejectedValue(
      new McpError(codes.ValidationError, 'Invalid geography level', {
        reason: 'geography_not_supported',
      }),
    );

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: "county'; DROP TABLE geo; --",
    });
    await expect(censusCompareGeographies.handler(input, ctx)).rejects.toMatchObject({
      code: codes.ValidationError,
    });
  });

  it('formats output with ranked geography table', () => {
    const output = {
      variable_labels: { B19013_001E: 'Median household income' },
      rows: [
        {
          geography_name: 'King County, WA',
          geography_fips: '033',
          geography_geoid: '53033',
          variables: {
            B19013_001E: {
              estimate: 105000,
              suppressed: false,
            },
          },
          rank: 1,
        },
      ],
    };
    const blocks = censusCompareGeographies.format!(output);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('King County, WA');
    expect(text).toContain('GEOID');
    expect(text).toContain('53033');
    expect(text).toContain('B19013_001E');
    expect(text).toContain('105,000');
  });
});

describe('censusCompareGeographies — predicates', () => {
  const cbpRows = [
    {
      geographyName: 'King County, Washington',
      geographyFips: '033',
      geographyGeoid: '53033',
      variables: { ESTAB: { estimate: 577, suppressed: false } },
    },
  ];

  it('forwards predicates to the api service', async () => {
    mockQueryData.mockResolvedValue(cbpRows);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['ESTAB'],
      geography_level: 'county',
      within: '53',
      dataset: 'cbp',
      predicates: { NAICS2017: '5112' },
    });
    await censusCompareGeographies.handler(input, ctx);

    expect(mockQueryData).toHaveBeenCalledWith(
      expect.objectContaining({ predicates: { NAICS2017: '5112' } }),
      expect.anything(),
    );
  });

  it('omits predicates from the api service call when none were supplied', async () => {
    mockQueryData.mockResolvedValue(cbpRows);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['ESTAB'],
      geography_level: 'county',
      within: '53',
      dataset: 'cbp',
    });
    await censusCompareGeographies.handler(input, ctx);

    expect(mockQueryData.mock.calls[0]?.[0]).not.toHaveProperty('predicates');
  });

  /**
   * A ranking built on an unset dimension ranks every category combined, which answers a
   * different question than the one the caller asked — that outranks truncation advice.
   */
  it('leads the notice with the unset filter dimensions, ahead of the truncation advice', async () => {
    mockCheckPredicates.mockResolvedValue({
      unset: [{ code: 'NAICS2017', label: '2017 NAICS code' }],
      unknown: [],
    });
    mockQueryData.mockResolvedValue([
      ...cbpRows,
      {
        geographyName: 'Pierce County, Washington',
        geographyFips: '053',
        geographyGeoid: '53053',
        variables: { ESTAB: { estimate: 120, suppressed: false } },
      },
    ]);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['ESTAB'],
      geography_level: 'county',
      within: '53',
      dataset: 'cbp',
      limit: 1,
    });
    await censusCompareGeographies.handler(input, ctx);

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('NAICS2017 (2017 NAICS code)');
    expect(notice).toContain('applied its own default');
    expect(notice.indexOf('NAICS2017')).toBeLessThan(notice.indexOf('Results truncated'));
  });

  it('emits no notice when every filter dimension is set', async () => {
    mockQueryData.mockResolvedValue(cbpRows);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['ESTAB'],
      geography_level: 'county',
      within: '53',
      dataset: 'cbp',
      predicates: { NAICS2017: '5112' },
    });
    await censusCompareGeographies.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('throws predicate_not_supported before querying for an unrecognized predicate key', async () => {
    mockCheckPredicates.mockResolvedValue({ unset: [], unknown: ['NAICS2022'] });

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['ESTAB'],
      geography_level: 'county',
      within: '53',
      dataset: 'cbp',
      predicates: { NAICS2022: '5112' },
    });
    await expect(censusCompareGeographies.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'predicate_not_supported', unknownPredicates: ['NAICS2022'] },
    });
    expect(mockQueryData).not.toHaveBeenCalled();
  });
});

describe('censusCompareGeographies — FIPS scope widths', () => {
  const row = {
    geographyName: 'Garland County, Arkansas',
    geographyFips: '051',
    geographyGeoid: '05051',
    variables: { B19013_001E: { estimate: 55409, suppressed: false } },
  };

  /**
   * The Census API matches FIPS literally, so `in=state:5` scopes the comparison to nothing
   * while `in=state:05` scopes it to Arkansas. census_resolve_geography pads the codes it hands
   * back, so the two sides have to agree on the width.
   */
  it('pads a short within to the two digits a state FIPS carries', async () => {
    mockQueryData.mockResolvedValue([row]);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      within: '5',
    });
    const result = await censusCompareGeographies.handler(input, ctx);

    expect(mockQueryData).toHaveBeenCalledWith(
      expect.objectContaining({ parentFips: '05' }),
      expect.anything(),
    );
    expect(result.rows[0]?.geography_name).toBe('Garland County, Arkansas');
  });

  it('pads a short within_county to three digits', async () => {
    mockQueryData.mockResolvedValue([row]);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'tract',
      within: '05',
      within_county: '51',
    });
    await censusCompareGeographies.handler(input, ctx);

    expect(mockQueryData).toHaveBeenCalledWith(
      expect.objectContaining({ countyFips: '051' }),
      expect.anything(),
    );
  });

  it('reads a blank scope as omitted rather than padding it to zeros', async () => {
    mockQueryData.mockResolvedValue([row]);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      within: '',
    });
    await censusCompareGeographies.handler(input, ctx);

    expect(mockQueryData.mock.calls[0]?.[0]).not.toHaveProperty('parentFips');
  });

  /**
   * `in=state:53 county:*` is the only hierarchy the Census API answers for every block group in
   * a state, and a padded `00*` matches no county — so a wildcard scope has to clear the schema
   * and reach the API as itself.
   */
  it('accepts a wildcard scope and sends it unpadded', async () => {
    mockQueryData.mockResolvedValue([row]);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'block group',
      within: '53',
      within_county: '*',
    });
    await censusCompareGeographies.handler(input, ctx);

    expect(mockQueryData).toHaveBeenCalledWith(
      expect.objectContaining({ parentFips: '53', countyFips: '*' }),
      expect.anything(),
    );
  });

  it('rejects a non-numeric scope at the schema boundary', () => {
    expect(
      censusCompareGeographies.input.safeParse({
        variables: ['B19013_001E'],
        geography_level: 'county',
        within: 'WA',
      }).success,
    ).toBe(false);
    expect(
      censusCompareGeographies.input.safeParse({
        variables: ['B19013_001E'],
        geography_level: 'tract',
        within: '05',
        within_county: '0510',
      }).success,
    ).toBe(false);
  });
});

describe('censusCompareGeographies — applied filter defaults', () => {
  /**
   * A ranking on a dataset that defaults a dimension to one category ranks that category, not
   * the whole. The applied label is what stops a POPGROUP-scoped ranking from reading as a
   * ranking of total population.
   */
  it('requests the label attribute of each unset dimension and echoes it per row', async () => {
    mockCheckPredicates.mockResolvedValue({
      unset: [{ code: 'NAICS2017', label: '2017 NAICS code', labelAttribute: 'NAICS2017_LABEL' }],
      unknown: [],
    });
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'King County, WA',
        geographyFips: '033',
        geographyGeoid: '53033',
        variables: { ESTAB: { estimate: 70376, suppressed: false } },
        appliedFilters: { NAICS2017: 'Total for all sectors' },
      },
    ]);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['ESTAB'],
      geography_level: 'county',
      within: '53',
      dataset: 'cbp',
    });
    const result = await censusCompareGeographies.handler(input, ctx);

    expect(mockQueryData).toHaveBeenCalledWith(
      expect.objectContaining({ defaultLabelColumns: { NAICS2017: 'NAICS2017_LABEL' } }),
      expect.anything(),
    );
    expect(result.rows[0]?.applied_filters).toEqual({ NAICS2017: 'Total for all sectors' });
    expect(getEnrichment(ctx).notice).toContain('"Total for all sectors"');
  });

  it('asks for no label column for a dimension that publishes none', async () => {
    mockCheckPredicates.mockResolvedValue({
      unset: [{ code: 'YEAR', label: 'Vintage Year' }],
      unknown: [],
    });
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'King County, WA',
        geographyFips: '033',
        geographyGeoid: '53033',
        variables: { ESTAB: { estimate: 70376, suppressed: false } },
      },
    ]);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['ESTAB'],
      geography_level: 'county',
      within: '53',
      dataset: 'cbp',
    });
    const result = await censusCompareGeographies.handler(input, ctx);

    expect(mockQueryData.mock.calls[0]?.[0]).not.toHaveProperty('defaultLabelColumns');
    expect(result.rows[0]?.applied_filters).toBeUndefined();
  });

  it('format shows the applied filter defaults beside the ranked value', () => {
    const output = {
      variable_labels: { ESTAB: 'Establishments' },
      rows: [
        {
          geography_name: 'King County, WA',
          geography_fips: '033',
          geography_geoid: '53033',
          variables: { ESTAB: { estimate: 70376, suppressed: false } },
          applied_filters: { NAICS2017: 'Total for all sectors' },
          rank: 1,
        },
      ],
    };
    const blocks = censusCompareGeographies.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('NAICS2017 = Total for all sectors');
  });
});

/**
 * A rank is a statement about one geography. When `pep/charv` returns its April base and its July
 * estimate and neither is pinned, every geography occupies two ranks with two different values —
 * a ranking that cannot be read correctly however the rows are labelled.
 */
describe('censusCompareGeographies — datasets that publish several records per geography', () => {
  const duplicated = [
    {
      geographyName: 'Washington',
      geographyFips: '53',
      geographyGeoid: '53',
      variables: { POP: { estimate: 7705267, suppressed: false } },
      record: { MONTH: { code: '4', label: 'April' } },
    },
    {
      geographyName: 'Washington',
      geographyFips: '53',
      geographyGeoid: '53',
      variables: { POP: { estimate: 7724566, suppressed: false } },
      record: { MONTH: { code: '7', label: 'July' } },
    },
    {
      geographyName: 'Oregon',
      geographyFips: '41',
      geographyGeoid: '41',
      variables: { POP: { estimate: 4241500, suppressed: false } },
      record: { MONTH: { code: '4', label: 'April' } },
    },
    {
      geographyName: 'Oregon',
      geographyFips: '41',
      geographyGeoid: '41',
      variables: { POP: { estimate: 4237256, suppressed: false } },
      record: { MONTH: { code: '7', label: 'July' } },
    },
  ];

  const charvInput = (overrides: Record<string, unknown> = {}) =>
    censusCompareGeographies.input.parse({
      variables: ['POP'],
      geography_level: 'state',
      dataset: 'pep/charv',
      ...overrides,
    });

  beforeEach(() => {
    mockGetRecordDimensions.mockResolvedValue([
      { code: 'MONTH', label: 'Vintage Month', labelAttribute: 'MONTH_DESC' },
    ]);
  });

  it('refuses to rank when each geography came back more than once', async () => {
    mockQueryData.mockResolvedValue(duplicated);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    await expect(censusCompareGeographies.handler(charvInput(), ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'ambiguous_rows', rowsPerGeography: 2 },
    });
  });

  it('groups the thousands of the per-geography row count in the error message', async () => {
    mockQueryData.mockResolvedValue(
      Array.from({ length: 1552 }, (_, i) => ({
        geographyName: 'King County, Washington',
        geographyFips: '033',
        geographyGeoid: '53033',
        variables: { POP: { estimate: i, suppressed: false } },
        record: { NAICS2017: { code: String(1000 + i), label: `Industry ${i}` } },
      })),
    );

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    await expect(censusCompareGeographies.handler(charvInput(), ctx)).rejects.toMatchObject({
      message: expect.stringContaining('returned 1,552 rows for each state'),
    });
  });

  it('names the column that separates the records and the value that pins one', async () => {
    mockQueryData.mockResolvedValue(duplicated);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const error = await Promise.resolve(censusCompareGeographies.handler(charvInput(), ctx)).catch(
      (err: { data: { recovery: { hint: string } } }) => err,
    );
    const hint = (error as { data: { recovery: { hint: string } } }).data.recovery.hint;

    expect(hint).toContain('MONTH');
    expect(hint).toContain('"4" (April)');
    expect(hint).toContain('{"MONTH": "7"}');
  });

  /** #62: the row count is the diagnosis, so the hint keeps only the values and the pin. */
  it('states the row count in the message alone, and the pin in the hint alone', async () => {
    mockQueryData.mockResolvedValue(duplicated);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const error = (await Promise.resolve(censusCompareGeographies.handler(charvInput(), ctx)).catch(
      (err: unknown) => err,
    )) as { message: string; data: { recovery: { hint: string } } };

    expect(error.message).toBe(
      'pep/charv (2023) returned 2 rows for each state, so a ranking would list every one of them more than once with different values.',
    );
    expect(error.data.recovery.hint).toBe(
      'Add the record you want to predicates, e.g. {"MONTH": "7"} — MONTH took "4" (April) and "7" (July) in this response. census_query_data returns every record for a single geography, each labelled, if you want to see them side by side first.',
    );
  });

  it('ranks each geography once when the record is pinned', async () => {
    mockQueryData.mockResolvedValue(duplicated.filter((row) => row.record.MONTH.code === '7'));

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const result = await censusCompareGeographies.handler(
      charvInput({ predicates: { MONTH: '7' } }),
      ctx,
    );

    expect(result.rows.map((row) => row.geography_geoid)).toEqual(['53', '41']);
    expect(result.rows[0]?.record).toEqual({ MONTH: { code: '7', label: 'July' } });
    expect(new Set(result.rows.map((row) => row.geography_geoid)).size).toBe(result.rows.length);
    // Without the record columns on the request the rows come back unlabelled, and the refusal
    // above degrades to naming nothing the caller can pin.
    expect(mockQueryData).toHaveBeenCalledWith(
      expect.objectContaining({ recordColumns: { MONTH: 'MONTH_DESC' } }),
      expect.anything(),
    );
  });

  /**
   * A pinned ranking is a ranking of one record, and the row it came from is the only thing that
   * says which. Clients that read content[] rather than structuredContent see the rendered text
   * alone, so a heading without the record is a rank whose provenance is missing there.
   */
  it('format names the record the ranking is over', () => {
    const blocks = censusCompareGeographies.format!({
      variable_labels: { POP: 'Total population' },
      rows: [
        {
          geography_name: 'Washington',
          geography_fips: '53',
          geography_geoid: '53',
          variables: { POP: { estimate: 7724566, suppressed: false } },
          record: { MONTH: { code: '7', label: 'July' } },
          rank: 1,
        },
      ],
    });
    const text = (blocks[0] as { type: string; text: string }).text;

    expect(text).toContain('1. Washington — MONTH 7 (July)');
  });

  /**
   * The guard keys on the GEOID, which is what makes a row unique nationally. Keying on the bare
   * level code would read two same-numbered counties in different states as one duplicated
   * geography and fail a legitimate nationwide comparison.
   */
  it('does not mistake the same level code in two states for a duplicate', async () => {
    mockGetRecordDimensions.mockResolvedValue([]);
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'King County, Washington',
        geographyFips: '033',
        geographyGeoid: '53033',
        variables: { B19013_001E: { estimate: 105000, suppressed: false } },
      },
      {
        geographyName: 'Cook County, Illinois',
        geographyFips: '033',
        geographyGeoid: '17033',
        variables: { B19013_001E: { estimate: 78000, suppressed: false } },
      },
    ]);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const result = await censusCompareGeographies.handler(
      censusCompareGeographies.input.parse({
        variables: ['B19013_001E'],
        geography_level: 'county',
      }),
      ctx,
    );

    expect(result.rows).toHaveLength(2);
  });
});

describe('censusCompareGeographies — declared contract text', () => {
  const declared = (reason: string) =>
    censusCompareGeographies.errors?.find((entry) => entry.reason === reason);

  it('declares ambiguous_rows for rows only GEO_ID separates, beside a record column', () => {
    const entry = declared('ambiguous_rows');

    expect(entry?.when).toContain('pep/charv MONTH');
    expect(entry?.when).toContain('only GEO_ID does');
    expect(entry?.recovery).toContain('MONTH, where "7" selects the July estimate');
    expect(entry?.recovery).toContain(
      'Where only GEO_ID tells the rows apart, no predicate pins one per geography, so compare a vintage that publishes one row per geography instead.',
    );
  });

  it('describes the boundary guidance an unmatched geographies entry can carry', () => {
    expect(censusCompareGeographies.enrichment?.notice.description).toContain(
      'for a tract or block group entry on a vintage before 2020 or a Connecticut county in the other county scheme, which boundaries that vintage publishes',
    );
  });
});
