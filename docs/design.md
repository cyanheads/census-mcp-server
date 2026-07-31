# census-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations | Errors |
|:-----|:------------|:-----------|:------------|:-------|
| `census_search_variables` | Search ACS variables by keyword across labels and concepts. Returns variable codes with human-readable labels, enabling the agent to go from "median income" to `B19013_001E`. | `query`, `dataset`, `year`, `limit` | `readOnlyHint: true`, `openWorldHint: false` | `dataset_not_found` (NotFound), `variables_unavailable` (ServiceUnavailable, retryable) |
| `census_get_variable` | Fetch full metadata for one or more variable codes — label, concept, type, universe. Confirms a code before querying. | `variables[]`, `dataset`, `year` | `readOnlyHint: true`, `openWorldHint: false` | `variable_not_found` (NotFound), `dataset_not_found` (NotFound), `variables_unavailable` (ServiceUnavailable, retryable) |
| `census_resolve_geography` | Resolve a place name or address to Census FIPS identifiers. Converts "King County, WA" or "Seattle, WA" to state/county FIPS codes. Required before calling `census_query_data` or `census_compare_geographies` unless FIPS codes are already known. | `name`, `geography_type` | `readOnlyHint: true`, `openWorldHint: false` | `no_match` (NotFound), `ambiguous_name` (InvalidParams), `resolution_unavailable` (ServiceUnavailable, retryable) |
| `census_query_data` | Query a Census dataset for one or more variables at a specific geography. Requires FIPS codes for the target geography — use `census_resolve_geography` first to convert place names. Returns labeled estimates with margin-of-error columns alongside each estimate. | `variables[]`, `geography_level`, `geography_fips`, `parent_fips`, `dataset`, `year` | `readOnlyHint: true`, `openWorldHint: false` | `missing_api_key` (Unauthorized), `variable_not_found` (InvalidParams), `geography_not_supported` (InvalidParams), `parent_required` (InvalidParams), `no_data` (NotFound), `too_many_variables` (InvalidParams), `upstream_error` (ServiceUnavailable, retryable) |
| `census_list_geographies` | List the geography levels available for a dataset and year — which levels (county, tract, block group, etc.) are supported and what parent geographies are required. | `dataset`, `year` | `readOnlyHint: true`, `openWorldHint: false` | `dataset_not_found` (NotFound), `year_not_available` (InvalidParams) |
| `census_list_datasets` | Browse available Census datasets with vintages. Returns dataset codes, descriptions, and available years — the starting point for exploring what data exists. | `filter` | `readOnlyHint: true`, `openWorldHint: false` | none (static metadata) |
| `census_compare_geographies` | Compare one or more variables across a set of geographies at the same level. Useful for "compare poverty rates across states" or "rank counties by median income." Returns a sorted table with all geographies and values. | `variables[]`, `geography_level`, `within`, `geographies`, `dataset`, `year`, `sort_by`, `sort_dir`, `limit` | `readOnlyHint: true`, `openWorldHint: false` | `missing_api_key` (Unauthorized), `geography_not_supported` (InvalidParams), `parent_required` (InvalidParams), `variable_not_found` (InvalidParams), `no_data` (NotFound), `upstream_error` (ServiceUnavailable, retryable) |

### Resources

No resources. All data access is covered by the tool surface. The variable and geography systems are query-driven rather than addressable by stable URI, making resources a poor fit. A tool-only agent can accomplish everything the server is for.

### Prompts

No prompts. The server is data-oriented; the tool descriptions carry sufficient operational guidance.

---

## Overview

census-mcp-server provides access to US Census Bureau demographic, economic, and housing data via the Census Bureau Data API (`https://api.census.gov/data`). It exposes four core dataset families — ACS 5-Year, ACS 1-Year, Population Estimates, and Decennial Census — through a tool surface that abstracts the Census API's most significant usability barriers: opaque variable codes and FIPS geography requirements.

The primary design challenge is the variable system. The ACS5 2024 dataset alone has 28,475 variables with codes like `B19013_001E`. An agent can't know that `B19013_001E` is median household income without discovery tooling. The tool surface puts variable search first, makes it fast, and allows agents to confirm codes before querying.

