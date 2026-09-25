/**
 * @fileoverview Tool to list available Census Bureau datasets and their vintage years.
 * @module mcp-server/tools/definitions/census-list-datasets
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { DATASET_AVAILABLE_YEARS } from '@/services/variable-cache/variable-cache-service.js';

/**
 * Static dataset catalog. Census dataset metadata doesn't change frequently. Vintages are not
 * repeated here — `DATASET_AVAILABLE_YEARS` is what the query path validates against, so
 * advertising a second list would let the two drift.
 */
const DATASETS = [
  {
    datasetId: 'acs/acs5',
    name: 'American Community Survey 5-Year Estimates',
    description:
      'ACS 5-year estimates covering all geographies down to block group. Most reliable for small areas. The default for most use cases.',
  },
  {
    datasetId: 'acs/acs5/profile',
    name: 'ACS 5-Year Data Profiles',
    description:
      'Pre-computed ACS5 social, economic, housing, and demographic profiles. Simpler DP-prefix codes (e.g., DP03_0062E) covering ~80% of common queries. Recommended starting point.',
  },
  {
    datasetId: 'acs/acs5/subject',
    name: 'ACS 5-Year Subject Tables',
    description:
      'ACS5 subject tables with S-prefix codes. Organized by topic (income, poverty, education, housing). More readable than B-table codes.',
  },
  {
    datasetId: 'acs/acs1',
    name: 'American Community Survey 1-Year Estimates',
    description:
      'ACS 1-year estimates — more current but only covers geographies with 65,000+ population. Tracts, block groups, and most rural counties are not available. Note: 2020 ACS1 was not released due to COVID-19.',
  },
  {
    datasetId: 'acs/acs1/profile',
    name: 'ACS 1-Year Data Profiles',
    description:
      'ACS 1-year data profiles with DP-prefix codes. Same coverage restriction as ACS1 (65K+ population geographies only).',
  },
  {
    datasetId: 'acs/acs1/subject',
    name: 'ACS 1-Year Subject Tables',
    description:
      'ACS 1-year subject tables with S-prefix codes, organized by topic (income, poverty, education, housing). Same coverage restriction as ACS1 (geographies with 65,000+ population only), and no 2020 vintage, since the 2020 ACS1 was not released.',
  },
  {
    datasetId: 'acs/acs5/cprofile',
    name: 'ACS 5-Year Comparison Profiles',
    description:
      "ACS 5-year profile lines for the latest period beside the non-overlapping period five years earlier, with CP-prefix codes whose middle segment names the end year of the period — CP03_2024_062E is 2020–2024 median household income and CP03_2019_062E the same line for 2015–2019, both in the vintage year's dollars. The comparison profiles publish no margins of error: no M code exists for any estimate. Geography levels are us, state, county, place, and metropolitan/micropolitan statistical area, with no tract level.",
  },
  {
    datasetId: 'acs/acs1/cprofile',
    name: 'ACS 1-Year Comparison Profiles',
    description:
      'ACS 1-year profile lines for the vintage year beside the four years before it, with CP-prefix codes whose middle segment names the year — CP03_2024_062E is 2024 median household income. The 2020 columns come back as not applicable, since the 2020 ACS1 was not released. The comparison profiles publish no margins of error: no M code exists for any estimate. Same coverage restriction as ACS1 (geographies with 65,000+ population only).',
  },
  {
    datasetId: 'acs/acsse',
    name: 'ACS 1-Year Supplemental Estimates',
    description:
      'A small set of ACS 1-year tables with K-prefix codes (e.g., K200101_001E, total population by sex), published for geographies with 20,000+ population — smaller areas than the 1-year estimates reach, with far fewer tables. Estimates carry margins of error at the matching M code. No 2020 vintage.',
  },
  {
    datasetId: 'acs/acs1/spp',
    name: 'ACS 1-Year Selected Population Profiles',
    description:
      'ACS 1-year S0201 profiles (e.g., S0201_001E, total population) for one race, ethnic, ancestry, or tribal group at a time. Every value is scoped by the predicate POPGROUP, and a query that omits it is answered for "Total population" — each row names the group under applied_filters. census_list_predicate_values on POPGROUP finds a group code by keyword, such as "filipino". Coverage follows the 1-year estimates, and a group is published only where it is large enough. The 2008 and 2010 vintages exist upstream but are not listed: the Census API answers them with server errors.',
  },
  {
    datasetId: 'pep/charv',
    name: 'Population Estimates Program',
    description:
      'Annual population estimates between decennial censuses, including age, sex, race, and Hispanic origin characteristics. 2023 is the only vintage: the 2020 through 2023 estimates all live inside it, reached through the YEAR filter rather than through the year parameter, which accepts 2023 alone. Filters on SEX, AGE, HISP, POPGROUP, and YEAR; the first four default to their all-categories total, but YEAR defaults to 2020, so set it explicitly to get the year you want — predicates {"YEAR": "2022"} for the 2022 estimate. Separate from the filters, 2020 carries two records per geography — an April 1 estimates base and a July 1 estimate — so a query that pins neither returns two rows with different numbers. MONTH is what separates them, and each row carries it: pass predicates {"MONTH": "7"} for the July estimate or "4" for the April base. census_list_predicate_values enumerates the codes each dimension takes.',
  },
  {
    datasetId: 'dec/pl',
    name: 'Decennial Census Redistricting Data (P.L. 94-171)',
    description:
      'Decennial Census population and housing unit counts used for congressional redistricting. Most granular geography coverage.',
  },
  {
    datasetId: 'dec/dhc',
    name: 'Decennial Census Demographic and Housing Characteristics File (DHC)',
    description:
      '2020 Census counts by age, sex, race, Hispanic origin, household type, and tenure, down to the block for many tables — the file for questions dec/pl cannot answer, such as population by age and sex for a tract (P12_001N is the total of that table). No filter dimension, so each geography comes back on one row.',
  },
  {
    datasetId: 'dec/dp',
    name: 'Decennial Census Demographic Profile',
    description:
      '2020 Census profile of population and housing characteristics. Each line is published as a count with the C suffix (DP1_0001C, total population) and a percent with the P suffix (DP1_0001P).',
  },
  {
    datasetId: 'dec/sdhc',
    name: 'Decennial Census Supplemental Demographic and Housing Characteristics File (S-DHC)',
    description:
      '2020 Census household and family characteristics for the nation and the states only — geography levels us and state. Each cell is published three ways: the estimated count in its COL1 code (e.g., PH7_COL1_R1, population in occupied housing units) and the low and high ends of its 90% interval in the matching COL2 and COL3 codes.',
  },
  {
    datasetId: 'dec/ddhca',
    name: 'Detailed Demographic and Housing Characteristics File A (DDHC-A)',
    description:
      'Detailed demographic and housing characteristics from the Decennial Census, published per detailed race and ethnic group. Every value is scoped by the predicate POPGROUP, and there is no code for all groups combined — the "Total population" code 001 that appears in the dataset dictionary returns nothing at any level. A query that omits POPGROUP is answered with one group the API picks rather than an error, so read the applied_filters label on each row before treating a number as a population total, and use dec/pl P1_001N when the total is what is wanted. census_list_predicate_values on POPGROUP finds a group code by keyword.',
  },
  {
    datasetId: 'cbp',
    name: 'County Business Patterns',
    description:
      'Annual establishment counts, employment, and payroll for employer businesses, broken out by industry. Queries must set the predicates NAICS2017 (industry; vintages before 2017 use NAICS2012), LFO (legal form of organization), and EMPSZES (employment size class) — omitting one returns the total across every category of it rather than an error, and census_list_predicate_values enumerates the codes each one takes. Geography levels are us, state, county, metropolitan/micropolitan statistical area, combined statistical area, congressional district, and zip code; census_resolve_geography turns a name into a code for the state, county, metropolitan/micropolitan statistical area, and combined statistical area levels of that set. A congressional district is its zero-padded district number, queried with parent_fips set to the state — "00" for an at-large seat, "98" for the District of Columbia\'s delegate — and follows the congress of the vintage (the 118th in 2021, the 119th in 2023). A zip code is the 5-digit ZIP itself, queried with no parent, and us takes the literal value 1. The Census API publishes vintages back to 1986, but only those listed here accept the NAME column every query here requests.',
  },
  {
    datasetId: 'ecnbasic',
    name: 'Economic Census',
    description:
      'Industry statistics collected every five years — establishments, revenue, payroll, and employment by industry. Queries must set the predicates NAICS2022 (industry; NAICS2017 in the 2017 vintage), TAXSTAT (tax status), and TYPOP (type of operation) — census_list_predicate_values enumerates the codes each one takes, and TAXSTAT and TYPOP are published per industry, so pass within_naics to see theirs. An unset NAICS is not an all-industry total here: at the national and state levels the API answers with one sector alone — Construction in the 2022 vintage, Mining, quarrying, and oil and gas extraction in 2017 and 2012 — and at finer levels it often returns nothing at all. Each row carries the applied sector under applied_filters, so read it rather than assuming which one this vintage picks. Geography levels in 2022 are us, region, state, county, consolidated city, metropolitan/micropolitan statistical area, metropolitan division, combined statistical area, and economic place; the 2017 and 2012 vintages publish place instead of economic place, keyed by the plain 5-digit place code. census_resolve_geography turns a name into a code for the state, county, place, consolidated city, metropolitan/micropolitan statistical area, combined statistical area, and economic place levels of that set. region is one of four fixed codes — 1 Northeast, 2 Midwest, 3 South, 4 West — and the Economic Census publishes regions for the Construction sector only; metropolitan division needs a code from another source and a CBSA parent that census_query_data has no input for; and us takes the literal value 1.',
  },
  {
    datasetId: 'nonemp',
    name: 'Nonemployer Statistics',
    description:
      'Businesses with no paid employees — sole proprietors, self-employed, and other single-person operations that County Business Patterns excludes. Queries must set the predicates NAICS2022 (industry; earlier vintages use the NAICS revision of their year), LFO (legal form of organization), and RCPSZES (receipts size class) — omitting one returns the total across every category of it rather than an error, and census_list_predicate_values enumerates the codes each one takes. The 1997 through 2007 vintages declare only the industry dimension, and publish no label for it, so their rows carry no applied_filters at all. Geography levels are us, state, county, metropolitan/micropolitan statistical area, and combined statistical area; census_resolve_geography turns a name into a code for every one of those but us, which takes the literal value 1. The 2008 through 2011 vintages exist upstream but reject the NAME column every query here requests, so they are not listed.',
  },
];

