/**
 * @fileoverview Tests for census_query_data tool.
 * @module tests/tools/census-query-data.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { censusQueryData } from '@/mcp-server/tools/definitions/census-query-data.tool.js';
import { yearNotAvailable } from '@/services/census-api/errors.js';
import { DATASET_AVAILABLE_YEARS } from '@/services/variable-cache/variable-cache-service.js';
import { readNotice } from '../helpers/markdown-readback.js';
import { readVariableLabels } from '../helpers/variable-labels-readback.js';

vi.mock('@/services/census-api/census-api-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/census-api/census-api-service.js')>()),
  getCensusApiService: vi.fn(),
}));

vi.mock('@/services/variable-cache/variable-cache-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/variable-cache/variable-cache-service.js')>()),
  DATASET_LATEST_YEARS: { 'acs/acs5': 2024, cbp: 2023, 'dec/ddhca': 2020, 'pep/charv': 2023 },
  KNOWN_DATASETS: new Set([
    'acs/acs5',
    'acs/acs1',
    'acs/acs5/profile',
    'dec/pl',
    'dec/ddhca',
    'cbp',
    'pep/charv',
  ]),
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

/** The error a handler call rejects with. */
const failureOf = async (
  input: Parameters<typeof censusQueryData.handler>[0],
  ctx: Parameters<typeof censusQueryData.handler>[1],
) => {
  const run = async () => censusQueryData.handler(input, ctx);
  return run().catch((e: unknown) => e);
};

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
const mockResolveGroup = vi.fn();

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
    resolveGroup: mockResolveGroup,
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

