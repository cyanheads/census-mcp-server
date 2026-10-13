/**
 * @fileoverview Tool to list geography levels available for a Census dataset and year.
 * @module mcp-server/tools/definitions/census-list-geographies
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getDiscoveryConfig } from '@/config/server-config.js';
import { getCensusApiService } from '@/services/census-api/census-api-service.js';
import { yearNotAvailable } from '@/services/census-api/errors.js';
import {
  DATASET_AVAILABLE_YEARS,
  DATASET_LATEST_YEARS,
  resolveDataset,
} from '@/services/variable-cache/variable-cache-service.js';

/**
 * Distinct `geography_level` values — the count the data tools' `geography_not_supported` message
 * gives. geography.json lists a level once per parent hierarchy (acs/acs5 2024: 65 entries, 43
 * levels), so the entry count would tell a caller a different total for the same dataset-year.
 */
const countLevels = (levels: ReadonlyArray<{ geography_level: string }>) =>
  new Set(levels.map((level) => level.geography_level)).size;

export const censusListGeographies = tool('census_list_geographies', {
  title: 'List Census Geography Levels',
  description:
    'List the geography levels available for a given Census dataset and year, along with the parent geographies each level requires. Use before querying to confirm that the target geography level exists — ACS1 omits many sub-state levels, and not all datasets support tracts or block groups. The geography_level values returned here are the valid inputs to the geography_level parameter in census_query_data and census_compare_geographies.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    dataset: z
      .string()
      .describe(
        'Dataset code (e.g., "acs/acs5", "acs/acs1"). Use census_list_datasets to discover valid values. Case is ignored, and a two-part code can be given by its last part alone — "acs5" is acs/acs5, "pl" is dec/pl. Three-part codes such as acs/acs5/profile must be given in full. The response echoes the resolved code.',
      ),
    year: z
      .number()
      .optional()
      .describe('Vintage year. Defaults to the latest available year for the dataset.'),
  }),
  output: z.object({
    geography_levels: z
      .array(
        z
          .object({
            geography_level: z
              .string()
              .describe(
                'Geography level name — the value to pass as geography_level in census_query_data (e.g., "county", "tract", "zip code tabulation area").',
              ),
            requires_parent: z
              .boolean()
              .describe(
                'Whether this level names any parent level. A parent is always mandatory for a concrete FIPS target; some levels drop their innermost parents when the target is "*", which is why a nationwide county query needs no parent_fips while a single county does.',
              ),
            required_parent_levels: z
              .array(z.string())
              .describe(
                'Names of the parent geography levels required when requires_parent is true.',
              ),
            example: z.string().describe('Example FIPS value for this geography level.'),
          })
          .describe('A single geography level available for this dataset.'),
      )
      .describe(
        'Geography levels supported by this dataset and year, one entry per parent hierarchy: a level published under several hierarchies (county under state, and under a metro area) appears once for each.',
      ),
  }),

  enrichment: {
    dataset: z.string().describe('Dataset queried.'),
    year: z.number().describe('Vintage year queried.'),
    totalLevels: z
      .number()
      .describe(
        'Distinct geography levels available for this dataset and year — the count census_query_data and census_compare_geographies give for an unsupported level. Can be lower than the number of geography_levels entries, which repeat a level per parent hierarchy.',
      ),
  },

  errors: [
    {
      reason: 'dataset_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Dataset code is missing or not recognized, even after case and shorthand resolution.',
      thrownBy: 'service',
      recovery: 'Call census_list_datasets to discover valid dataset codes like acs/acs5.',
    },
    {
      reason: 'year_not_available',
      code: JsonRpcErrorCode.ValidationError,
      when: "Dataset exists but the Census API publishes no geography list for the requested year. For a year outside the dataset's available_years, the error names the years it serves.",
      recovery: 'Check available_years in census_list_datasets for valid years for this dataset.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: "The Census API answered the dataset's geography.json with an HTTP error other than a 404, or with HTML or an unparseable body.",
      retryable: true,
      thrownBy: 'service',
      recovery:
        'Retry the request if the failure was transient; if the Census API rejected the request outright, retrying it unchanged returns the same status, so change the dataset or year.',
    },
  ],

  async handler(input, ctx) {
    const dataset = resolveDataset(input.dataset);
    const { defaultYear } = getDiscoveryConfig();
    const year = input.year ?? DATASET_LATEST_YEARS[dataset] ?? defaultYear;

    ctx.log.info('Listing geography levels', { dataset, year });

    const service = getCensusApiService();
    const levels = await service.fetchGeographyLevels(dataset, year, ctx);

    if (levels.length === 0) {
      const availableYears = DATASET_AVAILABLE_YEARS[dataset];
      // A listed year that 404s means the catalog drifted from the API: naming it as available
      // beside "cannot be queried" would contradict itself.
      if (!availableYears?.includes(year)) throw yearNotAvailable(dataset, year, availableYears);
      throw ctx.fail('year_not_available', `No geography data found for ${dataset} (${year}).`, {
        dataset,
        year,
      });
    }

    const result = levels.map((level) => {
      const requires = level.requires ?? [];
      const example =
        level.name === 'state'
          ? '06 (California)'
          : level.name === 'county'
            ? '037 (Los Angeles County)'
            : level.name === 'tract'
              ? '010100'
              : level.name === 'block group'
                ? '1'
                : level.name === 'zip code tabulation area'
                  ? '90001'
                  : level.name === 'us'
                    ? '1'
                    : '* (all)';

      return {
        geography_level: level.name,
        requires_parent: requires.length > 0,
        required_parent_levels: requires,
        example,
      };
    });

    ctx.enrich({ dataset, year, totalLevels: countLevels(result) });

    return { geography_levels: result };
  },

  format: (result) => {
    const levels = countLevels(result.geography_levels);
    const entries = result.geography_levels.length;
    const lines: string[] = [
      `## Geography Levels\n`,
      `**${levels} levels available**${
        entries > levels
          ? ` — ${entries} entries, since a level published under more than one parent hierarchy is listed once for each`
          : ''
      }\n`,
    ];
    for (const level of result.geography_levels) {
      lines.push(`### ${level.geography_level}`);
      lines.push(
        `**Requires parent:** ${level.requires_parent ? `Yes (${level.required_parent_levels.join(', ')})` : 'No'}`,
      );
      lines.push(`**Example FIPS:** \`${level.example}\`\n`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
