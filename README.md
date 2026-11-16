<div align="center">
  <h1>@cyanheads/census-mcp-server</h1>
  <p><b>Query U.S. Census Bureau data, variables, and geography via MCP. STDIO or Streamable HTTP.</b>
  <div>8 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.8.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/census-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/census-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/census-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/census-mcp-server/releases/latest/download/census-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=census-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvY2Vuc3VzLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22census-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fcensus-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://census.caseyjhand.com/mcp](https://census.caseyjhand.com/mcp)

</div>

---

## Overview

US Census Bureau demographic, economic, and housing data. Find datasets and variables, resolve place names or addresses to FIPS codes, and query or rank estimates across any set of geographies.

### Tools

| Tool | Description |
|:-----|:------------|
| `census_list_datasets` | Browse available Census Bureau datasets (ACS5 and ACS1 with their profile, subject, and comparison tables, ACS Supplemental Estimates and Selected Population Profiles, Population Estimates, Decennial, County Business Patterns, Economic Census, Nonemployer Statistics, and `geoinfo` land area) with vintage years and dataset codes. |
| `census_list_geographies` | List the geography levels supported by a dataset and year, with parent requirements and example FIPS values. |
| `census_search_variables` | Keyword search across variable labels and concept groups, or lookup by variable or table code. On ACS, returns estimate and margin-of-error codes together. |
| `census_get_variable` | Fetch full metadata for one or more variable codes — label, concept, predicate type, universe, MOE sibling — including the annotation and flag columns the data tools accept. |
| `census_list_predicate_values` | List the codes a filter dimension accepts (`EMPSZES`, `LFO`, `POPGROUP`, `NAICS2017`…), from the dataset dictionary or a live wildcard enumeration. |
| `census_resolve_geography` | Convert place names (e.g., "King County, WA"), ZIP codes, or street addresses to Census FIPS identifiers via TIGERweb and Census Geocoder. |
| `census_query_data` | Query a Census dataset for variables at one geography, a comma-separated list of them, or every geography at a level. Returns estimates with MOE, Census sentinel values and withheld business values resolved to their published meanings, and predicate filtering for the business datasets. |
| `census_compare_geographies` | Rank and compare variables across multiple geographies — all counties in a state, all states nationally, or a named set. Sorted table output, with the same predicate filtering. |

---

## Capability reference

### `census_list_datasets` <sub>tool</sub>

- Returns dataset codes, names, descriptions, and available vintage years, with an optional keyword filter. Covers ACS5 and ACS1 (data profiles, subject tables, comparison profiles, and `acs/acs1/spp`), `acs/acsse`, Population Estimates, the Decennial files (Redistricting (P.L. 94-171) for 2000, 2010, and 2020; `dec/dhc`, `dec/dp`, `dec/sdhc`, `dec/ddhca`, `dec/ddhcb` for 2020), `cbp`, `ecnbasic`, `nonemp`, and `geoinfo` (land and water area and internal points for every geography level, 2020 onward; the denominator for population density — query a count and `AREALAND_SQMI` at the same level and codes with the same explicit `year`, then divide)
- Each description names the filter predicates the dataset requires and the geography levels it publishes
- Dataset codes (e.g., `acs/acs5`) are what the other tools take. Case is ignored and a two-part code works by its last part alone (`acs5`, `pl`); three-part codes such as `acs/acs5/profile` must be given in full
- `available_years` is exhaustive: any other year fails with `year_not_available`, naming the years that work

---

### `census_list_geographies` <sub>tool</sub>

- Returns one row per geography level and parent hierarchy: `geography_level`, whether a parent is required, `required_parent_levels`, and an example FIPS value. `totalLevels` counts each level once
- `geography_level` values are the exact inputs to `census_query_data` and `census_compare_geographies`; `year` defaults to the latest vintage
- Fails with `dataset_not_found` or `year_not_available` (naming the years served)

---

