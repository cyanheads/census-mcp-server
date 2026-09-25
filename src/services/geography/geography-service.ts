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

/** Root of the TIGERweb ArcGIS services — the `TIGERweb` folder and the `Econ` folder beside it. */
const TIGERWEB_SERVICES = 'https://tigerweb.geo.census.gov/arcgis/rest/services';
const GEOCODER_BASE = 'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress';

/**
 * The January 2022 boundaries (the ACS 2022 vintage) an economic place's county prefix is read
 * from. Both sides of the county test come from this one vintage: the 2022 Economic Census
 * delineates its places on 2022 boundaries, and a place and a county drawn from the same vintage
 * share their common edges exactly, so an interior test finds no sliver along a county line.
 */
const BOUNDARIES_2022 = {
  service: 'TIGERweb/tigerWMS_ACS2022',
  incorporatedPlaces: 24,
  censusDesignatedPlaces: 26,
  countySubdivisions: 18,
  counties: 78,
} as const;

const ECONOMIC_PLACE = 'economic place' satisfies GeographyType;

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
  /** Layer holding this level's census-designated places, when it has one. */
  cdpLayer?: number;
  /** Attribute holding this level's own code, and the width that code zero-pads to. */
  codeField: string;
  codeLength: number;
  /** Layer carries `COUNTY`, so a county FIPS can scope the query. */
  countyScoped: boolean;
  /** Layer IDs making up this level — queried together, since a level can span two of them. */
  layers: number[];
  outFields: string;
  /** MapServer service, relative to the TIGERweb services root (`TIGERweb/…` or `Econ/…`). */
  service: string;
  /**
   * Layer has no `STATE` field but spells the states it spans into `NAME` ("Aberdeen, WA Micro
   * Area"), so a state suffix scopes the rows after the fetch instead of the WHERE clause.
   */
  stateInName: boolean;
  /** Layer carries `STATE`, so a state suffix on the name can scope the query. */
  stateScoped: boolean;
  /**
   * Layer's names include Saint abbreviations ("St. Louis city") and accented letters ("Doña
   * Ana County"), so a lookup that finds no row is retried in those spellings. The state,
   * tract, and consolidated-city vocabularies carry neither, so a retry there is a wasted call.
   */
  variantRetries: boolean;
}

