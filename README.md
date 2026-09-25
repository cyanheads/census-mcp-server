<div align="center">
  <h1>@cyanheads/census-mcp-server</h1>
  <p><b>Query U.S. Census Bureau data, variables, and geography via MCP. STDIO or Streamable HTTP.</b>
  <div>8 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.4.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/census-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/census-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/census-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

U.S. Census Bureau data — datasets, variables, and geography — via the Census Data API, TIGERweb, and the Census Geocoder. Discover datasets and variables, resolve place names or addresses to FIPS codes, and query or rank demographic, economic, and housing estimates across geographies from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:-----|:------------|
| `census_list_datasets` | Browse available Census Bureau datasets (ACS5, ACS1, Population Estimates, Decennial, County Business Patterns, Economic Census, Nonemployer Statistics) with vintage years and dataset codes. |
| `census_list_geographies` | List the geography levels supported by a dataset and year, with parent requirements and example FIPS values. |
| `census_search_variables` | Keyword search across variable labels and concept groups. On ACS, returns estimate and margin-of-error codes together. |
| `census_get_variable` | Fetch full metadata for one or more variable codes — label, concept, predicate type, universe, MOE sibling. |
| `census_list_predicate_values` | List the codes a filter dimension accepts (`EMPSZES`, `LFO`, `POPGROUP`, `NAICS2017`…), from the dataset dictionary or a live wildcard enumeration. |
| `census_resolve_geography` | Convert place names (e.g., "King County, WA") or street addresses to Census FIPS identifiers via TIGERweb and Census Geocoder. |
| `census_query_data` | Query a Census dataset for variables at a specific geography. Returns estimates with MOE, Census sentinel values and withheld business values resolved to their published meanings, and predicate filtering for the business datasets. |
| `census_compare_geographies` | Rank and compare variables across multiple geographies — all counties in a state, all states nationally, or a named set. Sorted table output, with the same predicate filtering. |

---

## Capability reference

### `census_list_datasets` <sub>tool</sub>

- Returns dataset codes, names, descriptions, and available vintage years
- Covers ACS5, ACS5 Data Profiles, ACS5 Subject Tables, ACS1, ACS1 Data Profiles, Population Estimates, Decennial Redistricting (P.L. 94-171), Decennial DHC, County Business Patterns (`cbp`), Economic Census (`ecnbasic`), and Nonemployer Statistics (`nonemp`)
- Each description names the filter predicates the dataset requires and the geography levels it publishes — both vary by dataset
- Accepts an optional keyword filter
- Dataset codes (e.g., `acs/acs5`) are the values to pass to other tools
- `available_years` is exhaustive, not a sample: any other year fails with `year_not_available` before a request goes out, naming the years that do work. It is narrower than what the Census API hosts — `pep/charv` reaches its 2020-2022 estimates through the `YEAR` filter inside the 2023 vintage, and the `cbp`/`nonemp` vintages left out reject the `NAME` column every query here sends

---

### `census_list_geographies` <sub>tool</sub>

- Returns one row per geography level — `geography_level`, whether a parent is required, `required_parent_levels`, and an example FIPS value
- `geography_level` values are the exact inputs to `geography_level` in `census_query_data` and `census_compare_geographies`
- `year` defaults to the dataset's latest available vintage
- `dataset_not_found` when the dataset code is unrecognized; `year_not_available` when the dataset has no geography data for the requested year

---

### `census_search_variables` <sub>tool</sub>

- Full-text search across label and concept fields with relevance scoring (exact concept match > label match > partial)
- On ACS datasets, returns estimate (E suffix) and margin-of-error (M suffix) codes together so both can be requested in one query — no other family publishes margins of error, and an E-final code there is an ordinary code
- Also surfaces the predicate codes a dataset filters on, such as `NAICS2017` in `cbp`
- `limit` is an integer from 1 to 100 (default 20) — out-of-range values are rejected, not clamped; `totalMatches` says how many matched before the limit
- Cache-backed: variables.json is fetched once per dataset+year with a configurable TTL (default 24h)

---

### `census_get_variable` <sub>tool</sub>

- Accepts one or more variable codes (case-sensitive) and returns metadata in the same order — label, concept, predicate type, and universe when the dataset publishes one
- On ACS datasets, returns `estimate_code`/`moe_code` sibling references; other families publish no margins of error and carry neither field
- Also resolves predicate/filter dimension codes (e.g., `NAICS2017`, `SEX`) to confirm a dimension exists in a dataset — `census_list_predicate_values` lists the values it accepts
- `dataset` defaults to `acs/acs5`, `year` defaults to the dataset's latest available vintage
- `variable_not_found` when a code isn't defined in the dataset and year