export const censusListDatasets = tool('census_list_datasets', {
  title: 'List Census Datasets',
  description:
    'Browse available Census Bureau datasets with their supported vintage years. Use as the starting point when the right dataset is unknown — ACS5, ACS1, and their profile, subject, and comparison tables, population estimates, the decennial census files, and the business datasets (County Business Patterns, Economic Census, Nonemployer Statistics) serve different use cases. Pass the dataset_id value to the dataset parameter in other census tools. Each description names the predicates a dataset requires and the geography levels it publishes, both of which vary by dataset.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    filter: z
      .string()
      .optional()
      .describe('Keyword to filter datasets by name or description. Omit to list all datasets.'),
  }),
  output: z.object({
    datasets: z
      .array(
        z
          .object({
            dataset_id: z
              .string()
              .describe(
                'Dataset code to pass to the dataset parameter in other tools (e.g., "acs/acs5", "acs/acs5/profile").',
              ),
            name: z.string().describe('Human-readable dataset name.'),
            description: z
              .string()
              .describe('Description of the dataset including coverage and use case guidance.'),
            available_years: z
              .array(z.number())
              .describe(
                'Vintage years this dataset can be queried for. Passing any other year to census_query_data, census_compare_geographies, or census_search_variables fails with year_not_available rather than returning data — the list is exhaustive, not a sample. It is narrower than what the Census API hosts: pep/charv publishes its 2020-2022 estimates inside the 2023 vintage under the YEAR filter, the cbp and nonemp vintages left out reject the NAME column every query here sends, and the Census API answers the acs/acs1/spp 2008 and 2010 vintages with server errors.',
              ),
          })
          .describe('A single Census dataset entry.'),
      )
      .describe('Matching Census datasets.'),
  }),

  enrichment: {
    totalCount: z.number().describe('Total number of matching datasets.'),
    filterApplied: z
      .string()
      .optional()
      .describe('Filter keyword applied to the dataset list, when provided.'),
    notice: z.string().optional().describe('Guidance when no datasets matched the filter keyword.'),
  },

  handler(input, ctx) {
    ctx.log.info('Listing Census datasets', { filter: input.filter });

    let results = DATASETS;
    const filterTrimmed = input.filter?.trim();

    if (filterTrimmed) {
      const filterLower = filterTrimmed.toLowerCase();
      results = DATASETS.filter(
        (d) =>
          d.name.toLowerCase().includes(filterLower) ||
          d.description.toLowerCase().includes(filterLower) ||
          d.datasetId.toLowerCase().includes(filterLower),
      );
    }

    ctx.enrich({
      totalCount: results.length,
      ...(filterTrimmed && { filterApplied: filterTrimmed }),
    });
    if (results.length === 0) {
      ctx.enrich.notice(
        `No datasets matched "${filterTrimmed}". Try a broader keyword like "acs" or omit the filter to list all.`,
      );
    }

    return {
      datasets: results.map((d) => ({
        dataset_id: d.datasetId,
        name: d.name,
        description: d.description,
        available_years: DATASET_AVAILABLE_YEARS[d.datasetId] ?? [],
      })),
    };
  },

  format: (result) => {
    const lines: string[] = [`**${result.datasets.length} datasets**\n`];
    for (const d of result.datasets) {
      lines.push(`### ${d.name}`);
      lines.push(`**ID:** \`${d.dataset_id}\``);
      lines.push(d.description);
      lines.push(`**Years:** ${d.available_years.join(', ')}\n`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