/** TIGERweb layer config per geography type. */
const TIGERWEB_LAYERS = {
  state: {
    service: 'TIGERweb/State_County',
    layers: [0],
    outFields: 'NAME,BASENAME,STATE,STUSAB',
    codeField: 'STATE',
    codeLength: 2,
    stateScoped: true,
    countyScoped: false,
    stateInName: false,
    variantRetries: false,
  },
  county: {
    service: 'TIGERweb/State_County',
    layers: [1],
    outFields: 'NAME,BASENAME,STATE,COUNTY',
    codeField: 'COUNTY',
    codeLength: 3,
    stateScoped: true,
    countyScoped: true,
    stateInName: false,
    variantRetries: true,
  },
  // The Census `place` level is incorporated places (layer 4 of Places_CouSub_ConCity_SubMCD)
  // and census-designated places (layer 5) together — layer 0 is Estates, layer 1 County
  // Subdivisions.
  place: {
    service: 'TIGERweb/Places_CouSub_ConCity_SubMCD',
    layers: [4, 5],
    cdpLayer: 5,
    outFields: 'NAME,BASENAME,STATE,PLACE',
    codeField: 'PLACE',
    codeLength: 5,
    stateScoped: true,
    countyScoped: false,
    stateInName: false,
    variantRetries: true,
  },
  tract: {
    service: 'TIGERweb/Tracts_Blocks',
    layers: [0],
    outFields: 'NAME,BASENAME,STATE,COUNTY,TRACT',
    codeField: 'TRACT',
    codeLength: 6,
    stateScoped: true,
    countyScoped: true,
    stateInName: false,
    variantRetries: false,
  },
  // Metropolitan (layer 3) and micropolitan (layer 4) areas are one Census level split across
  // two layers, so both are queried — a name can match either and neither layer knows the other.
  'metropolitan statistical area/micropolitan statistical area': {
    service: 'TIGERweb/CBSA',
    layers: [3, 4],
    outFields: 'NAME,BASENAME,GEOID,CBSA',
    codeField: 'GEOID',
    codeLength: 5,
    stateScoped: false,
    countyScoped: false,
    stateInName: true,
    variantRetries: true,
  },
  'combined statistical area': {
    service: 'TIGERweb/CBSA',
    layers: [0],
    outFields: 'NAME,BASENAME,GEOID,CSA',
    codeField: 'GEOID',
    codeLength: 3,
    stateScoped: false,
    countyScoped: false,
    stateInName: true,
    variantRetries: true,
  },
  'consolidated city': {
    service: 'TIGERweb/Places_CouSub_ConCity_SubMCD',
    layers: [3],
    outFields: 'NAME,BASENAME,STATE,CONCITY',
    codeField: 'CONCITY',
    codeLength: 5,
    stateScoped: true,
    countyScoped: false,
    stateInName: false,
    variantRetries: false,
  },
  // 2020 Census ZCTAs. A ZCTA is named by its code, so it is matched on GEOID rather than
  // NAME, and the layer carries no STATE — a ZCTA can straddle a state line.
  'zip code tabulation area': {
    service: 'TIGERweb/PUMA_TAD_TAZ_UGA_ZCTA',
    layers: [1],
    outFields: 'NAME,BASENAME,GEOID,ZCTA5',
    codeField: 'GEOID',
    codeLength: 5,
    stateScoped: false,
    countyScoped: false,
    stateInName: false,
    variantRetries: false,
  },
  // The 2022 Economic Census places — incorporated places and minor civil divisions (layer 2),
  // CDPs (layer 3), and each county's balance (layer 4) — which list every economic place
  // whether or not it has published data. Its code is 8 digits, the county and then PLACE; the
  // layers carry no COUNTY, so economicPlaceCounty finds the prefix.
  'economic place': {
    service: 'Econ/EconPlaces',
    layers: [2, 3, 4],
    cdpLayer: 3,
    outFields: 'NAME,BASENAME,STATE,PLACE',
    codeField: 'PLACE',
    codeLength: 5,
    stateScoped: true,
    countyScoped: false,
    stateInName: false,
    variantRetries: true,
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

/** A state suffix spelled as two-letter abbreviations, one or a hyphenated list, either case. */
const STATE_LIST_SUFFIX = /^[A-Za-z]{2}(?:-[A-Za-z]{2})*$/;

/** A name with its trailing state split off. */
interface SplitName {
  placeName: string;
  /** First state the suffix names — the one a query is scoped by. */
  stateAbbr?: string;
  /** The suffix as the caller's hint should echo it — "GA", or a list such as "NE-IA". */
  stateLabel?: string;
}

const ZCTA = 'zip code tabulation area' satisfies GeographyType;

/** A 5-digit ZIP, or a ZIP+4 whose first five digits name the ZCTA. */
const ZIP_CODE = /^(\d{5})(?:-\d{4})?$/;

/**
 * Base letters of every accented character in the TIGERweb county, place, CBSA, and CSA names
 * (ñ, í, ó, ü, á, …), measured on 2026-09-25. Each is wildcarded in the accent retry, since a
 * `LIKE` has no accent-insensitive comparison.
 */
const ACCENTED_BASE_LETTERS = new Set(['A', 'I', 'N', 'O', 'U']);

/** One spelling of the searched name — the `LIKE` body sent and how its rows are read back. */
interface SearchTerm {
  /** Term the exact-name preference compares rows against. */
  exactTerm: string;
  /** Uppercased `LIKE` body, without the surrounding `%`; `_` may stand in for an accented letter. */
  pattern: string;
  /** Pattern wildcards letters, so keep only rows whose accent-folded name contains the term. */
  wildcarded?: boolean;
}

/** A TIGERweb row, tagged with the layer it came from. */
type LayerFeature = TigerwebFeature & { layer: number };

/**
 * The rows one level query narrowed to, before {@link GeographyService.settle} resolves them —
 * one row is the geography, several are `ambiguous_name`.
 */
interface LevelMatch {
  /**
   * Every row is a census-designated place named exactly the term. A CDP is a statistical area
   * rather than a government, so it answers only when no later level has an exact row: "Arlington,
   * VA" is Arlington County, whose whole area the Arlington CDP repeats.
   */
  cdpOnly: boolean;
  /** Every row is named exactly the term, rather than a longer name that contains it. */
  exact: boolean;
  features: LayerFeature[];
  geographyType: GeographyType;
  /** The name as the caller gave it. */
  name: string;
}

/** What every level query of one lookup shares. */
interface NameLookup {
  countyFips: string | undefined;
  ctx: Context;
  /** The name as the caller gave it — for `ambiguous_name` and a row with no `NAME`. */
  name: string;
  split: SplitName;
}

/** The state list a CBSA or CSA `BASENAME` ends in — ", OR" off "Bend, OR". */
const BASENAME_STATE_LIST = /,\s*[A-Z]{2}(?:-[A-Z]{2})*$/;

/** Strip diacritics — "Doña Ana" becomes "Dona Ana". */
const stripMarks = (value: string) => value.normalize('NFD').replace(/\p{M}+/gu, '');

/** Lowercase and strip diacritics — "Doña Ana" and "dona ana" fold to the same string. */
const fold = (value: string) => stripMarks(value).toLowerCase().trim();

/**
 * The name respelled with each Saint token in TIGERweb's abbreviated form ("Saint Louis" →
 * "St. Louis", "Ste Genevieve" → "Ste. Genevieve"), then in the spelled-out form ("St. Jo" →
 * "Saint Jo") — only the spellings that differ from the name as given.
 */
const saintSpellings = (name: string): string[] => {
  const abbreviated = name
    .replace(/\b(?:Sainte|Ste\.?)(?=\s)/gi, 'Ste.')
    .replace(/\b(?:Saint|St\.?)(?=\s)/gi, 'St.');
  const spelledOut = name
    .replace(/\b(?:Sainte|Ste\.?)(?=\s)/gi, 'Sainte')
    .replace(/\b(?:Saint|St\.?)(?=\s)/gi, 'Saint');
  const seen = new Set([name.toUpperCase()]);
  return [abbreviated, spelledOut].filter((spelling) => {
    const key = spelling.toUpperCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** The uppercased name with every letter that carries an accent somewhere wildcarded to `_`. */
const wildcardAccents = (name: string) =>
  [...stripMarks(name).toUpperCase()]
    .map((char) => (ACCENTED_BASE_LETTERS.has(char) ? '_' : char))
    .join('');

export class GeographyService {
  /**
   * Resolve a place name or address to Census FIPS identifiers.
   *
   * Without an explicit `geographyType` the name is matched against an ordered chain of
   * layers (see {@link GeographyService.detectGeographyTypes}); a layer with no rows falls
   * through to the next, and so does one whose rows only contain the name — "King, WA" finds
   * "Kingston CDP" on the place level, which yields to "King County" named exactly that, and
   * is answered only when no later level has an exact row. A place level whose exact rows are
   * all CDPs yields the same way to an exact county, while still outranking a row that only
   * contains the name (see {@link GeographyService.preferredLevel}). The name's state suffix is
   * split once, before any query. Every level's name is tried as given first, so a real name on a
   * later level beats a respelling on an earlier one; only when no level has a row are the
   * respellings tried ({@link GeographyService.retryTerms}), and only an exhausted chain is a
   * `no_match`.
   *
   * A `countyFips` restricts that chain to the levels whose layers carry `COUNTY`, so the
   * scope is either applied or reported — never carried past a layer that cannot express it.
   */
  async resolveGeography(
    params: { name: string; geographyType?: GeographyType; countyFips?: string },
    ctx: Context,
  ): Promise<ResolvedGeography> {
    const { name, geographyType } = params;
    const trimmed = name.trim();
    // TIGERweb stores COUNTY zero-padded, so an unpadded '51' would match nothing at all.
    const countyFips = params.countyFips?.padStart(3, '0');
    ctx.log.info('Resolving geography', { name, geographyType, countyFips });

    const isAddress = this.looksLikeAddress(trimmed);
    const detected = isAddress
      ? []
      : geographyType
        ? [geographyType]
        : this.detectGeographyTypes(trimmed);

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

    const split = this.splitStateSuffix(trimmed);
    const lookup = { name, split, countyFips, ctx };

    const primary = await this.preferredLevel(
      types.map((type) => () => this.resolvePrimary(trimmed, type, lookup)),
    );
    if (primary) return this.settle(primary, ctx);

    // A level's respellings are tried in order and its first hit stands for the level.
    const respelled = await this.preferredLevel(
      types.map((type) => async () => {
        for (const term of this.retryTerms(split.placeName, type)) {
          const match = await this.resolveTerm(type, term, lookup);
          if (match) return match;
        }
        return null;
      }),
    );
    if (respelled) return this.settle(respelled, ctx);

    throw this.noMatch(name, split, types, countyFips);
  }

  /**
   * Walk the chain's levels in order and pick the match that answers the name: the first level
   * with an exact row that is not only CDPs, else the first exact CDP match, else the first level
   * whose rows only contain the name. Levels after the answer are never queried.
   */
  private async preferredLevel(
    levels: Array<() => Promise<LevelMatch | null>>,
  ): Promise<LevelMatch | undefined> {
    let fallback: LevelMatch | undefined;
    for (const level of levels) {
      const match = await level();
      if (!match) continue;
      if (match.exact && !match.cdpOnly) return match;
      if (!fallback || (match.exact && !fallback.exact)) fallback = match;
    }
    return fallback;
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

  /**
   * Query one geography level for the name as given. Resolves to `null` when its layers have
   * no row for it.
   */
  private resolvePrimary(
    trimmed: string,
    geographyType: GeographyType,
    lookup: NameLookup,
  ): Promise<LevelMatch | null> {
    // A ZCTA is named by its code, which the layer holds in GEOID — a ZIP+4 names the ZCTA of
    // its first five digits, and anything else names no ZCTA at all.
    if (geographyType === ZCTA) {
      const zip = ZIP_CODE.exec(trimmed)?.[1];
      if (!zip) return Promise.resolve(null);
      return this.findMatches({
        ...lookup,
        geographyType,
        term: { pattern: zip, exactTerm: zip },
        whereClause: `GEOID='${zip}'`,
      });
    }

    // The state layer's NAME is the full state name, so a bare abbreviation has to
    // match on STUSAB — 'WA' is not a substring of 'Washington'.
    if (geographyType === 'state' && /^[A-Z]{2}$/.test(trimmed)) {
      return this.findMatches({
        ...lookup,
        geographyType,
        term: { pattern: trimmed, exactTerm: trimmed },
        whereClause: `STUSAB='${trimmed}'`,
      });
    }

    const { placeName } = lookup.split;
    return this.resolveTerm(
      geographyType,
      { pattern: placeName.toUpperCase(), exactTerm: placeName },
      lookup,
    );
  }

  /**
   * The respellings tried on a level once no level had a row for the name as given: the Saint
   * token in TIGERweb's forms, then the name with its accent-bearing letters wildcarded, then —
   * on the statistical-area levels — the name's leading city alone. Levels whose vocabulary
   * carries none of these get no retry.
   *
   * OMB renames a CBSA or CSA by its trailing cities ("Denver-Aurora-Lakewood" became
   * "Denver-Aurora-Centennial"), and every CBSA renamed between the 2020 and 2023 delineations
   * kept its leading city, so the text before the first hyphen still finds the area. A merged
   * CSA is found the same way, through the area that now contains the city.
   */
  private retryTerms(placeName: string, geographyType: GeographyType): SearchTerm[] {
    const spec = TIGERWEB_LAYERS[geographyType];
    if (!spec.variantRetries) return [];

    const terms: SearchTerm[] = saintSpellings(placeName).map((spelling) => ({
      pattern: spelling.toUpperCase(),
      exactTerm: spelling,
    }));

    const wildcarded = wildcardAccents(placeName);
    if (wildcarded.includes('_')) {
      terms.push({ pattern: wildcarded, exactTerm: placeName, wildcarded: true });
    }

    const leadingCity = placeName.split('-')[0]?.trim();
    if (spec.stateInName && leadingCity && leadingCity !== placeName) {
      terms.push({ pattern: leadingCity.toUpperCase(), exactTerm: leadingCity });
    }

    return terms;
  }

  /**
   * Query one geography level for one spelling of the name. Matching is case-insensitive —
   * TIGERweb's `LIKE` is not, so both sides are uppercased — and scoped by the state suffix
   * and county the caller gave, wherever the layer can express them.
   */
  private resolveTerm(
    geographyType: GeographyType,
    term: SearchTerm,
    lookup: NameLookup,
  ): Promise<LevelMatch | null> {
    const spec = TIGERWEB_LAYERS[geographyType];
    const { stateAbbr } = lookup.split;

    let whereClause = `UPPER(NAME) LIKE '%${term.pattern.replace(/'/g, "''")}%'`;

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

    if (lookup.countyFips && spec.countyScoped) {
      whereClause += ` AND COUNTY='${lookup.countyFips}'`;
    }

    return this.findMatches({
      ...lookup,
      geographyType,
      term,
      whereClause,
      // The statistical-area layers have no STATE to filter on, so the state the caller named
      // is matched against the row names instead — dropping it would answer "Aberdeen, WA"
      // with the South Dakota micro area alongside the Washington one.
      ...(stateAbbr && spec.stateInName && { nameStateAbbr: stateAbbr }),
    });
  }

  /**
   * Fetch TIGERweb features across a level's layers and narrow them to the rows that name the
   * term exactly, when any do. Resolves to `null` when the level has no row for the term.
   */
  private async findMatches(opts: {
    ctx: Context;
    geographyType: GeographyType;
    name: string;
    /** State abbreviation to match against row names, on layers that carry no `STATE`. */
    nameStateAbbr?: string;
    term: SearchTerm;
    whereClause: string;
  }): Promise<LevelMatch | null> {
    const { ctx, geographyType, name, nameStateAbbr, term, whereClause } = opts;
    const spec: TigerwebLayerSpec = TIGERWEB_LAYERS[geographyType];

    const perLayer = await Promise.all(
      spec.layers.map(async (layer) => {
        const { features = [] } = await this.queryLayer(
          `${spec.service}/MapServer/${layer}`,
          whereClause,
          spec.outFields,
          ctx,
        );
        return features.map((f) => ({ ...f, layer }));
      }),
    );
    const fetched = perLayer.flat();
    const inState = nameStateAbbr ? this.filterByStateInName(fetched, nameStateAbbr) : fetched;
    // A wildcard stands for any letter, not only an accented one, so "D_n_" also matches
    // "Dina" — only a row whose accent-folded name holds the term is the name asked for.
    const folded = fold(term.exactTerm);
    const features = term.wildcarded
      ? inState.filter((f) => fold(String(f.attributes.NAME ?? '')).includes(folded))
      : inState;

    if (features.length === 0) return null;

    const preferred = this.preferExactMatches(features, term.exactTerm, spec);
    return {
      ...preferred,
      cdpOnly: preferred.exact && preferred.features.every((f) => f.layer === spec.cdpLayer),
      geographyType,
      name,
    };
  }

  /** Resolve a level's match to its geography. */
  private async settle(match: LevelMatch, ctx: Context): Promise<ResolvedGeography> {
    const { features, geographyType, name } = match;
    const spec: TigerwebLayerSpec = TIGERWEB_LAYERS[geographyType];

    // Any surviving row is a distinct geography, so picking the first of several is a
    // coin flip between real places — "Boston" alone matches towns in IN, GA, and MA.
    // Report every candidate instead and let the caller choose.
    if (features.length > 1) {
      throw this.ambiguousName(name, geographyType, features);
    }

    // biome-ignore lint/style/noNonNullAssertion: a match is never built from an empty row set
    const row = features[0]!;
    const attrs = row.attributes;

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
    const cdp = row.layer === spec.cdpLayer;
    if (cdp) result.censusDesignatedPlace = true;

    if (geographyType === ECONOMIC_PLACE) {
      if (!stateFips) {
        throw serviceUnavailable(
          'TIGERweb returned an economic place row without its STATE code.',
          {
            reason: 'resolution_unavailable',
          },
        );
      }
      const county = await this.economicPlaceCounty(stateFips, fipsSummary, cdp, ctx);
      if (!county) throw this.economicPlaceUnplaced(result.name, stateFips, fipsSummary);
      result.fipsSummary = `${county}${fipsSummary}`;
    }

    return result;
  }

  /**
   * The 3-digit county prefix of an economic place's code: the one county the place lies in, or
   * `000` when it spans several. Resolves to `undefined` when no 2022 boundary locates it.
   *
   * A balance of county is coded `98` plus its county, so its prefix is in the code. An
   * incorporated place or CDP is tested against the counties whose interiors its own interior
   * meets (DE-9IM `T********`), so a county it only borders never counts. A layer-2 economic
   * place with no place boundary is a minor civil division — a New Jersey township, a New England
   * town — and a county subdivision nests in one county, which its row names.
   */
  private async economicPlaceCounty(
    stateFips: string,
    placeFips: string,
    cdp: boolean,
    ctx: Context,
  ): Promise<string | undefined> {
    if (placeFips.startsWith('98')) return placeFips.slice(2);

    const { service, incorporatedPlaces, censusDesignatedPlaces, countySubdivisions, counties } =
      BOUNDARIES_2022;
    const boundary = await this.queryLayer(
      `${service}/MapServer/${cdp ? censusDesignatedPlaces : incorporatedPlaces}`,
      `STATE='${stateFips}' AND PLACE='${placeFips}'`,
      'PLACE',
      ctx,
      { returnGeometry: true },
    );
    const geometry = boundary.features?.[0]?.geometry;

    if (geometry) {
      const url = `${TIGERWEB_SERVICES}/${service}/MapServer/${counties}/query`;
      ctx.log.debug('TIGERweb county intersection', { url, stateFips, placeFips });
      // A city's polygon runs to hundreds of kilobytes, past any URL limit, so it is POSTed.
      const within = await this.requestTigerweb(url, ctx, {
        method: 'POST',
        body: new URLSearchParams({
          geometry: JSON.stringify(geometry),
          geometryType: 'esriGeometryPolygon',
          inSR: String(boundary.spatialReference?.wkid ?? ''),
          spatialRel: 'esriSpatialRelRelation',
          relationParam: 'T********',
          where: `STATE='${stateFips}'`,
          outFields: 'COUNTY',
          returnGeometry: 'false',
          f: 'json',
        }),
      });
      const codes = (within.features ?? []).flatMap((f) => {
        const code = this.levelCode(f.attributes, 'COUNTY', 3);
        return code ? [code] : [];
      });
      if (codes.length === 0) {
        throw serviceUnavailable(
          `TIGERweb placed place ${placeFips} of state ${stateFips} in no county.`,
          { reason: 'resolution_unavailable' },
        );
      }
      return codes.length === 1 ? codes[0] : '000';
    }

    if (cdp) return;
    const subdivision = await this.queryLayer(
      `${service}/MapServer/${countySubdivisions}`,
      `STATE='${stateFips}' AND COUSUB='${placeFips}'`,
      'COUNTY',
      ctx,
    );
    const attrs = subdivision.features?.[0]?.attributes;
    return attrs && this.levelCode(attrs, 'COUNTY', 3);
  }

  /**
   * Build the `no_match` error for an economic place whose county prefix no 2022 boundary could
   * supply — its code cannot be completed, and a guessed prefix would query a different place.
   */
  private economicPlaceUnplaced(name: string, stateFips: string, placeFips: string) {
    return notFound(
      `"${name}" is a 2022 economic place (place code ${placeFips}), but no 2022 boundary locates its county, so its 8-digit code cannot be completed.`,
      {
        reason: 'no_match',
        name,
        attemptedTypes: [ECONOMIC_PLACE],
        recovery: {
          hint: `Query ecnbasic 2022 at geography_level "economic place" with geography_fips "*", parent_fips "${stateFips}", and an industry predicate, and take the row whose code ends in ${placeFips}.`,
        },
      },
    );
  }

  /** Query one TIGERweb layer by WHERE clause. */
  private queryLayer(
    layerPath: string,
    whereClause: string,
    outFields: string,
    ctx: Context,
    options: { returnGeometry?: boolean } = {},
  ): Promise<TigerwebResponse> {
    const url = `${TIGERWEB_SERVICES}/${layerPath}/query?where=${encodeURIComponent(whereClause)}&outFields=${outFields}&returnGeometry=${options.returnGeometry ?? false}&f=json`;

    ctx.log.debug('TIGERweb query', { url, whereClause });

    return this.requestTigerweb(url, ctx);
  }

  /** Send one TIGERweb request, retrying transient failures, and read its JSON body. */
  private async requestTigerweb(
    url: string,
    ctx: Context,
    init: { method?: 'POST'; body?: URLSearchParams } = {},
  ): Promise<TigerwebResponse> {
    const data = await withRetry(
      async () => {
        const response = await fetchWithTimeout(url, 10_000, ctx as unknown as RequestContext, {
          ...init,
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
        operation: 'GeographyService.requestTigerweb',
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

    return data;
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
  private filterByStateInName(features: LayerFeature[], stateAbbr: string): LayerFeature[] {
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
   *
   * A row whose own name (`BASENAME`) is the term outranks one whose full `NAME` is: compared
   * case-insensitively, "Jersey City" is both Jersey City's `BASENAME` and the `NAME` "Jersey
   * city" of Jersey, GA, and only the first is the place the caller named.
   *
   * Among exact rows, an incorporated place outranks a census-designated place of the same name,
   * since a CDP is a statistical area and the government is what the name ordinarily means —
   * "Paradise, CA" is Paradise town, not the Paradise CDP in Mono County. A CDP is still reached
   * by its full name ("Paradise CDP, CA").
   *
   * `exact` says whether the rows kept are named the term or only contain it, which is what
   * lets a later level's exact row outrank them.
   */
  private preferExactMatches(
    features: LayerFeature[],
    queryTerm: string,
    spec: TigerwebLayerSpec,
  ): { features: LayerFeature[]; exact: boolean } {
    const term = fold(queryTerm);
    if (!term) return { features, exact: false };

    const byBasename = features.filter((f) => {
      const basename = String(f.attributes.BASENAME ?? '');
      // A statistical area's BASENAME keeps its state list ("Bend, OR"), which the split term
      // never carries — compared whole, the exact row could never match its own name.
      const bare = spec.stateInName ? basename.replace(BASENAME_STATE_LIST, '') : basename;
      return fold(bare) === term;
    });
    const byName = features.filter((f) => fold(String(f.attributes.NAME ?? '')) === term);
    const exact = byBasename.length > 0 ? byBasename : byName;
    if (exact.length === 0) return { features, exact: false };

    const governed = exact.filter((f) => f.layer !== spec.cdpLayer);
    return { features: governed.length > 0 ? governed : exact, exact: true };
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
      const code = this.levelCode(f.attributes, spec.codeField, spec.codeLength) ?? '';
      return {
        name: String(f.attributes.NAME ?? ''),
        geographyType,
        // Every candidate carries the value resolving it would have returned, so the caller
        // can take one straight to census_query_data instead of narrowing the name. An economic
        // place's code needs a county prefix only a spatial lookup finds, so its candidates
        // carry the place code alone rather than a lookup per candidate.
        ...(geographyType === ECONOMIC_PLACE ? { placeFips: code } : { fipsSummary: code }),
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
        : geographyType === ECONOMIC_PLACE
          ? ' — an economic place code carries a county prefix only resolution finds, so re-call census_resolve_geography with the name of the one you want'
          : '';

    return validationError(`"${name}" matched ${matches.length} geographies.`, {
      reason: 'ambiguous_name',
      candidates,
      recovery: { hint: `Re-query with one of: ${candidateList}${more}${next}` },
    });
  }

  /**
   * Build the `no_match` error for a name no layer in the chain matched. The hint is built from
   * the split name, so it names the place and state apart and never appends a second state to
   * a name that already carries one.
   */
  private noMatch(name: string, split: SplitName, types: GeographyType[], countyFips?: string) {
    const attempted = types.join(' or ');
    // county_fips narrows the chain to the levels that sit in a county, so it is part of why
    // nothing matched — a caller told only to check the spelling would re-run the same miss.
    const scope = countyFips ? ` in county ${countyFips}` : '';

    return notFound(`No ${attempted} matched "${name}"${scope}.`, {
      reason: 'no_match',
      name,
      attemptedTypes: types,
      ...(countyFips && { countyFips }),
      recovery: { hint: this.noMatchHint(name, split, types, countyFips) },
    });
  }

  private noMatchHint(
    name: string,
    split: SplitName,
    types: GeographyType[],
    countyFips: string | undefined,
  ): string {
    const { placeName, stateLabel } = split;
    const attempted = types.join(' or ');
    const levels = GEOGRAPHY_TYPES.join(', ');

    // A ZCTA is not a ZIP: ZIPs that serve only PO boxes or a single address have none, yet
    // cbp publishes data for them under the ZIP itself, so a miss here says nothing about cbp.
    if (types.includes(ZCTA)) {
      const zip = ZIP_CODE.exec(name.trim())?.[1];
      return zip
        ? `"${zip}" was checked only as a ZIP Code Tabulation Area (ZCTA), and no ZCTA has that code. cbp publishes ZIP-level data by the ZIP itself: pass "${zip}" as geography_fips with geography_level "zip code" — it needs no resolution.`
        : `A zip code tabulation area is named by its 5-digit code (e.g., "98109") — pass the ZIP, or set geography_type to search a named level (${levels}).`;
    }

    // A statistical area was asked for by level, so another level or a street address would
    // not answer the call — a single city the area contains would.
    if (types.every((type) => TIGERWEB_LAYERS[type].stateInName)) {
      const leadingCity = placeName.split('-')[0]?.trim() ?? '';
      const inState = stateLabel ? ` covers ${stateLabel}` : '';
      const leading =
        leadingCity !== placeName ? `, and none contains its leading city "${leadingCity}"` : '';
      return `No ${attempted} named "${placeName}"${inState}${leading} — check the spelling, or name the area by a single city it contains, as in "Seattle, WA" for the Seattle-Tacoma-Bellevue metro area.`;
    }

    // Only places that clear the Economic Census threshold are economic places, so a real town
    // can miss here — its establishments are tabulated in its county's balance.
    if (types.includes(ECONOMIC_PLACE)) {
      const inState = stateLabel ? ` in ${stateLabel}` : '';
      return `No 2022 economic place named "${placeName}"${inState}. Economic places are the incorporated places, census-designated places, and county subdivisions with 2,500 or more residents or jobs, plus each county's remainder ("Balance of Adams County"), which holds the establishments of every smaller place in it. Check the spelling, or resolve "Balance of <county> County" for a smaller place.`;
    }

    const scope = countyFips ? ` in county ${countyFips}` : '';
    const dropScope = countyFips ? ' drop county_fips,' : '';
    return stateLabel
      ? `No ${attempted} named "${placeName}" exists in ${stateLabel}${scope} — check the spelling,${dropScope} set geography_type to search a different level (${levels}), or pass a full street address.`
      : `Add the state abbreviation (e.g., "${placeName}, WA"),${dropScope} set geography_type to search a specific level (${levels}), or pass a full street address.`;
  }

  /**
   * Split a trailing state off a place name — "Seattle, WA", "Seattle, wa", "Chatham County,
   * Georgia", or a statistical area's "Omaha-Council Bluffs, NE-IA".
   *
   * After a comma, the whole final segment must be a state: a full name or territory alias
   * matched exactly and case-insensitively, or two-letter abbreviations in either case,
   * hyphenated into a list. Matching the whole segment keeps "McDowell County, West Virginia"
   * from reading as Virginia. Without a comma only an uppercase abbreviation splits, since a
   * trailing state word cannot be told apart from a place name ending in one. A list scopes by
   * its first state, the one the area is named for.
   */
  private splitStateSuffix(name: string): SplitName {
    const comma = name.lastIndexOf(',');
    const placeName = comma === -1 ? '' : name.slice(0, comma).trim();
    const suffix = comma === -1 ? '' : name.slice(comma + 1).trim();

    if (placeName) {
      const byName = STATE_NAME_TO_ABBR[suffix.toLowerCase()];
      if (byName) return { placeName, stateAbbr: byName, stateLabel: byName };
      if (STATE_LIST_SUFFIX.test(suffix)) {
        const stateLabel = suffix.toUpperCase();
        return { placeName, stateAbbr: stateLabel.slice(0, 2), stateLabel };
      }
      return { placeName: name };
    }

    const bare = /\s+([A-Z]{2}(?:-[A-Z]{2})*)\s*$/.exec(name);
    if (!bare?.[1]) return { placeName: name };
    return {
      placeName: name.slice(0, bare.index).trim(),
      stateAbbr: bare[1].slice(0, 2),
      stateLabel: bare[1],
    };
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
    const blockGeo = (geos['2020 Census Blocks'] ?? [])[0];
    const tractGeo = (geos['Census Tracts'] ?? [])[0] ?? blockGeo;
    const placeGeo = (geos['Incorporated Places'] ?? [])[0];
    const stateGeo = (geos.States ?? [])[0];

    // STATE field is available in Census Tracts, Blocks, and Incorporated Places.
    const rawState = tractGeo?.STATE ?? placeGeo?.STATE ?? stateGeo?.STATE;
    const stateFips = rawState ? String(rawState).padStart(2, '0') : '';
    const countyFips = tractGeo?.COUNTY ? String(tractGeo.COUNTY).padStart(3, '0') : undefined;
    const tractFips = tractGeo?.TRACT ? String(tractGeo.TRACT) : undefined;
    // Only the block layer names the block group, and only the incorporated-places layer names
    // a place — an address outside every incorporated place has no place to report.
    const blockGroupFips = blockGeo?.BLKGRP ? String(blockGeo.BLKGRP) : undefined;
    const placeFips = placeGeo?.PLACE ? String(placeGeo.PLACE).padStart(5, '0') : undefined;

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
    if (blockGroupFips) result.blockGroupFips = blockGroupFips;
    if (placeFips) result.placeFips = placeFips;

    return result;
  }

  /**
   * Ordered layer chain for a name with no explicit `geography_type`.
   *
   * A bare 5-digit ZIP (or ZIP+4) is a ZCTA — only codes are digits, and a caller holding a
   * place, county, or CBSA code has no reason to resolve it. Anything that is neither that, a
   * state name, nor a county/tract keyword is tried as a place
   * first and a county second, so "Seattle, WA" reaches the place layer while a name that
   * exists only as a county-equivalent still resolves. Keywords match whole words only —
   * "Marlborough" and "Parishville" are places — and "borough" tries the county layer before
   * the place layer, since it names an Alaska county-equivalent and a PA/NJ place alike.
   * A spelled-out state name must match
   * the whole input — a substring test would read "West Virginia University" as a state.
   *
   * "New York" resolves to the state: the Census place name for New York City is also
   * exactly "New York", and there is no qualifier a caller would naturally add to tell them
   * apart, so the city requires an explicit `geography_type: "place"`.
   */
  private detectGeographyTypes(name: string): GeographyType[] {
    const trimmed = name.trim();
    const lower = trimmed.toLowerCase();

    if (ZIP_CODE.test(trimmed)) return [ZCTA];
    if (/^[A-Z]{2}$/.test(trimmed)) return ['state'];
    if (STATE_NAME_TO_ABBR[lower]) return ['state'];
    if (/\b(?:county|parish)\b/.test(lower)) return ['county'];
    if (/\bborough\b/.test(lower)) return ['county', 'place'];
    if (/\btract\b/.test(lower)) return ['tract'];
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
