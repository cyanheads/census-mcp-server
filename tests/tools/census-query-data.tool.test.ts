/**
 * @fileoverview Tests for census_query_data tool.
 * @module tests/tools/census-query-data.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { censusQueryData } from '@/mcp-server/tools/definitions/census-query-data.tool.js';

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
const mockCheckGeography = vi.fn();
const mockGetVariablesByCode = vi.fn();

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
  } as never);

  // Default: label enrichment returns the code as label (best-effort)
  mockGetVariablesByCode.mockResolvedValue([]);
});

describe('censusQueryData', () => {
  it('returns enriched rows for a valid query', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'King County, Washington',
        geographyFips: '033',
        geographyGeoid: '53033',
        variables: {
          B19013_001E: { estimate: 105000, label: 'B19013_001E', suppressed: false },
        },
      },
    ]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      geography_fips: '033',
      parent_fips: '53',
    });
    const result = await censusQueryData.handler(input, ctx);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.geography_name).toBe('King County, Washington');
    expect(result.rows[0]?.geography_fips).toBe('033');
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalRows).toBe(1);
    expect(enrichment.dataset).toBe('acs/acs5');
    expect(enrichment.year).toBe(2024);
  });

  it('passes parentFips to apiService when provided', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'King County, Washington',
        geographyFips: '033',
        geographyGeoid: '53033',
        variables: {
          B19013_001E: { estimate: 105000, label: 'B19013_001E', suppressed: false },
        },
      },
    ]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      geography_fips: '033',
      parent_fips: '53',
    });
    await censusQueryData.handler(input, ctx);

    expect(mockQueryData).toHaveBeenCalledWith(
      expect.objectContaining({ parentFips: '53' }),
      expect.anything(),
    );
  });

  it('omits parentFips from apiService call when not provided', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'California',
        geographyFips: '06',
        geographyGeoid: '06',
        variables: {
          B01001_001E: { estimate: 39000000, label: 'B01001_001E', suppressed: false },
        },
      },
    ]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B01001_001E'],
      geography_level: 'state',
      geography_fips: '06',
    });
    await censusQueryData.handler(input, ctx);

    const callArgs = mockQueryData.mock.calls[0]?.[0];
    expect(callArgs).not.toHaveProperty('parentFips');
  });

  it('throws ValidationError when variables array is empty', async () => {
    const ctx = createMockContext({ errors: censusQueryData.errors });
    // Zod allows empty array — handler validates length
    const input = { variables: [], geography_level: 'state', geography_fips: '06' };
    await expect(
      censusQueryData.handler(input as Parameters<typeof censusQueryData.handler>[0], ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
    });
  });

  it('throws too_many_variables when more than 50 requested', async () => {
    const ctx = createMockContext({ errors: censusQueryData.errors });
    const manyVars = Array.from({ length: 51 }, (_, i) => `B19013_${String(i).padStart(3, '0')}E`);
    const input = censusQueryData.input.parse({
      variables: manyVars,
      geography_level: 'state',
      geography_fips: '06',
    });
    await expect(censusQueryData.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'too_many_variables' },
    });
  });

  it('passes countyFips to apiService for tract-level queries', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'Census Tract 1, King County, Washington',
        geographyFips: '000100',
        geographyGeoid: '53033000100',
        variables: {
          B19013_001E: { estimate: 98000, label: 'B19013_001E', suppressed: false },
        },
      },
    ]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'tract',
      geography_fips: '000100',
      parent_fips: '53',
      county_fips: '033',
    });
    await censusQueryData.handler(input, ctx);

    expect(mockQueryData).toHaveBeenCalledWith(
      expect.objectContaining({ parentFips: '53', countyFips: '033' }),
      expect.anything(),
    );
  });

  it('omits countyFips from apiService call when county_fips not provided', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'King County, Washington',
        geographyFips: '033',
        geographyGeoid: '53033',
        variables: {
          B19013_001E: { estimate: 105000, label: 'B19013_001E', suppressed: false },
        },
      },
    ]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      geography_fips: '033',
      parent_fips: '53',
    });
    await censusQueryData.handler(input, ctx);

    const callArgs = mockQueryData.mock.calls[0]?.[0];
    expect(callArgs).not.toHaveProperty('countyFips');
  });

  it('throws dataset_not_found for unknown dataset', async () => {
    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'state',
      geography_fips: '06',
      dataset: 'invalid/dataset',
    });
    await expect(censusQueryData.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'dataset_not_found' },
    });
  });

  it('throws no_data when query returns empty rows', async () => {
    mockQueryData.mockResolvedValue([]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      geography_fips: '999',
      dataset: 'acs/acs5',
    });
    await expect(censusQueryData.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_data' },
    });
  });

  it('throws parent_required before querying for a tract with no parent_fips', async () => {
    mockCheckGeography.mockResolvedValue({ status: 'parent_required', missingParents: ['state'] });

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'tract',
      geography_fips: '*',
    });
    await expect(censusQueryData.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'parent_required',
        missingParents: ['state'],
        recovery: { hint: expect.stringContaining('parent_fips') },
      },
    });
    expect(mockQueryData).not.toHaveBeenCalled();
  });

  it('parent_required names county_fips when the county parent is missing', async () => {
    mockCheckGeography.mockResolvedValue({ status: 'parent_required', missingParents: ['county'] });

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'block group',
      geography_fips: '*',
      parent_fips: '53',
    });
    await expect(censusQueryData.handler(input, ctx)).rejects.toMatchObject({
      data: { recovery: { hint: expect.stringContaining('county_fips') } },
    });
  });

  it('parent_required offers the wildcard when the missing parent has no input', async () => {
    mockCheckGeography.mockResolvedValue({
      status: 'parent_required',
      missingParents: ['tract'],
      wildcardRelaxes: true,
    });

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'block group',
      geography_fips: '1',
      parent_fips: '53',
      county_fips: '033',
    });
    await expect(censusQueryData.handler(input, ctx)).rejects.toMatchObject({
      data: { recovery: { hint: expect.stringContaining('geography_fips to "*"') } },
    });
  });

  it('parent_required says the level is out of reach when no wildcard would help', async () => {
    mockCheckGeography.mockResolvedValue({
      status: 'parent_required',
      missingParents: ['county subdivision'],
      wildcardRelaxes: false,
    });

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'subminor civil division',
      geography_fips: '*',
      parent_fips: '53',
      county_fips: '033',
    });
    await expect(censusQueryData.handler(input, ctx)).rejects.toMatchObject({
      data: { recovery: { hint: expect.stringContaining('no input for') } },
    });
  });

  it('throws geography_not_supported before querying for a level the dataset lacks', async () => {
    mockCheckGeography.mockResolvedValue({
      status: 'level_not_supported',
      availableLevels: ['us', 'state', 'county'],
    });

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'tract',
      geography_fips: '*',
      parent_fips: '53',
      dataset: 'acs/acs1',
    });
    await expect(censusQueryData.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'geography_not_supported', availableLevels: ['us', 'state', 'county'] },
    });
    expect(mockQueryData).not.toHaveBeenCalled();
  });

  it('no_data recovery does not tell an acs/acs5 caller to switch to acs/acs5', async () => {
    mockQueryData.mockResolvedValue([]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      geography_fips: '999',
      dataset: 'acs/acs5',
    });
    await expect(censusQueryData.handler(input, ctx)).rejects.toMatchObject({
      data: { recovery: { hint: expect.not.stringContaining('switch to') } },
    });
  });

  it('no_data recovery suggests acs/acs5 when the caller is on acs/acs1', async () => {
    mockQueryData.mockResolvedValue([]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      geography_fips: '999',
      dataset: 'acs/acs1',
    });
    await expect(censusQueryData.handler(input, ctx)).rejects.toMatchObject({
      data: { recovery: { hint: expect.stringContaining('acs/acs5') } },
    });
  });

  it('returns the composed GEOID alongside the bare level FIPS', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'King County, Washington',
        geographyFips: '033',
        geographyGeoid: '53033',
        variables: {
          B19013_001E: { estimate: 105000, label: 'B19013_001E', suppressed: false },
        },
      },
    ]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      geography_fips: '033',
      parent_fips: '53',
    });
    const result = await censusQueryData.handler(input, ctx);

    expect(result.rows[0]?.geography_fips).toBe('033');
    expect(result.rows[0]?.geography_geoid).toBe('53033');
  });

  it('surfaces suppressed values with suppression_reason in output', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'Small County',
        geographyFips: '999',
        geographyGeoid: '53999',
        variables: {
          B19013_001E: {
            estimate: null,
            label: 'B19013_001E',
            suppressed: true,
            suppressionReason: 'Not available — geography too small or data not collected',
          },
        },
      },
    ]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      geography_fips: '999',
    });
    const result = await censusQueryData.handler(input, ctx);

    const vars = result.rows[0]?.variables as Record<
      string,
      { suppressed: boolean; suppression_reason?: string }
    >;
    expect(vars.B19013_001E?.suppressed).toBe(true);
    expect(vars.B19013_001E?.suppression_reason).toContain('geography too small');
  });

  it('formats output with geography names, FIPS, and variable values', () => {
    const output = {
      rows: [
        {
          geography_name: 'King County, Washington',
          geography_fips: '033',
          geography_geoid: '53033',
          variables: {
            B19013_001E: {
              estimate: 105000,
              label: 'Median household income',
              suppressed: false,
            },
          },
        },
      ],
    };
    const blocks = censusQueryData.format!(output);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('King County, Washington');
    expect(text).toContain('033');
    expect(text).toContain('B19013_001E');
    expect(text).toContain('105,000');
  });

  it('format shows suppressed label when estimate is suppressed', () => {
    const output = {
      rows: [
        {
          geography_name: 'Tiny Town',
          geography_fips: '999',
          geography_geoid: '53999',
          variables: {
            B19013_001E: {
              estimate: null,
              label: 'Median household income',
              suppressed: true,
              suppression_reason: 'Not available — geography too small',
            },
          },
        },
      ],
    };
    const blocks = censusQueryData.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('Suppressed');
    expect(text).toContain('geography too small');
  });

  it('includes moe in output when service returns it', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'California',
        geographyFips: '06',
        geographyGeoid: '06',
        variables: {
          B19013_001E: {
            estimate: 75000,
            moe: 150,
            label: 'Median income',
            suppressed: false,
          },
        },
      },
    ]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'state',
      geography_fips: '06',
    });
    const result = await censusQueryData.handler(input, ctx);
    const vars = result.rows[0]?.variables as Record<string, { moe?: number }>;
    expect(vars.B19013_001E?.moe).toBe(150);
  });

  it('wildcard geography_fips passes "*" to api service', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'Alabama',
        geographyFips: '01',
        geographyGeoid: '01',
        variables: {
          B01001_001E: { estimate: 4900000, label: 'Total', suppressed: false },
        },
      },
    ]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B01001_001E'],
      geography_level: 'state',
      geography_fips: '*',
    });
    await censusQueryData.handler(input, ctx);
    expect(mockQueryData).toHaveBeenCalledWith(
      expect.objectContaining({ geographyFips: '*' }),
      expect.anything(),
    );
  });

  it('label enrichment from variable cache falls through to api label on cache failure', async () => {
    // variable cache throws — handler catches and continues
    const { getVariableCacheService } = await import(
      '@/services/variable-cache/variable-cache-service.js'
    );
    vi.mocked(getVariableCacheService).mockReturnValue({
      getVariablesByCode: vi.fn().mockRejectedValue(new Error('cache cold')),
    } as never);

    mockQueryData.mockResolvedValue([
      {
        geographyName: 'Oregon',
        geographyFips: '41',
        geographyGeoid: '41',
        variables: {
          B01001_001E: { estimate: 4200000, label: 'Total population', suppressed: false },
        },
      },
    ]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B01001_001E'],
      geography_level: 'state',
      geography_fips: '41',
    });
    const result = await censusQueryData.handler(input, ctx);
    // Falls back to api-provided label
    const vars = result.rows[0]?.variables as Record<string, { label: string }>;
    expect(vars.B01001_001E?.label).toBe('Total population');
  });

  it('throws upstream_error when api service rejects', async () => {
    const { McpError, JsonRpcErrorCode: codes } = await import('@cyanheads/mcp-ts-core/errors');
    mockQueryData.mockRejectedValue(
      new McpError(codes.ServiceUnavailable, 'Census API returned 503', {
        reason: 'upstream_error',
      }),
    );

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'state',
      geography_fips: '06',
    });
    await expect(censusQueryData.handler(input, ctx)).rejects.toMatchObject({
      code: codes.ServiceUnavailable,
    });
  });

  it('format shows moe alongside estimate when present', () => {
    const output = {
      rows: [
        {
          geography_name: 'Oregon',
          geography_fips: '41',
          geography_geoid: '41',
          variables: {
            B19013_001E: {
              estimate: 75000,
              moe: 300,
              label: 'Median income',
              suppressed: false,
            },
          },
        },
      ],
    };
    const blocks = censusQueryData.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('±');
    expect(text).toContain('300');
  });

  it('format output never contains API key or secrets', () => {
    const output = {
      rows: [
        {
          geography_name: 'Oregon',
          geography_fips: '41',
          geography_geoid: '41',
          variables: {
            B19013_001E: {
              estimate: 75000,
              label: 'Median income',
              suppressed: false,
            },
          },
        },
      ],
    };
    const blocks = censusQueryData.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).not.toMatch(/CENSUS_API_KEY/);
    expect(text).not.toMatch(/api.key/i);
    expect(text).not.toMatch(/secret/i);
  });

  it('injection attempt in variable codes is safely forwarded', async () => {
    const { McpError, JsonRpcErrorCode: codes } = await import('@cyanheads/mcp-ts-core/errors');
    mockQueryData.mockRejectedValue(
      new McpError(codes.ValidationError, 'Invalid variable code', {
        reason: 'variable_not_found',
      }),
    );

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const injectionPayload = "B19013_001E'; DROP TABLE vars; --";
    const input = censusQueryData.input.parse({
      variables: [injectionPayload],
      geography_level: 'state',
      geography_fips: '06',
    });
    await expect(censusQueryData.handler(input, ctx)).rejects.toMatchObject({
      code: codes.ValidationError,
    });
  });

  it('throws with exactly 50 variables — boundary accepted', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'State X',
        geographyFips: '01',
        geographyGeoid: '01',
        variables: Object.fromEntries(
          Array.from({ length: 50 }, (_, i) => [
            `B${String(i).padStart(7, '0')}E`,
            { estimate: i, label: `Var ${i}`, suppressed: false },
          ]),
        ),
      },
    ]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const vars50 = Array.from({ length: 50 }, (_, i) => `B${String(i).padStart(7, '0')}E`);
    const input = censusQueryData.input.parse({
      variables: vars50,
      geography_level: 'state',
      geography_fips: '01',
    });
    const result = await censusQueryData.handler(input, ctx);
    expect(result.rows).toHaveLength(1);
  });

  it('format handles multiple rows correctly', () => {
    const output = {
      rows: [
        {
          geography_name: 'King County',
          geography_fips: '033',
          geography_geoid: '53033',
          variables: {
            B19013_001E: { estimate: 105000, label: 'Median income', suppressed: false },
          },
        },
        {
          geography_name: 'Pierce County',
          geography_fips: '053',
          geography_geoid: '53053',
          variables: {
            B19013_001E: { estimate: 72000, label: 'Median income', suppressed: false },
          },
        },
      ],
    };
    const blocks = censusQueryData.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('King County');
    expect(text).toContain('Pierce County');
  });
});
