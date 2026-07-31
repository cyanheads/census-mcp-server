/**
 * @fileoverview Geography resolution service. Converts place names and addresses to
 * Census FIPS codes using TIGERweb MapServer REST API and Census Geocoder.
 * @module services/geography/geography-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { notFound, serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, type RequestContext, withRetry } from '@cyanheads/mcp-ts-core/utils';
import type {
  GeocoderResult,
  GeographyType,
  ResolvedGeography,
  TigerwebFeature,
  TigerwebResponse,
} from './types.js';
import { GEOGRAPHY_TYPES } from './types.js';

const TIGERWEB_BASE = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb';
const GEOCODER_BASE = 'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress';

/**
 * One TIGERweb layer group — the fields a level exposes and the WHERE clauses it accepts.
 *
 * Field availability differs per layer and a clause naming an absent field is answered with
 * HTTP 200 carrying an ArcGIS error body, not an empty result, so scoping is declared here
 * rather than assumed: `STUSAB` exists only on the state layer, and the CBSA and CSA layers
 * carry no `STATE` at all. `BASENAME` is the unqualified name ("Seattle" for `NAME` "Seattle
 * city") and is present on every layer.
 */
interface TigerwebLayerSpec {
  /** Attribute holding this level's own code, and the width that code zero-pads to. */
  codeField: string;
  codeLength: number;
  /** Layer carries `COUNTY`, so a county FIPS can scope the query. */
  countyScoped: boolean;
  /** Layer IDs making up this level — queried together, since a level can span two of them. */
  layers: number[];
  outFields: string;
  /** MapServer service under the TIGERweb root. */
  service: string;
  /**
   * Layer has no `STATE` field but spells the states it spans into `NAME` ("Aberdeen, WA Micro
   * Area"), so a state suffix scopes the rows after the fetch instead of the WHERE clause.
   */
  stateInName: boolean;
  /** Layer carries `STATE`, so a state suffix on the name can scope the query. */
  stateScoped: boolean;
}

/** TIGERweb layer config per geography type. */
const TIGERWEB_LAYERS = {
  state: {
    service: 'State_County',
    layers: [0],
    outFields: 'NAME,BASENAME,STATE,STUSAB',
    codeField: 'STATE',
    codeLength: 2,
    stateScoped: true,
    countyScoped: false,
    stateInName: false,
  },
  county: {
    service: 'State_County',
    layers: [1],
    outFields: 'NAME,BASENAME,STATE,COUNTY',
    codeField: 'COUNTY',
    codeLength: 3,
    stateScoped: true,
    countyScoped: true,
    stateInName: false,
  },
  // Incorporated places are in layer 4 of Places_CouSub_ConCity_SubMCD (layer 0 = county subdivisions).
  place: {
    service: 'Places_CouSub_ConCity_SubMCD',
    layers: [4],
    outFields: 'NAME,BASENAME,STATE,PLACE',
    codeField: 'PLACE',
    codeLength: 5,
    stateScoped: true,
    countyScoped: false,
    stateInName: false,
  },
  tract: {
    service: 'Tracts_Blocks',
    layers: [0],
    outFields: 'NAME,BASENAME,STATE,COUNTY,TRACT',
    codeField: 'TRACT',
    codeLength: 6,
    stateScoped: true,
    countyScoped: true,
    stateInName: false,
  },
  // Metropolitan (layer 3) and micropolitan (layer 4) areas are one Census level split across
  // two layers, so both are queried — a name can match either and neither layer knows the other.
  'metropolitan statistical area/micropolitan statistical area': {
    service: 'CBSA',
    layers: [3, 4],
    outFields: 'NAME,BASENAME,GEOID,CBSA',
    codeField: 'GEOID',
    codeLength: 5,
    stateScoped: false,
    countyScoped: false,
    stateInName: true,
  },
  'combined statistical area': {
    service: 'CBSA',
    layers: [0],
    outFields: 'NAME,BASENAME,GEOID,CSA',
    codeField: 'GEOID',
    codeLength: 3,
    stateScoped: false,
    countyScoped: false,
    stateInName: true,
  },
  'consolidated city': {
    service: 'Places_CouSub_ConCity_SubMCD',
    layers: [3],
    outFields: 'NAME,BASENAME,STATE,CONCITY',
    codeField: 'CONCITY',
    codeLength: 5,
    stateScoped: true,
    countyScoped: false,
    stateInName: false,
  },
} satisfies Record<GeographyType, TigerwebLayerSpec>;

