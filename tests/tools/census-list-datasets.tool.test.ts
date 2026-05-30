/**
 * @fileoverview Tests for census_list_datasets tool.
 * @module tests/tools/census-list-datasets.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { censusListDatasets } from '@/mcp-server/tools/definitions/census-list-datasets.tool.js';

describe('censusListDatasets', () => {
  it('returns all datasets when no filter provided', () => {
    const ctx = createMockContext();
    const input = censusListDatasets.input.parse({});
    const result = censusListDatasets.handler(input, ctx);
    expect(result.datasets.length).toBeGreaterThan(0);
    expect(getEnrichment(ctx).totalCount).toBe(result.datasets.length);
    expect(result.datasets[0]).toHaveProperty('dataset_id');
    expect(result.datasets[0]).toHaveProperty('name');
    expect(result.datasets[0]).toHaveProperty('description');
    expect(result.datasets[0]).toHaveProperty('available_years');
  });

  it('includes acs/acs5 in the unfiltered list', () => {
    const ctx = createMockContext();
    const input = censusListDatasets.input.parse({});
    const result = censusListDatasets.handler(input, ctx);
    const acs5 = result.datasets.find((d) => d.dataset_id === 'acs/acs5');
    expect(acs5).toBeDefined();
    expect(acs5?.available_years.length).toBeGreaterThan(0);
  });

  it('filters by keyword matching name or description', () => {
    const ctx = createMockContext();
    const input = censusListDatasets.input.parse({ filter: 'Decennial' });
    const result = censusListDatasets.handler(input, ctx);
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

  it('filters by dataset_id substring', () => {
    const ctx = createMockContext();
    const input = censusListDatasets.input.parse({ filter: 'acs1' });
    const result = censusListDatasets.handler(input, ctx);
    expect(result.datasets.length).toBeGreaterThan(0);
    expect(result.datasets.every((d) => d.dataset_id.includes('acs1'))).toBe(true);
  });

  it('returns empty list for non-matching filter', () => {
    const ctx = createMockContext();
    const input = censusListDatasets.input.parse({ filter: 'NONEXISTENT_DATASET_XYZ' });
    const result = censusListDatasets.handler(input, ctx);
    expect(getEnrichment(ctx).totalCount).toBe(0);
    expect(result.datasets).toHaveLength(0);
  });

  it('sets filterApplied enrichment when filter is provided', () => {
    const ctx = createMockContext();
    const input = censusListDatasets.input.parse({ filter: 'acs' });
    censusListDatasets.handler(input, ctx);
    expect(getEnrichment(ctx).filterApplied).toBe('acs');
  });

  it('does not set filterApplied enrichment when no filter', () => {
    const ctx = createMockContext();
    const input = censusListDatasets.input.parse({});
    censusListDatasets.handler(input, ctx);
    expect(getEnrichment(ctx).filterApplied).toBeUndefined();
  });

  it('sets notice enrichment when filter yields no matches', () => {
    const ctx = createMockContext();
    const input = censusListDatasets.input.parse({ filter: 'NONEXISTENT_XYZ' });
    censusListDatasets.handler(input, ctx);
    expect(getEnrichment(ctx).notice).toContain('NONEXISTENT_XYZ');
  });

  it('treats whitespace-only filter as no filter (empty trim = no results)', () => {
    const ctx = createMockContext();
    const input = censusListDatasets.input.parse({ filter: '   ' });
    const result = censusListDatasets.handler(input, ctx);
    // Trimmed to empty string — no filter applied, returns all
    expect(result.datasets.length).toBeGreaterThan(0);
  });

  it('filter matching is case-insensitive', () => {
    const ctxUpper = createMockContext();
    const ctxLower = createMockContext();
    const upper = censusListDatasets.handler(
      censusListDatasets.input.parse({ filter: 'ACS' }),
      ctxUpper,
    );
    const lower = censusListDatasets.handler(
      censusListDatasets.input.parse({ filter: 'acs' }),
      ctxLower,
    );
    expect(upper.datasets.length).toBe(lower.datasets.length);
    expect(upper.datasets.map((d) => d.dataset_id)).toEqual(
      lower.datasets.map((d) => d.dataset_id),
    );
  });

  it('includes dec/pl dataset with correct years', () => {
    const ctx = createMockContext();
    const result = censusListDatasets.handler(censusListDatasets.input.parse({}), ctx);
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

  it('injection attempt in filter does not crash or leak', () => {
    const ctx = createMockContext();
    const input = censusListDatasets.input.parse({
      filter: "'; DROP TABLE datasets; --",
    });
    const result = censusListDatasets.handler(input, ctx);
    // In-memory filter — should return empty safely, no throw
    expect(result.datasets).toHaveLength(0);
  });
});