The secondary challenge is geography. The Census API requires FIPS codes (`for=county:033&in=state:53`), but agents and users think in place names. `census_resolve_geography` bridges this, and is a mandatory first step for any agent that doesn't already have FIPS codes in hand.

Target users: agents doing demographic research, policy analysis, market sizing, geographic comparison, and any workflow that needs population, income, housing, or economic statistics for a US geography.

---

## Requirements

- API key required for all data queries (302 redirect without key — the API no longer supports unauthenticated data access at any rate limit)
- TIGERweb and Census Geocoder endpoints used for geography resolution — no API key required for these
- Rate limits: documented as 500 req/day without key (now moot — key required), higher with key; no hard-coded per-minute cap documented
- Read-only server — no write operations exist in the Census API
- Core datasets in scope: ACS 5-Year (`acs/acs5`), ACS 1-Year (`acs/acs1`), Population Estimates (`pep/charv`), Decennial 2020 (`dec/pl`, `dec/ddhca`)
- Latest vintages as of implementation: ACS5 2024, ACS1 2024, PEP 2023
- ACS5 sub-tables in scope: detailed tables (`acs5`), data profiles (`acs5/profile`), subject tables (`acs5/subject`) — profiles cover ~80% of common queries with simpler DP-prefix codes
- Variable search operates client-side against the variables.json endpoint (28K+ variables, cached) — no Census search API exists
- Geography resolution uses TIGERweb MapServer REST API for named places, and Census Geocoder for address-to-geography lookup

---

## Domain Mapping

| Noun | Operations |
|:-----|:-----------|
| Variable | search by keyword, get metadata by code(s), resolve human concept → codes |
| Dataset | list available, list vintages, get geography levels for a dataset |
| Geography | resolve name/address → FIPS, list hierarchy levels |
| Data | query by variable + geography + year, compare across multiple geographies |

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `CensusApiService` | Census Data API (`api.census.gov/data`) | `census_query_data`, variable endpoints |
| `VariableCacheService` | Variables.json endpoints (per dataset + year) | `census_search_variables`, `census_get_variable` |
| `GeographyService` | TIGERweb MapServer REST, Census Geocoder | `census_resolve_geography` |

### Service notes

**VariableCacheService:** Variables.json files are large (28K+ entries, several MB). Cache them in-process with a TTL of 24 hours — the files change only when new vintages release. Warm on first request per (dataset, year) pair; subsequent requests are in-memory lookups. The search is a client-side keyword match against `label` and `concept` fields.

**GeographyService:** TIGERweb provides named-place → FIPS resolution without an API key. The geocoder resolves street addresses → census geographies (state, county, tract, block group). Both are free-tier with no documented rate limits but should share the service's retry/backoff wrapper.

**CensusApiService:** All data requests require the API key as `&key=...`. HTTP 302 → missing_key.html is the error when key is absent or invalid. Parse the actual JSON array response: Census returns `[["NAME","B19013_001E","state","county"], ["King County, Washington","98144","53","033"]]` — first row is headers, subsequent rows are data.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `CENSUS_API_KEY` | Yes | Census Bureau API key. Request free at https://api.census.gov/data/key_signup.html |
| `CENSUS_DEFAULT_YEAR` | No | Default vintage year for queries. Defaults to latest available ACS5 vintage (currently 2024). |
| `CENSUS_VARIABLE_CACHE_TTL_HOURS` | No | Hours to cache variables.json per dataset+year. Defaults to 24. |

---

## Implementation Order

1. Config and server setup (`CENSUS_API_KEY`, `CENSUS_DEFAULT_YEAR`)
2. `CensusApiService` — data query, response parsing (header row + data rows → labeled objects)
3. `GeographyService` — TIGERweb name resolution, Census Geocoder address resolution
4. `VariableCacheService` — fetch + cache variables.json, keyword search
5. `census_list_datasets` and `census_list_geographies` (metadata tools, no key required)
6. `census_search_variables` and `census_get_variable` (read variable cache)
7. `census_resolve_geography` (geographic resolution)
8. `census_query_data` (core data query, uses all three services)
9. `census_compare_geographies` (builds on `census_query_data` with multi-geography fan-out)