/** States, DC, and territories — the single source for the FIPS/abbreviation/name lookups below. */
const US_STATES: ReadonlyArray<{ abbr: string; fips: string; name: string }> = [
  { abbr: 'AL', fips: '01', name: 'Alabama' },
  { abbr: 'AK', fips: '02', name: 'Alaska' },
  { abbr: 'AZ', fips: '04', name: 'Arizona' },
  { abbr: 'AR', fips: '05', name: 'Arkansas' },
  { abbr: 'CA', fips: '06', name: 'California' },
  { abbr: 'CO', fips: '08', name: 'Colorado' },
  { abbr: 'CT', fips: '09', name: 'Connecticut' },
  { abbr: 'DE', fips: '10', name: 'Delaware' },
  { abbr: 'DC', fips: '11', name: 'District of Columbia' },
  { abbr: 'FL', fips: '12', name: 'Florida' },
  { abbr: 'GA', fips: '13', name: 'Georgia' },
  { abbr: 'HI', fips: '15', name: 'Hawaii' },
  { abbr: 'ID', fips: '16', name: 'Idaho' },
  { abbr: 'IL', fips: '17', name: 'Illinois' },
  { abbr: 'IN', fips: '18', name: 'Indiana' },
  { abbr: 'IA', fips: '19', name: 'Iowa' },
  { abbr: 'KS', fips: '20', name: 'Kansas' },
  { abbr: 'KY', fips: '21', name: 'Kentucky' },
  { abbr: 'LA', fips: '22', name: 'Louisiana' },
  { abbr: 'ME', fips: '23', name: 'Maine' },
  { abbr: 'MD', fips: '24', name: 'Maryland' },
  { abbr: 'MA', fips: '25', name: 'Massachusetts' },
  { abbr: 'MI', fips: '26', name: 'Michigan' },
  { abbr: 'MN', fips: '27', name: 'Minnesota' },
  { abbr: 'MS', fips: '28', name: 'Mississippi' },
  { abbr: 'MO', fips: '29', name: 'Missouri' },
  { abbr: 'MT', fips: '30', name: 'Montana' },
  { abbr: 'NE', fips: '31', name: 'Nebraska' },
  { abbr: 'NV', fips: '32', name: 'Nevada' },
  { abbr: 'NH', fips: '33', name: 'New Hampshire' },
  { abbr: 'NJ', fips: '34', name: 'New Jersey' },
  { abbr: 'NM', fips: '35', name: 'New Mexico' },
  { abbr: 'NY', fips: '36', name: 'New York' },
  { abbr: 'NC', fips: '37', name: 'North Carolina' },
  { abbr: 'ND', fips: '38', name: 'North Dakota' },
  { abbr: 'OH', fips: '39', name: 'Ohio' },
  { abbr: 'OK', fips: '40', name: 'Oklahoma' },
  { abbr: 'OR', fips: '41', name: 'Oregon' },
  { abbr: 'PA', fips: '42', name: 'Pennsylvania' },
  { abbr: 'RI', fips: '44', name: 'Rhode Island' },
  { abbr: 'SC', fips: '45', name: 'South Carolina' },
  { abbr: 'SD', fips: '46', name: 'South Dakota' },
  { abbr: 'TN', fips: '47', name: 'Tennessee' },
  { abbr: 'TX', fips: '48', name: 'Texas' },
  { abbr: 'UT', fips: '49', name: 'Utah' },
  { abbr: 'VT', fips: '50', name: 'Vermont' },
  { abbr: 'VA', fips: '51', name: 'Virginia' },
  { abbr: 'WA', fips: '53', name: 'Washington' },
  { abbr: 'WV', fips: '54', name: 'West Virginia' },
  { abbr: 'WI', fips: '55', name: 'Wisconsin' },
  { abbr: 'WY', fips: '56', name: 'Wyoming' },
  { abbr: 'AS', fips: '60', name: 'American Samoa' },
  { abbr: 'GU', fips: '66', name: 'Guam' },
  { abbr: 'MP', fips: '69', name: 'Commonwealth of the Northern Mariana Islands' },
  { abbr: 'PR', fips: '72', name: 'Puerto Rico' },
  { abbr: 'VI', fips: '78', name: 'United States Virgin Islands' },
];

