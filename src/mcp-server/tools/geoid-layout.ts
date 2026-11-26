/**
 * @fileoverview The layout of a full GEOID at each level whose GEOID carries its parents — the
 * parent codes its prefix holds and the width of the level's own code after them — and the reading
 * of a `geography_fips` list against a call's scope, which sends each GEOID member as its level
 * code under the parents it names. dec/pl 2000 lists a whole-number tract by 4 digits where every
 * other vintage lists 6, so a tract code, alone or inside a GEOID, goes out in the vintage's form.
 * @module mcp-server/tools/geoid-layout
 */

import type { SuppliedParent } from '@/services/census-api/types.js';

/** The width the Census stores each parent code at, in the order a GEOID carries them. */
const PARENT_WIDTHS = {
  state: 2,
  county: 3,
  tract: 6,
} as const satisfies Record<SuppliedParent, number>;

/** The dataset and vintage year a call reads. */
export interface Vintage {
  readonly dataset: string;
  readonly year: number;
}

/**
 * Whether a vintage lists a whole-number tract — one whose 6-digit code ends in 00, as Tract 71 is
 * "007100" — by the 4 digits before the 00, answering the 6-digit code with nothing. Only dec/pl
 * 2000 does: swept across every state, DC, and Puerto Rico, it lists 40,786 of its 66,304 tracts in
 * 4 digits and none of the other 25,518 ends in 00, so the two forms never name different tracts.
 * acs/acs5 2009, drawn on the same 2000 tracts, and every other vintage list all 6 digits.
 */
function shortensWholeTracts({ dataset, year }: Vintage): boolean {
  return dataset === 'dec/pl' && year === 2000;
}

/** A 6-digit tract code in the form the vintage lists it: "007100" is "0071" on dec/pl 2000. */
function tractAsListed(code: string, vintage: Vintage): string {
  return shortensWholeTracts(vintage) && /^\d{4}00$/.test(code) ? code.slice(0, 4) : code;
}

/** A level's GEOID: the codes of its parents, outermost first, then the level's own code. */
export interface GeoidLayout {
  /** Digits in the level's own code, the last part of the GEOID. */
  readonly codeWidth: number;
  /** The parents whose codes the GEOID opens with, outermost first. */
  readonly parents: readonly SuppliedParent[];
  /** Digits in the whole GEOID. */
  readonly width: number;
}

const layoutOf = (parents: SuppliedParent[], codeWidth: number): GeoidLayout => ({
  parents,
  codeWidth,
  width: parents.reduce((sum, parent) => sum + PARENT_WIDTHS[parent], codeWidth),
});

/** The tract level's layout, whose own code is the tract. */
const TRACT = layoutOf(['state', 'county'], 6);

/**
 * The levels whose GEOID is a fixed chain of parent codes followed by the level's own code, keyed
 * by level name in lowercase. No level answers its GEOID as a `for=` member, so reading one as its
 * parts never changes what a call that worked before asks for.
 */
const LAYOUTS: ReadonlyMap<string, GeoidLayout> = new Map([
  ['county', layoutOf(['state'], 3)],
  ['place', layoutOf(['state'], 5)],
  ['school district (unified)', layoutOf(['state'], 5)],
  ['economic place', layoutOf(['state'], 8)],
  ['congressional district', layoutOf(['state'], 2)],
  ['county subdivision', layoutOf(['state', 'county'], 5)],
  ['tract', TRACT],
  ['block group', layoutOf(['state', 'county', 'tract'], 1)],
  ['block', layoutOf(['state', 'county', 'tract'], 4)],
]);

/** Every level a GEOID is read at, in table order — the list a tool description names. */
export const GEOID_LEVELS: readonly string[] = [...LAYOUTS.keys()];

/** The GEOID layout of a level, matched the way the Census API matches level names. */
export function geoidLayout(level: string): GeoidLayout | undefined {
  return LAYOUTS.get(level.trim().toLowerCase());
}

/** Where a level's GEOID carries a tract: as the level's own code, as a parent, or nowhere. */
function tractPartOf(layout: GeoidLayout): 'code' | 'parent' | undefined {
  if (layout === TRACT) return 'code';
  return layout.parents.includes('tract') ? 'parent' : undefined;
}

/**
 * The width of a level's GEOID when it carries a whole-number tract in the 4 digits the vintage
 * lists it by — 2 short of the full width — or undefined where the vintage or the level has no such
 * form.
 */
