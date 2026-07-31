/**
 * @fileoverview Domain types for the Census Bureau Data API service.
 * @module services/census-api/types
 */

/** A single row of Census API data with labeled variable values. */
export interface CensusDataRow {
  /**
   * Labels of the filter defaults the Census API applied on its own, keyed by predicate code
   * (e.g. `{ POPGROUP: 'European alone' }`). Present only for dimensions the query left unset
   * that publish a label attribute. A default is not always an all-categories total, so the
   * label is what tells a total apart from one arbitrary category.
   */
  appliedFilters?: Record<string, string>;
  /**
   * FIPS code of the geography at the queried level only, without its parents
   * (e.g., "033" for King County). This is the value the Census API `for=` clause
   * takes, so it round-trips into census_query_data's geography_fips input.
   */
  geographyFips: string;
  /**
   * Full GEOID — every geography column the response carried, concatenated in
   * hierarchy order (e.g., "53033" for King County, "53033000101" for a tract).
   * Nationally unique, so it is the safe identifier for cross-state matching.
   */
  geographyGeoid: string;
  /** Human-readable geography name (e.g., "King County, Washington"). */
  geographyName: string;
  /**
   * Which record this row is, for a dataset that publishes more than one per geography, keyed by
   * the column that separates them (e.g. `{ MONTH: { code: '7', label: 'July' } }`). The code is
   * what pins the record when passed back in a predicates map. Absent on the datasets that
   * return one row per geography.
   */
  record?: Record<string, { code: string; label: string }>;
  /** Map of variable code to parsed value entry. */
  variables: Record<string, CensusVariableValue>;
}

/** One geography level entry from a dataset's `geography.json`. */
export interface CensusGeographyLevel {
  /** Census summary-level code (e.g., "050" for county). */
  geoLevelDisplay: string;
  /** Level name as the `for=` clause takes it (e.g., "county", "block group"). */
  name: string;
  /**
   * The innermost required parent that becomes optional when the level itself is
   * queried with a `*` wildcard. Everything from this parent inward may be omitted.
   */
  optionalWithWCFor?: string;
  /** Vintage reference date for this level. */
  referenceDate?: string;
  /** Parent level names this level must be scoped by, outermost first. */
  requires?: string[];
  /** Parent levels that may themselves be wildcarded. */
  wildcard?: string[];
}

/** Outcome of pre-validating a geography level + parent combination against a dataset. */
export type GeographyCheck =
  | { status: 'ok' }
  | { status: 'level_not_supported'; availableLevels: string[] }
  | {
      status: 'parent_required';
      missingParents: string[];
      /** True when a `*` target would drop at least one of the missing parents. */
      wildcardRelaxes: boolean;
    }
  | {
      status: 'parent_not_accepted';
      /** Supplied parents the level does not name — `state`, `county`, or both. */
      unacceptedParents: string[];
      /** Every parent the level does name, in hierarchy order. Empty when it takes none. */
      acceptedParents: string[];
    };

/** One code a filter dimension accepts, with the label the dataset publishes for it. */
export interface CensusPredicateValue {
  /** The value to send in a predicates map (e.g. "210"). */
  code: string;
  /** Human-readable label (e.g. "Establishments with less than 5 employees"). */
  label: string;
}

/** A single variable value from a Census data query. */
export interface CensusVariableValue {
  /** Numeric estimate, or null if suppressed. */
  estimate: number | null;
  /** Human-readable label for this variable code. */
  label: string;
  /** Margin of error if the corresponding MOE variable was requested. */
  moe?: number | null;
  /** Whether this value was suppressed (negative sentinel code). */
  suppressed: boolean;
  /** Human-readable explanation when suppressed. */
  suppressionReason?: string;
  /**
   * The text the Census returned, for a cell that does not hold a number. Some columns are text
   * everywhere — `GEO_ID` (`"0500000US53033"`) on every dataset, `pep/charv` `UNIVERSE` (`"R"`) —
   * and an otherwise numeric column can hold text in one cell, which is how the older ACS profile
   * vintages write "not applicable" (`acs/acs5/profile` 2009 answers `DP02_0070E` with `"(X)"`).
   * Present only for such a cell, so its presence is what says the cell is text: `estimate` is
   * null alongside it, and that null means "not a number" rather than the "no value here" a bare
   * null means.
   */
  value?: string;
}

/** Raw Census API JSON response — array of arrays, first row is headers. */
export type CensusRawResponse = string[][];

/** Suppression code meanings. */
export const SUPPRESSION_CODES: Record<string, string> = {
  '-666666666': 'Not available — geography too small or data not collected',
  '-222222222': 'Not applicable',
  '-888888888': 'Estimate revised or superseded',
  '-999999999': 'Median falls in upper or lower open-ended interval',
};