/** Everyday spellings of the territories, whose TIGERweb `NAME` is the long legal form. */
const STATE_NAME_ALIASES: Record<string, string> = {
  'northern mariana islands': 'MP',
  'us virgin islands': 'VI',
  'u.s. virgin islands': 'VI',
  'virgin islands': 'VI',
};

/** Two-letter postal abbreviation → 2-digit state FIPS, for WHERE clauses on non-state layers. */
const STATE_ABBR_TO_FIPS: Record<string, string> = Object.fromEntries(
  US_STATES.map((s) => [s.abbr, s.fips]),
);

/** 2-digit state FIPS → postal abbreviation, for naming the state on layers without `STUSAB`. */
const STATE_FIPS_TO_ABBR: Record<string, string> = Object.fromEntries(
  US_STATES.map((s) => [s.fips, s.abbr]),
);

/** Lowercased full state name → postal abbreviation, for detecting spelled-out state inputs. */
const STATE_NAME_TO_ABBR: Record<string, string> = {
  ...Object.fromEntries(US_STATES.map((s) => [s.name.toLowerCase(), s.abbr])),
  ...STATE_NAME_ALIASES,
};

/** Candidates listed in an `ambiguous_name` error. */
const MAX_CANDIDATES = 10;

/**
 * The states a CBSA or CSA name spans — `MO-KS` out of "Kansas City, MO-KS Metro Area".
 *
 * Every name on those layers carries exactly one comma, followed by the hyphenated state list
 * and the area suffix, so the list is the segment between them.
 */
const NAME_STATE_LIST = /,\s*([A-Z]{2}(?:-[A-Z]{2})*)\b/;

export class GeographyService {
  /**
   * Resolve a place name or address to Census FIPS identifiers.
   *
   * Without an explicit `geographyType` the name is matched against an ordered chain of
   * layers (see {@link GeographyService.detectGeographyTypes}); a layer with no rows falls
   * through to the next, and only an exhausted chain is a `no_match`.
   *
   * A `countyFips` restricts that chain to the levels whose layers carry `COUNTY`, so the
   * scope is either applied or reported — never carried past a layer that cannot express it.
   */
  async resolveGeography(
    params: { name: string; geographyType?: GeographyType; countyFips?: string },
    ctx: Context,
  ): Promise<ResolvedGeography> {
    const { name, geographyType } = params;
    // TIGERweb stores COUNTY zero-padded, so an unpadded '51' would match nothing at all.
    const countyFips = params.countyFips?.padStart(3, '0');
    ctx.log.info('Resolving geography', { name, geographyType, countyFips });

    const isAddress = this.looksLikeAddress(name);
    const detected = isAddress
      ? []
      : geographyType
        ? [geographyType]
        : this.detectGeographyTypes(name);

    // A level with no COUNTY field answers exactly as it would have with no county named, so
    // the scope narrows the chain rather than riding along unapplied: a caller who scoped a
    // lookup must never get back a match that ignored the scope. A chain the filter empties
    // is the answer, not a licence to fall through to an unscoped layer.
    const types = countyFips
      ? detected.filter((type) => TIGERWEB_LAYERS[type].countyScoped)
      : detected;

    if (countyFips && types.length === 0) {
      throw this.countyScopeUnsupported(geographyType, isAddress, detected);
    }

    if (isAddress) return this.resolveAddress(name, ctx);

    for (const type of types) {
      const resolved = await this.resolveNamedPlace(name, type, countyFips, ctx);
      if (resolved) return resolved;
    }

    throw this.noMatch(name, types, countyFips);
  }