### `census_search_variables` <sub>tool</sub>

- Whole-word search across label and concept: every query word must match, otherwise the closest matches come back with a notice. A variable or table code in any case returns that variable, or the whole table in code order, first (`B19013` returns `B19013_001E` then `B19013_001M`). A table ID it returns is what `census_query_data` takes as `group`
- A code the dataset does not publish gets a notice naming the sibling dataset that holds it (`S1701` in `acs/acs5` points to `acs/acs5/subject`) or `census_get_variable` for an attribute column such as `B19013_001EA`
- On ACS datasets, estimate (E suffix) and margin-of-error (M suffix) codes come back together; comparison profiles and the other families publish no margins of error. Also finds predicate codes by keyword (`naics`) or code (`NAICS2017` in `cbp`)
- `limit` is an integer from 1 to 100 (default 20), rejected rather than clamped when out of range. `offset` pages the complete match ordering; `totalMatches` counts matches before paging, `truncated` means another page exists, and `nextOffset` names it. variables.json is cached per dataset+year (default TTL 24h)

---

### `census_get_variable` <sub>tool</sub>

- Takes one or more variable codes (case-insensitive) and returns label, concept, predicate type, and the table's universe, in the order given. If `groups.json` can't be fetched, variables come back without universe and a notice says to retry
- Resolves annotation and flag columns such as `B19013_001EA` and `EMP_F`, with `attribute_of` naming the column each belongs to and `attribute_type` its kind (`ANNOTATION`, `FLAG`, `MARGIN_OF_ERROR`). On ACS datasets it also returns `estimate_code`/`moe_code` sibling references
- Confirms predicate dimension codes (`NAICS2017`, `SEX`) exist in a dataset; `census_list_predicate_values` lists their values. `dataset` defaults to `acs/acs5` and `year` to the latest vintage
- `variable_not_found` when a code isn't defined, naming the sibling dataset that publishes it when one is found (`DP03_0062E` in `acs/acs5` points to `acs/acs5/profile`)

---

### `census_list_predicate_values` <sub>tool</sub>

- Lists the codes a filter dimension accepts, read from the dataset dictionary when it publishes a list and enumerated live otherwise. `NAICS*` and `POPGROUP` have long lists (thousands of codes; narrow with `query`); `EMPSZES`, `LFO`, `RCPSZES`, `TAXSTAT`, and `TYPOP` are live-only
- Dictionary lists are checked against the rows the dataset actually publishes and unpublished codes are dropped; `source` says whether the check ran and the notice gives the number withheld. A dictionary list does not validate publication at a supplied geography level
- Live enumeration takes `geography_level` (default `us`) and echoes that scope. Codes vary by level; only levels whose dataset metadata permits an unparented wildcard are accepted
- `query` matches code and label; results are sorted by code before `offset`/`limit` paging (`limit` 1 to 500, default 50). `totalCount` counts all matches; `truncated` means another page exists, with `nextOffset` only then. On `ecnbasic`, `within_naics` scopes `TAXSTAT` and `TYPOP` to one industry
- The live route and the dictionary check read the data endpoint, so they need `CENSUS_API_KEY`: without a working key a live-only dimension fails with `missing_api_key`, while a dictionary list still answers, unchecked, with a notice naming the key

---

### `census_resolve_geography` <sub>tool</sub>

