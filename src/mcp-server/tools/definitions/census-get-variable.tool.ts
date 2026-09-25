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
  resolveDataset,
} from '@/services/variable-cache/variable-cache-service.js';

export const censusGetVariable = tool('census_get_variable', {
  title: 'Get Census Variable Metadata',
  description:
    "Fetch full metadata for one or more Census variable codes — label, concept group, predicate type, the table's universe, and margin-of-error sibling references. Use to confirm a variable code before building a query, or to look up what a known code means. On ACS datasets it returns estimate_code and moe_code sibling references so you can request both without a separate search, and a margin-of-error code carries attribute_of and attribute_type MARGIN_OF_ERROR as the Census publishes them; the ACS comparison profiles (acs/acs5/cprofile, acs/acs1/cprofile) and the other dataset families publish no margins of error and carry none of these fields. It also resolves the annotation and flag columns the data tools accept, such as B19013_001EA or EMP_F, naming the column each one belongs to, and predicate codes such as NAICS2017 or SEX, confirming a filter dimension exists in a dataset before a query uses it — for the values a dimension accepts rather than the dimension itself, call census_list_predicate_values.",
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    variables: z
      .array(z.string())
      .describe(
        'One or more variable codes to look up (e.g., ["B19013_001E", "B19013_001M"]). Codes are trimmed and matched regardless of case, and the response echoes the dataset\'s own spelling — uppercase everywhere except the comparison profiles\' significance columns (e.g., CP03_2024to2019_062SS).',
      ),
    dataset: z
      .string()
      .optional()
      .describe(
        'Dataset the variables belong to (default: "acs/acs5"). Use census_list_datasets to discover valid values. Case is ignored, and a two-part code can be given by its last part alone — "acs5" is acs/acs5, "pl" is dec/pl. Three-part codes such as acs/acs5/profile must be given in full. The response echoes the resolved code.',
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
            concept: z
              .string()
              .optional()
              .describe(
                'Concept of the table the variable belongs to. Absent for a column shared across tables, such as GEO_ID, whose concept joins every table it appears in, and for a column the dataset publishes no concept for, such as STATE.',
              ),
            predicate_type: z.string().describe('Data type (e.g., "int", "string", "float").'),
            universe: z
              .string()
              .optional()
              .describe(
                'Universe of the variable\'s table (e.g., "Households", "Population 25 years and over"). Absent when the table publishes none — the ACS subject, profile, and selected population profile tables, dec/dp, the business datasets, pep/charv, and every ACS and dec/pl vintage before 2020 publish none — and for a column that belongs to no single table.',
              ),
            attribute_of: z
              .string()
              .optional()
              .describe(
                'For an annotation, flag, or margin-of-error column, the column it belongs to, as the Census publishes it (e.g., "B19013_001E" for B19013_001EA or B19013_001M). Absent on ordinary variables.',
              ),
            attribute_type: z
              .string()
              .optional()
              .describe(
                'For an annotation, flag, or margin-of-error column, its kind as the Census publishes it (e.g., "ANNOTATION", "FLAG", "MARGIN_OF_ERROR"). Absent on ordinary variables.',
              ),
            estimate_code: z
              .string()
              .optional()
              .describe(
                'Estimate sibling variable code when this is a margin-of-error variable. ACS datasets only, apart from the comparison profiles — no other dataset publishes margins of error.',
              ),
            moe_code: z
              .string()
              .optional()
              .describe(
                'Margin-of-error sibling code when this is an estimate variable. Include both in census_query_data for complete data. ACS datasets only, apart from the comparison profiles (acs/acs5/cprofile, acs/acs1/cprofile) — there and on other families an E-final code has no margin-of-error sibling, so the field is absent.',
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
      thrownBy: 'service',
      recovery:
        'Use census_search_variables to discover valid variable codes for this dataset and year.',
    },
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
      when: "Variable metadata — the dataset's variables.json, groups.json, or an attribute column's own entry — could not be fetched or parsed.",
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

    // Every supported dataset names its columns in uppercase, as the data tools assume.
    const codes = input.variables.map((code) => code.trim().toUpperCase());

    ctx.log.info('Getting Census variable metadata', { variables: codes, dataset, year });

    const service = getVariableCacheService();
    const variables = await service.getVariablesByCode(codes, dataset, year, ctx);

    return {
      variables: variables.map((v) => ({
        variable_code: v.code,
        label: v.label,
        ...(v.concept !== undefined && { concept: v.concept }),
        predicate_type: v.predicateType,
        ...(v.universe && { universe: v.universe }),
        ...(v.attributeOf && { attribute_of: v.attributeOf }),
        ...(v.attributeType && { attribute_type: v.attributeType }),
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
      if (v.concept !== undefined) lines.push(`**Concept:** ${v.concept}`);
      lines.push(`**Type:** ${v.predicate_type}`);
      if (v.universe) lines.push(`**Universe:** ${v.universe}`);
      if (v.attribute_of) lines.push(`**Attribute of:** \`${v.attribute_of}\``);
      if (v.attribute_type) lines.push(`**Attribute type:** ${v.attribute_type}`);
      if (v.moe_code) lines.push(`**MOE sibling:** \`${v.moe_code}\``);
      if (v.estimate_code) lines.push(`**Estimate sibling:** \`${v.estimate_code}\``);
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