  /**
   * Build the `county_scope_unsupported` error for a `county_fips` no level reached by this
   * call can apply — only `county` and `tract` sit inside a county, and a street address
   * resolves to a single point rather than a set a county could narrow.
   */
  private countyScopeUnsupported(
    geographyType: GeographyType | undefined,
    isAddress: boolean,
    detected: GeographyType[],
  ) {
    const subject = isAddress
      ? 'a street address, which already resolves to one county on its own'
      : geographyType
        ? `the ${geographyType} level`
        : `the ${detected.join(' or ')} level${detected.length > 1 ? 's' : ''} this name auto-detects to`;

    return validationError(
      `county_fips does not apply to ${subject} — only county and tract sit within a county.`,
      {
        reason: 'county_scope_unsupported',
        ...(geographyType && { geographyType }),
        ...(detected.length > 0 && { attemptedTypes: detected }),
        recovery: {
          hint: 'Drop county_fips, or set geography_type to "county" or "tract" to use it.',
        },
      },
    );
  }

  /** Query one geography level. Resolves to `null` when its layers have no row for the name. */
  private resolveNamedPlace(
    name: string,
    geographyType: GeographyType,
    countyFips: string | undefined,
    ctx: Context,
  ): Promise<ResolvedGeography | null> {
    const trimmed = name.trim();
    const spec = TIGERWEB_LAYERS[geographyType];

    // The state layer's NAME is the full state name, so a bare abbreviation has to
    // match on STUSAB — 'WA' is not a substring of 'Washington'.
    if (geographyType === 'state' && /^[A-Z]{2}$/.test(trimmed)) {
      return this.fetchAndMapFeatures({
        ctx,
        geographyType,
        name,
        queryTerm: trimmed,
        whereClause: `STUSAB='${trimmed}'`,
      });
    }

    const { placeName, stateAbbr } = this.splitStateSuffix(trimmed);

    let whereClause = `NAME LIKE '%${placeName.replace(/'/g, "''")}%'`;

    // A statistical area spans whatever states it spans, so its layer carries no STATE to
    // filter on — scoping it would be an ArcGIS error, not a narrower answer.
    if (stateAbbr && spec.stateScoped) {
      if (geographyType === 'state') {
        whereClause += ` AND STUSAB='${stateAbbr}'`;
      } else {
        const stateFips = STATE_ABBR_TO_FIPS[stateAbbr];
        if (stateFips) whereClause += ` AND STATE='${stateFips}'`;
      }
    }

    if (countyFips && spec.countyScoped) {
      whereClause += ` AND COUNTY='${countyFips}'`;
    }

    return this.fetchAndMapFeatures({
      ctx,
      geographyType,
      name,
      queryTerm: placeName,
      whereClause,
      // The statistical-area layers have no STATE to filter on, so the state the caller named
      // is matched against the row names instead — dropping it would answer "Aberdeen, WA"
      // with the South Dakota micro area alongside the Washington one.
      ...(stateAbbr && spec.stateInName && { nameStateAbbr: stateAbbr }),
    });
  }

  /** Fetch TIGERweb features across a level's layers and map them to a ResolvedGeography. */
  private async fetchAndMapFeatures(opts: {
    ctx: Context;
    geographyType: GeographyType;
    name: string;
    /** State abbreviation to match against row names, on layers that carry no `STATE`. */
    nameStateAbbr?: string;
    queryTerm: string;
    whereClause: string;
  }): Promise<ResolvedGeography | null> {
    const { ctx, geographyType, name, nameStateAbbr, queryTerm, whereClause } = opts;
    const spec = TIGERWEB_LAYERS[geographyType];

    const perLayer = await Promise.all(
      spec.layers.map((layer) => this.queryLayer(spec, layer, whereClause, ctx)),
    );
    const fetched = perLayer.flat();
    const features = nameStateAbbr ? this.filterByStateInName(fetched, nameStateAbbr) : fetched;

    if (features.length === 0) return null;

    const matches = this.preferExactMatches(features, queryTerm);

    // Any surviving row is a distinct geography, so picking the first of several is a
    // coin flip between real places — "Boston" alone matches towns in IN, GA, and MA.
    // Report every candidate instead and let the caller choose.
    if (matches.length > 1) {
      throw this.ambiguousName(name, geographyType, matches);
    }

    // biome-ignore lint/style/noNonNullAssertion: matches is derived from a non-empty features array
    const attrs = matches[0]!.attributes;

    const stateFips = this.levelCode(attrs, 'STATE', 2);
    const countyFips = this.levelCode(attrs, 'COUNTY', 3);
    const placeFips = this.levelCode(attrs, 'PLACE', 5);
    const tractFips = this.levelCode(attrs, 'TRACT', 6);
    const fipsSummary = this.levelCode(attrs, spec.codeField, spec.codeLength);

    if (!fipsSummary) {
      throw serviceUnavailable(
        `TIGERweb returned a ${geographyType} row without its ${spec.codeField} code.`,
        { reason: 'resolution_unavailable' },
      );
    }

    const result: ResolvedGeography = {
      name: String(attrs.NAME ?? name),
      geographyType,
      fipsSummary,
    };

    if (stateFips) result.stateFips = stateFips;
    if (countyFips) result.countyFips = countyFips;
    if (tractFips) result.tractFips = tractFips;
    if (placeFips) result.placeFips = placeFips;

    return result;
  }

