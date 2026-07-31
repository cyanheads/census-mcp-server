/**
 * @fileoverview Tests for CensusApiService — GEOID composition in parseResponse across
 * geography levels, and the geography.json-driven parent pre-validation in checkGeography.
 * @module tests/services/census-api/census-api-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CensusApiService,
  getCensusApiService,
  initCensusApiService,
} from '@/services/census-api/census-api-service.js';

vi.mock('@/config/server-config.js', () => ({
  getDiscoveryConfig: vi.fn(() => ({ defaultYear: 2024, variableCacheTtlHours: 24 })),
  getServerConfig: vi.fn(() => ({
    defaultYear: 2024,
    censusApiKey: 'test-key',
    variableCacheTtlHours: 24,
  })),
}));

/** Bodies handed out in call order; a request past the end sees an empty response. */
let responses: unknown[] = [];
/** Every URL the service requested, in order. */
let requestedUrls: string[] = [];

const queue = (...bodies: unknown[]) => {
  responses = bodies;
};

let service: CensusApiService;

beforeEach(() => {
  responses = [];
  requestedUrls = [];
  service = new CensusApiService();
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string | URL) => {
      requestedUrls.push(String(url));
      const body = responses.shift() ?? [];
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const query = (
  geographyLevel: string,
  overrides: Partial<Parameters<CensusApiService['queryData']>[0]> = {},
) =>
  service.queryData(
    {
      variables: ['B19013_001E'],
      geographyLevel,
      geographyFips: '*',
      dataset: 'acs/acs5',
      year: 2023,
      ...overrides,
    },
    createMockContext(),
  );

describe('CensusApiService.parseResponse — GEOID composition', () => {
  it('composes the state-qualified GEOID for a nationwide county query', async () => {
    queue([
      ['NAME', 'B19013_001E', 'state', 'county'],
      ['King County, Washington', '122148', '53', '033'],
      ['Los Angeles County, California', '85398', '06', '037'],
    ]);

    const rows = await query('county');

    // The bare level code is preserved for the census_query_data round-trip...
    expect(rows.map((r) => r.geographyFips)).toEqual(['033', '037']);
    // ...and the composed GEOID is what makes cross-state matching possible.
    expect(rows.map((r) => r.geographyGeoid)).toEqual(['53033', '06037']);
    expect(rows[0]?.geographyName).toBe('King County, Washington');
  });

  it('composes state+county+tract for a tract query', async () => {
    queue([
      ['NAME', 'B19013_001E', 'state', 'county', 'tract'],
      ['Census Tract 1.01; King County; Washington', '69028', '53', '033', '000101'],
    ]);

    const rows = await query('tract', { parentFips: '53', countyFips: '033' });

    expect(rows[0]?.geographyFips).toBe('000101');
    expect(rows[0]?.geographyGeoid).toBe('53033000101');
  });

  it('composes state+county+tract+block group for a block-group query', async () => {
    queue([
      ['NAME', 'B19013_001E', 'state', 'county', 'tract', 'block group'],
      [
        'Block Group 1; Census Tract 1.01; King County; Washington',
        '112841',
        '53',
        '033',
        '000101',
        '1',
      ],
    ]);

    const rows = await query('block group', { parentFips: '53', countyFips: '033' });

    expect(rows[0]?.geographyGeoid).toBe('53033000101' + '1');
  });

  it('leaves a single-column level GEOID equal to its bare FIPS', async () => {
    queue([
      ['NAME', 'B19013_001E', 'zip code tabulation area'],
      ['ZCTA5 00601', '18571', '00601'],
    ]);

    const rows = await query('zip code tabulation area');

    expect(rows[0]?.geographyFips).toBe('00601');
    expect(rows[0]?.geographyGeoid).toBe('00601');
  });

  it('excludes requested MOE variables from the composed GEOID', async () => {
    queue([
      ['NAME', 'B19013_001E', 'B19013_001M', 'state', 'county'],
      ['King County, Washington', '122148', '1808', '53', '033'],
    ]);

    const rows = await service.queryData(
      {
        variables: ['B19013_001E', 'B19013_001M'],
        geographyLevel: 'county',
        geographyFips: '*',
        dataset: 'acs/acs5',
        year: 2023,
      },
      createMockContext(),
    );

    expect(rows[0]?.geographyGeoid).toBe('53033');
    expect(rows[0]?.variables.B19013_001E?.moe).toBe(1808);
  });

  it('matches the geography column however the caller cased the level name', async () => {
    queue([
      ['NAME', 'B19013_001E', 'state', 'county'],
      ['King County, Washington', '122148', '53', '033'],
    ]);

    const rows = await query('County');

    expect(rows[0]?.geographyFips).toBe('033');
    expect(rows[0]?.geographyGeoid).toBe('53033');
  });

  it('decodes suppression sentinels rather than passing them through', async () => {
    queue([
      ['NAME', 'B19013_001E', 'state', 'place'],
      ['Abanda CDP, Alabama', '-666666666', '01', '00100'],
    ]);

    const rows = await query('place');

    expect(rows[0]?.geographyGeoid).toBe('0100100');
    expect(rows[0]?.variables.B19013_001E?.suppressed).toBe(true);
    expect(rows[0]?.variables.B19013_001E?.estimate).toBeNull();
    expect(rows[0]?.variables.B19013_001E?.suppressionReason).toContain('Not available');
  });
});

/** The acs/acs5 hierarchy as the Census geography.json actually publishes it. */
const geographyJson = {
  fips: [
    { name: 'us', geoLevelDisplay: '010' },
    { name: 'state', geoLevelDisplay: '040' },
    {
      name: 'county',
      geoLevelDisplay: '050',
      requires: ['state'],
      wildcard: ['state'],
      optionalWithWCFor: 'state',
    },
    {
      name: 'tract',
      geoLevelDisplay: '140',
      requires: ['state', 'county'],
      wildcard: ['county'],
      optionalWithWCFor: 'county',
    },
    {
      name: 'block group',
      geoLevelDisplay: '150',
      requires: ['state', 'county', 'tract'],
      wildcard: ['county', 'tract'],
      optionalWithWCFor: 'tract',
    },
    {
      name: 'state legislative district (upper chamber)',
      geoLevelDisplay: '610',
      requires: ['state'],
    },
    { name: 'zip code tabulation area', geoLevelDisplay: '860' },
  ],
};

const check = (
  geographyLevel: string,
  params: { geographyFips?: string; parentFips?: string; countyFips?: string } = {},
) =>
  service.checkGeography(
    {
      dataset: 'acs/acs5',
      year: 2023,
      geographyLevel,
      geographyFips: params.geographyFips ?? '*',
      ...(params.parentFips !== undefined && { parentFips: params.parentFips }),
      ...(params.countyFips !== undefined && { countyFips: params.countyFips }),
    },
    createMockContext(),
  );

describe('CensusApiService.checkGeography', () => {
  beforeEach(() => {
    queue(geographyJson);
  });

  it('accepts a level with no parent requirements', async () => {
    await expect(check('state')).resolves.toEqual({ status: 'ok' });
  });

  it('accepts a wildcard county query with no parent — the API infers the state', async () => {
    await expect(check('county')).resolves.toEqual({ status: 'ok' });
  });

  it('requires the state parent for a concrete county FIPS', async () => {
    await expect(check('county', { geographyFips: '033' })).resolves.toEqual({
      status: 'parent_required',
      missingParents: ['state'],
      wildcardRelaxes: true,
    });
  });

  it('requires the state parent for a wildcard tract query', async () => {
    await expect(check('tract')).resolves.toEqual({
      status: 'parent_required',
      missingParents: ['state'],
      wildcardRelaxes: false,
    });
  });

  it('flags that a wildcard would drop the tract parent a single block group needs', async () => {
    await expect(
      check('block group', { geographyFips: '1', parentFips: '53', countyFips: '033' }),
    ).resolves.toEqual({
      status: 'parent_required',
      missingParents: ['tract'],
      wildcardRelaxes: true,
    });
  });

  it('accepts a wildcard tract query scoped by state — county is optional under a wildcard', async () => {
    await expect(check('tract', { parentFips: '53' })).resolves.toEqual({ status: 'ok' });
  });

  it('requires both state and county for a wildcard block-group query', async () => {
    await expect(check('block group')).resolves.toEqual({
      status: 'parent_required',
      missingParents: ['state', 'county'],
      wildcardRelaxes: false,
    });
  });

  it('accepts a block-group query scoped by state and county', async () => {
    await expect(check('block group', { parentFips: '53', countyFips: '033' })).resolves.toEqual({
      status: 'ok',
    });
  });

  it('requires the state parent even under a wildcard when the level has no wildcard cutoff', async () => {
    await expect(check('state legislative district (upper chamber)')).resolves.toEqual({
      status: 'parent_required',
      missingParents: ['state'],
      wildcardRelaxes: false,
    });
  });

  it('reports an unknown level as unsupported with the levels the dataset does have', async () => {
    const result = await check('bogus level');
    expect(result).toMatchObject({ status: 'level_not_supported' });
    expect((result as { availableLevels: string[] }).availableLevels).toContain('county');
  });

  it('matches the level name case-insensitively', async () => {
    await expect(check('County')).resolves.toEqual({ status: 'ok' });
  });

  it('defers to the data call when the dataset+year has no geography metadata', async () => {
    // A 404 from geography.json (unavailable year) yields an empty level list.
    responses = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('', { status: 404 }))),
    );
    await expect(check('tract')).resolves.toEqual({ status: 'ok' });
  });
});

