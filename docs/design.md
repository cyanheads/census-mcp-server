# census-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations | Errors |
|:-----|:------------|:-----------|:------------|:-------|
| `census_search_variables` | Search ACS variables by keyword across labels and concepts. Returns variable codes with human-readable labels, enabling the agent to go from "median income" to `B19013_001E`. | `query`, `dataset`, `year`, `limit` | `readOnlyHint: true`, `openWorldHint: false` | `dataset_not_found` (NotFound), `year_not_available` (ValidationError), `variables_unavailable` (ServiceUnavailable, retryable) |
| `census_get_variable` | Fetch full metadata for one or more variable codes — label, concept, type, universe. Confirms a code before querying. | `variables[]`, `dataset`, `year` | `readOnlyHint: true`, `openWorldHint: false` | `variable_not_found` (NotFound), `dataset_not_found` (NotFound), `year_not_available` (ValidationError), `variables_unavailable` (ServiceUnavailable, retryable) |
| `census_resolve_geography` | Resolve a place name or address to Census FIPS identifiers. Converts "King County, WA", "Seattle, WA", or "Seattle-Tacoma-Bellevue, WA" to the codes the query tools take. Required before calling `census_query_data` or `census_compare_geographies` unless FIPS codes are already known. | `name`, `geography_type`, `county_fips` | `readOnlyHint: true`, `openWorldHint: false` | `no_match` (NotFound), `ambiguous_name` (InvalidParams), `county_scope_unsupported` (InvalidParams), `resolution_unavailable` (ServiceUnavailable, retryable) |
| `census_query_data` | Query a Census dataset for one or more variables at a specific geography. Requires FIPS codes for the target geography — use `census_resolve_geography` first to convert place names. Returns labeled estimates with margin-of-error columns alongside each estimate. | `variables[]`, `geography_level`, `geography_fips`, `parent_fips`, `dataset`, `year` | `readOnlyHint: true`, `openWorldHint: false` | `dataset_not_found` (NotFound), `missing_api_key` (Unauthorized), `year_not_available` (ValidationError), `variable_not_found` (NotFound), `variables_unavailable` (ServiceUnavailable, retryable), `geography_not_supported` (ValidationError), `parent_required` (ValidationError), `parent_not_accepted` (ValidationError), `no_data` (NotFound), `too_many_variables` (ValidationError), `predicate_not_supported` (ValidationError), `upstream_error` (ServiceUnavailable, retryable) |
| `census_list_geographies` | List the geography levels available for a dataset and year — which levels (county, tract, block group, etc.) are supported and what parent geographies are required. | `dataset`, `year` | `readOnlyHint: true`, `openWorldHint: false` | `dataset_not_found` (NotFound), `year_not_available` (InvalidParams) |
| `census_list_datasets` | Browse available Census datasets with vintages. Returns dataset codes, descriptions, and available years — the starting point for exploring what data exists. | `filter` | `readOnlyHint: true`, `openWorldHint: false` | none (static metadata) |
| `census_list_predicate_values` | List the codes a Census filter dimension accepts, so a `predicates` map can be written without guessing. Routes to the dataset's published value list when it has one (NAICS, POPGROUP) and checks it against the rows the dataset actually publishes, otherwise enumerates against the live data endpoint. Answers the question left open when `census_query_data` or `census_compare_geographies` reports a dimension was left unset. | `predicate`, `dataset`, `year`, `query`, `within_naics`, `limit` | `readOnlyHint: true`, `openWorldHint: false` | `dataset_not_found` (NotFound), `year_not_available` (ValidationError), `predicate_not_supported` (NotFound), `not_a_filter_dimension` (ValidationError), `no_values` (NotFound), `upstream_error` (ServiceUnavailable, retryable) |
| `census_compare_geographies` | Compare one or more variables across a set of geographies at the same level. Useful for "compare poverty rates across states" or "rank counties by median income." Returns a sorted table with all geographies and values. | `variables[]`, `geography_level`, `within`, `geographies`, `predicates`, `dataset`, `year`, `sort_by`, `sort_dir`, `limit` | `readOnlyHint: true`, `openWorldHint: false` | `dataset_not_found` (NotFound), `missing_api_key` (Unauthorized), `geography_not_supported` (ValidationError), `parent_required` (ValidationError), `parent_not_accepted` (ValidationError), `year_not_available` (ValidationError), `variable_not_found` (NotFound), `variables_unavailable` (ServiceUnavailable, retryable), `predicate_not_supported` (ValidationError), `ambiguous_rows` (ValidationError), `no_data` (NotFound), `upstream_error` (ServiceUnavailable, retryable) |

### Resources

No resources. All data access is covered by the tool surface. The variable and geography systems are query-driven rather than addressable by stable URI, making resources a poor fit. A tool-only agent can accomplish everything the server is for.

### Prompts

No prompts. The server is data-oriented; the tool descriptions carry sufficient operational guidance.

---

## Overview

