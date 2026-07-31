/**
 * @fileoverview Tests for GeographyService — TIGERweb layer selection, the
 * place-then-county fallback chain, exact-name preference, and the state
 * abbreviation carried on ambiguous-match candidates.
 * @module tests/services/geography/geography-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getGeographyService,
  initGeographyService,
} from '@/services/geography/geography-service.js';
import type { GeographyType } from '@/services/geography/types.js';

/** One TIGERweb feature. */
const feature = (attributes: Record<string, string>) => ({ attributes });

/** TIGERweb responses handed out in call order; a query past the end sees zero rows. */
let responses: unknown[] = [];
/** Every URL the service requested, in order. */
let requestedUrls: string[] = [];

const queue = (...bodies: unknown[]) => {
  responses = bodies;
};

const resolve = (name: string, geographyType?: GeographyType) =>
  getGeographyService().resolveGeography(name, geographyType, createMockContext());

beforeEach(() => {
  responses = [];
  requestedUrls = [];
  initGeographyService();
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string | URL) => {
      requestedUrls.push(String(url));
      const body = responses.shift() ?? { features: [] };
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

describe('GeographyService.resolveGeography — layer detection', () => {
  it('routes "Seattle, WA" to the place layer and returns the place FIPS', async () => {
    queue({
      features: [
        feature({ NAME: 'Seattle city', BASENAME: 'Seattle', STATE: '53', PLACE: '63000' }),
      ],
    });

    const result = await resolve('Seattle, WA');

    expect(result).toMatchObject({
      name: 'Seattle city',
      geographyType: 'place',
      stateFips: '53',
      placeFips: '63000',
      fipsSummary: '63000',
    });
    expect(requestedUrls[0]).toContain('Places_CouSub_ConCity_SubMCD/MapServer/4');
    expect(decodeURIComponent(requestedUrls[0] ?? '')).toContain(
      "NAME LIKE '%Seattle%' AND STATE='53'",
    );
  });

  it('routes a spelled-out state name to the state layer', async () => {
    queue({
      features: [
        feature({ NAME: 'California', BASENAME: 'California', STATE: '06', STUSAB: 'CA' }),
      ],
    });

    const result = await resolve('California');

    expect(result).toMatchObject({ geographyType: 'state', stateFips: '06', fipsSummary: '06' });
    expect(requestedUrls[0]).toContain('State_County/MapServer/0');
    expect(requestedUrls).toHaveLength(1);
  });

  it('resolves "Texas" to the state, not Texas County, Oklahoma', async () => {
    queue({ features: [feature({ NAME: 'Texas', BASENAME: 'Texas', STATE: '48', STUSAB: 'TX' })] });

    const result = await resolve('Texas');

    expect(result).toMatchObject({ name: 'Texas', geographyType: 'state', stateFips: '48' });
    expect(result).not.toHaveProperty('countyFips');
  });

  it('resolves "New York" to the state — the city needs an explicit geography_type', async () => {
    queue({
      features: [feature({ NAME: 'New York', BASENAME: 'New York', STATE: '36', STUSAB: 'NY' })],
    });

    const asState = await resolve('New York');
    expect(asState).toMatchObject({ geographyType: 'state', stateFips: '36', fipsSummary: '36' });

    queue({
      features: [
        feature({
          NAME: 'West New York town',
          BASENAME: 'West New York',
          STATE: '34',
          PLACE: '79610',
        }),
        feature({
          NAME: 'New York Mills village',
          BASENAME: 'New York Mills',
          STATE: '36',
          PLACE: '51011',
        }),
        feature({ NAME: 'New York city', BASENAME: 'New York', STATE: '36', PLACE: '51000' }),
      ],
    });

    const asPlace = await resolve('New York', 'place');
    expect(asPlace).toMatchObject({ geographyType: 'place', placeFips: '51000' });
  });

  it('matches full state names exactly — "West Virginia University" is not a state', async () => {
    queue({ features: [] }, { features: [] });

    await expect(resolve('West Virginia University')).rejects.toMatchObject({
      data: { reason: 'no_match', attemptedTypes: ['place', 'county'] },
    });
    expect(requestedUrls[0]).toContain('Places_CouSub_ConCity_SubMCD');
  });

  it('keeps county keywords on the county layer', async () => {
    queue({
      features: [feature({ NAME: 'King County', BASENAME: 'King', STATE: '53', COUNTY: '033' })],
    });

    const result = await resolve('King County, WA');

    expect(result).toMatchObject({ geographyType: 'county', stateFips: '53', countyFips: '033' });
    expect(requestedUrls[0]).toContain('State_County/MapServer/1');
  });

  it('matches a bare two-letter abbreviation on STUSAB', async () => {
    queue({
      features: [
        feature({ NAME: 'Washington', BASENAME: 'Washington', STATE: '53', STUSAB: 'WA' }),
      ],
    });

    const result = await resolve('WA');

    expect(result).toMatchObject({ name: 'Washington', geographyType: 'state', stateFips: '53' });
    expect(decodeURIComponent(requestedUrls[0] ?? '')).toContain("STUSAB='WA'");
  });

  it('requests BASENAME without geometry, and never STUSAB off the state layer', async () => {
    queue({
      features: [feature({ NAME: 'King County', BASENAME: 'King', STATE: '53', COUNTY: '033' })],
    });

    await resolve('King County, WA');

    const url = requestedUrls[0] ?? '';
    expect(url).toContain('outFields=NAME,BASENAME,STATE,COUNTY');
    expect(url).toContain('returnGeometry=false');
    expect(url).not.toContain('STUSAB');
  });
});

describe('GeographyService.resolveGeography — place-then-county fallback', () => {
  it('falls through to the county layer when the place layer has no rows', async () => {
    queue(
      { features: [] },
      {
        features: [
          feature({ NAME: 'Doña Ana County', BASENAME: 'Doña Ana', STATE: '35', COUNTY: '013' }),
        ],
      },
    );

    const result = await resolve('Doña Ana, NM');

    expect(result).toMatchObject({ geographyType: 'county', stateFips: '35', countyFips: '013' });
    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls[0]).toContain('Places_CouSub_ConCity_SubMCD');
    expect(requestedUrls[1]).toContain('State_County/MapServer/1');
  });

  it('does not fall back when the caller pinned geography_type', async () => {
    queue({ features: [] });

    await expect(resolve('Nowhere', 'place')).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_match', attemptedTypes: ['place'] },
    });
    expect(requestedUrls).toHaveLength(1);
  });

  it('no_match names the state instead of asking for an abbreviation already supplied', async () => {
    queue({ features: [] }, { features: [] });

    const err = await resolve('Nonexistent Place XYZ, WA').catch((e: unknown) => e);
    const hint = (err as { data: { recovery: { hint: string } } }).data.recovery.hint;

    expect(hint).toContain('WA');
    expect(hint).toContain('geography_type');
    expect(hint).not.toContain('Add the state abbreviation');
  });

  it('no_match asks for a state abbreviation when the name has none', async () => {
    queue({ features: [] }, { features: [] });

    const err = await resolve('Nonexistent Place XYZ').catch((e: unknown) => e);
    const hint = (err as { data: { recovery: { hint: string } } }).data.recovery.hint;

    expect(hint).toContain('Add the state abbreviation');
  });
});

