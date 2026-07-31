/**
 * @fileoverview Tests for census_resolve_geography tool.
 * @module tests/tools/census-resolve-geography.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { censusResolveGeography } from '@/mcp-server/tools/definitions/census-resolve-geography.tool.js';

vi.mock('@/services/geography/geography-service.js', () => ({
  getGeographyService: vi.fn(),
}));

const mockResolveGeography = vi.fn();

beforeEach(async () => {
  vi.clearAllMocks();
  const { getGeographyService } = await import('@/services/geography/geography-service.js');
  vi.mocked(getGeographyService).mockReturnValue({
    resolveGeography: mockResolveGeography,
  } as never);
});

describe('censusResolveGeography', () => {
  it('resolves a county name to FIPS codes', async () => {
    mockResolveGeography.mockResolvedValue({
      name: 'King County, Washington',
      geographyType: 'county',
      stateFips: '53',
      countyFips: '033',
      fipsSummary: '033',
    });

    const ctx = createMockContext({ errors: censusResolveGeography.errors });
    const input = censusResolveGeography.input.parse({ name: 'King County, WA' });
    const result = await censusResolveGeography.handler(input, ctx);

    expect(result.name).toBe('King County, Washington');
    expect(result.geography_type).toBe('county');
    expect(result.state_fips).toBe('53');
    expect(result.county_fips).toBe('033');
    expect(result.fips_summary).toBe('033');
    expect(result).not.toHaveProperty('tract_fips');
    expect(result).not.toHaveProperty('place_fips');
  });

  it('resolves a state name to FIPS', async () => {
    mockResolveGeography.mockResolvedValue({
      name: 'Washington',
      geographyType: 'state',
      stateFips: '53',
      fipsSummary: '53',
    });

    const ctx = createMockContext({ errors: censusResolveGeography.errors });
    const input = censusResolveGeography.input.parse({ name: 'Washington' });
    const result = await censusResolveGeography.handler(input, ctx);

    expect(result.state_fips).toBe('53');
    expect(result.geography_type).toBe('state');
    expect(result).not.toHaveProperty('county_fips');
  });

  it('includes tract_fips when resolved from an address', async () => {
    mockResolveGeography.mockResolvedValue({
      name: '1600 Pennsylvania Ave NW, Washington, DC 20500',
      geographyType: 'tract',
      stateFips: '11',
      countyFips: '001',
      tractFips: '010100',
      fipsSummary: '010100',
    });

    const ctx = createMockContext({ errors: censusResolveGeography.errors });
    const input = censusResolveGeography.input.parse({
      name: '1600 Pennsylvania Ave NW, Washington, DC 20500',
    });
    const result = await censusResolveGeography.handler(input, ctx);

    expect(result.tract_fips).toBe('010100');
    expect(result.county_fips).toBe('001');
  });

  it('throws no_match when geography is not found', async () => {
    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    mockResolveGeography.mockRejectedValue(
      notFound('No geography matched "Nonexistent Place XYZ"', { reason: 'no_match' }),
    );

    const ctx = createMockContext({ errors: censusResolveGeography.errors });
    const input = censusResolveGeography.input.parse({ name: 'Nonexistent Place XYZ' });
    await expect(censusResolveGeography.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('passes geography_type hint to service when provided', async () => {
    mockResolveGeography.mockResolvedValue({
      name: 'California',
      geographyType: 'state',
      stateFips: '06',
      fipsSummary: '06',
    });

    const ctx = createMockContext({ errors: censusResolveGeography.errors });
    const input = censusResolveGeography.input.parse({
      name: 'California',
      geography_type: 'state',
    });
    await censusResolveGeography.handler(input, ctx);

    expect(mockResolveGeography).toHaveBeenCalledWith(
      { name: 'California', geographyType: 'state' },
      expect.anything(),
    );
  });

  it('passes county_fips through to the service', async () => {
    mockResolveGeography.mockResolvedValue({
      name: 'Census Tract 104.01',
      geographyType: 'tract',
      stateFips: '05',
      countyFips: '143',
      tractFips: '010401',
      fipsSummary: '010401',
    });

    const ctx = createMockContext({ errors: censusResolveGeography.errors });
    const input = censusResolveGeography.input.parse({
      name: 'Census Tract 104.01, AR',
      geography_type: 'tract',
      county_fips: '143',
    });
    const result = await censusResolveGeography.handler(input, ctx);

    expect(mockResolveGeography).toHaveBeenCalledWith(
      { name: 'Census Tract 104.01, AR', geographyType: 'tract', countyFips: '143' },
      expect.anything(),
    );
    expect(result.county_fips).toBe('143');
    expect(result.tract_fips).toBe('010401');
  });

  it('omits countyFips from the service call when it was not supplied', async () => {
    mockResolveGeography.mockResolvedValue({
      name: 'Washington',
      geographyType: 'state',
      stateFips: '53',
      fipsSummary: '53',
    });

    const ctx = createMockContext({ errors: censusResolveGeography.errors });
    const input = censusResolveGeography.input.parse({ name: 'Washington' });
    await censusResolveGeography.handler(input, ctx);

    expect(mockResolveGeography).toHaveBeenCalledWith({ name: 'Washington' }, expect.anything());
  });

  it('rejects a non-numeric or over-long county_fips at the schema boundary', () => {
    for (const county_fips of ['033a', '0333', '', 'abc']) {
      expect(() =>
        censusResolveGeography.input.parse({ name: 'Census Tract 104.01, AR', county_fips }),
      ).toThrow();
    }
    expect(() =>
      censusResolveGeography.input.parse({ name: 'Census Tract 104.01, AR', county_fips: '33' }),
    ).not.toThrow();
  });

  it('resolves a metropolitan statistical area with no state_fips', async () => {
    mockResolveGeography.mockResolvedValue({
      name: 'Seattle-Tacoma-Bellevue, WA Metro Area',
      geographyType: 'metropolitan statistical area/micropolitan statistical area',
      fipsSummary: '42660',
    });

    const ctx = createMockContext({ errors: censusResolveGeography.errors });
    const input = censusResolveGeography.input.parse({
      name: 'Seattle-Tacoma-Bellevue, WA',
      geography_type: 'metropolitan statistical area/micropolitan statistical area',
    });
    const result = await censusResolveGeography.handler(input, ctx);

    expect(result.geography_type).toBe(
      'metropolitan statistical area/micropolitan statistical area',
    );
    expect(result.fips_summary).toBe('42660');
    expect(result).not.toHaveProperty('state_fips');
  });

  it('accepts every geography level the service resolves', () => {
    for (const geography_type of [
      'state',
      'county',
      'place',
      'tract',
      'metropolitan statistical area/micropolitan statistical area',
      'combined statistical area',
      'consolidated city',
    ]) {
      expect(() =>
        censusResolveGeography.input.parse({ name: 'Somewhere', geography_type }),
      ).not.toThrow();
    }
  });

  it('throws county_scope_unsupported when the service rejects the county scope', async () => {
    const { McpError, JsonRpcErrorCode: codes } = await import('@cyanheads/mcp-ts-core/errors');
    mockResolveGeography.mockRejectedValue(
      new McpError(codes.ValidationError, 'county_fips does not apply to the place level', {
        reason: 'county_scope_unsupported',
      }),
    );

    const ctx = createMockContext({ errors: censusResolveGeography.errors });
    const input = censusResolveGeography.input.parse({
      name: 'Seattle, WA',
      geography_type: 'place',
      county_fips: '033',
    });
    await expect(censusResolveGeography.handler(input, ctx)).rejects.toMatchObject({
      code: codes.ValidationError,
      data: { reason: 'county_scope_unsupported' },
    });
  });

  it('format names the level to query at and reports no parent for a statistical area', () => {
    const blocks = censusResolveGeography.format!({
      name: 'Seattle-Tacoma, WA CSA',
      geography_type: 'combined statistical area',
      fips_summary: '500',
    });
    const text = (blocks[0] as { type: string; text: string }).text;

    expect(text).toContain('geography_level');
    expect(text).toContain('combined statistical area');
    expect(text).toContain('without `parent_fips`');
    expect(text).not.toContain('State FIPS');
  });

  it('throws ValidationError for empty name', async () => {
    const ctx = createMockContext({ errors: censusResolveGeography.errors });
    const input = censusResolveGeography.input.parse({ name: '' });
    await expect(censusResolveGeography.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
    });
    expect(mockResolveGeography).not.toHaveBeenCalled();
  });

  it('throws ValidationError for whitespace-only name', async () => {
    const ctx = createMockContext({ errors: censusResolveGeography.errors });
    const input = censusResolveGeography.input.parse({ name: '   ' });
    await expect(censusResolveGeography.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
    });
    expect(mockResolveGeography).not.toHaveBeenCalled();
  });

  it('includes place_fips when service resolves a place', async () => {
    mockResolveGeography.mockResolvedValue({
      name: 'Seattle, Washington',
      geographyType: 'place',
      stateFips: '53',
      placeFips: '63000',
      fipsSummary: '63000',
    });

    const ctx = createMockContext({ errors: censusResolveGeography.errors });
    const input = censusResolveGeography.input.parse({ name: 'Seattle, WA' });
    const result = await censusResolveGeography.handler(input, ctx);

    expect(result.place_fips).toBe('63000');
    expect(result.geography_type).toBe('place');
    expect(result).not.toHaveProperty('county_fips');
  });

  it('throws ambiguous_name when service rejects with ambiguity', async () => {
    const { McpError, JsonRpcErrorCode: codes } = await import('@cyanheads/mcp-ts-core/errors');
    mockResolveGeography.mockRejectedValue(
      new McpError(codes.ValidationError, 'Matched multiple geographies', {
        reason: 'ambiguous_name',
      }),
    );

    const ctx = createMockContext({ errors: censusResolveGeography.errors });
    const input = censusResolveGeography.input.parse({ name: 'Springfield' });
    await expect(censusResolveGeography.handler(input, ctx)).rejects.toMatchObject({
      code: codes.ValidationError,
    });
  });

  it('throws resolution_unavailable when service is down', async () => {
    const { McpError, JsonRpcErrorCode: codes } = await import('@cyanheads/mcp-ts-core/errors');
    mockResolveGeography.mockRejectedValue(
      new McpError(codes.ServiceUnavailable, 'Geography endpoint unreachable', {
        reason: 'resolution_unavailable',
      }),
    );

    const ctx = createMockContext({ errors: censusResolveGeography.errors });
    const input = censusResolveGeography.input.parse({ name: 'California' });
    await expect(censusResolveGeography.handler(input, ctx)).rejects.toMatchObject({
      code: codes.ServiceUnavailable,
    });
  });

  it('rejects invalid geography_type values at the schema boundary', () => {
    expect(() =>
      censusResolveGeography.input.parse({
        name: 'Texas',
        geography_type: 'city',
      }),
    ).toThrow();
  });

  it('rejects whitespace-padded geography_type values at the schema boundary', () => {
    expect(() =>
      censusResolveGeography.input.parse({
        name: 'Texas',
        geography_type: '  state  ',
      }),
    ).toThrow();
  });

  it('format includes tract_fips and place_fips when present', () => {
    const output = {
      name: '1600 Pennsylvania Ave NW, Washington, DC',
      geography_type: 'tract',
      state_fips: '11',
      county_fips: '001',
      tract_fips: '010100',
      fips_summary: '010100',
    };
    const blocks = censusResolveGeography.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('010100');
  });

  it('format notes county_fips usage as county_fips in census_query_data for tract-level results', () => {
    const output = {
      name: '1600 Pennsylvania Ave NW, Washington, DC',
      geography_type: 'tract',
      state_fips: '11',
      county_fips: '001',
      tract_fips: '010100',
      fips_summary: '010100',
    };
    const blocks = censusResolveGeography.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('county_fips');
  });

  it('format does not note county_fips usage for non-tract results', () => {
    const output = {
      name: 'King County, Washington',
      geography_type: 'county',
      state_fips: '53',
      county_fips: '033',
      fips_summary: '033',
    };
    const blocks = censusResolveGeography.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    // county_fips appears in the parent_fips line for non-tract geography types but not the county_fips instruction
    expect(text).toContain('033');
    expect(text).not.toContain('also use as');
  });

  it('format output never contains API key or secrets', () => {
    const output = {
      name: 'King County, Washington',
      geography_type: 'county',
      state_fips: '53',
      county_fips: '033',
      fips_summary: '033',
    };
    const blocks = censusResolveGeography.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).not.toMatch(/CENSUS_API_KEY/);
    expect(text).not.toMatch(/api.key/i);
    expect(text).not.toMatch(/secret/i);
  });

  it('injection attempt in name does not crash handler', async () => {
    const { McpError, JsonRpcErrorCode: codes } = await import('@cyanheads/mcp-ts-core/errors');
    mockResolveGeography.mockRejectedValue(
      new McpError(codes.NotFound, 'No geography matched', { reason: 'no_match' }),
    );
    const ctx = createMockContext({ errors: censusResolveGeography.errors });
    const input = censusResolveGeography.input.parse({
      name: "'; SELECT * FROM geographies; --",
    });
    await expect(censusResolveGeography.handler(input, ctx)).rejects.toMatchObject({
      code: codes.NotFound,
    });
  });

  it('formats output with state and geography FIPS', () => {
    const output = {
      name: 'King County, Washington',
      geography_type: 'county',
      state_fips: '53',
      county_fips: '033',
      fips_summary: '033',
    };
    const blocks = censusResolveGeography.format!(output);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('King County, Washington');
    expect(text).toContain('53');
    expect(text).toContain('033');
    expect(text).toContain('parent_fips');
    expect(text).toContain('geography_fips');
  });
});