describe('CensusApiService.queryData — empty upstream response', () => {
  /** The Census API answers a well-formed query that matches nothing with 204, no body. */
  it('reads a 204 as zero rows rather than an unparseable response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
    );

    await expect(query('county', { geographyFips: '999', parentFips: '53' })).resolves.toEqual([]);
  });
});

describe('CensusApiService.fetchGeographyLevels', () => {
  it('serves a repeat dataset+year from cache instead of refetching', async () => {
    queue(geographyJson);
    const ctx = createMockContext();

    const first = await service.fetchGeographyLevels('acs/acs5', 2023, ctx);
    const second = await service.fetchGeographyLevels('acs/acs5', 2023, ctx);

    expect(second).toBe(first);
    expect(requestedUrls).toHaveLength(1);
  });

  it('fetches separately per dataset+year', async () => {
    queue(geographyJson, geographyJson);
    const ctx = createMockContext();

    await service.fetchGeographyLevels('acs/acs5', 2023, ctx);
    await service.fetchGeographyLevels('acs/acs5', 2022, ctx);

    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls[1]).toContain('/2022/acs/acs5/geography.json');
  });
});

describe('CensusApiService accessor', () => {
  it('throws until initCensusApiService has run', async () => {
    vi.resetModules();
    const mod = await import('@/services/census-api/census-api-service.js');
    expect(() => mod.getCensusApiService()).toThrow(/not initialized/);
    mod.initCensusApiService();
    expect(mod.getCensusApiService()).toBeInstanceOf(mod.CensusApiService);
  });

  it('returns the initialized singleton', () => {
    initCensusApiService();
    expect(getCensusApiService()).toBeInstanceOf(CensusApiService);
  });
});
