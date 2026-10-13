/**
 * @fileoverview Ranking for Census variable search: a query that is a variable or table code
 * first, then whole-word matching on label and concept with an all-terms filter, a most-terms
 * fallback, and one sort-key order with no weights.
 * @module services/variable-cache/variable-search
 */

import type { CensusVariable } from './types.js';

/** Result of ranking a variable set against a query. */
export interface VariableSearchResult {
  /** Variables matched as a code — the leading part of `variables` — before any limit. */
  codeMatches: number;
  /**
   * Distinct query terms the returned variables contain — every term, unless no variable held
   * them all and the search fell back to the variables that contain the most. A query that
   * matched as a code counts every term.
   */
  matchedTermCount: number;
  /** Distinct words in the query. Zero when the query holds no letters or digits. */
  termCount: number;
  /** Variables matched — the code tier and the keyword tier together — before any limit. */
  totalMatches: number;
  /** Matching variables in rank order, cut to the limit. */
  variables: CensusVariable[];
}

/**
 * True for a `group` naming more than one table (`"B17015,B18104,…"`). Such a column's concept
 * joins every one of those tables' concepts, so it describes none of them.
 */
export function isSharedAcrossTables(group: string | undefined): boolean {
  return group?.includes(',') ?? false;
}

/** The one table a variable belongs to, or undefined for shared and table-less columns. */
export function tableOf(variable: CensusVariable): string | undefined {
  const { group } = variable;
  return group && group !== 'N/A' && !isSharedAcrossTables(group) ? group : undefined;
}

/**
 * The query when it is a single token — the only form a code can take — else undefined. Quotes,
 * backticks, and other punctuation around it are dropped (`"B19013",` reads as `B19013`); no code
 * starts or ends with one.
 */
export function codeToken(query: string): string | undefined {
  const token = query.trim().replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, '');
  return /^\S+$/.test(token) ? token : undefined;
}

/**
 * True for a token shaped like a Census code: a letter, then letters, digits, and underscores, with
 * at least one digit or underscore. A number (`2020`, `65`) or a hyphenated word (`covid-19`) is a
 * keyword, never a code. Letter-only words (`AGE`, `SEX`, `STATE`) are column codes on some
 * datasets and ordinary keywords everywhere, so `rankVariables` reads such a token as a code only
 * when no keyword matched it, or when it was typed in the code's own uppercase spelling.
 */
export function looksLikeCode(token: string): boolean {
  return /^\p{L}[\p{L}\p{N}_]*$/u.test(token) && /[\d_]/.test(token);
}

const byCode = (a: CensusVariable, b: CensusVariable) =>
  a.code < b.code ? -1 : a.code > b.code ? 1 : 0;

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
 * the query describes; the whole concept equalling it marks the table it describes. Every
 * placement ranks below the code tier, which `rankVariables` puts ahead of all of them.
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
 * `code` is the query in the dataset's own spelling when it is a single token (`codeToken`). The
 * variables whose code equals it, or whose single table (`tableOf`) does, form a code tier in code
 * order ahead of every keyword match, and are not repeated among them: `B19013` returns
 * `B19013_001E` then `B19013_001M`. A token without a digit or underscore takes the code tier when
 * the keyword search matched nothing, so `POPGROUP` and `popgroup` find their column; otherwise
 * only when it was typed exactly as the dataset spells the code and its keyword matches leave a
 * variable of it out. So `STATE` on `dec/dhc` leads the six labels holding "state" with the column
 * labelled "Geography", while `state` and `State` return those six alone; `BENEFIT` on `ecnbasic`
 * ("Total fringe benefits") leads `BENPEB`, the one label holding "benefit", which `benefit`
 * returns alone; and `AGE` keeps its keyword order on `pep/charv`, where AGE is among them. Once the
 * code tier matched, a most-terms keyword fallback is dropped: the query matched whole, and the
 * variables holding only some of its words are noise beside it.
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
  code?: string,
): VariableSearchResult {
  const queryWords = words(query);
  const terms = [...new Set(queryWords)];
  if (terms.length === 0) {
    return { variables: [], totalMatches: 0, codeMatches: 0, matchedTermCount: 0, termCount: 0 };
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
      byCode(a.variable, b.variable),
  );

  const asCode =
    code === undefined
      ? []
      : [...variables.values()].filter((v) => v.code === code || tableOf(v) === code).sort(byCode);
  const keywordHolds = new Set(tier.map((c) => c.variable));
  const codeTier =
    code !== undefined &&
    (looksLikeCode(code) ||
      tier.length === 0 ||
      (codeToken(query) === code && asCode.some((v) => !keywordHolds.has(v))))
      ? asCode
      : [];

  if (codeTier.length === 0) {
    return {
      variables: tier.slice(0, limit).map((c) => c.variable),
      totalMatches: tier.length,
      codeMatches: 0,
      matchedTermCount: best,
      termCount: terms.length,
    };
  }

  const inCodeTier = new Set(codeTier);
  const ranked = [
    ...codeTier,
    ...(best === terms.length
      ? tier.map((c) => c.variable).filter((variable) => !inCodeTier.has(variable))
      : []),
  ];
  return {
    variables: ranked.slice(0, limit),
    totalMatches: ranked.length,
    codeMatches: codeTier.length,
    matchedTermCount: terms.length,
    termCount: terms.length,
  };
}
