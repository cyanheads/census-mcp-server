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

vi.mock('@/services/variable-cache/variable-cache-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/variable-cache/variable-cache-service.js')>()),
  DATASET_LATEST_YEARS: { 'acs/acs5': 2024, 'dec/pl': 2020 },
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
      { name: 'us', geoLevelDisplay: '010', requires: [] },
      { name: 'state', geoLevelDisplay: '040', requires: [] },
      { name: 'county', geoLevelDisplay: '050', requires: ['state'] },
      { name: 'tract', geoLevelDisplay: '140', requires: ['state', 'county'] },
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

  /** The only tool of the six that took its dataset untrimmed (#32). */
  it.each(['acs5', 'ACS5', 'ACS/ACS5', ' acs5 ', ' acs/acs5 '])(
    'resolves %j to acs/acs5 and echoes the canonical code (#32)',
    async (dataset) => {
      mockFetchGeographyLevels.mockResolvedValue([
        { name: 'state', geoLevelDisplay: '040', requires: [] },
      ]);

      const ctx = createMockContext({ errors: censusListGeographies.errors });
      await censusListGeographies.handler(censusListGeographies.input.parse({ dataset }), ctx);

      expect(mockFetchGeographyLevels).toHaveBeenCalledWith('acs/acs5', 2024, expect.anything());
      expect(getEnrichment(ctx)).toMatchObject({ dataset: 'acs/acs5', year: 2024 });
    },
  );

  it('takes its default year from the resolved code (#32)', async () => {
    mockFetchGeographyLevels.mockResolvedValue([
      { name: 'state', geoLevelDisplay: '040', requires: [] },
    ]);

    const ctx = createMockContext({ errors: censusListGeographies.errors });
    await censusListGeographies.handler(censusListGeographies.input.parse({ dataset: 'PL' }), ctx);

    expect(mockFetchGeographyLevels).toHaveBeenCalledWith('dec/pl', 2020, expect.anything());
  });

  it('rejects a blank dataset as a missing code, before any request (#32)', async () => {
    const ctx = createMockContext({ errors: censusListGeographies.errors });
    const input = censusListGeographies.input.parse({ dataset: '  ' });

    await expect(censusListGeographies.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: expect.stringMatching(/no dataset code/i),
      data: { reason: 'dataset_not_found' },
    });
    expect(mockFetchGeographyLevels).not.toHaveBeenCalled();
  });

  it('names both profile datasets for a bare "profile" (#32)', async () => {
    const ctx = createMockContext({ errors: censusListGeographies.errors });
    const input = censusListGeographies.input.parse({ dataset: 'profile' });

    // #62: the codes to pass are the next step, so the hint names them and the message does not.
    await expect(censusListGeographies.handler(input, ctx)).rejects.toMatchObject({
      message:
        'Unknown dataset: "profile" is the last segment of a dataset code, not a dataset code of its own.',
      data: { recovery: { hint: 'Pass the full code — acs/acs5/profile or acs/acs1/profile.' } },
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

  it('names the years the dataset serves, in the hint alone, for a year outside them', async () => {
    mockFetchGeographyLevels.mockResolvedValue([]);

    const ctx = createMockContext({ errors: censusListGeographies.errors });
    const input = censusListGeographies.input.parse({ dataset: 'dec/pl', year: 2015 });
    await expect(censusListGeographies.handler(input, ctx)).rejects.toMatchObject({
      message: 'dec/pl cannot be queried for 2015.',
      data: {
        reason: 'year_not_available',
        availableYears: [2000, 2010, 2020],
        recovery: { hint: 'Retry with a year this dataset serves: 2000, 2010, 2020.' },
      },
    });
  });

  it('names no year list when a year the dataset serves has no geography list', async () => {
    mockFetchGeographyLevels.mockResolvedValue([]);

    const ctx = createMockContext({ errors: censusListGeographies.errors });
    const input = censusListGeographies.input.parse({ dataset: 'acs/acs5', year: 2024 });
    const error = await Promise.resolve(censusListGeographies.handler(input, ctx)).catch(
      (e: unknown) => e,
    );

    expect(error).toMatchObject({
      message: 'No geography data found for acs/acs5 (2024).',
      data: { reason: 'year_not_available' },
    });
    expect((error as { data: Record<string, unknown> }).data).not.toHaveProperty('availableYears');
  });

  it('counts a level listed under several parent hierarchies once', async () => {
    mockFetchGeographyLevels.mockResolvedValue([
      { name: 'state', geoLevelDisplay: '040', requires: [] },
      { name: 'county', geoLevelDisplay: '050', requires: ['state'] },
      { name: 'county', geoLevelDisplay: '050', requires: ['combined statistical area'] },
    ]);

    const ctx = createMockContext({ errors: censusListGeographies.errors });
    const input = censusListGeographies.input.parse({ dataset: 'acs/acs5' });
    const result = await censusListGeographies.handler(input, ctx);

    expect(result.geography_levels).toHaveLength(3);
    expect(getEnrichment(ctx).totalLevels).toBe(2);
    const text = (censusListGeographies.format!(result)[0] as { text: string }).text;
    expect(text).toContain(
      '**2 levels available** — 3 entries, since a level published under more than one parent hierarchy is listed once for each',
    );
  });

  it('assigns example FIPS values for known level names', async () => {
    mockFetchGeographyLevels.mockResolvedValue([
      { name: 'state', geoLevelDisplay: '040', requires: [] },
      { name: 'county', geoLevelDisplay: '050', requires: ['state'] },
      { name: 'zip code tabulation area', geoLevelDisplay: '860', requires: [] },
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
      { name: 'us', geoLevelDisplay: '010', requires: [] },
      { name: 'block group', geoLevelDisplay: '150', requires: ['state', 'county', 'tract'] },
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
      { name: 'congressional district', geoLevelDisplay: '500', requires: ['state'] },
    ]);

    const ctx = createMockContext({ errors: censusListGeographies.errors });
    const input = censusListGeographies.input.parse({ dataset: 'acs/acs5' });
    const result = await censusListGeographies.handler(input, ctx);

    const cd = result.geography_levels.find((g) => g.geography_level === 'congressional district');
    expect(cd?.example).toBe('* (all)');
  });

  it('uses default year when year not provided', async () => {
    mockFetchGeographyLevels.mockResolvedValue([
      { name: 'state', geoLevelDisplay: '040', requires: [] },
    ]);

    const ctx = createMockContext({ errors: censusListGeographies.errors });
    const input = censusListGeographies.input.parse({ dataset: 'acs/acs5' });
    await censusListGeographies.handler(input, ctx);

    const { getEnrichment } = await import('@cyanheads/mcp-ts-core/testing');
    expect(getEnrichment(ctx).year).toBe(2024);
  });

  it('passes custom year to api service', async () => {
    mockFetchGeographyLevels.mockResolvedValue([
      { name: 'state', geoLevelDisplay: '040', requires: [] },
    ]);

    const ctx = createMockContext({ errors: censusListGeographies.errors });
    const input = censusListGeographies.input.parse({ dataset: 'acs/acs5', year: 2019 });
    await censusListGeographies.handler(input, ctx);

    expect(mockFetchGeographyLevels).toHaveBeenCalledWith('acs/acs5', 2019, expect.anything());
  });

  it('enrich reports correct totalLevels count', async () => {
    mockFetchGeographyLevels.mockResolvedValue([
      { name: 'state', geoLevelDisplay: '040', requires: [] },
      { name: 'county', geoLevelDisplay: '050', requires: ['state'] },
      { name: 'tract', geoLevelDisplay: '140', requires: ['state', 'county'] },
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
