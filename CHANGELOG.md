# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.3.2](changelog/0.3.x/0.3.2.md) — 2026-07-31

Fixed census_list_datasets advertising pep/charv vintages the Census API does not publish, and a dataset+year miss reaching the caller as raw upstream HTML (#28); fixed string-valued variables returning estimate: null indistinguishable from genuinely missing data (#29)

## [0.3.1](changelog/0.3.x/0.3.1.md) — 2026-07-31

Fixed census_list_predicate_values listing dataset-dictionary codes a dataset publishes no rows for (#26), and pep/charv returning two indistinguishable rows per geography that both entered comparison rankings (#27)

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-07-31

Added census_list_predicate_values to discover filter-dimension codes (#23), plus fixes for a raw 400 on an unaccepted parent (#21), silent no_data on an unpadded FIPS code (#25), and dec/ddhca/ecnbasic returning one category as if it were a total (#24)

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-07-31

census_resolve_geography now resolves metro/micro and combined statistical areas plus consolidated cities (#22), and takes a county_fips input to pin an ambiguous tract to one county (#20)

## [0.1.14](changelog/0.1.x/0.1.14.md) — 2026-07-31

Added County Business Patterns, Economic Census, and Nonemployer Statistics with predicate filtering (#9), and fixed census_search_variables/census_get_variable fabricating margin-of-error codes on non-ACS datasets (#17)

## [0.1.13](changelog/0.1.x/0.1.13.md) — 2026-07-31

census_query_data/census_compare_geographies: fixed cross-geography filtering with a new geography_geoid field (#16), and a geography level missing a required parent now fails before the query with an actionable error instead of a raw upstream 400 (#19)

## [0.1.12](changelog/0.1.x/0.1.12.md) — 2026-07-31

census_resolve_geography auto-detects place/state before defaulting to county, fixing wrong-place results (#15) and blank-state ambiguous_name candidates (#18); mcp-ts-core ^0.10.9 → ^0.11.0 maintenance

## [0.1.11](changelog/0.1.x/0.1.11.md) — 2026-06-20

mcp-ts-core ^0.10.6 → ^0.10.9 maintenance — ctx.content media collector, Canvas SQL invalid_sql classification, fresh-scaffold devcheck guards; new dependency-specifier + plugin-manifest packaging checks; skills + scripts re-synced; .codex-plugin longDescription filled

## [0.1.10](changelog/0.1.x/0.1.10.md) — 2026-06-12

mcp-ts-core ^0.10.6 adoption — explicit server identity, NotFound for unknown variable codes, truncation disclosure on variable search; MCPB bundle hardening

## [0.1.9](changelog/0.1.x/0.1.9.md) — 2026-06-04

county-scoped tract/block-group queries, geography_type enum validation, dataset_not_found error contract

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-06-02

@cyanheads/mcp-ts-core ^0.9.16 → ^0.9.21: per-request log context fix, fetchWithTimeout secret scrubbing, withRetry fail-fast on non-retryable errors

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-05-30

Enrichment adoption: query echo, result totals, and empty-result guidance in typed enrichment block on search/query/compare tools; @cyanheads/mcp-ts-core ^0.9.13 → ^0.9.16

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-05-28

mcp-ts-core ^0.9.13: HTTP body cap (413), session-init gate, quieter client-error logging, GET /mcp keywords; manifest user_config wiring; error code alignment

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-05-26

FUNDING.yml, Docker image, missing GitHub releases

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-05-24

Drop tsx, align all build scripts to bun-native execution; add funding metadata

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-05-24

Bug fixes and code simplification — geography resolution now fully functional (8 bugs fixed, 3 critical)

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-05-24

Scope npm package to @cyanheads/census-mcp-server

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-05-24

Launch release — full server implementation with 7 Census tools, 3 services, 47 tests, and polished docs/metadata

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-24

Initial release — US Census Bureau data via 7 MCP tools covering variable search, geography resolution, and ACS/decennial data queries