census-mcp-server provides access to US Census Bureau demographic, economic, and housing data via the Census Bureau Data API (`https://api.census.gov/data`). It exposes five core dataset families — ACS 5-Year, ACS 1-Year, Population Estimates, Decennial Census, and the business datasets (County Business Patterns, Economic Census, Nonemployer Statistics) — through a tool surface that abstracts the Census API's most significant usability barriers: opaque variable codes and FIPS geography requirements.

The primary design challenge is the variable system. The ACS5 2024 dataset alone has 28,475 variables with codes like `B19013_001E`. An agent can't know that `B19013_001E` is median household income without discovery tooling. The tool surface puts variable search first, makes it fast, and allows agents to confirm codes before querying.

The secondary challenge is geography. The Census API requires FIPS codes (`for=county:033&in=state:53`), but agents and users think in place names. `census_resolve_geography` bridges this, and is a mandatory first step for any agent that doesn't already have FIPS codes in hand.

Target users: agents doing demographic research, policy analysis, market sizing, geographic comparison, and any workflow that needs population, income, housing, or economic statistics for a US geography.

---

## Requirements

- API key required for all data queries (302 redirect without key — the API no longer supports unauthenticated data access at any rate limit)
- TIGERweb and Census Geocoder endpoints used for geography resolution — no API key required for these
- Rate limits: documented as 500 req/day without key (now moot — key required), higher with key; no hard-coded per-minute cap documented
- Read-only server — no write operations exist in the Census API
- Core datasets in scope: ACS 5-Year (`acs/acs5`), ACS 1-Year (`acs/acs1`), Population Estimates (`pep/charv`), Decennial 2020 (`dec/pl`, `dec/ddhca`), County Business Patterns (`cbp`), Economic Census (`ecnbasic`), Nonemployer Statistics (`nonemp`)
- Latest vintages as of implementation: ACS5 2024, ACS1 2024, PEP 2023, CBP 2023, Economic Census 2022, Nonemployer 2023
- ACS5 sub-tables in scope: detailed tables (`acs5`), data profiles (`acs5/profile`), subject tables (`acs5/subject`) — profiles cover ~80% of common queries with simpler DP-prefix codes
- Variable search operates client-side against the variables.json endpoint (28K+ variables, cached) — no Census search API exists
- Geography resolution uses TIGERweb MapServer REST API for named places, and Census Geocoder for address-to-geography lookup

---

## Domain Mapping

