/**
 * @fileoverview Tests for GeographyService — TIGERweb layer selection, the
 * place-then-county fallback chain, exact-name preference, and the state
 * abbreviation carried on ambiguous-match candidates — plus census_resolve_geography
 * run through this real service, where its result shape depends on what the service sets.
 * @module tests/services/geography/geography-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { censusResolveGeography } from '@/mcp-server/tools/definitions/census-resolve-geography.tool.js';
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

/**
 * A TIGERweb answer as TIGERweb serves it: each row carries only the attributes its request's
 * `outFields` names, so a field the service reads but never asks for never reaches it.
 */
const servedFields = (body: unknown, outFields: string[]): unknown => {
  const { features } = body as { features?: Array<{ attributes: Record<string, unknown> }> };
  if (!Array.isArray(features)) return body;
  return {
    ...(body as object),
    features: features.map((f) => ({
      ...f,
      attributes: Object.fromEntries(
        Object.entries(f.attributes).filter(([field]) => outFields.includes(field)),
      ),
    })),
  };
};

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
      const fixture = routes
        ? (routes.get(`${layerPath} ${where}`) ?? { features: [] })
        : (responses.shift() ?? { features: [] });
      // The geocoder takes no outFields and answers its layers whole.
      const outFields = form ? form.get('outFields') : new URL(href).searchParams.get('outFields');
      const body = outFields ? servedFields(fixture, outFields.split(',')) : fixture;
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
    const { message, data } = err as { message: string; data: { recovery: { hint: string } } };

    // #62: the parsed place and state are the diagnosis, so the message carries them once.
    expect(message).toBe('No place or county named "Nonexistent Place XYZ" exists in WA.');
    expect(data.recovery.hint).toContain('geography_type');
    expect(data.recovery.hint).not.toContain('WA');
    expect(data.recovery.hint).not.toContain('Nonexistent');
    expect(data.recovery.hint).not.toContain('Add the state abbreviation');
  });

  /** #62's reproduction: the hint used to open by restating the miss the message had stated. */
  it('states a county miss once, in the message, and keeps only the steps in the hint', async () => {
    const err = await resolve('Chatham County, WA', 'county').catch((e: unknown) => e);
    const { message, data } = err as { message: string; data: { recovery: { hint: string } } };

    expect(message).toBe('No county named "Chatham County" exists in WA.');
    // The level just tried is the miss, so county is not among the levels offered.
    expect(data.recovery.hint).toBe(
      'Check the spelling, set geography_type to search a different level (state, county subdivision, place, tract, metropolitan statistical area/micropolitan statistical area, combined statistical area, consolidated city, zip code tabulation area, economic place), or pass a full street address.',
    );
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
    expect(data.recovery.hint).toMatch(/the county of the one you want\.$/);
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
    const { message, data } = err as { message: string; data: { recovery: { hint: string } } };

    expect(message).toBe('No county named "Nowhere County" has code 033 in WA.');
    expect(data.recovery.hint).toContain('drop county_fips');
    expect(data.recovery.hint).not.toContain('033');
  });

  it('places a scoped miss on a level below the county inside that county', async () => {
    queue({ features: [] }, { features: [] });

    const err = await resolve('Nowhere Census Tract, WA', 'tract', '033').catch((e: unknown) => e);

    expect((err as { message: string }).message).toBe(
      'No tract named "Nowhere Census Tract" exists in county 033 of WA.',
    );
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

  it.each(['constructor', '__proto__'])(
    'reads "Nowhere, %s", a key every object carries, as no state',
    async (suffix) => {
      const err = await resolve(`Nowhere, ${suffix}`).catch((e: unknown) => e);

      expect(err).toMatchObject({ data: { reason: 'no_match' } });
      expect((err as { message: string }).message).toBe(
        `No place or county matched "Nowhere, ${suffix}".`,
      );
    },
  );

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

  /** #62: the split place and state moved from the hint into the message, which names them once. */
  it('builds the no_match message from the split place and state', async () => {
    const err = await resolve('Chatham County, Georgia').catch((e: unknown) => e);
    const { message } = err as { message: string };

    expect(err).toMatchObject({ data: { reason: 'no_match' } });
    expect(message).toContain('named "Chatham County" exists in GA.');
    expect(message).not.toContain('Georgia');
    expect(hintOf(err)).not.toContain('Chatham');
    expect(hintOf(err)).not.toContain('GA');
    expect(hintOf(err)).not.toContain('Add the state abbreviation');
  });

  it.each([
    ['Seattle, wa', 'Seattle', 'WA'],
    ['Omaha-Council Bluffs, NE-IA', 'Omaha-Council Bluffs', 'NE-IA'],
    ['San Juan, Puerto Rico', 'San Juan', 'PR'],
  ])(
    'never appends a second state to "%s" in the no_match message',
    async (input, placeName, state) => {
      const err = await resolve(input, 'place').catch((e: unknown) => e);
      const { message } = err as { message: string };

      expect(message).toBe(`No place named "${placeName}" exists in ${state}.`);
      expect(hintOf(err)).not.toContain(placeName);
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
    // #62: what was checked is the diagnosis; the cbp route is the step.
    expect((err as { message: string }).message).toBe(
      'No ZIP Code Tabulation Area (ZCTA) has the code "98111" — it was checked only as a ZCTA, not as a ZIP.',
    );
    expect(hint).toContain('cbp');
    expect(hint).toContain('geography_fips');
    expect(hint).toContain('"zip code"');
    expect(hint).not.toContain('98111');
    expect(hint).not.toContain('only as a ZIP Code Tabulation Area');
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
    // Minnesota's chain ends at the county subdivision level, so four primary queries come first.
    queue(
      { features: [] },
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
    expect(whereClauses()[3]).toBe(
      "UPPER(NAME) LIKE '%ST PAUL%' AND STATE='27' AND COUSUB<>'00000'",
    );
    expect(whereClauses()[4]).toBe("UPPER(NAME) LIKE '%ST. PAUL%' AND STATE='27'");
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
    expect((err as { message: string }).message).toBe(
      `No ${CBSA} named "Nowhere-Else" covers CO, and none contains its leading city "Nowhere".`,
    );
    expect(hint).not.toContain('Nowhere');
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
    expect(requestedUrls[0]).toContain('layers=8,12,22,28');
  });

  it.each([
    [
      '820 Mercer St, Cherry Hill, NJ 08002',
      { STATE: '34', COUNTY: '007', TRACT: '603301' },
      { COUSUB: '12280', STATE: '34', COUNTY: '007', NAME: 'Cherry Hill township' },
      '12280',
    ],
    [
      '400 Broad St, Seattle, WA 98109',
      { STATE: '53', COUNTY: '033', TRACT: '007101' },
      { COUSUB: '92928', STATE: '53', COUNTY: '033', NAME: 'Seattle CCD' },
      '92928',
    ],
    // A code sent without its leading zero comes back padded to the five digits FIPS keys on.
    [
      '5583 Main St, Williamsville, NY 14221',
      { STATE: '36', COUNTY: '029', TRACT: '009102' },
      { COUSUB: '2000', STATE: '36', COUNTY: '029', NAME: 'Amherst town' },
      '02000',
    ],
  ])(
    'carries the county subdivision "%s" sits in, from geocoder layer 22',
    async (address, tract, subdivision, code) => {
      queue({
        result: {
          addressMatches: [
            {
              matchedAddress: address.toUpperCase(),
              geographies: { 'Census Tracts': [tract], 'County Subdivisions': [subdivision] },
            },
          ],
        },
      });

      const result = await resolve(address);

      expect(result).toMatchObject({
        geographyType: 'tract',
        tractFips: tract.TRACT,
        fipsSummary: tract.TRACT,
        countySubdivisionFips: code,
      });
      expect(requestedUrls).toHaveLength(1);
      expect(requestedUrls[0]).toContain('layers=8,12,22,28');
    },
  );

  it('omits the county subdivision when the geocoder returns none', async () => {
    queue(broadSt(true));

    const result = await resolve('400 Broad St, Seattle, WA 98109');

    expect(result).not.toHaveProperty('countySubdivisionFips');
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

  /**
   * #62: the message said to include a ZIP code and the hint said it again — to a caller whose
   * address already carried one. The message now states the miss alone, and the hint asks for a
   * ZIP only when the address has none.
   */
  it.each([
    ['99999 Nonexistent Boulevard, Faketown, WA 98999', /^Check the house number and street name/],
    ['99999 Nonexistent Boulevard, Faketown, WA', /^Add the ZIP code/],
  ])(
    'states an unmatched address in the message and the step in the hint: %s',
    async (address, step) => {
      queue({ result: { addressMatches: [] } });

      const err = await resolve(address).catch((e: unknown) => e);
      const { message, data } = err as {
        message: string;
        data: { reason: string; recovery: { hint: string } };
      };

      expect(data.reason).toBe('no_match');
      expect(message).toBe(`Address "${address}" could not be geocoded.`);
      expect(data.recovery.hint).toMatch(step);
      expect(data.recovery.hint).not.toContain(address);
    },
  );
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
    expect((err as { message: string }).message).toBe(
      'No 2022 economic place named "Krupp" exists in WA.',
    );
    expect(hintOf(err)).toContain('2,500');
    expect(hintOf(err)).toContain('Balance of');
    expect(hintOf(err)).not.toContain('Krupp');
    expect(requestedUrls.some((u) => u.includes('tigerWMS_ACS2022'))).toBe(false);
  });

  it('fails as no_match rather than guessing a county when the 2022 boundary is missing', async () => {
    route(ECON_INCORPORATED, "UPPER(NAME) LIKE '%GONE%' AND STATE='53'", {
      features: [econPlace('Gone city', 'Gone', '53', '99990')],
    });

    const err = await resolve('Gone, WA', ECON).catch((e: unknown) => e);

    expect(err).toMatchObject({ data: { reason: 'no_match' } });
    // #62: the place code is stated once, in the message; the hint refers back to it.
    expect((err as { message: string }).message).toContain('(place code 99990)');
    expect(hintOf(err)).not.toContain('99990');
    expect(hintOf(err)).toContain('take the row whose code ends in the place code');
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
    // #62: the place code is stated once, in the message.
    expect((err as { message: string }).message).toContain('(place code 68785)');
    expect(hintOf(err)).not.toContain('68785');
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

describe('GeographyService.resolveGeography — New York City boroughs', () => {
  const INCORPORATED = 'Places_CouSub_ConCity_SubMCD/MapServer/4';
  const COUNTIES = 'State_County/MapServer/1';

  const hintOf = (err: unknown) =>
    (err as { data: { recovery: { hint: string } } }).data.recovery.hint;

  /** `UPPER(NAME) LIKE` clause the service sends for a term, scoped to a state FIPS. */
  const like = (term: string, stateFips?: string) =>
    `UPPER(NAME) LIKE '%${term}%'${stateFips ? ` AND STATE='${stateFips}'` : ''}`;

  /** TIGERweb county rows, as the State_County layer returns them for New York State. */
  const nyCounty = (basename: string, county: string) =>
    feature({ NAME: `${basename} County`, BASENAME: basename, STATE: '36', COUNTY: county });
  const nyPlace = (name: string, basename: string, place: string) =>
    feature({ NAME: name, BASENAME: basename, STATE: '36', PLACE: place });

  /**
   * The rows TIGERweb holds for these terms in New York State: each borough's county by its legal
   * name, and the places that only contain one of the names. No place row contains BROOKLYN,
   * MANHATTAN, STATEN ISLAND, or QUEENS.
   */
  const serveNewYork = () => {
    route(COUNTIES, like('KINGS', '36'), { features: [nyCounty('Kings', '047')] });
    route(COUNTIES, like('NEW YORK', '36'), { features: [nyCounty('New York', '061')] });
    route(COUNTIES, like('RICHMOND', '36'), { features: [nyCounty('Richmond', '085')] });
    route(COUNTIES, like('BRONX', '36'), { features: [nyCounty('Bronx', '005')] });
    route(COUNTIES, like('QUEENS', '36'), { features: [nyCounty('Queens', '081')] });
    route(COUNTIES, like('KINGS COUNTY', '36'), { features: [nyCounty('Kings', '047')] });
    route(INCORPORATED, like('NEW YORK', '36'), {
      features: [
        nyPlace('New York Mills village', 'New York Mills', '51011'),
        nyPlace('New York city', 'New York', '51000'),
      ],
    });
    route(INCORPORATED, like('BRONX', '36'), {
      features: [nyPlace('Bronxville village', 'Bronxville', '08532')],
    });
    route(INCORPORATED, like('RICHMOND', '36'), {
      features: [nyPlace('Richmondville village', 'Richmondville', '61588')],
    });
  };

  /** The places the bare and out-of-state borough names match, as TIGERweb returns them. */
  const serveOtherStates = () => {
    const place = (name: string, basename: string, state: string, code: string) =>
      feature({ NAME: name, BASENAME: basename, STATE: state, PLACE: code });
    route(INCORPORATED, like('BROOKLYN'), {
      features: [
        place('Brooklyn village', 'Brooklyn', '17', '08667'),
        place('Brooklyn town', 'Brooklyn', '18', '08038'),
        place('Brooklyn village', 'Brooklyn', '26', '11000'),
        place('Brooklyn village', 'Brooklyn', '55', '10075'),
        place('Brooklyn city', 'Brooklyn', '19', '08695'),
        place('Brooklyn city', 'Brooklyn', '39', '09246'),
      ],
    });
    route(INCORPORATED, like('MANHATTAN'), {
      features: [
        place('Manhattan town', 'Manhattan', '30', '47575'),
        place('Manhattan village', 'Manhattan', '17', '46357'),
        place('Manhattan city', 'Manhattan', '20', '44250'),
      ],
    });
    route(INCORPORATED, like('MANHATTAN', '20'), {
      features: [place('Manhattan city', 'Manhattan', '20', '44250')],
    });
    route(INCORPORATED, like('BROOKLYN PARK', '27'), {
      features: [place('Brooklyn Park city', 'Brooklyn Park', '27', '07966')],
    });
    route(INCORPORATED, like('BROOKLYN', '39'), {
      features: [place('Brooklyn city', 'Brooklyn', '39', '09246')],
    });
  };

  it.each([
    ['Queens, NY', 'QUEENS', '081'],
    ['Bronx, NY', 'BRONX', '005'],
    ['Richmond, NY', 'RICHMOND', '085'],
  ])(
    'resolves "%s", already its county name, with the requests any other name sends',
    async (name, term, county) => {
      serveNewYork();

      const result = await resolve(name);

      expect(result).toMatchObject({
        geographyType: 'county',
        stateFips: '36',
        fipsSummary: county,
      });
      expect(result).not.toHaveProperty('borough');
      // Place, county, then the check for a governing subdivision a New York county answer gets.
      expect(whereClauses()).toEqual([
        like(term, '36'),
        like(term, '36'),
        like(term, '36'),
        subdivisionClause(term, '36'),
      ]);
      expect(requestedUrls[2]).toContain(COUNTIES);
    },
  );

  it('resolves "Kings County, NY" on the county layer alone, with no borough', async () => {
    serveNewYork();

    const result = await resolve('Kings County, NY');

    expect(result).toMatchObject({ name: 'Kings County', fipsSummary: '047' });
    expect(result).not.toHaveProperty('borough');
    expect(whereClauses()).toEqual([like('KINGS COUNTY', '36')]);
  });

  it('keeps "New York, NY" on New York city, never querying the county layer', async () => {
    serveNewYork();

    const result = await resolve('New York, NY');

    expect(result).toMatchObject({ geographyType: 'place', placeFips: '51000' });
    expect(result).not.toHaveProperty('borough');
    expect(requestedUrls.some((u) => u.includes(COUNTIES))).toBe(false);
  });

  it.each([
    ['Manhattan, KS', 'MANHATTAN', '20', '44250'],
    ['Brooklyn Park, MN', 'BROOKLYN PARK', '27', '07966'],
    ['Brooklyn, OH', 'BROOKLYN', '39', '09246'],
  ])('leaves "%s" outside New York untouched', async (name, term, stateFips, place) => {
    serveOtherStates();

    const result = await resolve(name);

    expect(result).toMatchObject({ geographyType: 'place', stateFips, placeFips: place });
    expect(result).not.toHaveProperty('borough');
    expect(whereClauses()).toEqual([like(term, stateFips), like(term, stateFips)]);
  });

  it.each([
    ['Brooklyn', 6],
    ['Manhattan', 3],
  ])('keeps a bare "%s" ambiguous among places, with no county query', async (name, count) => {
    serveOtherStates();

    const err = await resolve(name).catch((e: unknown) => e);

    expect(err).toMatchObject({ data: { reason: 'ambiguous_name' } });
    expect((err as { data: { candidates: unknown[] } }).data.candidates).toHaveLength(count);
    expect(whereClauses()).toEqual([like(name.toUpperCase()), like(name.toUpperCase())]);
  });

  it.each(['Brooklyn, NY', 'Manhattan, NY'])(
    'never maps "%s" at the place level, so it never reaches New York city',
    async (name) => {
      serveNewYork();

      const err = await resolve(name, 'place').catch((e: unknown) => e);

      expect(err).toMatchObject({ data: { reason: 'no_match', attemptedTypes: ['place'] } });
      expect(requestedUrls.every((u) => !u.includes(COUNTIES))).toBe(true);
      expect(whereClauses().some((w) => w.includes('NEW YORK') || w.includes('KINGS'))).toBe(false);
    },
  );

  it.each([
    ['Brooklyn, NY', undefined],
    ['Brooklyn, New York', undefined],
    ['brooklyn, ny', undefined],
    ['Brooklyn, NY', 'county'],
    ['Brooklyn, New York', 'county'],
    ['brooklyn, ny', 'county'],
  ] as const)(
    'resolves "%s" (geography_type %s) to Kings County through its own query term',
    async (name, type) => {
      serveNewYork();

      const result = await resolve(name, type);

      expect(result).toEqual({
        name: 'Kings County',
        geographyType: 'county',
        stateFips: '36',
        countyFips: '047',
        fipsSummary: '047',
        borough: 'Brooklyn',
      });
      // The county level asks for KINGS in place of BROOKLYN; no respelling retry runs.
      const county = whereClauses().filter((_, i) => requestedUrls[i]?.includes(COUNTIES));
      expect(county).toEqual([like('KINGS', '36')]);
      expect(whereClauses().filter((w) => w.includes('_'))).toEqual([]);
    },
  );

  it.each([
    ['Manhattan, NY', 'NEW YORK', 'New York County', '061', 'Manhattan'],
    ['Staten Island, NY', 'RICHMOND', 'Richmond County', '085', 'Staten Island'],
    ['The Bronx, NY', 'BRONX', 'Bronx County', '005', 'The Bronx'],
    ['Queens borough, NY', 'QUEENS', 'Queens County', '081', 'Queens'],
    ['Staten Island borough, NY', 'RICHMOND', 'Richmond County', '085', 'Staten Island'],
    ['Staten  Island, NY', 'RICHMOND', 'Richmond County', '085', 'Staten Island'],
  ])('resolves "%s" to its county (%s)', async (name, term, countyName, county, borough) => {
    serveNewYork();

    const result = await resolve(name);

    expect(result).toMatchObject({
      name: countyName,
      geographyType: 'county',
      stateFips: '36',
      fipsSummary: county,
      borough,
    });
    expect(whereClauses().filter((_, i) => requestedUrls[i]?.includes(COUNTIES))).toEqual([
      like(term, '36'),
    ]);
  });

  it('answers "Queens borough, NY" from the county layer before the place layer is asked', async () => {
    serveNewYork();

    await resolve('Queens borough, NY');

    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).toContain(COUNTIES);
  });

  it('resolves "Manhattan, NY" to New York County, never the New York city place', async () => {
    serveNewYork();

    const result = await resolve('Manhattan, NY');

    expect(result).toMatchObject({ geographyType: 'county', fipsSummary: '061' });
    expect(result).not.toHaveProperty('placeFips');
    const placeClauses = whereClauses().filter((_, i) => requestedUrls[i]?.includes('Places_'));
    expect(placeClauses.some((w) => w.includes('NEW YORK'))).toBe(false);
  });

  it('keeps the county answer when a place row only contains the borough name', async () => {
    serveNewYork();
    route('Places_CouSub_ConCity_SubMCD/MapServer/5', like('BROOKLYN', '36'), {
      features: [nyPlace('Brooklyn Heights CDP', 'Brooklyn Heights', '10044')],
    });

    const result = await resolve('Brooklyn, NY');

    expect(result).toMatchObject({ name: 'Kings County', fipsSummary: '047', borough: 'Brooklyn' });
  });

  it('applies county_fips to the substituted term', async () => {
    serveNewYork();
    route(COUNTIES, `${like('KINGS', '36')} AND COUNTY='047'`, {
      features: [nyCounty('Kings', '047')],
    });

    const result = await resolve('Brooklyn, NY', undefined, '47');

    expect(result).toMatchObject({ fipsSummary: '047', borough: 'Brooklyn' });
    expect(whereClauses()).toEqual([`${like('KINGS', '36')} AND COUNTY='047'`]);
  });

  it('names the county a borough is when a county scope rules it out, after the retries', async () => {
    serveNewYork();

    const err = await resolve('Brooklyn, NY', undefined, '061').catch((e: unknown) => e);

    // A county scope keeps the county and county subdivision levels of New York's chain.
    expect(err).toMatchObject({
      data: { reason: 'no_match', attemptedTypes: ['county', 'county subdivision'] },
    });
    // The substituted term first, then the respelling retry of the name as given.
    expect(whereClauses()).toEqual([
      `${like('KINGS', '36')} AND COUNTY='061'`,
      subdivisionClause('BROOKLYN', '36', '061'),
      `${like('BR__KLY_', '36')} AND COUNTY='061'`,
      subdivisionClause('BR__KLY_', '36', '061'),
    ]);
    expect(hintOf(err)).toContain('Kings County (county 047)');
    // #62: the miss is the message's; the hint opens on the borough and the step.
    expect((err as { message: string }).message).toBe(
      'No county or county subdivision named "Brooklyn" exists in county 061 of NY.',
    );
    expect(hintOf(err)).toBe(
      'It is the New York City borough coextensive with Kings County (county 047), so drop county_fips or change it to 047.',
    );
  });

  it.each([
    ['Brooklyn, NY', 'Kings County (county 047)'],
    ['Manhattan, NY', 'New York County (county 061)'],
    ['Staten Island, NY', 'Richmond County (county 085)'],
  ])('names the county in the place-level no_match hint for "%s"', async (name, county) => {
    serveNewYork();

    const err = await resolve(name, 'place').catch((e: unknown) => e);

    expect(hintOf(err)).toContain(county);
    expect(hintOf(err)).toContain('geography_type "county"');
    expect(hintOf(err)).toMatch(/^It is the New York City borough coextensive with /);
    expect((err as { message: string }).message).toBe(
      `No place named "${name.replace(', NY', '')}" exists in NY.`,
    );
  });

  it.each(['Constructor, NY', '__proto__, NY'])(
    'reads "%s", a key every object carries, as no borough',
    async (name) => {
      const err = await resolve(name).catch((e: unknown) => e);

      expect(err).toMatchObject({ data: { reason: 'no_match' } });
      expect(hintOf(err)).not.toContain('borough');
    },
  );

  it('keeps the place-level no_match hint unchanged outside New York', async () => {
    const err = await resolve('Staten Island, VT', 'place').catch((e: unknown) => e);

    expect(hintOf(err)).not.toContain('borough');
    expect(hintOf(err)).not.toContain('Richmond');
  });

  it.each([
    ['Bronx, NY', like('BRONX', '36')],
    ['The Bronx, NY', like('THE BRONX', '36')],
  ])(
    'never settles "%s" at the place level on a place that only contains it',
    async (name, primary) => {
      serveNewYork();
      // The respelling retry finds Bronxville too, so the rule has to hold past the first query.
      route(INCORPORATED, like('BR__X', '36'), {
        features: [nyPlace('Bronxville village', 'Bronxville', '08532')],
      });

      const err = await resolve(name, 'place').catch((e: unknown) => e);

      expect(err).toMatchObject({ data: { reason: 'no_match', attemptedTypes: ['place'] } });
      expect(hintOf(err)).toContain('Bronx County (county 005)');
      expect(whereClauses()[0]).toBe(primary);
      if (name === 'Bronx, NY') expect(whereClauses()).toContain(like('BR__X', '36'));
    },
  );

  it('still answers a borough name at the place level from a place named exactly that', async () => {
    serveNewYork();
    route(INCORPORATED, like('BRONX', '36'), {
      features: [
        nyPlace('Bronxville village', 'Bronxville', '08532'),
        nyPlace('Bronx village', 'Bronx', '08500'),
      ],
    });

    const result = await resolve('Bronx, NY', 'place');

    expect(result).toMatchObject({ name: 'Bronx village', placeFips: '08500' });
  });

  it('resolves "Bronxville, NY" at the place level to Bronxville village', async () => {
    route(INCORPORATED, like('BRONXVILLE', '36'), {
      features: [nyPlace('Bronxville village', 'Bronxville', '08532')],
    });

    const result = await resolve('Bronxville, NY', 'place');

    expect(result).toMatchObject({ geographyType: 'place', placeFips: '08532' });
  });

  it('keeps a contains-only place answer for a New York name that is not a borough', async () => {
    serveNewYork();

    const result = await resolve('Richmond, NY', 'place');

    expect(result).toMatchObject({ name: 'Richmondville village', placeFips: '61588' });
    expect(whereClauses()).toEqual([like('RICHMOND', '36'), like('RICHMOND', '36')]);
  });

  it.each([
    ['Queens, NY', 'QUEENS', 'Queens County (county 081)'],
    ['Bronx, NY', 'BRONX', 'Bronx County (county 005)'],
  ])(
    'never settles "%s" at the economic place level on a place that only contains it',
    async (name, term, county) => {
      // Queensbury town (Warren County) and Bronxville village are 2022 economic places.
      route('Econ/EconPlaces/MapServer/2', like(term, '36'), {
        features: [
          term === 'QUEENS'
            ? feature({
                NAME: 'Queensbury town',
                BASENAME: 'Queensbury',
                STATE: '36',
                PLACE: '60356',
              })
            : feature({
                NAME: 'Bronxville village',
                BASENAME: 'Bronxville',
                STATE: '36',
                PLACE: '08532',
              }),
        ],
      });
      route('tigerWMS_ACS2022/MapServer/18', "STATE='36' AND COUSUB='60356'", {
        features: [feature({ COUNTY: '113' })],
      });

      const err = await resolve(name, 'economic place').catch((e: unknown) => e);

      expect(err).toMatchObject({
        data: { reason: 'no_match', attemptedTypes: ['economic place'] },
      });
      expect(hintOf(err)).toContain(county);
    },
  );

  it('points a place-level borough miss at New York city on the place level', async () => {
    serveNewYork();

    const err = await resolve('Brooklyn, NY', 'place').catch((e: unknown) => e);

    expect(hintOf(err)).toBe(
      'It is the New York City borough coextensive with Kings County (county 047): set geography_type "county", or omit it, to resolve the borough as its county; New York City as a whole is "New York, NY" at geography_type "place".',
    );
  });

  it('points an economic-place borough miss at New York city on the economic place level', async () => {
    // ecnbasic 2022 answers only at the economic place level, keyed by its 8-digit code, so the
    // 5-digit code the place level returns for New York city matches no row there.
    const err = await resolve('Brooklyn, NY', 'economic place').catch((e: unknown) => e);

    expect(err).toMatchObject({ data: { reason: 'no_match', attemptedTypes: ['economic place'] } });
    expect(hintOf(err)).toContain('Kings County (county 047)');
    expect(hintOf(err)).toMatch(
      /New York City as a whole is "New York, NY" at geography_type "economic place"\.$/,
    );
  });

  it('sends a tract-level borough miss in its own county to the county level, keeping the scope', async () => {
    const err = await resolve('Brooklyn, NY', 'tract', '047').catch((e: unknown) => e);

    expect(err).toMatchObject({ data: { reason: 'no_match', attemptedTypes: ['tract'] } });
    expect(hintOf(err)).toContain('set geography_type "county"');
    expect(hintOf(err)).not.toContain('county_fips');
  });

  it('sends a tract-level borough miss in another county to the county level, rescoped', async () => {
    const err = await resolve('Brooklyn, NY', 'tract', '061').catch((e: unknown) => e);

    expect(hintOf(err)).toContain('set geography_type "county"');
    expect(hintOf(err)).toContain('county_fips dropped or set to 047');
  });
});

/** Layers and WHERE clauses shared by the county subdivision and Connecticut county suites. */
const INCORPORATED_LAYER = 'Places_CouSub_ConCity_SubMCD/MapServer/4';
const CDP_LAYER = 'Places_CouSub_ConCity_SubMCD/MapServer/5';
const COUNTY_LAYER = 'State_County/MapServer/1';
const SUBDIVISION_LAYER = 'Places_CouSub_ConCity_SubMCD/MapServer/1';

/** `UPPER(NAME) LIKE` clause the service sends for a term, scoped to a state FIPS. */
const likeClause = (term: string, stateFips?: string) =>
  `UPPER(NAME) LIKE '%${term}%'${stateFips ? ` AND STATE='${stateFips}'` : ''}`;

/**
 * The county subdivision level's WHERE clause: the name, its scope, and the "County subdivisions
 * not defined" placeholder rows (code 00000) left out. A trailing TOWNSHIP also asks for the
 * charter township of that name.
 */
const subdivisionClause = (term: string, stateFips?: string, countyFips?: string) => {
  const name = term.endsWith(' TOWNSHIP')
    ? `(${likeClause(term)} OR ${likeClause(term.replace(/ TOWNSHIP$/, ' CHARTER TOWNSHIP'))})`
    : likeClause(term);
  return `${name}${stateFips ? ` AND STATE='${stateFips}'` : ''}${countyFips ? ` AND COUNTY='${countyFips}'` : ''} AND COUSUB<>'00000'`;
};

/** One TIGERweb county subdivision row. FUNCSTAT `A` is an active general-purpose government. */
const subdivisionRow = (
  name: string,
  basename: string,
  state: string,
  county: string,
  code: string,
  funcstat = 'A',
) =>
  feature({
    NAME: name,
    BASENAME: basename,
    STATE: state,
    COUNTY: county,
    COUSUB: code,
    FUNCSTAT: funcstat,
  });

const placeRow = (name: string, basename: string, state: string, code: string) =>
  feature({ NAME: name, BASENAME: basename, STATE: state, PLACE: code });

const countyRow = (basename: string, state: string, code: string) =>
  feature({ NAME: `${basename} County`, BASENAME: basename, STATE: state, COUNTY: code });

/** The TIGERweb layer each request went to, in order. */
const requestedLayers = () =>
  requestedUrls.map((url) => url.match(/services\/(?:TIGERweb\/)?([^?]+)\/query/)?.[1] ?? url);

describe('GeographyService.resolveGeography — county subdivisions', () => {
  it('resolves "Cherry Hill, NJ" to Cherry Hill township, past a CDP that only contains the name', async () => {
    route(CDP_LAYER, likeClause('CHERRY HILL', '34'), {
      features: [placeRow('Cherry Hill Mall CDP', 'Cherry Hill Mall', '34', '12385')],
    });
    route(SUBDIVISION_LAYER, subdivisionClause('CHERRY HILL', '34'), {
      features: [subdivisionRow('Cherry Hill township', 'Cherry Hill', '34', '007', '12280')],
    });

    const result = await resolve('Cherry Hill, NJ');

    expect(result).toEqual({
      name: 'Cherry Hill township',
      geographyType: 'county subdivision',
      stateFips: '34',
      countyFips: '007',
      countySubdivisionFips: '12280',
      fipsSummary: '12280',
    });
    // Place and county first, the subdivision level last — and nothing after the answer.
    expect(requestedLayers()).toEqual([
      INCORPORATED_LAYER,
      CDP_LAYER,
      COUNTY_LAYER,
      SUBDIVISION_LAYER,
    ]);
  });

  it.each([
    ['Edison, NJ', 'EDISON', '34', 'Edison township', 'Edison', '023', '20230'],
    ['Upper Darby, PA', 'UPPER DARBY', '42', 'Upper Darby township', 'Upper Darby', '045', '79000'],
    ['Amherst, NY', 'AMHERST', '36', 'Amherst town', 'Amherst', '029', '02000'],
  ])(
    'resolves "%s", which no place or county has, to its subdivision',
    async (name, term, state, rowName, basename, county, code) => {
      route(SUBDIVISION_LAYER, subdivisionClause(term, state), {
        features: [subdivisionRow(rowName, basename, state, county, code)],
      });

      const result = await resolve(name);

      expect(result).toMatchObject({
        geographyType: 'county subdivision',
        stateFips: state,
        countyFips: county,
        countySubdivisionFips: code,
        fipsSummary: code,
      });
    },
  );

  it('resolves "Greenwich, CT" to Greenwich town over the Greenwich CDP of the same name', async () => {
    route(CDP_LAYER, likeClause('GREENWICH', '09'), {
      features: [placeRow('Greenwich CDP', 'Greenwich', '09', '33690')],
    });
    route(SUBDIVISION_LAYER, subdivisionClause('GREENWICH', '09'), {
      features: [subdivisionRow('Greenwich town', 'Greenwich', '09', '190', '33620')],
    });

    const result = await resolve('Greenwich, CT');

    expect(result).toMatchObject({
      name: 'Greenwich town',
      geographyType: 'county subdivision',
      countyFips: '190',
      fipsSummary: '33620',
    });
    expect(result).not.toHaveProperty('censusDesignatedPlace');
  });

  it('resolves "Bedford, MA" to Bedford town, not New Bedford city, which only contains the name', async () => {
    route(INCORPORATED_LAYER, likeClause('BEDFORD', '25'), {
      features: [placeRow('New Bedford city', 'New Bedford', '25', '45000')],
    });
    route(SUBDIVISION_LAYER, subdivisionClause('BEDFORD', '25'), {
      features: [
        subdivisionRow('New Bedford city', 'New Bedford', '25', '005', '45000', 'F'),
        subdivisionRow('Bedford town', 'Bedford', '25', '017', '04615'),
      ],
    });

    const result = await resolve('Bedford, MA');

    expect(result).toMatchObject({ name: 'Bedford town', countyFips: '017', fipsSummary: '04615' });
  });

  /** The three Clinton townships of Michigan, as TIGERweb names them. */
  const clintonTownships = (countyFips?: string) => ({
    features: [
      subdivisionRow('Clinton township', 'Clinton', '26', '091', '16500'),
      subdivisionRow('Clinton charter township', 'Clinton', '26', '099', '16520'),
      subdivisionRow('Clinton township', 'Clinton', '26', '135', '16540'),
    ].filter((row) => !countyFips || row.attributes.COUNTY === countyFips),
  });

  it('reaches a charter township through a trailing "Township", listing every Clinton township by county', async () => {
    route(SUBDIVISION_LAYER, subdivisionClause('CLINTON TOWNSHIP', '26'), clintonTownships());

    const err = await resolve('Clinton Township, MI').catch((e: unknown) => e);
    const { message, data } = err as {
      message: string;
      data: {
        reason: string;
        candidates: Array<{ countyFips: string; fipsSummary: string; name: string }>;
        recovery: { hint: string };
      };
    };

    expect(data.reason).toBe('ambiguous_name');
    expect(message).toBe('"Clinton Township, MI" matched 3 geographies.');
    expect(data.candidates.map((c) => [c.name, c.countyFips, c.fipsSummary])).toEqual([
      ['Clinton township', '091', '16500'],
      ['Clinton charter township', '099', '16520'],
      ['Clinton township', '135', '16540'],
    ]);
    expect(data.recovery.hint).toContain('"Clinton charter township, MI" (county 099)');
    expect(data.recovery.hint).toContain('"Clinton township, MI" (county 135)');
    expect(data.recovery.hint).toContain('county_fips set to the county');
  });

  it('narrows "Clinton Township, MI" to the charter township with its county_fips', async () => {
    route(
      SUBDIVISION_LAYER,
      subdivisionClause('CLINTON TOWNSHIP', '26', '099'),
      clintonTownships('099'),
    );

    const result = await resolve('Clinton Township, MI', undefined, '99');

    expect(result).toMatchObject({
      name: 'Clinton charter township',
      geographyType: 'county subdivision',
      countyFips: '099',
      fipsSummary: '16520',
    });
    // The place level carries no COUNTY, so a county scope drops it from the chain.
    expect(requestedLayers()).toEqual([COUNTY_LAYER, SUBDIVISION_LAYER]);
  });

  it('lists every same-named township in "Springfield, PA" with its county', async () => {
    const counties = ['045', '051', '061', '049', '085', '091', '017', '133', '015'];
    route(SUBDIVISION_LAYER, subdivisionClause('SPRINGFIELD', '42'), {
      features: counties.map((county, i) =>
        subdivisionRow('Springfield township', 'Springfield', '42', county, String(73000 + i)),
      ),
    });

    const err = await resolve('Springfield, PA').catch((e: unknown) => e);
    const { data } = err as {
      data: {
        reason: string;
        candidates: Array<{ countyFips: string }>;
        recovery: { hint: string };
      };
    };

    expect(data.reason).toBe('ambiguous_name');
    expect(data.candidates.map((c) => c.countyFips)).toEqual(counties);
    for (const county of counties) {
      expect(data.recovery.hint).toContain(`"Springfield township, PA" (county ${county})`);
    }
    expect(data.recovery.hint).not.toContain('more');
  });

  it('tells two same-named subdivisions of one county apart by their full names', async () => {
    route(SUBDIVISION_LAYER, subdivisionClause('RANGELEY', '23'), {
      features: [
        subdivisionRow('Rangeley plantation', 'Rangeley', '23', '007', '61875'),
        subdivisionRow('Rangeley town', 'Rangeley', '23', '007', '61840'),
      ],
    });

    const err = await resolve('Rangeley, ME').catch((e: unknown) => e);
    const { data } = err as { data: { reason: string; recovery: { hint: string } } };

    expect(data.reason).toBe('ambiguous_name');
    expect(data.recovery.hint).toContain('"Rangeley town, ME" (county 007)');
    expect(data.recovery.hint).toContain(
      'and with its full name as listed where two share a county',
    );
  });

  it.each([
    [undefined, [COUNTY_LAYER, SUBDIVISION_LAYER]],
    ['county subdivision', [SUBDIVISION_LAYER]],
  ] as const)(
    'resolves "Edison, NJ" inside county_fips 023 (geography_type %s)',
    async (type, layers) => {
      route(SUBDIVISION_LAYER, subdivisionClause('EDISON', '34', '023'), {
        features: [subdivisionRow('Edison township', 'Edison', '34', '023', '20230')],
      });

      const result = await resolve('Edison, NJ', type, '023');

      expect(result).toMatchObject({ geographyType: 'county subdivision', fipsSummary: '20230' });
      expect(requestedLayers()).toEqual(layers);
    },
  );

  it('resolves a county subdivision outside the twelve states when the level is set', async () => {
    route(SUBDIVISION_LAYER, subdivisionClause('SEATTLE', '53'), {
      features: [
        subdivisionRow('Seattle East CCD', 'Seattle East', '53', '033', '92931', 'S'),
        subdivisionRow('Seattle CCD', 'Seattle', '53', '033', '92928', 'S'),
      ],
    });

    const result = await resolve('Seattle, WA', 'county subdivision');

    expect(result).toEqual({
      name: 'Seattle CCD',
      geographyType: 'county subdivision',
      stateFips: '53',
      countyFips: '033',
      countySubdivisionFips: '92928',
      fipsSummary: '92928',
    });
  });

  it('names county subdivision among the levels county_fips applies to', async () => {
    const err = await resolve('Seattle, WA', 'place', '033').catch((e: unknown) => e);
    const { message, data } = err as { message: string; data: { recovery: { hint: string } } };

    expect(message).toBe(
      'county_fips does not apply to the place level — only county, county subdivision, and tract sit within a county.',
    );
    expect(data.recovery.hint).toBe(
      'Drop county_fips, or set geography_type to "county", "county subdivision", or "tract" to use it.',
    );
  });

  /** The twelve states whose towns and townships govern (Census geography glossary). */
  it.each(['CT', 'ME', 'MA', 'MI', 'MN', 'NH', 'NJ', 'NY', 'PA', 'RI', 'VT', 'WI'])(
    'states a twelve-state miss in %s across all three levels it tried',
    async (state) => {
      const err = await resolve(`Nowhere Special, ${state}`).catch((e: unknown) => e);
      const { message, data } = err as {
        message: string;
        data: { attemptedTypes: string[]; recovery: { hint: string } };
      };

      expect(data.attemptedTypes).toEqual(['place', 'county', 'county subdivision']);
      expect(message).toBe(
        `No place, county, or county subdivision named "Nowhere Special" exists in ${state}.`,
      );
      expect(data.recovery.hint).not.toContain('county subdivision');
    },
  );

  describe('outside the twelve states, and without a state suffix, nothing changes', () => {
    it('keeps "Winston, NC" on Winston-Salem, never querying the subdivision level', async () => {
      route(INCORPORATED_LAYER, likeClause('WINSTON', '37'), {
        features: [placeRow('Winston-Salem city', 'Winston-Salem', '37', '75000')],
      });

      const result = await resolve('Winston, NC');

      expect(result).toMatchObject({ geographyType: 'place', placeFips: '75000' });
      expect(requestedLayers()).not.toContain(SUBDIVISION_LAYER);
    });

    it('keeps "Choccolocco, AL" on its CDP rather than the Choccolocco CCD', async () => {
      route(CDP_LAYER, likeClause('CHOCCOLOCCO', '01'), {
        features: [placeRow('Choccolocco CDP', 'Choccolocco', '01', '14728')],
      });

      const result = await resolve('Choccolocco, AL');

      expect(result).toMatchObject({ geographyType: 'place', placeFips: '14728' });
      expect(requestedLayers()).not.toContain(SUBDIVISION_LAYER);
    });

    it('keeps "Hartford, CT" on Hartford city', async () => {
      route(INCORPORATED_LAYER, likeClause('HARTFORD', '09'), {
        features: [
          placeRow('Hartford city', 'Hartford', '09', '37000'),
          placeRow('West Hartford CDP', 'West Hartford', '09', '82660'),
        ],
      });

      const result = await resolve('Hartford, CT');

      expect(result).toMatchObject({ geographyType: 'place', placeFips: '37000' });
      expect(requestedLayers()).toEqual([INCORPORATED_LAYER, CDP_LAYER]);
    });

    it.each(['Cherry Hill', 'Edison', 'Greenwich'])(
      'never gives bare "%s" the subdivision level',
      async (name) => {
        await resolve(name).catch(() => undefined);

        expect(requestedLayers().length).toBeGreaterThan(0);
        expect(requestedLayers()).not.toContain(SUBDIVISION_LAYER);
      },
    );
  });

  describe('active subdivisions named exactly the input, beside a county or CDP answer', () => {
    it('keeps "Plymouth, MA" on Plymouth County and names Plymouth town', async () => {
      route(CDP_LAYER, likeClause('PLYMOUTH', '25'), {
        features: [
          placeRow('North Plymouth CDP', 'North Plymouth', '25', '48780'),
          placeRow('Plymouth CDP', 'Plymouth', '25', '54275'),
        ],
      });
      route(COUNTY_LAYER, likeClause('PLYMOUTH', '25'), {
        features: [countyRow('Plymouth', '25', '023')],
      });
      route(SUBDIVISION_LAYER, subdivisionClause('PLYMOUTH', '25'), {
        features: [subdivisionRow('Plymouth town', 'Plymouth', '25', '023', '54310')],
      });

      const result = await resolve('Plymouth, MA');

      expect(result).toEqual({
        name: 'Plymouth County',
        geographyType: 'county',
        stateFips: '25',
        countyFips: '023',
        fipsSummary: '023',
        namesakes: {
          kind: 'found',
          subdivisions: [
            { name: 'Plymouth town', countyFips: '023', countySubdivisionFips: '54310' },
          ],
        },
      });
      // One request past the county answer: the check for an active subdivision of that name.
      expect(requestedLayers()).toEqual([
        INCORPORATED_LAYER,
        CDP_LAYER,
        COUNTY_LAYER,
        SUBDIVISION_LAYER,
      ]);
    });

    it('names every active "Lake" subdivision of Michigan beside Lake County, charter township included', async () => {
      route(COUNTY_LAYER, likeClause('LAKE', '26'), {
        features: [countyRow('Lake', '26', '085'), countyRow('Clear Lake', '26', '999')],
      });
      const lakes: Array<[string, string, string]> = [
        ['Lake township', '109', '44360'],
        ['Lake charter township', '021', '44260'],
        ['Lake township', '085', '44320'],
        ['Lake township', '063', '44300'],
        ['Lake township', '143', '44400'],
        ['Lake township', '019', '44240'],
        ['Lake township', '113', '44380'],
      ];
      route(SUBDIVISION_LAYER, subdivisionClause('LAKE', '26'), {
        features: [
          subdivisionRow('Clear Lake township', 'Clear Lake', '26', '001', '16000'),
          ...lakes.map(([name, county, code]) => subdivisionRow(name, 'Lake', '26', county, code)),
        ],
      });

      const result = await resolve('Lake, MI');

      expect(result).toMatchObject({ geographyType: 'county', fipsSummary: '085' });
      expect(result.namesakes).toEqual({
        kind: 'found',
        subdivisions: lakes.map(([name, countyFips, countySubdivisionFips]) => ({
          name,
          countyFips,
          countySubdivisionFips,
        })),
      });
    });

    it('names both Union townships beside Union County, NJ', async () => {
      route(COUNTY_LAYER, likeClause('UNION', '34'), {
        features: [countyRow('Union', '34', '039')],
      });
      route(SUBDIVISION_LAYER, subdivisionClause('UNION', '34'), {
        features: [
          subdivisionRow('Union township', 'Union', '34', '019', '74420'),
          subdivisionRow('Union township', 'Union', '34', '039', '74480'),
          subdivisionRow('Union City city', 'Union City', '34', '017', '74630'),
        ],
      });

      const result = await resolve('Union, NJ');

      expect(result).toMatchObject({ geographyType: 'county', fipsSummary: '039' });
      expect(result.namesakes).toEqual({
        kind: 'found',
        subdivisions: [
          { name: 'Union township', countyFips: '019', countySubdivisionFips: '74420' },
          { name: 'Union township', countyFips: '039', countySubdivisionFips: '74480' },
        ],
      });
    });

    it.each([
      ['Queens, NY', 'QUEENS', 'Queens', '081', 'Queens borough', '60323'],
      ['Bronx, NY', 'BRONX', 'Bronx', '005', 'Bronx borough', '08510'],
    ])(
      'leaves "%s" its county with no subdivision named — the borough has no government of its own',
      async (name, term, basename, county, borough, code) => {
        route(COUNTY_LAYER, likeClause(term, '36'), {
          features: [countyRow(basename, '36', county)],
        });
        route(SUBDIVISION_LAYER, subdivisionClause(term, '36'), {
          features: [subdivisionRow(borough, basename, '36', county, code, 'G')],
        });

        const result = await resolve(name);

        expect(result).toMatchObject({ geographyType: 'county', fipsSummary: county });
        expect(result).not.toHaveProperty('namesakes');
      },
    );

    it('names nothing when the only same-named subdivision only contains the name', async () => {
      route(COUNTY_LAYER, likeClause('ESSEX', '25'), {
        features: [countyRow('Essex', '25', '009')],
      });
      route(SUBDIVISION_LAYER, subdivisionClause('ESSEX', '25'), {
        features: [subdivisionRow('Essex Junction town', 'Essex Junction', '25', '009', '21850')],
      });

      const result = await resolve('Essex, MA');

      expect(result).not.toHaveProperty('namesakes');
    });

    it.each([
      ['Cherry Hill, NJ', 'CHERRY HILL', '34', 'Cherry Hill Mall CDP', 'Cherry Hill Mall', '12385'],
      ['Greenwich, CT', 'GREENWICH', '09', 'Greenwich CDP', 'Greenwich', '33690'],
    ])(
      'answers "%s" at geography_type "place" with its CDP and names the town or township',
      async (name, term, state, cdpName, cdpBase, cdpCode) => {
        const [townName, county, code] =
          state === '34'
            ? ['Cherry Hill township', '007', '12280']
            : ['Greenwich town', '190', '33620'];
        route(CDP_LAYER, likeClause(term, state), {
          features: [placeRow(cdpName, cdpBase, state, cdpCode)],
        });
        route(SUBDIVISION_LAYER, subdivisionClause(term, state), {
          features: [subdivisionRow(townName, name.split(',')[0] ?? '', state, county, code)],
        });

        const result = await resolve(name, 'place');

        expect(result).toMatchObject({
          name: cdpName,
          geographyType: 'place',
          placeFips: cdpCode,
          censusDesignatedPlace: true,
          namesakes: {
            kind: 'found',
            subdivisions: [{ name: townName, countyFips: county, countySubdivisionFips: code }],
          },
        });
      },
    );

    it.each([
      ['an incorporated place at "place"', 'Hartford, CT', 'place' as const],
      ['a CDP outside the twelve states', 'Choccolocco, AL', 'place' as const],
      ['a county asked for by level', 'Plymouth, MA', 'county' as const],
      ['a name that says "County"', 'Plymouth County, MA', undefined],
    ])('does not check for a subdivision on %s', async (_label, name, type) => {
      route(INCORPORATED_LAYER, likeClause('HARTFORD', '09'), {
        features: [placeRow('Hartford city', 'Hartford', '09', '37000')],
      });
      route(CDP_LAYER, likeClause('CHOCCOLOCCO', '01'), {
        features: [placeRow('Choccolocco CDP', 'Choccolocco', '01', '14728')],
      });
      route(COUNTY_LAYER, likeClause('PLYMOUTH', '25'), {
        features: [countyRow('Plymouth', '25', '023')],
      });
      route(COUNTY_LAYER, likeClause('PLYMOUTH COUNTY', '25'), {
        features: [countyRow('Plymouth', '25', '023')],
      });

      const result = await resolve(name, type);

      expect(result).not.toHaveProperty('namesakes');
      expect(requestedLayers()).not.toContain(SUBDIVISION_LAYER);
    });

    it('applies county_fips to the subdivision check', async () => {
      route(COUNTY_LAYER, `${likeClause('PLYMOUTH', '25')} AND COUNTY='023'`, {
        features: [countyRow('Plymouth', '25', '023')],
      });
      route(SUBDIVISION_LAYER, subdivisionClause('PLYMOUTH', '25', '023'), {
        features: [subdivisionRow('Plymouth town', 'Plymouth', '25', '023', '54310')],
      });

      const result = await resolve('Plymouth, MA', undefined, '023');

      expect(result.namesakes).toEqual({
        kind: 'found',
        subdivisions: [
          { name: 'Plymouth town', countyFips: '023', countySubdivisionFips: '54310' },
        ],
      });
      expect(whereClauses()).toEqual([
        `${likeClause('PLYMOUTH', '25')} AND COUNTY='023'`,
        subdivisionClause('PLYMOUTH', '25', '023'),
      ]);
    });

    it('returns the county with the check marked unavailable when TIGERweb fails it', async () => {
      route(COUNTY_LAYER, likeClause('PLYMOUTH', '25'), {
        features: [countyRow('Plymouth', '25', '023')],
      });
      route(SUBDIVISION_LAYER, subdivisionClause('PLYMOUTH', '25'), {
        error: { message: 'Unable to complete operation.' },
      });

      const result = await resolve('Plymouth, MA');

      expect(result).toMatchObject({
        geographyType: 'county',
        fipsSummary: '023',
        namesakes: { kind: 'unavailable' },
      });
    });

    it('makes the check one attempt — an unreadable answer is not retried', async () => {
      route(COUNTY_LAYER, likeClause('PLYMOUTH', '25'), {
        features: [countyRow('Plymouth', '25', '023')],
      });
      const fetchStub = vi.mocked(globalThis.fetch);
      const answer = fetchStub.getMockImplementation();
      fetchStub.mockImplementation((url, init) => {
        if (!String(url).includes(SUBDIVISION_LAYER)) return answer!(url, init);
        requestedUrls.push(String(url));
        // A proxy page in place of JSON — the kind of answer a retry exists for.
        return Promise.resolve(
          new Response('<!DOCTYPE html><html><body>Service unavailable</body></html>', {
            status: 200,
          }),
        );
      });

      const result = await resolve('Plymouth, MA');

      expect(result.namesakes).toEqual({ kind: 'unavailable' });
      expect(requestedLayers().filter((layer) => layer === SUBDIVISION_LAYER)).toHaveLength(1);
    });

    it('lets a cancellation during the check fail the call rather than mark it unavailable', async () => {
      route(COUNTY_LAYER, likeClause('PLYMOUTH', '25'), {
        features: [countyRow('Plymouth', '25', '023')],
      });
      const controller = new AbortController();
      const fetchStub = vi.mocked(globalThis.fetch);
      const answer = fetchStub.getMockImplementation();
      // The caller cancels while the check's request is in flight; the request dies with it.
      fetchStub.mockImplementation((url, init) => {
        if (!String(url).includes(SUBDIVISION_LAYER)) return answer!(url, init);
        requestedUrls.push(String(url));
        controller.abort();
        return Promise.reject(new DOMException('This operation was aborted', 'AbortError'));
      });

      const error = await getGeographyService()
        .resolveGeography(
          { name: 'Plymouth, MA' },
          createMockContext({ signal: controller.signal }),
        )
        .then(
          () => undefined,
          (err: unknown) => err,
        );

      expect(error).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
      expect(error).not.toMatchObject({ data: { reason: 'resolution_unavailable' } });
    });
  });
});

describe('GeographyService.resolveGeography — Connecticut counties before 2022', () => {
  it.each([
    ['Fairfield County, CT', 'Fairfield County', '001'],
    ['Hartford County, CT', 'Hartford County', '003'],
    ['Litchfield County, CT', 'Litchfield County', '005'],
    ['Middlesex County, CT', 'Middlesex County', '007'],
    ['New Haven County, CT', 'New Haven County', '009'],
    ['New London County, CT', 'New London County', '011'],
    ['Tolland County, CT', 'Tolland County', '013'],
    ['Windham County, CT', 'Windham County', '015'],
    ['fairfield county, connecticut', 'Fairfield County', '001'],
    ['New  Haven County, Connecticut', 'New Haven County', '009'],
  ])('resolves "%s" from the fixed table, with no TIGERweb request', async (name, county, code) => {
    const result = await resolve(name);

    expect(result).toEqual({
      name: county,
      geographyType: 'county',
      stateFips: '09',
      countyFips: code,
      fipsSummary: code,
      legacyCounty: true,
    });
    expect(requestedUrls).toHaveLength(0);
  });

  it('resolves "Fairfield, CT" at geography_type "county" from the table', async () => {
    const result = await resolve('Fairfield, CT', 'county');

    expect(result).toMatchObject({ countyFips: '001', fipsSummary: '001', legacyCounty: true });
    expect(requestedUrls).toHaveLength(0);
  });

  it.each([
    ['1', '001'],
    ['001', '001'],
  ])('resolves "Fairfield County, CT" inside county_fips %s', async (countyFips, code) => {
    const result = await resolve('Fairfield County, CT', undefined, countyFips);

    expect(result).toMatchObject({ fipsSummary: code, legacyCounty: true });
  });

  it.each(['Constructor County, CT', '__proto__ County, CT'])(
    'reads "%s", a key every object carries, as no Connecticut county',
    async (name) => {
      const err = await resolve(name).catch((e: unknown) => e);

      expect(err).toMatchObject({ data: { reason: 'no_match', attemptedTypes: ['county'] } });
      expect(requestedUrls.length).toBeGreaterThan(0);
    },
  );

  it('is no_match when county_fips names a different county', async () => {
    const err = await resolve('Fairfield County, CT', undefined, '190').catch((e: unknown) => e);

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_match', countyFips: '190' },
    });
  });

  it('never answers a bare "Fairfield, CT" with the pre-2022 county', async () => {
    route(CDP_LAYER, likeClause('FAIRFIELD', '09'), {
      features: [placeRow('Fairfield University CDP', 'Fairfield University', '09', '26698')],
    });
    route(SUBDIVISION_LAYER, subdivisionClause('FAIRFIELD', '09'), {
      features: [
        subdivisionRow('New Fairfield town', 'New Fairfield', '09', '190', '50860'),
        subdivisionRow('Fairfield town', 'Fairfield', '09', '120', '26620'),
      ],
    });

    const result = await resolve('Fairfield, CT');

    expect(result).toMatchObject({
      name: 'Fairfield town',
      geographyType: 'county subdivision',
      countyFips: '120',
      fipsSummary: '26620',
    });
    expect(result).not.toHaveProperty('legacyCounty');
  });

  it.each([
    [
      'Western Connecticut Planning Region, CT',
      'WESTERN CONNECTICUT PLANNING REGION',
      'Western Connecticut Planning Region',
      '190',
    ],
    ['Capitol, CT', 'CAPITOL', 'Capitol Planning Region', '110'],
  ])(
    'keeps "%s" on its planning region, as TIGERweb has it',
    async (name, term, regionName, code) => {
      route(COUNTY_LAYER, likeClause(term, '09'), {
        features: [
          feature({
            NAME: regionName,
            BASENAME: regionName.replace(/ Planning Region$/, ''),
            STATE: '09',
            COUNTY: code,
          }),
        ],
      });

      const result = await resolve(name);

      expect(result).toMatchObject({
        name: regionName,
        geographyType: 'county',
        fipsSummary: code,
      });
      expect(result).not.toHaveProperty('legacyCounty');
      expect(result).not.toHaveProperty('namesakes');
    },
  );

  it('leaves a Fairfield County outside Connecticut to TIGERweb', async () => {
    route(COUNTY_LAYER, likeClause('FAIRFIELD COUNTY', '39'), {
      features: [countyRow('Fairfield', '39', '045')],
    });

    const result = await resolve('Fairfield County, OH');

    expect(result).toEqual({
      name: 'Fairfield County',
      geographyType: 'county',
      stateFips: '39',
      countyFips: '045',
      fipsSummary: '045',
    });
    expect(whereClauses()).toEqual([likeClause('FAIRFIELD COUNTY', '39')]);
  });
});

describe('census_resolve_geography over the real GeographyService', () => {
  const COUNTIES = 'State_County/MapServer/1';

  const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
    result.content.map((c) => c.text ?? '').join('\n');

  beforeEach(() => {
    route(COUNTIES, "UPPER(NAME) LIKE '%KINGS%' AND STATE='36'", {
      features: [feature({ NAME: 'Kings County', BASENAME: 'Kings', STATE: '36', COUNTY: '047' })],
    });
    route(COUNTIES, "UPPER(NAME) LIKE '%QUEENS%' AND STATE='36'", {
      features: [
        feature({ NAME: 'Queens County', BASENAME: 'Queens', STATE: '36', COUNTY: '081' }),
      ],
    });
    route(COUNTIES, "UPPER(NAME) LIKE '%KINGS COUNTY%' AND STATE='36'", {
      features: [feature({ NAME: 'Kings County', BASENAME: 'Kings', STATE: '36', COUNTY: '047' })],
    });
    route(
      'Places_CouSub_ConCity_SubMCD/MapServer/4',
      "UPPER(NAME) LIKE '%BROOKLYN%' AND STATE='39'",
      {
        features: [
          feature({ NAME: 'Brooklyn city', BASENAME: 'Brooklyn', STATE: '39', PLACE: '09246' }),
        ],
      },
    );
  });

  it('discloses the borough mapping as a notice on both surfaces', async () => {
    const result = await runToolContract(censusResolveGeography, { name: 'Brooklyn, NY' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      name: 'Kings County',
      geography_type: 'county',
      state_fips: '36',
      county_fips: '047',
      fips_summary: '047',
      notice: '"Brooklyn" is the New York City borough coextensive with Kings County.',
    });
    const text = textOf(result);
    expect(text).toContain('## Resolved: Kings County');
    expect(text).toContain(
      '"Brooklyn" is the New York City borough coextensive with Kings County.',
    );
  });

  it.each([
    [{ name: 'Queens, NY' }, 'Queens County'],
    [{ name: 'Kings County, NY' }, 'Kings County'],
    [{ name: 'Brooklyn, OH' }, 'Brooklyn city'],
  ])('carries no notice for %j', async (args, resolved) => {
    const result = await runToolContract(censusResolveGeography, args);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ name: resolved });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(textOf(result)).not.toContain('borough');
  });

  it('returns the place-level miss with the county named, as an error on both surfaces', async () => {
    const result = await runToolContract(censusResolveGeography, {
      name: 'Brooklyn, NY',
      geography_type: 'place',
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'no_match' } },
    });
    expect(textOf(result)).toContain('Kings County (county 047)');
  });

  it('names the economic place level for New York city on an economic-place borough miss', async () => {
    const result = await runToolContract(censusResolveGeography, {
      name: 'Brooklyn, NY',
      geography_type: 'economic place',
    });

    const hint = 'New York City as a whole is "New York, NY" at geography_type "economic place".';
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'no_match', recovery: { hint: expect.stringContaining(hint) } },
      },
    });
    expect(textOf(result)).toContain(hint);
    expect(textOf(result)).toContain('Kings County (county 047)');
  });

  it('misses "Bronx, NY" at the place level rather than answering with Bronxville', async () => {
    route('Places_CouSub_ConCity_SubMCD/MapServer/4', "UPPER(NAME) LIKE '%BRONX%' AND STATE='36'", {
      features: [
        feature({
          NAME: 'Bronxville village',
          BASENAME: 'Bronxville',
          STATE: '36',
          PLACE: '08532',
        }),
      ],
    });

    const result = await runToolContract(censusResolveGeography, {
      name: 'Bronx, NY',
      geography_type: 'place',
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'no_match' } },
    });
    expect(textOf(result)).toContain('Bronx County (county 005)');
    expect(textOf(result)).not.toContain('08532');
  });
});

