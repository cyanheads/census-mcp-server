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
  resolveDataset,
} from '@/services/variable-cache/variable-cache-service.js';

export const censusSearchVariables = tool('census_search_variables', {
  title: 'Search Census Variables',
  description:
    'Search Census variables by keyword across variable labels and concept groups. Returns variable codes with human-readable labels — use this to go from a concept like "median household income" to the variable code B19013_001E needed for data queries. On ACS datasets it returns both estimate (E suffix) and margin-of-error (M suffix) codes so you can request both; the ACS comparison profiles (acs/acs5/cprofile, acs/acs1/cprofile) and the other dataset families publish no margins of error. Also use it to find the predicate codes a dataset filters on, such as NAICS2017 in cbp. Adding a word narrows the results, since every word must match; when totalMatches exceeds the limit, a more specific query reaches the rest.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    query: z
      .string()
      .describe(
        'Keywords to search (e.g., "median household income", "poverty", "bachelor\'s degree"). Each word must match a whole word of the label or of the concept, ignoring case and punctuation, so "rate" does not match "separated". A column shared across tables, such as GEO_ID, is matched on its label only, and a margin of error on its estimate\'s label. When no variable contains every word, the results are the variables containing the most words, and the notice says how many that was.',
      ),
    dataset: z
      .string()
      .optional()
      .describe(
        'Dataset to search within (default: "acs/acs5"). Use census_list_datasets to discover options. Case is ignored, and a two-part code can be given by its last part alone — "acs5" is acs/acs5, "pl" is dec/pl. Three-part codes such as acs/acs5/profile must be given in full. The response echoes the resolved code, and the default year is that dataset\'s latest.',
      ),
    year: z
      .number()
      .optional()
      .describe('Vintage year to search (default: latest available for the dataset).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        'Maximum results to return (default: 20, max: 100). Increase if totalMatches greatly exceeds the limit.',
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
              .optional()
              .describe(
                'Concept of the table the variable belongs to (e.g., "Median Household Income in the Past 12 Months"). Absent for a column shared across tables, such as GEO_ID, whose concept joins every table it appears in, and for a column the dataset publishes no concept for, such as STATE.',
              ),
            predicate_type: z
              .string()
              .describe('Data type of the variable (e.g., "int", "string", "float").'),
            estimate_code: z
              .string()
              .optional()
              .describe(
                'Corresponding estimate variable code when this is a margin-of-error variable. ACS datasets only, apart from the comparison profiles — no other dataset publishes margins of error.',
              ),
            moe_code: z
              .string()
              .optional()
              .describe(
                'Corresponding margin-of-error variable code when this is an estimate variable. Request both estimate and MOE in census_query_data for complete data. ACS datasets only, apart from the comparison profiles (acs/acs5/cprofile, acs/acs1/cprofile) — there and on other families an E-final code has no margin-of-error sibling, so the field is absent.',
              ),
          })
          .describe('A single matching Census variable entry.'),
      )
      .describe(
        "Matching variables, best first: a variable whose label's last !!-separated segment or whose whole concept equals the query, then the query as a phrase in both label and concept, in the label only, in the concept only, then every word present but not as a phrase; ties go to fewer !! segments in the label, then a shorter concept, then the code, which puts an E estimate before its M margin of error. On ACS datasets, codes ending in E are estimates and M are their margins of error, except on the comparison profiles, which publish no M codes; on other datasets the suffix carries no such meaning.",
      ),
  }),

  enrichment: {
    effectiveQuery: z.string().describe('Query as the server parsed it.'),
    dataset: z.string().describe('Dataset that was searched.'),
    year: z.number().describe('Vintage year that was searched.'),
    totalMatches: z
      .number()
      .describe(
        'Variables that contain every query word, before the limit was applied — or, when none does, the variables that contain the most words.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe('True when totalMatches exceeded the limit and results were cut off.'),
    shown: z.number().optional().describe('Number of variables returned after the limit.'),
    cap: z.number().optional().describe('The limit that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no variables matched, when no variable contained every query word and the results hold only some of them, or when results were truncated — suggests other keywords, a narrower query, or a higher limit.',
      ),
  },

  errors: [
    {
      reason: 'dataset_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Dataset code is not recognized, even after case and shorthand resolution.',
      thrownBy: 'service',
      recovery: 'Call census_list_datasets to discover valid dataset codes like acs/acs5.',
    },
    {
      reason: 'year_not_available',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The dataset does not serve the requested vintage year.',
      thrownBy: 'service',
      recovery:
        'Retry with a year from available_years in census_list_datasets; the error names the years this dataset serves.',
    },
    {
      reason: 'variables_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Variable metadata could not be fetched or parsed from the Census API.',
      retryable: true,
      thrownBy: 'service',
      recovery:
        'Retry the request; if persistent, the dataset and year combination may not be available.',
    },
  ],

  async handler(input, ctx) {
    const dataset = resolveDataset(input.dataset, 'acs/acs5');
    const { defaultYear } = getDiscoveryConfig();
    const year = input.year ?? DATASET_LATEST_YEARS[dataset] ?? defaultYear;
    const limit = input.limit ?? 20;

    ctx.log.info('Searching Census variables', { query: input.query, dataset, year, limit });

    const service = getVariableCacheService();
    const { variables, totalMatches, matchedTermCount, termCount } = await service.searchVariables(
      { query: input.query, dataset, year, limit },
      ctx,
    );

    ctx.enrich.echo(input.query);
    ctx.enrich({ dataset, year, totalMatches });

    const partial =
      matchedTermCount < termCount
        ? `No variable contains every word of "${input.query}"; these are the ${totalMatches} that contain ${matchedTermCount} of its ${termCount} words, and each can be missing a different one. Change or drop a word to match them all.`
        : undefined;

    if (termCount === 0) {
      ctx.enrich.notice(
        `"${input.query}" has no letters or digits to match. Search with words from a variable's label or concept, such as "median household income".`,
      );
    } else if (variables.length === 0) {
      ctx.enrich.notice(
        `No variables matched "${input.query}". Try broader keywords or a different dataset.`,
      );
    } else if (totalMatches > limit) {
      const truncation = `${totalMatches} variables matched — ${totalMatches - variables.length} not shown. ${limit < 100 ? 'Narrow the query or raise limit (max 100).' : 'Narrow the query to reach the rest.'}`;
      ctx.enrich.truncated({
        shown: variables.length,
        cap: limit,
        guidance: partial ? `${partial} ${truncation}` : truncation,
      });
    } else if (partial) {
      ctx.enrich.notice(partial);
    }

    return {
      variables: variables.map((v) => ({
        variable_code: v.code,
        label: v.label,
        ...(v.concept !== undefined && { concept: v.concept }),
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
      if (v.concept !== undefined) lines.push(`**Concept:** ${v.concept}`);
      lines.push(`**Type:** ${v.predicate_type}`);
      if (v.moe_code) lines.push(`**MOE code:** \`${v.moe_code}\``);
      if (v.estimate_code) lines.push(`**Estimate code:** \`${v.estimate_code}\``);
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