describe('GeographyService.resolveGeography — exact-name preference', () => {
  it('prefers the exactly-named place over a longer LIKE match', async () => {
    queue({
      features: [
        feature({
          NAME: 'North Kansas City city',
          BASENAME: 'North Kansas City',
          STATE: '29',
          PLACE: '53102',
        }),
        feature({ NAME: 'Kansas City city', BASENAME: 'Kansas City', STATE: '29', PLACE: '38000' }),
      ],
    });

    const result = await resolve('Kansas City, MO');

    expect(result).toMatchObject({ name: 'Kansas City city', placeFips: '38000' });
  });

  it('resolves a bare city name that would otherwise be ambiguous', async () => {
    queue({
      features: [
        feature({ NAME: 'New Chicago town', BASENAME: 'New Chicago', STATE: '18', PLACE: '52776' }),
        feature({
          NAME: 'Chicago Ridge village',
          BASENAME: 'Chicago Ridge',
          STATE: '17',
          PLACE: '14065',
        }),
        feature({
          NAME: 'North Chicago city',
          BASENAME: 'North Chicago',
          STATE: '17',
          PLACE: '53559',
        }),
        feature({
          NAME: 'West Chicago city',
          BASENAME: 'West Chicago',
          STATE: '17',
          PLACE: '80060',
        }),
        feature({ NAME: 'Chicago city', BASENAME: 'Chicago', STATE: '17', PLACE: '14000' }),
      ],
    });

    const result = await resolve('Chicago');

    expect(result).toMatchObject({ name: 'Chicago city', stateFips: '17', placeFips: '14000' });
  });

  it('reports every exactly-named match instead of taking the first of a handful', async () => {
    queue({
      features: [
        feature({ NAME: 'Boston town', BASENAME: 'Boston', STATE: '18', PLACE: '06652' }),
        feature({ NAME: 'Boston city', BASENAME: 'Boston', STATE: '13', PLACE: '09656' }),
        feature({ NAME: 'Boston city', BASENAME: 'Boston', STATE: '25', PLACE: '07000' }),
      ],
    });

    const err = await resolve('Boston').catch((e: unknown) => e);
    const { code, data } = err as {
      code: number;
      data: {
        reason: string;
        candidates: Array<{ stateAbbr: string }>;
        recovery: { hint: string };
      };
    };

    expect(code).toBe(JsonRpcErrorCode.ValidationError);
    expect(data.reason).toBe('ambiguous_name');
    expect(data.candidates.map((c) => c.stateAbbr)).toEqual(['IN', 'GA', 'MA']);
    expect(data.recovery.hint).toContain('"Boston city, MA"');
  });
});

