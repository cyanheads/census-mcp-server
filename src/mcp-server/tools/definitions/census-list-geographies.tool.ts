/**
 * @fileoverview Tool to list geography levels available for a Census dataset and year.
 * @module mcp-server/tools/definitions/census-list-geographies
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getDiscoveryConfig } from '@/config/server-config.js';
import { getCensusApiService } from '@/services/census-api/census-api-service.js';
import {
  DATASET_LATEST_YEARS,
  KNOWN_DATASETS,
} from '@/services/variable-cache/variable-cache-service.js';

export const censusListGeographies = tool('census_list_geographies', {
  title: 'List Census Geography Levels',
  description:
    'List the geography levels available for a given Census dataset and year, along with the parent geographies each level requires. Use before querying to confirm that the target geography level exists — ACS1 omits many sub-state levels, and not all datasets support tracts or block groups. The geography_level values returned here are the valid inputs to the geography_level parameter in census_query_data and census_compare_geographies.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    dataset: z
      .string()
      .describe(
        'Dataset code (e.g., "acs/acs5", "acs/acs1"). Use census_list_datasets to discover valid values.',
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
      .describe('Geography levels supported by this dataset and year.'),
  }),

  enrichment: {
    dataset: z.string().describe('Dataset queried.'),
    year: z.number().describe('Vintage year queried.'),
    totalLevels: z
      .number()
      .describe('Total number of geography levels available for this dataset and year.'),
  },

  errors: [
    {
      reason: 'dataset_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Dataset code is not recognized.',
      recovery: 'Call census_list_datasets to discover valid dataset codes like acs/acs5.',
    },
    {
      reason: 'year_not_available',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Dataset exists but the requested year has no data.',
      recovery: 'Check available_years in census_list_datasets for valid years for this dataset.',
    },
  ],

  async handler(input, ctx) {
    if (!KNOWN_DATASETS.has(input.dataset)) {
      throw ctx.fail('dataset_not_found', `Unknown dataset: "${input.dataset}"`, {
        ...ctx.recoveryFor('dataset_not_found'),
      });
    }

    const { defaultYear } = getDiscoveryConfig();
    const year = input.year ?? DATASET_LATEST_YEARS[input.dataset] ?? defaultYear;

    ctx.log.info('Listing geography levels', { dataset: input.dataset, year });

    const service = getCensusApiService();
    const levels = await service.fetchGeographyLevels(input.dataset, year, ctx);

    if (levels.length === 0) {
      throw ctx.fail(
        'year_not_available',
        `No geography data found for ${input.dataset} (${year})`,
        {
          dataset: input.dataset,
          year,
          ...ctx.recoveryFor('year_not_available'),
        },
      );
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

    ctx.enrich({ dataset: input.dataset, year, totalLevels: result.length });

    return { geography_levels: result };
  },

  format: (result) => {
    const lines: string[] = [
      `## Geography Levels\n`,
      `**${result.geography_levels.length} levels available**\n`,
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