Each step is independently testable. Steps 5–6 can be tested without a Census API key using the public metadata endpoints.

---

## Tool Detail

### `census_list_datasets`

**Description:** Browse available Census datasets with their supported vintage years. Returns dataset codes, human-readable names, and descriptions. Use this as the starting point when you don't know which dataset to query — ACS5, ACS1, population estimates, and decennial census all serve different use cases.

**Input:**
- `filter?: string` — optional keyword to filter datasets by name or description

**Output:** Array of `{ dataset_id, name, description, available_years }`. `dataset_id` is the value to pass to `dataset` in other tools (e.g., `"acs/acs5"`, `"acs/acs5/profile"`).

**Errors:**
- *(none — static metadata, always succeeds)*

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`

---

### `census_list_geographies`

**Description:** List the geography levels available for a given dataset and year, along with the parent geographies each level requires. Use before querying to confirm that the target geography level exists in the dataset — ACS1 omits many sub-state levels, and not all datasets support tracts or block groups.

**Input:**
- `dataset: string` — dataset code (e.g., `"acs/acs5"`, `"acs/acs1"`) — use `census_list_datasets` to discover valid values
- `year?: number` — vintage year (default: latest available for the dataset)

**Output:** Array of `{ geography_level, requires_parent, example }`. `geography_level` values (e.g., `"county"`, `"tract"`, `"zip code tabulation area"`) are the valid inputs to `geography_level` in `census_query_data` and `census_compare_geographies`.

**Errors:**
- `dataset_not_found` (NotFound) — unrecognized dataset code. Recovery: call `census_list_datasets` to find valid codes.
- `year_not_available` (InvalidParams) — dataset exists but the requested year has no data. Recovery: check `available_years` from `census_list_datasets`.

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`

---

### `census_search_variables`

**Description:** Search Census variables by keyword across variable labels and concept groups. Returns variable codes with human-readable labels — use this to go from a concept like "median household income" to the variable code `B19013_001E` needed for data queries. Returns both estimate (`E` suffix) and margin-of-error (`M` suffix) codes so you can request both.

**Input:**
- `query: string` — keyword to search (e.g., "median household income", "poverty", "bachelor's degree")
- `dataset?: string` — dataset to search within (default: `"acs/acs5"`)
- `year?: number` — vintage year (default: latest available)
- `limit?: number` — max results to return (default: 20, max: 100)

**Output:** Array of `{ variable_code, label, concept, predicateType }` sorted by relevance. `variable_code` is the value to pass to `census_query_data`. When results are truncated, `total_matches` indicates how many variables matched — narrow the query to see more specific results.

**Errors:**
- `dataset_not_found` (NotFound) — unrecognized dataset code. Recovery: call `census_list_datasets` for valid codes.
- `variables_unavailable` (ServiceUnavailable, retryable) — variables.json could not be fetched or parsed. Recovery: retry; if persistent, the dataset+year combination may not be available.

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`

---

### `census_get_variable`

**Description:** Fetch full metadata for one or more variable codes — label, concept group, predicateType, universe, and whether an annotation counterpart exists. Use to confirm a variable code before building a query, or to look up what a known code means.

**Input:**
- `variables: string[]` — one or more variable codes (e.g., `["B19013_001E", "B19013_001M"]`)
- `dataset?: string` — dataset the variables belong to (default: `"acs/acs5"`)
- `year?: number` — vintage year (default: latest available)

**Output:** Array of `{ variable_code, label, concept, predicateType, universe }` in the same order as the input array. Includes `estimate_code` and `moe_code` sibling references where applicable, so the agent can request both without a separate search.

**Errors:**
- `variable_not_found` (NotFound) — one or more codes not found in the dataset. Response includes which codes failed and suggests calling `census_search_variables` to find the correct code.
- `dataset_not_found` (NotFound) — unrecognized dataset code.
- `variables_unavailable` (ServiceUnavailable, retryable) — variables.json could not be fetched.

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`

---

### `census_resolve_geography`

