/**
 * @fileoverview Boundary-vintage guidance for a named code the data tools found no row for: a
 * vintage drawn on earlier tracts than the 2020 ones census_resolve_geography returns, and
 * Connecticut's switch from eight counties to nine planning regions in the 2022 vintages.
 * @module mcp-server/tools/boundary-vintage
 */

/** The levels drawn on census tracts: a tract, and the block groups and blocks inside one. */
const TRACT_LEVELS = new Set(['tract', 'block group', 'block']);

/** Connecticut's state FIPS — the one state whose county codes changed between vintages. */
export const CONNECTICUT = '09';

const LIST = new Intl.ListFormat('en', { type: 'conjunction' });

/**
 * The decennial census whose tracts a vintage publishes, for a vintage drawn on tracts older than
 * the 2020 ones: 2000 tracts through 2009 (acs/acs5 2009, dec/pl 2000), 2010 tracts through 2019.
 * Every registered dataset that publishes a tract-level geography follows this rule.
 */
function tractCensus(year: number): 2000 | 2010 | undefined {
  if (year < 2010) return 2000;
  if (year < 2020) return 2010;
  return;
}

/**
 * Which of Connecticut's two county schemes a code belongs to: the eight counties every vintage
 * through 2021 publishes (001–015), or the nine planning regions every vintage from 2022 publishes
 * in their place (110–190). A code in neither range names no Connecticut county at all.
 */
function connecticutScheme(code: string): 'counties' | 'regions' | undefined {
  if (!/^\d{3}$/.test(code)) return;
  const n = Number(code);
  if (n >= 1 && n <= 15) return 'counties';
  if (n >= 110 && n <= 190) return 'regions';
  return;
}

/** The data tool a hint is written for, which decides the inputs its steps name. */
export type BoundaryTool = 'census_query_data' | 'census_compare_geographies';

/**
 * Word the boundary change behind a named code that found no row, as one possible cause beside a
 * wrong code — never a diagnosis from the empty result alone. Two changes are covered:
 *
 * - A tract-drawn level (tract, block group, block) on a vintage before 2020, when the call names
 *   a tract: the vintage publishes 2000 or 2010 tracts, and the resolver's tract codes are 2020 ones.
 *   A call that names no tract (a tract-level `"*"`) has nothing to mistake.
 * - A Connecticut county code in the scheme the vintage does not publish: a planning region on a
 *   vintage through 2021, or a pre-2022 county on one from 2022. Tracts and county subdivisions kept
 *   their codes across the change, so the step for those levels lists them by `"*"` county.
 *
 * `literals` are the values the text quotes for the caller to send back, for an error's `literals`.
 */
export function describeBoundaryChange(call: {
  tool: BoundaryTool;
  dataset: string;
  year: number;
  level: string;
  /** The call names a tract: a tract code, a `tract_fips`, or a `geographies` entry carrying one. */
  namesTract: boolean;
  /** County codes the call names in Connecticut, in either scheme. */
  connecticutCounties: readonly string[];
}): { text: string; literals: string[] } | undefined {
  const { tool, dataset, year, level } = call;
  const query = tool === 'census_query_data';
  const sentences: string[] = [];
  const literals = new Set<string>();

  const census = tractCensus(year);
  if (census && call.namesTract && TRACT_LEVELS.has(level)) {
    const within = level === 'tract' ? '' : `, along with its ${level}s`;
    sentences.push(
      `${dataset} (${year}) publishes census tracts as drawn for the ${census} Census, not the 2020 tracts census_resolve_geography returns — the 2020 Census split, merged, or renumbered many of them, so a 2020 tract code can be missing here${within}.`,
      query
        ? 'geography_fips "*" at geography_level "tract", with the same parent_fips and county_fips, lists the tracts this vintage publishes.'
        : `Omitting geographies, with the same within and within_county, lists every ${level} this vintage publishes, each GEOID carrying its tract.`,
    );
    if (query) literals.add('*');
  }

  const published = year <= 2021 ? 'counties' : 'regions';
  const otherScheme = [...new Set(call.connecticutCounties)].filter((code) => {
    const scheme = connecticutScheme(code);
    return scheme !== undefined && scheme !== published;
  });
  if (otherScheme.length > 0) {
    const subject =
      otherScheme.length === 1
        ? `Connecticut's county ${otherScheme[0]} is`
        : `Connecticut's counties ${LIST.format(otherScheme)} are`;
    sentences.push(
      published === 'counties'
        ? `${subject} among the nine planning regions (110–190) that vintages from 2022 publish; ${dataset} (${year}) publishes the eight counties from before 2022 (001–015) in their place.`
        : `${subject} among the eight counties from before 2022 (001–015); ${dataset} (${year}) publishes the nine planning regions (110–190) that replaced them.`,
    );
    if (level === 'county') {
      sentences.push(
        query
          ? 'geography_fips "*" at the county level with parent_fips "09" lists them.'
          : 'Omitting geographies at the county level with within "09" lists them.',
      );
      if (query) literals.add('*');
    } else {
      sentences.push(
        query
          ? 'Tracts and county subdivisions kept their codes and changed only county: at either level, geography_fips "*" with county_fips "*" and parent_fips "09" lists each under the county this vintage publishes it in.'
          : 'Tracts and county subdivisions kept their codes and changed only county: within_county "*" with within "09", and no geographies, lists each under the county this vintage publishes it in.',
      );
      literals.add('*');
    }
    literals.add(CONNECTICUT);
  }

  if (sentences.length === 0) return;
  return { text: sentences.join(' '), literals: [...literals] };
}
