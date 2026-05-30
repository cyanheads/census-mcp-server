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

    expect(mockResolveGeography).toHaveBeenCalledWith('California', 'state', expect.anything());
  });

  it('throws no_match for empty name', async () => {
    const ctx = createMockContext({ errors: censusResolveGeography.errors });
    const input = censusResolveGeography.input.parse({ name: '' });
    await expect(censusResolveGeography.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_match' },
    });
    expect(mockResolveGeography).not.toHaveBeenCalled();
  });

  it('throws no_match for whitespace-only name', async () => {
    const ctx = createMockContext({ errors: censusResolveGeography.errors });
    const input = censusResolveGeography.input.parse({ name: '   ' });
    await expect(censusResolveGeography.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_match' },
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

  it('strips whitespace from geography_type before passing to service', async () => {
    mockResolveGeography.mockResolvedValue({
      name: 'Texas',
      geographyType: 'state',
      stateFips: '48',
      fipsSummary: '48',
    });

    const ctx = createMockContext({ errors: censusResolveGeography.errors });
    const input = censusResolveGeography.input.parse({
      name: 'Texas',
      geography_type: '  state  ',
    });
    await censusResolveGeography.handler(input, ctx);
    expect(mockResolveGeography).toHaveBeenCalledWith('Texas', 'state', expect.anything());
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