/** The 30 states carrying a "Washington County", as TIGERweb returns them. */
const WASHINGTON_COUNTY_FIPS = [
  '51',
  '55',
  '40',
  '47',
  '37',
  '41',
  '31',
  '21',
  '18',
  '39',
  '19',
  '28',
  '05',
  '01',
  '12',
  '13',
  '16',
  '17',
  '20',
  '22',
  '23',
  '24',
  '25',
  '27',
  '29',
  '36',
  '38',
  '42',
  '44',
  '45',
];

describe('GeographyService.resolveGeography — ambiguous candidates', () => {
  const ambiguousCounties = {
    features: WASHINGTON_COUNTY_FIPS.map((state, i) =>
      feature({
        NAME: 'Washington County',
        BASENAME: 'Washington',
        STATE: state,
        COUNTY: String(100 + i),
      }),
    ),
  };

  it('names each candidate state in the hint and the structured candidates', async () => {
    queue(ambiguousCounties);

    const err = await resolve('Washington County').catch((e: unknown) => e);
    const { code, data } = err as {
      code: number;
      data: {
        candidates: Array<{ stateAbbr: string; stateFips: string }>;
        recovery: { hint: string };
      };
    };

    expect(code).toBe(JsonRpcErrorCode.ValidationError);
    expect(data.recovery.hint).toContain('"Washington County, VA"');
    expect(data.recovery.hint).toContain('"Washington County, OK"');
    expect(data.recovery.hint).toContain('20 more');

    // Every listed candidate ends in a real state — none render as `"Washington County, "`.
    const entries = data.recovery.hint.match(/"[^"]+"/g) ?? [];
    expect(entries).toHaveLength(10);
    for (const entry of entries) {
      expect(entry).toMatch(/, [A-Z]{2}"$/);
    }

    expect(data.candidates).toHaveLength(10);
    for (const candidate of data.candidates) {
      expect(candidate.stateAbbr).toMatch(/^[A-Z]{2}$/);
    }
  });

  it('resolves single-digit state FIPS even when TIGERweb omits the leading zero', async () => {
    queue({
      features: [
        feature({ NAME: 'Washington County', BASENAME: 'Washington', STATE: '5', COUNTY: '143' }),
        feature({ NAME: 'Washington County', BASENAME: 'Washington', STATE: '1', COUNTY: '129' }),
        feature({ NAME: 'Washington County', BASENAME: 'Washington', STATE: '6', COUNTY: '001' }),
        feature({ NAME: 'Washington County', BASENAME: 'Washington', STATE: '9', COUNTY: '002' }),
      ],
    });

    const err = await resolve('Washington County').catch((e: unknown) => e);
    const { data } = err as {
      data: {
        candidates: Array<{ stateAbbr: string; stateFips: string }>;
        recovery: { hint: string };
      };
    };

    expect(data.candidates.map((c) => c.stateAbbr)).toEqual(['AR', 'AL', 'CA', 'CT']);
    expect(data.candidates[0]?.stateFips).toBe('05');
    expect(data.recovery.hint).toContain('"Washington County, AR"');
  });

  it('carries state abbreviations on place-layer candidates too', async () => {
    queue({
      features: ['01', '05', '17', '29'].map((state, i) =>
        feature({
          NAME: 'Springfield city',
          BASENAME: 'Springfield',
          STATE: state,
          PLACE: String(70000 + i),
        }),
      ),
    });

    const err = await resolve('Springfield').catch((e: unknown) => e);
    const { data } = err as { data: { recovery: { hint: string } } };

    expect(data.recovery.hint).toContain('"Springfield city, AL"');
    expect(data.recovery.hint).toContain('"Springfield city, MO"');
  });

  it('distinguishes tract candidates by county and hands over the FIPS pair', async () => {
    queue({
      features: ['051', '143', '125', '119'].map((county) =>
        feature({
          NAME: 'Census Tract 104.01',
          BASENAME: '104.01',
          STATE: '05',
          COUNTY: county,
          TRACT: '010401',
        }),
      ),
    });

    const err = await resolve('Census Tract 104.01').catch((e: unknown) => e);
    const { data } = err as {
      data: {
        candidates: Array<{ countyFips?: string; tractFips?: string }>;
        recovery: { hint: string };
      };
    };

    expect(requestedUrls[0]).toContain('Tracts_Blocks');
    expect(data.recovery.hint).toContain('"Census Tract 104.01, AR" (county 051)');
    expect(data.recovery.hint).toContain('(county 143)');
    // Every candidate shares a name and state, so re-querying by name cannot pick one.
    expect(data.recovery.hint).toContain('county_fips to census_query_data');
    expect(data.candidates[0]).toMatchObject({ countyFips: '051', tractFips: '010401' });
  });

  it('reports a two-county tract match rather than resolving the first county', async () => {
    queue({
      features: [
        feature({
          NAME: 'Census Tract 104.01',
          BASENAME: '104.01',
          STATE: '05',
          COUNTY: '143',
          TRACT: '010401',
        }),
        feature({
          NAME: 'Census Tract 104.01',
          BASENAME: '104.01',
          STATE: '05',
          COUNTY: '051',
          TRACT: '010401',
        }),
      ],
    });

    const err = await resolve('Census Tract 104.01, AR').catch((e: unknown) => e);
    const { data } = err as {
      data: { reason: string; candidates: Array<{ countyFips?: string }> };
    };

    expect(data.reason).toBe('ambiguous_name');
    expect(data.candidates.map((c) => c.countyFips)).toEqual(['143', '051']);
  });
});

describe('GeographyService.resolveGeography — addresses', () => {
  it('sends a street address to the geocoder and resolves to tract level', async () => {
    queue({
      result: {
        addressMatches: [
          {
            matchedAddress: '1600 PENNSYLVANIA AVE NW, WASHINGTON, DC, 20500',
            geographies: {
              'Census Tracts': [{ STATE: '11', COUNTY: '001', TRACT: '006202' }],
            },
          },
        ],
      },
    });

    const result = await resolve('1600 Pennsylvania Ave NW, Washington, DC 20500');

    expect(result).toMatchObject({
      geographyType: 'tract',
      stateFips: '11',
      countyFips: '001',
      tractFips: '006202',
      fipsSummary: '006202',
    });
    expect(requestedUrls[0]).toContain('geocoding.geo.census.gov');
  });
});
