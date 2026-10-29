/**
 * @fileoverview Tool to search Census Bureau variables by code, or by keyword across labels and
 * concepts.
 * @module mcp-server/tools/definitions/census-search-variables
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getDiscoveryConfig } from '@/config/server-config.js';
import { renderNotice } from '@/mcp-server/tools/notice-trailer.js';
import {
  type CodeMiss,
  DATASET_LATEST_YEARS,
  describeSiblingHolders,
  getVariableCacheService,
  resolveDataset,
} from '@/services/variable-cache/variable-cache-service.js';

/** The empty-result notice for a query shaped like a code, by why it matched nothing. */
function codeMissNotice(
  query: string,
  miss: CodeMiss,
  scope: { dataset: string; year: number },
): string {
  const where = `${scope.dataset} (${scope.year})`;
  switch (miss.kind) {
    case 'attribute':
      return `${miss.code} is an attribute column of ${where} — an annotation, flag, label, or significance column published beside a variable, which search does not list. Call census_get_variable with ${miss.code} for its label and the variable it belongs to.`;
    case 'sibling':
      return `No variables matched "${query}" in ${where}. ${describeSiblingHolders(new Map([[miss.code, miss.sibling]]))}`;
    case 'absent':
      return `No variable or table in ${where} has the code "${miss.code}", and no label or concept contains it. Codes differ by dataset and vintage: check the code and year, or search with words from the variable's label.`;
  }
}

export const censusSearchVariables = tool('census_search_variables', {
  title: 'Search Census Variables',
  description:
    'Search Census variables by keyword across variable labels and concept groups, or look one up by its code. Returns variable codes with human-readable labels — use this to go from a concept like "median household income" to the variable code B19013_001E needed for data queries. A query that is one variable or table code, such as B19013_001E or B19013, returns that variable or the table\'s variables, in code order, ahead of any keyword matches; a code the dataset does not publish gets a notice naming the dataset that does, when one is confirmed. On ACS datasets it returns both estimate (E suffix) and margin-of-error (M suffix) codes so you can request both; the ACS comparison profiles (acs/acs5/cprofile, acs/acs1/cprofile) and the other dataset families publish no margins of error. Also use it to find the predicate codes a dataset filters on, such as NAICS2017 in cbp. Adding a word narrows the results, since every word must match; when totalMatches exceeds the limit, a more specific query reaches the rest — except past the limit of a table code, where a later variable\'s own code does.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    query: z
      .string()
      .describe(
        'Keywords to search (e.g., "median household income", "poverty", "bachelor\'s degree"), or one variable or table code (e.g., "B19013_001E", "B19013"). Each word must match a whole word of the label or of the concept, ignoring case and punctuation, so "rate" does not match "separated". A column shared across tables, such as GEO_ID, is matched on its label only, and a margin of error on its estimate\'s label. When no variable contains every word, the results are the variables containing the most words, and the notice says how many that was. A single token that equals a variable code or a table ID, ignoring case and any quotes or punctuation around it, returns those variables first. A token with no digit or underscore, such as "state", is read as a code when no keyword matched; ahead of keyword matches only when typed in the code\'s own uppercase ("STATE").',
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
        "Matching variables, best first: the variable whose code equals the query, or every variable of the table whose ID equals it, in code order; then a variable whose label's last !!-separated segment or whose whole concept equals the query, then the query as a phrase in both label and concept, in the label only, in the concept only, then every word present but not as a phrase; ties go to fewer !! segments in the label, then a shorter concept, then the code, which puts an E estimate before its M margin of error. On ACS datasets, codes ending in E are estimates and M are their margins of error, except on the comparison profiles, which publish no M codes; on other datasets the suffix carries no such meaning.",
      ),
  }),

  enrichment: {
    effectiveQuery: z.string().describe('Query as the server parsed it.'),
    dataset: z.string().describe('Dataset that was searched.'),
    year: z.number().describe('Vintage year that was searched.'),
    totalMatches: z
      .number()
      .describe(
        'Variables matched before the limit was applied: those matching the query as a code, plus those containing every query word — or, when none does and no code matched, the variables that contain the most words.',
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
        'Guidance when no variables matched, when no variable contained every query word and the results hold only some of them, or when results were truncated — suggests other keywords, a narrower query, or a higher limit. For a code the dataset does not publish, it names the sibling dataset confirmed to hold it, or census_get_variable for an attribute column (annotation, flag, label, or significance); for a table cut at the limit, the last code shown.',
      ),
  },
  // The notice quotes the query.
  enrichmentTrailer: { notice: { render: renderNotice } },

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
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: "The Census API answered the dataset's variables.json with an HTTP error, after any retries a transient status earns.",
      retryable: true,
      thrownBy: 'service',
      recovery:
        'Retry the request if the failure was transient; if the Census API rejected the request outright, retrying it unchanged returns the same status, so change the dataset or year.',
    },
  ],

  async handler(input, ctx) {
    const dataset = resolveDataset(input.dataset, 'acs/acs5');
    const { defaultYear } = getDiscoveryConfig();
    const year = input.year ?? DATASET_LATEST_YEARS[dataset] ?? defaultYear;
    const limit = input.limit ?? 20;

    ctx.log.info('Searching Census variables', { query: input.query, dataset, year, limit });

    const service = getVariableCacheService();
    const { variables, totalMatches, codeMatches, matchedTermCount, termCount, codeMiss } =
      await service.searchVariables({ query: input.query, dataset, year, limit }, ctx);

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
        codeMiss
          ? codeMissNotice(input.query, codeMiss, { dataset, year })
          : `No variables matched "${input.query}". Try broader keywords or a different dataset.`,
      );
    } else if (totalMatches > limit) {
      const shown = `${totalMatches} variables matched — ${totalMatches - variables.length} not shown`;
      // A table cut inside its code tier: words added to the code drop it, so narrowing cannot help.
      const truncation =
        codeMatches > variables.length
          ? `${shown}; the table continues in code order after ${variables.at(-1)?.code}. ${limit < 100 ? 'Raise limit (max 100), or search' : 'Search'} a later variable code on its own — a word added to a table code ends the code match.`
          : `${shown}. ${limit < 100 ? 'Narrow the query or raise limit (max 100).' : 'Narrow the query to reach the rest.'}`;
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
