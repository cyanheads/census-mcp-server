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
/** The form parameters of every POST, in order — a spatial query sends its polygon as a POST. */
let postBodies: URLSearchParams[] = [];

const queue = (...bodies: unknown[]) => {
  responses = bodies;
};

/**
 * Answers keyed by layer and WHERE clause instead of call order — for lookups that make a
 * varying number of retry calls before the one under test. Anything unkeyed sees zero rows.
 */
let routes: Map<string, unknown> | undefined;
const route = (layerPath: string, where: string, body: unknown) => {
  routes ??= new Map();
  routes.set(`${layerPath} ${where}`, body);
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
  postBodies = [];
  routes = undefined;
  initGeographyService();
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string | URL, init?: RequestInit) => {
      requestedUrls.push(String(url));
      const href = String(url);
      const form = init?.body ? new URLSearchParams(String(init.body)) : undefined;
      if (form) postBodies.push(form);
      // Layers under the TIGERweb folder are keyed without it; other folders (Econ) keep theirs.
      const layerPath = href.match(/services\/(?:TIGERweb\/)?([^?]+)\/query/)?.[1] ?? '';
      const where = form
        ? (form.get('where') ?? '')
        : decodeURIComponent(href.match(/where=([^&]*)/)?.[1] ?? '');
      const body = routes
        ? (routes.get(`${layerPath} ${where}`) ?? { features: [] })
        : (responses.shift() ?? { features: [] });
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
      "UPPER(NAME) LIKE '%SEATTLE%' AND STATE='53'",
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

  it.each([
    ['Marlborough, MA', '4', '25', 'Marlborough city'],
    ['Parishville, NY', '5', '36', 'Parishville CDP'],
  ])(
    'tries "%s" as a place — a keyword inside a word is not a keyword',
    async (name, layer, state, rowName) => {
      const basename = rowName.split(' ')[0] ?? '';
      route(
        `Places_CouSub_ConCity_SubMCD/MapServer/${layer}`,
        `UPPER(NAME) LIKE '%${basename.toUpperCase()}%' AND STATE='${state}'`,
        {
          features: [feature({ NAME: rowName, BASENAME: basename, STATE: state, PLACE: '38715' })],
        },
      );

      const result = await resolve(name);

      expect(result).toMatchObject({ name: rowName, geographyType: 'place', placeFips: '38715' });
      expect(requestedUrls[0]).toContain('Places_CouSub_ConCity_SubMCD/MapServer/4');
    },
  );

  it('tries a borough as a county first, then as a place', async () => {
    route(
      'Places_CouSub_ConCity_SubMCD/MapServer/4',
      "UPPER(NAME) LIKE '%STATE COLLEGE BOROUGH%' AND STATE='42'",
      {
        features: [
          feature({
            NAME: 'State College borough',
            BASENAME: 'State College',
            STATE: '42',
            PLACE: '73808',
          }),
        ],
      },
    );

    const result = await resolve('State College borough, PA');

    expect(result).toMatchObject({ geographyType: 'place', stateFips: '42', placeFips: '73808' });
    expect(requestedUrls[0]).toContain('State_County/MapServer/1');
  });

  it('keeps a county-equivalent borough on the county layer', async () => {
    queue({
      features: [
        feature({
          NAME: 'Kenai Peninsula Borough',
          BASENAME: 'Kenai Peninsula',
          STATE: '02',
          COUNTY: '122',
        }),
      ],
    });

    const result = await resolve('Kenai Peninsula Borough, AK');

    expect(result).toMatchObject({ geographyType: 'county', stateFips: '02', countyFips: '122' });
    expect(requestedUrls).toHaveLength(1);
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
      { features: [] },
      {
        features: [
          feature({ NAME: 'Doña Ana County', BASENAME: 'Doña Ana', STATE: '35', COUNTY: '013' }),
        ],
      },
    );

    const result = await resolve('Doña Ana, NM');

    expect(result).toMatchObject({ geographyType: 'county', stateFips: '35', countyFips: '013' });
    expect(requestedUrls).toHaveLength(3);
    expect(requestedUrls[0]).toContain('Places_CouSub_ConCity_SubMCD/MapServer/4');
    expect(requestedUrls[1]).toContain('Places_CouSub_ConCity_SubMCD/MapServer/5');
    expect(requestedUrls[2]).toContain('State_County/MapServer/1');
  });

  it('does not fall back when the caller pinned geography_type', async () => {
    queue({ features: [] });

    await expect(resolve('Nowhere', 'place')).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_match', attemptedTypes: ['place'] },
    });
    // Name-variant retries stay on the pinned level's two layers; the county layer is never
    // reached.
    expect(requestedUrls.length).toBeGreaterThan(0);
    for (const url of requestedUrls) {
      expect(url).toMatch(/Places_CouSub_ConCity_SubMCD\/MapServer\/[45]\//);
    }
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

describe('GeographyService.resolveGeography — census-designated places', () => {
  const INCORPORATED = 'Places_CouSub_ConCity_SubMCD/MapServer/4';
  const CDP = 'Places_CouSub_ConCity_SubMCD/MapServer/5';
  const COUNTIES = 'State_County/MapServer/1';
  const place = (NAME: string, BASENAME: string, STATE: string, PLACE: string) =>
    feature({ NAME, BASENAME, STATE, PLACE });

  it('searches incorporated places and CDPs together and flags the CDP', async () => {
    const where = "UPPER(NAME) LIKE '%BETHESDA%' AND STATE='24'";
    route(CDP, where, {
      features: [
        place('Bethesda CDP', 'Bethesda', '24', '07125'),
        place('North Bethesda CDP', 'North Bethesda', '24', '56337'),
      ],
    });

    const result = await resolve('Bethesda, MD');

    expect(result).toEqual({
      name: 'Bethesda CDP',
      geographyType: 'place',
      stateFips: '24',
      placeFips: '07125',
      fipsSummary: '07125',
      censusDesignatedPlace: true,
    });
    expect(requestedUrls.filter((u) => u.includes(INCORPORATED))).toHaveLength(1);
    expect(requestedUrls.filter((u) => u.includes(CDP))).toHaveLength(1);
  });

  it('never flags an incorporated place as a CDP', async () => {
    route(INCORPORATED, "UPPER(NAME) LIKE '%SEATTLE%' AND STATE='53'", {
      features: [place('Seattle city', 'Seattle', '53', '63000')],
    });

    const result = await resolve('Seattle, WA');

    expect(result).toMatchObject({ placeFips: '63000' });
    expect(result).not.toHaveProperty('censusDesignatedPlace');
  });

  /**
   * The place level is the incorporated places and CDPs together, but a CDP is a statistical
   * area, so an incorporated place named exactly the term is the answer over any same-named CDP:
   * without that, every city sharing its name with a CDP anywhere ("Tacoma", "Mountain View,
   * CA") stops resolving.
   */
  it('prefers an incorporated place over a same-named CDP in the same state', async () => {
    const where = "UPPER(NAME) LIKE '%PARADISE%' AND STATE='06'";
    route(INCORPORATED, where, { features: [place('Paradise town', 'Paradise', '06', '55520')] });
    route(CDP, where, { features: [place('Paradise CDP', 'Paradise', '06', '55528')] });

    const result = await resolve('Paradise, CA');

    expect(result).toMatchObject({ name: 'Paradise town', placeFips: '55520' });
    expect(result).not.toHaveProperty('censusDesignatedPlace');
  });

  it('prefers an incorporated place over same-named CDPs in other states for a bare name', async () => {
    const where = "UPPER(NAME) LIKE '%BETHESDA%'";
    route(INCORPORATED, where, {
      features: [place('Bethesda village', 'Bethesda', '39', '06138')],
    });
    route(CDP, where, {
      features: [
        place('Bethesda CDP', 'Bethesda', '05', '05770'),
        place('Bethesda CDP', 'Bethesda', '24', '07125'),
        place('North Bethesda CDP', 'North Bethesda', '24', '56337'),
      ],
    });

    await expect(resolve('Bethesda')).resolves.toMatchObject({
      name: 'Bethesda village',
      stateFips: '39',
      placeFips: '06138',
    });
  });

  it('reports a bare name only CDPs share as ambiguous_name', async () => {
    route(CDP, "UPPER(NAME) LIKE '%CALVERTON%'", {
      features: [
        place('Calverton CDP', 'Calverton', '24', '12350'),
        place('Calverton CDP', 'Calverton', '36', '11781'),
      ],
    });

    const err = await resolve('Calverton').catch((e: unknown) => e);
    const { data } = err as {
      data: { reason: string; candidates: Array<{ fipsSummary: string; stateAbbr: string }> };
    };

    expect(data.reason).toBe('ambiguous_name');
    expect(data.candidates.map((c) => `${c.stateAbbr} ${c.fipsSummary}`)).toEqual([
      'MD 12350',
      'NY 11781',
    ]);
  });

  it('lets an exactly-named county outrank an exactly-named CDP', async () => {
    const where = "UPPER(NAME) LIKE '%ARLINGTON%' AND STATE='51'";
    route(CDP, where, { features: [place('Arlington CDP', 'Arlington', '51', '03000')] });
    route(COUNTIES, where, {
      features: [
        feature({ NAME: 'Arlington County', BASENAME: 'Arlington', STATE: '51', COUNTY: '013' }),
      ],
    });

    const result = await resolve('Arlington, VA');

    expect(result).toMatchObject({
      geographyType: 'county',
      countyFips: '013',
      fipsSummary: '013',
    });
    expect(result).not.toHaveProperty('censusDesignatedPlace');
  });

  it('keeps an exactly-named CDP over a county that only contains the name', async () => {
    const where = "UPPER(NAME) LIKE '%CHESTER%' AND STATE='51'";
    route(CDP, where, { features: [place('Chester CDP', 'Chester', '51', '16096')] });
    route(COUNTIES, where, {
      features: [
        feature({
          NAME: 'Chesterfield County',
          BASENAME: 'Chesterfield',
          STATE: '51',
          COUNTY: '041',
        }),
      ],
    });

    await expect(resolve('Chester, VA')).resolves.toMatchObject({
      geographyType: 'place',
      placeFips: '16096',
      censusDesignatedPlace: true,
    });
  });

  it('still answers with the CDP when place is the only level asked for', async () => {
    route(CDP, "UPPER(NAME) LIKE '%ARLINGTON%' AND STATE='51'", {
      features: [place('Arlington CDP', 'Arlington', '51', '03000')],
    });

    await expect(resolve('Arlington, VA', 'place')).resolves.toMatchObject({
      placeFips: '03000',
      censusDesignatedPlace: true,
    });
    expect(requestedUrls.some((u) => u.includes(COUNTIES))).toBe(false);
  });

  it('ranks a respelled county over a respelled CDP the same way', async () => {
    const accented = "UPPER(NAME) LIKE '%D___ ___%' AND STATE='35'";
    route(CDP, accented, { features: [place('Doña Ana CDP', 'Doña Ana', '35', '21240')] });
    route(COUNTIES, accented, {
      features: [
        feature({ NAME: 'Doña Ana County', BASENAME: 'Doña Ana', STATE: '35', COUNTY: '013' }),
      ],
    });

    await expect(resolve('Dona Ana, NM')).resolves.toMatchObject({
      geographyType: 'county',
      countyFips: '013',
    });
  });

  it('scopes both layers by the state, so a CDP elsewhere never displaces the city', async () => {
    route(INCORPORATED, "UPPER(NAME) LIKE '%BETHESDA%' AND STATE='39'", {
      features: [place('Bethesda village', 'Bethesda', '39', '05858')],
    });
    // Answered only unscoped — reached solely if the CDP query dropped the state scope.
    route(CDP, "UPPER(NAME) LIKE '%BETHESDA%'", {
      features: [place('Bethesda CDP', 'Bethesda', '24', '07125')],
    });

    const result = await resolve('Bethesda, OH');

    expect(result).toMatchObject({ name: 'Bethesda village', placeFips: '05858' });
    expect(whereClauses()).toEqual([
      "UPPER(NAME) LIKE '%BETHESDA%' AND STATE='39'",
      "UPPER(NAME) LIKE '%BETHESDA%' AND STATE='39'",
    ]);
  });

  /**
   * A CDP whose name only contains the term ("Kingston CDP" for "King") is a weaker match than a
   * county named exactly that, so it must not stop the chain the way an exact place does.
   */
  it('lets an exactly-named county outrank a CDP that only contains the name', async () => {
    const where = "UPPER(NAME) LIKE '%KING%' AND STATE='53'";
    route(CDP, where, { features: [place('Kingston CDP', 'Kingston', '53', '35870')] });
    route(COUNTIES, where, {
      features: [feature({ NAME: 'King County', BASENAME: 'King', STATE: '53', COUNTY: '033' })],
    });

    await expect(resolve('King, WA')).resolves.toMatchObject({
      geographyType: 'county',
      countyFips: '033',
    });
  });

  it('lets an exactly-named county outrank several CDPs that only contain the name', async () => {
    const where = "UPPER(NAME) LIKE '%HONOLULU%' AND STATE='15'";
    route(CDP, where, {
      features: [
        place('East Honolulu CDP', 'East Honolulu', '15', '17985'),
        place('Urban Honolulu CDP', 'Urban Honolulu', '15', '71550'),
      ],
    });
    route(COUNTIES, where, {
      features: [
        feature({ NAME: 'Honolulu County', BASENAME: 'Honolulu', STATE: '15', COUNTY: '003' }),
      ],
    });

    await expect(resolve('Honolulu, HI')).resolves.toMatchObject({
      geographyType: 'county',
      countyFips: '003',
    });
  });

  it('keeps a place that only contains the name when no county matches exactly', async () => {
    route(INCORPORATED, "UPPER(NAME) LIKE '%WINSTON%' AND STATE='37'", {
      features: [place('Winston-Salem city', 'Winston-Salem', '37', '75000')],
    });

    await expect(resolve('Winston, NC')).resolves.toMatchObject({
      geographyType: 'place',
      placeFips: '75000',
    });
  });

  it('keeps an ambiguous partial place match when no county matches exactly', async () => {
    const where = "UPPER(NAME) LIKE '%LOUDOUN%' AND STATE='51'";
    route(CDP, where, {
      features: [
        place('One Loudoun CDP', 'One Loudoun', '51', '59475'),
        place('Loudoun Valley Estates CDP', 'Loudoun Valley Estates', '51', '47225'),
      ],
    });

    await expect(resolve('Loudoun, VA')).rejects.toMatchObject({
      data: { reason: 'ambiguous_name' },
    });
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
      "UPPER(NAME) LIKE '%CENSUS TRACT 104.01%' AND STATE='05' AND COUNTY='143'",
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
    // The name-variant retry is county-scoped too — no request ever leaves the county layer.
    expect(requestedUrls.length).toBeGreaterThan(0);
    for (const [i, url] of requestedUrls.entries()) {
      expect(url).toContain('State_County/MapServer/1');
      expect(whereClauses()[i]).toContain("COUNTY='999'");
    }
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

describe('GeographyService.resolveGeography — state suffix forms', () => {
  const CBSA = 'metropolitan statistical area/micropolitan statistical area';
  const hintOf = (err: unknown) =>
    (err as { data: { recovery: { hint: string } } }).data.recovery.hint;

  it('splits a spelled-out state and scopes the query by its FIPS', async () => {
    queue({
      features: [
        feature({ NAME: 'Chatham County', BASENAME: 'Chatham', STATE: '13', COUNTY: '051' }),
      ],
    });

    const result = await resolve('Chatham County, Georgia');

    expect(result).toMatchObject({ geographyType: 'county', stateFips: '13', countyFips: '051' });
    expect(whereClauses()[0]).toMatch(/LIKE '%Chatham County%' AND STATE='13'$/i);
  });

  it('matches the whole final segment, so "West Virginia" is never read as Virginia', async () => {
    queue({
      features: [
        feature({ NAME: 'McDowell County', BASENAME: 'McDowell', STATE: '54', COUNTY: '047' }),
      ],
    });

    const result = await resolve('McDowell County, West Virginia');

    expect(result).toMatchObject({ stateFips: '54', countyFips: '047' });
    expect(whereClauses()[0]).toMatch(/LIKE '%McDowell County%' AND STATE='54'$/i);
  });

  it.each([
    ['Washington, District of Columbia', 'Washington', '11'],
    ['Kansas City, Kansas', 'Kansas City', '20'],
    ['Seattle, wa', 'Seattle', '53'],
    ['San Juan, Puerto Rico', 'San Juan', '72'],
    ['Charlotte Amalie, US Virgin Islands', 'Charlotte Amalie', '78'],
    ['Kansas City, MO-KS', 'Kansas City', '29'],
  ])('splits "%s" into the place "%s" in state %s', async (input, placeName, stateFips) => {
    await resolve(input, 'place').catch(() => undefined);

    expect(whereClauses()[0]).toMatch(
      new RegExp(`LIKE '%${placeName}%' AND STATE='${stateFips}'$`, 'i'),
    );
  });

  it('keeps the county name when only the final segment names a state', async () => {
    queue({
      features: [
        feature({ NAME: 'Washington County', BASENAME: 'Washington', STATE: '41', COUNTY: '067' }),
      ],
    });

    const result = await resolve('Washington County, Oregon');

    expect(result).toMatchObject({ stateFips: '41', countyFips: '067' });
    expect(whereClauses()[0]).toMatch(/LIKE '%Washington County%' AND STATE='41'$/i);
  });

  it('resolves a spelled-out state on a consolidated city', async () => {
    queue({
      features: [
        feature({
          NAME: 'Nashville-Davidson metropolitan government (balance)',
          BASENAME: 'Nashville-Davidson',
          STATE: '47',
          CONCITY: '52004',
        }),
      ],
    });

    const result = await resolve('Nashville-Davidson, Tennessee', 'consolidated city');

    expect(result).toMatchObject({ stateFips: '47', fipsSummary: '52004' });
    expect(whereClauses()[0]).toMatch(/LIKE '%Nashville-Davidson%' AND STATE='47'$/i);
  });

  it('answers a spelled-out tract suffix with the same ambiguity as the abbreviation', async () => {
    const tract = (county: string) =>
      feature({
        NAME: 'Census Tract 104.01',
        BASENAME: '104.01',
        STATE: '05',
        COUNTY: county,
        TRACT: '010401',
      });
    queue({ features: [tract('143'), tract('051')] });

    await expect(resolve('Census Tract 104.01, Arkansas')).rejects.toMatchObject({
      data: {
        reason: 'ambiguous_name',
        candidates: [{ countyFips: '143' }, { countyFips: '051' }],
      },
    });
    expect(whereClauses()[0]).toMatch(/LIKE '%Census Tract 104.01%' AND STATE='05'$/i);
  });

  it('scopes a CBSA by a spelled-out state through the row names', async () => {
    queue(
      {
        features: [
          feature({
            NAME: 'Denver-Aurora-Centennial, CO Metro Area',
            BASENAME: 'Denver-Aurora-Centennial, CO',
            GEOID: '19740',
          }),
        ],
      },
      { features: [] },
    );

    await expect(resolve('Denver, Colorado', CBSA)).resolves.toMatchObject({
      fipsSummary: '19740',
    });
    expect(whereClauses()[0]).toMatch(/LIKE '%Denver%'$/i);
  });

  it('matches a spelled-out state anywhere in a multi-state CBSA name', async () => {
    queue(
      {
        features: [
          feature({
            NAME: 'Kansas City, MO-KS Metro Area',
            BASENAME: 'Kansas City, MO-KS',
            GEOID: '28140',
          }),
        ],
      },
      { features: [] },
    );

    await expect(resolve('Kansas City, Missouri', CBSA)).resolves.toMatchObject({
      fipsSummary: '28140',
    });
  });

  it('scopes a CSA by a spelled-out state', async () => {
    queue({
      features: [
        feature({ NAME: 'Seattle-Tacoma, WA CSA', BASENAME: 'Seattle-Tacoma, WA', GEOID: '500' }),
      ],
    });

    await expect(
      resolve('Seattle-Tacoma, Washington', 'combined statistical area'),
    ).resolves.toMatchObject({ fipsSummary: '500' });
    expect(whereClauses()[0]).toMatch(/LIKE '%Seattle-Tacoma%'$/i);
  });

  it('splits a hyphenated state list and scopes CBSA rows by its first state', async () => {
    queue(
      {
        features: [
          feature({
            NAME: 'Omaha-Council Bluffs, NE-IA Metro Area',
            BASENAME: 'Omaha-Council Bluffs, NE-IA',
            GEOID: '36540',
          }),
          feature({
            NAME: 'Council Bluffs-Omaha-Council Bluffs, IA Micro Area',
            BASENAME: 'Council Bluffs-Omaha-Council Bluffs, IA',
            GEOID: '99999',
          }),
        ],
      },
      { features: [] },
    );

    await expect(resolve('Omaha-Council Bluffs, NE-IA', CBSA)).resolves.toMatchObject({
      fipsSummary: '36540',
    });
    expect(whereClauses()[0]).toMatch(/LIKE '%Omaha-Council Bluffs%'$/i);
  });

  it('builds the no_match hint from the split place and state', async () => {
    const err = await resolve('Chatham County, Georgia').catch((e: unknown) => e);

    expect(err).toMatchObject({ data: { reason: 'no_match' } });
    expect(hintOf(err)).toContain('"Chatham County"');
    expect(hintOf(err)).toContain('GA');
    expect(hintOf(err)).not.toContain('Georgia');
    expect(hintOf(err)).not.toContain('Add the state abbreviation');
  });

  it.each([
    ['Seattle, wa', 'Seattle', 'WA'],
    ['Omaha-Council Bluffs, NE-IA', 'Omaha-Council Bluffs', 'NE-IA'],
    ['San Juan, Puerto Rico', 'San Juan', 'PR'],
  ])(
    'never appends a second state to "%s" in the no_match hint',
    async (input, placeName, state) => {
      const err = await resolve(input, 'place').catch((e: unknown) => e);

      expect(hintOf(err)).toContain(`"${placeName}"`);
      expect(hintOf(err)).toContain(state);
      expect(hintOf(err)).not.toContain(', WA"');
      expect(hintOf(err)).not.toContain('Add the state abbreviation');
    },
  );

  it('still resolves a bare spelled-out state at the state layer', async () => {
    queue({
      features: [feature({ NAME: 'Georgia', BASENAME: 'Georgia', STATE: '13', STUSAB: 'GA' })],
    });

    const result = await resolve('Georgia');

    expect(result).toMatchObject({ geographyType: 'state', stateFips: '13' });
    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).toContain('State_County/MapServer/0');
    expect(whereClauses()[0]).toMatch(/LIKE '%Georgia%'$/i);
  });
});

describe('GeographyService.resolveGeography — case-insensitive matching', () => {
  it('matches a lowercase place name through UPPER(NAME)', async () => {
    queue({
      features: [
        feature({ NAME: 'Seattle city', BASENAME: 'Seattle', STATE: '53', PLACE: '63000' }),
      ],
    });

    await expect(resolve('seattle, WA')).resolves.toMatchObject({ placeFips: '63000' });
    expect(whereClauses()[0]).toBe("UPPER(NAME) LIKE '%SEATTLE%' AND STATE='53'");
  });

  it('matches a lowercase county name', async () => {
    queue({
      features: [feature({ NAME: 'King County', BASENAME: 'King', STATE: '53', COUNTY: '033' })],
    });

    await expect(resolve('king county, WA')).resolves.toMatchObject({ countyFips: '033' });
    expect(requestedUrls[0]).toContain('State_County/MapServer/1');
    expect(whereClauses()[0]).toBe("UPPER(NAME) LIKE '%KING COUNTY%' AND STATE='53'");
  });

  /**
   * Case-insensitively, "Jersey City" equals both Jersey City's BASENAME and the NAME "Jersey
   * city" of Jersey, GA — the place the caller named is the one whose own name it is.
   */
  it('ranks a BASENAME match above a NAME that only differs by case', async () => {
    queue({
      features: [
        feature({ NAME: 'Jersey city', BASENAME: 'Jersey', STATE: '13', PLACE: '41932' }),
        feature({
          NAME: 'Jersey City city',
          BASENAME: 'Jersey City',
          STATE: '34',
          PLACE: '36000',
        }),
      ],
    });

    await expect(resolve('Jersey City')).resolves.toMatchObject({
      stateFips: '34',
      placeFips: '36000',
    });
  });

  it('still matches a full NAME when no BASENAME equals the term', async () => {
    queue({
      features: [
        feature({ NAME: 'Seattle city', BASENAME: 'Seattle', STATE: '53', PLACE: '63000' }),
        feature({
          NAME: 'Seattle Hill CDP',
          BASENAME: 'Seattle Hill',
          STATE: '53',
          PLACE: '63025',
        }),
      ],
    });

    await expect(resolve('seattle city, WA', 'place')).resolves.toMatchObject({
      placeFips: '63000',
    });
  });

  it('still escapes a quote in the uppercased term', async () => {
    await resolve("O'Fallon, MO", 'place').catch(() => undefined);

    expect(whereClauses()[0]).toBe("UPPER(NAME) LIKE '%O''FALLON%' AND STATE='29'");
  });
});

describe('GeographyService.resolveGeography — ZIP codes', () => {
  const ZCTA = 'zip code tabulation area';
  const zcta98109 = {
    features: [feature({ NAME: 'ZCTA5 98109', BASENAME: '98109', GEOID: '98109', ZCTA5: '98109' })],
  };
  const hintOf = (err: unknown) =>
    (err as { data: { recovery: { hint: string } } }).data.recovery.hint;

  it('auto-detects a bare 5-digit ZIP as a ZCTA and matches it by GEOID', async () => {
    queue(zcta98109);

    const result = await resolve('98109');

    expect(result).toEqual({ name: 'ZCTA5 98109', geographyType: ZCTA, fipsSummary: '98109' });
    // The ZCTA layer has no STATE, so no parent is reported.
    expect(result).not.toHaveProperty('stateFips');
    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).toContain('PUMA_TAD_TAZ_UGA_ZCTA/MapServer/1');
    expect(whereClauses()[0]).toBe("GEOID='98109'");
  });

  it('resolves a ZIP+4 by its first five digits', async () => {
    queue(zcta98109);

    await expect(resolve('98109-1234')).resolves.toMatchObject({ fipsSummary: '98109' });
    expect(whereClauses()[0]).toBe("GEOID='98109'");
  });

  it('resolves a ZIP when the ZCTA level is set explicitly', async () => {
    queue(zcta98109);

    await expect(resolve('98109', ZCTA)).resolves.toMatchObject({ geographyType: ZCTA });
  });

  it('says a ZIP with no ZCTA was checked only as one, and points cbp at the ZIP itself', async () => {
    const err = await resolve('98111').catch((e: unknown) => e);

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_match', attemptedTypes: [ZCTA] },
    });
    const hint = hintOf(err);
    expect(hint).toContain('only as a ZIP Code Tabulation Area');
    expect(hint).toContain('cbp');
    expect(hint).toContain('geography_fips');
    expect(hint).toContain('"zip code"');
    expect(hint).not.toContain(', WA');
    expect(hint).not.toContain('Add the state abbreviation');
    // A ZCTA lookup is an exact code match — there is no spelling variant to retry.
    expect(requestedUrls).toHaveLength(1);
  });

  it('never queries the ZCTA layer for a name that is not a ZIP', async () => {
    const err = await resolve('Seattle', ZCTA).catch((e: unknown) => e);

    expect(err).toMatchObject({ data: { reason: 'no_match' } });
    expect(hintOf(err)).toContain('5-digit');
    expect(requestedUrls).toHaveLength(0);
  });

  it('rejects county_fips on a ZIP before any request', async () => {
    await expect(resolve('98109', undefined, '033')).rejects.toMatchObject({
      data: { reason: 'county_scope_unsupported', attemptedTypes: [ZCTA] },
    });
    expect(requestedUrls).toHaveLength(0);
  });

  it('leaves a 5-digit name on the place layer when place is set explicitly', async () => {
    await resolve('12420', 'place').catch(() => undefined);

    expect(requestedUrls[0]).toContain('Places_CouSub_ConCity_SubMCD/MapServer/4');
  });
});

describe('GeographyService.resolveGeography — Saint and accent retries', () => {
  const CBSA = 'metropolitan statistical area/micropolitan statistical area';
  const place = (NAME: string, BASENAME: string, STATE: string, PLACE: string) =>
    feature({ NAME, BASENAME, STATE, PLACE });

  it('retries "Saint" as "St." and prefers the exactly-named row', async () => {
    queue(
      { features: [] },
      { features: [] },
      { features: [] },
      {
        features: [
          place('Lake St. Louis city', 'Lake St. Louis', '29', '40096'),
          place('St. Louis city', 'St. Louis', '29', '65000'),
        ],
      },
    );

    await expect(resolve('Saint Louis, MO')).resolves.toMatchObject({
      name: 'St. Louis city',
      placeFips: '65000',
    });
    // Both levels' primary queries — the place level's two layers, then the county — run
    // before any retry.
    expect(whereClauses()).toEqual([
      "UPPER(NAME) LIKE '%SAINT LOUIS%' AND STATE='29'",
      "UPPER(NAME) LIKE '%SAINT LOUIS%' AND STATE='29'",
      "UPPER(NAME) LIKE '%SAINT LOUIS%' AND STATE='29'",
      "UPPER(NAME) LIKE '%ST. LOUIS%' AND STATE='29'",
      "UPPER(NAME) LIKE '%ST. LOUIS%' AND STATE='29'",
    ]);
    expect(requestedUrls[2]).toContain('State_County/MapServer/1');
    expect(requestedUrls[3]).toContain('Places_CouSub_ConCity_SubMCD/MapServer/4');
  });

  it('retries a county name with "Saint" rewritten', async () => {
    queue(
      { features: [] },
      {
        features: [
          feature({ NAME: 'St. Louis County', BASENAME: 'St. Louis', STATE: '29', COUNTY: '189' }),
        ],
      },
    );

    await expect(resolve('Saint Louis County, MO')).resolves.toMatchObject({ countyFips: '189' });
    expect(whereClauses()[1]).toBe("UPPER(NAME) LIKE '%ST. LOUIS COUNTY%' AND STATE='29'");
  });

  it('retries a bare "St" with its period', async () => {
    queue(
      { features: [] },
      { features: [] },
      { features: [] },
      {
        features: [
          place('North St. Paul city', 'North St. Paul', '27', '46924'),
          place('West St. Paul city', 'West St. Paul', '27', '69700'),
          place('South St. Paul city', 'South St. Paul', '27', '61492'),
          place('St. Paul Park city', 'St. Paul Park', '27', '58036'),
          place('St. Paul city', 'St. Paul', '27', '58000'),
        ],
      },
    );

    await expect(resolve('St Paul, MN')).resolves.toMatchObject({ placeFips: '58000' });
    expect(whereClauses()[3]).toBe("UPPER(NAME) LIKE '%ST. PAUL%' AND STATE='27'");
  });

  it('retries "St." as "Saint" for the places spelled out in full', async () => {
    queue(
      { features: [] },
      { features: [] },
      { features: [] },
      { features: [place('Saint Jo city', 'Saint Jo', '48', '64184')] },
    );

    await expect(resolve('St. Jo, TX')).resolves.toMatchObject({ placeFips: '64184' });
    expect(whereClauses()[3]).toBe("UPPER(NAME) LIKE '%SAINT JO%' AND STATE='48'");
  });

  it('retries "Ste" as "Ste."', async () => {
    queue(
      { features: [] },
      {
        features: [
          feature({
            NAME: 'Ste. Genevieve County',
            BASENAME: 'Ste. Genevieve',
            STATE: '29',
            COUNTY: '186',
          }),
        ],
      },
    );

    await expect(resolve('Ste Genevieve County, MO')).resolves.toMatchObject({ countyFips: '186' });
    expect(whereClauses()[1]).toBe("UPPER(NAME) LIKE '%STE. GENEVIEVE COUNTY%' AND STATE='29'");
  });

  it('wildcards the letters that carry accents and keeps rows that fold to the term', async () => {
    queue(
      { features: [] },
      {
        features: [
          feature({ NAME: 'Doña Ana County', BASENAME: 'Doña Ana', STATE: '35', COUNTY: '013' }),
          // Matches the wildcard pattern but not the name once accents are folded away.
          feature({ NAME: 'Dina Ina County', BASENAME: 'Dina Ina', STATE: '35', COUNTY: '999' }),
        ],
      },
    );

    await expect(resolve('Dona Ana County, NM')).resolves.toMatchObject({
      name: 'Doña Ana County',
      countyFips: '013',
    });
    expect(whereClauses()[1]).toBe("UPPER(NAME) LIKE '%D___ ___ C___TY%' AND STATE='35'");
  });

  it('resolves an unaccented place name', async () => {
    queue(
      { features: [] },
      { features: [] },
      { features: [] },
      { features: [place('Española city', 'Española', '35', '25170')] },
    );

    await expect(resolve('Espanola, NM')).resolves.toMatchObject({ placeFips: '25170' });
    expect(whereClauses()[3]).toBe("UPPER(NAME) LIKE '%ESP___L_%' AND STATE='35'");
  });

  it('resolves an unaccented statistical-area name, scoped through the row names', async () => {
    queue(
      { features: [] },
      { features: [] },
      {
        features: [
          feature({
            NAME: 'Mayagüez, PR Metro Area',
            BASENAME: 'Mayagüez, PR',
            GEOID: '32420',
          }),
        ],
      },
      { features: [] },
    );

    await expect(resolve('Mayaguez, PR', CBSA)).resolves.toMatchObject({ fipsSummary: '32420' });
    expect(whereClauses()[2]).toBe("UPPER(NAME) LIKE '%M_Y_G_EZ%'");
  });

  it('never retries after a primary hit', async () => {
    queue({ features: [place('St. Louis city', 'St. Louis', '29', '65000')] });

    await expect(resolve('St. Louis, MO')).resolves.toMatchObject({ placeFips: '65000' });
    // The place level's two layers, and nothing after them.
    expect(requestedUrls).toHaveLength(2);
  });

  it('reports a retry that matches two rows as ambiguous_name rather than picking one', async () => {
    queue(
      { features: [] },
      { features: [] },
      { features: [] },
      {
        features: [
          place('North St. Paul city', 'North St. Paul', '27', '46924'),
          place('West St. Paul city', 'West St. Paul', '27', '69700'),
        ],
      },
    );

    await expect(resolve('Saint Paul, MN')).rejects.toMatchObject({
      data: {
        reason: 'ambiguous_name',
        candidates: [{ fipsSummary: '46924' }, { fipsSummary: '69700' }],
      },
    });
  });

  it('retries only the accent spelling when the name has no Saint token', async () => {
    await resolve('Nowhere, WA').catch(() => undefined);

    expect(whereClauses()).toEqual([
      "UPPER(NAME) LIKE '%NOWHERE%' AND STATE='53'",
      "UPPER(NAME) LIKE '%NOWHERE%' AND STATE='53'",
      "UPPER(NAME) LIKE '%NOWHERE%' AND STATE='53'",
      "UPPER(NAME) LIKE '%__WHERE%' AND STATE='53'",
      "UPPER(NAME) LIKE '%__WHERE%' AND STATE='53'",
      "UPPER(NAME) LIKE '%__WHERE%' AND STATE='53'",
    ]);
  });

  it('never retries a tract name, whose layer holds no Saint or accented names', async () => {
    await resolve('Census Tract 9999, WA').catch(() => undefined);

    expect(requestedUrls).toHaveLength(1);
  });
});

describe('GeographyService.resolveGeography — prior statistical-area names', () => {
  const CBSA = 'metropolitan statistical area/micropolitan statistical area';
  const CSA = 'combined statistical area';
  const METRO = 'CBSA/MapServer/3';
  const MICRO = 'CBSA/MapServer/4';
  const area = (NAME: string, BASENAME: string, GEOID: string) =>
    feature({ NAME, BASENAME, GEOID });
  const hintOf = (err: unknown) =>
    (err as { data: { recovery: { hint: string } } }).data.recovery.hint;

  it.each([
    ['Denver-Aurora-Lakewood, CO', 'DENVER', 'Denver-Aurora-Centennial, CO', '19740'],
    ['Austin-Round Rock-Georgetown, TX', 'AUSTIN', 'Austin-Round Rock-San Marcos, TX', '12420'],
    [
      'San Francisco-Oakland-Berkeley, CA',
      'SAN FRANCISCO',
      'San Francisco-Oakland-Fremont, CA',
      '41860',
    ],
    [
      'Miami-Fort Lauderdale-Pompano Beach, FL',
      'MIAMI',
      'Miami-Fort Lauderdale-West Palm Beach, FL',
      '33100',
    ],
    ['Denver-Aurora-Lakewood, Colorado', 'DENVER', 'Denver-Aurora-Centennial, CO', '19740'],
  ])(
    'resolves the renamed CBSA "%s" through its leading city',
    async (input, leading, current, code) => {
      route(METRO, `UPPER(NAME) LIKE '%${leading}%'`, {
        features: [area(`${current} Metro Area`, current, code)],
      });

      await expect(resolve(input, CBSA)).resolves.toMatchObject({
        name: `${current} Metro Area`,
        fipsSummary: code,
      });
      // The full name was tried as given first.
      expect(whereClauses()[0]).not.toBe(`UPPER(NAME) LIKE '%${leading}%'`);
    },
  );

  it('scopes the leading-city retry by the first state of a multi-state list', async () => {
    route(METRO, "UPPER(NAME) LIKE '%OMAHA%'", {
      features: [area('Omaha, NE-IA Metro Area', 'Omaha, NE-IA', '36540')],
    });
    route(MICRO, "UPPER(NAME) LIKE '%OMAHA%'", {
      features: [area('Omaha, IA Micro Area', 'Omaha, IA', '99999')],
    });

    await expect(resolve('Omaha-Council Bluffs, NE-IA', CBSA)).resolves.toMatchObject({
      fipsSummary: '36540',
    });
  });

  it('resolves a prior name that is still a substring of the current one on the first query', async () => {
    route(METRO, "UPPER(NAME) LIKE '%NEW YORK-NEWARK-JERSEY CITY%'", {
      features: [
        area(
          'New York-Newark-Jersey City, NY-NJ Metro Area',
          'New York-Newark-Jersey City, NY-NJ',
          '35620',
        ),
      ],
    });

    await expect(resolve('New York-Newark-Jersey City, NY-NJ-PA', CBSA)).resolves.toMatchObject({
      fipsSummary: '35620',
    });
    expect(requestedUrls).toHaveLength(2);
  });

  it('resolves a merged CSA to the area its leading city now sits in', async () => {
    route('CBSA/MapServer/0', "UPPER(NAME) LIKE '%KERRVILLE%'", {
      features: [
        area(
          'San Antonio-New Braunfels-Kerrville, TX CSA',
          'San Antonio-New Braunfels-Kerrville, TX',
          '484',
        ),
      ],
    });

    await expect(resolve('Kerrville-Fredericksburg, TX', CSA)).resolves.toMatchObject({
      fipsSummary: '484',
    });
  });

  it.each([
    [
      'Bend, OR',
      [area('Bend, OR Metro Area', 'Bend, OR', '13460')],
      [area('Coos Bay-North Bend, OR Micro Area', 'Coos Bay-North Bend, OR', '18300')],
      '13460',
    ],
    [
      'Ashland, OH',
      [area('Huntington-Ashland, WV-KY-OH Metro Area', 'Huntington-Ashland, WV-KY-OH', '26580')],
      [area('Ashland, OH Micro Area', 'Ashland, OH', '11740')],
      '11740',
    ],
  ])(
    'prefers the exact current name "%s" over an area that merely contains it',
    async (input, metro, micro, code) => {
      queue({ features: metro }, { features: micro });

      await expect(resolve(input, CBSA)).resolves.toMatchObject({ fipsSummary: code });
      expect(requestedUrls).toHaveLength(2);
    },
  );

  it('never retries a full current name that resolves on the first query', async () => {
    route(METRO, "UPPER(NAME) LIKE '%SEATTLE-TACOMA-BELLEVUE%'", {
      features: [
        area('Seattle-Tacoma-Bellevue, WA Metro Area', 'Seattle-Tacoma-Bellevue, WA', '42660'),
      ],
    });

    await expect(resolve('Seattle-Tacoma-Bellevue, WA', CBSA)).resolves.toMatchObject({
      fipsSummary: '42660',
    });
    expect(requestedUrls).toHaveLength(2);
  });

  it('reports a leading city several areas share as ambiguous_name', async () => {
    route(METRO, "UPPER(NAME) LIKE '%COLUMBUS%'", {
      features: [
        area('Columbus, OH Metro Area', 'Columbus, OH', '18140'),
        area('Columbus, GA-AL Metro Area', 'Columbus, GA-AL', '17980'),
      ],
    });

    await expect(resolve('Columbus-Auburn-Opelika', CBSA)).rejects.toMatchObject({
      data: { reason: 'ambiguous_name' },
    });
  });

  it('suggests a single city when no statistical area matched', async () => {
    const err = await resolve('Nowhere-Else, CO', CBSA).catch((e: unknown) => e);

    expect(err).toMatchObject({ data: { reason: 'no_match', attemptedTypes: [CBSA] } });
    const hint = hintOf(err);
    expect(hint).toContain('"Nowhere-Else"');
    expect(hint).toContain('CO');
    expect(hint).toContain('single city');
    expect(hint).not.toContain('street address');
    expect(hint).not.toContain('geography_type');
    expect(whereClauses()).toContain("UPPER(NAME) LIKE '%NOWHERE%'");
  });

  it('never takes a leading city on a level whose names are not statistical areas', async () => {
    await resolve('Winston-Salem, NC', 'place').catch(() => undefined);

    expect(whereClauses()).not.toContain("UPPER(NAME) LIKE '%WINSTON%' AND STATE='37'");
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

  /** The layers the geocoder answers for "400 Broad St, Seattle, WA 98109", trimmed. */
  const broadSt = (withPlace: boolean) => ({
    result: {
      addressMatches: [
        {
          matchedAddress: '400 BROAD ST, SEATTLE, WA, 98109',
          geographies: {
            'Census Tracts': [{ STATE: '53', COUNTY: '033', TRACT: '007101' }],
            '2020 Census Blocks': [
              { STATE: '53', COUNTY: '033', TRACT: '007101', BLKGRP: '2', BLOCK: '2001' },
            ],
            ...(withPlace && {
              'Incorporated Places': [{ STATE: '53', PLACE: '63000', NAME: 'Seattle city' }],
            }),
          },
        },
      ],
    },
  });

  it('carries the block group and incorporated place, and stays at the tract', async () => {
    queue(broadSt(true));

    const result = await resolve('400 Broad St, Seattle, WA 98109');

    expect(result).toEqual({
      name: '400 BROAD ST, SEATTLE, WA, 98109',
      geographyType: 'tract',
      stateFips: '53',
      countyFips: '033',
      tractFips: '007101',
      blockGroupFips: '2',
      placeFips: '63000',
      fipsSummary: '007101',
    });
    // Both come from layers the geocoder already answers — no second request.
    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).toContain('layers=8,12,28');
  });

  it('omits place_fips for an address outside any incorporated place', async () => {
    queue(broadSt(false));

    const result = await resolve('400 Broad St, Seattle, WA 98109');

    expect(result).toMatchObject({ tractFips: '007101', blockGroupFips: '2' });
    expect(result).not.toHaveProperty('placeFips');
  });

  it('omits the block group when the geocoder returns no block', async () => {
    queue({
      result: {
        addressMatches: [
          {
            matchedAddress: '1600 PENNSYLVANIA AVE NW, WASHINGTON, DC, 20500',
            geographies: { 'Census Tracts': [{ STATE: '11', COUNTY: '001', TRACT: '006202' }] },
          },
        ],
      },
    });

    const result = await resolve('1600 Pennsylvania Ave NW, Washington, DC 20500');

    expect(result).not.toHaveProperty('blockGroupFips');
    expect(result).not.toHaveProperty('placeFips');
  });
});

describe('GeographyService.resolveGeography — economic places', () => {
  const ECON = 'economic place' as GeographyType;
  const ECON_INCORPORATED = 'Econ/EconPlaces/MapServer/2';
  const ECON_CDP = 'Econ/EconPlaces/MapServer/3';
  const ECON_BALANCE = 'Econ/EconPlaces/MapServer/4';
  const PLACES_2022 = 'tigerWMS_ACS2022/MapServer/24';
  const CDPS_2022 = 'tigerWMS_ACS2022/MapServer/26';
  const COUSUBS_2022 = 'tigerWMS_ACS2022/MapServer/18';
  const COUNTIES_2022 = 'tigerWMS_ACS2022/MapServer/78';
  const econPlace = (NAME: string, BASENAME: string, STATE: string, PLACE: string) =>
    feature({ NAME, BASENAME, STATE, PLACE });
  const polygon = (id: number) => ({
    spatialReference: { wkid: 102100, latestWkid: 3857 },
    features: [
      {
        attributes: { NAME: 'boundary' },
        geometry: {
          rings: [
            [
              [id, 0],
              [id, 1],
              [id + 1, 0],
              [id, 0],
            ],
          ],
        },
      },
    ],
  });
  const counties = (...codes: string[]) => ({
    features: codes.map((COUNTY) => feature({ NAME: `County ${COUNTY}`, STATE: '53', COUNTY })),
  });
  const hintOf = (err: unknown) =>
    (err as { data: { recovery: { hint: string } } }).data.recovery.hint;

  it('prefixes the place code with the one county the place lies in', async () => {
    route(ECON_INCORPORATED, "UPPER(NAME) LIKE '%SEATTLE%' AND STATE='53'", {
      features: [econPlace('Seattle city', 'Seattle', '53', '63000')],
    });
    route(PLACES_2022, "STATE='53' AND PLACE='63000'", polygon(1));
    route(COUNTIES_2022, "STATE='53'", counties('033'));

    const result = await resolve('Seattle, WA', ECON);

    expect(result).toEqual({
      name: 'Seattle city',
      geographyType: 'economic place',
      stateFips: '53',
      placeFips: '63000',
      fipsSummary: '03363000',
    });
    // The name is searched across all three 2022 layers.
    for (const layer of [ECON_INCORPORATED, ECON_CDP, ECON_BALANCE]) {
      expect(requestedUrls.some((u) => u.includes(`/services/${layer}/query`))).toBe(true);
    }
    // The polygon goes to the counties layer as a DE-9IM interior intersection.
    expect(postBodies).toHaveLength(1);
    expect(postBodies[0]?.get('spatialRel')).toBe('esriSpatialRelRelation');
    expect(postBodies[0]?.get('relationParam')).toBe('T********');
    expect(postBodies[0]?.get('inSR')).toBe('102100');
    expect(JSON.parse(postBodies[0]?.get('geometry') ?? '{}')).toEqual(
      polygon(1).features[0]?.geometry,
    );
    expect(requestedUrls.find((u) => u.includes(PLACES_2022))).toContain('returnGeometry=true');
  });

  it('prefixes 000 for a place that spans counties', async () => {
    route(ECON_INCORPORATED, "UPPER(NAME) LIKE '%AUBURN%' AND STATE='53'", {
      features: [econPlace('Auburn city', 'Auburn', '53', '03180')],
    });
    route(PLACES_2022, "STATE='53' AND PLACE='03180'", polygon(2));
    route(COUNTIES_2022, "STATE='53'", counties('033', '053'));

    await expect(resolve('Auburn, WA', ECON)).resolves.toMatchObject({
      fipsSummary: '00003180',
      placeFips: '03180',
    });
  });

  it('reads a CDP boundary off the CDP layer and flags the CDP', async () => {
    route(ECON_CDP, "UPPER(NAME) LIKE '%SUNNYSLOPE%' AND STATE='53'", {
      features: [econPlace('Sunnyslope CDP', 'Sunnyslope', '53', '68785')],
    });
    route(CDPS_2022, "STATE='53' AND PLACE='68785'", polygon(3));
    route(COUNTIES_2022, "STATE='53'", counties('007'));

    await expect(resolve('Sunnyslope, WA', ECON)).resolves.toMatchObject({
      fipsSummary: '00768785',
      censusDesignatedPlace: true,
    });
    expect(requestedUrls.some((u) => u.includes(PLACES_2022))).toBe(false);
  });

  it('takes a balance of county straight from its 98xxx code, with no spatial query', async () => {
    route(ECON_BALANCE, "UPPER(NAME) LIKE '%BALANCE OF ADAMS COUNTY%' AND STATE='53'", {
      features: [econPlace('Balance of Adams County', 'Balance of Adams', '53', '98001')],
    });

    await expect(resolve('Balance of Adams County, WA', ECON)).resolves.toMatchObject({
      fipsSummary: '00198001',
      placeFips: '98001',
    });
    expect(requestedUrls.some((u) => u.includes('tigerWMS_ACS2022'))).toBe(false);
    expect(postBodies).toHaveLength(0);
  });

  it('reads a minor civil division county off the county subdivisions layer', async () => {
    route(ECON_INCORPORATED, "UPPER(NAME) LIKE '%EDISON%' AND STATE='34'", {
      features: [econPlace('Edison township', 'Edison', '34', '20230')],
    });
    route(COUSUBS_2022, "STATE='34' AND COUSUB='20230'", {
      features: [feature({ NAME: 'Edison township', STATE: '34', COUNTY: '023', COUSUB: '20230' })],
    });

    await expect(resolve('Edison, NJ', ECON)).resolves.toMatchObject({ fipsSummary: '02320230' });
    // No place polygon exists for a township, and a county subdivision nests in one county.
    expect(postBodies).toHaveLength(0);
  });

  it('answers a place with no economic place record as no_match, naming what qualifies', async () => {
    const err = await resolve('Krupp, WA', ECON).catch((e: unknown) => e);

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_match', attemptedTypes: ['economic place'] },
    });
    expect(hintOf(err)).toContain('2,500');
    expect(hintOf(err)).toContain('Balance of');
    expect(requestedUrls.some((u) => u.includes('tigerWMS_ACS2022'))).toBe(false);
  });

  it('fails as no_match rather than guessing a county when the 2022 boundary is missing', async () => {
    route(ECON_INCORPORATED, "UPPER(NAME) LIKE '%GONE%' AND STATE='53'", {
      features: [econPlace('Gone city', 'Gone', '53', '99990')],
    });

    const err = await resolve('Gone, WA', ECON).catch((e: unknown) => e);

    expect(err).toMatchObject({ data: { reason: 'no_match' } });
    expect(hintOf(err)).toContain('99990');
  });

  it('fails as resolution_unavailable, never a guessed code, when the county test errors', async () => {
    route(ECON_INCORPORATED, "UPPER(NAME) LIKE '%SEATTLE%' AND STATE='53'", {
      features: [econPlace('Seattle city', 'Seattle', '53', '63000')],
    });
    route(PLACES_2022, "STATE='53' AND PLACE='63000'", polygon(1));
    route(COUNTIES_2022, "STATE='53'", { error: { message: 'Unable to complete operation.' } });

    await expect(resolve('Seattle, WA', ECON)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'resolution_unavailable' },
    });
  });

  it('fails as resolution_unavailable when the county test places a polygon in no county', async () => {
    route(ECON_INCORPORATED, "UPPER(NAME) LIKE '%SEATTLE%' AND STATE='53'", {
      features: [econPlace('Seattle city', 'Seattle', '53', '63000')],
    });
    route(PLACES_2022, "STATE='53' AND PLACE='63000'", polygon(1));
    route(COUNTIES_2022, "STATE='53'", counties());

    await expect(resolve('Seattle, WA', ECON)).rejects.toMatchObject({
      data: { reason: 'resolution_unavailable' },
    });
  });

  it('answers a CDP with no 2022 boundary as no_match, with no county subdivision lookup', async () => {
    route(ECON_CDP, "UPPER(NAME) LIKE '%SUNNYSLOPE%' AND STATE='53'", {
      features: [econPlace('Sunnyslope CDP', 'Sunnyslope', '53', '68785')],
    });

    const err = await resolve('Sunnyslope, WA', ECON).catch((e: unknown) => e);

    expect(err).toMatchObject({ data: { reason: 'no_match', attemptedTypes: ['economic place'] } });
    expect(hintOf(err)).toContain('68785');
    expect(requestedUrls.some((u) => u.includes(CDPS_2022))).toBe(true);
    expect(requestedUrls.some((u) => u.includes(COUSUBS_2022))).toBe(false);
  });

  it('lists ambiguous candidates with their place code, never a county it did not look up', async () => {
    route(ECON_INCORPORATED, "UPPER(NAME) LIKE '%SPRINGFIELD%'", {
      features: [
        econPlace('Springfield city', 'Springfield', '17', '72000'),
        econPlace('Springfield city', 'Springfield', '29', '70000'),
      ],
    });

    const err = await resolve('Springfield', ECON).catch((e: unknown) => e);
    const { data } = err as {
      data: { reason: string; candidates: Array<Record<string, string>> };
    };

    expect(data.reason).toBe('ambiguous_name');
    expect(data.candidates.map((c) => c.placeFips)).toEqual(['72000', '70000']);
    expect(data.candidates.every((c) => !('fipsSummary' in c))).toBe(true);
    expect(hintOf(err)).toContain('re-call');
    expect(postBodies).toHaveLength(0);
  });

  it('is never auto-detected', async () => {
    await resolve('Seattle, WA').catch(() => undefined);

    expect(requestedUrls.some((u) => u.includes('Econ/EconPlaces'))).toBe(false);
  });

  it('rejects county_fips, since the layers carry no county', async () => {
    await expect(resolve('Seattle, WA', ECON, '033')).rejects.toMatchObject({
      data: { reason: 'county_scope_unsupported' },
    });
    expect(requestedUrls).toHaveLength(0);
  });
});
