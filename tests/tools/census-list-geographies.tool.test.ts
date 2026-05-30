/**
 * @fileoverview Tests for census_list_geographies tool.
 * @module tests/tools/census-list-geographies.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { censusListGeographies } from '@/mcp-server/tools/definitions/census-list-geographies.tool.js';

vi.mock('@/services/census-api/census-api-service.js', () => ({
  getCensusApiService: vi.fn(),
}));

vi.mock('@/services/variable-cache/variable-cache-service.js', () => ({
  DATASET_LATEST_YEARS: { 'acs/acs5': 2024 },
  KNOWN_DATASETS: new Set(['acs/acs5', 'acs/acs1', 'acs/acs5/profile', 'dec/pl']),
}));

vi.mock('@/config/server-config.js', () => ({
  getDiscoveryConfig: vi.fn(() => ({ defaultYear: 2024, variableCacheTtlHours: 24 })),
}));

const mockFetchGeographyLevels = vi.fn();

beforeEach(async () => {
  vi.clearAllMocks();
  const { getCensusApiService } = await import('@/services/census-api/census-api-service.js');
  vi.mocked(getCensusApiService).mockReturnValue({
    fetchGeographyLevels: mockFetchGeographyLevels,
  } as never);
});

describe('censusListGeographies', () => {
  it('returns geography levels for a valid dataset', async () => {
    mockFetchGeographyLevels.mockResolvedValue([
      { name: 'us', geoLevelId: '010', requires: [] },
      { name: 'state', geoLevelId: '040', requires: [] },
      { name: 'county', geoLevelId: '050', requires: ['state'] },
      { name: 'tract', geoLevelId: '140', requires: ['state', 'county'] },
    ]);

    const ctx = createMockContext({ errors: censusListGeographies.errors });
    const input = censusListGeographies.input.parse({ dataset: 'acs/acs5' });
    const result = await censusListGeographies.handler(input, ctx);

    expect(result.geography_levels).toHaveLength(4);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.dataset).toBe('acs/acs5');
    expect(enrichment.year).toBe(2024);

    const county = result.geography_levels.find((g) => g.geography_level === 'county');
    expect(county?.requires_parent).toBe(true);
    expect(county?.required_parent_levels).toContain('state');

    const state = result.geography_levels.find((g) => g.geography_level === 'state');
    expect(state?.requires_parent).toBe(false);
  });

  it('throws dataset_not_found for unknown dataset', async () => {
    const ctx = createMockContext({ errors: censusListGeographies.errors });
    const input = censusListGeographies.input.parse({ dataset: 'invalid/dataset' });
    await expect(censusListGeographies.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'dataset_not_found' },
    });
  });

  it('throws year_not_available when API returns empty levels', async () => {
    mockFetchGeographyLevels.mockResolvedValue([]);

    const ctx = createMockContext({ errors: censusListGeographies.errors });
    const input = censusListGeographies.input.parse({ dataset: 'acs/acs5', year: 1900 });
    await expect(censusListGeographies.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'year_not_available' },
    });
  });

  it('assigns example FIPS values for known level names', async () => {
    mockFetchGeographyLevels.mockResolvedValue([
      { name: 'state', geoLevelId: '040', requires: [] },
      { name: 'county', geoLevelId: '050', requires: ['state'] },
      { name: 'zip code tabulation area', geoLevelId: '860', requires: [] },
    ]);

    const ctx = createMockContext({ errors: censusListGeographies.errors });
    const input = censusListGeographies.input.parse({ dataset: 'acs/acs5' });
    const result = await censusListGeographies.handler(input, ctx);

    const state = result.geography_levels.find((g) => g.geography_level === 'state');
    expect(state?.example).toContain('06');

    const zcta = result.geography_levels.find(
      (g) => g.geography_level === 'zip code tabulation area',
    );
    expect(zcta?.example).toContain('90001');
  });

  it('assigns example FIPS for "us" and "block group" levels', async () => {
    mockFetchGeographyLevels.mockResolvedValue([
      { name: 'us', geoLevelId: '010', requires: [] },
      { name: 'block group', geoLevelId: '150', requires: ['state', 'county', 'tract'] },
    ]);

    const ctx = createMockContext({ errors: censusListGeographies.errors });
    const input = censusListGeographies.input.parse({ dataset: 'acs/acs5' });
    const result = await censusListGeographies.handler(input, ctx);

    const us = result.geography_levels.find((g) => g.geography_level === 'us');
    expect(us?.example).toBe('1');

    const bg = result.geography_levels.find((g) => g.geography_level === 'block group');
    expect(bg?.example).toBe('1');
  });

  it('assigns wildcard example for unrecognized geography names', async () => {
    mockFetchGeographyLevels.mockResolvedValue([
      { name: 'congressional district', geoLevelId: '500', requires: ['state'] },
    ]);

    const ctx = createMockContext({ errors: censusListGeographies.errors });
    const input = censusListGeographies.input.parse({ dataset: 'acs/acs5' });
    const result = await censusListGeographies.handler(input, ctx);

    const cd = result.geography_levels.find((g) => g.geography_level === 'congressional district');
    expect(cd?.example).toBe('* (all)');
  });

  it('uses default year when year not provided', async () => {
    mockFetchGeographyLevels.mockResolvedValue([
      { name: 'state', geoLevelId: '040', requires: [] },
    ]);

    const ctx = createMockContext({ errors: censusListGeographies.errors });
    const input = censusListGeographies.input.parse({ dataset: 'acs/acs5' });
    await censusListGeographies.handler(input, ctx);

    const { getEnrichment } = await import('@cyanheads/mcp-ts-core/testing');
    expect(getEnrichment(ctx).year).toBe(2024);
  });

  it('passes custom year to api service', async () => {
    mockFetchGeographyLevels.mockResolvedValue([
      { name: 'state', geoLevelId: '040', requires: [] },
    ]);

    const ctx = createMockContext({ errors: censusListGeographies.errors });
    const input = censusListGeographies.input.parse({ dataset: 'acs/acs5', year: 2019 });
    await censusListGeographies.handler(input, ctx);

    expect(mockFetchGeographyLevels).toHaveBeenCalledWith('acs/acs5', 2019, expect.anything());
  });

  it('enrich reports correct totalLevels count', async () => {
    mockFetchGeographyLevels.mockResolvedValue([
      { name: 'state', geoLevelId: '040', requires: [] },
      { name: 'county', geoLevelId: '050', requires: ['state'] },
      { name: 'tract', geoLevelId: '140', requires: ['state', 'county'] },
    ]);

    const { getEnrichment } = await import('@cyanheads/mcp-ts-core/testing');
    const ctx = createMockContext({ errors: censusListGeographies.errors });
    const input = censusListGeographies.input.parse({ dataset: 'acs/acs5' });
    await censusListGeographies.handler(input, ctx);
    expect(getEnrichment(ctx).totalLevels).toBe(3);
  });

  it('formats output listing geography levels', () => {
    const output = {
      geography_levels: [
        {
          geography_level: 'state',
          requires_parent: false,
          required_parent_levels: [],
          example: '06 (California)',
        },
        {
          geography_level: 'county',
          requires_parent: true,
          required_parent_levels: ['state'],
          example: '037 (Los Angeles County)',
        },
      ],
    };
    const blocks = censusListGeographies.format!(output);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('state');
    expect(text).toContain('county');
    expect(text).toContain('06 (California)');
    expect(text).toContain('037 (Los Angeles County)');
  });

  it('format output does not contain API key or secrets', () => {
    const output = {
      geography_levels: [
        {
          geography_level: 'state',
          requires_parent: false,
          required_parent_levels: [],
          example: '06 (California)',
        },
      ],
    };
    const blocks = censusListGeographies.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).not.toMatch(/CENSUS_API_KEY/);
    expect(text).not.toMatch(/api.key/i);
  });
});
