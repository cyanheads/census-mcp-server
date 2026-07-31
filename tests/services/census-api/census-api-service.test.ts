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
  observeRecordValues,
  padFips,
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

  /**
   * The Census API echoes every predicate it filtered on back as its own column, positioned
   * between the requested variables and the geography hierarchy. Treating those as geography
   * columns would splice industry and size codes into the GEOID.
   */
  it('excludes echoed predicate columns from the composed GEOID', async () => {
    queue([
      ['NAME', 'ESTAB', 'NAICS2017', 'LFO', 'EMPSZES', 'state', 'county'],
      ['King County, Washington', '577', '5112', '001', '001', '53', '033'],
    ]);

    const rows = await service.queryData(
      {
        variables: ['ESTAB'],
        geographyLevel: 'county',
        geographyFips: '033',
        parentFips: '53',
        predicates: { NAICS2017: '5112', LFO: '001', EMPSZES: '001' },
        dataset: 'cbp',
        year: 2023,
      },
      createMockContext(),
    );

    expect(rows[0]?.geographyGeoid).toBe('53033');
    expect(rows[0]?.geographyFips).toBe('033');
    expect(rows[0]?.variables.ESTAB?.estimate).toBe(577);
  });

  /**
   * The applied-default label arrives as an extra column with no marker distinguishing it from
   * a geography column, so leaving it out of the exclusion set splices "European alone" into
   * the GEOID a caller round-trips back into another query.
   */
  it('excludes an applied-default label column from the composed GEOID', async () => {
    queue([
      ['NAME', 'T01001_001N', 'POPGROUP_LABEL', 'state', 'county'],
      ['King County, Washington', '1119875', 'European alone', '53', '033'],
    ]);

    const rows = await service.queryData(
      {
        variables: ['T01001_001N'],
        geographyLevel: 'county',
        geographyFips: '*',
        parentFips: '53',
        defaultLabelColumns: { POPGROUP: 'POPGROUP_LABEL' },
        dataset: 'dec/ddhca',
        year: 2020,
      },
      createMockContext(),
    );

    expect(rows[0]?.geographyGeoid).toBe('53033');
    expect(rows[0]?.geographyFips).toBe('033');
    expect(rows[0]?.appliedFilters).toEqual({ POPGROUP: 'European alone' });
  });

  /**
   * Requesting the bare predicate code in `get=` flips the API from applying one default to
   * enumerating every category of it — 2,996 rows for a single state on dec/ddhca. Only the
   * `_LABEL` attribute echoes the applied default back at one row.
   */
  it('requests the label attribute and never the bare predicate code', async () => {
    queue([
      ['NAME', 'T01001_001N', 'POPGROUP_LABEL', 'state'],
      ['California', '9653100', 'European alone', '06'],
    ]);

    await service.queryData(
      {
        variables: ['T01001_001N'],
        geographyLevel: 'state',
        geographyFips: '06',
        defaultLabelColumns: { POPGROUP: 'POPGROUP_LABEL' },
        dataset: 'dec/ddhca',
        year: 2020,
      },
      createMockContext(),
    );

    const getClause = requestedUrls[0]?.match(/[?&]get=([^&]*)/)?.[1] ?? '';
    expect(decodeURIComponent(getClause)).toBe('NAME,T01001_001N,POPGROUP_LABEL');
    expect(decodeURIComponent(getClause).split(',')).not.toContain('POPGROUP');
  });

  it('carries no appliedFilters when the query set every dimension itself', async () => {
    queue([
      ['NAME', 'T01001_001N', 'POPGROUP', 'state'],
      ['California', '9653100', '1002', '06'],
    ]);

    const rows = await service.queryData(
      {
        variables: ['T01001_001N'],
        geographyLevel: 'state',
        geographyFips: '06',
        predicates: { POPGROUP: '1002' },
        dataset: 'dec/ddhca',
        year: 2020,
      },
      createMockContext(),
    );

    expect(rows[0]?.appliedFilters).toBeUndefined();
    expect(rows[0]?.geographyGeoid).toBe('06');
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

/**
 * A column that holds text used to be coerced with `Number` like every other, so it arrived as
 * `estimate: null` with `suppressed: false` — the same shape a geography with no value has, and
 * with the text itself dropped.
 */
describe('CensusApiService.parseResponse — text values', () => {
  it('keeps a text value the caller can read instead of reporting it as missing', async () => {
    queue([
      ['NAME', 'B19013_001E', 'GEO_ID', 'state', 'county'],
      ['King County, Washington', '122148', '0500000US53033', '53', '033'],
    ]);

    const rows = await query('county', { variables: ['B19013_001E', 'GEO_ID'] });

    expect(rows[0]?.variables.GEO_ID).toEqual({
      estimate: null,
      label: 'GEO_ID',
      suppressed: false,
      value: '0500000US53033',
    });
    // The measure alongside it is untouched.
    expect(rows[0]?.variables.B19013_001E?.estimate).toBe(122148);
    expect(rows[0]?.variables.B19013_001E?.value).toBeUndefined();
  });

  /**
   * `variables.json` declares the ACS median-year codes `predicateType: "string"` and serves them
   * ordinary years, so a fix keyed on the declared type would stop returning a number for them.
   */
  it('leaves a numeric value the dataset declares a string as a number', async () => {
    queue([
      ['NAME', 'B25035_001E', 'state', 'county'],
      ['King County, Washington', '1983', '53', '033'],
    ]);

    const rows = await query('county', { variables: ['B25035_001E'] });

    expect(rows[0]?.variables.B25035_001E?.estimate).toBe(1983);
    expect(rows[0]?.variables.B25035_001E?.value).toBeUndefined();
  });

  it('reports an empty cell as missing rather than as text or as zero', async () => {
    queue([
      ['NAME', 'B19013_001E', 'GEO_ID', 'state', 'county'],
      ['King County, Washington', '', null, '53', '033'],
    ]);

    const rows = await query('county', { variables: ['B19013_001E', 'GEO_ID'] });

    for (const code of ['B19013_001E', 'GEO_ID']) {
      expect(rows[0]?.variables[code]?.estimate).toBeNull();
      expect(rows[0]?.variables[code]?.value).toBeUndefined();
      expect(rows[0]?.variables[code]?.suppressed).toBe(false);
    }
  });

  it('keeps a suppressed cell suppressed rather than reading its sentinel as text', async () => {
    queue([
      ['NAME', 'B19013_001E', 'GEO_ID', 'state', 'tract'],
      [
        'Census Tract 118.02; King County; Washington',
        '-666666666',
        '1400000US53033011802',
        '53',
        '011802',
      ],
    ]);

    const rows = await query('tract', { variables: ['B19013_001E', 'GEO_ID'] });

    expect(rows[0]?.variables.B19013_001E?.suppressed).toBe(true);
    expect(rows[0]?.variables.B19013_001E?.value).toBeUndefined();
    // Suppression and text are separate states, readable side by side on one row.
    expect(rows[0]?.variables.GEO_ID?.suppressed).toBe(false);
    expect(rows[0]?.variables.GEO_ID?.value).toBe('1400000US53033011802');
  });

  it('does not read a text value that names an Object member as a suppression code', async () => {
    queue([
      ['NAME', 'UNIVERSE', 'state'],
      ['Washington', 'constructor', '53'],
    ]);

    const rows = await query('state', { variables: ['UNIVERSE'] });

    expect(rows[0]?.variables.UNIVERSE?.suppressed).toBe(false);
    expect(rows[0]?.variables.UNIVERSE?.suppressionReason).toBeUndefined();
    expect(rows[0]?.variables.UNIVERSE?.value).toBe('constructor');
  });
});

describe('CensusApiService.queryData — record columns', () => {
  /**
   * `pep/charv` publishes an April estimates base and a July estimate for every geography, so a
   * query answers with two rows carrying different numbers. Requesting MONTH and its `_DESC` is
   * what lets a caller tell which row is which; without them the two are identical apart from
   * the value.
   */
  it('labels each row with the record it came from', async () => {
    queue([
      ['NAME', 'POP', 'MONTH', 'MONTH_DESC', 'state'],
      ['Washington', '7705267', '4', 'April', '53'],
      ['Washington', '7724566', '7', 'July', '53'],
    ]);

    const rows = await service.queryData(
      {
        variables: ['POP'],
        geographyLevel: 'state',
        geographyFips: '53',
        recordColumns: { MONTH: 'MONTH_DESC' },
        dataset: 'pep/charv',
        year: 2023,
      },
      createMockContext(),
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]?.record).toEqual({ MONTH: { code: '4', label: 'April' } });
    expect(rows[1]?.record).toEqual({ MONTH: { code: '7', label: 'July' } });
    expect(rows[0]?.variables.POP?.estimate).toBe(7705267);
    expect(rows[1]?.variables.POP?.estimate).toBe(7724566);
    const getClause = requestedUrls[0]?.match(/[?&]get=([^&]*)/)?.[1] ?? '';
    expect(decodeURIComponent(getClause)).toBe('NAME,POP,MONTH,MONTH_DESC');
  });

  /**
   * The GEOID is composed from whatever columns are left once the requested ones are excluded, so
   * a record column that is not excluded gets concatenated into it — "534" instead of "53", which
   * then fails every downstream round-trip.
   */
  it('keeps record columns out of the composed GEOID', async () => {
    queue([
      ['NAME', 'POP', 'MONTH', 'MONTH_DESC', 'state', 'county'],
      ['Adams County, Washington', '20609', '4', 'April', '53', '001'],
    ]);

    const rows = await service.queryData(
      {
        variables: ['POP'],
        geographyLevel: 'county',
        geographyFips: '*',
        parentFips: '53',
        recordColumns: { MONTH: 'MONTH_DESC' },
        dataset: 'pep/charv',
        year: 2023,
      },
      createMockContext(),
    );

    expect(rows[0]?.geographyGeoid).toBe('53001');
    expect(rows[0]?.geographyFips).toBe('001');
  });

  it('carries no record on a dataset that returns one row per geography', async () => {
    queue([
      ['NAME', 'B19013_001E', 'state'],
      ['Washington', '94605', '53'],
    ]);

    const rows = await query('state');

    expect(rows[0]?.record).toBeUndefined();
  });
});

describe('observeRecordValues', () => {
  /**
   * A column that took one value across the response separated nothing; only the ones that took
   * several explain why a geography came back more than once, and their codes are what a caller
   * pins the record with.
   */
  it('collects the distinct values each record column took', () => {
    const observed = observeRecordValues([
      {
        geographyName: 'Washington',
        geographyFips: '53',
        geographyGeoid: '53',
        variables: {},
        record: { MONTH: { code: '7', label: 'July' }, UNIVERSE: { code: 'R', label: 'Resident' } },
      },
      {
        geographyName: 'Washington',
        geographyFips: '53',
        geographyGeoid: '53',
        variables: {},
        record: {
          MONTH: { code: '4', label: 'April' },
          UNIVERSE: { code: 'R', label: 'Resident' },
        },
      },
    ]);

    expect(observed.MONTH).toEqual([
      { code: '4', label: 'April' },
      { code: '7', label: 'July' },
    ]);
    expect(observed.UNIVERSE).toEqual([{ code: 'R', label: 'Resident' }]);
  });
});

describe('CensusApiService.queryData — predicates', () => {
  it('appends each predicate to the request URL as its own query parameter', async () => {
    queue([
      ['NAME', 'ESTAB', 'NAICS2017', 'state', 'county'],
      ['King County, Washington', '577', '5112', '53', '033'],
    ]);

    await service.queryData(
      {
        variables: ['ESTAB'],
        geographyLevel: 'county',
        geographyFips: '033',
        parentFips: '53',
        predicates: { NAICS2017: '5112' },
        dataset: 'cbp',
        year: 2023,
      },
      createMockContext(),
    );

    expect(requestedUrls[0]).toContain('&NAICS2017=5112');
    expect(requestedUrls[0]).toContain('for=county%3A033');
  });

  it('percent-encodes a predicate value so it cannot inject another parameter', async () => {
    queue([
      ['NAME', 'ESTAB', 'state'],
      ['Washington', '1', '53'],
    ]);

    await service.queryData(
      {
        variables: ['ESTAB'],
        geographyLevel: 'state',
        geographyFips: '53',
        predicates: { NAICS2017: '51&key=stolen' },
        dataset: 'cbp',
        year: 2023,
      },
      createMockContext(),
    );

    expect(requestedUrls[0]).toContain('&NAICS2017=51%26key%3Dstolen');
    expect(requestedUrls[0]?.match(/[?&]key=/g)).toHaveLength(1);
  });

  it('sends no predicate parameters when none were supplied', async () => {
    queue([
      ['NAME', 'B19013_001E', 'state'],
      ['Washington', '95000', '53'],
    ]);

    await query('state', { geographyFips: '53' });

    expect(requestedUrls[0]).not.toContain('&NAICS');
  });
});

describe('CensusApiService.parseResponse — margin-of-error pairing', () => {
  it('pairs a requested E value with its requested M value on ACS', async () => {
    queue([
      ['NAME', 'B19013_001E', 'B19013_001M', 'state'],
      ['Washington', '95000', '812', '53'],
    ]);

    const rows = await service.queryData(
      {
        variables: ['B19013_001E', 'B19013_001M'],
        geographyLevel: 'state',
        geographyFips: '53',
        dataset: 'acs/acs5',
        year: 2024,
      },
      createMockContext(),
    );

    expect(rows[0]?.variables.B19013_001E?.moe).toBe(812);
  });

  /**
   * Outside ACS the E/M suffix carries no estimate/margin relationship, so two codes that
   * happen to share a stem are unrelated variables — pairing them would report a margin of
   * error on a value that has none.
   */
  it('leaves two same-stem codes unpaired outside ACS', async () => {
    queue([
      ['NAME', 'INVTOTE', 'INVTOTM', 'state'],
      ['Washington', '5000', '7000', '53'],
    ]);

    const rows = await service.queryData(
      {
        variables: ['INVTOTE', 'INVTOTM'],
        geographyLevel: 'state',
        geographyFips: '53',
        dataset: 'ecnbasic',
        year: 2022,
      },
      createMockContext(),
    );

    expect(rows[0]?.variables.INVTOTE?.moe).toBeUndefined();
    expect(rows[0]?.variables.INVTOTE?.estimate).toBe(5000);
    expect(rows[0]?.variables.INVTOTM?.estimate).toBe(7000);
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

  /**
   * The mirror of the missing-parent case. `zip code tabulation area` names no parent at all,
   * so the `in=state:53` clause built from a supplied state is a hierarchy the Census API
   * answers with an opaque 400 — the same cached metadata already rules it out.
   */
  it('rejects a state parent on a level that names no parent', async () => {
    await expect(check('zip code tabulation area', { parentFips: '53' })).resolves.toEqual({
      status: 'parent_not_accepted',
      unacceptedParents: ['state'],
      acceptedParents: [],
    });
  });

  it('rejects a county parent on a level whose only parent is state', async () => {
    await expect(
      check('state legislative district (upper chamber)', { parentFips: '53', countyFips: '033' }),
    ).resolves.toEqual({
      status: 'parent_not_accepted',
      unacceptedParents: ['county'],
      acceptedParents: ['state'],
    });
  });

  it('names both parents when a level that takes neither was given both', async () => {
    await expect(
      check('zip code tabulation area', { parentFips: '53', countyFips: '033' }),
    ).resolves.toEqual({
      status: 'parent_not_accepted',
      unacceptedParents: ['state', 'county'],
      acceptedParents: [],
    });
  });

  /**
   * Acceptance is a property of the level, not of the `*` relaxation: a wildcard changes which
   * parents are mandatory, never which ones are allowed. `tract` names county under
   * optionalWithWCFor, so a `*` target drops it from the mandatory set — reading acceptance off
   * that relaxed set would reject the county scope on the most ordinary tract comparison there
   * is, one the live API answers.
   */
  it('still accepts a parent the wildcard made optional', async () => {
    await expect(
      check('tract', { geographyFips: '*', parentFips: '53', countyFips: '033' }),
    ).resolves.toEqual({ status: 'ok' });
    await expect(
      check('block group', { geographyFips: '*', parentFips: '53', countyFips: '033' }),
    ).resolves.toEqual({ status: 'ok' });
  });

  /**
   * A level can be under-scoped and over-scoped at once. The missing parent is the actionable
   * half — reporting the unaccepted one first sends the caller to drop an input and hit
   * `parent_required` on the retry.
   */
  it('reports a missing required parent ahead of an unaccepted one', async () => {
    await expect(
      check('state legislative district (upper chamber)', { countyFips: '033' }),
    ).resolves.toMatchObject({
      status: 'parent_required',
      missingParents: ['state'],
    });
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

describe('CensusApiService.fetchPredicateValues', () => {
  const enumerate = (overrides: Record<string, unknown> = {}) =>
    service.fetchPredicateValues(
      {
        dataset: 'cbp',
        year: 2023,
        code: 'EMPSZES',
        labelAttribute: 'EMPSZES_LABEL',
        ...overrides,
      },
      createMockContext(),
    );

  it('reads the wildcard group-by response into labeled codes', async () => {
    queue([
      ['EMPSZES_LABEL', 'EMPSZES', 'us'],
      ['All establishments', '001', '1'],
      ['Establishments with less than 5 employees', '210', '1'],
    ]);

    await expect(enumerate()).resolves.toEqual([
      { code: '001', label: 'All establishments' },
      { code: '210', label: 'Establishments with less than 5 employees' },
    ]);
    expect(requestedUrls[0]).toContain('EMPSZES=*');
    expect(requestedUrls[0]).toContain('get=EMPSZES_LABEL');
  });

  /**
   * A dimension's own label column is answerable from the dataset's published value map, so a
   * label-only wildcard on dec/ddhca reports all 5,543 declared POPGROUP codes. Naming a measure
   * instead forces the read against the data file, which answers with the ones it publishes.
   */
  it('requests the measure in place of the label column when one is given', async () => {
    queue([
      ['T01001_001N', 'POPGROUP', 'us'],
      ['9653100', '1002', '1'],
    ]);

    await expect(
      enumerate({
        dataset: 'dec/ddhca',
        year: 2020,
        code: 'POPGROUP',
        labelAttribute: 'POPGROUP_LABEL',
        measure: 'T01001_001N',
      }),
    ).resolves.toEqual([{ code: '1002', label: '1002' }]);
    expect(requestedUrls[0]).toContain('get=T01001_001N');
    expect(requestedUrls[0]).not.toContain('POPGROUP_LABEL');
  });

  /**
   * The checked and unchecked answers to the same dimension are different lists, so sharing one
   * cache slot would serve whichever ran first to both callers.
   */
  it('caches the measure-backed enumeration separately from the label-backed one', async () => {
    queue(
      [
        ['POPGROUP_LABEL', 'POPGROUP', 'us'],
        ['Total population', '001', '1'],
        ['European alone', '1002', '1'],
      ],
      [
        ['T01001_001N', 'POPGROUP', 'us'],
        ['9653100', '1002', '1'],
      ],
    );

    const base = { dataset: 'dec/ddhca', year: 2020, code: 'POPGROUP' };
    const declared = await enumerate({ ...base, labelAttribute: 'POPGROUP_LABEL' });
    const published = await enumerate({ ...base, measure: 'T01001_001N' });

    expect(declared.map((v) => v.code)).toEqual(['001', '1002']);
    expect(published.map((v) => v.code)).toEqual(['1002']);
    expect(requestedUrls).toHaveLength(2);
  });

  /** A wildcarded dimension repeats each code once per combination of the others. */
  it('returns each code once even when the response repeats it', async () => {
    queue([
      ['YEAR', 'YEAR', 'us'],
      ['2020', '2020', '1'],
      ['2020', '2020', '1'],
      ['2021', '2021', '1'],
    ]);

    const values = await service.fetchPredicateValues(
      { dataset: 'pep/charv', year: 2023, code: 'YEAR' },
      createMockContext(),
    );

    expect(values).toEqual([
      { code: '2020', label: '2020' },
      { code: '2021', label: '2021' },
    ]);
  });

  it('scopes the enumeration by an industry when one is supplied', async () => {
    queue([
      ['TAXSTAT_LABEL', 'TAXSTAT', 'NAICS2022', 'us'],
      ['All establishments', '00', '62', '1'],
      ['Establishments subject to federal income tax', 'T', '62', '1'],
    ]);

    const values = await service.fetchPredicateValues(
      {
        dataset: 'ecnbasic',
        year: 2022,
        code: 'TAXSTAT',
        labelAttribute: 'TAXSTAT_LABEL',
        naicsScope: { code: 'NAICS2022', value: '62' },
      },
      createMockContext(),
    );

    expect(values).toHaveLength(2);
    expect(requestedUrls[0]).toContain('&NAICS2022=62');
  });

  it('reads a 204 as no codes rather than an unparseable response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
    );

    await expect(enumerate()).resolves.toEqual([]);
  });

  it('serves a repeat dimension from cache but refetches for a different industry scope', async () => {
    queue(
      [
        ['EMPSZES_LABEL', 'EMPSZES', 'us'],
        ['All establishments', '001', '1'],
      ],
      [
        ['EMPSZES_LABEL', 'EMPSZES', 'NAICS2017', 'us'],
        ['All establishments', '001', '62', '1'],
      ],
    );

    await enumerate();
    await enumerate();
    expect(requestedUrls).toHaveLength(1);

    await enumerate({ naicsScope: { code: 'NAICS2017', value: '62' } });
    expect(requestedUrls).toHaveLength(2);
  });
});

describe('padFips', () => {
  /**
   * The Census API compares FIPS literally, so `state:5` finds nothing where `state:05` finds
   * Arkansas. Both parent inputs have a fixed width, which makes padding unambiguous.
   */
  it('zero-pads a short code to the width the Census stores', () => {
    expect(padFips('5', 2)).toBe('05');
    expect(padFips('51', 3)).toBe('051');
  });

  it('leaves a full-width code alone', () => {
    expect(padFips('05', 2)).toBe('05');
    expect(padFips('051', 3)).toBe('051');
  });

  it('reads a blank or absent value as omitted', () => {
    expect(padFips('', 2)).toBeUndefined();
    expect(padFips('   ', 2)).toBeUndefined();
    expect(padFips(undefined, 2)).toBeUndefined();
  });

  /**
   * `in=state:53 county:*` is the only hierarchy that reaches every block group in a state, so
   * `*` has to survive as itself — padded it becomes `00*`, which matches no county.
   */
  it('passes a wildcard scope through unpadded', () => {
    expect(padFips('*', 2)).toBe('*');
    expect(padFips('*', 3)).toBe('*');
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
