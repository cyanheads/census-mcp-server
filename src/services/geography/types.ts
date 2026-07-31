/**
 * @fileoverview Domain types for the Census geography resolution service.
 * @module services/geography/types
 */

/** Census geography level a name can resolve to — one TIGERweb layer each. */
export type GeographyType = 'state' | 'county' | 'place' | 'tract';

/** Resolved geography with FIPS identifiers. */
export interface ResolvedGeography {
  /** 3-digit county FIPS code (when applicable). */
  countyFips?: string;
  /** Pre-formatted FIPS value ready to pass as geography_fips to census_query_data. */
  fipsSummary: string;
  /** Geography level the name resolved to. */
  geographyType: GeographyType;
  /** Canonical name of the resolved geography. */
  name: string;
  /** Place FIPS code (when applicable). */
  placeFips?: string;
  /** 2-digit state FIPS code. */
  stateFips: string;
  /** 6-digit tract FIPS code (when applicable). */
  tractFips?: string;
}

/** TIGERweb MapServer query response shape. */
export interface TigerwebFeature {
  attributes: {
    NAME: string;
    /** Unqualified name — "Seattle" for NAME "Seattle city", "King" for "King County". */
    BASENAME?: string;
    STATE: string;
    COUNTY?: string;
    PLACE?: string;
    TRACT?: string;
    [key: string]: string | number | undefined;
  };
}

export interface TigerwebResponse {
  error?: { message: string };
  features?: TigerwebFeature[];
}

/** Census Geocoder response shape. */
export interface GeocoderResult {
  input?: { address?: { address: string } };
  result?: {
    addressMatches?: GeocoderMatch[];
  };
}

export interface GeocoderMatch {
  geographies?: {
    /** Present when benchmark includes the State layer. */
    States?: Array<{ STATE: string }>;
    /** Present when benchmark includes the County layer. */
    Counties?: Array<{ STATE: string; COUNTY: string }>;
    /** Census tracts include STATE, COUNTY, and TRACT. */
    'Census Tracts'?: Array<{ STATE: string; COUNTY: string; TRACT: string }>;
    /** Block-level geography — also carries STATE, COUNTY, TRACT. */
    '2020 Census Blocks'?: Array<{ STATE: string; COUNTY: string; TRACT: string }>;
    /** Incorporated places carry STATE and PLACE (no COUNTY or TRACT). */
    'Incorporated Places'?: Array<{ STATE: string; PLACE: string }>;
  };
  matchedAddress: string;
}
