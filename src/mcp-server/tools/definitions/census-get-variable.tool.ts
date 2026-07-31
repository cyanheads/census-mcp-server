/**
 * @fileoverview Tool to fetch full metadata for one or more Census variable codes.
 * @module mcp-server/tools/definitions/census-get-variable
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getDiscoveryConfig } from '@/config/server-config.js';
import {
  DATASET_LATEST_YEARS,
  getVariableCacheService,
} from '@/services/variable-cache/variable-cache-service.js';

export const censusGetVariable = tool('census_get_variable', {
  title: 'Get Census Variable Metadata',
  description:
    'Fetch full metadata for one or more Census variable codes — label, concept group, predicate type, universe, and margin-of-error sibling references. Use to confirm a variable code before building a query, or to look up what a known code means. On ACS datasets it returns estimate_code and moe_code sibling references so you can request both without a separate search; other dataset families publish no margins of error and carry neither field. It also resolves predicate codes such as NAICS2017 or SEX, confirming a filter dimension exists in a dataset before a query uses it.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    variables: z
      .array(z.string())
      .describe(
        'One or more variable codes to look up (e.g., ["B19013_001E", "B19013_001M"]). Variable codes are case-sensitive.',
      ),
    dataset: z
      .string()
      .optional()
      .describe(
        'Dataset the variables belong to (default: "acs/acs5"). Use census_list_datasets to discover valid values.',
      ),
    year: z
      .number()
      .optional()
      .describe('Vintage year (default: latest available for the dataset).'),
  }),
  output: z.object({
    variables: z
      .array(
        z
          .object({
            variable_code: z.string().describe('Census variable code (e.g., "B19013_001E").'),
            label: z.string().describe('Human-readable label from the Census data dictionary.'),
            concept: z.string().describe('Concept group the variable belongs to.'),
            predicate_type: z.string().describe('Data type (e.g., "int", "string", "float").'),
            universe: z
              .string()
              .optional()
              .describe(
                'Universe the variable applies to (e.g., "Households", "People 25 years and over").',
              ),
            estimate_code: z
              .string()
              .optional()
              .describe(
                'Estimate sibling variable code when this is a margin-of-error variable. ACS datasets only — no other family publishes margins of error.',
              ),
            moe_code: z
              .string()
              .optional()
              .describe(
                'Margin-of-error sibling code when this is an estimate variable. Include both in census_query_data for complete data. ACS datasets only — on other families an E-final code is an ordinary code with no margin-of-error sibling, so the field is absent.',
              ),
          })
          .describe('Full metadata for a single Census variable.'),
      )
      .describe('Variable metadata in the same order as the input array.'),
    dataset: z.string().describe('Dataset queried.'),
    year: z.number().describe('Vintage year queried.'),
  }),

  errors: [
    {
      reason: 'variable_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'One or more variable codes were not found in the dataset and year.',
      recovery:
        'Use census_search_variables to discover valid variable codes for this dataset and year.',
    },
    {
      reason: 'dataset_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Dataset code is not recognized.',
      recovery: 'Call census_list_datasets to discover valid dataset codes like acs/acs5.',
    },
    {
      reason: 'variables_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Variable metadata endpoint is unreachable or returned an unparseable response.',
      retryable: true,
      recovery:
        'Retry the request; if persistent, the dataset and year combination may not be available.',
    },
  ],

  async handler(input, ctx) {
    const dataset = input.dataset?.trim() || 'acs/acs5';
    const { defaultYear } = getDiscoveryConfig();
    const year = input.year ?? DATASET_LATEST_YEARS[dataset] ?? defaultYear;

    ctx.log.info('Getting Census variable metadata', { variables: input.variables, dataset, year });

    const service = getVariableCacheService();
    const variables = await service.getVariablesByCode(input.variables, dataset, year, ctx);

    return {
      variables: variables.map((v) => ({
        variable_code: v.code,
        label: v.label,
        concept: v.concept,
        predicate_type: v.predicateType,
        ...(v.universe && { universe: v.universe }),
        ...(v.estimateCode && { estimate_code: v.estimateCode }),
        ...(v.moeCode && { moe_code: v.moeCode }),
      })),
      dataset,
      year,
    };
  },

  format: (result) => {
    const lines: string[] = [`## Variable Metadata — ${result.dataset} (${result.year})\n`];

    for (const v of result.variables) {
      lines.push(`### \`${v.variable_code}\``);
      lines.push(`**Label:** ${v.label}`);
      lines.push(`**Concept:** ${v.concept}`);
      lines.push(`**Type:** ${v.predicate_type}`);
      if (v.universe) lines.push(`**Universe:** ${v.universe}`);
      if (v.moe_code) lines.push(`**MOE sibling:** \`${v.moe_code}\``);
      if (v.estimate_code) lines.push(`**Estimate sibling:** \`${v.estimate_code}\``);
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
