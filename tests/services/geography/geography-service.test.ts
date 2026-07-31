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

const resolve = (name: string, geographyType?: GeographyType, countyFips?: string) =>
  getGeographyService().resolveGeography(
    { name, ...(geographyType && { geographyType }), ...(countyFips && { countyFips }) },
    createMockContext(),
  );

/** Every WHERE clause the service sent, decoded. */
const whereClauses = () =>
  requestedUrls.map((url) => decodeURIComponent(url.match(/where=([^&]*)/)?.[1] ?? ''));

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
    expect(data.recovery.hint).toContain(
      're-call census_resolve_geography with county_fips set to the county',
    );
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

describe('GeographyService.resolveGeography — county scoping', () => {
  const tract = (county: string) =>
    feature({
      NAME: 'Census Tract 104.01',
      BASENAME: '104.01',
      STATE: '05',
      COUNTY: county,
      TRACT: '010401',
    });

  it('narrows a two-county tract match to the county asked for', async () => {
    queue({ features: [tract('143'), tract('051')] });

    await expect(resolve('Census Tract 104.01, AR')).rejects.toMatchObject({
      data: { reason: 'ambiguous_name' },
    });

    queue({ features: [tract('143')] });

    const result = await resolve('Census Tract 104.01, AR', 'tract', '143');

    expect(result).toMatchObject({
      geographyType: 'tract',
      stateFips: '05',
      countyFips: '143',
      tractFips: '010401',
      fipsSummary: '010401',
    });
    expect(whereClauses()[1]).toBe(
      "NAME LIKE '%Census Tract 104.01%' AND STATE='05' AND COUNTY='143'",
    );
  });

  it('zero-pads a short county code — TIGERweb stores COUNTY padded', async () => {
    queue({ features: [tract('051')] });

    await resolve('Census Tract 104.01, AR', 'tract', '51');

    expect(whereClauses()[0]).toContain("COUNTY='051'");
  });

  it('scopes the county layer too', async () => {
    queue({
      features: [feature({ NAME: 'King County', BASENAME: 'King', STATE: '53', COUNTY: '033' })],
    });

    await resolve('King County, WA', 'county', '033');

    expect(whereClauses()[0]).toContain("COUNTY='033'");
  });

  it('rejects county_fips on a level that does not sit within a county', async () => {
    await expect(resolve('Seattle, WA', 'place', '033')).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'county_scope_unsupported', geographyType: 'place' },
    });
    expect(requestedUrls).toHaveLength(0);
  });

  it('narrows auto-detection to the levels that can apply the scope', async () => {
    queue({
      features: [
        feature({ NAME: 'Doña Ana County', BASENAME: 'Doña Ana', STATE: '35', COUNTY: '013' }),
      ],
    });

    const result = await resolve('Doña Ana, NM', undefined, '013');

    expect(result).toMatchObject({ geographyType: 'county', countyFips: '013' });
    // The place layer carries no COUNTY, so it is dropped from the chain rather than queried
    // unscoped — one request, and it is the county layer.
    expect(requestedUrls).toHaveLength(1);
    expect(whereClauses()[0]).toContain("COUNTY='013'");
  });

  /**
   * "Springfield, IL" auto-detects to place-then-county and is a real place, so a chain that
   * still reached the place layer would answer from it — returning a place FIPS with
   * county_fips discarded, and nothing telling the caller their scope was dropped.
   */
  it('never answers a county-scoped lookup from a layer that cannot apply the scope', async () => {
    queue({ features: [] });

    await expect(resolve('Springfield, IL', undefined, '999')).rejects.toMatchObject({
      data: { reason: 'no_match', attemptedTypes: ['county'], countyFips: '999' },
    });
    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).toContain('State_County/MapServer/1');
    expect(whereClauses()[0]).toContain("COUNTY='999'");
  });

  it('rejects county_fips on a name that auto-detects to a level without a county', async () => {
    await expect(resolve('California', undefined, '001')).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'county_scope_unsupported', attemptedTypes: ['state'] },
    });
    expect(requestedUrls).toHaveLength(0);
  });

  it('rejects county_fips on a street address before spending the geocoder call', async () => {
    await expect(
      resolve('1600 Pennsylvania Ave NW, Washington, DC 20500', undefined, '001'),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'county_scope_unsupported' },
    });
    expect(requestedUrls).toHaveLength(0);
  });

  it('names the county scope in the no_match hint so it is not re-run unchanged', async () => {
    queue({ features: [] });

    const err = await resolve('Nowhere County, WA', 'county', '033').catch((e: unknown) => e);
    const hint = (err as { data: { recovery: { hint: string } } }).data.recovery.hint;

    expect(hint).toContain('in county 033');
    expect(hint).toContain('drop county_fips');
  });
});

