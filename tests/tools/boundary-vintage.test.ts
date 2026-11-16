/**
 * @fileoverview The boundary-vintage table, tabled once at its own seam: which vintages are drawn on
 * earlier tracts than census_resolve_geography's, and which Connecticut county codes each vintage
 * publishes. The data tools' tests prove only the wiring.
 * @module tests/tools/boundary-vintage.test
 */

import { describe, expect, it } from 'vitest';
import { describeBoundaryChange } from '@/mcp-server/tools/boundary-vintage.js';

type Call = Parameters<typeof describeBoundaryChange>[0];

const call = (overrides: Partial<Call>): Call => ({
  tool: 'census_query_data',
  dataset: 'acs/acs5',
  year: 2019,
  level: 'tract',
  namesTract: true,
  connecticutCounties: [],
  ...overrides,
});

describe('describeBoundaryChange — the tracts a vintage is drawn on', () => {
  it.each([
    [2009, 2000],
    [2010, 2010],
    [2015, 2010],
    [2019, 2010],
  ])('names the %i vintage as %i tracts', (year, census) => {
    const result = describeBoundaryChange(call({ year }));

    expect(result?.text).toContain(
      `acs/acs5 (${year}) publishes census tracts as drawn for the ${census} Census, not the 2020 tracts census_resolve_geography returns`,
    );
    expect(result?.literals).toEqual(['*']);
  });

  it('names dec/pl 2000 as 2000 tracts and dec/pl 2010 as 2010 tracts', () => {
    expect(describeBoundaryChange(call({ dataset: 'dec/pl', year: 2000 }))?.text).toContain(
      'dec/pl (2000) publishes census tracts as drawn for the 2000 Census',
    );
    expect(
      describeBoundaryChange(call({ dataset: 'dec/pl', year: 2010, level: 'block' }))?.text,
    ).toContain('dec/pl (2010) publishes census tracts as drawn for the 2010 Census');
  });

  it.each([2020, 2021, 2024])('says nothing for a %i vintage, drawn on 2020 tracts', (year) => {
    expect(describeBoundaryChange(call({ year }))).toBeUndefined();
  });

  it('says nothing when the call names no tract', () => {
    expect(describeBoundaryChange(call({ namesTract: false }))).toBeUndefined();
  });

  it.each(['county', 'place', 'county subdivision', 'zip code tabulation area'])(
    'says nothing at the %s level, which is not drawn on tracts',
    (level) => {
      expect(describeBoundaryChange(call({ level }))).toBeUndefined();
    },
  );

  it.each([
    ['tract', 'so a 2020 tract code can be missing here.'],
    ['block group', 'so a 2020 tract code can be missing here, along with its block groups.'],
    ['block', 'so a 2020 tract code can be missing here, along with its blocks.'],
  ])('carries a %s with its tract', (level, ending) => {
    expect(describeBoundaryChange(call({ level }))?.text).toContain(ending);
  });

  it('points each tool at its own listing of the vintage', () => {
    expect(describeBoundaryChange(call({}))?.text).toContain(
      'geography_fips "*" at geography_level "tract", with the same parent_fips and county_fips, lists the tracts this vintage publishes.',
    );
    expect(
      describeBoundaryChange(call({ tool: 'census_compare_geographies', level: 'block group' }))
        ?.text,
    ).toContain(
      'Omitting geographies, with the same within and within_county, lists every block group this vintage publishes, each GEOID carrying its tract.',
    );
  });
});

describe("describeBoundaryChange — Connecticut's two county schemes", () => {
  const ct = (
    year: number,
    codes: string[],
    level = 'county',
    tool: Call['tool'] = 'census_query_data',
  ) =>
    describeBoundaryChange(
      call({ year, level, tool, namesTract: false, connecticutCounties: codes }),
    );

  it.each([
    [2021, '110'],
    [2021, '190'],
    [2020, '150'],
    [2010, '190'],
  ])('names a planning region on %i as one the 2022 vintages publish', (year, code) => {
    expect(ct(year, [code])?.text).toBe(
      `Connecticut's county ${code} is among the nine planning regions (110–190) that vintages from 2022 publish; acs/acs5 (${year}) publishes the eight counties from before 2022 (001–015) in their place. geography_fips "*" at the county level with parent_fips "09" lists them.`,
    );
  });

  it.each([
    [2022, '001'],
    [2022, '015'],
    [2024, '009'],
  ])('names a pre-2022 county on %i as one the planning regions replaced', (year, code) => {
    expect(ct(year, [code])?.text).toBe(
      `Connecticut's county ${code} is among the eight counties from before 2022 (001–015); acs/acs5 (${year}) publishes the nine planning regions (110–190) that replaced them. geography_fips "*" at the county level with parent_fips "09" lists them.`,
    );
  });

  it.each([
    [2021, '001'],
    [2021, '015'],
    [2022, '110'],
    [2022, '190'],
  ])('says nothing for a code in the scheme %i publishes (%s)', (year, code) => {
    expect(ct(year, [code])).toBeUndefined();
  });

  it.each(['000', '016', '100', '109', '191', '510', '*', '19'])(
    'says nothing for %j, which names no Connecticut county in either scheme',
    (code) => {
      expect(ct(2021, [code])).toBeUndefined();
      expect(ct(2022, [code])).toBeUndefined();
    },
  );

  it('names every code of the other scheme once, and none of the scheme the vintage publishes', () => {
    expect(ct(2021, ['190', '001', '110', '190'])?.text).toMatch(
      /^Connecticut's counties 190 and 110 are among the nine planning regions/,
    );
  });

  it('lists tracts and subdivisions by a "*" county below the county level, on each tool', () => {
    expect(ct(2021, ['190'], 'tract')?.text).toContain(
      'Tracts and county subdivisions kept their codes and changed only county: at either level, geography_fips "*" with county_fips "*" and parent_fips "09" lists each under the county this vintage publishes it in.',
    );
    expect(ct(2022, ['001'], 'tract', 'census_compare_geographies')?.text).toContain(
      'Tracts and county subdivisions kept their codes and changed only county: within_county "*" with within "09", and no geographies, lists each under the county this vintage publishes it in.',
    );
    expect(ct(2021, ['190'], 'county', 'census_compare_geographies')?.text).toContain(
      'Omitting geographies at the county level with within "09" lists them.',
    );
  });

  it('hands back exactly the values each text quotes to send', () => {
    expect(ct(2021, ['190'])?.literals).toEqual(['*', '09']);
    expect(ct(2021, ['190'], 'tract', 'census_compare_geographies')?.literals).toEqual(['*', '09']);
    expect(ct(2021, ['190'], 'county', 'census_compare_geographies')?.literals).toEqual(['09']);
    expect(describeBoundaryChange(call({ tool: 'census_compare_geographies' }))?.literals).toEqual(
      [],
    );
  });

  it('carries both changes when a pre-2020 tract call names a planning region', () => {
    const result = describeBoundaryChange(
      call({ year: 2019, level: 'tract', namesTract: true, connecticutCounties: ['190'] }),
    );

    expect(result?.text).toMatch(
      /^acs\/acs5 \(2019\) publishes census tracts as drawn for the 2010/,
    );
    expect(result?.text).toContain("Connecticut's county 190 is among the nine planning regions");
    expect(result?.literals).toEqual(['*', '09']);
  });
});
