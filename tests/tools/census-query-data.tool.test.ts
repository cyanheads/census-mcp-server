/**
 * @fileoverview Tests for census_query_data tool.
 * @module tests/tools/census-query-data.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { censusQueryData } from '@/mcp-server/tools/definitions/census-query-data.tool.js';
import { yearNotAvailable } from '@/services/census-api/errors.js';
import { DATASET_AVAILABLE_YEARS } from '@/services/variable-cache/variable-cache-service.js';

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

const mockQueryData = vi.fn();
const mockCheckGeography = vi.fn();
const mockGetVariablesByCode = vi.fn();
const mockCheckPredicates = vi.fn();
const mockGetRecordDimensions = vi.fn();
const mockValidateYear = vi.fn();

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
    getRecordDimensions: mockGetRecordDimensions,
    validateYear: mockValidateYear,
  } as never);

  /**
   * The real check, not a stub: a test that asserts the year is refused before the first
   * request is only meaningful if the mock refuses the same years the service does.
   */
  mockValidateYear.mockImplementation((dataset: string, year: number) => {
    const years = DATASET_AVAILABLE_YEARS[dataset];
    if (years && !years.includes(year)) throw yearNotAvailable(dataset, year, years);
  });

  // Default: the dataset declares no filter dimensions, so nothing is unset or unknown.
  mockCheckPredicates.mockResolvedValue({ unset: [], unknown: [] });

  // Default: the dataset publishes one row per geography, so nothing separates records.
  mockGetRecordDimensions.mockResolvedValue([]);

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

  it('forwards predicates to the api service', async () => {
    mockQueryData.mockResolvedValue([
      {
        geographyName: 'King County, Washington',
        geographyFips: '033',
        geographyGeoid: '53033',
        variables: { ESTAB: { estimate: 577, label: 'ESTAB', suppressed: false } },
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
        variables: { B01001_001E: { estimate: 39000000, label: 'B01001_001E', suppressed: false } },
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
        variables: { ESTAB: { estimate: 70376, label: 'ESTAB', suppressed: false } },
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
        variables: { ESTAB: { estimate: 577, label: 'ESTAB', suppressed: false } },
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
        variables: { B19013_001E: { estimate: 55409, label: 'B19013_001E', suppressed: false } },
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
        variables: { B19013_001E: { estimate: 48000, label: 'B19013_001E', suppressed: false } },
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
        variables: { B01001_001E: { estimate: 39000000, label: 'B01001_001E', suppressed: false } },
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
        variables: { B01003_001E: { estimate: 832, label: 'B01003_001E', suppressed: false } },
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
        variables: { B19013_001E: { estimate: 1, label: 'B19013_001E', suppressed: false } },
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
        variables: { T01001_001N: { estimate: 9653100, label: 'T01001_001N', suppressed: false } },
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
        variables: { POP: { estimate: 7705267, label: 'POP', suppressed: false } },
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
      rows: [
        {
          geography_name: 'California',
          geography_fips: '06',
          geography_geoid: '06',
          variables: {
            T01001_001N: { estimate: 9653100, label: 'Total population', suppressed: false },
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

    const error = await censusQueryData.handler(input, ctx).then(
      () => undefined,
      (err: Error) => err,
    );

    expect(error?.message).toContain('cbp cannot be queried for 2009');
    expect(error?.message).toContain('2012-2023');
    expect(error?.message).not.toMatch(/has no 2009 vintage|does not publish/);
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
          B19013_001E: { estimate: 122148, label: 'B19013_001E', suppressed: false },
          GEO_ID: {
            estimate: null,
            label: 'GEO_ID',
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
      rows: [
        {
          geography_name: 'King County, Washington',
          geography_fips: '033',
          geography_geoid: '53033',
          variables: {
            GEO_ID: {
              estimate: null,
              label: 'Geography',
              suppressed: false,
              value: '0500000US53033',
            },
            B19013_001M: { estimate: null, label: 'Margin of error', suppressed: false },
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
      checkPredicates: mockCheckPredicates,
      getRecordDimensions: mockGetRecordDimensions,
      validateYear: mockValidateYear,
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
      variables: { POP: { estimate: 7705267, label: 'POP', suppressed: false } },
      appliedFilters: { POPGROUP: 'Total population' },
      record: { MONTH: { code: '4', label: 'April' } },
    },
    {
      geographyName: 'Washington',
      geographyFips: '53',
      geographyGeoid: '53',
      variables: { POP: { estimate: 7724566, label: 'POP', suppressed: false } },
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
