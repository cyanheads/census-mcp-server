/**
 * @fileoverview Domain types for the Census variable cache service.
 * @module services/variable-cache/types
 */

/** A single variable entry from Census variables.json. */
export interface CensusVariable {
  /**
   * Column this attribute column annotates or flags, as the per-variable endpoint publishes it
   * (e.g. "B19013_001E" for `B19013_001EA`). Present on attribute columns and ACS margins of
   * error only.
   */
  attributeOf?: string;
  /** Kind of attribute column, as published (e.g. "ANNOTATION", "FLAG", "LABEL"). */
  attributeType?: string;
  /** Variable code (e.g., "B19013_001E"). */
  code: string;
  /**
   * Concept of the table the variable belongs to (e.g., "Median Household Income in the Past 12
   * Months"). Absent on a column shared across tables (`GEO_ID`, the `ecnbasic` measures): its
   * `group` lists every table and its concept joins every one of theirs — 99,266 bytes for
   * `GEO_ID` on `acs/acs5` 2024 — so it names none of them and matches almost any query. Also
   * absent when the dataset publishes no concept for the column (the ACS `STATE` column).
   */
  concept?: string;
  /** Corresponding estimate variable code when this is a MOE variable. */
  estimateCode?: string;
  /**
   * Flag column published beside this measure (e.g. "RCPTOT_F"), on the business datasets. A
   * withheld value holds `0` in the measure and a symbol in this column, so the column has to be
   * read for the number to mean anything. Present on numeric measures only.
   */
  flagAttribute?: string;
  /**
   * Table the variable belongs to, as variables.json names it (e.g. "T01001" on `dec/ddhca`,
   * "CB2300CBP" on `cbp`), or `"N/A"` for the geography and metadata columns that belong to no
   * table. Which table a query reads decides how many of a dimension's codes come back, so this
   * is what picks the probe variable in `findPublicationProbe`.
   */
  group?: string;
  /** Human-readable label (e.g., "Estimate!!Median household income in the past 12 months"). */
  label: string;
  /**
   * Attribute column carrying the human-readable label of this variable's value
   * (e.g. "POPGROUP_LABEL"). Present on filter dimensions; requesting it in a query echoes
   * back the label of whatever value the Census API applied.
   */
  labelAttribute?: string;
  /** Corresponding MOE variable code when this is an estimate variable. */
  moeCode?: string;
  /** Predicate type (e.g., "int", "string", "float"). */
  predicateType: string;
  /**
   * True when variables.json marks the variable `required` — a filter dimension the Census
   * API applies its own default to when a query omits it, rather than rejecting the query.
   */
  required?: boolean;
  /**
   * Universe of the variable's table (e.g., "Households"). The Census publishes it per table in
   * groups.json rather than per variable, so it is set only by `getVariablesByCode`, and only
   * when the variable's table publishes one.
   */
  universe?: string;
  /**
   * Codes this filter dimension accepts, mapped to their labels. Only `NAICS*` and `POPGROUP`
   * publish one; every other dimension has to be enumerated against the data endpoint.
   */
  values?: Record<string, string>;
}

/** A filter dimension the dataset declares required and the query did not set. */
export interface UnsetPredicate {
  code: string;
  label: string;
  /** Attribute column that echoes back the label of the default the API applied, when published. */
  labelAttribute?: string;
}

/**
 * A column that separates several records for one geography. Unlike a filter dimension the
 * dataset marks required, the Census API neither defaults it nor rejects a query that omits it:
 * it simply returns every record. `pep/charv` publishes one record per reference date, so a
 * query that pins no date gets an April estimates-base row and a July estimate row for the same
 * geography, carrying different numbers and nothing else to tell them apart.
 *
 * Recognized from variables.json rather than a per-dataset list: a variable the dataset does not
 * mark required, that carries its own `_LABEL` or `_DESC` attribute, is a labelled category the
 * rows vary over. Requesting it echoes each row's own value without changing which rows come back.
 */
export interface RecordDimension {
  code: string;
  label: string;
  /** Attribute column carrying the human-readable value for this row (e.g. "MONTH_DESC"). */
  labelAttribute: string;
}

/** Outcome of checking a caller's predicate map against a dataset's own variables.json. */
export interface PredicateCheck {
  /** Supplied predicate codes that are not variables in this dataset+year. */
  unknown: string[];
  /**
   * Required predicates the caller left unset. The Census API substitutes its own default for
   * each, without an error — an all-categories total for some dimensions (`cbp` `NAICS2017`),
   * one fixed category for others (`pep/charv` `YEAR`).
   */
  unset: UnsetPredicate[];
}

/** Raw variables.json structure from Census API. */
export interface RawVariablesJson {
  variables: Record<string, RawVariableEntry>;
}

/** A single raw entry from variables.json. */
export interface RawVariableEntry {
  /** Comma-separated attribute column names (e.g. "NAICS2017_F,NAICS2017_LABEL"). */
  attributes?: string;
  concept?: string;
  group?: string;
  label: string;
  limit?: number;
  predicateType?: string;
  /** Present (as "default displayed") when the API defaults this dimension instead of erroring. */
  required?: string;
  /** Published code→label map, on the few dimensions that carry one. */
  values?: { item?: Record<string, string> };
}

/**
 * One column's entry from the per-variable endpoint (`…/variables/<CODE>.json`). Attribute
 * columns have no variables.json entry of their own, so this is the only place their label and
 * the column they belong to are published. A column that is no attribute (`STATE`) carries
 * `null` in the attribute and type fields.
 */
export interface RawVariableRecord {
  'attribute of'?: string | null;
  'attribute type'?: string | null;
  concept?: string;
  group?: string;
  label?: string;
  name?: string;
  predicateType?: string | null;
}

/**
 * groups.json, one entry per table. The universe key is spelled with a trailing space
 * (`"universe "`), and tables that publish no universe omit it.
 */
export interface RawGroupsJson {
  groups?: Array<{ name?: string; 'universe '?: string; universe?: string }>;
}