export function shortGeoidWidth(level: string, vintage: Vintage): number | undefined {
  const layout = geoidLayout(level);
  if (!layout || !tractPartOf(layout) || !shortensWholeTracts(vintage)) return;
  return layout.width - 2;
}

/** A GEOID read as the parent codes it carries and the level's own code. */
export interface GeoidParts {
  readonly code: string;
  readonly parents: Readonly<Partial<Record<SuppliedParent, string>>>;
}

/**
 * Read a trimmed `member` as a GEOID of `level`: all digits, exactly the level's GEOID width — or,
 * on a vintage that lists a whole-number tract in 4 digits, 2 digits shorter at a level whose GEOID
 * carries a tract, read as carrying that 4-digit tract. The tract comes back in 6 digits either
 * way, the form tract_fips takes, so GEOIDs and the scope compare as one code. Anything else — a
 * bare level code, `*`, a level with no layout — is not one.
 */
export function splitGeoid(
  level: string,
  member: string,
  vintage: Vintage,
): GeoidParts | undefined {
  const layout = geoidLayout(level);
  if (!layout) return;
  const tract = tractPartOf(layout);
  const short = member.length === shortGeoidWidth(level, vintage);
  if ((member.length !== layout.width && !short) || !/^\d+$/.test(member)) return;
  // A whole-number tract's 4 digits are its 6-digit code without the trailing 00.
  const widened = (code: string) => (short ? `${code}00` : code);
  const parents: Partial<Record<SuppliedParent, string>> = {};
  let at = 0;
  for (const parent of layout.parents) {
    const end = at + (parent === 'tract' && short ? 4 : PARENT_WIDTHS[parent]);
    const code = member.slice(at, end);
    parents[parent] = parent === 'tract' ? widened(code) : code;
    at = end;
  }
  const code = member.slice(at);
  return { parents, code: tract === 'code' ? widened(code) : code };
}

/**
 * A `census_compare_geographies` `geographies` entry in the form the vintage's rows carry it: a
 * bare tract code, or the tract inside a full GEOID, in the 4 digits dec/pl 2000 lists a
 * whole-number tract by ("53033007100" is "530330071" there). Every other entry, and every entry
 * on another vintage, comes back as written.
 */
export function listedForm(level: string, entry: string, vintage: Vintage): string {
  const layout = geoidLayout(level);
  const tract = layout && tractPartOf(layout);
  if (!layout || !tract) return entry;
  const geoid = splitGeoid(level, entry, vintage);
  if (!geoid) return tract === 'code' ? tractAsListed(entry, vintage) : entry;
  const listed = (code: string, isTract: boolean) =>
    isTract ? tractAsListed(code, vintage) : code;
  // splitGeoid sets every parent the layout carries.
  const parents = layout.parents.map((parent) =>
    listed(geoid.parents[parent] as string, parent === 'tract'),
  );
  return [...parents, listed(geoid.code, tract === 'code')].join('');
}

const LIST = new Intl.ListFormat('en', { type: 'conjunction' });

/**
 * The sentence saying which codes were read in the 4-digit form dec/pl 2000 lists a whole-number
 * tract by, so a row carrying "0071" reads as the tract written "007100". `read` maps each code as
 * written to the form it was read as; an empty map says nothing.
 */
export function describeShortenedTracts(
  { dataset, year }: Vintage,
  read: ReadonlyMap<string, string>,
): string | undefined {
  if (read.size === 0) return;
  const pairs = [...read].map(([written, listed]) => `"${written}" was read as "${listed}"`);
  return `${dataset} (${year}) lists a census tract whose 6-digit code ends in 00 by its first 4 digits, the form its rows and GEOIDs carry, so ${LIST.format(pairs)}.`;
}

/** The parent codes a call is scoped by, padded; `*` spans every code and is never compared. */
export type GeoidScope = Readonly<Record<SuppliedParent, string | undefined>>;

/** One distinct member of a `geography_fips` list. */
export interface GeoidMember {
  /**
   * Set for a GEOID naming a parent other than the concrete one the scope gives, which is sent as
   * written: the parents that differ, outermost first, the GEOID's own parts, and the scope's codes
   * for those parents as given, a tract in the 6 digits tract_fips takes.
   */
  readonly conflict?: {
    readonly parents: readonly SuppliedParent[];
    readonly geoid: GeoidParts;
    readonly scope: Readonly<Partial<Record<SuppliedParent, string>>>;
  };
  /** The member as written, trimmed. */
  readonly given: string;
  /**
   * What is sent for it: the level code of a GEOID whose parents the scope gives, else `given` — a
   * tract code in the form the vintage lists it.
   */
  readonly sent: string;
}

