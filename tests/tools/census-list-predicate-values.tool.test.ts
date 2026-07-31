/**
 * @fileoverview Tests for census_list_predicate_values tool — the two routes a dimension's
 * codes can come from, and the completeness caveats each one carries.
 * @module tests/tools/census-list-predicate-values.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { censusListPredicateValues } from '@/mcp-server/tools/definitions/census-list-predicate-values.tool.js';

vi.mock('@/services/census-api/census-api-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/census-api/census-api-service.js')>()),
  getCensusApiService: vi.fn(),
}));

vi.mock('@/services/variable-cache/variable-cache-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/variable-cache/variable-cache-service.js')>()),
  DATASET_LATEST_YEARS: { cbp: 2023, ecnbasic: 2022, 'dec/ddhca': 2020 },
  KNOWN_DATASETS: new Set(['cbp', 'ecnbasic', 'dec/ddhca', 'acs/acs5']),
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

const mockFetchPredicateValues = vi.fn();
const mockFindVariable = vi.fn();
const mockGetFilterDimensions = vi.fn();

beforeEach(async () => {
  vi.clearAllMocks();

  const { getCensusApiService } = await import('@/services/census-api/census-api-service.js');
  vi.mocked(getCensusApiService).mockReturnValue({
    fetchPredicateValues: mockFetchPredicateValues,
  } as never);

  const { getVariableCacheService } = await import(
    '@/services/variable-cache/variable-cache-service.js'
  );
  vi.mocked(getVariableCacheService).mockReturnValue({
    findVariable: mockFindVariable,
    getFilterDimensions: mockGetFilterDimensions,
  } as never);

  mockGetFilterDimensions.mockResolvedValue([]);
});

/** EMPSZES is the shape of every dimension the Census publishes no value list for. */
const empszes = {
  code: 'EMPSZES',
  label: 'Employment size of establishments code',
  concept: '',
  predicateType: 'string',
  required: true,
  labelAttribute: 'EMPSZES_LABEL',
};

/** POPGROUP is one of the two dimensions that do publish a value list, and it is enormous. */
const popgroup = {
  code: 'POPGROUP',
  label: 'Race/Ethnic Group',
  concept: '',
  predicateType: 'string',
  required: true,
  labelAttribute: 'POPGROUP_LABEL',
  values: {
    '001': 'Total population',
    '1002': 'European alone',
    '2670': 'Native Village of Council alone or in any combination',
  },
};

const call = (overrides: Record<string, unknown> = {}) =>
  censusListPredicateValues.input.parse({
    predicate: 'EMPSZES',
    dataset: 'cbp',
    ...overrides,
  });