  /** Query one TIGERweb layer, returning its rows. */
  private async queryLayer(
    spec: TigerwebLayerSpec,
    layer: number,
    whereClause: string,
    ctx: Context,
  ): Promise<TigerwebFeature[]> {
    const url = `${TIGERWEB_BASE}/${spec.service}/MapServer/${layer}/query?where=${encodeURIComponent(whereClause)}&outFields=${spec.outFields}&returnGeometry=false&f=json`;

    ctx.log.debug('TIGERweb query', { url, whereClause });

    const data = await withRetry(
      async () => {
        const response = await fetchWithTimeout(url, 10_000, ctx as unknown as RequestContext, {
          signal: ctx.signal,
        });
        const text = await response.text();

        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable('TIGERweb returned HTML instead of JSON.', {
            reason: 'resolution_unavailable',
          });
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw serviceUnavailable('TIGERweb response could not be parsed.', {
            reason: 'resolution_unavailable',
          });
        }

        return parsed as TigerwebResponse;
      },
      {
        operation: 'GeographyService.resolveNamedPlace',
        context: ctx as unknown as RequestContext,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );

    if (data.error) {
      throw serviceUnavailable(`TIGERweb error: ${data.error.message}`, {
        reason: 'resolution_unavailable',
      });
    }

    return data.features ?? [];
  }

  /**
   * Read one code off a TIGERweb row, zero-padded to its documented width.
   *
   * TIGERweb drops leading zeros on some numeric fields — an unpadded `5` for Arkansas would
   * miss every FIPS lookup keyed on `05`.
   */
  private levelCode(
    attrs: TigerwebFeature['attributes'],
    field: string,
    length: number,
  ): string | undefined {
    const raw = attrs[field];
    if (raw === undefined || raw === null || raw === '') return;
    return String(raw).padStart(length, '0');
  }

  /**
   * Narrow to rows whose name spans the state the caller named.
   *
   * A statistical area covers whatever states it covers, so its layer carries no `STATE` to
   * put in a WHERE clause — but its name ends in the hyphenated list of those states, which
   * means the named one can sit second or third rather than first: "Kansas City, MO" and
   * "Kansas City, KS" are both the MO-KS metro area. A row whose name yields no state list
   * fails the check, since an unverifiable row does not satisfy a scope that was asked for.
   */
  private filterByStateInName(features: TigerwebFeature[], stateAbbr: string): TigerwebFeature[] {
    return features.filter((f) => {
      const states = NAME_STATE_LIST.exec(String(f.attributes.NAME ?? ''))?.[1];
      return states?.split('-').includes(stateAbbr) ?? false;
    });
  }

  /**
   * Narrow to rows whose name is exactly the queried term, when any are.
   *
   * A `NAME LIKE '%term%'` query also matches longer names — "Kansas City" returns
   * "North Kansas City city" alongside "Kansas City city" — so without this the first
   * row TIGERweb happens to return can be a different place than the one asked for.
   */
  private preferExactMatches(features: TigerwebFeature[], queryTerm: string): TigerwebFeature[] {
    const term = queryTerm.trim().toLowerCase();
    if (!term) return features;

    const exact = features.filter(
      (f) =>
        String(f.attributes.BASENAME ?? '').toLowerCase() === term ||
        String(f.attributes.NAME ?? '').toLowerCase() === term,
    );

    return exact.length > 0 ? exact : features;
  }