**Description:** Resolve a place name to Census FIPS identifiers (state, county, place, tract codes). Converts "King County, WA" or "Seattle, WA" to the FIPS codes required by `census_query_data` and `census_compare_geographies`. Also accepts street addresses for tract-level resolution. Returns the FIPS values directly ready to pass to other tools.

**Input:**
- `name: string` — place name (e.g., "King County, WA", "Seattle, WA") or street address (e.g., "1600 Pennsylvania Ave NW, Washington, DC 20500")
- `geography_type?: string` — geography level to resolve to: `"state"`, `"county"`, `"place"`, `"tract"` (default: auto-detect from name)

**Auto-detection:** a two-letter abbreviation or a spelled-out state name (matched against the whole input, so "West Virginia University" is not a state) resolves at the state layer; `"County"`/`"Borough"`/`"Parish"` at the county layer; `"Tract"` at the tract layer. Everything else is tried at the place layer and falls back to county when the place layer has no row. Rows whose name is exactly the queried term win over longer `LIKE` matches, so "Kansas City, MO" resolves to Kansas City rather than North Kansas City. Whatever survives that filter must be a single row to resolve — two or more are distinct real geographies (bare "Boston" matches towns in IN, GA, and MA), so they come back as `ambiguous_name` rather than a coin flip. `"New York"` is a standing ambiguity — it is both the state name and the Census place name for New York City, so auto-detection resolves the state and the city needs `geography_type: "place"`.

**Output:** `{ name, geography_type, state_fips, county_fips?, tract_fips?, place_fips?, fips_summary }`. `fips_summary` is a pre-formatted string ready to use as `geography_fips` in `census_query_data` (e.g., `"033"` for a county, with `state_fips: "53"` as the parent). Always includes `state_fips` — the parent geography required by most sub-state queries.

**Errors:**
- `no_match` (NotFound) — no layer in the chain had a row for the name. Recovery names the state when the input already carried one; otherwise it asks for a state abbreviation, an explicit `geography_type`, or a full street address.
- `ambiguous_name` (ValidationError) — more than one geography matched. `candidates[]` carries `{ name, geographyType, stateFips, stateAbbr, countyFips?, tractFips? }` and the recovery hint lists them ready to re-query. Only the state layer returns `STUSAB`, so the abbreviation is derived by reversing the state FIPS table. Tract candidates repeat the same name within a state, so they are separated by county and the hint hands over `county_fips` for `census_query_data` instead of a re-query.
- `resolution_unavailable` (ServiceUnavailable, retryable) — TIGERweb or geocoder endpoint unreachable. Recovery: retry; both endpoints are free-tier with no auth requirements.

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`

---

### `census_query_data`

**Description:** Query a Census dataset for one or more variables at a specific geography. Requires FIPS codes for the target geography — call `census_resolve_geography` first to convert place names. Returns labeled estimates with margin-of-error values alongside each estimate. Suppression codes in the data (negative values like -666666666) indicate the geography is too small or the data was not collected — these are surfaced with their meaning rather than passed through as raw numbers.

**Input:**
- `variables: string[]` — variable codes to retrieve (e.g., `["B19013_001E", "B19013_001M"]`). Max 50 per request. Use `census_search_variables` to find codes. Always include the MOE counterpart (swap `E` → `M` suffix) to get margin-of-error alongside each estimate.
- `geography_level: string` — level of the target geography (e.g., `"county"`, `"tract"`, `"state"`, `"zip code tabulation area"`). Use `census_list_geographies` to see valid values for the dataset.
- `geography_fips: string` — FIPS code for the target geography at the requested level (e.g., `"033"` for a county, `"*"` for all geographies at that level within the parent). Use `census_resolve_geography` to obtain this value.
- `parent_fips?: string` — FIPS of the parent geography when the level requires one (e.g., state FIPS `"53"` when querying counties within WA). Required for sub-state levels. `census_resolve_geography` returns this as `state_fips`.
- `dataset?: string` — dataset to query (default: `"acs/acs5"`). Use `census_list_datasets` for valid values.
- `year?: number` — vintage year (default: latest available for the dataset)

**Output:** Array of result rows, each with `{ geography_name, geography_fips, variables: { [code]: { estimate, moe?, label, suppressed, suppression_reason? } } }`. Suppressed values include a human-readable `suppression_reason` (e.g., "geography too small for reliable estimate") rather than the raw negative sentinel. When `geography_fips` is `"*"`, returns all geographies at the level — results include `geography_fips` on each row for use in follow-up calls.

**Errors:**
- `missing_api_key` (Unauthorized) — `CENSUS_API_KEY` not configured or invalid. Recovery: set the env var and restart.
- `variable_not_found` (InvalidParams) — one or more variable codes don't exist in the dataset+year. Recovery: call `census_search_variables` or `census_get_variable` to confirm codes.
- `geography_not_supported` (InvalidParams) — the requested geography level is not available for this dataset and year. Recovery: call `census_list_geographies` to see supported levels.
- `parent_required` (InvalidParams) — the geography level requires a parent FIPS (e.g., county requires state FIPS) but none was provided. Recovery: add `parent_fips` — use `census_resolve_geography` to get it.
- `no_data` (NotFound) — the query returned no rows. Most common cause: ACS1 queried for a geography with fewer than 65K population, or a dataset+year combination that doesn't cover the requested level. Recovery: switch to `acs/acs5` or check `census_list_geographies`.
- `too_many_variables` (InvalidParams) — more than 50 variable codes requested. Recovery: split into multiple calls.
- `upstream_error` (ServiceUnavailable, retryable) — Census API returned an error or was unreachable. Recovery: retry; if persistent, the API may be down.

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`

