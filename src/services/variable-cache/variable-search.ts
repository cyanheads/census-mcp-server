/**
 * @fileoverview Keyword ranking for Census variables: whole-word matching on label and concept,
 * an all-terms filter with a most-terms fallback, and one sort-key order with no weights.
 * @module services/variable-cache/variable-search
 */

import type { CensusVariable } from './types.js';

/** Result of ranking a variable set against a query. */
export interface VariableSearchResult {
  /**
   * Distinct query terms the returned variables contain — every term, unless no variable held
   * them all and the search fell back to the variables that contain the most.
   */
  matchedTermCount: number;
  /** Distinct words in the query. Zero when the query holds no letters or digits. */
  termCount: number;
  /** Variables in the returned tier, before any limit. */
  totalMatches: number;
  /** Matching variables in rank order, cut to the limit. */
  variables: CensusVariable[];
}

/**
 * Lowercase and split on every run of characters that is not a letter or a digit, so `rate`
 * matches the word "rate" and never the inside of "separated", and `Total:` reads as `total`.
 */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** A word list joined for whole-word containment: `' a b c '` holds `' b '` and `' a b '`. */
const padded = (tokens: string[]) => ` ${tokens.join(' ')} `;

/**
 * Where the query appears in a variable, best first. A label's last `!!` segment names the row
 * itself (`Estimate!!Total:!!Hispanic or Latino`), so it equalling the query marks the variable
 * the query describes; the whole concept equalling it marks the table it describes.
 */
const Placement = {
  Exact: 0,
  LabelAndConcept: 1,
  Label: 2,
  Concept: 3,
  TermsOnly: 4,
} as const;

interface Candidate {
  conceptLength: number;
  depth: number;
  placement: (typeof Placement)[keyof typeof Placement];
  variable: CensusVariable;
}

/**
 * Rank `variables` against `query`.
 *
 * A term matches a whole word of the label or of the concept. A variable without a concept — a
 * column shared across tables, whose concept joins every table's — matches on its label alone. A
 * margin of error matches on its estimate's label: its own opens with `Margin of Error!!`, and
 * those three words would otherwise rank it alone above its estimate whenever the query holds one
 * of them ("median value of") that the estimate does not.
 * A result contains every distinct term; when no variable does, the result is the variables that
 * contain the most terms, and `matchedTermCount` says how many that was.
 *
 * Results sort on four keys in order: where the query phrase appears (see `Placement`), then
 * fewer `!!` segments in the label, then a shorter concept, then the code. The last key puts an
 * estimate ahead of its tied margin of error, since `…E` sorts before `…M`.
 */
export function rankVariables(
  variables: ReadonlyMap<string, CensusVariable>,
  query: string,
  limit: number,
): VariableSearchResult {
  const queryWords = words(query);
  const terms = [...new Set(queryWords)];
  if (terms.length === 0) {
    return { variables: [], totalMatches: 0, matchedTermCount: 0, termCount: 0 };
  }

  const phrase = padded(queryWords);
  const bare = queryWords.join(' ');
  let best = 0;
  let tier: Candidate[] = [];

  // A table's concept repeats on every one of its variables (acs/acs5 carries ~1,200 distinct
  // concepts across ~57,000 entries), so each distinct string is tokenized once per search.
  const tokenized = new Map<string, string>();
  const normalize = (text: string) => {
    let value = tokenized.get(text);
    if (value === undefined) {
      value = padded(words(text));
      tokenized.set(text, value);
    }
    return value;
  };

  for (const variable of variables.values()) {
    const estimate = variable.estimateCode ? variables.get(variable.estimateCode) : undefined;
    const labelText = estimate?.label ?? variable.label;
    const label = normalize(labelText);
    const concept = variable.concept === undefined ? '' : normalize(variable.concept);

    let count = 0;
    for (const term of terms) {
      const word = ` ${term} `;
      if (label.includes(word) || concept.includes(word)) count++;
    }
    if (count === 0 || count < best) continue;
    if (count > best) {
      best = count;
      tier = [];
    }

    const segments = labelText.split('!!');
    const inLabel = label.includes(phrase);
    const inConcept = concept.includes(phrase);
    const placement =
      words(segments.at(-1) ?? '').join(' ') === bare || concept.trim() === bare
        ? Placement.Exact
        : inLabel && inConcept
          ? Placement.LabelAndConcept
          : inLabel
            ? Placement.Label
            : inConcept
              ? Placement.Concept
              : Placement.TermsOnly;

    tier.push({
      variable,
      placement,
      depth: segments.length,
      conceptLength: variable.concept?.length ?? 0,
    });
  }

  tier.sort(
    (a, b) =>
      a.placement - b.placement ||
      a.depth - b.depth ||
      a.conceptLength - b.conceptLength ||
      (a.variable.code < b.variable.code ? -1 : a.variable.code > b.variable.code ? 1 : 0),
  );

  return {
    variables: tier.slice(0, limit).map((c) => c.variable),
    totalMatches: tier.length,
    matchedTermCount: best,
    termCount: terms.length,
  };
}