  /**
   * Build the `ambiguous_name` error, giving each candidate enough to act on without a
   * re-query: its own code, plus the state that separates same-named places.
   */
  private ambiguousName(name: string, geographyType: GeographyType, matches: TigerwebFeature[]) {
    const spec = TIGERWEB_LAYERS[geographyType];

    const candidates = matches.slice(0, MAX_CANDIDATES).map((f) => {
      const stateFips = this.levelCode(f.attributes, 'STATE', 2);
      const countyFips = this.levelCode(f.attributes, 'COUNTY', 3);
      const tractFips = this.levelCode(f.attributes, 'TRACT', 6);
      return {
        name: String(f.attributes.NAME ?? ''),
        geographyType,
        // Every candidate carries the value resolving it would have returned, so the caller
        // can take one straight to census_query_data instead of narrowing the name.
        fipsSummary: this.levelCode(f.attributes, spec.codeField, spec.codeLength) ?? '',
        ...(stateFips && { stateFips, stateAbbr: STATE_FIPS_TO_ABBR[stateFips] ?? '' }),
        ...(countyFips && { countyFips }),
        // Tract candidates share a name, so the FIPS pair is the only way to act on one.
        ...(tractFips && { tractFips }),
      };
    });

    const candidateList = candidates
      .map((c) => {
        const state = c.stateAbbr ? `, ${c.stateAbbr}` : '';
        // Tract names repeat within a state, so the county is what separates them.
        const county = geographyType === 'tract' && c.countyFips ? ` (county ${c.countyFips})` : '';
        return `"${c.name}${state}"${county}`;
      })
      .join(', ');
    const remaining = matches.length - candidates.length;
    const more = remaining > 0 ? `, and ${remaining} more` : '';

    // A tract candidate is not re-queryable by name — every one of them carries the same
    // name and state, so the county FIPS is the only input that separates them.
    const next =
      geographyType === 'tract'
        ? ' — tract names repeat within a state, so re-call census_resolve_geography with county_fips set to the county of the one you want'
        : '';

    return validationError(`"${name}" matched ${matches.length} geographies.`, {
      reason: 'ambiguous_name',
      candidates,
      recovery: { hint: `Re-query with one of: ${candidateList}${more}${next}` },
    });
  }

  /** Build the `no_match` error for a name no layer in the chain matched. */
  private noMatch(name: string, types: GeographyType[], countyFips?: string) {
    const { placeName, stateAbbr } = this.splitStateSuffix(name.trim());
    const attempted = types.join(' or ');
    const levels = GEOGRAPHY_TYPES.join(', ');
    // county_fips narrows the chain to the levels that sit in a county, so it is part of why
    // nothing matched — a caller told only to check the spelling would re-run the same miss.
    const scope = countyFips ? ` in county ${countyFips}` : '';
    const dropScope = countyFips ? ' drop county_fips,' : '';
    const hint = stateAbbr
      ? `No ${attempted} named "${placeName}" exists in ${stateAbbr}${scope} — check the spelling,${dropScope} set geography_type to search a different level (${levels}), or pass a full street address.`
      : `Add the state abbreviation (e.g., "${placeName}, WA"),${dropScope} set geography_type to search a specific level (${levels}), or pass a full street address.`;

    return notFound(`No ${attempted} matched "${name}"${scope}.`, {
      reason: 'no_match',
      name,
      attemptedTypes: types,
      ...(countyFips && { countyFips }),
      recovery: { hint },
    });
  }

  /** Split a trailing two-letter state abbreviation ("Seattle, WA") off a place name. */
  private splitStateSuffix(name: string): { placeName: string; stateAbbr?: string } {
    const stateAbbr = name.match(/,?\s+([A-Z]{2})\s*$/)?.[1];
    if (!stateAbbr) return { placeName: name };
    return { placeName: name.replace(/,?\s+[A-Z]{2}\s*$/, '').trim(), stateAbbr };
  }