---

### `census_compare_geographies`

**Description:** Compare one or more variables across multiple geographies at the same level — all counties in a state, all states nationally, or a named set of specific geographies. Returns a sorted ranked table. Use for "rank states by poverty rate", "compare median income across WA counties", or "which census tracts in King County have the highest renter rate."

**Input:**
- `variables: string[]` — variable codes to compare (e.g., `["B17001_002E", "B17001_001E"]`). Include MOE counterparts (`M` suffix) to get reliability context.
- `geography_level: string` — the level to compare across (e.g., `"state"`, `"county"`, `"tract"`). Use `census_list_geographies` to see valid values for the dataset.
- `within?: string` — FIPS of the parent geography to constrain results (e.g., state FIPS `"53"` to compare counties within WA only). Omit to compare all geographies at the level nationally. Use `census_resolve_geography` to get the FIPS.
- `geographies?: string[]` — optional list of specific geography FIPS codes to include. When provided, only these geographies are returned. Omit to return all geographies at the level within `within` (or nationally). Use `census_resolve_geography` for each place name to get its FIPS.
- `dataset?: string` — dataset to query (default: `"acs/acs5"`)
- `year?: number` — vintage year (default: latest available)
- `sort_by?: string` — variable code to sort by (default: first variable in the list)
- `sort_dir?: 'asc' | 'desc'` — sort direction (default: `'desc'`)
- `limit?: number` — max geographies to return (default: 50, max: 500). When results are truncated, `total_count` indicates how many geographies matched.

**Output:** `{ rows: [{ geography_name, geography_fips, variables: { [code]: { estimate, moe?, label, suppressed } } }], total_count, truncated }`. `geography_fips` on each row enables follow-up calls to `census_query_data` for more variables on a specific result. Suppressed values are labeled rather than passed through as raw sentinels.