describe('censusListPredicateValues — dimensions with no published value list', () => {
  /**
   * `variables.json` carries a value map for NAICS and POPGROUP only, so EMPSZES, LFO, RCPSZES,
   * TAXSTAT, and TYPOP have no offline source at all — wildcarding the dimension on the data
   * endpoint is the only route to their codes.
   */
  it('enumerates the codes against the data endpoint and labels each one', async () => {
    mockFindVariable.mockResolvedValue(empszes);
    mockFetchPredicateValues.mockResolvedValue([
      { code: '001', label: 'All establishments' },
      { code: '210', label: 'Establishments with less than 5 employees' },
      { code: '220', label: 'Establishments with 5 to 9 employees' },
    ]);

    const ctx = createMockContext({ errors: censusListPredicateValues.errors });
    const result = await censusListPredicateValues.handler(call(), ctx);

    expect(result.values).toEqual([
      { code: '001', label: 'All establishments' },
      { code: '210', label: 'Establishments with less than 5 employees' },
      { code: '220', label: 'Establishments with 5 to 9 employees' },
    ]);
    expect(result.predicate_label).toBe('Employment size of establishments code');
    expect(mockFetchPredicateValues).toHaveBeenCalledWith(
      expect.objectContaining({
        dataset: 'cbp',
        year: 2023,
        code: 'EMPSZES',
        labelAttribute: 'EMPSZES_LABEL',
      }),
      expect.anything(),
    );
    expect(getEnrichment(ctx).source).toBe('live_query');
  });

  /**
   * On ecnbasic the codes TAXSTAT and TYPOP take are published per industry, so an unscoped
   * enumeration returns only the all-establishments row. Handing that back as the answer would
   * present a one-row placeholder as the complete set.
   */
  it('tells the caller to scope by industry when only the placeholder row came back', async () => {
    mockFindVariable.mockResolvedValue({
      code: 'TAXSTAT',
      label: 'Tax status code',
      concept: '',
      predicateType: 'string',
      required: true,
      labelAttribute: 'TAXSTAT_LABEL',
    });
    mockGetFilterDimensions.mockResolvedValue([
      { code: 'NAICS2022', label: '2022 NAICS code', concept: '', predicateType: 'string' },
      { code: 'TAXSTAT', label: 'Tax status code', concept: '', predicateType: 'string' },
    ]);
    mockFetchPredicateValues.mockResolvedValue([{ code: '00', label: 'All establishments' }]);

    const ctx = createMockContext({ errors: censusListPredicateValues.errors });
    await censusListPredicateValues.handler(
      call({ predicate: 'TAXSTAT', dataset: 'ecnbasic' }),
      ctx,
    );

    expect(getEnrichment(ctx).notice).toContain('within_naics');
  });

  /**
   * A dataset with no industry dimension cannot be narrowed by within_naics, so suggesting it
   * for a one-code result there is advice the tool would ignore if taken.
   */
  it('suggests no industry scope on a dataset that has no NAICS dimension', async () => {
    mockFindVariable.mockResolvedValue(empszes);
    mockGetFilterDimensions.mockResolvedValue([
      { code: 'EMPSZES', label: 'Employment size', concept: '', predicateType: 'string' },
    ]);
    mockFetchPredicateValues.mockResolvedValue([{ code: '001', label: 'All establishments' }]);

    const ctx = createMockContext({ errors: censusListPredicateValues.errors });
    await censusListPredicateValues.handler(call(), ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('scopes the enumeration by the dataset own NAICS dimension and flags the limit', async () => {
    mockFindVariable.mockResolvedValue({
      code: 'TAXSTAT',
      label: 'Tax status code',
      concept: '',
      predicateType: 'string',
      required: true,
      labelAttribute: 'TAXSTAT_LABEL',
    });
    mockGetFilterDimensions.mockResolvedValue([
      { code: 'NAICS2022', label: '2022 NAICS code', concept: '', predicateType: 'string' },
      { code: 'TAXSTAT', label: 'Tax status code', concept: '', predicateType: 'string' },
    ]);
    mockFetchPredicateValues.mockResolvedValue([
      { code: '00', label: 'All establishments' },
      { code: 'T', label: 'Establishments subject to federal income tax' },
      { code: 'Y', label: 'Establishments exempt from federal income tax' },
    ]);

    const ctx = createMockContext({ errors: censusListPredicateValues.errors });
    const result = await censusListPredicateValues.handler(
      call({ predicate: 'TAXSTAT', dataset: 'ecnbasic', within_naics: '62' }),
      ctx,
    );

    expect(mockFetchPredicateValues).toHaveBeenCalledWith(
      expect.objectContaining({ naicsScope: { code: 'NAICS2022', value: '62' } }),
      expect.anything(),
    );
    expect(result.values).toHaveLength(3);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('NAICS2022=62');
    expect(notice).toContain('that industry only');
  });

  it('throws no_values when the dimension enumerated to nothing', async () => {
    mockFindVariable.mockResolvedValue(empszes);
    mockFetchPredicateValues.mockResolvedValue([]);

    const ctx = createMockContext({ errors: censusListPredicateValues.errors });
    await expect(censusListPredicateValues.handler(call(), ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_values' },
    });
  });
});

describe('censusListPredicateValues — dimensions with a published value list', () => {
  it('reads the codes from the dataset dictionary without spending a data query', async () => {
    mockFindVariable.mockResolvedValue(popgroup);

    const ctx = createMockContext({ errors: censusListPredicateValues.errors });
    const result = await censusListPredicateValues.handler(
      call({ predicate: 'POPGROUP', dataset: 'dec/ddhca' }),
      ctx,
    );

    expect(result.values.map((v) => v.code)).toEqual(['001', '1002', '2670']);
    expect(getEnrichment(ctx).source).toBe('dataset_dictionary');
    expect(mockFetchPredicateValues).not.toHaveBeenCalled();
  });

  /**
   * POPGROUP runs to ~5,500 codes and NAICS to ~6,700, so returning whichever sort first is
   * useless — a keyword is how a caller reaches the code they actually want.
   */
  it('narrows the list by keyword against both code and label', async () => {
    mockFindVariable.mockResolvedValue(popgroup);

    const ctx = createMockContext({ errors: censusListPredicateValues.errors });
    const result = await censusListPredicateValues.handler(
      call({ predicate: 'POPGROUP', dataset: 'dec/ddhca', query: 'european' }),
      ctx,
    );

    expect(result.values).toEqual([{ code: '1002', label: 'European alone' }]);
    expect(getEnrichment(ctx).totalCount).toBe(1);
  });

  /**
   * A keyword that matches nothing returns an empty list, which reads as "this dimension takes
   * no codes" unless the response says the filter is what emptied it.
   */
  it('says the keyword emptied the list rather than returning a bare empty array', async () => {
    mockFindVariable.mockResolvedValue(popgroup);

    const ctx = createMockContext({ errors: censusListPredicateValues.errors });
    const result = await censusListPredicateValues.handler(
      call({ predicate: 'POPGROUP', dataset: 'dec/ddhca', query: 'zzz' }),
      ctx,
    );

    expect(result.values).toEqual([]);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.notice).toContain('"zzz"');
    expect(enrichment.notice).toContain('3 codes');
  });

  it('discloses a truncated list rather than passing it off as complete', async () => {
    mockFindVariable.mockResolvedValue(popgroup);

    const ctx = createMockContext({ errors: censusListPredicateValues.errors });
    const result = await censusListPredicateValues.handler(
      call({ predicate: 'POPGROUP', dataset: 'dec/ddhca', limit: 2 }),
      ctx,
    );

    expect(result.values).toHaveLength(2);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.totalCount).toBe(3);
    expect(enrichment.notice).toContain('Showing 2 of 3');
  });
});

describe('censusListPredicateValues — input rejection', () => {
  it('throws dataset_not_found for an unregistered dataset', async () => {
    const ctx = createMockContext({ errors: censusListPredicateValues.errors });
    await expect(
      censusListPredicateValues.handler(call({ dataset: 'cbp/nope' }), ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'dataset_not_found' },
    });
  });

  it('throws predicate_not_supported for a code the dataset never defines', async () => {
    mockFindVariable.mockResolvedValue(undefined);

    const ctx = createMockContext({ errors: censusListPredicateValues.errors });
    await expect(
      censusListPredicateValues.handler(call({ predicate: 'NAICS2022' }), ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'predicate_not_supported' },
    });
    expect(mockFetchPredicateValues).not.toHaveBeenCalled();
  });

  /**
   * GEOCOMP is marked required on every Census dataset but selects a geography component, not a
   * subject-matter category — the data tools drop it from the dimensions they report. Listing
   * its codes here would advertise a filter nothing else on this server treats as one.
   */
  it('throws not_a_filter_dimension for the non-filtering GEOCOMP predicate', async () => {
    mockFindVariable.mockResolvedValue({
      code: 'GEOCOMP',
      label: 'GEO_ID Component',
      concept: '',
      predicateType: 'string',
      required: true,
    });

    const ctx = createMockContext({ errors: censusListPredicateValues.errors });
    await expect(
      censusListPredicateValues.handler(call({ predicate: 'GEOCOMP' }), ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'not_a_filter_dimension' },
    });
    expect(mockFetchPredicateValues).not.toHaveBeenCalled();
  });

  /**
   * Wildcarding a data variable is not a value lookup — it would spend a query and return the
   * dataset's own measurements as if they were filter codes.
   */
  it('throws not_a_filter_dimension for a data variable', async () => {
    mockFindVariable.mockResolvedValue({
      code: 'ESTAB',
      label: 'Number of establishments',
      concept: 'Business Patterns',
      predicateType: 'int',
    });

    const ctx = createMockContext({ errors: censusListPredicateValues.errors });
    await expect(
      censusListPredicateValues.handler(call({ predicate: 'ESTAB' }), ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'not_a_filter_dimension' },
    });
    expect(mockFetchPredicateValues).not.toHaveBeenCalled();
  });
});

describe('censusListPredicateValues — format', () => {
  it('renders every code with its label and names the dimension', () => {
    const blocks = censusListPredicateValues.format!({
      values: [
        { code: '001', label: 'All establishments' },
        { code: '210', label: 'Establishments with less than 5 employees' },
      ],
      predicate: 'EMPSZES',
      predicate_label: 'Employment size of establishments code',
      dataset: 'cbp',
      year: 2023,
    });
    const text = (blocks[0] as { type: string; text: string }).text;

    expect(text).toContain('EMPSZES');
    expect(text).toContain('Employment size of establishments code');
    expect(text).toContain('`210`');
    expect(text).toContain('Establishments with less than 5 employees');
    expect(text).toContain('cbp (2023)');
  });
});
