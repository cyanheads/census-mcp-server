/**
 * @fileoverview Tool to list the codes a Census filter dimension accepts, from the dataset's
 * published value map when it has one and from a wildcard group-by query when it does not.
 * A published value map is a classification, not a record of what the dataset serves, so the
 * codes read from one are checked against the dataset's own published rows before being returned.
 * @module mcp-server/tools/definitions/census-list-predicate-values
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getDiscoveryConfig } from '@/config/server-config.js';
import { getCensusApiService } from '@/services/census-api/census-api-service.js';
import type { CensusPredicateValue } from '@/services/census-api/types.js';
import {
  DATASET_LATEST_YEARS,
  getVariableCacheService,
  KNOWN_DATASETS,
  NON_FILTERING_PREDICATES,
} from '@/services/variable-cache/variable-cache-service.js';

/** Filter dimensions carrying an industry classification, whose value scopes the others. */
const NAICS_DIMENSION = /^NAICS\d{4}$/;

/** How many withheld codes a notice names before it stops listing them. */
const WITHHELD_SAMPLE_SIZE = 3;

/**
 * The codes a dimension's published value map declares that the dataset actually serves rows for,
 * or `undefined` when the check could not be made.
 *
 * A `values.item` map is a classification the Census shares across products — `dec/ddhca` declares
 * 5,543 `POPGROUP` codes and publishes 2,996 of them, `cbp` declares 6,694 `NAICS2017` codes and
 * publishes 2,003. Wildcarding the dimension against one of the dataset's measure columns answers
 * with the published set in a single call, cached for the discovery TTL.
 *
 * The check is best-effort by design: a failure downgrades the answer to the unchecked map with a
 * notice saying so, which is worse than a checked list but better than no list at all.
 */