describe('census_resolve_geography over the real GeographyService — subdivisions and Connecticut counties', () => {
  const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
    result.content.map((c) => c.text ?? '').join('\n');

  const servePlymouth = () => {
    route(COUNTY_LAYER, likeClause('PLYMOUTH', '25'), {
      features: [countyRow('Plymouth', '25', '023')],
    });
    route(SUBDIVISION_LAYER, subdivisionClause('PLYMOUTH', '25'), {
      features: [subdivisionRow('Plymouth town', 'Plymouth', '25', '023', '54310')],
    });
  };

  it('returns a county subdivision with its code on both surfaces', async () => {
    route(SUBDIVISION_LAYER, subdivisionClause('CHERRY HILL', '34'), {
      features: [subdivisionRow('Cherry Hill township', 'Cherry Hill', '34', '007', '12280')],
    });

    const result = await runToolContract(censusResolveGeography, { name: 'Cherry Hill, NJ' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      name: 'Cherry Hill township',
      geography_type: 'county subdivision',
      state_fips: '34',
      county_fips: '007',
      county_subdivision_fips: '12280',
      fips_summary: '12280',
    });
    const text = textOf(result);
    expect(text).toContain('**Type:** county subdivision');
    expect(text).toContain('**County subdivision FIPS:** `12280`');
    expect(text).toContain(
      '**County FIPS:** `007` — also use as `county_fips` in census_query_data for county subdivision queries',
    );
  });

  it('names the town beside a county answer, as a notice on both surfaces', async () => {
    servePlymouth();

    const result = await runToolContract(censusResolveGeography, { name: 'Plymouth, MA' });

    const notice =
      'Plymouth town (county 023, county subdivision 54310) shares this name and has its own government: resolve it with geography_type "county subdivision".';
    expect(result.structuredContent).toEqual({
      name: 'Plymouth County',
      geography_type: 'county',
      state_fips: '25',
      county_fips: '023',
      fips_summary: '023',
      notice,
    });
    expect(textOf(result)).toContain(notice);
  });

  it('says on both surfaces when the subdivision check could not run', async () => {
    route(COUNTY_LAYER, likeClause('PLYMOUTH', '25'), {
      features: [countyRow('Plymouth', '25', '023')],
    });
    route(SUBDIVISION_LAYER, subdivisionClause('PLYMOUTH', '25'), {
      error: { message: 'Unable to complete operation.' },
    });

    const result = await runToolContract(censusResolveGeography, { name: 'Plymouth, MA' });

    const notice =
      'Whether a county subdivision with its own government shares this name could not be checked, because TIGERweb did not answer; geography_type "county subdivision" resolves one directly.';
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ fips_summary: '023', notice });
    expect(textOf(result)).toContain(notice);
  });

  it('discloses a pre-2022 Connecticut county as a notice on both surfaces', async () => {
    const result = await runToolContract(censusResolveGeography, { name: 'Fairfield County, CT' });

    const notice =
      "Fairfield County (county 001) is one of Connecticut's eight counties before 2022: every dataset vintage through 2021, the 2020 Census included, publishes it, and vintages from 2022 publish the nine planning regions (counties 110–190) in its place.";
    expect(result.structuredContent).toEqual({
      name: 'Fairfield County',
      geography_type: 'county',
      state_fips: '09',
      county_fips: '001',
      fips_summary: '001',
      notice,
    });
    expect(textOf(result)).toContain(notice);
  });

  it('hands over the county subdivision an address sits in, on both surfaces', async () => {
    queue({
      result: {
        addressMatches: [
          {
            matchedAddress: '820 MERCER ST, CHERRY HILL, NJ, 08002',
            geographies: {
              'Census Tracts': [{ STATE: '34', COUNTY: '007', TRACT: '603301' }],
              'County Subdivisions': [
                { COUSUB: '12280', STATE: '34', COUNTY: '007', NAME: 'Cherry Hill township' },
              ],
            },
          },
        ],
      },
    });

    const result = await runToolContract(censusResolveGeography, {
      name: '820 Mercer St, Cherry Hill, NJ 08002',
    });

    expect(result.structuredContent).toEqual({
      name: '820 MERCER ST, CHERRY HILL, NJ, 08002',
      geography_type: 'tract',
      state_fips: '34',
      county_fips: '007',
      tract_fips: '603301',
      county_subdivision_fips: '12280',
      fips_summary: '603301',
      notice:
        'Tract 603301 is a 2020 census tract: ACS 5-year vintages from 2020 and the 2020 Census files publish it and its block groups, while earlier vintages publish earlier tracts — 2010 tracts, or 2000 tracts on acs/acs5 2009 and dec/pl 2000 — where this code can be missing.',
    });
    expect(textOf(result)).toContain(
      '**County subdivision FIPS:** `12280` — use as `geography_fips` at `geography_level` "county subdivision" in census_query_data, with the state and county',
    );
  });
});