**Errors:**
- `missing_api_key` (Unauthorized) — `CENSUS_API_KEY` not configured or invalid.
- `geography_not_supported` (InvalidParams) — geography level not available for this dataset+year. Recovery: call `census_list_geographies`.
- `parent_required` (InvalidParams) — the level requires a parent FIPS but `within` was not provided. Error message names which parent level is required.
- `variable_not_found` (InvalidParams) — one or more variable codes invalid for this dataset+year.
- `no_data` (NotFound) — no geographies returned. Most common: ACS1 + sub-state level, or `geographies` list contains codes that don't exist in the dataset.
- `upstream_error` (ServiceUnavailable, retryable) — Census API unreachable or returned an error.

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`

---

## Design Decisions

### Geography resolution is a mandatory first step, not a hidden convenience

`census_query_data` and `census_compare_geographies` require FIPS codes. They do not resolve place names internally. This is a deliberate choice:

1. Resolution is non-trivial — "King County" exists in multiple states. The resolution step should be visible to the agent so it can see and confirm what geography it's actually querying.
2. Hiding resolution inside `census_query_data` would duplicate `census_resolve_geography`'s function and make errors harder to diagnose — a name resolution failure mid-query is harder to surface cleanly than a failed pre-query resolution step.
3. Agents that already have FIPS codes (from a prior resolution call or from other data) skip the extra step without any penalty.

`census_resolve_geography` is the mandatory bridge from place names to FIPS. The workflow is: `census_resolve_geography` → FIPS codes → `census_query_data` or `census_compare_geographies`.

### Why not accept human-readable concepts directly in `census_query_data`?

Early consideration was to make `census_query_data` accept a `concepts` parameter like `["median household income", "poverty rate"]` and resolve internally. This was rejected because:

1. Resolution is ambiguous — "median income" matches 34 variables across different subgroups (by race, household size, etc.)
2. The resolution step is genuinely useful to surface to the agent, not hide — the agent should see and confirm the codes it's querying
3. It conflates two operations that benefit from being separate: search (exploratory) and query (precise)

The workflow is: `census_search_variables` → agent picks codes → `census_query_data`. This is one extra step but avoids silent mismatches.

### ACS1 vs ACS5: surface the distinction, don't hide it

ACS1 is more current (one-year reference period) but only covers geographies with 65K+ population — tracts, block groups, and small counties don't exist. ACS5 covers everything down to block group. Hiding this behind a single `dataset` parameter would silently return empty results for small geographies queried against ACS1. The design surfaces the dataset choice explicitly with descriptions that explain the tradeoff, and `census_list_geographies` shows which levels a given dataset+year supports.

### Data profiles (DP tables) vs detailed tables (B tables)

ACS5 has four sub-table types. Data profiles (`acs5/profile`, DP-prefix codes like `DP03_0062E`) cover the most common social, economic, demographic, and housing metrics with ~1,400 variables that are more human-readable than B-table codes. Detailed tables have 28K+ variables for cross-tabulated deep dives. The design doesn't hide this distinction — `census_search_variables` searches across the specified sub-table, and the tool descriptions explain when each is appropriate.

### Why `census_compare_geographies` instead of multiple `census_query_data` calls?

The comparison workflow — ranking states by poverty rate, comparing counties on median income — is a very common pattern that requires querying one variable across many geographies. A single `census_query_data` call with `geography_fips: "*"` returns all geographies at a level; `census_compare_geographies` generalizes this pattern and adds sorting, labeling, and truncation with counts so the agent gets a ranked table rather than raw rows. It's implemented as fan-out across `census_query_data` internally when multi-dataset comparison is needed, or a single wildcard query when all geographies are within one dataset.

### Variable search is client-side, not a Census API feature

The Census API does not provide a variable search endpoint. `census_search_variables` fetches and caches the full `variables.json` for the requested dataset+year, then does keyword matching in-process against `label` and `concept` fields. The cache TTL (default 24h) means the first request per dataset+year is slow (several MB JSON download), but subsequent searches are instant. This is the only viable approach given the API's design.

---

## Workflow Analysis

### Primary workflow: "What's the median household income in King County, WA?"

| # | Call | Tool | Purpose |
|:--|:-----|:-----|:--------|
| 1 | Search for variable | `census_search_variables` | Query "median household income", identify `B19013_001E` |
| 2 | Resolve geography | `census_resolve_geography` | "King County, WA" → state_fips: `53`, county_fips: `033` |
| 3 | Query data | `census_query_data` | geography_level: `county`, geography_fips: `033`, parent_fips: `53` |

Three calls total. If the agent already knows the variable code, steps 1–2 collapse to one. If the agent already has FIPS, step 2 is skipped entirely.

### Secondary workflow: "Compare poverty rates across all states"

| # | Call | Tool | Purpose |
|:--|:-----|:-----|:--------|
| 1 | Search variables | `census_search_variables` | Find poverty rate variable(s): `B17001_002E` + `B17001_001E` |
| 2 | Compare | `census_compare_geographies` | geography_level: `state`, no `within` (all states), sort by derived rate |

Two calls. `census_compare_geographies` handles the wildcard state query and sorting internally.

### Discovery workflow: "What ACS data exists for ZIP codes?"

| # | Call | Tool | Purpose |
|:--|:-----|:-----|:--------|
| 1 | List geographies | `census_list_geographies` | Check if ZIP code tabulation areas are a supported level for `acs/acs5` |
| 2 | List datasets | `census_list_datasets` | Find which dataset/year combinations cover ZCTAs |
| 3 | Search variables | `census_search_variables` | Find relevant variables for the ZCTA dataset |

Note: ACS5 supports ZCTAs (`zip code tabulation area`), but the geography name in the API is not "zip code" — `census_list_geographies` surfaces the correct term.

---

## API Reference

### Query structure

```
GET https://api.census.gov/data/{year}/{dataset}?get={vars}&for={geo}&in={parent_geo}&key={key}
```

- `{year}`: e.g., `2024`
- `{dataset}`: e.g., `acs/acs5`, `acs/acs1`, `acs/acs5/profile`, `acs/acs5/subject`
- `{vars}`: comma-separated variable codes, max 50 per request, always include `NAME`
- `for={level}:{code}`: e.g., `county:033`, `county:*` (wildcard), `state:*`
- `in={level}:{code}`: parent geography filter, e.g., `in=state:53`
- `key={key}`: required for all data queries

### Response format

JSON array, first row = column headers, subsequent rows = data:
```json
[
  ["NAME", "B19013_001E", "state", "county"],
  ["King County, Washington", "98144", "53", "033"]
]
```

Values are strings. Negative values (-666666666, -222222222, etc.) are Census suppression/unavailability codes, not real data.

### Variable code anatomy

`B19013_001E`:
- `B` prefix: Base table (detailed). `C` = collapsed. `DP` = data profile. `S` = subject table.
- `19013`: Table number (household income)
- `_001`: Cell/line within the table
- `E`: Estimate. `M` = margin of error. `EA` = estimate annotation. `MA` = MOE annotation.

### Geography hierarchy and FIPS

Census geographies nest: us → region → division → state → county → tract → block group. Lower levels require parent FIPS in the `in=` parameter. County FIPS are 3-digit (zero-padded), state FIPS are 2-digit, tracts are 6-digit.

TIGERweb endpoint for county lookup:
```
GET https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query
  ?where=NAME LIKE '%King%'&outFields=NAME,STATE,COUNTY&f=json