---

### `census_list_predicate_values` <sub>tool</sub>

- Two routes, picked by where the answer lives: a dimension with a published value list is read from the dataset dictionary, one without is enumerated live by wildcarding it on the data endpoint. `NAICS*` and `POPGROUP` always publish one (thousands of codes — narrow them with `query`); on the current vintages `EMPSZES`, `LFO`, `RCPSZES`, `TAXSTAT`, and `TYPOP` publish none, so the live route is the only place their codes appear
- A dictionary value list is a classification shared across Census products, not a record of what one dataset serves — `dec/ddhca` declares 5,543 `POPGROUP` codes and publishes 2,996, `cbp` declares 6,694 `NAICS2017` codes and publishes 2,003. The declared list is checked against the dataset's own published rows and the dead codes are dropped; `source` says whether that check ran and the notice says how many were withheld
- Keyword `query` matches code and label; results are sorted by code and a truncated list is disclosed rather than passed off as complete (`limit` an integer from 1 to 500, default 50; `totalCount` says how many matched)
- `ecnbasic` publishes `TAXSTAT` and `TYPOP` per industry, so `within_naics` scopes the enumeration — and the notice says the result is complete for that industry alone
- Live enumerations are cached per dataset, year, dimension, industry scope, and probe measure

---

### `census_resolve_geography` <sub>tool</sub>

- Named places (e.g., "King County, WA") resolve via TIGERweb; street addresses resolve to tract level via Census Geocoder
- Auto-detects `geography_type` for state, county, place, and tract; metropolitan/micropolitan statistical areas, combined statistical areas, and consolidated cities are never auto-detected and need an explicit `geography_type`, since their names overlap city names
- Optional `county_fips` scopes resolution to the county and tract levels only — required when a tract name matches more than one county; `county_scope_unsupported` when paired with any other level or a street address
- Prefers an exactly-named match over a partial one (e.g., "Kansas City, MO" does not resolve to North Kansas City)
- A name matching more than one geography returns `ambiguous_name`, with every candidate's FIPS code and the state that separates them
- Returns `state_fips` (→ `parent_fips`) and `fips_summary` (→ `geography_fips`) ready to pass to other tools; a statistical area omits `state_fips` since it can span several states

---

### `census_query_data` <sub>tool</sub>

- Requires FIPS codes (use `census_resolve_geography` for place names); `geography_fips: "*"` returns every geography at the level within the parent, and each row carries both `geography_fips` and the nationally-unique `geography_geoid`
- A wildcard returns up to `limit` rows (default 50, max 500) in GEOID order, and `offset` pages through the rest; `totalCount` and `truncated` say how many rows matched, and the notice names the range returned and the next `offset`. Every row counts, including each `pep/charv` record and each category of a `"*"` predicate
- Up to 49 variable codes per call, fewer on datasets where label or record columns are added: the Census API accepts 50 columns per request and every query also sends `NAME`. `too_many_variables` states the exact maximum before any request goes out. Codes are case-insensitive, and an unknown one is `variable_not_found`
- Level and parent are checked against the dataset's own geography metadata before querying — `parent_required` and `parent_not_accepted` name what's missing or unaccepted rather than surfacing a raw Census 400
- Optional `predicates` map filters the business/`pep`/`dec` datasets (e.g., `{"NAICS2017": "5112"}`); a dimension left unset applies a Census-chosen default — an all-categories total on some datasets, a single category on others — echoed per row in `applied_filters`. Keys are case-insensitive and a blank value counts as omitted; `"*"` returns one row per category, each labelled in `record`
- A dataset that publishes more than one record per geography (`pep/charv`) returns multiple rows, each carrying a `record` field; pin one with `predicates` (e.g., `{"MONTH": "7"}`)
- ACS sentinel values resolve to the Census's published meanings, a controlled estimate's margin of error reads as `0`, and a median in an open-ended interval is flagged `open_ended`. On `cbp`, `ecnbasic`, and `nonemp`, a value the Census withheld (stored as `0` beside a flag such as `D`) is reported as suppressed with the flag's meaning. A null `estimate` means the value is either suppressed, a text cell (returned under `value`), or genuinely empty
- Requires `CENSUS_API_KEY`