async function fetchPublishedCodes(
  dataset: string,
  year: number,
  predicate: string,
  ctx: Context,
): Promise<Set<string> | undefined> {
  try {
    const measure = await getVariableCacheService().findPublicationProbe(dataset, year, ctx);
    if (!measure) return;

    const published = await getCensusApiService().fetchPredicateValues(
      { dataset, year, code: predicate, measure },
      ctx,
    );
    // An empty answer is the probe saying nothing rather than the dimension having no codes —
    // withholding every code on the strength of it would hide the whole dimension.
    return published.length > 0 ? new Set(published.map((v) => v.code)) : undefined;
  } catch (error) {
    ctx.log.warning('Publication check failed; falling back to the unchecked value map', {
      dataset,
      year,
      predicate,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
}

export const censusListPredicateValues = tool('census_list_predicate_values', {
  title: 'List Census Predicate Values',
  description:
    "List the codes a Census filter dimension accepts, so a predicates map can be written without guessing. Answers the question left open when census_query_data or census_compare_geographies reports that a dimension was left unset. Which route a dimension takes depends on the vintage: NAICS and POPGROUP always publish a value list in the dataset dictionary, and on the current vintages EMPSZES, LFO, RCPSZES, TAXSTAT, and TYPOP publish none and are enumerated here against the live data endpoint instead. A dictionary value list is a classification shared across Census products rather than a list of what one dataset serves, and roughly half of its codes typically return no rows anywhere — those are checked against the dataset's own published rows and dropped, and the response source field says whether that check ran. The dictionary lists run to thousands of codes and are best narrowed with query. Pass the returned code as the dimension's value in predicates.",
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    predicate: z
      .string()
      .describe(
        'Filter dimension code to enumerate (e.g., "EMPSZES", "LFO", "POPGROUP", "NAICS2017"). Case-sensitive. The response notice of census_query_data names the dimensions a dataset declares, and census_search_variables finds them by keyword.',
      ),
    dataset: z
      .string()
      .describe(
        'Dataset the dimension belongs to (e.g., "cbp", "nonemp", "ecnbasic", "dec/ddhca", "pep/charv"). Use census_list_datasets to discover valid values. Dimension codes are vintage-specific, so the dataset and year must match the query the values are for.',
      ),
    year: z
      .number()
      .optional()
      .describe('Vintage year (default: latest available for the dataset).'),
    query: z
      .string()
      .optional()
      .describe(
        'Keyword to narrow the list, matched case-insensitively against each code and label (e.g., "software" against NAICS2017, "exempt" against TAXSTAT). Omit to list from the start. NAICS and POPGROUP run to thousands of codes, so a keyword is the practical way to use them.',
      ),
    within_naics: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(/^\d{2,8}(-\d{2})?$/)
          .describe('A NAICS code: 2 to 8 digits, or a hyphenated sector range such as "31-33".'),
      ])
      .optional()
      .describe(
        'Industry code to scope the enumeration by, for dimensions the Census publishes per industry. On ecnbasic, TAXSTAT and TYPOP return only the all-establishments row until a NAICS sector is named — pass a sector code such as "62" (Health Care) or "42" (Wholesale Trade) and the result is complete for that industry alone. Ignored for dimensions with a published value list. Get sector codes by calling this tool on the dataset\'s own NAICS dimension. Blank is treated as omitted.',
      ),
    limit: z.number().optional().describe('Maximum codes to return (default: 50, max: 500).'),
  }),
  output: z.object({
    values: z
      .array(
        z
          .object({
            code: z
              .string()
              .describe(
                'The value to send for this dimension in a predicates map (e.g., "210" for EMPSZES).',
              ),
            label: z
              .string()
              .describe(
                'What the code means (e.g., "Establishments with less than 5 employees"). Falls back to the code when the dataset publishes no label for it.',
              ),
          })
          .describe('One accepted code for the dimension, with its label.'),
      )
      .describe('Codes the dimension accepts, sorted by code.'),
    predicate: z.string().describe('Filter dimension enumerated.'),
    predicate_label: z
      .string()
      .describe('Label of the dimension itself (e.g., "Employment size of establishments code").'),
    dataset: z.string().describe('Dataset queried.'),
    year: z.number().describe('Vintage year queried.'),
  }),

  enrichment: {
    totalCount: z.number().describe('Codes matched before the limit was applied.'),
    truncated: z.boolean().describe('True when totalCount exceeds the limit and the list was cut.'),
    source: z
      .string()
      .describe(
        'Where the codes came from. "live_query" is a wildcard group-by against the data endpoint, which returns only codes the dataset publishes. "dataset_dictionary_verified" is the dataset\'s published value map with the codes it serves no rows for removed. Plain "dataset_dictionary" is that map unchecked — every code in it is declared by the dataset, but some of them return nothing at any geography, and the notice says why the check did not run.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the list was truncated, when query matched no published code, when codes from the dataset dictionary could not be checked against its published rows, or when the codes returned are complete only for a named industry rather than for the dimension as a whole.',
      ),
  },

  errors: [
    {
      reason: 'dataset_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Dataset code is not recognized.',
      recovery: 'Call census_list_datasets to discover valid dataset codes like cbp or nonemp.',
    },
    {
      reason: 'predicate_not_supported',
      code: JsonRpcErrorCode.NotFound,
      when: 'The predicate code is not a variable in this dataset and year.',
      recovery:
        'Call census_search_variables on this dataset and year for the codes it does define — dimension names are vintage-specific, so NAICS2017 and NAICS2022 belong to different years.',
    },
    {
      reason: 'not_a_filter_dimension',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The code is not one of the dimensions the dataset filters on, so it takes no value list.',
      recovery:
        'Pass a dimension the dataset filters on. The response notice of census_query_data names every dimension a dataset declares, and census_get_variable confirms what a code is.',
    },
    {
      reason: 'no_values',
      code: JsonRpcErrorCode.NotFound,
      when: 'The dimension returned no codes for the scope requested.',
      recovery:
        'Drop within_naics, or try a broader industry code — a narrow leaf industry often publishes only the all-establishments row.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Census API returned an error or was unreachable.',
      retryable: true,
      recovery:
        'Retry the request; if the error persists, the Census API may be temporarily unavailable.',
    },
  ],

  async handler(input, ctx) {
    const dataset = input.dataset.trim();
    if (!KNOWN_DATASETS.has(dataset)) {
      throw ctx.fail('dataset_not_found', `Unknown dataset: "${dataset}".`, {
        dataset,
        ...ctx.recoveryFor('dataset_not_found'),
      });
    }

    const { defaultYear } = getDiscoveryConfig();
    const year = input.year ?? DATASET_LATEST_YEARS[dataset] ?? defaultYear;
    const limit = Math.min(input.limit ?? 50, 500);
    const predicate = input.predicate.trim();

    ctx.log.info('Listing predicate values', { predicate, dataset, year });

    const variableCacheService = getVariableCacheService();
    const variable = await variableCacheService.findVariable(predicate, dataset, year, ctx);

    if (!variable) {
      throw ctx.fail(
        'predicate_not_supported',
        `"${predicate}" is not a variable in ${dataset} (${year}).`,
        { dataset, year, predicate, ...ctx.recoveryFor('predicate_not_supported') },
      );
    }

    // GEOCOMP is marked required on every dataset but selects a geography component rather than
    // a subject-matter category, so the data tools leave it out of the dimensions they report.
    // Enumerating it here would advertise a dimension nothing else on this server treats as one.
    if (!variable.required || NON_FILTERING_PREDICATES.has(predicate)) {
      throw ctx.fail(
        'not_a_filter_dimension',
        `"${predicate}" is not one of the dimensions ${dataset} (${year}) filters on.`,
        { dataset, year, predicate, ...ctx.recoveryFor('not_a_filter_dimension') },
      );
    }

    // Two routes, picked by where the answer lives. `NAICS*` and `POPGROUP` always publish a
    // `values.item` map and a handful of others do on older vintages; a dimension without one
    // has to be enumerated against the data endpoint.
    let all: CensusPredicateValue[];
    let source: string;
    let naicsScopeApplied: string | undefined;
    /** Declared codes the dataset publishes no rows for — dropped from `all`, named in a notice. */
    let withheld: CensusPredicateValue[] = [];
    /** Why the declared codes were returned unchecked, when they were. */
    let unchecked: 'per_industry' | 'check_unavailable' | undefined;

    const dimensions = await variableCacheService.getFilterDimensions(dataset, year, ctx);
    /** The dataset's own industry dimension, when it has one. */
    const naicsCode = dimensions.find((d) => NAICS_DIMENSION.test(d.code))?.code;

    if (variable.values) {
      const declared = Object.entries(variable.values)
        .map(([code, label]) => ({ code, label }))
        .sort((a, b) => a.code.localeCompare(b.code));

      // A dimension the dataset publishes per industry serves a different set under each one, so
      // an unscoped check would withhold codes a NAICS-scoped query does return.
      const perIndustry = naicsCode !== undefined && naicsCode !== predicate;
      const published = perIndustry
        ? undefined
        : await fetchPublishedCodes(dataset, year, predicate, ctx);

      if (published) {
        all = declared.filter((v) => published.has(v.code));
        withheld = declared.filter((v) => !published.has(v.code));
        source = 'dataset_dictionary_verified';
      } else {
        all = declared;
        source = 'dataset_dictionary';
        unchecked = perIndustry ? 'per_industry' : 'check_unavailable';
      }
    } else {
      const naicsValue = input.within_naics?.trim();
      const naicsScope =
        naicsCode && naicsValue ? { code: naicsCode, value: naicsValue } : undefined;
      naicsScopeApplied = naicsScope ? `${naicsScope.code}=${naicsScope.value}` : undefined;

      all = await getCensusApiService().fetchPredicateValues(
        {
          dataset,
          year,
          code: predicate,
          ...(variable.labelAttribute && { labelAttribute: variable.labelAttribute }),
          ...(naicsScope && { naicsScope }),
        },
        ctx,
      );
      source = 'live_query';
    }

    if (all.length === 0) {
      throw ctx.fail('no_values', `${predicate} returned no codes in ${dataset} (${year}).`, {
        dataset,
        year,
        predicate,
        ...ctx.recoveryFor('no_values'),
      });
    }

    const keyword = input.query?.trim().toLowerCase();
    const matched = keyword
      ? all.filter(
          (v) => v.code.toLowerCase().includes(keyword) || v.label.toLowerCase().includes(keyword),
        )
      : all;

    const values = matched.slice(0, limit);
    const truncated = matched.length > limit;

    ctx.enrich({ totalCount: matched.length, truncated, source });

    const notices: string[] = [];
    if (naicsScopeApplied) {
      notices.push(
        `These codes are the ones ${predicate} takes under ${naicsScopeApplied}, and are complete for that industry only — a different industry can publish a different set. Send the same ${naicsScopeApplied.split('=')[0]} value alongside ${predicate} in predicates.`,
      );
    } else if (source === 'live_query' && all.length === 1 && naicsCode) {
      notices.push(
        `Only one code came back for ${predicate}, which is what a dimension published per industry rather than dataset-wide returns unscoped. Set within_naics to a sector code (for example "62" or "42") to see the codes ${predicate} takes there.`,
      );
    }
    if (withheld.length > 0) {
      notices.push(
        `${dataset} (${year}) declares ${withheld.length + all.length} ${predicate} codes and publishes rows for ${all.length} of them; only those are listed. The rest belong to the wider classification the value map is shared from and return nothing at any geography. A single geography, or a more detailed table, can publish fewer still.`,
      );
    } else if (unchecked === 'per_industry') {
      notices.push(
        `${dataset} (${year}) publishes ${predicate} per industry, so which of these codes return rows depends on the ${naicsCode} value sent alongside them. These are the codes ${predicate} declares, not a list of what any one industry serves — confirm one with a census_query_data call that sets both.`,
      );
    } else if (unchecked === 'check_unavailable') {
      notices.push(
        `These are the codes ${predicate} declares in ${dataset} (${year}); checking them against the rows the dataset publishes was not possible on this call. A declared code can return nothing at any geography, so confirm one with census_query_data before relying on it.`,
      );
    }
    if (truncated) {
      notices.push(
        `Showing ${values.length} of ${matched.length} codes. Narrow with query, or raise limit.`,
      );
    } else if (matched.length === 0) {
      // A keyword that matches only withheld codes is the sharpest version of this dimension's
      // trap: on dec/ddhca "total population" matches 001, a code the dataset serves nothing for.
      // Naming what it matched is what separates "no such code" from "that code is a dead end".
      const withheldMatches = keyword
        ? withheld.filter(
            (v) =>
              v.code.toLowerCase().includes(keyword) || v.label.toLowerCase().includes(keyword),
          )
        : [];
      if (withheldMatches.length > 0) {
        const named = withheldMatches
          .slice(0, WITHHELD_SAMPLE_SIZE)
          .map((v) => `${v.code} (${v.label.trim()})`)
          .join(', ');
        const plural = withheldMatches.length === 1 ? 'code' : 'codes';
        notices.push(
          `No published ${predicate} code matched "${input.query?.trim()}". ${dataset} (${year}) does declare ${withheldMatches.length} matching ${plural} — ${named} — but publishes no rows for ${withheldMatches.length === 1 ? 'it' : 'them'} at any geography, so ${withheldMatches.length === 1 ? 'it is' : 'they are'} not listed. A declared code a dataset serves nothing for means the category it names is outside what that dataset covers, not that the query was wrong — try another keyword, or census_list_datasets for a dataset that reports it.`,
        );
      } else {
        notices.push(
          `No ${predicate} code matched "${input.query?.trim()}". ${predicate} takes ${all.length} ${all.length === 1 ? 'code' : 'codes'} here — drop query to list them, or try a broader keyword.`,
        );
      }
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      values,
      predicate,
      predicate_label: variable.label,
      dataset,
      year,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## ${result.predicate} — ${result.predicate_label}`,
      `**${result.dataset} (${result.year})** · ${result.values.length} codes\n`,
    ];
    for (const v of result.values) {
      lines.push(`- **\`${v.code}\`** — ${v.label}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