describe('GeographyService — an upstream that fails every attempt is resolution_unavailable', () => {
  const TIGERWEB_HOST = 'tigerweb.geo.census.gov';
  const GEOCODER_HOST = 'geocoding.geo.census.gov';

  /** A request the upstream accepts and never answers; it settles only when its signal aborts. */
  const hang = (init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      if (init?.signal?.aborted) reject(init.signal.reason);
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });

  type Failure =
    | '403'
    | '404'
    | '429'
    | '500'
    | '503'
    | '504'
    | 'network error'
    | 'timeout'
    | 'an HTML page'
    | 'a body that is not JSON';
  const fail = (failure: Failure, init?: RequestInit): Promise<Response> => {
    switch (failure) {
      case '403':
      case '404':
      case '429':
      case '500':
      case '503':
      case '504':
        return Promise.resolve(
          new Response('<html><body>Upstream failure</body></html>', {
            status: Number(failure),
            headers: { 'content-type': 'text/html' },
          }),
        );
      case 'network error':
        return Promise.reject(new TypeError('fetch failed'));
      case 'timeout':
        return hang(init);
      // A proxy or gateway page in place of the JSON asked for, with a 200.
      case 'an HTML page':
        return Promise.resolve(
          new Response('<!DOCTYPE html><html><body>Service unavailable</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
        );
      case 'a body that is not JSON':
        return Promise.resolve(
          new Response('Service temporarily unavailable', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          }),
        );
    }
  };

  /** Fail every request to `host`; answer the rest from the suite's routes. */
  const failHost = (host: string, failure: Failure) => {
    const fetchStub = vi.mocked(globalThis.fetch);
    const answer = fetchStub.getMockImplementation();
    fetchStub.mockImplementation((url, init) => {
      if (new URL(String(url)).hostname !== host) return answer!(url, init);
      requestedUrls.push(String(url));
      return fail(failure, init);
    });
  };

  /** How many times each distinct URL at `host` was requested — a place name asks two layers. */
  const attemptsAt = (host: string) => {
    const counts = new Map<string, number>();
    for (const url of requestedUrls.filter((u) => new URL(u).hostname === host)) {
      counts.set(url, (counts.get(url) ?? 0) + 1);
    }
    return [...new Set(counts.values())];
  };

  /** Run with retry backoffs and per-attempt timeouts on fake timers, past every one of them. */
  const settle = async <T>(pending: Promise<T>) => {
    const outcome = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(300_000);
    return outcome;
  };

  beforeEach(() => {
    // Date moves with the timers: a resolution's upstream budget is measured against it.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const cases = [
    ['TIGERweb', TIGERWEB_HOST, 'Seattle, WA'],
    ['the Census Geocoder', GEOCODER_HOST, '400 Broad St, Seattle, WA 98109'],
  ] as const;
  const failures: Failure[] = ['500', '503', 'network error', 'timeout'];

  it.each(
    cases.flatMap(([source, host, name]) =>
      failures.map((failure) => [source, failure, host, name] as const),
    ),
  )(
    '%s failing with a %s on every attempt carries the declared reason and its recovery',
    async (_source, failure, host, name) => {
      failHost(host, failure);

      const outcome = await settle(resolve(name));

      expect(outcome).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: {
            reason: 'resolution_unavailable',
            retryable: true,
            recovery: { hint: expect.stringMatching(/^Retry the request/) },
          },
        },
      });
      /**
       * Every request gets one attempt and three retries, except a hung Census Geocoder: its fourth
       * 15-second attempt cannot start inside the call's 50-second budget.
       */
      expect(attemptsAt(host)).toEqual([host === GEOCODER_HOST && failure === 'timeout' ? 3 : 4]);
    },
  );

  it('names the upstream status as a field, never the upstream body', async () => {
    failHost(TIGERWEB_HOST, '503');

    const outcome = await settle(resolve('Seattle, WA'));

    const error = (outcome as { error: { message: string; data: Record<string, unknown> } }).error;
    expect(error.data).toMatchObject({ status: 503, retryAttempts: 4 });
    expect(error.message).toBe('TIGERweb answered HTTP 503 on all 4 attempts.');
    expect(JSON.stringify(error.data)).not.toContain('Upstream failure');
  });

  it.each([
    ['network error', 'TIGERweb could not be reached on all 4 attempts.'],
    ['timeout', 'TIGERweb did not answer within 10 s on all 4 attempts.'],
  ] as const)('says what a TIGERweb %s on every attempt was', async (failure, message) => {
    failHost(TIGERWEB_HOST, failure);

    const outcome = await settle(resolve('Seattle, WA'));

    expect(outcome).toMatchObject({ error: { message, data: { retryAttempts: 4 } } });
  });

  /** A 4xx refuses the request as sent, which a retry only repeats. */
  it.each([
    ['TIGERweb', '404', TIGERWEB_HOST, 'Seattle, WA', 'TIGERweb answered HTTP 404.'],
    [
      'the Census Geocoder',
      '403',
      GEOCODER_HOST,
      '400 Broad St, Seattle, WA 98109',
      'The Census Geocoder answered HTTP 403.',
    ],
  ] as const)(
    '%s refusing a request with a %s is neither retried nor retryable',
    async (_source, failure, host, name, message) => {
      failHost(host, failure);

      const outcome = await settle(resolve(name));

      expect(outcome).toMatchObject({
        error: {
          message,
          data: {
            reason: 'resolution_unavailable',
            status: Number(failure),
            retryable: false,
            recovery: {
              hint: 'The request was refused rather than failing transiently, so retrying it unchanged gets the same status. Resolve the geography by another name or level, or pass FIPS codes already in hand straight to the data tools.',
            },
          },
        },
      });
      expect(attemptsAt(host)).toEqual([1]);
    },
  );

  it('keeps a TIGERweb 429 transient: retried, and retryable once its attempts run out', async () => {
    failHost(TIGERWEB_HOST, '429');

    const outcome = await settle(resolve('Seattle, WA'));

    expect(outcome).toMatchObject({
      error: {
        message: 'TIGERweb answered HTTP 429 on all 4 attempts.',
        data: {
          reason: 'resolution_unavailable',
          status: 429,
          retryable: true,
          recovery: {
            hint: 'Retry the request; if it keeps failing, TIGERweb is temporarily unavailable.',
          },
        },
      },
    });
    expect(attemptsAt(TIGERWEB_HOST)).toEqual([4]);
  });

  it.each([
    [
      'TIGERweb',
      'an HTML page',
      TIGERWEB_HOST,
      'Seattle, WA',
      'TIGERweb returned HTML instead of JSON.',
    ],
    [
      'TIGERweb',
      'a body that is not JSON',
      TIGERWEB_HOST,
      'Seattle, WA',
      'TIGERweb response could not be parsed.',
    ],
    [
      'the Census Geocoder',
      'an HTML page',
      GEOCODER_HOST,
      '400 Broad St, Seattle, WA 98109',
      'The Census Geocoder returned HTML instead of JSON.',
    ],
    [
      'the Census Geocoder',
      'a body that is not JSON',
      GEOCODER_HOST,
      '400 Broad St, Seattle, WA 98109',
      'The Census Geocoder response could not be parsed.',
    ],
  ] as const)(
    '%s answering %s on every attempt is resolution_unavailable',
    async (_source, failure, host, name, said) => {
      failHost(host, failure);

      const outcome = await settle(resolve(name));

      expect(outcome).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          message: expect.stringContaining(said),
          data: { reason: 'resolution_unavailable' },
        },
      });
      expect(attemptsAt(host)).toEqual([4]);
    },
  );

  it('reaches both client surfaces with its recovery through census_resolve_geography', async () => {
    failHost(GEOCODER_HOST, 'network error');

    const outcome = await settle(
      runToolContract(censusResolveGeography, { name: '400 Broad St, Seattle, WA 98109' }),
    );
    const result = (
      outcome as {
        value: {
          isError?: boolean;
          structuredContent?: unknown;
          content: Array<{ type: string; text?: string }>;
        };
      }
    ).value;

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as {
      error: { message: string; data: { reason: string; recovery: { hint: string } } };
    };
    expect(error.data.reason).toBe('resolution_unavailable');
    const text = result.content.map((c) => c.text ?? '').join('\n');
    expect(text).toContain(error.message);
    expect(text).toContain(`Recovery: ${error.data.recovery.hint}`);
  });

  it('keeps a caller cancellation a cancellation, not an unavailable upstream', async () => {
    const controller = new AbortController();
    const fetchStub = vi.mocked(globalThis.fetch);
    fetchStub.mockImplementation((url, init) => {
      requestedUrls.push(String(url));
      controller.abort();
      return hang(init);
    });

    const outcome = await settle(
      getGeographyService().resolveGeography(
        { name: 'Seattle, WA' },
        createMockContext({ signal: controller.signal }),
      ),
    );

    expect(outcome).toHaveProperty('error');
    const error = (outcome as { error: { code: number; data?: Record<string, unknown> } }).error;
    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(error.data?.reason).toBeUndefined();
    expect(attemptsAt(TIGERWEB_HOST)).toEqual([1]);
  });

  // A gateway timeout (504) answers a status, where a hang answers none.
  it.each(['503', '504', 'timeout'] as const)(
    'leaves the one-attempt subdivision check reporting a %s as unavailable',
    async (failure) => {
      route(COUNTY_LAYER, likeClause('PLYMOUTH', '25'), {
        features: [countyRow('Plymouth', '25', '023')],
      });
      const fetchStub = vi.mocked(globalThis.fetch);
      const answer = fetchStub.getMockImplementation();
      fetchStub.mockImplementation((url, init) => {
        if (!String(url).includes(SUBDIVISION_LAYER)) return answer!(url, init);
        requestedUrls.push(String(url));
        return fail(failure, init);
      });

      const outcome = await settle(resolve('Plymouth, MA'));

      expect(outcome).toMatchObject({
        value: { geographyType: 'county', fipsSummary: '023', namesakes: { kind: 'unavailable' } },
      });
      expect(requestedLayers().filter((layer) => layer === SUBDIVISION_LAYER)).toHaveLength(1);
    },
  );

  // The check is advisory: the county is already the answer, so even a refusal only leaves the
  // notice unchecked rather than failing a resolution that needs no subdivision request.
  it.each(['403', '404', '429'] as const)(
    'keeps the answer when TIGERweb refuses the subdivision check with a %s',
    async (failure) => {
      route(COUNTY_LAYER, likeClause('PLYMOUTH', '25'), {
        features: [countyRow('Plymouth', '25', '023')],
      });
      const fetchStub = vi.mocked(globalThis.fetch);
      const answer = fetchStub.getMockImplementation();
      fetchStub.mockImplementation((url, init) => {
        if (!String(url).includes(SUBDIVISION_LAYER)) return answer!(url, init);
        requestedUrls.push(String(url));
        return fail(failure, init);
      });

      const outcome = await settle(resolve('Plymouth, MA'));

      expect(outcome).toMatchObject({
        value: { geographyType: 'county', fipsSummary: '023', namesakes: { kind: 'unavailable' } },
      });
      expect(requestedLayers().filter((layer) => layer === SUBDIVISION_LAYER)).toHaveLength(1);
    },
  );

  it('answers an address the Census Geocoder rejects as too long with its stated reason, unretried', async () => {
    const fetchStub = vi.mocked(globalThis.fetch);
    fetchStub.mockImplementation((url) => {
      requestedUrls.push(String(url));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            errors: ['Address cannot be empty and cannot exceed 100 characters'],
            status: '400',
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
      );
    });
    const address = `1 ${'Long '.repeat(25)}St, Seattle, WA 98109`;

    const outcome = await settle(resolve(address));

    expect(outcome).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'address_rejected',
          status: 400,
          upstreamMessage: 'Address cannot be empty and cannot exceed 100 characters',
          recovery: { hint: expect.stringContaining('shorter') },
        },
      },
    });
    expect(attemptsAt(GEOCODER_HOST)).toEqual([1]);
  });

  // resolution_unavailable is declared under ServiceUnavailable: a TIGERweb 404 is an unavailable
  // service, never the NotFound that no_match carries.
  it.each([
    ['403', TIGERWEB_HOST, 'Seattle, WA'],
    ['404', TIGERWEB_HOST, 'Seattle, WA'],
    ['429', TIGERWEB_HOST, 'Seattle, WA'],
    ['404', GEOCODER_HOST, '400 Broad St, Seattle, WA 98109'],
  ] as const)(
    'carries the declared ServiceUnavailable code for a %s from %s',
    async (failure, host, name) => {
      failHost(host, failure);

      const outcome = await settle(resolve(name));

      expect(outcome).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { reason: 'resolution_unavailable', status: Number(failure) },
        },
      });
    },
  );

  describe('one 50-second budget across every request a resolution chains', () => {
    const BUDGET_MS = 50_000;

    beforeEach(() => {
      // Backoffs without jitter — 1 s, 2 s, 4 s — so a scripted chain lands where it is placed.
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
    });

    afterEach(() => {
      vi.mocked(Math.random).mockRestore();
    });

    /**
     * Advance fake time by `ms` and report how `pending` settled within it — `undefined` while it
     * is still running.
     */
    const within = async <T>(ms: number, pending: Promise<T>) => {
      let outcome: { value: T } | { error: unknown } | undefined;
      pending.then(
        (value) => {
          outcome = { value };
        },
        (error: unknown) => {
          outcome = { error };
        },
      );
      await vi.advanceTimersByTimeAsync(ms);
      return outcome;
    };

    /** An answer whose body never ends: its stream errors only when the request's signal aborts. */
    const stalledBody = (init?: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
                once: true,
              });
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    /**
     * Stall the first `hung(url)` attempts of each request — before its headers, or partway
     * through its body — so each settles only when its signal aborts, and answer every later
     * attempt from the suite's routes.
     */
    const hangFirstAttempts = (
      hung: (url: string) => number,
      stage: 'headers' | 'body' = 'headers',
    ) => {
      const fetchStub = vi.mocked(globalThis.fetch);
      const answer = fetchStub.getMockImplementation();
      const attempts = new Map<string, number>();
      fetchStub.mockImplementation((url, init) => {
        const attempt = (attempts.get(String(url)) ?? 0) + 1;
        attempts.set(String(url), attempt);
        if (attempt > hung(String(url))) return answer!(url, init);
        requestedUrls.push(String(url));
        return stage === 'headers' ? hang(init) : stalledBody(init);
      });
    };

    it.each(['headers', 'body'] as const)(
      'ends a TIGERweb answering only on its last retry, mid-chain, as resolution_unavailable — attempts stalled in their %s',
      async (stage) => {
        /**
         * Place → county → county subdivision: each level answers after three stalled attempts,
         * about 37 s, so the place level answers and the county level is still retrying when the
         * budget runs out.
         */
        hangFirstAttempts(() => 3, stage);

        const outcome = await within(BUDGET_MS, resolve('Nowhere, MA'));

        expect(outcome).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ServiceUnavailable,
            message: "TIGERweb did not finish answering within the call's 50 s upstream budget.",
            data: {
              reason: 'resolution_unavailable',
              retryable: true,
              deadlineMs: BUDGET_MS,
              callDeadlineExceeded: true,
              recovery: {
                hint: 'Retry the request; if it keeps failing, TIGERweb is temporarily unavailable.',
              },
            },
          },
        });
        expect(new Set(requestedLayers())).toEqual(
          new Set([INCORPORATED_LAYER, CDP_LAYER, COUNTY_LAYER]),
        );
        // Nothing the call started outlives it: no attempt still in flight, no backoff still armed.
        expect(vi.getTimerCount()).toBe(0);
      },
    );

    it('ends a hung Census Geocoder as resolution_unavailable inside the budget, on both client surfaces', async () => {
      failHost(GEOCODER_HOST, 'timeout');

      const outcome = await within(
        BUDGET_MS,
        runToolContract(censusResolveGeography, { name: '400 Broad St, Seattle, WA 98109' }),
      );

      expect(outcome).toMatchObject({ value: { isError: true } });
      const result = (
        outcome as {
          value: { structuredContent?: unknown; content: Array<{ type: string; text?: string }> };
        }
      ).value;
      const { error } = result.structuredContent as {
        error: { message: string; data: { recovery: { hint: string } } };
      };
      expect(error).toMatchObject({
        message:
          "The Census Geocoder did not finish answering within the call's 50 s upstream budget.",
        data: {
          reason: 'resolution_unavailable',
          retryable: true,
          callDeadlineExceeded: true,
          recovery: {
            hint: 'Retry the request; if it keeps failing, the Census Geocoder is temporarily unavailable.',
          },
        },
      });
      const text = result.content.map((c) => c.text ?? '').join('\n');
      expect(text).toContain(error.message);
      expect(text).toContain(`Recovery: ${error.data.recovery.hint}`);
      // Three 15-second attempts and their backoffs fit; a fourth could not finish inside it.
      expect(attemptsAt(GEOCODER_HOST)).toEqual([3]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('answers with the county and the check unavailable when the namesake check meets the end of the budget', async () => {
      route(COUNTY_LAYER, likeClause('PLYMOUTH', '25'), {
        features: [countyRow('Plymouth', '25', '023')],
      });
      /**
       * The place level answers after three hung attempts (37 s) and the county level after one
       * (48 s), leaving the check 2 s of a request that never answers.
       */
      hangFirstAttempts((url) =>
        url.includes(SUBDIVISION_LAYER)
          ? Number.POSITIVE_INFINITY
          : url.includes(COUNTY_LAYER)
            ? 1
            : 3,
      );

      const outcome = await within(BUDGET_MS, resolve('Plymouth, MA'));

      expect(outcome).toMatchObject({
        value: { geographyType: 'county', fipsSummary: '023', namesakes: { kind: 'unavailable' } },
      });
      expect(requestedLayers().filter((layer) => layer === SUBDIVISION_LAYER)).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('sends no namesake request once the budget is spent, and still answers with the county', async () => {
      route(COUNTY_LAYER, likeClause('PLYMOUTH', '25'), {
        features: [countyRow('Plymouth', '25', '023')],
      });
      const fetchStub = vi.mocked(globalThis.fetch);
      const answer = fetchStub.getMockImplementation();
      fetchStub.mockImplementation((url, init) => {
        // The county answer arrives just as the budget runs out.
        if (String(url).includes(COUNTY_LAYER)) vi.setSystemTime(Date.now() + BUDGET_MS);
        return answer!(url, init);
      });

      const outcome = await within(0, resolve('Plymouth, MA'));

      expect(outcome).toMatchObject({
        value: { geographyType: 'county', fipsSummary: '023', namesakes: { kind: 'unavailable' } },
      });
      expect(requestedLayers()).not.toContain(SUBDIVISION_LAYER);
    });

    it('keeps a cancellation that lands as the budget runs out a cancellation', async () => {
      const controller = new AbortController();
      const fetchStub = vi.mocked(globalThis.fetch);
      const answer = fetchStub.getMockImplementation();
      fetchStub.mockImplementation((url, init) => {
        // A request sent on a cancelled signal fails, as fetch fails it.
        if (init?.signal?.aborted) return Promise.reject(init.signal.reason);
        // The county level answers just as the budget runs out, and the caller cancels with it.
        if (String(url).includes(COUNTY_LAYER)) {
          vi.setSystemTime(Date.now() + BUDGET_MS);
          controller.abort();
        }
        return answer!(url, init);
      });

      const outcome = await within(
        0,
        getGeographyService().resolveGeography(
          { name: 'Nowhere, MA' },
          createMockContext({ signal: controller.signal }),
        ),
      );

      expect(outcome).toMatchObject({ error: { code: JsonRpcErrorCode.RequestCancelled } });
      expect(
        (outcome as { error: { data?: Record<string, unknown> } }).error.data?.reason,
      ).toBeUndefined();
    });

    it('keeps a cancellation mid-chain a cancellation, with no later level asked and no budget waited out', async () => {
      const controller = new AbortController();
      const fetchStub = vi.mocked(globalThis.fetch);
      const answer = fetchStub.getMockImplementation();
      fetchStub.mockImplementation((url, init) => {
        if (!String(url).includes(COUNTY_LAYER)) return answer!(url, init);
        requestedUrls.push(String(url));
        controller.abort();
        return hang(init);
      });

      const outcome = await within(
        0,
        getGeographyService().resolveGeography(
          { name: 'Nowhere, MA' },
          createMockContext({ signal: controller.signal }),
        ),
      );

      expect(outcome).toMatchObject({ error: { code: JsonRpcErrorCode.RequestCancelled } });
      expect(
        (outcome as { error: { data?: Record<string, unknown> } }).error.data?.reason,
      ).toBeUndefined();
      expect(requestedLayers()).toEqual([INCORPORATED_LAYER, CDP_LAYER, COUNTY_LAYER]);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
