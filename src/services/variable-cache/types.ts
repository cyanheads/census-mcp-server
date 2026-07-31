/**
 * @fileoverview Domain types for the Census variable cache service.
 * @module services/variable-cache/types
 */

/** A single variable entry from Census variables.json. */
export interface CensusVariable {
  /** Variable code (e.g., "B19013_001E"). */
  code: string;
  /** Concept group the variable belongs to (e.g., "MEDIAN HOUSEHOLD INCOME IN THE PAST 12 MONTHS"). */
  concept: string;
  /** Corresponding estimate variable code when this is a MOE variable. */
  estimateCode?: string;
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
  /** Universe the variable applies to (e.g., "Households"). */
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
  universe?: string;
  /** Published code→label map, on the few dimensions that carry one. */
  values?: { item?: Record<string, string> };
}