- Named places (e.g., "King County, WA") resolve via TIGERweb; street addresses resolve to tract level via Census Geocoder, with `block_group_fips`, `place_fips`, and `county_subdivision_fips`. A resolved tract is a 2020 tract, published from ACS 5-year 2020 and the 2020 Census files; earlier vintages use 2010 tracts (2000 tracts on `acs/acs5` 2009 and `dec/pl` 2000), and a `notice` says so. A 5-digit ZIP (or ZIP+4) resolves to its ZIP Code Tabulation Area (`zip code tabulation area`)
- Auto-detects `geography_type` for state, county, county subdivision, place, tract, and ZIP. Metropolitan/micropolitan statistical areas, combined statistical areas, consolidated cities, and economic places need an explicit `geography_type`; `economic place` returns the 8-digit `ecnbasic` code (Seattle `03363000`)
- The place level includes census-designated places, which answer a name only when no incorporated place or county matches exactly; use the full name ("Arlington CDP, VA") or `geography_type: "place"` to reach one. Optional `county_fips` scopes county, county subdivision, and tract resolution (`county_scope_unsupported` for any other level or an address)
- County subdivisions resolve in every state with `geography_type: "county subdivision"`, returning `county_subdivision_fips`. With a CT, ME, MA, MI, MN, NH, NJ, NY, PA, RI, VT, or WI suffix, where towns and townships govern like incorporated places, a town or township is also found without it ("Cherry Hill, NJ" → Cherry Hill township `12280`) and outranks a CDP or a place that only contains the name; a trailing "Township" also matches a Michigan charter township. An exact county name still wins ("Plymouth, MA" is Plymouth County), and the `notice` names a same-named town or township with its codes
- Matching ignores case, accepts a state abbreviation or full name, and tolerates Saint/St. and accent differences. New York City boroughs resolve to their counties ("Brooklyn, NY" → Kings County `047`) with a `notice`
- "Fairfield County, CT" (a name saying "County", or `geography_type: "county"`) resolves to Connecticut's county from before 2022 (`001`; Hartford `003`, Litchfield `005`, Middlesex `007`, New Haven `009`, New London `011`, Tolland `013`, Windham `015`) with a `notice`: every dataset vintage through 2021, the 2020 Census included, publishes it, and vintages from 2022 publish the nine planning regions (`110`–`190`). A bare "Fairfield, CT" resolves to Fairfield town
- A name matching several geographies returns `ambiguous_name` with every candidate's FIPS code and state; tract and county subdivision candidates are separated by county. Results carry `state_fips` (→ `parent_fips`) and `fips_summary` (→ `geography_fips`) for the next tool; statistical areas and ZCTAs omit `state_fips`

---

### `census_query_data` <sub>tool</sub>

