/**
 * @fileoverview Tests for CensusApiService — GEOID composition in parseResponse across
 * geography levels, and the geography.json-driven parent pre-validation in checkGeography.
 * @module tests/services/census-api/census-api-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CensusApiService,
  describeColumnBudget,
  describeColumnLimit,
  getCensusApiService,
  getColumnsFor,
  initCensusApiService,
  normalizePredicates,
  normalizeVariableCodes,
  observeRecordValues,
  padFips,
  planQueryColumns,
} from '@/services/census-api/census-api-service.js';

vi.mock('@/config/server-config.js', () => ({
  getDiscoveryConfig: vi.fn(() => ({ defaultYear: 2024, variableCacheTtlHours: 24 })),
  getServerConfig: vi.fn(() => ({
    defaultYear: 2024,
    censusApiKey: 'test-key',
    variableCacheTtlHours: 24,
  })),
}));

/**
 * Bodies handed out in call order. A queued `Response` is served as-is, which is how a non-2xx
 * status and its body are staged; anything else is served as a 200 JSON body. A request past the
 * end of the queue rejects, so a test cannot pass on a request it never staged.
 */
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
      if (responses.length === 0) return Promise.reject(new Error('unmocked fetch'));
      const body = responses.shift();
      if (body instanceof Response) return Promise.resolve(body);
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});

