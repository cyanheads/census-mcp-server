/**
 * @fileoverview Tool to list available Census Bureau datasets and their vintage years.
 * @module mcp-server/tools/definitions/census-list-datasets
 */

import { tool, z } from '@cyanheads/mcp-ts-core';

/** Static dataset catalog. Census dataset metadata doesn't change frequently. */
const DATASETS = [
  {
    datasetId: 'acs/acs5',
    name: 'American Community Survey 5-Year Estimates',
    description:
      'ACS 5-year estimates covering all geographies down to block group. Most reliable for small areas. The default for most use cases.',
    availableYears: [
      2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024,
    ],
  },
  {
    datasetId: 'acs/acs5/profile',
    name: 'ACS 5-Year Data Profiles',
    description:
      'Pre-computed ACS5 social, economic, housing, and demographic profiles. Simpler DP-prefix codes (e.g., DP03_0062E) covering ~80% of common queries. Recommended starting point.',
    availableYears: [
      2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024,
    ],
  },
  {
    datasetId: 'acs/acs5/subject',
    name: 'ACS 5-Year Subject Tables',
    description:
      'ACS5 subject tables with S-prefix codes. Organized by topic (income, poverty, education, housing). More readable than B-table codes.',
    availableYears: [
      2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024,
    ],
  },
  {
    datasetId: 'acs/acs1',
    name: 'American Community Survey 1-Year Estimates',
    description:
      'ACS 1-year estimates — more current but only covers geographies with 65,000+ population. Tracts, block groups, and most rural counties are not available. Note: 2020 ACS1 was not released due to COVID-19.',
    availableYears: [
      2005, 2006, 2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019,
      2021, 2022, 2023, 2024,
    ],
  },
  {
    datasetId: 'acs/acs1/profile',
    name: 'ACS 1-Year Data Profiles',
    description:
      'ACS 1-year data profiles with DP-prefix codes. Same coverage restriction as ACS1 (65K+ population geographies only).',
    availableYears: [
      2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024,
    ],
  },
  {
    datasetId: 'pep/charv',
    name: 'Population Estimates Program',
    description:
      'Annual population estimates between decennial censuses, including age, sex, race, and Hispanic origin characteristics. Filters on SEX, AGE, HISP, POPGROUP, and YEAR; the first four default to their all-categories total, but YEAR defaults to a single vintage and returns more than one row per geography, so set it explicitly to pin the year. census_list_predicate_values enumerates the codes each dimension takes.',
    availableYears: [2020, 2021, 2022, 2023],
  },
  {
    datasetId: 'dec/pl',
    name: 'Decennial Census Redistricting Data (P.L. 94-171)',
    description:
      'Decennial Census population and housing unit counts used for congressional redistricting. Most granular geography coverage.',
    availableYears: [2000, 2010, 2020],
  },
  {
    datasetId: 'dec/ddhca',
    name: 'Decennial Census Demographic and Housing Characteristics',
    description:
      'Detailed demographic and housing characteristics from the Decennial Census, published per detailed race and ethnic group. Every value is scoped by the predicate POPGROUP, and there is no code for all groups combined — the "Total population" code 001 that appears in the dataset dictionary returns nothing at any level. A query that omits POPGROUP is answered with one group the API picks rather than an error, so read the applied_filters label on each row before treating a number as a population total, and use dec/pl P1_001N when the total is what is wanted. census_list_predicate_values on POPGROUP finds a group code by keyword.',
    availableYears: [2020],
  },
  {
    datasetId: 'cbp',
    name: 'County Business Patterns',
    description:
      'Annual establishment counts, employment, and payroll for employer businesses, broken out by industry. Queries must set the predicates NAICS2017 (industry; vintages before 2017 use NAICS2012), LFO (legal form of organization), and EMPSZES (employment size class) — omitting one returns the total across every category of it rather than an error, and census_list_predicate_values enumerates the codes each one takes. Geography levels are us, state, county, metropolitan/micropolitan statistical area, combined statistical area, congressional district, and zip code; census_resolve_geography turns a name into a code for the state, county, metropolitan/micropolitan statistical area, and combined statistical area levels of that set — congressional district and zip code need a code from another source, and us takes the literal value 1. The Census API publishes vintages back to 1986, but only those listed here accept the NAME column every query here requests.',
    availableYears: [2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023],
  },
  {
    datasetId: 'ecnbasic',
    name: 'Economic Census',
    description:
      'Industry statistics collected every five years — establishments, revenue, payroll, and employment by industry. Queries must set the predicates NAICS2022 (industry; NAICS2017 in the 2017 vintage), TAXSTAT (tax status), and TYPOP (type of operation) — census_list_predicate_values enumerates the codes each one takes, and TAXSTAT and TYPOP are published per industry, so pass within_naics to see theirs. An unset NAICS is not an all-industry total here: at the national and state levels the API answers with one sector alone — Construction in the 2022 vintage, Mining, quarrying, and oil and gas extraction in 2017 and 2012 — and at finer levels it often returns nothing at all. Each row carries the applied sector under applied_filters, so read it rather than assuming which one this vintage picks. Geography levels are us, region, state, county, consolidated city, metropolitan/micropolitan statistical area, metropolitan division, combined statistical area, and economic place; census_resolve_geography turns a name into a code for the state, county, consolidated city, metropolitan/micropolitan statistical area, and combined statistical area levels of that set — region, metropolitan division, and economic place need a code from another source, and us takes the literal value 1.',
    availableYears: [2012, 2017, 2022],
  },
  {
    datasetId: 'nonemp',
    name: 'Nonemployer Statistics',
    description:
      'Businesses with no paid employees — sole proprietors, self-employed, and other single-person operations that County Business Patterns excludes. Queries must set the predicates NAICS2022 (industry; earlier vintages use the NAICS revision of their year), LFO (legal form of organization), and RCPSZES (receipts size class) — omitting one returns the total across every category of it rather than an error, and census_list_predicate_values enumerates the codes each one takes. The 1997 through 2007 vintages declare only the industry dimension, and publish no label for it, so their rows carry no applied_filters at all. Geography levels are us, state, county, metropolitan/micropolitan statistical area, and combined statistical area; census_resolve_geography turns a name into a code for every one of those but us, which takes the literal value 1. The 2008 through 2011 vintages exist upstream but reject the NAME column every query here requests, so they are not listed.',
    availableYears: [
      1997, 1998, 1999, 2000, 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2012, 2013, 2014, 2015,
      2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023,
    ],
  },
];

export const censusListDatasets = tool('census_list_datasets', {
  title: 'List Census Datasets',
  description:
    'Browse available Census Bureau datasets with their supported vintage years. Use as the starting point when the right dataset is unknown — ACS5, ACS1, population estimates, decennial census, and the business datasets (County Business Patterns, Economic Census, Nonemployer Statistics) serve different use cases. Pass the dataset_id value to the dataset parameter in other census tools. Each description names the predicates a dataset requires and the geography levels it publishes, both of which vary by dataset.',
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
              .describe('Vintage years available for this dataset.'),
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
        available_years: d.availableYears,
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