---

### `census_compare_geographies` <sub>tool</sub>

- Ranks all geographies at a level, or a named `geographies` list of GEOIDs/bare level codes, in one call; `within`/`within_county` scope to a state/county, omit for a national comparison
- Ranks on one variable's value: `sort_by` (default the first code; it must be one of the requested codes, or the call fails with `sort_by_not_requested`), `sort_dir` (default `desc`), and `limit` (an integer from 1 to 500, default 50); `totalCount` reports how many geographies matched before the limit
- A count ranks by size, not rate — rank a published percentage for a rate, e.g. `S1701_C03_001E` (percent below poverty, `acs/acs5/subject`) or `DP04_0047PE` (percent renter-occupied, `acs/acs5/profile`), both available down to tract
- Same `predicates` map, variable limit, geography validation, and `applied_filters` default-echoing as `census_query_data`, applied to every geography in the ranking
- A dataset that publishes more than one record per geography (`pep/charv`), or a `"*"` predicate, fails with `ambiguous_rows` unless `predicates` pins one (e.g., `{"MONTH": "7"}`)
- Suppressed values carry the same reasons as `census_query_data` and sort to the end in either direction, withheld business values included; a text value has no ordering, so sorting on it leaves rows tied, and the notice says the rows are not ranked
- Requires `CENSUS_API_KEY`

---

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Census-specific:

- In-process variable cache with configurable TTL — variables.json fetched once per dataset+year, searched client-side
- Three-API backend: Census Data API for data queries, TIGERweb for named-place resolution, Census Geocoder for address-to-tract
- Automatic retry with backoff on all external API calls
- FIPS formatting helpers — zero-padded state, county, and tract codes ready to pass between tools

Agent-friendly output:

- Workflow-oriented tool surface — `fips_summary` and `state_fips` return values are ready to pass as `geography_fips` and `parent_fips` to the next tool
- Suppression codes decoded — Census negative sentinel values (e.g., `-666666666`) and business-dataset withholding flags (e.g., `D`) surfaced as their published meanings instead of raw numbers or false zeros
- Recovery hints on errors — ambiguous geography names include candidate lists; missing API key errors include registration URL

---

## Getting started

### Public Hosted Instance

A public instance is available at `https://census.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "census-mcp-server": {
      "type": "streamable-http",
      "url": "https://census.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

> **API key:** Register a free key at [api.census.gov/data/key_signup.html](https://api.census.gov/data/key_signup.html). Variable search and geography resolution work without a key; data queries (`census_query_data`, `census_compare_geographies`) require one.

Add the following to your MCP client configuration file:

```json
{
  "mcpServers": {
    "census-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/census-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "CENSUS_API_KEY": "your-census-api-key"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "census-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/census-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "CENSUS_API_KEY": "your-census-api-key"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "census-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-e", "CENSUS_API_KEY=your-census-api-key",
        "ghcr.io/cyanheads/census-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 CENSUS_API_KEY=... bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- A Census API key — register free at [api.census.gov/data/key_signup.html](https://api.census.gov/data/key_signup.html). Required for `census_query_data` and `census_compare_geographies`; other tools work without it.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/census-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd census-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set CENSUS_API_KEY
```

---

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `CENSUS_API_KEY` | **Required for data queries.** Register free at api.census.gov/data/key_signup.html. | — |
| `CENSUS_DEFAULT_YEAR` | Default vintage year when no year is specified. | `2024` |
| `CENSUS_VARIABLE_CACHE_TTL_HOURS` | Hours to cache variables.json per dataset+year in memory. | `24` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateful`, `stateless`, or `auto`. The server declares `stateless` in `src/index.ts`; set this only to override it. | `stateless` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `notice`, `warning`, `error`). | `info` |
| `OTEL_ENABLED` | Enable OpenTelemetry instrumentation. | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

---

## Running the server

### Local development

```sh
# One-time build
bun run rebuild

# Run the built server
bun run start:stdio
# or
bun run start:http
```

Run checks and tests:

```sh
bun run devcheck   # Lint, format, typecheck, security audit
bun run test       # Vitest test suite
bun run lint:mcp   # Validate MCP definitions against spec
```

### Docker

```sh
docker build -t census-mcp-server .
docker run --rm -e CENSUS_API_KEY=your-key -p 3010:3010 census-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/census-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

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
