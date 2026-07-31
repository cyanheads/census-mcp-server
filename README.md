<div align="center">
  <h1>@cyanheads/census-mcp-server</h1>
  <p><b>Query U.S. Census Bureau data, variables, and geography via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.12-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/census-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/census-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/census-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.14-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/census-mcp-server/releases/latest/download/census-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=census-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvY2Vuc3VzLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22census-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fcensus-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://census.caseyjhand.com/mcp](https://census.caseyjhand.com/mcp)

</div>

---

## Tools

7 tools covering the full Census data workflow — from dataset discovery and variable search through geography resolution and ranked comparisons:

| Tool | Description |
|:-----|:------------|
| `census_list_datasets` | Browse available Census Bureau datasets (ACS5, ACS1, Population Estimates, Decennial) with vintage years and dataset codes. |
| `census_list_geographies` | List the geography levels supported by a dataset and year, with parent requirements and example FIPS values. |
| `census_search_variables` | Keyword search across variable labels and concept groups. Returns estimate and margin-of-error codes together. |
| `census_get_variable` | Fetch full metadata for one or more variable codes — label, concept, predicate type, universe, MOE sibling. |
| `census_resolve_geography` | Convert place names (e.g., "King County, WA") or street addresses to Census FIPS identifiers via TIGERweb and Census Geocoder. |
| `census_query_data` | Query a Census dataset for variables at a specific geography. Returns estimates with MOE, suppression codes resolved to readable reasons. |
| `census_compare_geographies` | Rank and compare variables across multiple geographies — all counties in a state, all states nationally, or a named set. Sorted table output. |

### `census_list_datasets`

Browse available Census Bureau datasets.

- Returns dataset codes, names, descriptions, and available vintage years
- Covers ACS5, ACS5 Data Profiles, ACS5 Subject Tables, ACS1, ACS1 Data Profiles, Population Estimates, Decennial Redistricting (P.L. 94-171), and Decennial DHC
- Accepts an optional keyword filter
- Dataset codes (e.g., `acs/acs5`) are the values to pass to other tools

---

### `census_search_variables`

Search Census variables by keyword.

- Full-text search across label and concept fields with relevance scoring (exact concept match > label match > partial)
- Returns estimate (E suffix) and margin-of-error (M suffix) codes together so both can be requested in one query
- Configurable limit (default 20, max 100); `total_matches` indicates how many matched before the limit
- Cache-backed: variables.json is fetched once per dataset+year with a configurable TTL (default 24h)

---

### `census_resolve_geography`

Convert place names and addresses to Census FIPS identifiers.

- Named places (e.g., "King County, WA", "Seattle, WA", "California") resolved via TIGERweb MapServer
- Street addresses resolved to tract level via Census Geocoder
- Auto-detects the geography level — state for an abbreviation or spelled-out state name, county for "County"/"Borough"/"Parish", tract for "Tract", otherwise place falling back to county; `geography_type` overrides it
- Prefers an exactly-named match, so "Kansas City, MO" does not resolve to North Kansas City
- Never picks between matches: anything still matching more than one geography comes back as `ambiguous_name` with every candidate and its state abbreviation
- Returns `state_fips` (→ `parent_fips`) and `fips_summary` (→ `geography_fips`) ready to pass to other tools

---

### `census_query_data`

Query a Census dataset for one or more variables at a specific geography.

- Requires FIPS codes — use `census_resolve_geography` first for place names
- Use `geography_fips: "*"` to return all geographies at the level within the parent
- Suppression codes (geography too small, data not collected, etc.) resolved to human-readable reasons
- Variable labels enriched from cache and surfaced alongside estimates
- Requires `CENSUS_API_KEY`

---

### `census_compare_geographies`

Rank and compare variables across multiple geographies.

- Fetches all geographies at a level (e.g., all WA counties) in one API call, then sorts and slices
- Optional `within` parameter to constrain to a parent FIPS; omit for national comparison
- Optional `geographies` list to filter to specific FIPS values
- Configurable sort variable, direction, and limit (default 50, max 500)
- Suppressed values sorted to end of results and labeled rather than passed through as negative sentinels
- Requires `CENSUS_API_KEY`

---

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats with recovery hints
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

Census-specific:

- In-process variable cache with configurable TTL — variables.json fetched once per dataset+year, searched client-side
- Three-API backend: Census Data API for data queries, TIGERweb for named-place resolution, Census Geocoder for address-to-tract
- Automatic retry with backoff on all external API calls
- FIPS formatting helpers — zero-padded state, county, and tract codes ready to pass between tools

Agent-friendly output:

- Workflow-oriented tool surface — `fips_summary` and `state_fips` return values are ready to pass as `geography_fips` and `parent_fips` to the next tool
- Suppression codes decoded — Census negative sentinel values (e.g., `-666666666`) surfaced as human-readable reasons instead of raw numbers
- Recovery hints on errors — ambiguous geography names include candidate lists; missing API key errors include registration URL

---

## Getting started

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

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).
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

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

---

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