```

### Suppression codes

| Code | Meaning |
|:-----|:--------|
| -666666666 | Not available (geography too small, data not collected) |
| -222222222 | Not applicable |
| -888888888 | Estimate revised or superseded |
| -999999999 | Median falls in upper or lower open-ended interval |

---

## Known Limitations

- **API key required, no free tier.** As of 2025, the Census API enforces key authentication on all data queries. The key signup is free but required.
- **Variable search is approximate.** With 28K+ variables, keyword search returns many results. Agents should confirm codes via `census_get_variable` before relying on them in queries.
- **ACS1 geographic coverage gap.** ACS1 only covers geographies with 65K+ population. Tracts, block groups, most rural counties, and small cities don't exist in ACS1. The tool descriptions and `census_list_geographies` surface this, but agents querying small geographies against ACS1 will get empty results.
- **Margin of error is not a guarantee.** ACS data is survey-based. MOE values can be larger than the estimate for small geographies or rare populations. The server returns MOE columns alongside estimates but doesn't validate statistical reliability.
- **50-variable limit per request.** The Census API caps `get=` at 50 variables per request. `census_query_data` enforces this and will error with guidance if exceeded. Requesting all demographics for a geography requires multiple calls.
- **No historical ACS1 for 2020.** ACS1 2020 was not released due to COVID-19 data collection disruptions. Querying 2020 ACS1 returns no data.
