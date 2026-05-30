/**
 * @fileoverview Tests for census_compare_geographies tool.
 * @module tests/tools/census-compare-geographies.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { censusCompareGeographies } from '@/mcp-server/tools/definitions/census-compare-geographies.tool.js';

vi.mock('@/services/census-api/census-api-service.js', () => ({
  getCensusApiService: vi.fn(),
}));

vi.mock('@/services/variable-cache/variable-cache-service.js', () => ({
  DATASET_LATEST_YEARS: { 'acs/acs5': 2024 },
  KNOWN_DATASETS: new Set(['acs/acs5', 'acs/acs1', 'acs/acs5/profile', 'dec/pl']),
  getVariableCacheService: vi.fn(),
}));

vi.mock('@/config/server-config.js', () => ({
  getDiscoveryConfig: vi.fn(() => ({ defaultYear: 2024, variableCacheTtlHours: 24 })),
  getServerConfig: vi.fn(() => ({
    defaultYear: 2024,
    censusApiKey: 'test-key',
    variableCacheTtlHours: 24,
  })),
}));

const mockQueryData = vi.fn();
const mockGetVariablesByCode = vi.fn();

beforeEach(async () => {
  vi.clearAllMocks();

  const { getCensusApiService } = await import('@/services/census-api/census-api-service.js');
  vi.mocked(getCensusApiService).mockReturnValue({ queryData: mockQueryData } as never);

  const { getVariableCacheService } = await import(
    '@/services/variable-cache/variable-cache-service.js'
  );
  vi.mocked(getVariableCacheService).mockReturnValue({
    getVariablesByCode: mockGetVariablesByCode,
  } as never);

  // Default: label enrichment best-effort (returns nothing — codes used as labels)
  mockGetVariablesByCode.mockResolvedValue([]);
});

describe('censusCompareGeographies', () => {
  it('returns ranked rows sorted by sort variable descending', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'King County, WA',
        geographyFips: '53033',
        variables: {
          B19013_001E: { estimate: 105000, label: 'Median income', suppressed: false },
        },
      },
      {
        geographyName: 'Pierce County, WA',
        geographyFips: '53053',
        variables: {
          B19013_001E: { estimate: 72000, label: 'Median income', suppressed: false },
        },
      },
      {
        geographyName: 'Spokane County, WA',
        geographyFips: '53063',
        variables: {
          B19013_001E: { estimate: 65000, label: 'Median income', suppressed: false },
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
        geographyFips: '53033',
        variables: {
          B19013_001E: { estimate: 105000, label: 'Median income', suppressed: false },
        },
      },
      {
        geographyName: 'Spokane County, WA',
        geographyFips: '53063',
        variables: {
          B19013_001E: { estimate: 65000, label: 'Median income', suppressed: false },
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

  it('filters to specific geographies when geographies list is provided', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'King County, WA',
        geographyFips: '53033',
        variables: {
          B19013_001E: { estimate: 105000, label: 'Median income', suppressed: false },
        },
      },
      {
        geographyName: 'Pierce County, WA',
        geographyFips: '53053',
        variables: {
          B19013_001E: { estimate: 72000, label: 'Median income', suppressed: false },
        },
      },
    ]);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      geographies: ['53033'], // Only King County
    });
    const result = await censusCompareGeographies.handler(input, ctx);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.geography_fips).toBe('53033');
  });

  it('truncates results when count exceeds limit', async () => {
    const manyRows = Array.from({ length: 60 }, (_, i) => ({
      geographyName: `County ${i}`,
      geographyFips: String(i).padStart(5, '0'),
      variables: {
        B19013_001E: {
          estimate: 50000 + i * 100,
          label: 'Median income',
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

  it('puts suppressed values at end of ranking', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'Tiny County',
        geographyFips: '53099',
        variables: {
          B19013_001E: { estimate: null, label: 'Median income', suppressed: true },
        },
      },
      {
        geographyName: 'King County, WA',
        geographyFips: '53033',
        variables: {
          B19013_001E: { estimate: 105000, label: 'Median income', suppressed: false },
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
        variables: {
          B17001_002E: { estimate: 5000, label: 'Poverty', suppressed: false },
          B01001_001E: { estimate: 100000, label: 'Population', suppressed: false },
        },
      },
      {
        geographyName: 'County B',
        geographyFips: '002',
        variables: {
          B17001_002E: { estimate: 8000, label: 'Poverty', suppressed: false },
          B01001_001E: { estimate: 200000, label: 'Population', suppressed: false },
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

  it('caps limit at 500 even when input is higher', async () => {
    const manyRows = Array.from({ length: 600 }, (_, i) => ({
      geographyName: `County ${i}`,
      geographyFips: String(i).padStart(5, '0'),
      variables: {
        B19013_001E: { estimate: i * 1000, label: 'Median income', suppressed: false },
      },
    }));
    mockQueryData.mockResolvedValue(manyRows);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      limit: 999,
    });
    const result = await censusCompareGeographies.handler(input, ctx);

    expect(result.rows.length).toBeLessThanOrEqual(500);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.totalCount).toBe(600);
  });

  it('sets truncated=false when results fit within limit', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'King County, WA',
        geographyFips: '53033',
        variables: {
          B19013_001E: { estimate: 105000, label: 'Median income', suppressed: false },
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
      variables: {
        B19013_001E: { estimate: i * 1000, label: 'Median income', suppressed: false },
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
        variables: {
          B19013_001E: { estimate: 50000, label: 'Median income', suppressed: false },
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

  it('label enrichment cache failure does not block comparison', async () => {
    const { getVariableCacheService } = await import(
      '@/services/variable-cache/variable-cache-service.js'
    );
    vi.mocked(getVariableCacheService).mockReturnValue({
      getVariablesByCode: vi.fn().mockRejectedValue(new Error('cache cold')),
    } as never);

    mockQueryData.mockResolvedValue([
      {
        geographyName: 'County X',
        geographyFips: '001',
        variables: {
          B19013_001E: { estimate: 80000, label: 'Median income', suppressed: false },
        },
      },
    ]);

    const ctx = createMockContext({ errors: censusCompareGeographies.errors });
    const input = censusCompareGeographies.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
    });
    const result = await censusCompareGeographies.handler(input, ctx);
    expect(result.rows).toHaveLength(1);
  });

  it('format output never contains API key or secrets', () => {
    const output = {
      rows: [
        {
          geography_name: 'King County, WA',
          geography_fips: '53033',
          variables: {
            B19013_001E: { estimate: 105000, label: 'Median income', suppressed: false },
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

  it('format shows moe alongside estimate when present', () => {
    const output = {
      rows: [
        {
          geography_name: 'King County, WA',
          geography_fips: '53033',
          variables: {
            B19013_001E: { estimate: 105000, moe: 500, label: 'Median income', suppressed: false },
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
      rows: [
        {
          geography_name: 'King County, WA',
          geography_fips: '53033',
          variables: {
            B19013_001E: {
              estimate: 105000,
              label: 'Median household income',
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
    expect(text).toContain('53033');
    expect(text).toContain('B19013_001E');
    expect(text).toContain('105,000');
  });
});
