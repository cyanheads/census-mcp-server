/**
 * @fileoverview Tool to resolve place names and addresses to Census FIPS identifiers.
 * @module mcp-server/tools/definitions/census-resolve-geography
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { getGeographyService } from '@/services/geography/geography-service.js';

export const censusResolveGeography = tool('census_resolve_geography', {
  title: 'Resolve Census Geography',
  description:
    'Resolve a place name or street address to Census FIPS identifiers (state, county, tract codes). Converts names like "King County, WA" or "Seattle, WA" to the FIPS codes required by census_query_data and census_compare_geographies. Use before querying when you have a place name rather than raw FIPS codes — state_fips maps to parent_fips and fips_summary maps to geography_fips in downstream tools.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    name: z
      .string()
      .describe(
        'Place name (e.g., "King County, WA", "Seattle, WA", "California") or street address (e.g., "1600 Pennsylvania Ave NW, Washington, DC 20500"). Include the state abbreviation to disambiguate places with common names.',
      ),
    geography_type: z
      .enum(['state', 'county', 'place', 'tract'])
      .optional()
      .describe(
        'Expected geography type to resolve to. Optional — auto-detected from the name when omitted (county if "County"/"Borough"/"Parish" appears, state for two-letter abbreviations).',
      ),
  }),
  output: z.object({
    name: z.string().describe('Canonical name of the resolved geography.'),
    geography_type: z
      .string()
      .describe('Resolved geography type (state, county, place, or tract).'),
    state_fips: z
      .string()
      .describe(
        '2-digit state FIPS code. Use as parent_fips in census_query_data for sub-state queries.',
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
      .describe('6-digit census tract FIPS code when resolved from a street address.'),
    place_fips: z
      .string()
      .optional()
      .describe('Place FIPS code when the resolved geography is an incorporated place.'),
    fips_summary: z
      .string()
      .describe(
        'Pre-formatted FIPS value ready to use as geography_fips in census_query_data (e.g., "033" for King County with state_fips "53" as parent_fips).',
      ),
  }),

  errors: [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'Place name not recognized or no matching geography found.',
      recovery:
        'Include the state abbreviation (e.g., "King County, WA"), use a full address, or verify the spelling.',
    },
    {
      reason: 'ambiguous_name',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Name matched multiple geographies across different states.',
      recovery:
        'Re-call with a more specific name that includes the state abbreviation or full state name.',
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

    ctx.log.info('Resolving geography', { name: input.name, geographyType: input.geography_type });

    const service = getGeographyService();
    const resolved = await service.resolveGeography(input.name, input.geography_type, ctx);

    return {
      name: resolved.name,
      geography_type: resolved.geographyType,
      state_fips: resolved.stateFips,
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
      `**Type:** ${result.geography_type}`,
      `**State FIPS:** \`${result.state_fips}\` — use as \`parent_fips\` in census_query_data`,
      `**Geography FIPS:** \`${result.fips_summary}\` — use as \`geography_fips\` in census_query_data`,
    ];

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