describe('GeographyService.resolveGeography — statistical areas and consolidated cities', () => {
  const CBSA = 'metropolitan statistical area/micropolitan statistical area';

  it('queries both the metropolitan and micropolitan layers for a CBSA', async () => {
    queue(
      {
        features: [
          feature({
            NAME: 'Seattle-Tacoma-Bellevue, WA Metro Area',
            BASENAME: 'Seattle-Tacoma-Bellevue, WA',
            GEOID: '42660',
            CBSA: '42660',
          }),
        ],
      },
      { features: [] },
    );

    const result = await resolve('Seattle-Tacoma-Bellevue, WA', CBSA);

    expect(result).toMatchObject({
      name: 'Seattle-Tacoma-Bellevue, WA Metro Area',
      geographyType: CBSA,
      fipsSummary: '42660',
    });
    // A CBSA spans whatever states it spans — it has no single one to report.
    expect(result).not.toHaveProperty('stateFips');
    expect(requestedUrls.some((u) => u.includes('CBSA/MapServer/3'))).toBe(true);
    expect(requestedUrls.some((u) => u.includes('CBSA/MapServer/4'))).toBe(true);
  });

  it('never scopes a CBSA query by state — the layer has no STATE field to filter on', async () => {
    queue(
      {
        features: [
          feature({
            NAME: 'Seattle-Tacoma-Bellevue, WA Metro Area',
            BASENAME: 'Seattle-Tacoma-Bellevue, WA',
            GEOID: '42660',
            CBSA: '42660',
          }),
        ],
      },
      { features: [] },
    );

    await resolve('Seattle-Tacoma-Bellevue, WA', CBSA);

    for (const where of whereClauses()) {
      expect(where).not.toContain('STATE');
    }
    expect(requestedUrls[0]).not.toContain('STATE');
  });

  it('reports CBSA candidates across both layers with the code each resolves to', async () => {
    queue(
      {
        features: [
          feature({ NAME: 'Columbus, OH Metro Area', BASENAME: 'Columbus, OH', GEOID: '18140' }),
          feature({ NAME: 'Columbus, IN Metro Area', BASENAME: 'Columbus, IN', GEOID: '18020' }),
        ],
      },
      {
        features: [
          feature({ NAME: 'Columbus, NE Micro Area', BASENAME: 'Columbus, NE', GEOID: '18100' }),
        ],
      },
    );

    const err = await resolve('Columbus', CBSA).catch((e: unknown) => e);
    const { data } = err as {
      data: {
        reason: string;
        candidates: Array<{ name: string; fipsSummary: string; stateAbbr?: string }>;
      };
    };

    expect(data.reason).toBe('ambiguous_name');
    expect(data.candidates.map((c) => c.fipsSummary).sort()).toEqual(['18020', '18100', '18140']);
    // No state to name, so the code is what makes a candidate actionable.
    for (const candidate of data.candidates) {
      expect(candidate).not.toHaveProperty('stateAbbr');
    }
  });

  /**
   * The CBSA layers carry no STATE to put in a WHERE clause, so a state suffix has to be
   * matched against the row names instead. Discarding it answers "Aberdeen, WA" with the
   * South Dakota micro area alongside the Washington one.
   */
  it('pins a CBSA name to the state the caller named', async () => {
    const aberdeen = [
      feature({ NAME: 'Aberdeen, SD Micro Area', BASENAME: 'Aberdeen, SD', GEOID: '10100' }),
      feature({ NAME: 'Aberdeen, WA Micro Area', BASENAME: 'Aberdeen, WA', GEOID: '10140' }),
    ];
    queue({ features: [] }, { features: aberdeen });

    const result = await resolve('Aberdeen, WA', CBSA);

    expect(result).toMatchObject({ name: 'Aberdeen, WA Micro Area', fipsSummary: '10140' });
    // The scope is applied to the rows, never to the query — the layer would 400 on STATE.
    for (const where of whereClauses()) {
      expect(where).not.toContain('STATE');
    }
  });

  it('matches a state anywhere in a multi-state CBSA name, not just the first', async () => {
    const kansasCity = feature({
      NAME: 'Kansas City, MO-KS Metro Area',
      BASENAME: 'Kansas City, MO-KS',
      GEOID: '28140',
    });
    queue({ features: [kansasCity] }, { features: [] });

    await expect(resolve('Kansas City, KS', CBSA)).resolves.toMatchObject({
      fipsSummary: '28140',
    });

    queue({ features: [kansasCity] }, { features: [] });

    await expect(resolve('Kansas City, MO', CBSA)).resolves.toMatchObject({
      fipsSummary: '28140',
    });
  });

  it('reports no match when no area covering that state carries the name', async () => {
    queue(
      { features: [] },
      {
        features: [
          feature({ NAME: 'Aberdeen, SD Micro Area', BASENAME: 'Aberdeen, SD', GEOID: '10100' }),
          feature({ NAME: 'Aberdeen, WA Micro Area', BASENAME: 'Aberdeen, WA', GEOID: '10140' }),
        ],
      },
    );

    await expect(resolve('Aberdeen, MD', CBSA)).rejects.toMatchObject({
      data: { reason: 'no_match' },
    });
  });

  it('scopes a CSA by the state in its name too', async () => {
    queue({
      features: [
        feature({
          NAME: 'New York-Newark, NY-NJ-CT-PA CSA',
          BASENAME: 'New York-Newark, NY-NJ-CT-PA',
          GEOID: '408',
          CSA: '408',
        }),
        feature({
          NAME: 'Newark-Granville, OH CSA',
          BASENAME: 'Newark-Granville, OH',
          GEOID: '535',
          CSA: '535',
        }),
      ],
    });

    await expect(resolve('Newark, CT', 'combined statistical area')).resolves.toMatchObject({
      fipsSummary: '408',
    });
  });

  it('resolves a CSA off layer 0 to its 3-digit code', async () => {
    queue({
      features: [
        feature({
          NAME: 'Seattle-Tacoma, WA CSA',
          BASENAME: 'Seattle-Tacoma, WA',
          GEOID: '500',
          CSA: '500',
        }),
      ],
    });

    const result = await resolve('Seattle-Tacoma, WA', 'combined statistical area');

    expect(result).toMatchObject({
      geographyType: 'combined statistical area',
      fipsSummary: '500',
    });
    expect(result).not.toHaveProperty('stateFips');
    expect(requestedUrls[0]).toContain('CBSA/MapServer/0');
  });

  it('resolves a consolidated city to its code and keeps the state scope', async () => {
    queue({
      features: [
        feature({
          NAME: 'Nashville-Davidson metropolitan government',
          BASENAME: 'Nashville-Davidson',
          STATE: '47',
          CONCITY: '52004',
        }),
      ],
    });

    const result = await resolve('Nashville-Davidson, TN', 'consolidated city');

    expect(result).toMatchObject({
      geographyType: 'consolidated city',
      stateFips: '47',
      fipsSummary: '52004',
    });
    expect(requestedUrls[0]).toContain('Places_CouSub_ConCity_SubMCD/MapServer/3');
    expect(whereClauses()[0]).toContain("STATE='47'");
  });

  it('names the new levels in the no_match hint', async () => {
    queue({ features: [] }, { features: [] });

    const err = await resolve('Nowhere At All').catch((e: unknown) => e);
    const hint = (err as { data: { recovery: { hint: string } } }).data.recovery.hint;

    expect(hint).toContain('metropolitan statistical area/micropolitan statistical area');
    expect(hint).toContain('combined statistical area');
    expect(hint).toContain('consolidated city');
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