  private async resolveAddress(address: string, ctx: Context): Promise<ResolvedGeography> {
    const url = `${GEOCODER_BASE}?address=${encodeURIComponent(address)}&benchmark=4&vintage=4&layers=8,12,28&format=json`;

    ctx.log.debug('Census Geocoder query', { address });

    const data = await withRetry(
      async () => {
        const response = await fetchWithTimeout(url, 15_000, ctx as unknown as RequestContext, {
          signal: ctx.signal,
        });
        const text = await response.text();

        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable('Census Geocoder returned HTML instead of JSON.', {
            reason: 'resolution_unavailable',
          });
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw serviceUnavailable('Census Geocoder response could not be parsed.', {
            reason: 'resolution_unavailable',
          });
        }

        return parsed as GeocoderResult;
      },
      {
        operation: 'GeographyService.resolveAddress',
        context: ctx as unknown as RequestContext,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );

    const matches = data.result?.addressMatches ?? [];

    if (matches.length === 0) {
      throw notFound(
        `Address "${address}" could not be geocoded. Verify the address format and include a ZIP code.`,
        {
          reason: 'no_match',
          address,
          recovery: {
            hint: `Include a full address with ZIP code (e.g., "1600 Pennsylvania Ave NW, Washington, DC 20500").`,
          },
        },
      );
    }

    // biome-ignore lint/style/noNonNullAssertion: guarded by matches.length === 0 check above
    const match = matches[0]!;
    const geos = match.geographies ?? {};

    // The geocoder returns STATE/COUNTY/TRACT as fields inside whichever layer has them.
    // Priority: Census Tracts > 2020 Census Blocks > Incorporated Places > States.
    // Each layer that has a STATE field also has COUNTY and TRACT when applicable.
    const tractGeo = (geos['Census Tracts'] ?? [])[0] ?? (geos['2020 Census Blocks'] ?? [])[0];
    const placeGeo = (geos['Incorporated Places'] ?? [])[0];
    const stateGeo = (geos.States ?? [])[0];

    // STATE field is available in Census Tracts, Blocks, and Incorporated Places.
    const rawState = tractGeo?.STATE ?? placeGeo?.STATE ?? stateGeo?.STATE;
    const stateFips = rawState ? String(rawState).padStart(2, '0') : '';
    const countyFips = tractGeo?.COUNTY ? String(tractGeo.COUNTY).padStart(3, '0') : undefined;
    const tractFips = tractGeo?.TRACT ? String(tractGeo.TRACT) : undefined;

    if (!stateFips) {
      throw notFound('Geocoder matched address but returned no geographic identifiers.', {
        reason: 'no_match',
        address,
        recovery: { hint: 'Verify the address is in a valid US location.' },
      });
    }

    const geographyType = tractFips ? 'tract' : countyFips ? 'county' : 'state';
    const fipsSummary = tractFips ?? countyFips ?? stateFips;

    const result: ResolvedGeography = {
      name: match.matchedAddress,
      geographyType,
      stateFips,
      fipsSummary,
    };

    if (countyFips) result.countyFips = countyFips;
    if (tractFips) result.tractFips = tractFips;

    return result;
  }

  /**
   * Ordered layer chain for a name with no explicit `geography_type`.
   *
   * Anything that is neither a state name nor a county/tract keyword is tried as a place
   * first and a county second, so "Seattle, WA" reaches the place layer while a name that
   * exists only as a county-equivalent still resolves. A spelled-out state name must match
   * the whole input — a substring test would read "West Virginia University" as a state.
   *
   * "New York" resolves to the state: the Census place name for New York City is also
   * exactly "New York", and there is no qualifier a caller would naturally add to tell them
   * apart, so the city requires an explicit `geography_type: "place"`.
   */
  private detectGeographyTypes(name: string): GeographyType[] {
    const trimmed = name.trim();
    const lower = trimmed.toLowerCase();

    if (/^[A-Z]{2}$/.test(trimmed)) return ['state'];
    if (STATE_NAME_TO_ABBR[lower]) return ['state'];
    if (lower.includes('county') || lower.includes('borough') || lower.includes('parish')) {
      return ['county'];
    }
    if (lower.includes('tract')) return ['tract'];
    return ['place', 'county'];
  }

  private looksLikeAddress(name: string): boolean {
    return /^\d+\s+\w/.test(name.trim());
  }
}

// --- Init/accessor pattern ---

let _service: GeographyService | undefined;

export function initGeographyService(): void {
  _service = new GeographyService();
}

export function getGeographyService(): GeographyService {
  if (!_service) {
    throw new Error('GeographyService not initialized — call initGeographyService() in setup()');
  }
  return _service;
}
