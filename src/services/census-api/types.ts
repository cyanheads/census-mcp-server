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
  | {
      status: 'ok';
      /**
       * Every parent the level names, in hierarchy order — the scopes a caller could narrow by.
       * Absent when the dataset publishes no geography metadata for the year.
       */
      acceptedParents?: string[];
    }
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

/** A symbol a business dataset published in a measure's `_F` flag column, with its meaning. */
export interface CensusFlag {
  /** The symbol as the Census wrote it (e.g. "D", "j", "s") — case matters. */
  code: string;
  /** What the symbol means, from the Census documentation for the dataset family. */
  meaning: string;
}

/** A single variable value from a Census data query. */
export interface CensusVariableValue {
  /** Numeric estimate, or null if suppressed. */
  estimate: number | null;
  /**
   * The flag the dataset published beside this measure, when there was one. A flag that means the
   * value was withheld also sets `suppressed`; one that annotates a published figure (revised, a
   * high relative standard error, noise infusion) leaves the estimate in place.
   */
  flag?: CensusFlag;
  /** Human-readable label for this variable code. */
  label: string;
  /** Margin of error if the corresponding MOE variable was requested. */
  moe?: number | null;
  /**
   * True on an ACS estimate whose requested margin of error is `-333333333`: the median falls in
   * the lowest or highest interval of an open-ended distribution, so the figure is that interval's
   * boundary (`250001` for "250,000+", `9999` for "10,000-"). Which end it is, the MOE code does
   * not say.
   */
  openEnded?: boolean;
  /** Whether this value was withheld — an ACS negative sentinel, or a withholding flag. */
  suppressed: boolean;
  /** Human-readable explanation when suppressed, where the Census publishes one. */
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

/**
 * The ACS margin-of-error sentinel for an estimate controlled to an independent population or
 * housing count. The Census says its margin of error "may be treated as zero", and the 2009
 * vintage writes the same cell as a literal `0`, so it is read as the number zero.
 */
export const ACS_CONTROLLED_MOE = -555555555;

/** The ACS margin-of-error sentinel that marks its estimate as an open-ended interval's boundary. */
export const ACS_OPEN_ENDED_MOE = -333333333;

/**
 * What each ACS negative sentinel means, keyed by numeric value so the float form subject and
 * profile percent columns use (`-666666666.0`) resolves like the integer form. Worded from the
 * Census estimate and annotation values table
 * (census.gov/data/developers/data-sets/acs-1year/notes-on-acs-estimate-and-annotation-values.html),
 * which covers the 1-year and 5-year surveys alike. ACS only: the other families withhold through
 * flag columns, and a value this low there has no published meaning.
 */
export const ACS_SENTINEL_REASONS: ReadonlyMap<number, string> = new Map([
  [
    -666666666,
    'Estimate not computable: too few sample observations (also used for a ratio of medians where a median falls in an open-ended interval, and for a 5-year median whose margin of error exceeds it)',
  ],
  [-999999999, 'Cannot be displayed: too few sample cases in this geography'],
  [-888888888, 'Not applicable or not available'],
  [-222222222, 'Margin of error not computable: too few sample observations'],
  [
    ACS_OPEN_ENDED_MOE,
    "Margin of error not computable: the median falls in the lowest or highest interval of an open-ended distribution, so the estimate is that interval's boundary",
  ],
]);

/**
 * What a business-dataset flag symbol does to the value beside it.
 *
 * - `withholds`: the measure holds a `0` placeholder and the value was not published.
 * - `annotates`: the measure holds a published figure and the symbol is a note on it.
 * - `ranges`: the symbol is a range — a noise band or a data-quality band — which the range
 *   columns (`cbp` `EMP_N`, "Noise range for number of employees"; `ecnbasic` `RCPTOT_IMP`, "Range
 *   indicating imputed percentage …") publish in place of a number, leaving `0` in the measure.
 *   Beside a nonzero figure the same symbol can only be a note on it, so it annotates there.
 */
type CensusFlagEffect = 'withholds' | 'annotates' | 'ranges';

/**
 * What each business-dataset flag symbol means, and what it does to the value beside it.
 *
 * `cbp`, `ecnbasic`, and `nonemp` publish a `_F` column beside each measure. A withheld cell holds
 * `0` in the measure — the CBP record layouts say "Employment or payroll field set to zero" — and
 * the symbol is the only thing that tells it apart from a real zero. Meanings are from the 2022
 * Economic Census data dictionary, the County Business Patterns record layouts and methodology,
 * and the Nonemployer Statistics methodology. The symbols are case-sensitive: `j` is an employment
 * range, `J` is high noise.
 *
 * Withholding symbols: `D`, `S`, `N`, `Q`, `X`, `*`, the employment ranges `a`–`m`, and the receipt
 * ranges. Range symbols: the data-quality bands `0`–`9` and the noise bands `G`, `H`, `J`, `^`,
 * which the API carries only on the range columns, always beside a `0`. The rest (`r`, `s`, `A`,
 * `Z`, `-`) annotate a figure that was published.
 */
export const CENSUS_FLAGS: ReadonlyMap<string, { meaning: string; effect: CensusFlagEffect }> =
  new Map([
    [
      'D',
      {
        meaning:
          'Withheld to avoid disclosing data for individual companies; data are included in higher level totals',
        effect: 'withholds',
      },
    ],
    [
      'S',
      {
        meaning: 'Withheld because the estimate did not meet publication standards',
        effect: 'withholds',
      },
    ],
    ['N', { meaning: 'Not available or not comparable', effect: 'withholds' }],
    [
      'Q',
      {
        meaning: 'Revenue not collected at this level of detail for multiestablishment firms',
        effect: 'withholds',
      },
    ],
    ['X', { meaning: 'Not applicable', effect: 'withholds' }],
    [
      '*',
      {
        meaning: 'Measure of sampling variability not shown since the estimate is not published',
        effect: 'withholds',
      },
    ],
    ...(
      [
        ['a', '0 to 19'],
        ['b', '20 to 99'],
        ['c', '100 to 249'],
        ['e', '250 to 499'],
        ['f', '500 to 999'],
        ['g', '1,000 to 2,499'],
        ['h', '2,500 to 4,999'],
        ['i', '5,000 to 9,999'],
        ['j', '10,000 to 24,999'],
        ['k', '25,000 to 49,999'],
        ['l', '50,000 to 99,999'],
        ['m', '100,000 or more'],
      ] as const
    ).map(
      ([code, range]) =>
        [
          code,
          {
            meaning: `Withheld to avoid disclosing data for individual companies; the published employment range is ${range} employees`,
            effect: 'withholds',
          },
        ] as const,
    ),
    ...(
      [
        ['B', 'less than $1 million'],
        ['I', '$1 million to less than $5 million'],
        ['K', '$5 million to less than $15 million'],
        ['L', '$15 million to less than $50 million'],
        ['M', '$50 million to less than $75 million'],
        ['O', '$75 million to less than $150 million'],
        ['R', '$150 million to less than $500 million'],
        ['T', '$500 million to less than $1 billion'],
        ['U', '$1 billion to less than $5 billion'],
        ['W', '$5 billion or more'],
      ] as const
    ).map(
      ([code, range]) =>
        [
          code,
          {
            meaning: `Withheld to avoid disclosing data for individual companies; the published sales range is ${range}`,
            effect: 'withholds',
          },
        ] as const,
    ),
    ...(
      [
        ['0', 'less than 10%'],
        ['1', '10% to less than 20%'],
        ['2', '20% to less than 30%'],
        ['3', '30% to less than 40%'],
        ['4', '40% to less than 50%'],
        ['5', '50% to less than 60%'],
        ['6', '60% to less than 70%'],
        ['7', '70% to less than 80%'],
        ['8', '80% to less than 90%'],
        ['9', '90% to 100%'],
      ] as const
    ).map(
      ([code, band]) =>
        [
          code,
          {
            meaning: `Data quality band ${band} (imputation rate or relative standard error)`,
            effect: 'ranges',
          },
        ] as const,
    ),
    ['r', { meaning: 'Revised', effect: 'annotates' }],
    ['s', { meaning: 'Relative standard error exceeds 40%', effect: 'annotates' }],
    ['A', { meaning: 'Relative standard error of 100% or more', effect: 'annotates' }],
    ['Z', { meaning: 'Rounds to zero', effect: 'annotates' }],
    ['-', { meaning: 'Zero or rounds to zero', effect: 'annotates' }],
    [
      'G',
      { meaning: 'Low noise infusion: the value was changed by less than 2%', effect: 'ranges' },
    ],
    [
      'H',
      {
        meaning: 'Medium noise infusion: the value was changed by 2% to less than 5%',
        effect: 'ranges',
      },
    ],
    [
      'J',
      { meaning: 'High noise infusion: the value was changed by 5% or more', effect: 'ranges' },
    ],
    ['^', { meaning: 'Noise infusion range not applicable', effect: 'ranges' }],
  ]);
