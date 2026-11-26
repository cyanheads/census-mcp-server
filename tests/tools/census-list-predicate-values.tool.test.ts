/**
 * @fileoverview Tests for census_list_predicate_values tool — the two routes a dimension's
 * codes can come from, and the completeness caveats each one carries.
 * @module tests/tools/census-list-predicate-values.tool.test
 */

import { JsonRpcErrorCode, unauthorized } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { censusListPredicateValues } from '@/mcp-server/tools/definitions/census-list-predicate-values.tool.js';

vi.mock('@/services/census-api/census-api-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/census-api/census-api-service.js')>()),
  getCensusApiService: vi.fn(),
}));

vi.mock('@/services/variable-cache/variable-cache-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/variable-cache/variable-cache-service.js')>()),
  getVariableCacheService: vi.fn(),
}));

vi.mock('@/config/server-config.js', () => ({
  activeDiscoveryConfig: vi.fn(() => ({ variableCacheTtlHours: 24, clampLimits: true })),
  getDiscoveryConfig: vi.fn(() => ({ variableCacheTtlHours: 24, clampLimits: true })),
  getServerConfig: vi.fn(() => ({
    censusApiKey: 'test-key',
    variableCacheTtlHours: 24,
    clampLimits: true,
  })),
}));

const mockFetchPredicateValues = vi.fn();
const mockFindVariable = vi.fn();
const mockGetFilterDimensions = vi.fn();
const mockFindPublicationProbes = vi.fn();
const mockCheckGeography = vi.fn();

