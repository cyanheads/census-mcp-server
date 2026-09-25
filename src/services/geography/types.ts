/**
 * @fileoverview Domain types for the Census geography resolution service.
 * @module services/geography/types
 */

/**
 * Census geography levels a name can resolve to.
 *
 * Each value is the level's own Census API name, so a resolved `geographyType` is also the
 * `geography_level` census_query_data takes. Statistical areas are the verbose ones because
 * that is what the Census API calls them.
 */
export const GEOGRAPHY_TYPES = [
  'state',
  'county',
  'place',
  'tract',
  'metropolitan statistical area/micropolitan statistical area',
  'combined statistical area',
  'consolidated city',
  'zip code tabulation area',
  'economic place',
] as const;

/** Census geography level a name can resolve to — one or more TIGERweb layers each. */
export type GeographyType = (typeof GEOGRAPHY_TYPES)[number];

/** Resolved geography with FIPS identifiers. */
export interface ResolvedGeography {
  /** 1-digit block group within the tract — from a street address only. */
  blockGroupFips?: string;
  /**
   * The place is a census-designated place — an unincorporated community the Census delineates
   * for statistics — rather than an incorporated one. Absent for every other geography.
   */
  censusDesignatedPlace?: true;
  /** 3-digit county FIPS code (when applicable). */
  countyFips?: string;
  /** Pre-formatted FIPS value ready to pass as geography_fips to census_query_data. */
  fipsSummary: string;
  /** Geography level the name resolved to. */
  geographyType: GeographyType;
  /** Canonical name of the resolved geography. */
  name: string;
  /**
   * 5-digit place FIPS code — the resolved place itself, or for a street address the
   * incorporated place it sits in.
   */
  placeFips?: string;
  /**
   * 2-digit state FIPS code. Absent for levels that sit outside the state hierarchy —
   * a metropolitan or combined statistical area can span several states, and the ZCTA layer
   * carries no state at all.
   */
  stateFips?: string;
  /** 6-digit tract FIPS code (when applicable). */
  tractFips?: string;
}

/** TIGERweb MapServer query response shape. */
export interface TigerwebFeature {
  attributes: {
    NAME: string;
    /** Unqualified name — "Seattle" for NAME "Seattle city", "King" for "King County". */
    BASENAME?: string;
    /** Absent on the CBSA and CSA layers, which carry no state at all. */
    STATE?: string;
    COUNTY?: string;
    PLACE?: string;
    TRACT?: string;
    /** Consolidated city code — 5 digits, scoped to its state. */
    CONCITY?: string;
    /** Nationally unique code on the CBSA and CSA layers — 5 digits for a CBSA, 3 for a CSA. */
    GEOID?: string;
    [key: string]: string | number | undefined;
  };
  /** The row's shape, present only when a query asked for geometry — an ArcGIS polygon here. */
  geometry?: unknown;
}

export interface TigerwebResponse {
  error?: { message: string };
  features?: TigerwebFeature[];
  /** Coordinate system of any geometry in the response. */
  spatialReference?: { wkid?: number };
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
    /** Block-level geography — carries STATE, COUNTY, TRACT, and the 1-digit block group. */
    '2020 Census Blocks'?: Array<{
      STATE: string;
      COUNTY: string;
      TRACT: string;
      BLKGRP?: string;
      BLOCK?: string;
    }>;
    /** Incorporated places carry STATE and PLACE (no COUNTY or TRACT). */
    'Incorporated Places'?: Array<{ STATE: string; PLACE: string; NAME?: string }>;
  };
  matchedAddress: string;
}
