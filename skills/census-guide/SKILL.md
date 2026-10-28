---
name: census-guide
description: "Census Bureau data through the census_* tools: choose the dataset and vintage a question needs, find variable codes for lay concepts (rent burden, poverty rate), reach geographies census_resolve_geography cannot name (New England towns, tribal areas), and read ACS margins of error before ranking places, comparing a tract with its county, or comparing years. Use before answering from census_query_data or census_compare_geographies numbers."
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

The census_* tools read the Census Bureau Data API: the American Community Survey (ACS) 1-year and 5-year families, the Population Estimates Program's 2023 vintage, the 2000, 2010, and 2020 decennial files, and the business datasets (County Business Patterns, Economic Census, Nonemployer Statistics). Census microdata (PUMS) and the Island Areas files are not served.

Dataset discovery, variable search and lookup, geography resolution, and geography listing need no key. census_query_data and census_compare_geographies read the data API, which needs a CENSUS_API_KEY configured on the server. So does census_list_predicate_values for a dimension it enumerates against the data endpoint; one answered from the dataset dictionary (NAICS, POPGROUP) needs no key. A key error is fixed in the server's configuration, not by retrying the call.

## Identifiers

| Identifier | Where it comes from |
|:-----------|:--------------------|
| Dataset code and vintage | census_list_datasets. Its available years are the only years the other tools accept. |
| Variable code | Search census_search_variables with a table ID (B25070, S1701) to get the whole table in code order, then confirm the exact code with census_get_variable in every vintage the query will use. Search matches whole words, so use the Census wording in the vocabulary table below rather than a lay term. |
| FIPS for state, county, place, tract, ZCTA, metro/micro area, combined statistical area, consolidated city, economic place | census_resolve_geography. |
| Code for any other level (county subdivision, American Indian area, congressional district, school district, urban area, and the rest) | No resolver. Enumerate it: see "Levels the resolver cannot name" below. |

## Gates

**Pick the survey before the variable.**
- ACS 1-year covers only geographies of 65,000 or more people, and the ACS 1-year Supplemental Estimates (acs/acsse, K-prefixed tables) geographies of 20,000 or more. Everything smaller is in the ACS 5-year family.
- A 5-year estimate describes its whole period, not its last year: report acs/acs5 2024 as "2020–2024", never as "2024".
- Compare 1-year estimates only with 1-year estimates and 5-year only with 5-year, even when a larger area also has a 1-year figure.
- pep/charv publishes no place, tract, or other sub-county level. A city's population comes from dec/pl (2020 count) or the ACS (an estimate with a margin). Name which source a figure came from, and do not mix sources inside one comparison.

**Read the margin before claiming a difference.**
- Request the margin-of-error code (M suffix) beside every ACS estimate (E suffix) the answer relies on, except on the comparison profiles, which publish none.
- ACS margins are 90 percent confidence intervals; the standard error is the margin divided by 1.645.
- Call two ACS estimates different only when |X1 − X2| > √(MOE1² + MOE2²). Do not treat overlapping or non-overlapping intervals as the test; compute it.
- In a ranking, run that test on any pair whose order the answer leans on. Two places whose difference fails it are not distinguishable, whatever their ranks.

**Change over time.**
- Consecutive 5-year estimates share four years of data. Compare 5-year periods that do not overlap (2015–2019 with 2020–2024), or 1-year with 1-year.
- Prefer the comparison profiles (acs/acs5/cprofile, acs/acs1/cprofile) for change questions: the earlier period is restated in the vintage's dollars, and each line has a significance column ending in SS, marked `*` where the change is statistically significant at 90 percent and empty where it is not.
- The 5-year comparison profiles cover only geographies of 5,000 or more people. A smaller county or place has no row there; fall back to two non-overlapping acs/acs5 vintages and the test above.
- ACS dollar values are in the inflation-adjusted dollars the label names ("in 2024 inflation-adjusted dollars"). Before comparing dollars across vintages outside the comparison profiles, adjust the earlier figure with the CPI-U-RS ratio of the two years.

**Boundaries change between vintages.**
- Connecticut's county level is nine planning regions (county codes 110–190) from the 2022 ACS vintage onward, replacing the old counties. Connecticut county figures do not line up across that break.
- ACS vintages from 2020 onward, and the 2020 decennial files, use 2020 census tracts. Do not compare a tract across that break by its code: the 2010-based tracts of 2019 and earlier vintages were redrawn.

**Before ranking an enumerated level, drop placeholder rows.** County subdivision listings include rows named "County subdivisions not defined", with code 00000 and a population of 0. They distort a ranking unless removed, and an ascending sort puts them first.

## Workflows

### A small area against its containers

For "this tract against its county and state", call census_query_data three times with the same dataset, year, and E and M codes: the tract (with its state, county, and tract codes from census_resolve_geography), then the county, then the state. census_compare_geographies ranks within one level only. Apply the difference test to each pair.

### Levels the resolver cannot name

1. Call census_list_geographies for the dataset and year to get the level's exact name and the parents it requires.
2. Call census_query_data at that level with geography_fips `"*"`, requesting `GEO_ID`, and supply the parents the level still requires. With `"*"` some levels need fewer parents than a single code does: on the 2020 decennial files county subdivision needs only the state, and the national American Indian area/Alaska Native area/Hawaiian home land level needs none.
3. Pick the row by its geography name, then carry its code and the same parents into the real query, or pass its GEOID to census_compare_geographies.

New England towns are county subdivisions ("Brookline town, Norfolk County, Massachusetts"), not places. To rank every town in a state, call census_compare_geographies at county subdivision within the state, after dropping the placeholder rows.

### Derived measures

When the answer is a share the Census does not publish, sum the table's lines yourself:
- Use the table's own total as the denominator, minus any "Not computed" line.
- Before summing lines, check whether a profile (DP) or subject (S) table already publishes the share. A published percentage carries a better margin than one you derive.
- Margins for sums, shares, ratios, and percent change: [references/derived-estimates.md](references/derived-estimates.md).

### Vocabulary

Codes confirmed in the 2024 vintage; confirm each with census_get_variable in any other vintage before querying.

| Question | Census wording and code |
|:---------|:------------------------|
| Rent burden | "Gross rent as a percentage of household income", B25070 (acs/acs5): lines _007E–_010E are 30.0 percent or more, _011E is "Not computed" |
| Median rent burden | B25071_001E (acs/acs5) |
| Owner cost burden | "Selected monthly owner costs as a percentage of household income", B25091 (acs/acs5): with a mortgage _008E–_011E, without _019E–_022E at 30.0 percent or more; _012E and _023E are "Not computed" |
| Poverty rate | S1701_C03_001E (acs/acs5/subject) |
| Median household income | B19013_001E (acs/acs5) |
| Unemployment rate | S2301_C04_001E (acs/acs5/subject) |
| Uninsured rate | S2701_C05_001E, "Percent Uninsured" (acs/acs5/subject) |
| Bachelor's degree or higher, age 25+ | S1501_C02_015E (acs/acs5/subject); full detail in B15003 (acs/acs5) |
| Renter-occupied share | DP04_0047PE (acs/acs5/profile) |

## References

- [references/derived-estimates.md](references/derived-estimates.md): margin-of-error formulas for estimates you derive from published ones.