/** The `get=` list of the n-th request, decoded and split. */
const getColumns = (n = 0) =>
  decodeURIComponent(requestedUrls[n]?.match(/[?&]get=([^&]*)/)?.[1] ?? '').split(',');

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

  it('scopes a block group by its tract after the county in the in= clause', async () => {
    queue([
      ['NAME', 'B19013_001E', 'state', 'county', 'tract', 'block group'],
      [
        'Block Group 2; Census Tract 71.01; King County; Washington',
        '136034',
        '53',
        '033',
        '007101',
        '2',
      ],
    ]);

    const rows = await query('block group', {
      geographyFips: '2',
      parentFips: '53',
      countyFips: '033',
      tractFips: '007101',
    });

    expect(requestedUrls[0]).toContain(
      '&for=block%20group%3A2&in=state:53%20county:033%20tract:007101&',
    );
    expect(rows.map((r) => r.geographyGeoid)).toEqual(['530330071012']);
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
    expect(rows[0]?.variables.B19013_001E?.suppressionReason).toMatch(
      /too few sample observations/i,
    );
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
  params: {
    geographyFips?: string;
    parentFips?: string;
    countyFips?: string;
    tractFips?: string;
  } = {},
) =>
  service.checkGeography(
    {
      dataset: 'acs/acs5',
      year: 2023,
      geographyLevel,
      geographyFips: params.geographyFips ?? '*',
      ...(params.parentFips !== undefined && { parentFips: params.parentFips }),
      ...(params.countyFips !== undefined && { countyFips: params.countyFips }),
      ...(params.tractFips !== undefined && { tractFips: params.tractFips }),
    },
    createMockContext(),
  );

describe('CensusApiService.checkGeography', () => {
  beforeEach(() => {
    queue(geographyJson);
  });

  it('accepts a level with no parent requirements', async () => {
    await expect(check('state')).resolves.toEqual({ status: 'ok', acceptedParents: [] });
  });

  it('accepts a wildcard county query with no parent — the API infers the state', async () => {
    await expect(check('county')).resolves.toEqual({ status: 'ok', acceptedParents: ['state'] });
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
    await expect(check('tract', { parentFips: '53' })).resolves.toEqual({
      status: 'ok',
      acceptedParents: ['state', 'county'],
    });
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
      acceptedParents: ['state', 'county', 'tract'],
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
    await expect(check('County')).resolves.toEqual({ status: 'ok', acceptedParents: ['state'] });
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
    ).resolves.toEqual({ status: 'ok', acceptedParents: ['state', 'county'] });
    await expect(
      check('block group', { geographyFips: '*', parentFips: '53', countyFips: '033' }),
    ).resolves.toEqual({ status: 'ok', acceptedParents: ['state', 'county', 'tract'] });
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

  describe('a tract scope', () => {
    const bgScope = { parentFips: '53', countyFips: '033', tractFips: '007101' };

    it('satisfies the tract parent a single block group needs', async () => {
      await expect(check('block group', { ...bgScope, geographyFips: '2' })).resolves.toEqual({
        status: 'ok',
        acceptedParents: ['state', 'county', 'tract'],
      });
    });

    it('narrows a wildcard block-group query to one tract', async () => {
      await expect(check('block group', bgScope)).resolves.toEqual({
        status: 'ok',
        acceptedParents: ['state', 'county', 'tract'],
      });
    });

    it.each(['2', '*'])('requires the county a tract sits in (block group %s)', async (fips) => {
      await expect(
        check('block group', { geographyFips: fips, parentFips: '53', tractFips: '007101' }),
      ).resolves.toEqual({
        status: 'parent_required',
        missingParents: ['county'],
        wildcardRelaxes: false,
      });
    });

    /** Upstream answers `county:* tract:007101` with HTTP 400 "wildcard mismatch". */
    it('requires a concrete county, not "*", under a tract scope', async () => {
      await expect(
        check('block group', { ...bgScope, countyFips: '*', geographyFips: '2' }),
      ).resolves.toEqual({
        status: 'parent_required',
        missingParents: ['county'],
        wildcardRelaxes: false,
      });
    });

    it.each([
      ['tract', bgScope, ['state', 'county']],
      ['county', { parentFips: '53', tractFips: '007101' }, ['state']],
    ])(
      'rejects a tract scope on the %s level, which does not sit in a tract',
      async (level, scope, accepted) => {
        await expect(check(level, scope)).resolves.toEqual({
          status: 'parent_not_accepted',
          unacceptedParents: ['tract'],
          acceptedParents: accepted,
        });
      },
    );
  });

  it('defers to the data call when the dataset+year has no geography metadata', async () => {
    // A 404 from geography.json (unavailable year) yields an empty level list.
    responses = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('', { status: 404 }))),
    );
    // With no metadata there is no list of parents to report either.
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

/**
 * The Census estimate and annotation values table
 * (census.gov/data/developers/data-sets/acs-1year/notes-on-acs-estimate-and-annotation-values.html)
 * is the source for every meaning below. Rows are real King County / Harris County / Alabama
 * responses captured from `acs/acs5` and `acs/acs1/subject` 2024.
 */
describe('CensusApiService.parseResponse — ACS sentinel values', () => {
  const acs = (
    header: string[],
    row: Array<string | null>,
    variables: string[],
    dataset = 'acs/acs5',
    level = 'tract',
  ) => {
    queue([header, row]);
    return service.queryData(
      {
        variables,
        geographyLevel: level,
        geographyFips: '*',
        parentFips: '53',
        dataset,
        year: 2024,
      },
      createMockContext(),
    );
  };

  /**
   * Subject and profile percent columns write the sentinels as floats. An exact string lookup
   * resolved `-666666666` and left `-666666666.0` in the same row suppressed with no reason.
   */
  it('resolves a decimal sentinel to the same reason as its integer form', async () => {
    const rows = await acs(
      [
        'NAME',
        'S1701_C03_001E',
        'S1701_C03_001M',
        'S1903_C03_001E',
        'S1903_C03_001M',
        'state',
        'county',
        'tract',
      ],
      [
        'Census Tract 9901; King County; Washington',
        '-666666666.0',
        '-222222222.0',
        '-666666666',
        '-222222222',
        '53',
        '033',
        '990100',
      ],
      ['S1701_C03_001E', 'S1701_C03_001M', 'S1903_C03_001E', 'S1903_C03_001M'],
      'acs/acs5/subject',
    );

    const v = rows[0]?.variables ?? {};
    expect(v.S1701_C03_001E?.suppressionReason).toBeDefined();
    expect(v.S1701_C03_001E?.suppressionReason).toBe(v.S1903_C03_001E?.suppressionReason);
    expect(v.S1701_C03_001M?.suppressionReason).toBe(v.S1903_C03_001M?.suppressionReason);
    expect(v.S1701_C03_001E?.suppressionReason).toMatch(/could not be computed|not computable/i);
    expect(v.S1701_C03_001M?.suppressionReason).toMatch(/margin of error/i);
  });

  it('words each sentinel the way the Census table defines it', async () => {
    const rows = await acs(
      ['NAME', 'A_001E', 'A_002E', 'A_003E', 'A_004M', 'A_005M', 'state', 'county'],
      [
        'Calhoun County, Alabama',
        '-666666666',
        '-999999999',
        '-888888888',
        '-222222222',
        '-333333333',
        '01',
        '015',
      ],
      ['A_001E', 'A_002E', 'A_003E', 'A_004M', 'A_005M'],
      'acs/acs1/subject',
      'county',
    );

    const v = rows[0]?.variables ?? {};
    expect(v.A_001E?.suppressionReason).toMatch(/too few sample observations/i);
    expect(v.A_002E?.suppressionReason).toMatch(/cannot be displayed/i);
    expect(v.A_003E?.suppressionReason).toMatch(/not applicable or not available/i);
    expect(v.A_004M?.suppressionReason).toMatch(/margin of error.*too few sample observations/i);
    expect(v.A_005M?.suppressionReason).toMatch(/open-ended/i);
    // None of the wrong meanings the lookup used to carry survive.
    const reasons = Object.values(v).map((x) => x.suppressionReason ?? '');
    for (const wrong of [/revised or superseded/i, /geography too small/i, /^Not applicable$/]) {
      expect(reasons.some((r) => wrong.test(r))).toBe(false);
    }
    for (const x of Object.values(v)) {
      expect(x.suppressed).toBe(true);
      expect(x.estimate).toBeNull();
    }
  });

  /**
   * `-555555555` means the estimate is controlled to an independent count and "the margin of
   * error may be treated as zero" — the 2009 vintage writes the same county MOE as a literal 0.
   */
  it('reads a controlled-estimate MOE as zero and pairs it with its estimate', async () => {
    const rows = await acs(
      ['NAME', 'B01003_001E', 'B01003_001M', 'B01003_001EA', 'B01003_001MA', 'state', 'county'],
      ['King County, Washington', '2287171', '-555555555', null, '*****', '53', '033'],
      ['B01003_001E', 'B01003_001M', 'B01003_001EA', 'B01003_001MA'],
      'acs/acs5',
      'county',
    );

    const v = rows[0]?.variables ?? {};
    expect(v.B01003_001M).toMatchObject({ estimate: 0, suppressed: false });
    expect(v.B01003_001M?.suppressionReason).toBeUndefined();
    expect(v.B01003_001E).toMatchObject({ estimate: 2287171, moe: 0, suppressed: false });
    // The annotation column is text and stays text.
    expect(v.B01003_001MA).toMatchObject({ estimate: null, value: '*****', suppressed: false });
  });

  /**
   * A median in an open-ended interval is published as the interval's boundary (`250001` for
   * "250,000+", `9999` for "10,000-"), and only the `-333333333` MOE says so. The figure is kept —
   * it is a bound on the true median and ranks correctly as one — and the estimate is flagged.
   */
  it('keeps a top-coded median and marks it open-ended when its MOE is -333333333', async () => {
    const rows = await acs(
      [
        'NAME',
        'B19013_001E',
        'B19013_001M',
        'B19013_001EA',
        'B19013_001MA',
        'state',
        'county',
        'tract',
      ],
      [
        'Census Tract 41.01; King County; Washington',
        '250001',
        '-333333333',
        '250,000+',
        '***',
        '53',
        '033',
        '004101',
      ],
      ['B19013_001E', 'B19013_001M', 'B19013_001EA', 'B19013_001MA'],
    );

    const v = rows[0]?.variables ?? {};
    expect(v.B19013_001E).toMatchObject({
      estimate: 250001,
      moe: null,
      openEnded: true,
      suppressed: false,
    });
    expect(v.B19013_001M?.suppressed).toBe(true);
    expect(v.B19013_001M?.suppressionReason).toMatch(/open-ended/i);
    expect(v.B19013_001EA).toMatchObject({ value: '250,000+', suppressed: false });
    expect(v.B19013_001EA?.suppressionReason).toBeUndefined();
  });

  it('marks a bottom-coded median open-ended the same way', async () => {
    const rows = await acs(
      ['NAME', 'B25077_001E', 'B25077_001M', 'state', 'county', 'tract'],
      ['Census Tract 4320.06; Harris County; Texas', '9999', '-333333333', '48', '201', '432006'],
      ['B25077_001E', 'B25077_001M'],
    );

    expect(rows[0]?.variables.B25077_001E).toMatchObject({ estimate: 9999, openEnded: true });
  });

  it('leaves an ordinary estimate and MOE pair unmarked', async () => {
    const rows = await acs(
      ['NAME', 'B19013_001E', 'B19013_001M', 'state', 'county', 'tract'],
      ['Census Tract 1.01; King County; Washington', '69577', '14341', '53', '033', '000101'],
      ['B19013_001E', 'B19013_001M'],
    );

    expect(rows[0]?.variables.B19013_001E).toEqual({
      estimate: 69577,
      moe: 14341,
      label: 'B19013_001E',
      suppressed: false,
    });
  });

  /**
   * The table is the ACS one. Other families withhold through flag columns rather than negative
   * sentinels, so a value that low outside ACS is still withheld — but with no borrowed meaning,
   * and a `-555555555` there is not a controlled MOE.
   */
  it('keeps the ACS meanings, zero MOE, and open_ended off the other families', async () => {
    queue([
      ['NAME', 'POP', 'POPM', 'state'],
      ['Washington', '-666666666', '-555555555', '53'],
    ]);
    const rows = await service.queryData(
      {
        variables: ['POP', 'POPM'],
        geographyLevel: 'state',
        geographyFips: '53',
        dataset: 'pep/charv',
        year: 2023,
      },
      createMockContext(),
    );

    for (const code of ['POP', 'POPM']) {
      expect(rows[0]?.variables[code]).toMatchObject({ estimate: null, suppressed: true });
      expect(rows[0]?.variables[code]?.suppressionReason).toBeUndefined();
    }
  });

  it('never resolves a text cell to a sentinel reason', async () => {
    const rows = await acs(
      ['NAME', 'DP02_0070E', 'B19013_001EA', 'GEO_ID', 'state', 'county'],
      ['King County, Washington', '(X)', '250,000+', '0500000US53033', '53', '033'],
      ['DP02_0070E', 'B19013_001EA', 'GEO_ID'],
      'acs/acs5/profile',
      'county',
    );

    const v = rows[0]?.variables ?? {};
    expect(v.DP02_0070E).toMatchObject({ value: '(X)', suppressed: false });
    expect(v.B19013_001EA).toMatchObject({ value: '250,000+', suppressed: false });
    expect(v.GEO_ID).toMatchObject({ value: '0500000US53033', suppressed: false });
    for (const code of ['DP02_0070E', 'B19013_001EA', 'GEO_ID']) {
      expect(v[code]?.suppressionReason).toBeUndefined();
      expect(v[code]?.estimate).toBeNull();
    }
  });
});

describe('CensusApiService.queryData — unknown variable rejection', () => {
  const rejectWith = (body: string, status = 400) =>
    new Response(body, { status, headers: { 'content-type': 'text/plain' } });

  it('reports an unknown variable the caller sent as variable_not_found, without retrying', async () => {
    queue(rejectWith("error: unknown variable 'B19013_001X'"));

    const error = await query('county', {
      variables: ['B19013_001X'],
      geographyFips: '033',
      parentFips: '53',
    }).then(
      () => undefined,
      (err: { code: number; data: Record<string, unknown>; message: string }) => err,
    );

    expect(error?.code).toBe(-32001);
    expect(error?.data).toMatchObject({
      reason: 'variable_not_found',
      missingCodes: ['B19013_001X'],
      dataset: 'acs/acs5',
      year: 2023,
    });
    expect(error?.message).toContain('B19013_001X');
    expect(error?.data).toMatchObject({
      recovery: { hint: expect.stringContaining('census_search_variables') },
    });
    expect(error?.data.retryable).not.toBe(true);
    expect(requestedUrls).toHaveLength(1);
  });

  it.each([
    ["error: unknown predicate variable: 'FOO'"],
    ['error: unknown/unsupported geography hierarchy'],
    ["error: 'get' is limited to 50 variables"],
  ])('keeps a different 400 (%s) on upstream_error', async (body) => {
    queue(rejectWith(body));

    await expect(query('county', { geographyFips: '033', parentFips: '53' })).rejects.toMatchObject(
      {
        data: { reason: 'upstream_error', status: 400, upstreamMessage: body },
      },
    );
  });

  /**
   * NAME, label, record, and flag columns are the server's own additions. Naming one of them as
   * the caller's missing code would send the caller hunting for a code they never passed.
   */
  it('does not blame the caller for an unknown column the server added', async () => {
    queue(rejectWith("error: unknown variable 'NAME'"));

    await expect(query('county', { geographyFips: '033', parentFips: '53' })).rejects.toMatchObject(
      {
        data: { reason: 'upstream_error' },
      },
    );
  });

  it('still retries a 5xx and reports it as upstream_error when it persists', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      queue(
        rejectWith('upstream unavailable', 503),
        rejectWith('upstream unavailable', 503),
        rejectWith('upstream unavailable', 503),
        rejectWith('upstream unavailable', 503),
      );
      const pending = query('county', { geographyFips: '033', parentFips: '53' }).then(
        () => undefined,
        (err: { code: number; data: Record<string, unknown> }) => err,
      );
      await vi.advanceTimersByTimeAsync(60_000);
      const error = await pending;

      expect(error?.code).toBe(-32000);
      expect(error?.data).toMatchObject({ reason: 'upstream_error', status: 503 });
      expect(requestedUrls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The business datasets withhold a cell by writing `0` in the measure and a symbol in its `_F`
 * column. Rows are the live `ecnbasic` 2022 `NAICS2022=622` (hospitals) response for Washington
 * counties: Chelan's receipts are withheld (`D`), Pierce's employment is withheld with a range
 * (`j` = 10,000 to 24,999 employees).
 */
describe('CensusApiService.parseResponse — business-dataset flag columns', () => {
  const ecnbasic = async (rows: Array<Array<string | null>>) => {
    queue([
      ['NAME', 'ESTAB', 'RCPTOT', 'EMP', 'RCPTOT_F', 'EMP_F', 'NAICS2022', 'state', 'county'],
      ...rows,
    ]);
    return service.queryData(
      {
        variables: ['ESTAB', 'RCPTOT', 'EMP'],
        geographyLevel: 'county',
        geographyFips: '*',
        parentFips: '53',
        predicates: { NAICS2022: '622' },
        flagColumns: { RCPTOT: 'RCPTOT_F', EMP: 'EMP_F' },
        dataset: 'ecnbasic',
        year: 2022,
      },
      createMockContext(),
    );
  };

  it('reports a withheld cell as suppressed with the flag meaning, never as a zero', async () => {
    const rows = await ecnbasic([
      ['Chelan County, Washington', '4', '0', '2955', 'D', null, '622', '53', '007'],
      ['Pierce County, Washington', '11', '0', '0', 'D', 'j', '622', '53', '053'],
      ['King County, Washington', '25', '14293515', '54853', null, null, '622', '53', '033'],
    ]);

    const [chelan, pierce, king] = rows;
    expect(chelan?.variables.RCPTOT).toMatchObject({
      estimate: null,
      suppressed: true,
      flag: { code: 'D' },
    });
    expect(chelan?.variables.RCPTOT?.suppressionReason).toMatch(/withheld to avoid disclosing/i);
    // Unflagged cells beside it keep their numbers.
    expect(chelan?.variables.EMP).toMatchObject({ estimate: 2955, suppressed: false });
    expect(chelan?.variables.EMP?.flag).toBeUndefined();
    expect(chelan?.variables.ESTAB?.estimate).toBe(4);

    expect(pierce?.variables.EMP).toMatchObject({
      estimate: null,
      suppressed: true,
      flag: { code: 'j' },
    });
    expect(pierce?.variables.EMP?.suppressionReason).toContain('10,000 to 24,999 employees');

    expect(king?.variables.RCPTOT).toMatchObject({ estimate: 14293515, suppressed: false });
    expect(king?.variables.RCPTOT?.flag).toBeUndefined();

    // The flag columns are neither geography columns nor variables of their own.
    expect(rows.map((r) => r.geographyGeoid)).toEqual(['53007', '53053', '53033']);
    expect(chelan?.variables).not.toHaveProperty('RCPTOT_F');
    expect(getColumns()).toEqual(['NAME', 'ESTAB', 'RCPTOT', 'EMP', 'RCPTOT_F', 'EMP_F']);
  });

  /** `s` (relative standard error above 40%) annotates a published figure — ecnbasic 2012 WA ESTAB 53. */
  it('keeps a published figure whose flag is a quality note and carries the note', async () => {
    const rows = await ecnbasic([
      ['Somewhere, Washington', '53', '1200', '40', 's', null, '622', '53', '999'],
    ]);

    expect(rows[0]?.variables.RCPTOT).toMatchObject({
      estimate: 1200,
      suppressed: false,
      flag: { code: 's' },
    });
    expect(rows[0]?.variables.RCPTOT?.flag?.meaning).toMatch(/relative standard error/i);
  });

  it('treats a symbol with no published meaning as withheld rather than trusting the zero', async () => {
    const rows = await ecnbasic([
      ['Somewhere, Washington', '3', '0', '12', '~', null, '622', '53', '999'],
    ]);

    expect(rows[0]?.variables.RCPTOT).toMatchObject({
      estimate: null,
      suppressed: true,
      flag: { code: '~' },
    });
    expect(rows[0]?.variables.RCPTOT?.suppressionReason).toContain('"~"');
  });

  /**
   * The range columns publish their answer in the flag and hold `0` in the measure: `ecnbasic`
   * `RCPTOT_IMP` ("Range indicating percent … imputed") carries a digit band, and `cbp` `EMP_N`
   * ("Noise range for number of employees") a noise letter. Values are from the live `ecnbasic`
   * 2022 King County (NAICS2022=62) and `cbp` 2023 King County responses.
   */
  it('reads the zero beside a range flag as a range, not as the number 0', async () => {
    queue([
      ['NAME', 'RCPTOT', 'RCPTOT_IMP', 'EMP_N', 'RCPTOT_IMP_F', 'EMP_N_F', 'state', 'county'],
      ['King County, Washington', '31688958', '0', '0', '2', 'G', '53', '033'],
    ]);
    const rows = await service.queryData(
      {
        variables: ['RCPTOT', 'RCPTOT_IMP', 'EMP_N'],
        geographyLevel: 'county',
        geographyFips: '033',
        parentFips: '53',
        flagColumns: { RCPTOT_IMP: 'RCPTOT_IMP_F', EMP_N: 'EMP_N_F' },
        dataset: 'ecnbasic',
        year: 2022,
      },
      createMockContext(),
    );

    const v = rows[0]?.variables ?? {};
    expect(v.RCPTOT_IMP).toMatchObject({ estimate: null, suppressed: true, flag: { code: '2' } });
    expect(v.RCPTOT_IMP?.suppressionReason).toMatch(/range.*20% to less than 30%/i);
    expect(v.EMP_N).toMatchObject({ estimate: null, suppressed: true, flag: { code: 'G' } });
    expect(v.EMP_N?.suppressionReason).toMatch(/range.*less than 2%/i);
    expect(v.RCPTOT).toMatchObject({ estimate: 31688958, suppressed: false });
  });

  it('keeps a nonzero figure a range flag rides beside, and carries the flag', async () => {
    const rows = await ecnbasic([
      ['Somewhere, Washington', '53', '1200', '40', 'H', null, '622', '53', '999'],
    ]);

    expect(rows[0]?.variables.RCPTOT).toMatchObject({
      estimate: 1200,
      suppressed: false,
      flag: { code: 'H' },
    });
  });
});

/**
 * A predicate value of `*` turns the dimension into a group-by. The API echoes the dimension's
 * code on every row; its own `_LABEL`/`_DESC` column adds the label without changing which rows
 * come back (1,552 rows for King County `NAICS2017=*` either way).
 */
describe('CensusApiService.queryData — wildcarded dimensions', () => {
  it('labels each per-category row with the code and label of its category', async () => {
    queue([
      ['NAME', 'ESTAB', 'NAICS2017_LABEL', 'NAICS2017', 'LFO', 'EMPSZES', 'state', 'county'],
      [
        'King County, Washington',
        '93517',
        'Total for all sectors',
        '00',
        '001',
        '001',
        '53',
        '033',
      ],
      [
        'King County, Washington',
        '177',
        'Agriculture, forestry, fishing and hunting',
        '11',
        '001',
        '001',
        '53',
        '033',
      ],
      [
        'King County, Washington',
        '12',
        'Support activities for crop production',
        '1151',
        '001',
        '001',
        '53',
        '033',
      ],
    ]);

    const rows = await service.queryData(
      {
        variables: ['ESTAB'],
        geographyLevel: 'county',
        geographyFips: '033',
        parentFips: '53',
        predicates: { NAICS2017: '*', LFO: '001', EMPSZES: '001' },
        wildcardColumns: [{ code: 'NAICS2017', labelColumn: 'NAICS2017_LABEL' }],
        dataset: 'cbp',
        year: 2023,
      },
      createMockContext(),
    );

    expect(rows.map((r) => r.record)).toEqual([
      { NAICS2017: { code: '00', label: 'Total for all sectors' } },
      { NAICS2017: { code: '11', label: 'Agriculture, forestry, fishing and hunting' } },
      { NAICS2017: { code: '1151', label: 'Support activities for crop production' } },
    ]);
    expect(rows.map((r) => r.geographyGeoid)).toEqual(['53033', '53033', '53033']);
    expect(rows[1]?.variables).toEqual({
      ESTAB: { estimate: 177, label: 'ESTAB', suppressed: false },
    });
    // Only the label column is requested; the code arrives as the predicate echo.
    expect(getColumns()).toEqual(['NAME', 'ESTAB', 'NAICS2017_LABEL']);
  });

  it('falls back to the code for a dimension that publishes no label column', async () => {
    queue([
      ['NAME', 'POP', 'MONTH', 'MONTH_DESC', 'YEAR', 'state'],
      ['Washington', '7724566', '7', 'July', '2020', '53'],
      ['Washington', '7812880', '7', 'July', '2023', '53'],
    ]);

    const rows = await service.queryData(
      {
        variables: ['POP'],
        geographyLevel: 'state',
        geographyFips: '53',
        predicates: { MONTH: '7', YEAR: '*' },
        recordColumns: { MONTH: 'MONTH_DESC' },
        wildcardColumns: [{ code: 'YEAR' }],
        dataset: 'pep/charv',
        year: 2023,
      },
      createMockContext(),
    );

    expect(rows.map((r) => r.record)).toEqual([
      { MONTH: { code: '7', label: 'July' }, YEAR: { code: '2020', label: '2020' } },
      { MONTH: { code: '7', label: 'July' }, YEAR: { code: '2023', label: '2023' } },
    ]);
    expect(rows.map((r) => r.geographyGeoid)).toEqual(['53', '53']);
    expect(getColumns()).toEqual(['NAME', 'POP', 'MONTH', 'MONTH_DESC']);
  });
});

describe('normalizePredicates', () => {
  it('uppercases keys, trims values, and drops a blank value as omitted', () => {
    expect(normalizePredicates({ naics2017: ' 5112 ', LFO: '', EMPSZES: '   ', sex: '1' })).toEqual(
      { predicates: { NAICS2017: '5112', SEX: '1' }, wildcards: [] },
    );
  });

  it('names the dimensions a "*" value wildcards', () => {
    expect(normalizePredicates({ NAICS2017: '*', year: ' * ', LFO: '001' })).toEqual({
      predicates: { NAICS2017: '*', YEAR: '*', LFO: '001' },
      wildcards: ['NAICS2017', 'YEAR'],
    });
  });

  it('reads an absent map as no predicates', () => {
    expect(normalizePredicates(undefined)).toEqual({ predicates: {}, wildcards: [] });
  });
});

/**
 * The Census API rejects a `get=` list longer than 50 columns (NAME + 49 codes succeeds, NAME + 50
 * fails), and every column this server adds counts toward it.
 */
describe('planQueryColumns', () => {
  const codes = (n: number) =>
    Array.from({ length: n }, (_, i) => `B01001_${String(i + 1).padStart(3, '0')}E`);

  it('fits NAME plus 49 codes and refuses the 50th', () => {
    expect(planQueryColumns({ variables: codes(49) })).toMatchObject({ status: 'ok' });
    expect(planQueryColumns({ variables: codes(50) })).toEqual({
      status: 'over_limit',
      columnCount: 51,
      maxVariables: 49,
      addedColumns: ['NAME'],
    });
  });

  it('counts the default-label and record columns the service adds', () => {
    const columns = {
      defaultLabelColumns: { POPGROUP: 'POPGROUP_LABEL' },
      recordColumns: { MONTH: 'MONTH_DESC' },
    };

    expect(planQueryColumns({ variables: codes(46), ...columns })).toMatchObject({ status: 'ok' });
    expect(planQueryColumns({ variables: codes(47), ...columns })).toEqual({
      status: 'over_limit',
      columnCount: 51,
      maxVariables: 46,
      addedColumns: ['NAME', 'POPGROUP_LABEL', 'MONTH', 'MONTH_DESC'],
    });
  });

  /**
   * Wildcard label and flag columns are the server's own extras. Adding them must never turn a
   * request that fit into one that fails, so they take what is left and the rest is reported.
   */
  it('fits optional label and flag columns into what is left, and reports the rest', () => {
    const plan = planQueryColumns({
      variables: ['ESTAB', 'EMP', 'PAYANN', ...codes(44)],
      defaultLabelColumns: { LFO: 'LFO_LABEL' },
      wildcardColumns: [{ code: 'NAICS2017', labelColumn: 'NAICS2017_LABEL' }],
      flagColumns: { ESTAB: 'ESTAB_F', EMP: 'EMP_F', PAYANN: 'PAYANN_F' },
    });

    // NAME + 47 codes + LFO_LABEL = 49, so one optional column fits.
    expect(plan).toEqual({
      status: 'ok',
      wildcardColumns: [{ code: 'NAICS2017', labelColumn: 'NAICS2017_LABEL' }],
      flagColumns: {},
      unlabelledWildcards: [],
      uncheckedFlags: ['ESTAB', 'EMP', 'PAYANN'],
    });
  });

  it('keeps every optional column when there is room', () => {
    expect(
      planQueryColumns({
        variables: ['ESTAB', 'EMP'],
        wildcardColumns: [{ code: 'NAICS2017', labelColumn: 'NAICS2017_LABEL' }, { code: 'YEAR' }],
        flagColumns: { ESTAB: 'ESTAB_F', EMP: 'EMP_F' },
      }),
    ).toEqual({
      status: 'ok',
      wildcardColumns: [{ code: 'NAICS2017', labelColumn: 'NAICS2017_LABEL' }, { code: 'YEAR' }],
      flagColumns: { ESTAB: 'ESTAB_F', EMP: 'EMP_F' },
      unlabelledWildcards: [],
      uncheckedFlags: [],
    });
  });

  it('builds the same get= list queryData sends', () => {
    expect(
      getColumnsFor({
        variables: ['ESTAB'],
        defaultLabelColumns: { LFO: 'LFO_LABEL' },
        recordColumns: { MONTH: 'MONTH_DESC' },
        wildcardColumns: [{ code: 'NAICS2017', labelColumn: 'NAICS2017_LABEL' }, { code: 'YEAR' }],
        flagColumns: { ESTAB: 'ESTAB_F' },
      }),
    ).toEqual(['NAME', 'ESTAB', 'LFO_LABEL', 'MONTH', 'MONTH_DESC', 'NAICS2017_LABEL', 'ESTAB_F']);
  });

  /**
   * A caller can name a column the server would add anyway — `MONTH_DESC` on pep/charv, a flag
   * column, a dimension's label column. The Census API needs it once, so it is sent and counted
   * once, and the per-call maximum is not lowered by a column that costs nothing extra.
   */
  it('sends and counts a column the caller also requests once', () => {
    const columns = {
      variables: ['POP', 'MONTH_DESC', 'EMP_F', 'NAICS2017_LABEL', 'POP'],
      recordColumns: { MONTH: 'MONTH_DESC' },
      wildcardColumns: [{ code: 'NAICS2017', labelColumn: 'NAICS2017_LABEL' }],
      flagColumns: { EMP: 'EMP_F' },
    };

    expect(getColumnsFor(columns)).toEqual([
      'NAME',
      'POP',
      'MONTH_DESC',
      'EMP_F',
      'NAICS2017_LABEL',
      'MONTH',
    ]);
  });

  it('does not charge a record, label, or flag column the caller already requested', () => {
    // NAME + MONTH + MONTH_DESC leaves 47 codes; naming MONTH_DESC among them costs nothing.
    expect(
      planQueryColumns({
        variables: [...codes(47), 'MONTH_DESC'],
        recordColumns: { MONTH: 'MONTH_DESC' },
      }),
    ).toMatchObject({ status: 'ok' });

    // NAME + 49 codes is full; the flag and label columns the caller named are already in it.
    expect(
      planQueryColumns({
        variables: [...codes(47), 'EMP_F', 'NAICS2017_LABEL'],
        wildcardColumns: [{ code: 'NAICS2017', labelColumn: 'NAICS2017_LABEL' }],
        flagColumns: { EMP: 'EMP_F' },
      }),
    ).toEqual({
      status: 'ok',
      wildcardColumns: [{ code: 'NAICS2017', labelColumn: 'NAICS2017_LABEL' }],
      flagColumns: { EMP: 'EMP_F' },
      unlabelledWildcards: [],
      uncheckedFlags: [],
    });
  });
});

describe('normalizeVariableCodes', () => {
  it('trims, uppercases, drops blanks, and keeps the first of any repeat', () => {
    expect(normalizeVariableCodes([' b19013_001e', '', '  ', 'B19013_001E', 'geo_id'])).toEqual([
      'B19013_001E',
      'GEO_ID',
    ]);
  });
});

describe('column-limit wording', () => {
  it('states the per-call maximum and the columns that lower it', () => {
    expect(describeColumnLimit(50, { maxVariables: 49, addedColumns: ['NAME'] })).toBe(
      '50 variable codes requested, but this query can carry at most 49: the Census API accepts 50 columns per request, and every query also sends NAME.',
    );
    expect(
      describeColumnLimit(47, {
        maxVariables: 46,
        addedColumns: ['NAME', 'EMPSZES_LABEL', 'LFO_LABEL', 'NAICS2017_LABEL'],
      }),
    ).toContain('at most 46');
  });

  it('names the codes whose flags went unchecked and the dimensions left unlabelled', () => {
    const text = describeColumnBudget({
      uncheckedFlags: ['EMP', 'PAYANN'],
      unlabelledWildcards: ['NAICS2017'],
    });

    expect(text).toContain('Flags were not checked for EMP, PAYANN');
    expect(text).toContain('reads as 0');
    expect(text).toContain('label column of NAICS2017');
  });

  it('says nothing when every optional column fit', () => {
    expect(describeColumnBudget({ uncheckedFlags: [], unlabelledWildcards: [] })).toBeUndefined();
  });
});
