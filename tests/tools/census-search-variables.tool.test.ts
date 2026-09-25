/**
 * @fileoverview Tests for census_search_variables tool.
 * @module tests/tools/census-search-variables.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { censusSearchVariables } from '@/mcp-server/tools/definitions/census-search-variables.tool.js';

// Mock the variable cache service and server config; dataset resolution stays real.
vi.mock('@/services/variable-cache/variable-cache-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/variable-cache/variable-cache-service.js')>()),
  DATASET_LATEST_YEARS: { 'acs/acs5': 2024 },
  getVariableCacheService: vi.fn(),
}));

vi.mock('@/config/server-config.js', () => ({
  getDiscoveryConfig: vi.fn(() => ({ defaultYear: 2024, variableCacheTtlHours: 24 })),
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

  it('rejects a limit above 100 at the schema rather than clamping it', () => {
    expect(censusSearchVariables.input.safeParse({ query: 'income', limit: 101 }).success).toBe(
      false,
    );
    expect(censusSearchVariables.input.safeParse({ query: 'income', limit: 100 }).success).toBe(
      true,
    );
  });

  it('passes limit 100 through and does not advise raising it once truncated there', async () => {
    mockSearchVariables.mockResolvedValue({
      variables: Array.from({ length: 100 }, (_, i) => ({
        code: `B01001_${String(i).padStart(3, '0')}E`,
        label: 'Sex by age',
        concept: 'SEX BY AGE',
        predicateType: 'int',
      })),
      totalMatches: 19423,
    });

    const ctx = createMockContext({ errors: censusSearchVariables.errors });
    const input = censusSearchVariables.input.parse({ query: 'income', limit: 100 });
    await censusSearchVariables.handler(input, ctx);

    expect(mockSearchVariables).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
      expect.anything(),
    );
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('19423 variables matched');
    expect(notice).toContain('Narrow the query');
    expect(notice).not.toMatch(/raise limit/i);
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
