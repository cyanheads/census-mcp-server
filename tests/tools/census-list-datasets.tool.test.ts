/**
 * @fileoverview Tests for census_list_datasets tool.
 * @module tests/tools/census-list-datasets.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { censusListDatasets } from '@/mcp-server/tools/definitions/census-list-datasets.tool.js';

describe('censusListDatasets', () => {
  it('returns all datasets when no filter provided', async () => {
    const ctx = createMockContext();
    const input = censusListDatasets.input.parse({});
    const result = await censusListDatasets.handler(input, ctx);
    expect(result.datasets.length).toBeGreaterThan(0);
    expect(getEnrichment(ctx).totalCount).toBe(result.datasets.length);
    expect(result.datasets[0]).toHaveProperty('dataset_id');
    expect(result.datasets[0]).toHaveProperty('name');
    expect(result.datasets[0]).toHaveProperty('description');
    expect(result.datasets[0]).toHaveProperty('available_years');
  });

  it('includes acs/acs5 in the unfiltered list', async () => {
    const ctx = createMockContext();
    const input = censusListDatasets.input.parse({});
    const result = await censusListDatasets.handler(input, ctx);
    const acs5 = result.datasets.find((d) => d.dataset_id === 'acs/acs5');
    expect(acs5).toBeDefined();
    expect(acs5?.available_years.length).toBeGreaterThan(0);
  });

  it.each([
    ['cbp', 2023, 'NAICS2017'],
    ['ecnbasic', 2022, 'NAICS2022'],
    ['nonemp', 2023, 'NAICS2022'],
  ])(
    'catalogs %s with its latest year and required industry predicate',
    async (id, latestYear, naics) => {
      const ctx = createMockContext();
      const result = await censusListDatasets.handler(censusListDatasets.input.parse({}), ctx);
      const entry = result.datasets.find((d) => d.dataset_id === id);

      expect(entry).toBeDefined();
      expect(Math.max(...(entry?.available_years ?? []))).toBe(latestYear);
      expect(entry?.description).toContain(naics);
    },
  );

  /**
   * These datasets publish levels census_resolve_geography cannot resolve a name to — zip code,
   * congressional district, region, metropolitan division, economic place — so the catalog has to
   * name the gap. `us` is a level of all three and resolves from no name at all, so even nonemp,
   * whose named levels all resolve, cannot claim blanket coverage.
   */
  it.each([
    ['cbp', ['congressional district', 'zip code']],
    ['ecnbasic', ['region', 'metropolitan division', 'economic place']],
    ['nonemp', []],
  ] as const)(
    'tells a caller which %s geography levels census_resolve_geography cannot reach',
    async (id, unreachable) => {
      const ctx = createMockContext();
      const result = await censusListDatasets.handler(censusListDatasets.input.parse({}), ctx);
      const entry = result.datasets.find((d) => d.dataset_id === id);
      const description = entry?.description ?? '';

      expect(description).toContain('census_resolve_geography');

      const gap = description.slice(description.indexOf('census_resolve_geography'));
      expect(gap).toContain('literal value 1');
      for (const level of unreachable) {
        expect(gap).toContain(level);
      }
      if (unreachable.length === 0) {
        expect(gap).not.toContain('another source');
      }
    },
  );

  /**
   * Every query sends NAME in get=, and the older business vintages reject it with a 400 — cbp
   * before 2012, nonemp 2008 through 2011. Advertising them sends a caller at a guaranteed error.
   */
  it.each([
    ['cbp', [2004, 2008, 2011]],
    ['nonemp', [2008, 2009, 2010, 2011]],
  ])(
    'leaves the %s vintages that reject the NAME column out of the catalog',
    async (id, rejected) => {
      const ctx = createMockContext();
      const result = await censusListDatasets.handler(censusListDatasets.input.parse({}), ctx);
      const years = result.datasets.find((d) => d.dataset_id === id)?.available_years ?? [];

      for (const year of rejected) expect(years).not.toContain(year);
      expect(years).toContain(2012);
    },
  );

  /**
   * The Census API publishes one pep/charv vintage. Its 2020 through 2022 numbers are values of
   * that vintage's own YEAR dimension, so advertising them as vintages sent a caller at a
   * variables.json path that 404s.
   */
  it('advertises the single pep/charv vintage the API publishes', async () => {
    const ctx = createMockContext();
    const result = await censusListDatasets.handler(censusListDatasets.input.parse({}), ctx);
    const pep = result.datasets.find((d) => d.dataset_id === 'pep/charv');

    expect(pep?.available_years).toEqual([2023]);
    // The years that are gone from the list have to be reachable some other way.
    expect(pep?.description).toContain('YEAR');
    expect(pep?.description).toContain('2020 through 2023');
  });

  it('advertises exactly the years the query path serves', async () => {
    const { DATASET_AVAILABLE_YEARS } = await import(
      '@/services/variable-cache/variable-cache-service.js'
    );
    const ctx = createMockContext();
    const result = await censusListDatasets.handler(censusListDatasets.input.parse({}), ctx);

    for (const dataset of result.datasets) {
      expect(dataset.available_years).toEqual(DATASET_AVAILABLE_YEARS[dataset.dataset_id]);
    }
  });

  it('keeps the catalog in step with the dataset codes the tools accept', async () => {
    const { KNOWN_DATASETS } = await import('@/services/variable-cache/variable-cache-service.js');
    const ctx = createMockContext();
    const result = await censusListDatasets.handler(censusListDatasets.input.parse({}), ctx);

    expect(new Set(result.datasets.map((d) => d.dataset_id))).toEqual(KNOWN_DATASETS);
  });

  it('filters by keyword matching name or description', async () => {
    const ctx = createMockContext();
    const input = censusListDatasets.input.parse({ filter: 'Decennial' });
    const result = await censusListDatasets.handler(input, ctx);
    expect(result.datasets.length).toBeGreaterThan(0);
    const filterLower = 'decennial';
    expect(
      result.datasets.every(
        (d) =>
          d.name.toLowerCase().includes(filterLower) ||
          d.description.toLowerCase().includes(filterLower) ||
          d.dataset_id.toLowerCase().includes(filterLower),
      ),
    ).toBe(true);
  });

  it('filters by dataset_id substring', async () => {
    const ctx = createMockContext();
    const input = censusListDatasets.input.parse({ filter: 'acs1' });
    const result = await censusListDatasets.handler(input, ctx);
    expect(result.datasets.length).toBeGreaterThan(0);
    expect(result.datasets.every((d) => d.dataset_id.includes('acs1'))).toBe(true);
  });

  it('returns empty list for non-matching filter', async () => {
    const ctx = createMockContext();
    const input = censusListDatasets.input.parse({ filter: 'NONEXISTENT_DATASET_XYZ' });
    const result = await censusListDatasets.handler(input, ctx);
    expect(getEnrichment(ctx).totalCount).toBe(0);
    expect(result.datasets).toHaveLength(0);
  });

  it('sets filterApplied enrichment when filter is provided', async () => {
    const ctx = createMockContext();
    const input = censusListDatasets.input.parse({ filter: 'acs' });
    await censusListDatasets.handler(input, ctx);
    expect(getEnrichment(ctx).filterApplied).toBe('acs');
  });

  it('does not set filterApplied enrichment when no filter', async () => {
    const ctx = createMockContext();
    const input = censusListDatasets.input.parse({});
    await censusListDatasets.handler(input, ctx);
    expect(getEnrichment(ctx).filterApplied).toBeUndefined();
  });

  it('sets notice enrichment when filter yields no matches', async () => {
    const ctx = createMockContext();
    const input = censusListDatasets.input.parse({ filter: 'NONEXISTENT_XYZ' });
    await censusListDatasets.handler(input, ctx);
    expect(getEnrichment(ctx).notice).toContain('NONEXISTENT_XYZ');
  });

  it('treats whitespace-only filter as no filter (empty trim = no results)', async () => {
    const ctx = createMockContext();
    const input = censusListDatasets.input.parse({ filter: '   ' });
    const result = await censusListDatasets.handler(input, ctx);
    // Trimmed to empty string — no filter applied, returns all
    expect(result.datasets.length).toBeGreaterThan(0);
  });

  it('filter matching is case-insensitive', async () => {
    const ctxUpper = createMockContext();
    const ctxLower = createMockContext();
    const upper = await censusListDatasets.handler(
      censusListDatasets.input.parse({ filter: 'ACS' }),
      ctxUpper,
    );
    const lower = await censusListDatasets.handler(
      censusListDatasets.input.parse({ filter: 'acs' }),
      ctxLower,
    );
    expect(upper.datasets.length).toBe(lower.datasets.length);
    expect(upper.datasets.map((d) => d.dataset_id)).toEqual(
      lower.datasets.map((d) => d.dataset_id),
    );
  });

  it('includes dec/pl dataset with correct years', async () => {
    const ctx = createMockContext();
    const result = await censusListDatasets.handler(censusListDatasets.input.parse({}), ctx);
    const decPl = result.datasets.find((d) => d.dataset_id === 'dec/pl');
    expect(decPl).toBeDefined();
    expect(decPl?.available_years).toContain(2020);
  });

  it('format shows count and all dataset details including years', () => {
    const output = {
      datasets: [
        {
          dataset_id: 'acs/acs5',
          name: 'American Community Survey 5-Year Estimates',
          description: 'ACS 5-year estimates.',
          available_years: [2022, 2023, 2024],
        },
        {
          dataset_id: 'dec/pl',
          name: 'Decennial Census Redistricting Data',
          description: 'Redistricting data.',
          available_years: [2000, 2010, 2020],
        },
      ],
    };
    const blocks = censusListDatasets.format!(output);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).toContain('acs/acs5');
    expect(text).toContain('American Community Survey');
    expect(text).toContain('2024');
    expect(text).toContain('dec/pl');
    expect(text).toContain('Decennial');
  });

  it('format output does not contain secrets or API keys', () => {
    const output = {
      datasets: [
        {
          dataset_id: 'acs/acs5',
          name: 'ACS 5-Year',
          description: 'ACS.',
          available_years: [2024],
        },
      ],
    };
    const blocks = censusListDatasets.format!(output);
    const text = (blocks[0] as { type: string; text: string }).text;
    expect(text).not.toMatch(/api.key/i);
    expect(text).not.toMatch(/CENSUS_API_KEY/);
    expect(text).not.toMatch(/secret/i);
  });

  it('injection attempt in filter does not crash or leak', async () => {
    const ctx = createMockContext();
    const input = censusListDatasets.input.parse({
      filter: "'; DROP TABLE datasets; --",
    });
    const result = await censusListDatasets.handler(input, ctx);
    // In-memory filter — should return empty safely, no throw
    expect(result.datasets).toHaveLength(0);
  });
});