describe('censusQueryData', () => {
  it.each([
    ['acs/acs1', '65,000', 'acs/acs5'],
    ['acs/acsse', '20,000', 'acs/acs5'],
    ['acs/acs1/profile', '65,000', 'acs/acs5/profile'],
    ['acs/acs1/cprofile', '65,000', 'acs/acs5/profile'],
    ['acs/acs5/cprofile', '5,000', 'acs/acs5/profile'],
    ['acs/acs1/spp', '500,000', 'acs/acs5'],
    ['acs/acs1/subject', '65,000', 'acs/acs5/subject'],
  ])(
    'explains possible coverage for empty %s results without losing code checks',
    async (dataset, threshold, alternative) => {
      mockQueryData.mockResolvedValue([]);
      const result = await runToolContract(censusQueryData, {
        variables: ['B01003_001E'],
        dataset,
        year: 2024,
        geography_level: 'county',
        geography_fips: '019',
        parent_fips: '53',
      });
      const data = result.structuredContent as {
        error: { data: { reason: string; recovery: { hint: string } } };
      };
      expect(data.error.data.reason).toBe('no_data');
      const hint = data.error.data.recovery.hint;
      expect(hint).toContain(threshold);
      expect(hint).toContain(alternative);
      expect(hint).toContain('census_search_variables');
      expect(hint).toContain('possible');
      expect(hint).toContain('literally');
      expect(hint).toContain('census_resolve_geography');
      const text = result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      expect(text).toContain(threshold);
      expect(text).toContain('census_search_variables');
      if (dataset.endsWith('/cprofile')) expect(hint).toContain('comparison history');
      if (dataset.endsWith('/spp')) expect(hint).toContain('subgroup');
      if (dataset.endsWith('/subject')) expect(hint).toContain('subgroup');
    },
  );

  it.each(['acs/acs1', 'acs/acsse', 'acs/acs5/cprofile'])(
    'keeps %s missing-member coverage independent of pagination',
    async (dataset) => {
      mockQueryData.mockResolvedValue([
        { geographyName: 'King', geographyFips: '033', geographyGeoid: '53033', variables: {} },
        { geographyName: 'Pierce', geographyFips: '053', geographyGeoid: '53053', variables: {} },
      ]);
      const result = await runToolContract(censusQueryData, {
        variables: ['B01003_001E'],
        dataset,
        year: 2024,
        geography_level: 'county',
        geography_fips: '019,033,053',
        parent_fips: '53',
        limit: 1,
      });
      expect(result.isError).not.toBe(true);
      const data = result.structuredContent as { notice: string };
      expect(data.notice).toContain('1 of the 3');
      expect(data.notice).toContain('019');
      expect(data.notice).toContain('possible');
      expect(data.notice).toContain('census_search_variables');
      expect(readNotice(result)).toBe(data.notice);
    },
  );

  it.each([
    { offset: 0, limit: 2, count: 2, more: true, next: 2 },
    { offset: 2, limit: 2, count: 2, more: true, next: 4 },
    { offset: 4, limit: 2, count: 1, more: false, next: undefined },
    { offset: 5, limit: 2, count: 0, more: false, next: undefined },
    { offset: 9, limit: 2, count: 0, more: false, next: undefined },
    { offset: 4, limit: 1, count: 1, more: false, next: undefined },
    { offset: 0, limit: 5, count: 5, more: false, next: undefined },
  ])(
    'exposes continuation on both surfaces for offset $offset, limit $limit',
    async ({ offset, limit, count, more, next }) => {
      mockQueryData.mockResolvedValue(
        [5, 3, 1, 4, 2].map((code) => ({
          geographyName: `County ${code}`,
          geographyFips: String(code).padStart(3, '0'),
          geographyGeoid: `53${String(code).padStart(3, '0')}`,
          variables: {
            B01003_001E: { estimate: code * 100, suppressed: false },
          },
        })),
      );
      const result = await runToolContract(censusQueryData, {
        variables: ['B01003_001E'],
        geography_level: 'county',
        geography_fips: '*',
        parent_fips: '53',
        offset,
        limit,
      });
      expect(result.isError).not.toBe(true);
      const data = result.structuredContent as {
        rows: { geography_geoid: string }[];
        totalCount: number;
        truncated: boolean;
        nextOffset?: number;
        notice?: string;
      };
      expect(data.rows).toHaveLength(count);
      expect(data.totalCount).toBe(5);
      expect(data.truncated).toBe(more);
      expect(data.nextOffset).toBe(next);
      const text = result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      expect(text).toContain(`**truncated:** ${more}`);
      if (next !== undefined) expect(text).toContain(`**nextOffset:** ${next}`);
      else expect(text).not.toContain('**nextOffset:**');
      if (offset === 4) expect(data.notice).toContain('last page');
      if (offset >= 5) expect(data.notice).toContain('past the last');
      if (offset === 2)
        expect(data.rows.map((row) => row.geography_geoid)).toEqual(['53003', '53004']);
    },
  );

  it('returns enriched rows for a valid query', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'King County, Washington',
        geographyFips: '033',
        geographyGeoid: '53033',
        variables: {
          B19013_001E: { estimate: 105000, suppressed: false },
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
          B19013_001E: { estimate: 105000, suppressed: false },
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
          B01001_001E: { estimate: 39000000, suppressed: false },
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

  /**
   * The Census API caps `get=` at 50 columns and every query sends NAME, so 50 codes is 51
   * columns — rejected upstream as an untyped 400 before the cap counted NAME.
   */
  it('throws too_many_variables for 50 codes, naming 49 as the maximum', async () => {
    const ctx = createMockContext({ errors: censusQueryData.errors });
    const manyVars = Array.from({ length: 50 }, (_, i) => `B19013_${String(i).padStart(3, '0')}E`);
    const input = censusQueryData.input.parse({
      variables: manyVars,
      geography_level: 'state',
      geography_fips: '06',
    });
    await expect(censusQueryData.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'too_many_variables', requested: 50, maxVariables: 49 },
    });
    expect(mockQueryData).not.toHaveBeenCalled();
  });

  it('passes countyFips to apiService for tract-level queries', async () => {
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
          B19013_001E: { estimate: 105000, suppressed: false },
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

  it('parent_required for a ZCTA never says census_resolve_geography returns its state', async () => {
    mockCheckGeography.mockResolvedValue({ status: 'parent_required', missingParents: ['state'] });

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B01003_001E'],
      geography_level: 'zip code tabulation area',
      geography_fips: '98109',
      year: 2019,
    });
    const run = async () => censusQueryData.handler(input, ctx);
    const err = await run().catch((e: unknown) => e);
    const { data } = err as { data: { reason: string; recovery: { hint: string } } };

    expect(data.reason).toBe('parent_required');
    expect(data.recovery.hint).toContain('parent_fips');
    expect(data.recovery.hint).not.toContain('returns it as state_fips');
    expect(data.recovery.hint).toContain('no state_fips');
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
      missingParents: ['county subdivision'],
      wildcardRelaxes: true,
    });

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'subminor civil division',
      geography_fips: '12345',
      parent_fips: '72',
      county_fips: '127',
    });
    await expect(censusQueryData.handler(input, ctx)).rejects.toMatchObject({
      data: { recovery: { hint: expect.stringContaining('geography_fips to "*"') } },
    });
  });

  it('parent_required names tract_fips, not the wildcard, for a single block group', async () => {
    mockCheckGeography.mockResolvedValue({
      status: 'parent_required',
      missingParents: ['tract'],
      wildcardRelaxes: true,
    });

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'block group',
      geography_fips: '2',
      parent_fips: '53',
      county_fips: '033',
    });
    const err = await failureOf(input, ctx);
    const hint = (err as { data: { recovery: { hint: string } } }).data.recovery.hint;

    expect(hint).toContain('add tract_fips');
    expect(hint).toContain('census_resolve_geography');
    expect(hint).not.toContain('"*"');
    expect(mockQueryData).not.toHaveBeenCalled();
  });

  it('parent_required asks for a concrete county when county_fips is "*" under a tract', async () => {
    mockCheckGeography.mockResolvedValue({
      status: 'parent_required',
      missingParents: ['county'],
      wildcardRelaxes: false,
    });

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'block group',
      geography_fips: '2',
      parent_fips: '53',
      county_fips: '*',
      tract_fips: '007101',
    });
    const err = await failureOf(input, ctx);
    const hint = (err as { data: { recovery: { hint: string } } }).data.recovery.hint;

    expect(hint).toContain('county_fips');
    expect(hint).toContain('instead of "*"');
    expect(mockQueryData).not.toHaveBeenCalled();
  });

  it('passes tract_fips to the geography check and the data query, unpadded', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'Block Group 2; Census Tract 71.01; King County; Washington',
        geographyFips: '2',
        geographyGeoid: '530330071012',
        variables: { B19013_001E: { estimate: 136034, suppressed: false } },
      },
    ]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'block group',
      geography_fips: '2',
      parent_fips: '53',
      county_fips: '033',
      tract_fips: '007101',
    });
    await censusQueryData.handler(input, ctx);

    expect(mockCheckGeography).toHaveBeenCalledWith(
      expect.objectContaining({ countyFips: '033', tractFips: '007101' }),
      expect.anything(),
    );
    expect(mockQueryData).toHaveBeenCalledWith(
      expect.objectContaining({ countyFips: '033', tractFips: '007101' }),
      expect.anything(),
    );
  });

  it('reads a blank tract_fips as omitted', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'King County, Washington',
        geographyFips: '033',
        geographyGeoid: '53033',
        variables: { B19013_001E: { estimate: 1, suppressed: false } },
      },
    ]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      geography_fips: '033',
      parent_fips: '53',
      tract_fips: '',
    });
    await censusQueryData.handler(input, ctx);

    expect(mockCheckGeography.mock.calls[0]?.[0]).not.toHaveProperty('tractFips');
    expect(mockQueryData.mock.calls[0]?.[0]).not.toHaveProperty('tractFips');
  });

  it.each(['007101', ''])('accepts tract_fips %j at the schema', (tract_fips) => {
    expect(
      censusQueryData.input.safeParse({
        variables: ['B19013_001E'],
        geography_level: 'block group',
        geography_fips: '2',
        tract_fips,
      }).success,
    ).toBe(true);
  });

  it.each(['*', '7101', '71.01', '0071011', ' 007101'])(
    'rejects tract_fips %j at the schema — a tract is exactly 6 digits',
    (tract_fips) => {
      expect(
        censusQueryData.input.safeParse({
          variables: ['B19013_001E'],
          geography_level: 'block group',
          geography_fips: '2',
          tract_fips,
        }).success,
      ).toBe(false);
    },
  );

  it('parent_not_accepted names tract_fips as the input to drop', async () => {
    mockCheckGeography.mockResolvedValue({
      status: 'parent_not_accepted',
      unacceptedParents: ['tract'],
      acceptedParents: ['state', 'county'],
    });

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'tract',
      geography_fips: '007101',
      parent_fips: '53',
      county_fips: '033',
      tract_fips: '007101',
    });
    const err = await failureOf(input, ctx);
    const hint = (err as { data: { recovery: { hint: string } } }).data.recovery.hint;

    expect(hint).toContain('Drop tract_fips');
    expect(hint).not.toContain('county_fips');
    expect(mockQueryData).not.toHaveBeenCalled();
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

  /**
   * A parent the level does not name builds an `in=` clause the Census API answers with an
   * untyped 400 carrying no reason and no recovery. The caller has to be told which of its own
   * inputs to drop, and the query must not be spent finding out.
   */
  it('throws parent_not_accepted naming parent_fips as the input to drop', async () => {
    mockCheckGeography.mockResolvedValue({
      status: 'parent_not_accepted',
      unacceptedParents: ['state'],
      acceptedParents: [],
    });

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'zip code tabulation area',
      geography_fips: '98101',
      parent_fips: '53',
    });
    await expect(censusQueryData.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'parent_not_accepted',
        unacceptedParents: ['state'],
        recovery: { hint: expect.stringContaining('Drop parent_fips') },
      },
    });
    expect(mockQueryData).not.toHaveBeenCalled();
  });

  it('parent_not_accepted names county_fips and the scope the level does take', async () => {
    mockCheckGeography.mockResolvedValue({
      status: 'parent_not_accepted',
      unacceptedParents: ['county'],
      acceptedParents: ['state'],
    });

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'place',
      geography_fips: '63000',
      parent_fips: '53',
      county_fips: '033',
    });
    await expect(censusQueryData.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'parent_not_accepted',
        acceptedParents: ['state'],
        recovery: { hint: expect.stringContaining('Drop county_fips') },
      },
    });
    expect(mockQueryData).not.toHaveBeenCalled();
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
      message: expect.stringContaining('Available levels: us, state, county.'),
      data: { reason: 'geography_not_supported', availableLevels: ['us', 'state', 'county'] },
    });
    expect(mockQueryData).not.toHaveBeenCalled();
  });

  it('names a long level list by count instead of spelling it out in the message', async () => {
    const availableLevels = Array.from({ length: 13 }, (_, i) => `level ${i}`);
    mockCheckGeography.mockResolvedValue({ status: 'level_not_supported', availableLevels });

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'tract',
      geography_fips: '*',
      parent_fips: '53',
      dataset: 'acs/acs1',
    });
    const error = await Promise.resolve(censusQueryData.handler(input, ctx)).catch(
      (e: unknown) => e,
    );
    // #62: census_list_geographies is the contract recovery's step, so the message leaves it out.
    expect((error as Error).message).toBe(
      'Geography level "tract" does not exist in acs/acs1 (2024). It publishes 13 geography levels.',
    );
    expect(error).toMatchObject({ data: { availableLevels } });
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
          B19013_001E: { estimate: 105000, suppressed: false },
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
            suppressed: true,
            suppressionReason: 'Estimate not computable: too few sample observations',
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
    expect(vars.B19013_001E?.suppression_reason).toContain('too few sample observations');
  });

  it('forwards predicates to the api service', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'King County, Washington',
        geographyFips: '033',
        geographyGeoid: '53033',
        variables: { ESTAB: { estimate: 577, suppressed: false } },
      },
    ]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['ESTAB'],
      geography_level: 'county',
      geography_fips: '033',
      parent_fips: '53',
      dataset: 'cbp',
      predicates: { NAICS2017: '5112' },
    });
    await censusQueryData.handler(input, ctx);

    expect(mockQueryData).toHaveBeenCalledWith(
      expect.objectContaining({ predicates: { NAICS2017: '5112' } }),
      expect.anything(),
    );
    expect(mockCheckPredicates).toHaveBeenCalledWith(
      expect.objectContaining({ dataset: 'cbp', supplied: ['NAICS2017'] }),
      expect.anything(),
    );
  });

  it('omits predicates from the api service call when none were supplied', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'California',
        geographyFips: '06',
        geographyGeoid: '06',
        variables: { B01001_001E: { estimate: 39000000, suppressed: false } },
      },
    ]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B01001_001E'],
      geography_level: 'state',
      geography_fips: '06',
    });
    await censusQueryData.handler(input, ctx);

    expect(mockQueryData.mock.calls[0]?.[0]).not.toHaveProperty('predicates');
  });

  /**
   * The Census API answers a query that omits a required predicate with the aggregate across
   * that whole dimension, not an error — so the notice is the only signal that the number
   * answers a broader question than the one asked.
   */
  it('warns that unset filter dimensions leave the values scoped by an API default', async () => {
    mockCheckPredicates.mockResolvedValue({
      unset: [
        { code: 'LFO', label: 'Legal form of organization code' },
        { code: 'NAICS2017', label: '2017 NAICS code' },
      ],
      unknown: [],
    });
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'King County, Washington',
        geographyFips: '033',
        geographyGeoid: '53033',
        variables: { ESTAB: { estimate: 70376, suppressed: false } },
      },
    ]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['ESTAB'],
      geography_level: 'county',
      geography_fips: '033',
      parent_fips: '53',
      dataset: 'cbp',
    });
    await censusQueryData.handler(input, ctx);

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('NAICS2017 (2017 NAICS code)');
    expect(notice).toContain('LFO (Legal form of organization code)');
    expect(notice).toContain('applied its own default');
  });

  it('emits no notice when every filter dimension is set', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'King County, Washington',
        geographyFips: '033',
        geographyGeoid: '53033',
        variables: { ESTAB: { estimate: 577, suppressed: false } },
      },
    ]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['ESTAB'],
      geography_level: 'county',
      geography_fips: '033',
      parent_fips: '53',
      dataset: 'cbp',
      predicates: { NAICS2017: '5112' },
    });
    await censusQueryData.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('throws predicate_not_supported before querying for an unrecognized predicate key', async () => {
    mockCheckPredicates.mockResolvedValue({ unset: [], unknown: ['BOGUSKEY'] });

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['ESTAB'],
      geography_level: 'county',
      geography_fips: '033',
      parent_fips: '53',
      dataset: 'cbp',
      predicates: { BOGUSKEY: '1' },
    });
    await expect(censusQueryData.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'predicate_not_supported', unknownPredicates: ['BOGUSKEY'] },
    });
    expect(mockQueryData).not.toHaveBeenCalled();
  });

  /**
   * ecnbasic publishes nothing below the national level until an industry is named, so an
   * empty result there is a missing predicate rather than a bad FIPS code.
   */
  it('no_data recovery names the unset predicates when the dataset has any', async () => {
    mockCheckPredicates.mockResolvedValue({
      unset: [{ code: 'NAICS2022', label: '2022 NAICS code' }],
      unknown: [],
    });
    mockQueryData.mockResolvedValue([]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['ESTAB'],
      geography_level: 'county',
      geography_fips: '033',
      parent_fips: '53',
      dataset: 'cbp',
    });
    await expect(censusQueryData.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'no_data',
        recovery: { hint: expect.stringContaining('NAICS2022') },
      },
    });
  });

  /**
   * The Census API answers an unknown predicate *value* with 204, not 400, so a fully-predicated
   * query that comes back empty is as likely a bad value as a bad FIPS code.
   */
  it('no_data recovery points at the supplied predicate values as well', async () => {
    mockCheckPredicates.mockResolvedValue({ unset: [], unknown: [] });
    mockQueryData.mockResolvedValue([]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['ESTAB'],
      geography_level: 'county',
      geography_fips: '033',
      parent_fips: '53',
      dataset: 'cbp',
      predicates: { NAICS2017: 'ZZZZ' },
    });
    await expect(censusQueryData.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'no_data',
        recovery: { hint: expect.stringContaining('NAICS2017 value') },
      },
    });
  });

  /**
   * The Census API matches FIPS literally, so `in=state:5` is a query that finds nothing while
   * `in=state:05` returns Arkansas. census_resolve_geography already pads the codes it hands
   * back; a caller who types the short form got a `no_data` blaming its geography codes.
   */
  it('pads a short state FIPS to the width the Census API matches on', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'Garland County, Arkansas',
        geographyFips: '051',
        geographyGeoid: '05051',
        variables: { B19013_001E: { estimate: 55409, suppressed: false } },
      },
    ]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      geography_fips: '051',
      parent_fips: '5',
    });
    const result = await censusQueryData.handler(input, ctx);

    expect(mockQueryData).toHaveBeenCalledWith(
      expect.objectContaining({ parentFips: '05' }),
      expect.anything(),
    );
    expect(result.rows[0]?.geography_name).toBe('Garland County, Arkansas');
  });

  it('pads a short county FIPS to three digits', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'Census Tract 1, Garland County, Arkansas',
        geographyFips: '000100',
        geographyGeoid: '05051000100',
        variables: { B19013_001E: { estimate: 48000, suppressed: false } },
      },
    ]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'tract',
      geography_fips: '000100',
      parent_fips: '05',
      county_fips: '51',
    });
    await censusQueryData.handler(input, ctx);

    expect(mockQueryData).toHaveBeenCalledWith(
      expect.objectContaining({ countyFips: '051' }),
      expect.anything(),
    );
  });

  it('reads a blank parent as omitted rather than padding it to zeros', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'California',
        geographyFips: '06',
        geographyGeoid: '06',
        variables: { B01001_001E: { estimate: 39000000, suppressed: false } },
      },
    ]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B01001_001E'],
      geography_level: 'state',
      geography_fips: '06',
      parent_fips: '',
    });
    await censusQueryData.handler(input, ctx);

    expect(mockQueryData.mock.calls[0]?.[0]).not.toHaveProperty('parentFips');
  });

  /**
   * `in=state:53 county:*` is the only hierarchy the Census API answers for every block group in
   * a state — omitting county_fips is a 400, and a padded `00*` matches no county. So `*` has to
   * clear the schema and reach the API as itself.
   */
  it('accepts a wildcard parent scope and sends it unpadded', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'Block Group 1; Census Tract 9501; Adams County; Washington',
        geographyFips: '1',
        geographyGeoid: '5300195010011',
        variables: { B01003_001E: { estimate: 832, suppressed: false } },
      },
    ]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B01003_001E'],
      geography_level: 'block group',
      geography_fips: '*',
      parent_fips: '53',
      county_fips: '*',
    });
    await censusQueryData.handler(input, ctx);

    expect(mockQueryData).toHaveBeenCalledWith(
      expect.objectContaining({ parentFips: '53', countyFips: '*' }),
      expect.anything(),
    );
  });

  it('rejects a non-numeric parent at the schema boundary', () => {
    expect(
      censusQueryData.input.safeParse({
        variables: ['B19013_001E'],
        geography_level: 'county',
        geography_fips: '051',
        parent_fips: 'WA',
      }).success,
    ).toBe(false);
    expect(
      censusQueryData.input.safeParse({
        variables: ['B19013_001E'],
        geography_level: 'tract',
        geography_fips: '000100',
        parent_fips: '05',
        county_fips: '0510',
      }).success,
    ).toBe(false);
  });

  /**
   * geography_fips takes its width from geography_level and also accepts `*`, so it has no
   * single width to pad to and is passed through exactly as given.
   */
  it('passes geography_fips through unpadded', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'Somewhere',
        geographyFips: '51',
        geographyGeoid: '0551',
        variables: { B19013_001E: { estimate: 1, suppressed: false } },
      },
    ]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      geography_fips: '51',
      parent_fips: '05',
    });
    await censusQueryData.handler(input, ctx);

    expect(mockQueryData).toHaveBeenCalledWith(
      expect.objectContaining({ geographyFips: '51' }),
      expect.anything(),
    );
  });

  it('no_data recovery names the literal FIPS width instead of only doubting the codes', async () => {
    mockQueryData.mockResolvedValue([]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B19013_001E'],
      geography_level: 'county',
      geography_fips: '51',
      parent_fips: '05',
    });
    await expect(censusQueryData.handler(input, ctx)).rejects.toMatchObject({
      data: { recovery: { hint: expect.stringContaining('"051", not "51"') } },
    });
  });

  /**
   * dec/ddhca answers a query that omits POPGROUP with one population group's count rather than
   * a total, and no POPGROUP code means "all groups". The applied label is the only thing that
   * keeps 9,653,100 from reading as California's population.
   */
  it('requests the label attribute of each unset dimension and echoes it per row', async () => {
    mockCheckPredicates.mockResolvedValue({
      unset: [{ code: 'POPGROUP', label: 'Race/Ethnic Group', labelAttribute: 'POPGROUP_LABEL' }],
      unknown: [],
    });
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'California',
        geographyFips: '06',
        geographyGeoid: '06',
        variables: { T01001_001N: { estimate: 9653100, suppressed: false } },
        appliedFilters: { POPGROUP: 'European alone' },
      },
    ]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['T01001_001N'],
      geography_level: 'state',
      geography_fips: '06',
      dataset: 'dec/ddhca',
    });
    const result = await censusQueryData.handler(input, ctx);

    expect(mockQueryData).toHaveBeenCalledWith(
      expect.objectContaining({ defaultLabelColumns: { POPGROUP: 'POPGROUP_LABEL' } }),
      expect.anything(),
    );
    expect(result.rows[0]?.applied_filters).toEqual({ POPGROUP: 'European alone' });
    expect(getEnrichment(ctx).notice).toContain('"European alone"');
  });

  it('asks for no label column for a dimension that publishes none', async () => {
    mockCheckPredicates.mockResolvedValue({
      unset: [{ code: 'YEAR', label: 'Vintage Year' }],
      unknown: [],
    });
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'Washington',
        geographyFips: '53',
        geographyGeoid: '53',
        variables: { POP: { estimate: 7705267, suppressed: false } },
      },
    ]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['POP'],
      geography_level: 'state',
      geography_fips: '53',
    });
    const result = await censusQueryData.handler(input, ctx);

    expect(mockQueryData.mock.calls[0]?.[0]).not.toHaveProperty('defaultLabelColumns');
    expect(result.rows[0]?.applied_filters).toBeUndefined();
  });

  it('format shows the applied filter defaults beside the value', () => {
    const output = {
      variable_labels: { T01001_001N: 'Total population' },
      rows: [
        {
          geography_name: 'California',
          geography_fips: '06',
          geography_geoid: '06',
          variables: {
            T01001_001N: { estimate: 9653100, suppressed: false },
          },
          applied_filters: { POPGROUP: 'European alone' },
        },
      ],
    };
    const blocks = censusQueryData.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('POPGROUP = European alone');
  });

  it('formats output with geography names, FIPS, and variable values', () => {
    const output = {
      variable_labels: { B19013_001E: 'Median household income' },
      rows: [
        {
          geography_name: 'King County, Washington',
          geography_fips: '033',
          geography_geoid: '53033',
          variables: {
            B19013_001E: {
              estimate: 105000,
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
      variable_labels: { B19013_001E: 'Median household income' },
      rows: [
        {
          geography_name: 'Tiny Town',
          geography_fips: '999',
          geography_geoid: '53999',
          variables: {
            B19013_001E: {
              estimate: null,
              suppressed: true,
              suppression_reason: 'Cannot be displayed: too few sample cases in this geography',
            },
          },
        },
      ],
    };
    const blocks = censusQueryData.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain(
      '**B19013_001E:** Suppressed (Cannot be displayed: too few sample cases in this geography)',
    );
  });

  /**
   * The check has to sit ahead of the geography check, which is the handler's first request —
   * a year the dataset does not serve has no geography metadata either, so leaving the check
   * downstream spends a round trip and reports the wrong problem. Nothing here is stubbed to
   * reject: the refusal has to come from the handler calling validateYear itself.
   */
  it('refuses a year the dataset does not serve before any request goes out', async () => {
    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['POP'],
      geography_level: 'state',
      geography_fips: '53',
      dataset: 'pep/charv',
      year: 2021,
    });

    await expect(censusQueryData.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'year_not_available',
        availableYears: [2023],
        recovery: { hint: expect.stringContaining('2023') },
      },
    });
    expect(mockCheckGeography).not.toHaveBeenCalled();
    expect(mockCheckPredicates).not.toHaveBeenCalled();
    expect(mockQueryData).not.toHaveBeenCalled();
  });

  /**
   * cbp does publish a 2009 vintage; it rejects the NAME column every query here sends. Saying
   * the dataset has no such vintage would be false, so the message says it cannot be queried.
   */
  it('words the refusal for a vintage that exists upstream but cannot be queried', async () => {
    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['ESTAB'],
      geography_level: 'state',
      geography_fips: '53',
      dataset: 'cbp',
      year: 2009,
    });

    const error = await Promise.resolve(censusQueryData.handler(input, ctx)).then(
      () => undefined,
      (err: Error) => err,
    );

    expect(error?.message).toBe('cbp cannot be queried for 2009.');
    expect(error?.message).not.toMatch(/has no 2009 vintage|does not publish/);
    // #62: the years to retry with are the hint's, stated once.
    expect(error).toMatchObject({
      data: { recovery: { hint: 'Retry with a year this dataset serves: 2012-2023.' } },
    });
  });

  /**
   * A text column reached the caller as `estimate: null` with `suppressed: false`, which is what a
   * geography with no value looks like — so the text was both lost and unreadable as text.
   */
  it('carries a text value through to the caller alongside the numeric ones', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'King County, Washington',
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

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const input = censusQueryData.input.parse({
      variables: ['B19013_001E', 'GEO_ID'],
      geography_level: 'county',
      geography_fips: '033',
      parent_fips: '53',
    });
    const result = await censusQueryData.handler(input, ctx);

    const variables = result.rows[0]?.variables as Record<
      string,
      { estimate: number | null; suppressed: boolean; value?: string }
    >;
    expect(variables.GEO_ID?.value).toBe('0500000US53033');
    expect(variables.GEO_ID?.suppressed).toBe(false);
    // The three ways an estimate can be null stay distinguishable from one another.
    expect(variables.B19013_001E?.value).toBeUndefined();
    expect(variables.B19013_001E?.estimate).toBe(122148);
  });

  it('format renders a text value rather than the N/A a missing one gets', () => {
    const output = {
      variable_labels: { GEO_ID: 'Geography', B19013_001M: 'Margin of error' },
      rows: [
        {
          geography_name: 'King County, Washington',
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
        },
      ],
    };

    const blocks = censusQueryData.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;

    expect(text).toContain('**GEO_ID:** 0500000US53033');
    // The column with nothing in it still reads as nothing.
    expect(text).toContain('**B19013_001M:** N/A');
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
          B01001_001E: { estimate: 4900000, suppressed: false },
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

  /** A row used to label such a code with the code itself, a label that says nothing. */
  it('gives a code the variable cache has no entry for no label at all', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'Oregon',
        geographyFips: '41',
        geographyGeoid: '41',
        variables: {
          B01001_001E: { estimate: 4200000, suppressed: false },
        },
      },
    ]);

    const result = await runToolContract(censusQueryData, {
      variables: ['B01001_001E'],
      geography_level: 'state',
      geography_fips: '41',
    });
    const data = result.structuredContent as {
      variable_labels: Record<string, string>;
      rows: Array<{ variables: Record<string, object> }>;
    };
    expect(data.variable_labels).toEqual({});
    expect(data.rows[0]?.variables.B01001_001E).not.toHaveProperty('label');
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

    const result = await runToolContract(censusQueryData, {
      variables: ['B19013_001E', 'B19013_001M', 'B19013_001EA'],
      geography_level: 'county',
      geography_fips: '*',
      parent_fips: '53',
    });
    const data = result.structuredContent as {
      variable_labels: Record<string, string>;
      rows: Array<{ variables: Record<string, object> }>;
    };

    expect(data.variable_labels).toEqual(labels);
    expect(Object.keys(data.variable_labels)).toEqual(['B19013_001E', 'B19013_001M']);
    expect(data.rows).toHaveLength(2);
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

      const result = await runToolContract(censusQueryData, {
        variables: ['B01003_001E'],
        geography_level: 'county',
        geography_fips: '*',
        parent_fips: '53',
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
        geographyName: 'Washington',
        geographyFips: '53',
        geographyGeoid: '53',
        variables: {
          B19083_001E: { estimate: 0.4691, moe: 0.0018, suppressed: false },
          B19083_001M: { estimate: 0.0018, suppressed: false },
        },
      },
    ]);

    const result = await runToolContract(censusQueryData, {
      variables: ['B19083_001E', 'B19083_001M'],
      geography_level: 'state',
      geography_fips: '53',
    });
    const data = result.structuredContent as {
      rows: Array<{ variables: Record<string, { estimate: number; moe?: number }> }>;
    };

    expect(data.rows[0]?.variables.B19083_001E).toMatchObject({ estimate: 0.4691, moe: 0.0018 });
    expect(data.rows[0]?.variables.B19083_001M).toMatchObject({ estimate: 0.0018 });
    const text = textOf(result);
    expect(text).toContain('- **B19083_001E:** 0.4691 ± 0.0018\n');
    expect(text).toContain('- **B19083_001M:** 0.0018\n');
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
      variable_labels: { B19013_001E: 'Median income' },
      rows: [
        {
          geography_name: 'Oregon',
          geography_fips: '41',
          geography_geoid: '41',
          variables: {
            B19013_001E: {
              estimate: 75000,
              moe: 300,
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
      variable_labels: { B19013_001E: 'Median income' },
      rows: [
        {
          geography_name: 'Oregon',
          geography_fips: '41',
          geography_geoid: '41',
          variables: {
            B19013_001E: {
              estimate: 75000,
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

  it('accepts 49 variables, the most NAME leaves room for — boundary accepted', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'State X',
        geographyFips: '01',
        geographyGeoid: '01',
        variables: Object.fromEntries(
          Array.from({ length: 49 }, (_, i) => [
            `B${String(i).padStart(7, '0')}E`,
            { estimate: i, suppressed: false },
          ]),
        ),
      },
    ]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const vars49 = Array.from({ length: 49 }, (_, i) => `B${String(i).padStart(7, '0')}E`);
    const input = censusQueryData.input.parse({
      variables: vars49,
      geography_level: 'state',
      geography_fips: '01',
    });
    const result = await censusQueryData.handler(input, ctx);
    expect(result.rows).toHaveLength(1);
  });

  it('format handles multiple rows correctly', () => {
    const output = {
      variable_labels: { B19013_001E: 'Median income' },
      rows: [
        {
          geography_name: 'King County',
          geography_fips: '033',
          geography_geoid: '53033',
          variables: {
            B19013_001E: { estimate: 105000, suppressed: false },
          },
        },
        {
          geography_name: 'Pierce County',
          geography_fips: '053',
          geography_geoid: '53053',
          variables: {
            B19013_001E: { estimate: 72000, suppressed: false },
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

/**
 * `pep/charv` publishes an April estimates base and a July estimate for every geography, so a
 * query that pins neither answers with two rows sharing a GEOID, the same applied_filters, and
 * different numbers. Which one a caller is reading has to be on the row.
 */
describe('censusQueryData — datasets that publish several records per geography', () => {
  const charvRows = [
    {
      geographyName: 'Washington',
      geographyFips: '53',
      geographyGeoid: '53',
      variables: { POP: { estimate: 7705267, suppressed: false } },
      appliedFilters: { POPGROUP: 'Total population' },
      record: { MONTH: { code: '4', label: 'April' } },
    },
    {
      geographyName: 'Washington',
      geographyFips: '53',
      geographyGeoid: '53',
      variables: { POP: { estimate: 7724566, suppressed: false } },
      appliedFilters: { POPGROUP: 'Total population' },
      record: { MONTH: { code: '7', label: 'July' } },
    },
  ];

  const charvInput = (overrides: Record<string, unknown> = {}) =>
    censusQueryData.input.parse({
      variables: ['POP'],
      geography_level: 'state',
      geography_fips: '53',
      dataset: 'pep/charv',
      ...overrides,
    });

  beforeEach(() => {
    mockGetRecordDimensions.mockResolvedValue([
      { code: 'MONTH', label: 'Vintage Month', labelAttribute: 'MONTH_DESC' },
    ]);
  });

  it('carries the record on every row so the two are not interchangeable', async () => {
    mockQueryData.mockResolvedValue(charvRows);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    const result = await censusQueryData.handler(charvInput(), ctx);

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.record).toEqual({ MONTH: { code: '4', label: 'April' } });
    expect(result.rows[1]?.record).toEqual({ MONTH: { code: '7', label: 'July' } });
    expect(mockQueryData).toHaveBeenCalledWith(
      expect.objectContaining({ recordColumns: { MONTH: 'MONTH_DESC' } }),
      expect.anything(),
    );
  });

  /**
   * Reading the first row as the answer is the failure. The notice has to say a choice is being
   * made, name what separates the rows, and give the value that pins one.
   */
  it('warns that a geography came back twice and names what pins one record', async () => {
    mockQueryData.mockResolvedValue(charvRows);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    await censusQueryData.handler(charvInput(), ctx);

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('came back on 2 rows');
    expect(notice).toContain('MONTH');
    expect(notice).toContain('"4" (April)');
    expect(notice).toContain('"7" (July)');
    expect(notice).toContain('{"MONTH": "7"}');
  });

  it('drops the warning once the record is pinned', async () => {
    mockQueryData.mockResolvedValue([charvRows[1]]);

    const ctx = createMockContext({ errors: censusQueryData.errors });
    await censusQueryData.handler(charvInput({ predicates: { MONTH: '7' } }), ctx);

    expect(getEnrichment(ctx).notice ?? '').not.toContain('came back on');
  });

  /**
   * Claude Desktop reads content[] rather than structuredContent, so a heading that repeats the
   * geography name with a different number under it is the same ambiguity in the other surface.
   */
  it('format separates the two rows in the rendered text', () => {
    const blocks = censusQueryData.format!({
      variable_labels: { POP: 'Total population' },
      rows: charvRows.map((row) => ({
        geography_name: row.geographyName,
        geography_fips: row.geographyFips,
        geography_geoid: row.geographyGeoid,
        variables: row.variables,
        applied_filters: row.appliedFilters,
        record: row.record,
      })),
    });
    const text = (blocks[0] as { type: string; text: string }).text;

    expect(text).toContain('Washington — MONTH 4 (April)');
    expect(text).toContain('Washington — MONTH 7 (July)');
  });
});

describe('censusQueryData — a whole table through group (#88)', () => {
  /** Two lines of B01001 as the variable cache lays out `group(B01001)`. */
  const b01001 = {
    id: 'B01001',
    columns: [
      'B01001_001E',
      'B01001_001EA',
      'B01001_001M',
      'B01001_001MA',
      'B01001_002E',
      'B01001_002EA',
      'B01001_002M',
      'B01001_002MA',
      'GEO_ID',
      'NAME',
    ],
  };
  const labels = {
    B19013_001E: 'Estimate!!Median household income',
    B01001_001E: 'Estimate!!Total:',
    B01001_001M: 'Margin of Error!!Total:',
    B01001_002E: 'Estimate!!Total:!!Male:',
    B01001_002M: 'Margin of Error!!Total:!!Male:',
  };
  const king = {
    geographyName: 'King County, Washington',
    geographyFips: '033',
    geographyGeoid: '53033',
    variables: {
      B19013_001E: { estimate: 122148, suppressed: false },
      B01001_001E: { estimate: 2287171, moe: 0, suppressed: false },
      B01001_001M: { estimate: 0, suppressed: false },
      B01001_002E: { estimate: 1140843, moe: 1234, suppressed: false },
      B01001_002M: { estimate: 1234, suppressed: false },
    },
  };
  const atKing = { geography_level: 'county', geography_fips: '033', parent_fips: '53' };

  beforeEach(() => {
    mockResolveGroup.mockResolvedValue(b01001);
    mockLookupVariables.mockImplementation(
      async (codes: string[]) =>
        new Map(
          codes.flatMap((code) => {
            const label = labels[code as keyof typeof labels];
            return label ? [[code, { code, label, predicateType: 'int' }]] : [];
          }),
        ),
    );
    mockQueryData.mockResolvedValue([king]);
  });

  it('resolves the table, sends it beside the codes, and labels every column it keys', async () => {
    const result = await runToolContract(censusQueryData, {
      ...atKing,
      variables: ['B19013_001E', 'B01001_001E'],
      group: ' b01001 ',
    });

    expect(mockResolveGroup).toHaveBeenCalledWith('B01001', 'acs/acs5', 2024, expect.anything());
    expect(mockQueryData).toHaveBeenCalledWith(
      expect.objectContaining({ variables: ['B19013_001E', 'B01001_001E'], group: b01001 }),
      expect.anything(),
    );
    const data = result.structuredContent as {
      variable_labels: Record<string, string>;
      rows: Array<{ variables: Record<string, unknown> }>;
    };
    expect(Object.keys(data.variable_labels)).toEqual([
      'B19013_001E',
      'B01001_001E',
      'B01001_001M',
      'B01001_002E',
      'B01001_002M',
    ]);
    expect(data.variable_labels).toEqual(labels);
    expect(readVariableLabels(textOf(result))).toEqual(labels);
    const text = textOf(result);
    expect(text).toContain('**B01001_002E:** 1,140,843 ± 1,234');
    expect(text).toContain('**B01001_002M:** 1,234');
  });

  /** Sent as a code, `group(B01001)` went out uppercased as `GROUP(B01001)`, which answers 204. */
  it('reads a group(<ID>) entry of variables, in any case, as the group input', async () => {
    await runToolContract(censusQueryData, { ...atKing, variables: ['Group( b01001 )'] });

    expect(mockResolveGroup).toHaveBeenCalledWith('B01001', 'acs/acs5', 2024, expect.anything());
    expect(mockQueryData).toHaveBeenCalledWith(
      expect.objectContaining({ variables: [], group: b01001 }),
      expect.anything(),
    );
  });

  it('accepts the same table named both ways', async () => {
    const result = await runToolContract(censusQueryData, {
      ...atKing,
      variables: ['group(B01001)'],
      group: 'b01001',
    });

    expect(result.isError).toBeFalsy();
    expect(mockResolveGroup).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['group and an entry', { variables: ['group(B19013)'], group: 'B01001' }],
    ['two entries', { variables: ['group(B01001)', 'B01003_001E', 'group(b19013)'] }],
  ])('refuses two tables, %s, before any request', async (_label, tables) => {
    const result = await runToolContract(censusQueryData, { ...atKing, ...tables });

    expect(result.isError).toBe(true);
    const error = (
      result.structuredContent as {
        error: { code: number; message: string; data: Record<string, unknown> };
      }
    ).error;
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data.reason).toBe('multiple_groups');
    expect(error.data.groups).toEqual(['B01001', 'B19013']);
    expect(error.message).toBe(
      'B01001 and B19013 are 2 different tables, and the Census API returns one table per request.',
    );
    expect(textOf(result)).toContain('Keep B01001 in group and query B19013 in a second call');
    expect(mockCheckGeography).not.toHaveBeenCalled();
    expect(mockQueryData).not.toHaveBeenCalled();
  });

  it.each([
    ['neither', {}],
    ['a blank group and blank codes', { variables: ['  '], group: ' ' }],
    ['an empty group() entry', { variables: ['group()'] }],
  ])('requires a code or a table — %s', async (_label, given) => {
    const result = await runToolContract(censusQueryData, { ...atKing, ...given });

    expect(result.isError).toBe(true);
    const error = (
      result.structuredContent as { error: { code: number; data: Record<string, unknown> } }
    ).error;
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data.reason).toBe('variables_or_group_required');
    expect(mockCheckGeography).not.toHaveBeenCalled();
  });

  it.each([
    [
      'filter dimensions',
      { filterDimensions: ['EMPSZES', 'LFO', 'NAICS2017'], unset: [], unknown: [] },
      [],
      'EMPSZES, LFO, NAICS2017',
    ],
    [
      'a record dimension',
      { filterDimensions: [], unset: [], unknown: [] },
      [{ code: 'MONTH', label: 'Vintage Month', labelAttribute: 'MONTH_DESC' }],
      'MONTH',
    ],
  ])(
    'refuses group on a dataset with %s before the data request',
    async (_label, predicateCheck, recordDimensions, named) => {
      mockCheckPredicates.mockResolvedValue(predicateCheck);
      mockGetRecordDimensions.mockResolvedValue(recordDimensions);

      const result = await runToolContract(censusQueryData, {
        ...atKing,
        dataset: 'cbp',
        group: 'cb2300cbp',
      });

      expect(result.isError).toBe(true);
      const error = (
        result.structuredContent as {
          error: { code: number; message: string; data: Record<string, unknown> };
        }
      ).error;
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('group_not_supported');
      expect(error.message).toContain(`carry the ${named} dimension`);
      expect(error.data.recovery).toEqual({
        hint: 'List the codes you need from CB2300CBP in variables instead (census_search_variables with CB2300CBP as the query returns them), and pick a category in predicates where the default is not the one wanted.',
      });
      // The table ID is a value to send back, so content[] carries it as a code span.
      expect(textOf(result)).toContain(
        'Recovery: List the codes you need from `CB2300CBP` in variables instead (census_search_variables with `CB2300CBP` as the query returns them)',
      );
      expect(mockResolveGroup).not.toHaveBeenCalled();
      expect(mockQueryData).not.toHaveBeenCalled();
    },
  );

  it('fits 49 codes beside the table and refuses the 50th before the data request', async () => {
    const codes = (n: number) =>
      Array.from({ length: n }, (_, i) => `B19001_${String(i + 1).padStart(3, '0')}E`);

    const fits = await runToolContract(censusQueryData, {
      ...atKing,
      variables: codes(49),
      group: 'B01001',
    });
    expect(fits.isError).toBeFalsy();

    mockQueryData.mockClear();
    const over = await runToolContract(censusQueryData, {
      ...atKing,
      variables: [...codes(50), 'B01001_002M'],
      group: 'B01001',
    });
    const error = (
      over.structuredContent as { error: { data: Record<string, unknown>; message: string } }
    ).error;
    expect(error.data).toMatchObject({
      reason: 'too_many_variables',
      requested: 50,
      maxVariables: 49,
      recovery: {
        hint: 'Keep at most 49 codes beside the table and query the rest in a second call.',
      },
    });
    expect(error.message).toContain('50 variable codes requested beside table B01001');
    expect(mockQueryData).not.toHaveBeenCalled();
  });
});
