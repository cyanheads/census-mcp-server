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
    'Resolve a place name or street address to Census FIPS identifiers. Converts names like "King County, WA", "Seattle, WA", or "Seattle-Tacoma-Bellevue, WA" to the codes required by census_query_data and census_compare_geographies. Use before querying when you have a place name rather than raw FIPS codes — state_fips maps to parent_fips and fips_summary maps to geography_fips in downstream tools, and geography_type is itself the geography_level to query at.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    name: z
      .string()
      .describe(
        'Place name (e.g., "King County, WA", "Seattle, WA", "California") or street address (e.g., "1600 Pennsylvania Ave NW, Washington, DC 20500"). Include the state abbreviation to disambiguate places with common names — it narrows a statistical area as well, matching any state the area spans, so "Kansas City, MO" and "Kansas City, KS" both reach the MO-KS metro area. For a statistical area, the name is the full hyphenated one the Census publishes ("Seattle-Tacoma-Bellevue, WA" for the metro area, "Seattle-Tacoma, WA" for the combined one) — a single city name matches it too when only one area contains that city.',
      ),
    geography_type: z
      .enum(GEOGRAPHY_TYPES)
      .optional()
      .describe(
        'Geography level to resolve to, named exactly as census_query_data\'s geography_level and census_list_geographies name it. Auto-detection covers only state, county, place, and tract: state for a two-letter abbreviation or a spelled-out state name, county when the name contains "County"/"Borough"/"Parish", tract when it contains "Tract", otherwise place with a fallback to county. The other three are never auto-detected and must be set explicitly, because their names overlap city names — "metropolitan statistical area/micropolitan statistical area" covers both metro and micro areas and yields a 5-digit code, "combined statistical area" yields a 3-digit code, and "consolidated city" covers the eight merged city-county governments (Nashville-Davidson, Louisville/Jefferson County, Indianapolis, Athens-Clarke County, Augusta-Richmond County, Butte-Silver Bow, Milford CT, Greeley County KS). Setting it explicitly also overrides auto-detection — "New York" auto-detects as the state, so New York City needs "place".',
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
        '2-digit state FIPS code. Use as parent_fips in census_query_data for sub-state queries. Absent for a metropolitan/micropolitan or combined statistical area, which can span several states and needs no parent_fips.',
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
    place_fips: z
      .string()
      .optional()
      .describe('Place FIPS code when the resolved geography is an incorporated place.'),
    fips_summary: z
      .string()
      .describe(
        'Pre-formatted FIPS value ready to use as geography_fips in census_query_data (e.g., "033" for King County with state_fips "53" as parent_fips, "42660" for the Seattle-Tacoma-Bellevue metro area with no parent at all).',
      ),
  }),

  errors: [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'Place name not recognized at any geography level tried for it.',
      recovery:
        'Check the spelling, set geography_type to search a different level, or pass a full street address.',
    },
    {
      reason: 'ambiguous_name',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Name matched more than one geography.',
      recovery:
        'Take fips_summary from the candidate you want in the error, or re-call with the candidate name — tract candidates need county_fips instead, since they share a name.',
    },
    {
      reason: 'county_scope_unsupported',
      code: JsonRpcErrorCode.ValidationError,
      when: 'county_fips was combined with a street address, or with a geography_type — set or auto-detected — that does not sit within a county.',
      recovery: 'Drop county_fips, or set geography_type to "county" or "tract" to use it.',
    },
    {
      reason: 'resolution_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Geography resolution endpoint was unreachable.',
      retryable: true,
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
      ...(resolved.placeFips && { place_fips: resolved.placeFips }),
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
    } else {
      lines.push('**Parent:** none — this level is queried without `parent_fips`');
    }

    lines.push(
      `**Geography FIPS:** \`${result.fips_summary}\` — use as \`geography_fips\` in census_query_data`,
    );

    if (result.county_fips) {
      const countyNote = isTractLevel
        ? ` — also use as \`county_fips\` in census_query_data for tract-level queries`
        : '';
      lines.push(`**County FIPS:** \`${result.county_fips}\`${countyNote}`);
    }
    if (result.tract_fips) lines.push(`**Tract FIPS:** \`${result.tract_fips}\``);
    if (result.place_fips) lines.push(`**Place FIPS:** \`${result.place_fips}\``);

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