- Requires FIPS codes (use `census_resolve_geography` for place names). `geography_fips: "*"` returns every geography at the level within the parent; each row carries `geography_fips` and the nationally unique `geography_geoid`. Wildcards return up to `limit` rows (default 50, max 500) in GEOID order, with `offset` for paging and `totalCount` for all matches. `truncated` is true only when another page exists; `nextOffset` names that page
- A comma-separated list (`"06,53"`, or `"033,061"` with `parent_fips: "53"`) returns one row per listed code at the same level, in GEOID order and paged the same way; codes take the level's width, no `"*"` member, and the parents a single code needs. The notice names each listed code no row came back for
- Up to 49 variable codes per call, fewer on datasets that add label or record columns (`too_many_variables` states the maximum). Unknown codes fail with `variable_not_found`; level and parent problems fail with `parent_required` or `parent_not_accepted`. Optional `tract_fips` (6 digits, with a concrete `county_fips`) scopes a block-group or decennial block query to one tract
- `group` takes one table ID (`B01001`, any case; a `group(B01001)` entry in `variables` reads the same) and returns every column of that table in one call, beside or in place of `variables` (one of the two is required, else `variables_or_group_required`), outside the 49-code limit: the codes listed in `variables` first, then the table's columns in line order, decoded and estimate/margin paired as usual, with annotation columns (a code plus `A`) left out and the comparison profiles' `SS` columns kept. `variable_labels` labels every column; the table's `GEO_ID` and `NAME` appear only when `variables` lists them. Not available on `cbp`, `ecnbasic`, `nonemp`, `pep/charv`, `dec/ddhca`, `dec/ddhcb`, or `acs/acs1/spp` (`group_not_supported`), and one table per call (`multiple_groups`). A table the dataset doesn't publish fails `variable_not_found`, naming the sibling dataset that does. A wide table over a broad `"*"` scope can outrun the data request's time limit: narrow the geography or list only the codes needed in `variables`
- Optional `predicates` map filters the business, `pep`, and `dec` datasets and `acs/acs1/spp` (e.g., `{"NAICS2017": "5112"}`). Unset dimensions take a Census default, echoed per row in `applied_filters`; `"*"` returns one row per category, labelled in `record`. `pep/charv` returns several rows per geography, so pin one (e.g., `{"MONTH": "7"}`)
- Variable labels come once per response in `variable_labels` (code → label, the same on every page; annotation and flag columns such as `B19013_001EA` have none), not on each row. `content[]` opens with the same legend and prints every digit `structuredContent` carries, with thousands separators
- ACS sentinel values resolve to their published meanings, and a median in an open-ended interval is flagged `open_ended`. On `cbp`, `ecnbasic`, and `nonemp`, withheld values are reported as suppressed with the flag's meaning. A null `estimate` means suppressed, a text cell (returned under `value`), or empty
- On `dec/ddhca` and `dec/ddhcb`, a geography's `POPGROUP` group sits in only one table of a family; a `no_data` hint or notice names the sibling tables. Requires `CENSUS_API_KEY`
- Missing-geography guidance names applicable ACS publication thresholds as possible causes alongside code checks, and pairs broader-coverage datasets with variable rediscovery. When a call names a tract (or a block group or block) on a vintage before 2020, the hint and the unmatched-code notice say that vintage publishes 2010 tracts (2000 tracts on `acs/acs5` 2009 and `dec/pl` 2000), not the 2020 tracts `census_resolve_geography` returns, and point to the `"*"` tract listing. A Connecticut county code in the scheme the vintage does not publish (a planning region 110–190 through 2021, a pre-2022 county 001–015 from 2022) gets a hint naming the scheme the vintage publishes; tracts and county subdivisions keep their codes across the change, so below the county level it points to `geography_fips: "*"` with `county_fips: "*"`

---

### `census_compare_geographies` <sub>tool</sub>

- Ranks all geographies at a level, or a named `geographies` list of GEOIDs/bare level codes; `within`/`within_county` scope to a state/county, omit for a national comparison
- Ranks on one variable: `sort_by` (default the first code; must be a requested code, else `sort_by_not_requested`), `sort_dir` (default `desc`), and `limit` (1 to 500, default 50). Equal numeric values share competition ranks (`1, 2, 2, 4`) and are ordered by GEOID; a notice identifies a page boundary inside a tie. A count ranks by size, not rate, so rank a published percentage for a rate (`S1701_C03_001E` in `acs/acs5/subject`, `DP04_0047PE` in `acs/acs5/profile`)
- `offset` counts rows in the sorted matched set; ranks are assigned before paging. `totalCount` counts that set, `truncated` means another page exists, and `nextOffset` appears only then. A nonempty `geographies` filter also returns `scope_rank` against all fetched geographies and `scopeCount` for that denominator
- Takes the same `predicates`, variable limit, validation, `variable_labels`, and `applied_filters` as `census_query_data`; a `"*"` predicate or a multi-record dataset fails with `ambiguous_rows` unless `predicates` pins one record (`{"MONTH": "7"}` on `pep/charv`); on `geoinfo` 2020 at levels delineated twice only `GEO_ID` separates the rows and no predicate pins one per geography, so compare a vintage with one row per geography. Suppressed values sort last with the same reasons, and text values can't be ranked (the notice says so). Requires `CENSUS_API_KEY`

---

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Census-specific:

