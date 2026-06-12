/**
 * @fileoverview Tool to search Census Bureau variables by keyword across labels and concepts.
 * @module mcp-server/tools/definitions/census-search-variables
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getDiscoveryConfig } from '@/config/server-config.js';
import {
  DATASET_LATEST_YEARS,
  getVariableCacheService,
} from '@/services/variable-cache/variable-cache-service.js';

export const censusSearchVariables = tool('census_search_variables', {
  title: 'Search Census Variables',
  description:
    'Search Census variables by keyword across variable labels and concept groups. Returns variable codes with human-readable labels — use this to go from a concept like "median household income" to the variable code B19013_001E needed for data queries. Returns both estimate (E suffix) and margin-of-error (M suffix) codes so you can request both. When total_matches exceeds the limit, narrow the query to see more specific results.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    query: z
      .string()
      .describe(
        'Keyword to search (e.g., "median household income", "poverty", "bachelor\'s degree"). Multi-word queries search for all terms.',
      ),
    dataset: z
      .string()
      .optional()
      .describe(
        'Dataset to search within (default: "acs/acs5"). Use census_list_datasets to discover options.',
      ),
    year: z
      .number()
      .optional()
      .describe('Vintage year to search (default: latest available for the dataset).'),
    limit: z
      .number()
      .optional()
      .describe(
        'Maximum results to return (default: 20, max: 100). Increase if total_matches greatly exceeds the limit.',
      ),
  }),
  output: z.object({
    variables: z
      .array(
        z
          .object({
            variable_code: z
              .string()
              .describe('Variable code to pass to census_query_data (e.g., "B19013_001E").'),
            label: z
              .string()
              .describe('Human-readable variable label from the Census data dictionary.'),
            concept: z
              .string()
              .describe('Concept group the variable belongs to (e.g., "MEDIAN HOUSEHOLD INCOME").'),
            predicate_type: z
              .string()
              .describe('Data type of the variable (e.g., "int", "string", "float").'),
            estimate_code: z
              .string()
              .optional()
              .describe(
                'Corresponding estimate variable code when this is a margin-of-error variable.',
              ),
            moe_code: z
              .string()
              .optional()
              .describe(
                'Corresponding margin-of-error variable code when this is an estimate variable. Request both estimate and MOE in census_query_data for complete data.',
              ),
          })
          .describe('A single matching Census variable entry.'),
      )
      .describe(
        'Matching variables sorted by relevance. Variable codes ending in E are estimates; M are margins of error.',
      ),
  }),

  enrichment: {
    effectiveQuery: z.string().describe('Query as the server parsed it.'),
    dataset: z.string().describe('Dataset that was searched.'),
    year: z.number().describe('Vintage year that was searched.'),
    totalMatches: z
      .number()
      .describe('Total variables matching the query before the limit was applied.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when total_matches exceeded the limit and results were cut off.'),
    shown: z.number().optional().describe('Number of variables returned after the limit.'),
    cap: z.number().optional().describe('The limit that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no variables matched, or when results were truncated — suggests broader keywords, a narrower query, or a higher limit.',
      ),
  },

  errors: [
    {
      reason: 'dataset_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Dataset code is not recognized.',
      recovery: 'Call census_list_datasets to discover valid dataset codes like acs/acs5.',
    },
    {
      reason: 'variables_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Variable metadata could not be fetched or parsed from the Census API.',
      retryable: true,
      recovery:
        'Retry the request; if persistent, the dataset and year combination may not be available.',
    },
  ],

  async handler(input, ctx) {
    const dataset = input.dataset?.trim() || 'acs/acs5';
    const { defaultYear } = getDiscoveryConfig();
    const year = input.year ?? DATASET_LATEST_YEARS[dataset] ?? defaultYear;
    const limit = Math.min(input.limit ?? 20, 100);

    ctx.log.info('Searching Census variables', { query: input.query, dataset, year, limit });

    const service = getVariableCacheService();
    const { variables, totalMatches } = await service.searchVariables(
      { query: input.query, dataset, year, limit },
      ctx,
    );

    ctx.enrich.echo(input.query);
    ctx.enrich({ dataset, year, totalMatches });
    if (variables.length === 0) {
      ctx.enrich.notice(
        `No variables matched "${input.query}". Try broader keywords or a different dataset.`,
      );
    } else if (totalMatches > limit) {
      ctx.enrich.truncated({
        shown: variables.length,
        cap: limit,
        guidance: `${totalMatches} variables matched — ${totalMatches - variables.length} not shown. Narrow the query or raise limit (max 100).`,
      });
    }

    return {
      variables: variables.map((v) => ({
        variable_code: v.code,
        label: v.label,
        concept: v.concept,
        predicate_type: v.predicateType,
        ...(v.estimateCode && { estimate_code: v.estimateCode }),
        ...(v.moeCode && { moe_code: v.moeCode }),
      })),
    };
  },

  format: (result) => {
    const lines: string[] = [`## Variable Search Results\n`];

    for (const v of result.variables) {
      lines.push(`### \`${v.variable_code}\``);
      lines.push(`**Label:** ${v.label}`);
      lines.push(`**Concept:** ${v.concept}`);
      lines.push(`**Type:** ${v.predicate_type}`);
      if (v.moe_code) lines.push(`**MOE code:** \`${v.moe_code}\``);
      if (v.estimate_code) lines.push(`**Estimate code:** \`${v.estimate_code}\``);
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