/** A `geography_fips` list read against a call's scope. */
export interface GeoidReading {
  /** Omitted parents the members' GEOIDs name more than one code for, each code once, in order. */
  readonly disagreements: ReadonlyMap<SuppliedParent, readonly string[]>;
  /** What to send: `geography_fips` unchanged when no member was read, else each sent code once. */
  readonly geographyFips: string;
  /** The distinct members, in the order written. */
  readonly members: readonly GeoidMember[];
  /**
   * The parents to send: the scope, with each omitted parent the members' GEOIDs all name filled
   * in, and its tract in the form the vintage lists it.
   */
  readonly scope: GeoidScope;
  /**
   * Each tract code written in 6 digits — alone, in tract_fips, or inside a full-width GEOID — that
   * went out in the 4 the vintage lists it by, as written → as sent, in order of first mention.
   */
  readonly shortened: ReadonlyMap<string, string>;
}

/**
 * Read each member of a comma-separated `geographyFips` that is a full GEOID of `level` as its
 * parents plus its level code. A parent the scope omits is filled in only when every member is a
 * GEOID and they all name the same code for it. A GEOID is then sent as its level code when every
 * parent it carries matches a concrete scope code; one that contradicts a concrete code is sent as
 * written, with the contradiction recorded; one under a `*` or still-missing parent is sent as
 * written. Bare codes, `*`, and levels with no layout pass through untouched, except that a tract
 * code — a bare one at the tract level, the scope's tract, or a GEOID's — goes out in the form the
 * vintage lists it. Parents compare with a tract in 6 digits, whichever width a GEOID carries.
 */
export function readGeoids(
  level: string,
  geographyFips: string,
  given: GeoidScope,
  vintage: Vintage,
): GeoidReading {
  const written = [...new Set(geographyFips.split(',').map((member) => member.trim()))];
  const layout = geoidLayout(level);
  const geoids = written.map((member) => splitGeoid(level, member, vintage));
  const scope: Record<SuppliedParent, string | undefined> = { ...given };
  const disagreements = new Map<SuppliedParent, string[]>();
  if (layout && geoids.every((parts): parts is GeoidParts => parts !== undefined)) {
    for (const parent of layout.parents) {
      if (scope[parent] !== undefined) continue;
      const codes = [...new Set(geoids.flatMap((parts) => parts.parents[parent] ?? []))];
      if (codes.length === 1) scope[parent] = codes[0];
      else disagreements.set(parent, codes);
    }
  }

  const tractCodes = layout !== undefined && tractPartOf(layout) === 'code';
  const members = written.map((member, i): GeoidMember => {
    const geoid = geoids[i];
    if (!geoid || !layout) {
      return { given: member, sent: tractCodes ? tractAsListed(member, vintage) : member };
    }
    const scoped = layout.parents.map((parent) => scope[parent]);
    const parents = layout.parents.filter(
      (parent, at) =>
        scoped[at] !== undefined && scoped[at] !== '*' && scoped[at] !== geoid.parents[parent],
    );
    if (parents.length > 0) {
      const contradicted = Object.fromEntries(parents.map((parent) => [parent, scope[parent]]));
      return { given: member, sent: member, conflict: { parents, geoid, scope: contradicted } };
    }
    const complete = scoped.every((code) => code !== undefined && code !== '*');
    if (!complete) return { given: member, sent: member };
    return { given: member, sent: tractCodes ? tractAsListed(geoid.code, vintage) : geoid.code };
  });

  // Only a code the caller wrote in 6 digits is named: a GEOID 2 digits short already carries the
  // 4-digit tract, and a member sent as written sent no tract of its own.
  const shortened = new Map<string, string>();
  const note = (code: string | undefined) => {
    if (code === undefined) return;
    const listed = tractAsListed(code, vintage);
    if (listed !== code) shortened.set(code, listed);
  };
  note(given.tract);
  for (const [i, member] of written.entries()) {
    const geoid = geoids[i];
    if (members[i]?.sent === member || (geoid && member.length !== layout?.width)) continue;
    note(tractCodes ? (geoid?.code ?? member) : geoid?.parents.tract);
  }

  return {
    geographyFips: members.every((member) => member.sent === member.given)
      ? geographyFips
      : [...new Set(members.map((member) => member.sent))].join(','),
    scope: { ...scope, tract: scope.tract && tractAsListed(scope.tract, vintage) },
    members,
    disagreements,
    shortened,
  };
}