| Noun | Operations |
|:-----|:-----------|
| Variable | search by keyword, get metadata by code(s), resolve human concept → codes |
| Predicate | list the codes a filter dimension accepts, from the dataset dictionary or a live query |
| Dataset | list available, list vintages, get geography levels for a dataset |
| Geography | resolve name/address → FIPS, list hierarchy levels |
| Data | query by variable + geography + year, compare across multiple geographies |

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `CensusApiService` | Census Data API (`api.census.gov/data`) | `census_query_data`, `census_list_predicate_values`, variable endpoints |
| `VariableCacheService` | Variables.json endpoints (per dataset + year) | `census_search_variables`, `census_get_variable`, `census_list_predicate_values` |
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
10. `census_list_predicate_values` (enumerates the codes a `predicates` dimension accepts, from the variable cache's dataset dictionary or a live group-by query)

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

### `census_list_predicate_values`

**Description:** List the codes a Census filter dimension accepts, so a `predicates` map can be written without guessing. Answers the question left open when `census_query_data` or `census_compare_geographies` reports that a dimension was left unset. Which route a dimension takes depends on the vintage: NAICS and POPGROUP always publish a value list in the dataset dictionary; on the current vintages EMPSZES, LFO, RCPSZES, TAXSTAT, and TYPOP publish none and are enumerated against the live data endpoint instead. A dictionary value list is a classification shared across Census products rather than a record of what one dataset serves, so it is checked against the dataset's own published rows before being returned — see "Dictionary value lists are checked against published rows" below. The dictionary lists run to thousands of codes and are best narrowed with `query`.

**Input:**
- `predicate: string` — filter dimension code to enumerate (e.g., `"EMPSZES"`, `"LFO"`, `"POPGROUP"`, `"NAICS2017"`). Case-sensitive. The response notice of `census_query_data` names the dimensions a dataset declares, and `census_search_variables` finds them by keyword.
- `dataset: string` — dataset the dimension belongs to (e.g., `"cbp"`, `"nonemp"`, `"ecnbasic"`, `"dec/ddhca"`, `"pep/charv"`). Use `census_list_datasets` to discover valid values. Dimension codes are vintage-specific, so dataset and year must match the query the values are for.
- `year?: number` — vintage year (default: latest available for the dataset)
- `query?: string` — keyword to narrow the list, matched case-insensitively against each code and label (e.g., `"software"` against `NAICS2017`, `"exempt"` against `TAXSTAT`). Omit to list from the start.
- `within_naics?: string` — industry code to scope the enumeration by, for dimensions the Census publishes per industry — `ecnbasic`'s `TAXSTAT` and `TYPOP` return only the all-establishments row until a NAICS sector is named (e.g., `"62"` for Health Care, `"42"` for Wholesale Trade). Constrained at the schema to 2–8 digits or a hyphenated sector range (`"31-33"`), so a malformed code is rejected rather than silently scoping the enumeration to nothing; blank is treated as omitted. Ignored for dimensions with a published value list. Get sector codes by calling this tool on the dataset's own NAICS dimension.
- `limit?: number` — max codes to return (default: 50, max: 500)

**Output:** `{ values: [{ code, label }], predicate, predicate_label, dataset, year }`. `values` is sorted by code; `code` is the value to send for this dimension in a `predicates` map, and `label` falls back to the code when the dataset publishes no label for it. Alongside the output, an enrichment block carries `totalCount` (codes matched before the limit), `truncated`, `source`, and an optional `notice`.

`source` names where the codes came from and whether they were checked: `"live_query"` is a wildcard group-by against the data endpoint, which returns only codes the dataset publishes; `"dataset_dictionary_verified"` is the published value map with the codes the dataset serves no rows for removed; plain `"dataset_dictionary"` is that map unchecked, and the notice says why the check did not run.

`notice` explains a truncated list, a keyword that matched no published code, how many declared codes were withheld as unpublished, why a dictionary list was returned unchecked, or that the codes returned are complete only for the industry passed in `within_naics`.

**Errors:**
- `dataset_not_found` (NotFound) — unrecognized dataset code. Recovery: call `census_list_datasets` to discover valid dataset codes.
- `predicate_not_supported` (NotFound) — the predicate code is not a variable in this dataset and year. Recovery: call `census_search_variables` on this dataset and year for the codes it does define — dimension names are vintage-specific, so `NAICS2017` and `NAICS2022` belong to different years.
- `not_a_filter_dimension` (ValidationError) — the code is not one of the dimensions the dataset filters on, so it takes no value list. Recovery: pass a dimension the dataset filters on. The response notice of `census_query_data` names every dimension a dataset declares, and `census_get_variable` confirms what a code is.
- `no_values` (NotFound) — the dimension returned no codes for the scope requested. Recovery: drop `within_naics`, or try a broader industry code — a narrow leaf industry often publishes only the all-establishments row.
- `upstream_error` (ServiceUnavailable, retryable) — Census API returned an error or was unreachable. Recovery: retry; if the error persists, the Census API may be temporarily unavailable.

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
- `year_not_available` (ValidationError) — the dataset cannot be queried for the requested vintage. Raised from `DATASET_AVAILABLE_YEARS` before any request. Recovery: retry with a year the error names.
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
- `year_not_available` (ValidationError) — the dataset cannot be queried for the requested vintage. Raised from `DATASET_AVAILABLE_YEARS` before any request.
- `variables_unavailable` (ServiceUnavailable, retryable) — variables.json could not be fetched.

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`

---

### `census_resolve_geography`

**Description:** Resolve a place name to Census FIPS identifiers. Converts "King County, WA", "Seattle, WA", or "Seattle-Tacoma-Bellevue, WA" to the codes required by `census_query_data` and `census_compare_geographies`. Also accepts street addresses for tract-level resolution. Returns the FIPS values directly ready to pass to other tools, and a `geography_type` that is itself the `geography_level` to query at.

**Input:**
- `name: string` — place name (e.g., "King County, WA", "Seattle, WA") or street address (e.g., "1600 Pennsylvania Ave NW, Washington, DC 20500")
- `geography_type?: string` — geography level to resolve to: `"state"`, `"county"`, `"place"`, `"tract"`, `"metropolitan statistical area/micropolitan statistical area"`, `"combined statistical area"`, `"consolidated city"` (default: auto-detect from name). Each value is the level's own Census API name, so it feeds `census_query_data`'s `geography_level` unchanged.
- `county_fips?: string` — 1 to 3 digits, zero-padded to 3, restricting resolution to a single county. Only `county` and `tract` sit within a county, so it also narrows auto-detection to those two levels rather than riding along on a layer that cannot apply it

**Auto-detection:** a two-letter abbreviation or a spelled-out state name (matched against the whole input, so "West Virginia University" is not a state) resolves at the state layer; `"County"`/`"Borough"`/`"Parish"` at the county layer; `"Tract"` at the tract layer. Everything else is tried at the place layer and falls back to county when the place layer has no row. Rows whose name is exactly the queried term win over longer `LIKE` matches, so "Kansas City, MO" resolves to Kansas City rather than North Kansas City. Whatever survives that filter must be a single row to resolve — two or more are distinct real geographies (bare "Boston" matches towns in IN, GA, and MA), so they come back as `ambiguous_name` rather than a coin flip. `"New York"` is a standing ambiguity — it is both the state name and the Census place name for New York City, so auto-detection resolves the state and the city needs `geography_type: "place"`. The three statistical/consolidated levels are never auto-detected — their names overlap city names — so each needs an explicit `geography_type`. A state suffix scopes them too, but through the row names rather than a WHERE clause: the CBSA and CSA layers carry no `STATE` field, and their names end in the hyphenated list of states the area spans, so "Kansas City, MO" and "Kansas City, KS" both reach the MO-KS metro area.

**Output:** `{ name, geography_type, state_fips?, county_fips?, tract_fips?, place_fips?, fips_summary }`. `fips_summary` is a pre-formatted string ready to use as `geography_fips` in `census_query_data` (e.g., `"033"` for a county, with `state_fips: "53"` as the parent; `"42660"` for the Seattle-Tacoma-Bellevue metro area, with no parent at all). Every state-hierarchy level carries `state_fips` — the parent geography most sub-state queries require. A metropolitan/micropolitan or combined statistical area omits it: those levels can span several states and take no `parent_fips`, so reporting the `"00"` a missing field would pad to would be a fabricated parent.

**Errors:**
- `no_match` (NotFound) — no layer in the chain had a row for the name. Recovery names the state when the input already carried one; otherwise it asks for a state abbreviation, an explicit `geography_type`, or a full street address.
- `ambiguous_name` (ValidationError) — more than one geography matched. `candidates[]` carries `{ name, geographyType, stateFips, stateAbbr, countyFips?, tractFips? }` and the recovery hint lists them ready to re-query. Only the state layer returns `STUSAB`, so the abbreviation is derived by reversing the state FIPS table. Tract candidates repeat the same name within a state, so they are separated by county and the hint sends the caller back to this tool with `county_fips` set, which is the only input that picks one. Statistical-area candidates carry no state at all, so the code each resolves to is what makes them actionable.
- `county_scope_unsupported` (ValidationError) — `county_fips` was paired with a street address, or with a level that does not sit within a county, whether set explicitly or auto-detected. Thrown before any network call. Recovery: drop `county_fips`, or set `geography_type` to `"county"` or `"tract"`.
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
- `county_fips?: string` — county FIPS when querying tracts or block groups inside one county (e.g., `"033"` for King County), alongside `parent_fips`. `census_resolve_geography` returns this as `county_fips`.
- `predicates?: Record<string, string>` — dataset-specific filter values keyed by variable code (e.g., `{ "NAICS2017": "5112" }`), appended to the request URL as extra query parameters. See "Predicate filtering" below.
- `dataset?: string` — dataset to query (default: `"acs/acs5"`). Use `census_list_datasets` for valid values.
- `year?: number` — vintage year (default: latest available for the dataset)

**Output:** Array of result rows, each with `{ geography_name, geography_fips, geography_geoid, variables: { [code]: { estimate, moe?, label, suppressed, suppression_reason?, value? } } }`. Suppressed values include a human-readable `suppression_reason` (e.g., "geography too small for reliable estimate") rather than the raw negative sentinel. `value` carries the text of a cell that does not hold a number, which is what makes a null `estimate` readable — see "A null estimate resolves three ways" below. When `geography_fips` is `"*"`, returns all geographies at the level.

Each row carries two identifiers because they serve different purposes. `geography_fips` is the bare code at the queried level (`"033"`) — what the Census API `for=` clause takes, so it round-trips back into this tool's own `geography_fips` input alongside the same parents. `geography_geoid` concatenates the level with its parents (`"53033"` for a county, `"53033000101"` for a tract) and is nationally unique, so it is the identifier that works when geographies span states — notably in `census_compare_geographies`'s `geographies` filter.

A row also carries `applied_filters` (the label of the default the API applied to each filter dimension the query left unset) and, on a dataset that publishes more than one record per geography, `record` — keyed by the column that separates the records, each value carrying a `code` and a `label`, e.g. `{ "MONTH": { "code": "7", "label": "July" } }`. The code is what pins the record when passed back in `predicates`. Both are absent when they do not apply. See "Several records per geography are labelled, not collapsed" below.

**Errors:**
- `missing_api_key` (Unauthorized) — `CENSUS_API_KEY` not configured or invalid. Recovery: set the env var and restart.
- `year_not_available` (ValidationError) — the dataset cannot be queried for the requested vintage. Raised from `DATASET_AVAILABLE_YEARS` before the handler's first request, so a wrong year costs no round trip. The error names the years that do work, contiguous runs collapsed (`2005-2019, 2021-2024`).
- `variables_unavailable` (ServiceUnavailable, retryable) — the variable metadata endpoint answered with something unparseable, surfaced through the predicate check. Recovery: retry.
- `variable_not_found` (InvalidParams) — one or more variable codes don't exist in the dataset+year. Recovery: call `census_search_variables` or `census_get_variable` to confirm codes.
- `geography_not_supported` (InvalidParams) — the requested geography level does not exist in this dataset and year. Thrown before the data query, from the dataset's own geography metadata; the error carries the levels the dataset does have. Recovery: call `census_list_geographies` to see supported levels.
- `parent_required` (InvalidParams) — the geography level requires a parent the request did not supply (e.g., tract requires a state, block group a state and a county). Thrown before the data query, from the same metadata; the error names the missing parents and the recovery hint names the input to add. A `*` target relaxes the innermost required parent, which is why a nationwide `county` query needs no `parent_fips` while a tract query does. A missing parent this tool has no input for (a single block group needs its tract) is reported as such: the hint offers `geography_fips: "*"` when the wildcard would drop that parent, and otherwise says the level is out of reach.
- `no_data` (NotFound) — the query returned no rows. The Census API answers a well-formed but empty query with `204 No Content`, which is read as zero rows here rather than an unparseable response. Recovery is dataset-aware: on ACS1 it points at the 65K population floor and suggests `acs/acs5`; on any other dataset it points at confirming the FIPS codes and level, without suggesting a switch to the dataset already in use.
- `predicate_not_supported` (InvalidParams) — a key in `predicates` is not a variable in this dataset+year. Validated against the cached `variables.json` before the data query, because the Census API's own rejection surfaces as a `400` naming the request URL and nothing about which key was wrong.
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
- `within_county?: string` — county FIPS to constrain a tract or block-group comparison to one county inside `within` (e.g., `"033"`). `census_resolve_geography` returns this as `county_fips`.
- `geographies?: string[]` — optional list of specific geographies to include; when provided, only these are returned. Omit to return all geographies at the level within `within` (or nationally). An entry matches a row's full GEOID (`"53033"` King County WA, `"06037"` Los Angeles County CA) or its bare level code (`"033"`). Prefer GEOIDs: they are nationally unique, so a list may span states, whereas a bare code matches that code in every state unless `within` scopes the comparison. A GEOID is easiest taken from a row's own `geography_geoid`; from `census_resolve_geography`, concatenate `state_fips`, then `county_fips` when present, then `fips_summary` — a tract GEOID is state + county + tract, not state + tract. Entries that match no row, and bare codes that matched more than one state, are named in the response notice; a list that matches nothing at all throws `no_data` rather than returning an empty ranking.
- `predicates?: Record<string, string>` — dataset-specific filter values keyed by variable code, applied to every geography in the comparison. See "Predicate filtering" below.
- `dataset?: string` — dataset to query (default: `"acs/acs5"`)
- `year?: number` — vintage year (default: latest available)
- `sort_by?: string` — variable code to sort by (default: first variable in the list)
- `sort_dir?: 'asc' | 'desc'` — sort direction (default: `'desc'`)
- `limit?: number` — max geographies to return (default: 50, max: 500). When results are truncated, `total_count` indicates how many geographies matched.

**Output:** `{ rows: [{ geography_name, geography_fips, geography_geoid, variables: { [code]: { estimate, moe?, label, suppressed, value? } }, applied_filters?, record?, rank }], total_count, truncated }`. `geography_fips` on each row enables follow-up calls to `census_query_data` for more variables on a specific result; `geography_geoid` is the nationally unique form to pass back in `geographies`. Suppressed values are labeled rather than passed through as raw sentinels. `record` carries the record the ranking is over on a dataset that publishes more than one per geography — same shape as in `census_query_data`, and present whenever the dataset publishes such a column, since a comparison that would put a geography on several rows fails with `ambiguous_rows` rather than ranking it.

**Errors:**
- `missing_api_key` (Unauthorized) — `CENSUS_API_KEY` not configured or invalid.
- `ambiguous_rows` (ValidationError) — the dataset publishes several records per geography and the comparison pinned none, so every geography would occupy several ranks with different values. Raised after the data query, from a count of rows per full GEOID, so two same-numbered counties in different states are not read as a duplicate. The error carries the record columns and the values each took; the recovery hint names the one to add to `predicates` and the code that selects it.
- `geography_not_supported` (InvalidParams) — the geography level does not exist in this dataset+year. Thrown before the data query, from the dataset's own geography metadata. Recovery: call `census_list_geographies`.
- `parent_required` (InvalidParams) — the level requires a parent the request did not supply. Thrown before the data query; the message names the missing parent levels and the recovery hint names `within` or `within_county`.
- `parent_not_accepted` (ValidationError) — `within` or `within_county` names a parent the level does not sit within, which the Census API would answer with an opaque `400`. Checked against the level's own `requires` list, so the `*` wildcard relaxes which parents are mandatory but never which are allowed.
- `year_not_available` (ValidationError) — the dataset cannot be queried for the requested vintage. Raised from `DATASET_AVAILABLE_YEARS` before the handler's first request.
- `variable_not_found` (InvalidParams) — one or more variable codes invalid for this dataset+year.
- `variables_unavailable` (ServiceUnavailable, retryable) — the variable metadata endpoint answered with something unparseable, surfaced through the predicate check.
- `predicate_not_supported` (InvalidParams) — a key in `predicates` is not a variable in this dataset+year, validated before the data query.
- `no_data` (NotFound) — no geographies returned, or the `geographies` list matched no row. Recovery is dataset-aware on the first case (ACS1 gets the 65K population floor and an `acs/acs5` suggestion; other datasets get level and FIPS verification) and names the unmatched entries on the second.
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

### Margin-of-error inference is scoped to the ACS family

`variables.json` omits ACS's `M`-suffix margin-of-error codes even though the data API serves them, so the variable cache infers each `B…E` estimate's `B…M` sibling and synthesizes an entry for it. That `E`/`M` pairing is an ACS table convention, not a Census-wide one: `pep/charv` has `UNIVERSE`, `AGE`, and `MEDAGE`, `ecnbasic` has `INVTOTE` and `INVWIPE`, and `cbp` has `STATE` — ordinary codes that happen to end in `E` and have no margin of error at all. Applied to those families the inference invented codes (`UNIVERSM`, `INVTOTM`, `STATM`) that do not exist upstream, and `census_get_variable` resolved them to fabricated "Margin of Error — …" entries instead of reporting `variable_not_found`.

Both the inference and the synthesis are gated on `isAcsDataset()` (a `acs/` dataset prefix). `CensusApiService.parseResponse` carries the same gate when it pairs a requested `E` value with a requested `M` value into `.moe`. That path never fabricated anything — it only pairs codes the caller explicitly requested, and no non-ACS dataset in the registry currently has both a `<stem>E` and a `<stem>M` variable for it to mispair. It is gated anyway so the two services tell one story about where the convention holds, rather than the cache reporting no margin-of-error relationship while a query attaches one.

### Predicate filtering: a generic map, with unset dimensions reported rather than guessed

Several datasets mark variables `required` in `variables.json` — `NAICS2017`/`NAICS2022`, `LFO`, `EMPSZES`, `RCPSZES`, `TAXSTAT`, `TYPOP` on the business datasets, and `SEX`, `AGE`, `POPGROUP`, `HISP`, `YEAR` on `pep/charv`. The Census API does not enforce them. A query that omits one succeeds and substitutes the API's own default for that dimension: `cbp` establishments in King County is 70,376 with no `NAICS2017` and 577 with `NAICS2017=5112`. Registering the business datasets without a way to send these would answer "how many software companies are in King County" with the all-industries total.

`predicates` is a `Record<string, string>` on both data tools rather than dataset-aware named parameters (`naics`, `size_class`) because the codes are vintage-specific, not just dataset-specific — `cbp` 2023 takes `NAICS2017` while `cbp` 2012 takes `NAICS2012`, and `nonemp` 2023 takes `NAICS2022`. Named parameters would need a hand-maintained dataset × year × parameter mapping that drifts, and would add seven dead optional fields to every ACS query. The map is validated against the dataset's own cached `variables.json` instead, so it stays correct across vintages with no table to maintain.

An unset required predicate is reported through `ctx.enrich.notice()`, not thrown as an error. Erroring was rejected because it was unrecoverable for most of these dimensions: `variables.json` publishes a value list for `NAICS*` and `POPGROUP` only, so a caller told to supply `LFO` or `EMPSZES` had no endpoint to learn what they accepted — `census_list_predicate_values` now closes that gap by enumerating the rest against the live data endpoint. Erroring would also break every existing `pep/charv` and `dec/ddhca` query, which is the only form those datasets are reachable in today. The notice reaches both `structuredContent` and `content[]`, attached to the number itself, and names each unset dimension with its label.

What the notice does *not* say is that the value is an all-categories total, because the substituted default is not one shape. `cbp` defaults `NAICS2017` to `00`, the all-industries total. `pep/charv` defaults `YEAR` to 2020, so an unfiltered `POP` query against the 2023 vintage reports 2020 rather than a sum across 2020–2023. Calling both an aggregate would misreport the second, so the wording says only what holds for both: the API supplied the default, so no value is scoped to a category the query chose. `YEAR` still cannot be echoed back per row — naming it in `get=` flips the query from applying the default to enumerating all four vintages — so the notice names it as a dimension whose applied value is not visible.

The duplicate rows `pep/charv` returns for one geography are a separate mechanism from the defaults, and are covered below.

`GEOCOMP` is excluded from the report: every Census dataset declares it — checked across all eleven registered dataset and year pairs — its default is the whole geography, and listing it beside real filter dimensions on every ACS query would train readers to skip the notice.

An unknown predicate *key* is an error (`predicate_not_supported`), validated client-side, because that case is both unambiguous and fully recoverable. The Census API does reject it with a `400`, but the message that reaches the caller carries only the request URL and the status — never which key was wrong. An unknown predicate *value* is not rejected at all: it comes back as `204 No Content`, indistinguishable from a geography with no data, which is why the `no_data` recovery hint names the supplied predicates alongside the unset ones.

### Dictionary value lists are checked against published rows

A `values.item` map in `variables.json` is a classification the Census shares across products, not a record of what one dataset publishes. `dec/ddhca` declares 5,543 `POPGROUP` codes and serves 2,996; `cbp` declares 6,694 `NAICS2017` codes and serves 2,003; `pep/charv` declares 5,545 `POPGROUP` codes and serves 12. Returning the declared list unqualified handed callers dead codes — most sharply `dec/ddhca` `POPGROUP` `001` "Total population", the top hit for the obvious keyword and a code that returns nothing at any geography.

The check is one wildcard group-by per dimension, cached for the discovery TTL. What lands in `get=` decides what it answers from: a dimension's own label column can be served from the dictionary, so a label-only request reports every declared code, while naming one of the dataset's measure columns forces the read against the data file and answers with the published set. Coverage is per table and nests — on `dec/ddhca` the one-cell total-population table publishes 2,996 groups where the 49-cell sex-by-age table publishes 551 of the same ones — so the probe takes a measure from the table with the fewest cells, which is the widest set the dataset serves. Any other measure in that table gives the same answer, and on `cbp`, `nonemp`, `ecnbasic`, and `pep/charv` every measure in the dataset does.

The national scope is an upper bound rather than a per-geography answer: `dec/ddhca` serves the same 2,996 groups in WA, CA, NY, and TX, and `cbp` serves 1,827 of its 2,003 national codes in WA — every sub-national set checked is a subset of the national one, so a code withheld here is served nowhere. The notice says so, since a single geography or a more detailed table can publish fewer.

Two escapes keep the check from costing more than it gives. A dimension published per industry (`ecnbasic` `TAXSTAT` returns only `00` unscoped but `T` and `Y` under `NAICS2017=62`) is left unchecked, because an unscoped check would withhold codes a scoped query does return. A check that fails or comes back empty downgrades to the unchecked map with a notice, rather than emptying the response — the `source` field is what tells the two apart.

### Several records per geography are labelled, not collapsed

`pep/charv` publishes an April 1 estimates base and a July 1 estimate for every geography, so a query that pins neither answers with two rows carrying different numbers and, before this, nothing to tell them apart. `MONTH` is what separates them — not `YEAR`, which defaults to 2020 and is carried by both rows, so pinning `YEAR=2020` still returns two. 2021 through 2023 have a July record only, which is why pinning a later year looked like a fix.

The column is recognized from `variables.json` rather than a per-dataset list: a variable the dataset does not mark `required` that carries its own `_LABEL` or `_DESC` attribute is a labelled category the rows vary over. Across every registered dataset and vintage that matches `MONTH` and `UNIVERSE` on `pep/charv` 2023 and nothing else, which lines up with a direct duplicate scan — a `for=state:*` query on every other registered dataset and vintage returns exactly one row per state. `UNIVERSE` takes one value (`R`, Resident Population), so it labels rows without splitting them; the rule tolerates that, since a column that took one value is reported and never named as the cause of a duplicate.

Unlike a required filter dimension, naming one of these in `get=` does not change which rows come back — the API was already returning them all — so requesting them is free of the enumeration flip that rules out echoing `YEAR`. Both the code and its label column are requested, and both are excluded from GEOID composition alongside the requested variables and echoed predicates; a record column left in would concatenate into the GEOID and break every round-trip.

The two data tools answer differently on purpose. `census_query_data` returns every record, labels each row with `record`, renders the record on the row heading so `content[]` carries the same distinction as `structuredContent`, and warns which column separates them and what to pass to pin one. `census_compare_geographies` refuses: a rank is a statement about one geography, so a ranking that lists each one twice with two different values cannot be read correctly however the rows are labelled. It fails with `ambiguous_rows` and names the column and code to pin. Pinning it — `predicates: { "MONTH": "7" }` — is a plain predicate on a variable the dataset declares, so it passes the predicate check and the Census API applies it like any other.

### One vintage table, checked before the request

`DATASET_AVAILABLE_YEARS` in `variable-cache-service.ts` is the only place a dataset's vintages are written down. `KNOWN_DATASETS` is its key set, `DATASET_LATEST_YEARS` is the maximum of each list, and `census_list_datasets` reads `available_years` straight out of it. Before, `census-list-datasets.tool.ts` held one copy and the two registries held overlapping others, and none of the three was what a query validated against — which is how `pep/charv` came to advertise three vintages the Census API does not publish.

`VariableCacheService.validateYear` raises `year_not_available` from that table, and both data tools call it before their first request rather than letting the variable cache reach it, because the geography check runs earlier and a vintage the dataset does not serve has no geography metadata either. So a wrong year costs no round trip and reports the year rather than a downstream symptom.

A year is listed only when a query here can answer with it, and that is narrower than what the API hosts for two unrelated reasons: `pep/charv` 2020-2022 are not vintages at all (they are `YEAR` values inside the 2023 vintage), while `cbp` before 2012 and `nonemp` 2008-2011 are real vintages that reject the `NAME` column every query here sends. The error therefore says a year *cannot be queried* rather than that the dataset does not publish it, which would be false for the second kind.

The cost is that a vintage the Census releases is refused until the table is edited. That is the deliberate trade — a wrong year is a common input mistake and a new vintage is a once-a-year event — but it makes the table a maintenance obligation, so it is checked against `api.census.gov/data/<year>.json`, the per-vintage catalog, rather than trimmed by eye.

### A null estimate resolves three ways

Every requested cell used to go through `Number()`, so a cell holding text became `NaN` and serialized to the same `null` as a geography with no value: the text was lost and what was left could not be told apart from missing data. `GEO_ID` is the sharpest case, since it is what a caller reaches for as a join key.

The signal is the value, not the declared type. `variables.json` declares the ACS median-year codes (`B25035_001E`, the `B25037`/`B25039` families) `predicateType: "string"` and serves them ordinary years like `"1983"` that callers rank and average, so keying on the declared type would have stopped returning a number for those; across the registered dataset+year pairs the same mismatch covers dozens of columns (`SUMLEVEL`, `STATE`, `YEAR`, `MONTH`, `NAICS2017`, `EMPSZES` and more) that are numeric in practice. A non-empty cell that does not parse as a number is text; anything else is a number.

Text lands in a new optional `value`, leaving `estimate` null and `suppressed` false, so a null `estimate` now resolves by what sits beside it:

| Cell | `estimate` | `value` | `suppressed` |
|:--|:--|:--|:--|
| A number | the number | absent | `false` |
| Text | `null` | the text | `false` |
| Withheld by the Census | `null` | absent | `true` |
| Empty | `null` | absent | `false` |

The read is per cell rather than per column, which matters in both directions: `GEO_ID` and `pep/charv` `UNIVERSE` are text on every row, while the older ACS profile vintages write "not applicable" as the literal `"(X)"` in a column that is a number everywhere else (`acs/acs5/profile` 2009 answers `DP02_0070E` with `"(X)"`), and that annotation reaches the caller instead of an unexplained null. `format()` renders the text where it used to print `N/A`; a genuinely empty cell still prints `N/A`. On the ranking tool text has no ordering, so sorting on a column of it leaves every row tied — which the `variables` output description says.

Two smaller fixes ride the same read. An empty cell went through `Number("")`, which is `0`, and was reported as a zero estimate; it now reads as missing. And the suppression-code lookup was an unguarded index into an object literal, so a cell reading `"constructor"` would have resolved to a suppression reason — reachable once text flows down this path, so the lookup is guarded with `Object.hasOwn`.

### Upstream error bodies are read, not forwarded or stripped

`fetchWithTimeout` attaches the first 500 bytes of a failed response to `data.body` and `data.responseBody`, and those two bodies are not the same kind of thing. A rejected query comes back as one `text/plain` line — `error: unknown variable 'NAME'`, `error: unknown/unsupported geography hierarchy` — which is the entire diagnosis and has no other route to a caller. A path that does not exist comes back as a servlet container's HTML error page, several hundred bytes of styling that says nothing an agent can use.

`censusHttpError` wraps all four `fetchWithTimeout` call sites and reads the body rather than forwarding or dropping it wholesale: a short line with no markup becomes `data.upstreamMessage` and is appended to the error text, and anything else is discarded. `body` and `responseBody` are removed either way, so no markup reaches a caller from any status. The full body stays in the framework's own log line, which is where a maintainer looks for the case the typed errors do not cover.

A 404 on a vintage the table does not list becomes `year_not_available`. A 404 on one it does list does not — the year was validated before the request, so the table has drifted from the API, and answering "no such vintage" while naming that same vintage as available is a loop rather than a recovery. Every other status keeps its status-mapped code, which is what `withRetry` reads, so a 5xx is still retried and a 400 still fails fast; the recovery hint follows the same split rather than telling a caller to retry a query the API rejected outright.

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
- **Margins of error exist only on ACS.** `pep`, `dec`, `cbp`, `ecnbasic`, and `nonemp` publish none, so `moe_code`/`estimate_code` are absent there and query rows carry no `moe`. A code ending in `E` in those datasets is an ordinary code, not an estimate with an `M` sibling.
- **Some business-dataset geography levels have no name-to-code path.** State, county, CBSA, CSA, and consolidated city all resolve from a name. `cbp`'s congressional district and ZIP code, and `ecnbasic`'s region, metropolitan division, and economic place, do not — those need a code the caller already holds. `metropolitan division` is left out deliberately: its parent is the CBSA level, and `census_query_data` can only express `state` and `county` in its `in=` clause, so a resolved code would land on `parent_required` with no input able to satisfy it. `economic place` has no NAICS-free enumeration to resolve against at all.
- **Business-dataset vintages predate the query shape.** Every query sends `NAME` in `get=`, and the older vintages reject it with a `400` — `cbp` before 2012, and `nonemp` 2008 through 2011. Those years exist upstream but are omitted from `census_list_datasets` rather than advertised and then failing. `cbp` vintages before 2017 also take `NAICS2012` rather than `NAICS2017`, and `nonemp` runs back through `NAICS1997`; the predicate check reads each vintage's own `variables.json`, so the right code name is reported at runtime.