beforeEach(async () => {
  vi.clearAllMocks();

  const { getCensusApiService } = await import('@/services/census-api/census-api-service.js');
  vi.mocked(getCensusApiService).mockReturnValue({
    fetchPredicateValues: mockFetchPredicateValues,
    checkGeography: mockCheckGeography,
  } as never);

  const { getVariableCacheService } = await import(
    '@/services/variable-cache/variable-cache-service.js'
  );
  vi.mocked(getVariableCacheService).mockReturnValue({
    findVariable: mockFindVariable,
    getFilterDimensions: mockGetFilterDimensions,
    findPublicationProbes: mockFindPublicationProbes,
  } as never);

  mockGetFilterDimensions.mockResolvedValue([]);
  mockCheckGeography.mockResolvedValue({ status: 'ok', acceptedParents: [] });
  // Default: the dataset offers no measure column, so a value map is returned unchecked.
  mockFindPublicationProbes.mockResolvedValue([]);
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
  it('preserves uppercase normalization and dictionary industry-scope behavior (characterization)', async () => {
    mockFindVariable.mockResolvedValue(popgroup);
    const ctx = createMockContext({ errors: censusListPredicateValues.errors });
    const result = await censusListPredicateValues.handler(
      call({ predicate: ' popgroup ', dataset: 'dec/ddhca', within_naics: '62' }),
      ctx,
    );
    expect(result.predicate).toBe('POPGROUP');
    expect(result.values.map((v) => v.code)).toEqual(['001', '1002', '2670']);
    expect(mockFetchPredicateValues).not.toHaveBeenCalled();
  });

  it('names and passes the requested live geography on both client surfaces', async () => {
    mockFindVariable.mockResolvedValue(empszes);
    mockFetchPredicateValues.mockResolvedValue([{ code: '273', label: '5,000 employees or more' }]);
    const result = await runToolContract(censusListPredicateValues, {
      predicate: 'EMPSZES',
      dataset: 'cbp',
      geography_level: ' County ',
    });
    expect(result.structuredContent).toMatchObject({
      geography_level: 'county',
      values: [{ code: '273' }],
      source: 'live_query',
    });
    expect(mockFetchPredicateValues).toHaveBeenCalledWith(
      expect.objectContaining({ geographyLevel: 'county' }),
      expect.anything(),
    );
    expect(mockCheckGeography).toHaveBeenCalledWith(
      expect.objectContaining({ geographyLevel: 'county', geographyFips: '*', scopeParents: [] }),
      expect.anything(),
    );
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).toContain('county');
    expect(text).toContain('273');
    expect(text).toContain('geography level');
  });

  it.each([
    [
      { status: 'level_not_supported', availableLevels: ['us', 'county'] },
      'geography_not_supported',
    ],
    [
      { status: 'parent_required', missingParents: ['state'], wildcardRelaxes: false },
      'parent_required',
    ],
  ])('rejects a live geography that cannot be enumerated nationally: %s', async (check, reason) => {
    mockFindVariable.mockResolvedValue(empszes);
    mockCheckGeography.mockResolvedValue(check);
    const result = await runToolContract(censusListPredicateValues, {
      predicate: 'EMPSZES',
      dataset: 'cbp',
      geography_level: 'tract',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { data: { reason } } });
    expect(result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')).toContain(
      'census_list_geographies',
    );
    expect(mockFetchPredicateValues).not.toHaveBeenCalled();
  });

  it('discloses that an explicit geography does not scope a dictionary list', async () => {
    mockFindVariable.mockResolvedValue(popgroup);
    const result = await runToolContract(censusListPredicateValues, {
      predicate: 'POPGROUP',
      dataset: 'dec/ddhca',
      geography_level: 'county',
    });
    expect(result.structuredContent).toMatchObject({
      source: 'dataset_dictionary',
      notice: expect.stringContaining('does not validate publication at geography_level "county"'),
    });
    expect(result.structuredContent).not.toHaveProperty('geography_level');
    expect(mockCheckGeography).not.toHaveBeenCalled();
  });

  it('pages filtered codes before the limit and distinguishes past-end from no matches', async () => {
    mockFindVariable.mockResolvedValue(popgroup);
    for (const [offset, codes, nextOffset] of [
      [0, ['1002'], 1],
      [1, ['2670'], undefined],
      [2, [], undefined],
    ] as const) {
      const result = await runToolContract(censusListPredicateValues, {
        predicate: 'POPGROUP',
        dataset: 'dec/ddhca',
        query: 'alone',
        limit: 1,
        offset,
      });
      expect(result.structuredContent).toMatchObject({
        values: codes.map((code) => ({ code })),
        totalCount: 2,
        truncated: nextOffset !== undefined,
      });
      if (nextOffset !== undefined)
        expect(result.structuredContent).toHaveProperty('nextOffset', nextOffset);
      else expect(result.structuredContent).not.toHaveProperty('nextOffset');
      const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
      for (const code of codes) expect(text).toContain(code);
      if (offset === 2) expect(text).toContain('past the');
    }
  });

  it.each([
    [1000, 'This is the last page of 1,200 matching codes; offset: 0 starts again.'],
    [
      1200,
      'offset 1,200 is past the last of the 1,200 matching codes. Pass an offset below 1,200, or offset: 0 to start again.',
    ],
  ])('groups the counts in the terminal notice at offset %i', async (offset, notice) => {
    mockFindVariable.mockResolvedValue(empszes);
    mockFetchPredicateValues.mockResolvedValue(
      Array.from({ length: 1200 }, (_, i) => ({ code: String(i + 1000), label: `Size ${i}` })),
    );
    const result = await runToolContract(censusListPredicateValues, {
      predicate: 'EMPSZES',
      dataset: 'cbp',
      limit: 500,
      offset,
    });
    expect((result.structuredContent as { notice?: string }).notice).toContain(notice);
  });

  it('counts a single code in the singular in the text header', async () => {
    mockFindVariable.mockResolvedValue(empszes);
    mockFetchPredicateValues.mockResolvedValue([{ code: '273', label: '5,000 employees or more' }]);
    const result = await runToolContract(censusListPredicateValues, {
      predicate: 'EMPSZES',
      dataset: 'cbp',
    });
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).toContain('· 1 code\n');
  });

  it.each([-1, 0.5])('rejects offset %s', (offset) => {
    expect(
      censusListPredicateValues.input.safeParse({ predicate: 'EMPSZES', dataset: 'cbp', offset })
        .success,
    ).toBe(false);
  });
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

    expect(getEnrichment(ctx).notice).not.toContain('within_naics');
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

  describe('no_values under within_naics', () => {
    const taxstat = {
      code: 'TAXSTAT',
      label: 'Tax status code',
      concept: '',
      predicateType: 'string',
      required: true,
      labelAttribute: 'TAXSTAT_LABEL',
    };

    beforeEach(() => {
      mockFindVariable.mockResolvedValue(taxstat);
      mockGetFilterDimensions.mockResolvedValue([
        { code: 'NAICS2022', label: '2022 NAICS code', concept: '', predicateType: 'string' },
        { code: 'TAXSTAT', label: 'Tax status code', concept: '', predicateType: 'string' },
      ]);
      mockFetchPredicateValues.mockResolvedValue([]);
    });

    const hintOf = async (within_naics: string) => {
      const result = await runToolContract(censusListPredicateValues, {
        predicate: 'TAXSTAT',
        dataset: 'ecnbasic',
        within_naics,
      });
      const error = (
        result.structuredContent as {
          error: { data: { reason: string; recovery: { hint: string } } };
        }
      ).error;
      const text = result.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      return { reason: error.data.reason, hint: error.data.recovery.hint, text };
    };

    it('points a narrow industry at a broader one (characterization)', async () => {
      const { reason, hint, text } = await hintOf('7111');

      expect(reason).toBe('no_values');
      expect(hint).toBe(
        'Drop within_naics, or try a broader industry code — a narrow leaf industry often publishes only the all-establishments row.',
      );
      expect(text).toContain('try a broader industry code');
    });

    it('documents the three NAICS ranges in the within_naics description (#101)', () => {
      const schema = censusListPredicateValues.input.toJSONSchema() as {
        properties: Record<string, { description?: string }>;
      };
      const description = schema.properties.within_naics?.description ?? '';

      for (const range of ['31-33', '44-45', '48-49']) expect(description).toContain(range);
    });

    /** #101: ecnbasic publishes manufacturing only as 31-33, so "31" scopes to no industry. */
    it('names the published range for a two-digit code inside one (#101)', async () => {
      const { reason, hint, text } = await hintOf('31');

      expect(reason).toBe('no_values');
      expect(hint).toContain('"31-33"');
      expect(hint).toContain('within_naics "31"');
      expect(hint).not.toContain('a broader industry code');
      expect(text).toContain('31-33');
    });
  });
});