- In-process variable cache with configurable TTL — variables.json fetched once per dataset+year, searched client-side
- Three-API backend: Census Data API for data queries, TIGERweb for named-place resolution, Census Geocoder for address-to-tract
- Automatic retry with backoff on all external API calls
- Keyed tool calls share a 50-second upstream budget across metadata, data, retries, and optional probes; data requests retain a 40-second ceiling within the remaining budget. `census_resolve_geography` runs every TIGERweb and geocoder request of one call inside the same 50-second budget
- FIPS formatting helpers — zero-padded state, county, and tract codes ready to pass between tools

Agent-friendly output:

- Workflow-oriented tool surface — `fips_summary` and `state_fips` return values are ready to pass as `geography_fips` and `parent_fips` to the next tool
- Suppression codes decoded — Census negative sentinel values (e.g., `-666666666`) and business-dataset withholding flags (e.g., `D`) surfaced as their published meanings instead of raw numbers or false zeros
- Recovery hints on errors — ambiguous geography names include candidate lists; missing API key errors include registration URL

---

## Getting started

Connect to the hosted instance, no install:

```sh
claude mcp add --transport http census-mcp-server https://census.caseyjhand.com/mcp
```

Or run it locally:

```sh
claude mcp add census-mcp-server -e CENSUS_API_KEY=your-key -- npx -y @cyanheads/census-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "census-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/census-mcp-server"],
      "env": { "CENSUS_API_KEY": "your-key" }
    }
  }
}
```

Register a free key at [api.census.gov/data/key_signup.html](https://api.census.gov/data/key_signup.html). Data queries (`census_query_data`, `census_compare_geographies`) require it, as does `census_list_predicate_values` for a dimension it enumerates live; variable search and geography resolution work without one. For Docker or a source build, see [Running the server](#running-the-server).

---

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `CENSUS_API_KEY` | **Required for data queries** (`census_query_data`, `census_compare_geographies`) and for `census_list_predicate_values` on a live-enumerated dimension; without it those fail with `missing_api_key`, and a dictionary list comes back unchecked. Register free at api.census.gov/data/key_signup.html. | — |
| `CENSUS_DEFAULT_YEAR` | Default vintage year when no year is specified. | `2024` |
| `CENSUS_VARIABLE_CACHE_TTL_HOURS` | Hours to cache variables.json per dataset+year in memory. | `24` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateful`, `stateless`, or `auto`. | `stateless` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `notice`, `warning`, `error`). | `info` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log each failed tool call's arguments and result, redacted by key name and capped at `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` (default `16384`). A secret inside a free-form value is not redacted. | `false` |
| `OTEL_ENABLED` | Enable OpenTelemetry instrumentation. | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

---

## Running the server

### Local development

Requires [Bun v1.4.4](https://bun.sh/) or higher (or Node.js v24+).

- **Clone and install:**

  ```sh
  git clone https://github.com/cyanheads/census-mcp-server.git
  cd census-mcp-server && bun install
  cp .env.example .env   # set CENSUS_API_KEY
  ```

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security audit
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker run --rm -e CENSUS_API_KEY=your-key -p 3010:3010 ghcr.io/cyanheads/census-mcp-server:latest
```

The image defaults to HTTP transport, stateless session mode, and logs to `/var/log/census-mcp-server`. To run it over stdio from an MCP client, use `"command": "docker"` with `"args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "-e", "CENSUS_API_KEY=your-key", "ghcr.io/cyanheads/census-mcp-server:latest"]`. To build locally, `docker build -t census-mcp-server .`; OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

---

## Project structure

| Path | Purpose |
|:-----|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and initializes services. |
| `src/config/server-config.ts` | Census-specific env var parsing and validation with Zod. |
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`). |
| `src/services/census-api/` | Census Data API client — data queries, suppression code mapping, retry logic. |
| `src/services/geography/` | Geography resolution — TIGERweb named-place lookup and Census Geocoder address-to-tract. |
| `src/services/variable-cache/` | In-process variables.json cache with TTL and keyword search. |
| `tests/` | Vitest tests mirroring `src/` structure. |

---

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools via the barrel in `src/mcp-server/tools/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

---

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

---

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
