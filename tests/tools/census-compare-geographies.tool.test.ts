/**
 * @fileoverview Tests for census_compare_geographies tool.
 * @module tests/tools/census-compare-geographies.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { censusCompareGeographies } from '@/mcp-server/tools/definitions/census-compare-geographies.tool.js';

vi.mock('@/services/census-api/census-api-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/census-api/census-api-service.js')>()),
  getCensusApiService: vi.fn(),
}));

vi.mock('@/services/variable-cache/variable-cache-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/variable-cache/variable-cache-service.js')>()),
  DATASET_LATEST_YEARS: { 'acs/acs5': 2024, cbp: 2023 },
  KNOWN_DATASETS: new Set(['acs/acs5', 'acs/acs1', 'acs/acs5/profile', 'dec/pl', 'cbp']),
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
const mockCheckGeography = vi.fn();
const mockGetVariablesByCode = vi.fn();
const mockCheckPredicates = vi.fn();

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
    getVariablesByCode: mockGetVariablesByCode,
    checkPredicates: mockCheckPredicates,
  } as never);

  // Default: the dataset declares no filter dimensions, so nothing is unset or unknown.
  mockCheckPredicates.mockResolvedValue({ unset: [], unknown: [] });

  // Default: label enrichment best-effort (returns nothing — codes used as labels)
  mockGetVariablesByCode.mockResolvedValue([]);
});

describe('censusCompareGeographies', () => {
  it('returns ranked rows sorted by sort variable descending', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'King County, WA',
        geographyFips: '033',
        geographyGeoid: '53033',
        variables: {
          B19013_001E: { estimate: 105000, label: 'Median income', suppressed: false },
        },
      },
      {
        geographyName: 'Pierce County, WA',
        geographyFips: '053',
        geographyGeoid: '53053',
        variables: {
          B19013_001E: { estimate: 72000, label: 'Median income', suppressed: false },
        },
      },
      {
        geographyName: 'Spokane County, WA',
        geographyFips: '063',
        geographyGeoid: '53063',
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
        geographyFips: '033',
        geographyGeoid: '53033',
        variables: {
          B19013_001E: { estimate: 105000, label: 'Median income', suppressed: false },
        },
      },
      {
        geographyName: 'Spokane County, WA',
        geographyFips: '063',
        geographyGeoid: '53063',
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
      variables: { B19013_001E: { estimate: 105000, label: 'Median income', suppressed: false } },
    },
    {
      geographyName: 'Los Angeles County, California',
      geographyFips: '037',
      geographyGeoid: '06037',
      variables: { B19013_001E: { estimate: 82000, label: 'Median income', suppressed: false } },
    },
    {
      geographyName: 'Autauga County, Alabama',
      geographyFips: '001',
      geographyGeoid: '01001',
      variables: { B19013_001E: { estimate: 69000, label: 'Median income', suppressed: false } },
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
        variables: { B19013_001E: { estimate: 105000, label: 'Median income', suppressed: false } },
      },
      {
        geographyName: 'Pierce County, Washington',
        geographyFips: '053',
        geographyGeoid: '53053',
        variables: { B19013_001E: { estimate: 72000, label: 'Median income', suppressed: false } },
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
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'King County, Washington',
        geographyFips: '033',
        geographyGeoid: '53033',
        variables: { B19013_001E: { estimate: 105000, label: 'Median income', suppressed: false } },
      },
      {
        geographyName: "Prince George's County, Maryland",
        geographyFips: '033',
        geographyGeoid: '24033',
        variables: { B19013_001E: { estimate: 97000, label: 'Median income', suppressed: false } },
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
    expect(getEnrichment(ctx).notice).toContain('033 matched a county in more than one state');
  });

  it('stays silent when within scopes a bare level code to a single match', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'King County, Washington',
        geographyFips: '033',
        geographyGeoid: '53033',
        variables: { B19013_001E: { estimate: 105000, label: 'Median income', suppressed: false } },
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

  it('passes countyFips to apiService when within_county is provided', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'Census Tract 1, King County, Washington',
        geographyFips: '000100',
        geographyGeoid: '53033000100',
        variables: {
          B19013_001E: { estimate: 98000, label: 'Median income', suppressed: false },
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
          B19013_001E: { estimate: 105000, label: 'Median income', suppressed: false },
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
      data: { reason: 'geography_not_supported', availableLevels: ['us', 'state', 'county'] },
    });
    expect(mockQueryData).not.toHaveBeenCalled();
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
          B19013_001E: { estimate: null, label: 'Median income', suppressed: true },
        },
      },
      {
        geographyName: 'King County, WA',
        geographyFips: '033',
        geographyGeoid: '53033',
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
        geographyGeoid: '53001',
        variables: {
          B17001_002E: { estimate: 5000, label: 'Poverty', suppressed: false },
          B01001_001E: { estimate: 100000, label: 'Population', suppressed: false },
        },
      },
      {
        geographyName: 'County B',
        geographyFips: '002',
        geographyGeoid: '53002',
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
      geographyGeoid: String(i).padStart(5, '0'),
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
        geographyFips: '033',
        geographyGeoid: '53033',
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
      geographyGeoid: String(i).padStart(5, '0'),
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
        geographyGeoid: '01',
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
      checkPredicates: mockCheckPredicates,
    } as never);

    mockQueryData.mockResolvedValue([
      {
        geographyName: 'County X',
        geographyFips: '001',
        geographyGeoid: '53001',
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
          geography_fips: '033',
          geography_geoid: '53033',
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
          geography_fips: '033',
          geography_geoid: '53033',
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
          geography_fips: '033',
          geography_geoid: '53033',
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
      variables: { ESTAB: { estimate: 577, label: 'ESTAB', suppressed: false } },
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
        variables: { ESTAB: { estimate: 120, label: 'ESTAB', suppressed: false } },
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
    variables: { B19013_001E: { estimate: 55409, label: 'B19013_001E', suppressed: false } },
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
        variables: { ESTAB: { estimate: 70376, label: 'ESTAB', suppressed: false } },
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
        variables: { ESTAB: { estimate: 70376, label: 'ESTAB', suppressed: false } },
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
      rows: [
        {
          geography_name: 'King County, WA',
          geography_fips: '033',
          geography_geoid: '53033',
          variables: { ESTAB: { estimate: 70376, label: 'Establishments', suppressed: false } },
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