describe('censusListPredicateValues — dimensions with a published value list', () => {
  /** The published set on dec/ddhca — 001 is declared but the dataset serves no rows for it. */
  const publishedPopgroups = [{ code: '1002' }, { code: '2670' }];

  it('returns the value map unchecked when the dataset offers no measure to check against', async () => {
    mockFindVariable.mockResolvedValue(popgroup);

    const ctx = createMockContext({ errors: censusListPredicateValues.errors });
    const result = await censusListPredicateValues.handler(
      call({ predicate: 'POPGROUP', dataset: 'dec/ddhca' }),
      ctx,
    );

    expect(result.values.map((v) => v.code)).toEqual(['001', '1002', '2670']);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.source).toBe('dataset_dictionary');
    expect(enrichment.notice).toContain('confirm one with census_query_data');
    expect(mockFetchPredicateValues).not.toHaveBeenCalled();
  });

  /**
   * A `values.item` map is a classification the Census shares across products, so it names codes
   * the dataset serves nothing for — on dec/ddhca that includes 001 "Total population", which is
   * the top hit for the obvious keyword and returns 204 at every geography. Handing it back is
   * the exact failure this tool exists to prevent.
   */
  it('drops the codes the dataset publishes no rows for', async () => {
    mockFindVariable.mockResolvedValue(popgroup);
    mockFindPublicationProbes.mockResolvedValue(['T01001_001N']);
    mockFetchPredicateValues.mockResolvedValue(publishedPopgroups);

    const ctx = createMockContext({ errors: censusListPredicateValues.errors });
    const result = await censusListPredicateValues.handler(
      call({ predicate: 'POPGROUP', dataset: 'dec/ddhca' }),
      ctx,
    );

    expect(result.values.map((v) => v.code)).toEqual(['1002', '2670']);
    expect(mockFetchPredicateValues).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'POPGROUP', measure: 'T01001_001N' }),
      expect.anything(),
    );
    const enrichment = getEnrichment(ctx);
    expect(enrichment.source).toBe('dataset_dictionary_verified');
    expect(enrichment.totalCount).toBe(2);
    expect(enrichment.notice).toContain('declares 3 POPGROUP codes and publishes rows for 2');
  });

  it('groups the thousands in the declared and published counts', async () => {
    const codes = Array.from({ length: 5545 }, (_, i) => String(1000 + i));
    mockFindVariable.mockResolvedValue({
      ...popgroup,
      values: Object.fromEntries(codes.map((code) => [code, `Group ${code}`])),
    });
    mockFindPublicationProbes.mockResolvedValue(['T01001_001N']);
    mockFetchPredicateValues.mockResolvedValue(codes.slice(0, 1200).map((code) => ({ code })));

    const ctx = createMockContext({ errors: censusListPredicateValues.errors });
    await censusListPredicateValues.handler(
      call({ predicate: 'POPGROUP', dataset: 'dec/ddhca' }),
      ctx,
    );

    expect(getEnrichment(ctx).notice).toContain(
      'declares 5,545 POPGROUP codes and publishes rows for 1,200',
    );
  });

  /**
   * The reported failure in full: a caller searching for the total finds a code named exactly
   * that, queries it, and gets nothing back. Suppressing the code is only half an answer — the
   * empty result has to say the code exists and is a dead end, or the caller retries the search.
   */
  it('names the withheld code when a keyword matched only unpublished ones', async () => {
    mockFindVariable.mockResolvedValue(popgroup);
    mockFindPublicationProbes.mockResolvedValue(['T01001_001N']);
    mockFetchPredicateValues.mockResolvedValue(publishedPopgroups);

    const ctx = createMockContext({ errors: censusListPredicateValues.errors });
    const result = await censusListPredicateValues.handler(
      call({ predicate: 'POPGROUP', dataset: 'dec/ddhca', query: 'total population' }),
      ctx,
    );

    expect(result.values).toEqual([]);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('001 (Total population)');
    expect(notice).toContain('publishes no rows for it at any geography');
  });

  /**
   * On ecnbasic the codes TAXSTAT takes are published per industry — T and Y come back only under
   * a NAICS scope. Checking against an unscoped query would withhold codes that do return rows.
   */
  it('leaves a per-industry dimension unchecked rather than withholding its codes', async () => {
    mockFindVariable.mockResolvedValue({
      code: 'TAXSTAT',
      label: 'Tax status code',
      concept: '',
      predicateType: 'string',
      required: true,
      labelAttribute: 'TAXSTAT_LABEL',
      values: { '00': 'All establishments', T: 'Subject to federal income tax' },
    });
    mockGetFilterDimensions.mockResolvedValue([
      { code: 'NAICS2017', label: '2017 NAICS code', concept: '', predicateType: 'string' },
      { code: 'TAXSTAT', label: 'Tax status code', concept: '', predicateType: 'string' },
    ]);
    mockFindPublicationProbes.mockResolvedValue(['ASRET']);

    const ctx = createMockContext({ errors: censusListPredicateValues.errors });
    const result = await censusListPredicateValues.handler(
      call({ predicate: 'TAXSTAT', dataset: 'ecnbasic', year: 2017 }),
      ctx,
    );

    expect(result.values.map((v) => v.code)).toEqual(['00', 'T']);
    expect(mockFetchPredicateValues).not.toHaveBeenCalled();
    const enrichment = getEnrichment(ctx);
    expect(enrichment.source).toBe('dataset_dictionary');
    expect(enrichment.notice).toContain('publishes TAXSTAT per industry');
  });

  /**
   * The check is one live call on top of an answer the dictionary already holds. Losing it should
   * cost the caller the guarantee and nothing else — a failed check that emptied the response
   * would trade a list with dead codes in it for no list at all.
   */
  it('falls back to the unchecked value map when the check fails', async () => {
    mockFindVariable.mockResolvedValue(popgroup);
    mockFindPublicationProbes.mockResolvedValue(['T01001_001N']);
    mockFetchPredicateValues.mockRejectedValue(new Error('Census API unreachable'));

    const ctx = createMockContext({ errors: censusListPredicateValues.errors });
    const result = await censusListPredicateValues.handler(
      call({ predicate: 'POPGROUP', dataset: 'dec/ddhca' }),
      ctx,
    );

    expect(result.values.map((v) => v.code)).toEqual(['001', '1002', '2670']);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.source).toBe('dataset_dictionary');
    expect(enrichment.notice).toContain('was not possible on this call');
    expect(enrichment.notice).not.toContain('CENSUS_API_KEY');
  });

  /**
   * The check reads the data endpoint, so it needs the key the dictionary list does not. Without a
   * working one the list still answers, and the notice says why it went unchecked — "not possible
   * on this call" would invite a retry that fails the same way.
   */
  it('names CENSUS_API_KEY when the check failed for want of a working key', async () => {
    mockFindVariable.mockResolvedValue(popgroup);
    mockFindPublicationProbes.mockResolvedValue(['T01001_001N']);
    mockFetchPredicateValues.mockRejectedValue(
      unauthorized('CENSUS_API_KEY is not set.', { reason: 'missing_api_key' }),
    );

    const ctx = createMockContext({ errors: censusListPredicateValues.errors });
    const result = await censusListPredicateValues.handler(
      call({ predicate: 'POPGROUP', dataset: 'dec/ddhca' }),
      ctx,
    );

    expect(result.values.map((v) => v.code)).toEqual(['001', '1002', '2670']);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.source).toBe('dataset_dictionary');
    expect(enrichment.notice).toContain('CENSUS_API_KEY');
    expect(enrichment.notice).not.toContain('was not possible on this call');
  });

  /**
   * A check that comes back empty is the probe saying nothing, not the dimension having no codes.
   * Trusting it would hide every code the dimension takes behind one bad answer.
   */
  it('keeps the value map when the check comes back empty', async () => {
    mockFindVariable.mockResolvedValue(popgroup);
    mockFindPublicationProbes.mockResolvedValue(['T01001_001N']);
    mockFetchPredicateValues.mockResolvedValue([]);

    const ctx = createMockContext({ errors: censusListPredicateValues.errors });
    const result = await censusListPredicateValues.handler(
      call({ predicate: 'POPGROUP', dataset: 'dec/ddhca' }),
      ctx,
    );

    expect(result.values.map((v) => v.code)).toEqual(['001', '1002', '2670']);
    expect(getEnrichment(ctx).source).toBe('dataset_dictionary');
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
    expect(enrichment.notice).toContain('raise limit (max 10,000)');
  });

  /** #95: a limit above the 10,000 cap is served at the cap and said so; at the cap, it is not. */
  it.each([
    [10_001, 'limit 10,001 is over the 10,000-code cap, so this page holds up to 10,000 codes. '],
    [10_000, ''],
  ])('serves limit %i at 10,000 without advising a larger page', async (requested, clamp) => {
    mockFindVariable.mockResolvedValue(empszes);
    mockFetchPredicateValues.mockResolvedValue(
      Array.from({ length: 10_050 }, (_, i) => ({
        code: String(i).padStart(5, '0'),
        label: `Code ${i}`,
      })),
    );

    const ctx = createMockContext({ errors: censusListPredicateValues.errors });
    const result = await censusListPredicateValues.handler(call({ limit: requested }), ctx);

    expect(result.values).toHaveLength(10_000);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain(`${clamp}Showing 10,000 of 10,050 codes.`);
    expect(notice).toContain('Narrow with query for fewer matches.');
    expect(notice).not.toMatch(/raise limit/i);
  });

  it('groups the code count when a keyword matches none of a long list', async () => {
    mockFindVariable.mockResolvedValue(empszes);
    mockFetchPredicateValues.mockResolvedValue(
      Array.from({ length: 10_050 }, (_, i) => ({
        code: String(i).padStart(5, '0'),
        label: `Code ${i}`,
      })),
    );

    const ctx = createMockContext({ errors: censusListPredicateValues.errors });
    await censusListPredicateValues.handler(call({ query: 'zzz' }), ctx);

    expect(getEnrichment(ctx).notice).toContain(
      'No EMPSZES code matched "zzz". EMPSZES takes 10,050 codes here — drop query to list them, or try a broader keyword.',
    );
  });

  it('discloses limit 20,000 served at 10,000 when every code fits the page', async () => {
    mockFindVariable.mockResolvedValue(empszes);
    mockFetchPredicateValues.mockResolvedValue([
      { code: '210', label: 'Establishments with less than 5 employees' },
      { code: '273', label: '5,000 employees or more' },
    ]);

    const ctx = createMockContext({ errors: censusListPredicateValues.errors });
    const result = await censusListPredicateValues.handler(call({ limit: 20_000 }), ctx);

    expect(result.values).toHaveLength(2);
    expect(getEnrichment(ctx).notice).toBe(
      'These codes cover geography level "us"; codes can vary by geography level, industry and individual geography. Keep geography_level unchanged when following nextOffset. limit 20,000 is over the 10,000-code cap, so this page holds up to 10,000 codes.',
    );
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
