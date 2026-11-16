/**
 * @fileoverview Tool to resolve place names and addresses to Census FIPS identifiers.
 * @module mcp-server/tools/definitions/census-resolve-geography
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { CONNECTICUT } from '@/mcp-server/tools/boundary-vintage.js';
import { renderNotice } from '@/mcp-server/tools/notice-trailer.js';
import { getGeographyService } from '@/services/geography/geography-service.js';
import {
  GEOGRAPHY_TYPES,
  type NamesakeCheck,
  type ResolvedGeography,
} from '@/services/geography/types.js';

/** The governing county subdivisions that share the input's name, or that the check did not run. */
function namesakeNotice(check: NamesakeCheck): string {
  switch (check.kind) {
    case 'unavailable':
      return 'Whether a county subdivision with its own government shares this name could not be checked, because TIGERweb did not answer; geography_type "county subdivision" resolves one directly.';
    case 'found': {
      const listed = check.subdivisions.map(
        (s) => `${s.name} (county ${s.countyFips}, county subdivision ${s.countySubdivisionFips})`,
      );
      return listed.length === 1
        ? `${listed[0]} shares this name and has its own government: resolve it with geography_type "county subdivision".`
        : `${listed.length} county subdivisions with their own governments share this name — ${listed.join(', ')}: resolve one with geography_type "county subdivision" and its county_fips.`;
    }
  }
}

/**
 * The vintages a resolved tract is published in. TIGERweb's current tract layer and the Census
 * Geocoder both return 2020 tracts, which ACS 5-year 2009–2019 and the 2000 and 2010 Census files
 * predate; in Connecticut the tract also carries the planning region it sits in, which vintages
 * through 2021 do not publish, though the tract code itself is the same there.
 */
function tractNotice({ tractFips, stateFips, countyFips }: ResolvedGeography): string {
  const tract = `Tract ${tractFips} is a 2020 census tract: ACS 5-year vintages from 2020 and the 2020 Census files publish it and its block groups, while earlier vintages publish earlier tracts — 2010 tracts, or 2000 tracts on acs/acs5 2009 and dec/pl 2000 — where this code can be missing.`;
  if (stateFips !== CONNECTICUT) return tract;
  return `${tract} In Connecticut it sits under its planning region, county ${countyFips}, which vintages from 2022 publish; vintages through 2021, the 2020 Census included, publish the same tract code under one of the eight counties from before 2022 (001–015) — census_query_data at the tract level with geography_fips "*", county_fips "*", and parent_fips "09" lists each under its county there.`;
}

/**
 * Every note a resolved geography carries beyond its fields, in the order they read: a borough
 * mapped to its county, the same-named subdivision check, a Connecticut county from before 2022,
 * the vintages a tract is published in.
 */
function noticesFor(resolved: ResolvedGeography): string[] {
  const notices: string[] = [];
  if (resolved.borough) {
    notices.push(
      `"${resolved.borough}" is the New York City borough coextensive with ${resolved.name}.`,
    );
  }
  if (resolved.namesakes) notices.push(namesakeNotice(resolved.namesakes));
  if (resolved.legacyCounty) {
    notices.push(
      `${resolved.name} (county ${resolved.countyFips}) is one of Connecticut's eight counties before 2022: every dataset vintage through 2021, the 2020 Census included, publishes it, and vintages from 2022 publish the nine planning regions (counties 110–190) in its place.`,
    );
  }
  if (resolved.tractFips) notices.push(tractNotice(resolved));
  return notices;
}

