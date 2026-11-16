/**
 * @fileoverview Tests for census_resolve_geography tool.
 * @module tests/tools/census-resolve-geography.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { censusResolveGeography } from '@/mcp-server/tools/definitions/census-resolve-geography.tool.js';
import { readNotice } from '../helpers/markdown-readback.js';

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
      'county subdivision',
      'place',
      'tract',
      'metropolitan statistical area/micropolitan statistical area',
      'combined statistical area',
      'consolidated city',
      'zip code tabulation area',
      'economic place',
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

  it('resolves a ZIP to its ZCTA with no state_fips in structuredContent', async () => {
    mockResolveGeography.mockResolvedValue({
      name: 'ZCTA5 98109',
      geographyType: 'zip code tabulation area',
      fipsSummary: '98109',
    });

    const ctx = createMockContext({ errors: censusResolveGeography.errors });
    const input = censusResolveGeography.input.parse({ name: '98109' });
    const result = await censusResolveGeography.handler(input, ctx);

    expect(result).toEqual({
      name: 'ZCTA5 98109',
      geography_type: 'zip code tabulation area',
      fips_summary: '98109',
    });
  });

  it('format says which vintages take a ZCTA without a parent, and never claims all do', () => {
    const blocks = censusResolveGeography.format!({
      name: 'ZCTA5 98109',
      geography_type: 'zip code tabulation area',
      fips_summary: '98109',
    });
    const text = (blocks[0] as { type: string; text: string }).text;

    expect(text).toContain('ZCTA5 98109');
    expect(text).toContain('**Type:** zip code tabulation area');
    expect(text).toContain('`98109`');
    expect(text).not.toContain('this level is queried without `parent_fips`');
    expect(text).toContain('acs/acs5');
    expect(text).toContain('2020');
    expect(text).toContain('acs/acs5/subject');
    expect(text).toContain('2019');
    // Earlier vintages need a state this result cannot supply.
    expect(text).toContain('2011');
    expect(text).toContain('state');
    // cbp's zip code level is a different unit.
    expect(text).toContain('not cbp');
  });

  it('describes name and geography_type with the forms the resolver accepts', () => {
    const shape = censusResolveGeography.input.shape;
    const name = shape.name.description ?? '';
    const level = shape.geography_type.description ?? '';

    expect(name).toContain('full name');
    expect(name).toContain('98109');
    expect(name).toContain('leading city');
    expect(name).not.toContain('the full hyphenated one the Census publishes');
    expect(level).toContain('zip code tabulation area');
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

  /** #62: the message said what to provide, and the hint said it again. */
  it('states a blank name in the message and what to send in the hint, on both surfaces', async () => {
    const result = await runToolContract(censusResolveGeography, { name: '   ' });
    const error = (
      result.structuredContent as {
        error: { message: string; data: { recovery: { hint: string } } };
      }
    ).error;

    expect(error.message).toBe('Place name is required.');
    expect(error.data.recovery.hint).toBe(
      'Provide a city, county, state, or street address, such as "King County, WA" or "Washington".',
    );
    const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
    expect(text).toContain('Error: Place name is required.');
    expect(text).toContain(`Recovery: ${error.data.recovery.hint}`);
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

  it('returns an economic place as its 8-digit code, and says how the code is built', async () => {
    mockResolveGeography.mockResolvedValue({
      name: 'Auburn city',
      geographyType: 'economic place',
      stateFips: '53',
      placeFips: '03180',
      fipsSummary: '00003180',
    });

    const ctx = createMockContext({ errors: censusResolveGeography.errors });
    const result = await censusResolveGeography.handler(
      censusResolveGeography.input.parse({ name: 'Auburn, WA', geography_type: 'economic place' }),
      ctx,
    );

    expect(result).toEqual({
      name: 'Auburn city',
      geography_type: 'economic place',
      state_fips: '53',
      place_fips: '03180',
      fips_summary: '00003180',
    });
    const text = (censusResolveGeography.format!(result)[0] as { text: string }).text;
    expect(text).toContain('`00003180`');
    expect(text).toContain('`000`');
    expect(text).toContain('more than one county');
    expect(text).toContain('ecnbasic');
    // The earlier vintages publish place, which place_fips reaches.
    expect(text).toContain('2017');
    expect(text).toContain('`place`');
  });

  it('names the county prefix of a single-county economic place', () => {
    const text = (
      censusResolveGeography.format!({
        name: 'Seattle city',
        geography_type: 'economic place',
        state_fips: '53',
        place_fips: '63000',
        fips_summary: '03363000',
      })[0] as { text: string }
    ).text;

    expect(text).toContain('county `033`');
    expect(text).not.toContain('more than one county');
  });

  it('describes economic place as never auto-detected, with its 8-digit code', () => {
    const level = censusResolveGeography.input.shape.geography_type.description ?? '';
    expect(level).toContain('"economic place"');
    expect(level).toContain('8-digit');
    expect(level).toContain('000');
  });

  it('hands over an address block group and place, ready for a block-group query', async () => {
    mockResolveGeography.mockResolvedValue({
      name: '400 BROAD ST, SEATTLE, WA, 98109',
      geographyType: 'tract',
      stateFips: '53',
      countyFips: '033',
      tractFips: '007101',
      blockGroupFips: '2',
      placeFips: '63000',
      fipsSummary: '007101',
    });

    const ctx = createMockContext({ errors: censusResolveGeography.errors });
    const result = await censusResolveGeography.handler(
      censusResolveGeography.input.parse({ name: '400 Broad St, Seattle, WA 98109' }),
      ctx,
    );

    expect(result).toEqual({
      name: '400 BROAD ST, SEATTLE, WA, 98109',
      geography_type: 'tract',
      state_fips: '53',
      county_fips: '033',
      tract_fips: '007101',
      block_group_fips: '2',
      place_fips: '63000',
      fips_summary: '007101',
    });
    const text = (censusResolveGeography.format!(result)[0] as { text: string }).text;
    expect(text).toContain('**Block group FIPS:** `2`');
    expect(text).toContain('"block group"');
    expect(text).toContain('tract_fips');
    expect(text).toContain('**Place FIPS:** `63000`');
    expect(text).toContain('**Type:** tract');
  });

  it('describes block_group_fips and an address place_fips in the output schema', () => {
    const shape = censusResolveGeography.output.shape;
    expect(shape.block_group_fips.description).toContain('tract_fips');
    expect(shape.place_fips.description).toContain('street address');
  });

  it('says a census-designated place is one, on both surfaces', async () => {
    mockResolveGeography.mockResolvedValue({
      name: 'Bethesda CDP',
      geographyType: 'place',
      stateFips: '24',
      placeFips: '07125',
      fipsSummary: '07125',
      censusDesignatedPlace: true,
    });

    const ctx = createMockContext({ errors: censusResolveGeography.errors });
    const result = await censusResolveGeography.handler(
      censusResolveGeography.input.parse({ name: 'Bethesda, MD' }),
      ctx,
    );

    expect(result).toMatchObject({ place_fips: '07125', census_designated_place: true });
    const text = (censusResolveGeography.format!(result)[0] as { text: string }).text;
    expect(text).toContain('census-designated place');
    expect(text).toContain('`07125`');
  });

  it('carries no CDP flag or note for an incorporated place', async () => {
    mockResolveGeography.mockResolvedValue({
      name: 'Seattle city',
      geographyType: 'place',
      stateFips: '53',
      placeFips: '63000',
      fipsSummary: '63000',
    });

    const ctx = createMockContext({ errors: censusResolveGeography.errors });
    const result = await censusResolveGeography.handler(
      censusResolveGeography.input.parse({ name: 'Seattle, WA' }),
      ctx,
    );

    expect(result).not.toHaveProperty('census_designated_place');
    const text = (censusResolveGeography.format!(result)[0] as { text: string }).text;
    expect(text).not.toContain('census-designated');
  });

  it('discloses a New York City borough mapped to its county, on both surfaces', async () => {
    mockResolveGeography.mockResolvedValue({
      name: 'Richmond County',
      geographyType: 'county',
      stateFips: '36',
      countyFips: '085',
      fipsSummary: '085',
      borough: 'Staten Island',
    });

    const result = await runToolContract(censusResolveGeography, { name: 'Staten Island, NY' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      name: 'Richmond County',
      fips_summary: '085',
      notice: '"Staten Island" is the New York City borough coextensive with Richmond County.',
    });
    expect(result.structuredContent).not.toHaveProperty('borough');
    const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
    expect(text).toContain(
      '"Staten Island" is the New York City borough coextensive with Richmond County.',
    );
  });

  it('carries no notice when the service mapped no borough', async () => {
    mockResolveGeography.mockResolvedValue({
      name: 'Queens County',
      geographyType: 'county',
      stateFips: '36',
      countyFips: '081',
      fipsSummary: '081',
    });

    const result = await runToolContract(censusResolveGeography, { name: 'Queens, NY' });

    expect(result.structuredContent).not.toHaveProperty('notice');
    const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
    expect(text).not.toContain('borough');
  });

  it('declares the notice in the advertised output and names boroughs in the name description', () => {
    expect(Object.keys(censusResolveGeography.enrichment ?? {})).toEqual(['notice']);
    expect(censusResolveGeography.input.shape.name.description).toContain('Brooklyn, NY');
  });

  const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
    result.content.map((c) => c.text ?? '').join('\n');

  it('returns a county subdivision with its own code and the county_fips it is queried under', async () => {
    mockResolveGeography.mockResolvedValue({
      name: 'Edison township',
      geographyType: 'county subdivision',
      stateFips: '34',
      countyFips: '023',
      countySubdivisionFips: '20230',
      fipsSummary: '20230',
    });

    const result = await runToolContract(censusResolveGeography, { name: 'Edison, NJ' });

    expect(result.structuredContent).toEqual({
      name: 'Edison township',
      geography_type: 'county subdivision',
      state_fips: '34',
      county_fips: '023',
      county_subdivision_fips: '20230',
      fips_summary: '20230',
    });
    const text = textOf(result);
    expect(text).toContain('**County subdivision FIPS:** `20230`');
    expect(text).toContain('for county subdivision queries');
    // A resolved subdivision is queried by fips_summary, so its own line carries no usage note.
    expect(text).toMatch(/^\*\*County subdivision FIPS:\*\* `20230`$/m);
  });

  it('names every active subdivision of the name, each with its county and code', async () => {
    mockResolveGeography.mockResolvedValue({
      name: 'Union County',
      geographyType: 'county',
      stateFips: '34',
      countyFips: '039',
      fipsSummary: '039',
      namesakes: {
        kind: 'found',
        subdivisions: [
          { name: 'Union township', countyFips: '019', countySubdivisionFips: '74420' },
          { name: 'Union township', countyFips: '039', countySubdivisionFips: '74480' },
        ],
      },
    });

    const result = await runToolContract(censusResolveGeography, { name: 'Union, NJ' });

    const notice =
      '2 county subdivisions with their own governments share this name — Union township (county 019, county subdivision 74420), Union township (county 039, county subdivision 74480): resolve one with geography_type "county subdivision" and its county_fips.';
    expect(result.structuredContent).toMatchObject({ fips_summary: '039', notice });
    expect(textOf(result)).toContain(notice);
    expect(result.structuredContent).not.toHaveProperty('namesakes');
  });

  it('joins every notice a result carries into the one notice field', async () => {
    mockResolveGeography.mockResolvedValue({
      name: 'Kings County',
      geographyType: 'county',
      stateFips: '36',
      countyFips: '047',
      fipsSummary: '047',
      borough: 'Brooklyn',
      namesakes: { kind: 'unavailable' },
    });

    const result = await runToolContract(censusResolveGeography, { name: 'Brooklyn, NY' });

    expect((result.structuredContent as { notice: string }).notice).toBe(
      '"Brooklyn" is the New York City borough coextensive with Kings County. Whether a county subdivision with its own government shares this name could not be checked, because TIGERweb did not answer; geography_type "county subdivision" resolves one directly.',
    );
  });

  it('says a Connecticut county is the pre-2022 one, with the vintages that publish it', async () => {
    mockResolveGeography.mockResolvedValue({
      name: 'Windham County',
      geographyType: 'county',
      stateFips: '09',
      countyFips: '015',
      fipsSummary: '015',
      legacyCounty: true,
    });

    const result = await runToolContract(censusResolveGeography, { name: 'Windham County, CT' });

    expect(result.structuredContent).toMatchObject({
      county_fips: '015',
      notice:
        "Windham County (county 015) is one of Connecticut's eight counties before 2022: every dataset vintage through 2021, the 2020 Census included, publishes it, and vintages from 2022 publish the nine planning regions (counties 110–190) in its place.",
    });
    expect(result.structuredContent).not.toHaveProperty('legacy_county');
  });

  it('describes county subdivisions, the twelve-state tier, and Connecticut counties', () => {
    const { name, geography_type, county_fips } = censusResolveGeography.input.shape;
    const output = censusResolveGeography.output.shape;
    const notice = censusResolveGeography.enrichment?.notice.description ?? '';

    expect(name.description).toContain('Cherry Hill, NJ');
    expect(name.description).toContain('Clinton Township, MI');
    expect(name.description).toContain('Fairfield County, CT');
    expect(geography_type.description).toContain('CT, ME, MA, MI, MN, NH, NJ, NY, PA, RI, VT, WI');
    expect(geography_type.description).toContain('Plymouth, MA');
    expect(county_fips.description).toContain('county subdivision');
    // census_query_data zero-pads its county_fips the same way.
    expect(county_fips.description).not.toContain('pads nothing');
    expect(output.county_subdivision_fips.description).toContain('street address');
    expect(notice).toContain('county subdivision');
    expect(notice).toContain('Connecticut');
  });

  it('names county subdivision in the ambiguous_name and county_scope_unsupported recoveries', () => {
    const recovery = (reason: string) =>
      censusResolveGeography.errors?.find((e) => e.reason === reason)?.recovery ?? '';

    expect(recovery('ambiguous_name')).toContain('county subdivision');
    expect(recovery('county_scope_unsupported')).toBe(
      'Drop county_fips, or set geography_type to "county", "county subdivision", or "tract" to use it.',
    );
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

describe('censusResolveGeography — a resolved tract is a 2020 tract (#94)', () => {
  const TRACT_NOTICE =
    'Tract 007101 is a 2020 census tract: ACS 5-year vintages from 2020 and the 2020 Census files publish it and its block groups, while earlier vintages publish earlier tracts — 2010 tracts, or 2000 tracts on acs/acs5 2009 and dec/pl 2000 — where this code can be missing.';

  it.each([
    [
      'a street address',
      '400 Broad St, Seattle, WA 98109',
      { name: '400 BROAD ST, SEATTLE, WA, 98109', blockGroupFips: '2', placeFips: '63000' },
    ],
    [
      'a tract name',
      'Census Tract 71.01, King County, WA',
      { name: 'Census Tract 71.01; King County; Washington' },
    ],
  ])('says so on both surfaces for %s', async (_kind, name, fields) => {
    mockResolveGeography.mockResolvedValue({
      geographyType: 'tract',
      stateFips: '53',
      countyFips: '033',
      tractFips: '007101',
      fipsSummary: '007101',
      ...fields,
    });

    const result = await runToolContract(censusResolveGeography, { name });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ tract_fips: '007101', notice: TRACT_NOTICE });
    expect(readNotice(result)).toBe(TRACT_NOTICE);
  });

  it.each([
    [
      'a county',
      { name: 'King County', geographyType: 'county', stateFips: '53', countyFips: '033' },
      '033',
    ],
    [
      'a place',
      { name: 'Seattle city', geographyType: 'place', stateFips: '53', placeFips: '63000' },
      '63000',
    ],
  ])('carries no tract notice for %s', async (_kind, fields, fipsSummary) => {
    mockResolveGeography.mockResolvedValue({ ...fields, fipsSummary });

    const result = await runToolContract(censusResolveGeography, { name: 'Seattle, WA' });

    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(result.content.map((c) => ('text' in c ? c.text : '')).join('\n')).not.toContain(
      '2020 census tract',
    );
  });

  it('names the planning region and the earlier county scheme for a Connecticut tract, "*" intact', async () => {
    mockResolveGeography.mockResolvedValue({
      name: '1 MAIN ST, GREENWICH, CT, 06830',
      geographyType: 'tract',
      stateFips: '09',
      countyFips: '190',
      tractFips: '010101',
      countySubdivisionFips: '33620',
      fipsSummary: '010101',
    });

    const result = await runToolContract(censusResolveGeography, {
      name: '1 Main St, Greenwich, CT 06830',
    });

    const notice = (result.structuredContent as { notice: string }).notice;
    expect(notice).toBe(
      'Tract 010101 is a 2020 census tract: ACS 5-year vintages from 2020 and the 2020 Census files publish it and its block groups, while earlier vintages publish earlier tracts — 2010 tracts, or 2000 tracts on acs/acs5 2009 and dec/pl 2000 — where this code can be missing. In Connecticut it sits under its planning region, county 190, which vintages from 2022 publish; vintages through 2021, the 2020 Census included, publish the same tract code under one of the eight counties from before 2022 (001–015) — census_query_data at the tract level with geography_fips "*", county_fips "*", and parent_fips "09" lists each under its county there.',
    );
    // A bare "*" pair in live Markdown would read as emphasis; the notice reads back exactly.
    expect(readNotice(result)).toBe(notice);
  });

  it('joins the tract notice after the other notes a result carries', async () => {
    mockResolveGeography.mockResolvedValue({
      name: 'Census Tract 7071.01; Plymouth County; Massachusetts',
      geographyType: 'tract',
      stateFips: '25',
      countyFips: '023',
      tractFips: '707101',
      fipsSummary: '707101',
      namesakes: { kind: 'unavailable' },
    });

    const result = await runToolContract(censusResolveGeography, {
      name: 'Census Tract 7071.01, MA',
    });

    expect((result.structuredContent as { notice: string }).notice).toMatch(
      /could not be checked, because TIGERweb did not answer; .* Tract 707101 is a 2020 census tract:/,
    );
  });

  it('states it in the tract_fips and notice descriptions', () => {
    expect(censusResolveGeography.output.shape.tract_fips.description).toContain(
      'It is a 2020 census tract, which ACS 5-year vintages from 2020 and the 2020 Census files publish',
    );
    expect(censusResolveGeography.enrichment?.notice.description).toContain(
      'or a census tract, which is a 2020 tract',
    );
  });

  it('declares resolution_unavailable for every way an upstream fails, with a retry recovery', () => {
    const entry = censusResolveGeography.errors?.find((e) => e.reason === 'resolution_unavailable');
    expect(entry?.when).toContain('HTTP error');
    expect(entry?.when).toContain('did not answer in time');
    expect(entry?.when).toContain("the call's 50-second upstream budget");
    expect(entry?.recovery).toBe(
      'Retry the request; if it keeps failing, the Census geography service is temporarily unavailable.',
    );
  });
});
