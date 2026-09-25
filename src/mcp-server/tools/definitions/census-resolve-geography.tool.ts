/**
 * @fileoverview Tool to resolve place names and addresses to Census FIPS identifiers.
 * @module mcp-server/tools/definitions/census-resolve-geography
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { getGeographyService } from '@/services/geography/geography-service.js';
import { GEOGRAPHY_TYPES } from '@/services/geography/types.js';

export const censusResolveGeography = tool('census_resolve_geography', {
  title: 'Resolve Census Geography',
  description:
    'Resolve a place name, ZIP code, or street address to Census FIPS identifiers. Converts names like "King County, WA", "Seattle, WA", or "Seattle-Tacoma-Bellevue, WA", and ZIPs like "98109", to the codes required by census_query_data and census_compare_geographies. Use before querying when you have a place name rather than raw FIPS codes — state_fips maps to parent_fips and fips_summary maps to geography_fips in downstream tools, and geography_type is itself the geography_level to query at.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    name: z
      .string()
      .describe(
        'Place name (e.g., "King County, WA", "Seattle, WA", "California"), 5-digit ZIP code (e.g., "98109", resolved to its ZIP Code Tabulation Area), or street address (e.g., "1600 Pennsylvania Ave NW, Washington, DC 20500"). Include the state after a comma — its abbreviation or full name, as in "Chatham County, Georgia" — to disambiguate places with common names. It narrows a statistical area as well, matching any state the area spans, so "Kansas City, MO" and "Kansas City, KS" both reach the MO-KS metro area. Matching ignores case, reads "Saint" and "St." as the same word, and accepts unaccented spellings ("Dona Ana County, NM"). For a statistical area a leading city is enough ("Denver, CO" for the Denver-Aurora-Centennial metro area), and an older full name resolves through its leading city ("Denver-Aurora-Lakewood, CO").',
      ),
    geography_type: z
      .enum(GEOGRAPHY_TYPES)
      .optional()
      .describe(
        'Geography level to resolve to, named exactly as census_query_data\'s geography_level and census_list_geographies name it. Auto-detection covers only state, county, place, tract, and zip code tabulation area: zip code tabulation area for a 5-digit ZIP or ZIP+4 — the ACS\'s ZIP-shaped area, not cbp\'s "zip code" level, which takes the ZIP itself with no resolution — state for a two-letter abbreviation or a spelled-out state name, county when the name contains the word "County" or "Parish", county then place for the word "Borough" (an Alaska borough is a county, a PA or NJ borough a place), tract for the word "Tract", otherwise place (incorporated places and census-designated places together) with a fallback to county, where a census-designated place answers only when no incorporated place or county has the exact name — "Arlington, VA" is Arlington County, and set "place" to reach the Arlington CDP. The other four are never auto-detected and must be set explicitly, because their names overlap city names — "metropolitan statistical area/micropolitan statistical area" covers both metro and micro areas and yields a 5-digit code, "combined statistical area" yields a 3-digit code, "consolidated city" covers the eight merged city-county governments (Nashville-Davidson, Louisville/Jefferson County, Indianapolis, Athens-Clarke County, Augusta-Richmond County, Butte-Silver Bow, Milford CT, Greeley County KS), and "economic place" yields the 8-digit code ecnbasic 2022 publishes a place under: the 3-digit county it lies in (000 when it spans counties) followed by its 5-digit place code. Economic places are the incorporated places, census-designated places, and county subdivisions the 2022 Economic Census tabulates, plus each county\'s remainder ("Balance of Adams County, WA"). Setting it explicitly also overrides auto-detection — "New York" auto-detects as the state, so New York City needs "place".',
      ),
    county_fips: z
      .string()
      .regex(/^\d{1,3}$/)
      .optional()
      .describe(
        'County FIPS code to resolve within — 1 to 3 digits, zero-padded here to the 3 the Census stores. A tract name is unique only inside its county, so a bare tract name matching two counties comes back as ambiguous_name until this is set: take the countyFips of the candidate you want from that error and re-call. Only county and tract sit within a county, so this restricts resolution to those two levels — pairing it with any other geography_type, or with a street address, is a county_scope_unsupported error rather than a scope quietly dropped. census_query_data takes the same code as its own county_fips but pads nothing, so hand it the 3-digit county_fips returned here, not the shorter value.',
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
    tract_fips: z
      .string()
      .optional()
      .describe(
        '6-digit census tract FIPS code when the resolved geography is a tract — from a street address, or from a tract name.',
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
        'Take fips_summary from the candidate you want in the error, or re-call with the candidate name — tract candidates need county_fips instead, since they share a name.',
    },
    {
      reason: 'county_scope_unsupported',
      code: JsonRpcErrorCode.ValidationError,
      when: 'county_fips was combined with a street address, or with a geography_type — set or auto-detected — that does not sit within a county.',
      thrownBy: 'service',
      recovery: 'Drop county_fips, or set geography_type to "county" or "tract" to use it.',
    },
    {
      reason: 'resolution_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Geography resolution endpoint was unreachable.',
      retryable: true,
      thrownBy: 'service',
      recovery:
        'Retry the request — the Census geography endpoints are free-tier with no auth requirements.',
    },
  ],

  async handler(input, ctx) {
    if (!input.name.trim()) {
      throw validationError(
        'Place name is required — provide a city, county, state, or street address.',
        {
          recovery: { hint: 'Provide a non-empty name such as "King County, WA" or "Washington".' },
        },
      );
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

    return {
      name: resolved.name,
      geography_type: resolved.geographyType,
      ...(resolved.stateFips && { state_fips: resolved.stateFips }),
      ...(resolved.countyFips && { county_fips: resolved.countyFips }),
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

    if (result.county_fips) {
      const countyNote = isTractLevel
        ? ` — also use as \`county_fips\` in census_query_data for tract-level queries`
        : '';
      lines.push(`**County FIPS:** \`${result.county_fips}\`${countyNote}`);
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