export const censusResolveGeography = tool('census_resolve_geography', {
  title: 'Resolve Census Geography',
  description:
    'Resolve a place name, ZIP code, or street address to Census FIPS identifiers. Converts names like "King County, WA", "Seattle, WA", or "Seattle-Tacoma-Bellevue, WA", and ZIPs like "98109", to the codes required by census_query_data and census_compare_geographies. Use before querying when you have a place name rather than raw FIPS codes — state_fips maps to parent_fips and fips_summary maps to geography_fips in downstream tools, and geography_type is itself the geography_level to query at.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    name: z
      .string()
      .describe(
        'Place name (e.g., "King County, WA", "Seattle, WA", "California"), 5-digit ZIP code (e.g., "98109", resolved to its ZIP Code Tabulation Area), or street address of at most 100 characters (e.g., "1600 Pennsylvania Ave NW, Washington, DC 20500"). Include the state after a comma — its abbreviation or full name, as in "Chatham County, Georgia" — to disambiguate places with common names. It narrows a statistical area as well, matching any state the area spans, so "Kansas City, MO" and "Kansas City, KS" both reach the MO-KS metro area. Matching ignores case, reads "Saint" and "St." as the same word, and accepts unaccented spellings ("Dona Ana County, NM"). For a statistical area a leading city is enough ("Denver, CO" for the Denver-Aurora-Centennial metro area), and an older full name resolves through its leading city ("Denver-Aurora-Lakewood, CO"). A New York City borough with a New York suffix resolves to the county it is coextensive with when geography_type is "county" or omitted — "Brooklyn, NY" is Kings County, "Manhattan, NY" New York County, "Staten Island, NY" Richmond County. At county subdivision it is the borough\'s own subdivision; at any other level it is no_match, and at place, economic place, state, tract, or consolidated city the hint names the county. In the twelve states whose towns and townships are local governments, a town or township resolves to its county subdivision ("Cherry Hill, NJ", "Greenwich, CT"), and a trailing "Township" also reaches a Michigan charter township ("Clinton Township, MI"). "Fairfield County, CT" — or "Fairfield, CT" at geography_type "county" — resolves to Connecticut\'s county 001 from before 2022, which every vintage through 2021 publishes; the other seven of those eight counties resolve the same way.',
      ),
    geography_type: z
      .enum(GEOGRAPHY_TYPES)
      .optional()
      .describe(
        'Geography level to resolve to, named exactly as census_query_data\'s geography_level and census_list_geographies name it. Auto-detection covers only state, county, county subdivision, place, tract, and zip code tabulation area: zip code tabulation area for a 5-digit ZIP or ZIP+4 — the ACS\'s ZIP-shaped area, not cbp\'s "zip code" level, which takes the ZIP itself with no resolution — state for a two-letter abbreviation or a spelled-out state name, county when the name contains the word "County" or "Parish", county then place for the word "Borough" (an Alaska borough is a county, a PA or NJ borough a place), tract for the word "Tract", otherwise place (incorporated places and census-designated places together) with a fallback to county, where a census-designated place answers only when no incorporated place or county has the exact name — "Arlington, VA" is Arlington County, and set "place" to reach the Arlington CDP. When the state suffix is one of the twelve states whose towns and townships are local governments (CT, ME, MA, MI, MN, NH, NJ, NY, PA, RI, VT, WI), county subdivision follows county in that chain: a town or township named exactly the input outranks a CDP of that name and a place that only contains it ("Cherry Hill, NJ" is Cherry Hill township, not Cherry Hill Mall CDP), while a county named exactly it still answers ("Plymouth, MA" is Plymouth County, and the notice names Plymouth town). Elsewhere a county subdivision is a statistical census county division or an inactive township and is never auto-detected; set "county subdivision" to resolve one in any state. The other four are never auto-detected and must be set explicitly, because their names overlap city names — "metropolitan statistical area/micropolitan statistical area" covers both metro and micro areas and yields a 5-digit code, "combined statistical area" yields a 3-digit code, "consolidated city" covers the eight merged city-county governments (Nashville-Davidson, Louisville/Jefferson County, Indianapolis, Athens-Clarke County, Augusta-Richmond County, Butte-Silver Bow, Milford CT, Greeley County KS), and "economic place" yields the 8-digit code ecnbasic 2022 publishes a place under: the 3-digit county it lies in (000 when it spans counties) followed by its 5-digit place code. Economic places are the incorporated places, census-designated places, and county subdivisions the 2022 Economic Census tabulates, plus each county\'s remainder ("Balance of Adams County, WA"). Setting it explicitly also overrides auto-detection — "New York" auto-detects as the state, so New York City needs "place".',
      ),
    county_fips: z
      .string()
      .regex(/^\d{1,3}$/)
      .optional()
      .describe(
        "County FIPS code to resolve within — 1 to 3 digits, zero-padded here to the 3 the Census stores. A tract name is unique only inside its county, and a town or township name can repeat across a state's counties, so a name matching two counties comes back as ambiguous_name until this is set: take the countyFips of the candidate you want from that error and re-call. Only county, county subdivision, and tract sit within a county, so this restricts resolution to those three levels — pairing it with any other geography_type, or with a street address, is a county_scope_unsupported error rather than a scope quietly dropped. census_query_data takes the same code as its own county_fips.",
      ),
  }),
  output: z.object({
    name: z.string().describe('Canonical name of the resolved geography.'),
    geography_type: z
      .string()
      .describe(
        'Resolved geography level. Pass this straight through as geography_level in census_query_data and census_compare_geographies.',
      ),
    state_fips: z
      .string()
      .optional()
      .describe(
        '2-digit state FIPS code. Use as parent_fips in census_query_data for sub-state queries. Absent for a metropolitan/micropolitan or combined statistical area, which can span several states and needs no parent_fips, and for a zip code tabulation area, whose source layer carries no state.',
      ),
    county_fips: z
      .string()
      .optional()
      .describe(
        '3-digit county FIPS code when the resolved geography is a county or sub-county level.',
      ),
    county_subdivision_fips: z
      .string()
      .optional()
      .describe(
        '5-digit county subdivision FIPS code: the resolved town, township, or other county subdivision (the same code as fips_summary), or for a street address the county subdivision the address sits in — query it at geography_level "county subdivision" with this as geography_fips, state_fips as parent_fips, and county_fips. A Connecticut subdivision carries its planning-region county (110–190), the one vintages from 2022 publish it under; vintages through 2021 publish it under the county from before 2022.',
      ),
    tract_fips: z
      .string()
      .optional()
      .describe(
        '6-digit census tract FIPS code when the resolved geography is a tract — from a street address, or from a tract name. It is a 2020 census tract, which ACS 5-year vintages from 2020 and the 2020 Census files publish; earlier vintages publish earlier tracts, where the code can be missing, and the notice says so.',
      ),
    block_group_fips: z
      .string()
      .optional()
      .describe(
        '1-digit block group within tract_fips, for a street address only. Query it as geography_level "block group" with this as geography_fips, alongside parent_fips, county_fips, and tract_fips. geography_type and fips_summary stay at the tract.',
      ),
    place_fips: z
      .string()
      .optional()
      .describe(
        '5-digit place FIPS code when the resolved geography is a place — incorporated or census-designated. For an economic place, the place part of its 8-digit code, which is also the place code the 2017 and 2012 ecnbasic vintages take. For a street address, the incorporated place the address sits in (query it at the place level with state_fips as parent_fips); absent when the address is outside every incorporated place, and a census-designated place is never reported for an address.',
      ),
    census_designated_place: z
      .literal(true)
      .optional()
      .describe(
        "Present (true) when the resolved place or economic place is a census-designated place (CDP): an unincorporated community the Census delineates for statistics, with no municipal government. Its code is queried like an incorporated place's. Absent for an incorporated place and every other level.",
      ),
    fips_summary: z
      .string()
      .describe(
        'Pre-formatted FIPS value ready to use as geography_fips in census_query_data (e.g., "033" for King County with state_fips "53" as parent_fips, "42660" for the Seattle-Tacoma-Bellevue metro area with no parent at all, "03363000" for Seattle as an ecnbasic 2022 economic place).',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Present when the result needs context its fields cannot carry: a New York City borough ("Brooklyn", "The Bronx", "Queens borough") resolved to the county it is coextensive with; a county subdivision with its own government named exactly the input — beside a county auto-detected in one of the twelve town-and-township states, or a census-designated place resolved at geography_type "place" there — named with its county and code, or a statement that the check could not run; a Connecticut county from before 2022, which vintages through 2021 publish in place of the planning regions; or a census tract, which is a 2020 tract that earlier vintages, drawn on earlier tracts, can lack — and in Connecticut sits under its planning region, where vintages through 2021 publish the same code under an earlier county.',
      ),
  },
  // The notice quotes place names and the "*" a tract listing takes.
  enrichmentTrailer: { notice: { render: renderNotice } },

  errors: [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'Place name not recognized at any geography level tried for it.',
      thrownBy: 'service',
      recovery:
        'Check the spelling, set geography_type to search a different level, or pass a full street address.',
    },
    {
      reason: 'ambiguous_name',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Name matched more than one geography.',
      thrownBy: 'service',
      recovery:
        'Take fips_summary from the candidate you want in the error, or re-call with the candidate name — tract and county subdivision candidates need county_fips instead, since they can share a name.',
    },
    {
      reason: 'county_scope_unsupported',
      code: JsonRpcErrorCode.ValidationError,
      when: 'county_fips was combined with a street address, or with a geography_type — set or auto-detected — that does not sit within a county.',
      thrownBy: 'service',
      recovery:
        'Drop county_fips, or set geography_type to "county", "county subdivision", or "tract" to use it.',
    },
    {
      reason: 'address_rejected',
      code: JsonRpcErrorCode.ValidationError,
      when: "The Census Geocoder rejected the street address as sent — one longer than 100 characters, for one — and the error carries the geocoder's own statement of why.",
      thrownBy: 'service',
      recovery:
        'Send a shorter or corrected address — house number, street, city, state, and ZIP code are enough — or resolve the city or county by name instead.',
    },
    {
      reason: 'resolution_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: "TIGERweb or the Census Geocoder failed with an HTTP error, could not be reached, or did not answer in time on every attempt or within the call's 50-second upstream budget, or answered with a page or an error in place of data.",
      retryable: true,
      thrownBy: 'service',
      recovery:
        'Retry the request; if it keeps failing, the Census geography service is temporarily unavailable.',
    },
  ],

  async handler(input, ctx) {
    if (!input.name.trim()) {
      throw validationError('Place name is required.', {
        recovery: {
          hint: 'Provide a city, county, state, or street address, such as "King County, WA" or "Washington".',
        },
      });
    }

    ctx.log.info('Resolving geography', {
      name: input.name,
      geographyType: input.geography_type,
      countyFips: input.county_fips,
    });

    const service = getGeographyService();
    const resolved = await service.resolveGeography(
      {
        name: input.name,
        ...(input.geography_type !== undefined && { geographyType: input.geography_type }),
        ...(input.county_fips !== undefined && { countyFips: input.county_fips }),
      },
      ctx,
    );

    // The notice field holds one string, so every note the result carries is joined into it.
    const notices = noticesFor(resolved);
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      name: resolved.name,
      geography_type: resolved.geographyType,
      ...(resolved.stateFips && { state_fips: resolved.stateFips }),
      ...(resolved.countyFips && { county_fips: resolved.countyFips }),
      ...(resolved.countySubdivisionFips && {
        county_subdivision_fips: resolved.countySubdivisionFips,
      }),
      ...(resolved.tractFips && { tract_fips: resolved.tractFips }),
      ...(resolved.blockGroupFips && { block_group_fips: resolved.blockGroupFips }),
      ...(resolved.placeFips && { place_fips: resolved.placeFips }),
      ...(resolved.censusDesignatedPlace && { census_designated_place: true as const }),
      fips_summary: resolved.fipsSummary,
    };
  },

  format: (result) => {
    const isTractLevel = result.geography_type === 'tract';
    const lines: string[] = [
      `## Resolved: ${result.name}`,
      `**Type:** ${result.geography_type} — use as \`geography_level\` in census_query_data`,
    ];

    if (result.state_fips) {
      lines.push(
        `**State FIPS:** \`${result.state_fips}\` — use as \`parent_fips\` in census_query_data`,
      );
    } else if (result.geography_type === 'zip code tabulation area') {
      lines.push(
        "**Parent:** none on acs/acs5 and acs/acs5/profile from 2020, or acs/acs5/subject from 2019. Earlier ACS 5-year vintages (2011 on) need `parent_fips` set to the ZCTA's state, which this result does not carry. A ZCTA is not cbp's `zip code` level — cbp takes the ZIP itself.",
      );
    } else {
      lines.push('**Parent:** none — this level is queried without `parent_fips`');
    }

    lines.push(
      `**Geography FIPS:** \`${result.fips_summary}\` — use as \`geography_fips\` in census_query_data`,
    );

    if (result.geography_type === 'economic place') {
      const county = result.fips_summary.slice(0, 3);
      const countyPart =
        county === '000'
          ? 'county `000` (the place spans more than one county)'
          : `county \`${county}\``;
      lines.push(
        `**Economic place code:** ${countyPart} + place \`${result.fips_summary.slice(3)}\` — ecnbasic 2022 only; the 2017 and 2012 vintages publish \`place\` instead, keyed by \`place_fips\``,
      );
    }

    const isSubdivisionLevel = result.geography_type === 'county subdivision';
    if (result.county_fips) {
      const countyNote = isTractLevel
        ? ` — also use as \`county_fips\` in census_query_data for tract-level queries`
        : isSubdivisionLevel
          ? ` — also use as \`county_fips\` in census_query_data for county subdivision queries`
          : '';
      lines.push(`**County FIPS:** \`${result.county_fips}\`${countyNote}`);
    }
    if (result.county_subdivision_fips) {
      // A resolved subdivision is queried by fips_summary already; an address's is a second level.
      const usage = isSubdivisionLevel
        ? ''
        : ' — use as `geography_fips` at `geography_level` "county subdivision" in census_query_data, with the state and county';
      lines.push(`**County subdivision FIPS:** \`${result.county_subdivision_fips}\`${usage}`);
    }
    if (result.tract_fips) lines.push(`**Tract FIPS:** \`${result.tract_fips}\``);
    if (result.block_group_fips) {
      lines.push(
        `**Block group FIPS:** \`${result.block_group_fips}\` — use as \`geography_fips\` at \`geography_level\` "block group" in census_query_data, with \`tract_fips\` \`${result.tract_fips}\` alongside the state and county`,
      );
    }
    if (result.place_fips) lines.push(`**Place FIPS:** \`${result.place_fips}\``);
    if (result.census_designated_place) {
      lines.push(
        "**Place kind:** census-designated place (CDP) — an unincorporated community delineated for statistics, with no municipal government; its code is queried like an incorporated place's",
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
