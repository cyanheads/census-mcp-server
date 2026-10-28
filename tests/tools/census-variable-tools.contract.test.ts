/**
 * @fileoverview Contract tests for census_search_variables, census_get_variable, and
 * census_list_predicate_values, run through the real VariableCacheService and CensusApiService
 * over a routed fetch fake. The ranking, the shared-table rule, attribute resolution, the universe
 * join, and code normalization all live below the handlers, so these tests read both client
 * surfaces the tools produce rather than a stubbed service's return value.
 * @module tests/tools/census-variable-tools.contract.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { censusGetVariable } from '@/mcp-server/tools/definitions/census-get-variable.tool.js';
import { censusListPredicateValues } from '@/mcp-server/tools/definitions/census-list-predicate-values.tool.js';
import { censusSearchVariables } from '@/mcp-server/tools/definitions/census-search-variables.tool.js';
import { initCensusApiService } from '@/services/census-api/census-api-service.js';
import { initVariableCacheService } from '@/services/variable-cache/variable-cache-service.js';

vi.mock('@/config/server-config.js', () => ({
  getDiscoveryConfig: vi.fn(() => ({ defaultYear: 2024, variableCacheTtlHours: 24 })),
  getServerConfig: vi.fn(() => ({
    defaultYear: 2024,
    censusApiKey: 'test-key',
    variableCacheTtlHours: 24,
  })),
}));

/** A route that answers each request itself — a hang, a rejection, or a different answer per call. */
type RouteFn = (init?: RequestInit) => Promise<Response>;

let routes: Record<string, unknown> = {};
let calls: URL[] = [];

beforeEach(() => {
  routes = {};
  calls = [];
  initCensusApiService();
  initVariableCacheService();
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(url);
      const body = routes[url.pathname];
      if (body === undefined) return Promise.reject(new Error(`unmocked fetch: ${url.pathname}`));
      if (typeof body === 'function') return (body as RouteFn)(init);
      if (body instanceof Response) return Promise.resolve(body.clone());
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((c) => c.text ?? '').join('\n');

interface VariableRow {
  attribute_of?: string;
  attribute_type?: string;
  concept?: string;
  label: string;
  universe?: string;
  variable_code: string;
}

const structured = (result: { structuredContent?: unknown }) =>
  result.structuredContent as {
    variables: VariableRow[];
    notice?: string;
    totalMatches?: number;
    truncated?: boolean;
    predicate?: string;
    values?: Array<{ code: string; label: string }>;
    error?: { code: number; message: string; data: Record<string, unknown> };
  };

/** GEO_ID's concept joins every table it belongs to; the real one runs to 99,266 bytes. */
const GEO_ID_CONCEPT = Array.from(
  { length: 400 },
  (_, i) => `Poverty Status in the Past 12 Months by Sex by Age Table ${i};Coverage Rate ${i}`,
).join(';');

const acsVariables = {
  GEO_ID: {
    label: 'Geography',
    concept: GEO_ID_CONCEPT,
    predicateType: 'string',
    group: 'B17001,B98011,B19013',
    attributes: 'NAME',
  },
  B19013B_001E: {
    label:
      'Estimate!!Median household income in the past 12 months (in 2024 inflation-adjusted dollars)',
    concept:
      'Median Household Income in the Past 12 Months (in 2024 Inflation-Adjusted Dollars) (Black or African American Alone Householder)',
    predicateType: 'int',
    group: 'B19013B',
    attributes: 'B19013B_001EA,B19013B_001M,B19013B_001MA',
  },
  B19013_001E: {
    label:
      'Estimate!!Median household income in the past 12 months (in 2024 inflation-adjusted dollars)',
    concept: 'Median Household Income in the Past 12 Months (in 2024 Inflation-Adjusted Dollars)',
    predicateType: 'int',
    group: 'B19013',
    attributes: 'B19013_001EA,B19013_001M,B19013_001MA',
  },
  B17001_002E: {
    label: 'Estimate!!Total:!!Income in the past 12 months below poverty level:',
    concept: 'Poverty Status in the Past 12 Months by Sex by Age',
    predicateType: 'int',
    group: 'B17001',
  },
  B25077_001E: {
    label: 'Estimate!!Median value (dollars)',
    concept: 'Median Value (Dollars)',
    predicateType: 'int',
    group: 'B25077',
  },
};

const acsGroups = {
  groups: [
    { name: 'B19013', description: 'Median Household Income', 'universe ': 'Households' },
    {
      name: 'B19013B',
      description: 'Median Household Income (Black)',
      'universe ': 'Households with a householder who is Black or African American alone',
    },
    {
      name: 'B17001',
      description: 'Poverty Status',
      'universe ': 'Population for whom poverty status is determined',
    },
    {
      name: 'B25077',
      description: 'Median Value (Dollars)',
      'universe ': 'Owner-occupied housing units',
    },
  ],
};

const serveAcs = () => {
  routes['/data/2024/acs/acs5/variables.json'] = { variables: acsVariables };
  routes['/data/2024/acs/acs5/groups.json'] = acsGroups;
  routes['/data/2024/acs/acs5/variables/B19013_001EA.json'] = {
    name: 'B19013_001EA',
    label:
      'Annotation of Estimate!!Median household income in the past 12 months (in 2024 inflation-adjusted dollars)',
    concept: 'Median Household Income in the Past 12 Months (in 2024 Inflation-Adjusted Dollars)',
    predicateType: 'string',
    group: 'B19013',
    limit: 0,
    'attribute of': 'B19013_001E',
    'attribute type': 'ANNOTATION',
  };
};

describe('census_search_variables on both surfaces', () => {
  it('ranks the base variable first and never returns the shared GEO_ID column (#33, #34)', async () => {
    serveAcs();

    const result = await runToolContract(censusSearchVariables, {
      query: 'median household income',
    });

    const out = structured(result);
    expect(out.variables.map((v) => v.variable_code)).toEqual([
      'B19013_001E',
      'B19013_001M',
      'B19013B_001E',
      'B19013B_001M',
    ]);
    expect(out.totalMatches).toBe(4);
    const text = textOf(result);
    expect(text.indexOf('`B19013_001E`')).toBeLessThan(text.indexOf('`B19013B_001E`'));
  });

  it('keeps GEO_ID and its concept off both surfaces for an unrelated query (#33)', async () => {
    serveAcs();

    const result = await runToolContract(censusSearchVariables, { query: 'poverty rate' });

    expect(structured(result).variables.map((v) => v.variable_code)).not.toContain('GEO_ID');
    expect(JSON.stringify(result.structuredContent)).not.toContain('Coverage Rate 399');
    expect(textOf(result)).not.toContain('GEO_ID');
  });

  it('returns GEO_ID for a label match, with no concept on either surface (#33)', async () => {
    serveAcs();

    const result = await runToolContract(censusSearchVariables, { query: 'geography' });

    const [geoId] = structured(result).variables;
    expect(geoId?.variable_code).toBe('GEO_ID');
    expect(geoId).not.toHaveProperty('concept');
    const text = textOf(result);
    expect(text).toContain('`GEO_ID`');
    expect(text).not.toContain('**Concept:**');
    expect(text).not.toContain('Coverage Rate');
  });

  it('keeps a single-table concept on both surfaces (#33)', async () => {
    serveAcs();

    const result = await runToolContract(censusSearchVariables, {
      query: 'median household income',
      limit: 1,
    });

    expect(structured(result).variables[0]?.concept).toBe(
      'Median Household Income in the Past 12 Months (in 2024 Inflation-Adjusted Dollars)',
    );
    expect(textOf(result)).toContain(
      '**Concept:** Median Household Income in the Past 12 Months (in 2024 Inflation-Adjusted Dollars)',
    );
  });

  it('says on both surfaces when no variable holds every term (#34)', async () => {
    serveAcs();

    const result = await runToolContract(censusSearchVariables, { query: 'median home value' });

    const out = structured(result);
    expect(out.variables[0]?.variable_code).toBe('B25077_001E');
    expect(out.notice).toMatch(/no variable contains every word/i);
    expect(out.notice).toContain('2 of its 3 words');
    expect(textOf(result)).toContain('2 of its 3 words');
  });

  it('keeps the partial-match statement when the fallback is also cut at the limit (#34)', async () => {
    serveAcs();

    const result = await runToolContract(censusSearchVariables, {
      query: 'median home value',
      limit: 1,
    });

    const out = structured(result);
    expect(out.truncated).toBe(true);
    expect(out.notice).toContain('2 of its 3 words');
    expect(out.notice).toMatch(/not shown/);
  });

  it('explains an empty result on both surfaces (#34)', async () => {
    serveAcs();

    const result = await runToolContract(censusSearchVariables, { query: 'xyzzy' });

    expect(structured(result).variables).toEqual([]);
    expect(structured(result).totalMatches).toBe(0);
    expect(textOf(result)).toContain('No variables matched "xyzzy"');
  });

  it('ranks an estimate ahead of its margin for a query naming "estimate" (#58)', async () => {
    serveAcs();

    const result = await runToolContract(censusSearchVariables, {
      query: 'annotation of estimate median household income',
    });

    const codes = structured(result).variables.map((v) => v.variable_code);
    expect(codes[0]).toBe('B19013_001E');
    expect(codes.every((code) => code.endsWith('M'))).toBe(false);
    const text = textOf(result);
    expect(text.indexOf('`B19013_001E`')).toBeLessThan(text.indexOf('`B19013_001M`'));
  });

  it('keeps an estimate ahead of its margin for a query holding "of" (#58)', async () => {
    serveAcs();

    const result = await runToolContract(censusSearchVariables, { query: 'median value of' });

    const out = structured(result);
    expect(out.variables.map((v) => v.variable_code)).toEqual(['B25077_001E', 'B25077_001M']);
    expect(out.notice).toContain('2 of its 3 words');
    const text = textOf(result);
    expect(text.indexOf('`B25077_001E`')).toBeLessThan(text.indexOf('`B25077_001M`'));
    expect(text).toContain('2 of its 3 words');
  });

  it('says a query with no letters or digits has nothing to match (#34)', async () => {
    serveAcs();

    const result = await runToolContract(censusSearchVariables, { query: '!!--' });

    expect(structured(result).variables).toEqual([]);
    expect(structured(result).notice).toMatch(/no letters or digits/i);
  });
});

describe('census_search_variables matches a variable or table code (#63)', () => {
  const paths = () => calls.map((u) => u.pathname);
  const notHeld = () =>
    new Response(
      '<!doctype html><html lang="en"><head><title>HTTP Status 404 – Not Found</title></head><body><h1>HTTP Status 404 – Not Found</h1></body></html>',
      { status: 404, headers: { 'content-type': 'text/html' } },
    );

  const serveSubject = () => {
    const row = (label: string) => ({
      label,
      concept: 'Poverty Status in the Past 12 Months',
      predicateType: 'int',
      group: 'S1701',
    });
    routes['/data/2024/acs/acs5/subject/variables.json'] = {
      variables: {
        S1701_C03_001E: row(
          'Estimate!!Percent below poverty level!!Population for whom poverty status is determined',
        ),
        S1701_C01_001E: row('Estimate!!Total!!Population for whom poverty status is determined'),
        S1701_C02_001E: row(
          'Estimate!!Below poverty level!!Population for whom poverty status is determined',
        ),
      },
    };
  };

  it('returns a table ID as its variables in code order, on both surfaces', async () => {
    serveAcs();

    const result = await runToolContract(censusSearchVariables, { query: 'B19013' });

    const out = structured(result);
    expect(out.variables.map((v) => v.variable_code)).toEqual(['B19013_001E', 'B19013_001M']);
    expect(out.totalMatches).toBe(2);
    expect(out.notice).toBeUndefined();
    const text = textOf(result);
    expect(text.indexOf('`B19013_001E`')).toBeGreaterThan(-1);
    expect(text.indexOf('`B19013_001E`')).toBeLessThan(text.indexOf('### `B19013_001M`'));
    expect(paths()).toEqual(['/data/2024/acs/acs5/variables.json']);
  });

  it('returns a lowercase variable code first, with no partial-match notice', async () => {
    serveAcs();

    const result = await runToolContract(censusSearchVariables, { query: 'b19013_001e' });

    const out = structured(result);
    expect(out.variables[0]?.variable_code).toBe('B19013_001E');
    expect(out.totalMatches).toBe(1);
    expect(out.notice).toBeUndefined();
    expect(textOf(result)).toContain('### `B19013_001E`');
    expect(textOf(result)).not.toMatch(/every word/i);
  });

  it('cuts a table at the limit in code order, with the truncation notice', async () => {
    serveSubject();

    const result = await runToolContract(censusSearchVariables, {
      query: 'S1701',
      dataset: 'acs/acs5/subject',
      limit: 3,
    });

    const out = structured(result);
    expect(out.variables.map((v) => v.variable_code)).toEqual([
      'S1701_C01_001E',
      'S1701_C01_001M',
      'S1701_C02_001E',
    ]);
    expect(out.totalMatches).toBe(6);
    expect(out.truncated).toBe(true);
    expect(out.notice).toBe(
      '6 variables matched — 3 not shown; the table continues in code order after S1701_C02_001E. Raise limit (max 100), or search a later variable code on its own — a word added to a table code ends the code match.',
    );
    expect(textOf(result)).toContain('the table continues in code order after S1701_C02_001E');
    expect(textOf(result)).not.toContain('### `S1701_C02_001M`');
    expect(textOf(result)).toContain('### `S1701_C02_001E`');
  });

  it.each([
    ['S1701_C03_001E', '/data/2024/acs/acs5/subject/variables/S1701_C03_001E.json'],
    ['S1701', '/data/2024/acs/acs5/subject/groups/S1701.json'],
  ])('names acs/acs5/subject for %s searched in acs/acs5', async (query, lookup) => {
    serveAcs();
    routes[lookup] = { name: query };

    const result = await runToolContract(censusSearchVariables, { query });

    const out = structured(result);
    expect(out.variables).toEqual([]);
    expect(out.totalMatches).toBe(0);
    const hint = `${query} is in acs/acs5/subject — query that dataset instead.`;
    expect(out.notice).toContain(hint);
    expect(out.notice).not.toMatch(/broader keywords/i);
    expect(textOf(result)).toContain(hint);
    expect(paths()).toEqual(['/data/2024/acs/acs5/variables.json', lookup]);
  });

  it('points an attribute column at census_get_variable, with no lookup', async () => {
    serveAcs();

    const result = await runToolContract(censusSearchVariables, { query: 'b19013_001ea' });

    const out = structured(result);
    expect(out.variables).toEqual([]);
    const notice =
      'B19013_001EA is an attribute column of acs/acs5 (2024) — an annotation, flag, label, or significance column published beside a variable, which search does not list. Call census_get_variable with B19013_001EA for its label and the variable it belongs to.';
    expect(out.notice).toBe(notice);
    expect(textOf(result)).toContain(notice);
    expect(paths()).toEqual(['/data/2024/acs/acs5/variables.json']);
  });

  it('answers a failed lookup with the empty result and its notice, never an error', async () => {
    serveAcs();
    routes['/data/2024/acs/acs5/subject/variables/S1701_C03_001E.json'] = new Response('boom', {
      status: 500,
      headers: { 'content-type': 'text/plain' },
    });

    const result = await runToolContract(censusSearchVariables, { query: 'S1701_C03_001E' });

    const out = structured(result);
    expect(out.error).toBeUndefined();
    expect(out.variables).toEqual([]);
    expect(out.notice).toBe(
      'No variable or table in acs/acs5 (2024) has the code "S1701_C03_001E", and no label or concept contains it. Codes differ by dataset and vintage: check the code and year, or search with words from the variable\'s label.',
    );
    expect(paths()).toEqual([
      '/data/2024/acs/acs5/variables.json',
      '/data/2024/acs/acs5/subject/variables/S1701_C03_001E.json',
    ]);
  });

  it('keeps keyword queries on variables.json alone, matched or not (characterization)', async () => {
    serveAcs();
    for (const sibling of ['acs/acs5/subject', 'acs/acs1/subject', 'acs/acs1/spp']) {
      routes[`/data/2024/${sibling}/variables/S9999_C99_999E.json`] = notHeld();
    }

    for (const query of ['median household income', 'xyzzy', 'poverty rate']) {
      await runToolContract(censusSearchVariables, { query });
    }

    expect(paths()).toEqual(['/data/2024/acs/acs5/variables.json']);
  });

  it('names the sibling for a code sharing a word with labels here, in place of those matches', async () => {
    serveAcs();
    routes['/data/2024/acs/acs5/cprofile/variables/CP03_2024_062E.json'] = {
      name: 'CP03_2024_062E',
    };

    // "2024" is a word of the income labels, so by keyword alone this is a 1-of-3-words match.
    const result = await runToolContract(censusSearchVariables, { query: 'CP03_2024_062E' });

    const out = structured(result);
    expect(out.variables).toEqual([]);
    expect(out.totalMatches).toBe(0);
    const hint = 'CP03_2024_062E is in acs/acs5/cprofile — query that dataset instead.';
    expect(out.notice).toContain(hint);
    expect(out.notice).not.toMatch(/every word/i);
    expect(textOf(result)).toContain(hint);
  });

  it('leads with a letter-only column only when the query spells its code, on both surfaces', async () => {
    // dec/dhc 2020 labels its STATE column "Geography", so no keyword search reaches it.
    const prisons = (age: string) => ({
      label: ` !!Total:!!Male:!!${age}:!!Institutionalized population (101-106, 201-203, 301, 401-405):!!Correctional facilities for adults (101-106):!!State prisons (103)`,
      concept: 'GROUP QUARTERS POPULATION BY SEX BY AGE BY GROUP QUARTERS TYPE',
      predicateType: 'int',
      group: 'PCT19',
    });
    routes['/data/2020/dec/dhc/variables.json'] = {
      variables: {
        STATE: { label: 'Geography', group: 'N/A', limit: 0 },
        PCT19_008N: prisons('Under 18 years'),
        PCT19_040N: prisons('18 to 64 years'),
      },
    };
    const search = (query: string) =>
      runToolContract(censusSearchVariables, { query, dataset: 'dec/dhc', year: 2020 });

    const word = await search('state');
    expect(structured(word).variables.map((v) => v.variable_code)).toEqual([
      'PCT19_008N',
      'PCT19_040N',
    ]);
    expect(structured(word).totalMatches).toBe(2);
    expect(textOf(word)).not.toContain('`STATE`');

    const code = await search('STATE');
    expect(structured(code).variables.map((v) => v.variable_code)).toEqual([
      'STATE',
      'PCT19_008N',
      'PCT19_040N',
    ]);
    expect(structured(code).totalMatches).toBe(3);
    const text = textOf(code);
    expect(text.indexOf('`STATE`')).toBeGreaterThan(-1);
    expect(text.indexOf('`STATE`')).toBeLessThan(text.indexOf('`PCT19_008N`'));
  });
});

describe('census_get_variable on both surfaces', () => {
  it('omits the concept of a shared column and keeps a single-table one (#33)', async () => {
    serveAcs();

    const result = await runToolContract(censusGetVariable, {
      variables: ['GEO_ID', 'B19013_001E'],
    });

    const [geoId, income] = structured(result).variables;
    expect(geoId).not.toHaveProperty('concept');
    expect(income?.concept).toBe(
      'Median Household Income in the Past 12 Months (in 2024 Inflation-Adjusted Dollars)',
    );
    expect(JSON.stringify(result.structuredContent).length).toBeLessThan(2_000);
    const text = textOf(result);
    expect(text).not.toContain('Coverage Rate');
    expect(text).toContain(
      '**Concept:** Median Household Income in the Past 12 Months (in 2024 Inflation-Adjusted Dollars)',
    );
  });

  /** ACS variables.json lists `STATE` with a label and `group: "N/A"`, and no concept at all. */
  it('omits the concept on both surfaces when the dataset publishes none (#33)', async () => {
    serveAcs();
    routes['/data/2024/acs/acs5/variables.json'] = {
      variables: { ...acsVariables, STATE: { label: 'State', group: 'N/A', limit: 0 } },
    };

    const result = await runToolContract(censusGetVariable, { variables: ['STATE'] });

    const [state] = structured(result).variables;
    expect(state).toMatchObject({ variable_code: 'STATE', label: 'State' });
    expect(state).not.toHaveProperty('concept');
    expect(textOf(result)).not.toContain('**Concept:**');
  });

  it('resolves an annotation column with attribute_of and attribute_type (#48)', async () => {
    serveAcs();

    const result = await runToolContract(censusGetVariable, { variables: ['B19013_001EA'] });

    const [annotation] = structured(result).variables;
    expect(annotation).toMatchObject({
      variable_code: 'B19013_001EA',
      attribute_of: 'B19013_001E',
      attribute_type: 'ANNOTATION',
    });
    const text = textOf(result);
    expect(text).toContain('**Attribute of:** `B19013_001E`');
    expect(text).toContain('**Attribute type:** ANNOTATION');
  });

  it('labels a synthesized margin of error as the Census publishes it, on both surfaces (#58)', async () => {
    serveAcs();

    const result = await runToolContract(censusGetVariable, { variables: ['B19013_001M'] });

    const [moe] = structured(result).variables;
    expect(moe).toMatchObject({
      variable_code: 'B19013_001M',
      label:
        'Margin of Error!!Median household income in the past 12 months (in 2024 inflation-adjusted dollars)',
      attribute_of: 'B19013_001E',
      attribute_type: 'MARGIN_OF_ERROR',
    });
    const text = textOf(result);
    expect(text).toContain(
      '**Label:** Margin of Error!!Median household income in the past 12 months (in 2024 inflation-adjusted dollars)',
    );
    expect(text).toContain('**Attribute of:** `B19013_001E`');
    expect(text).toContain('**Attribute type:** MARGIN_OF_ERROR');
    expect(calls.some((u) => u.pathname.includes('/variables/'))).toBe(false);
  });

  it('resolves lowercase codes and echoes the canonical spelling (#50)', async () => {
    serveAcs();

    const result = await runToolContract(censusGetVariable, {
      variables: [' b19013_001e ', 'b19013_001ea'],
    });

    expect(structured(result).variables.map((v) => v.variable_code)).toEqual([
      'B19013_001E',
      'B19013_001EA',
    ]);
    expect(textOf(result)).toContain('`B19013_001E`');
    expect(calls.map((u) => u.pathname)).toContain(
      '/data/2024/acs/acs5/variables/B19013_001EA.json',
    );
  });

  it('names the uppercased code when a lowercase code is unknown (#50)', async () => {
    serveAcs();

    const result = await runToolContract(censusGetVariable, { variables: ['b19013_001xa'] });

    const error = structured(result).error;
    expect(error?.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error?.data).toMatchObject({
      reason: 'variable_not_found',
      missingCodes: ['B19013_001XA'],
    });
    expect(textOf(result)).toContain('B19013_001XA');
    // No attribute lookup in acs/acs5 itself; the only per-variable request is the acs/acs1
    // sibling probe, which fails here and leaves the search hint.
    expect(calls.some((u) => u.pathname.startsWith('/data/2024/acs/acs5/variables/'))).toBe(false);
    expect(error?.data.recovery).toEqual({
      hint: 'Use census_search_variables to find valid codes for this dataset and year.',
    });
  });

  it('carries the universe on both surfaces (#53)', async () => {
    serveAcs();

    const result = await runToolContract(censusGetVariable, { variables: ['B19013_001E'] });

    expect(structured(result).variables[0]?.universe).toBe('Households');
    expect(textOf(result)).toContain('**Universe:** Households');
  });

  it('omits the universe on both surfaces when the group publishes none (#53)', async () => {
    serveAcs();
    routes['/data/2024/acs/acs5/groups.json'] = { groups: [{ name: 'B19013' }] };

    const result = await runToolContract(censusGetVariable, { variables: ['B19013_001E'] });

    expect(structured(result).variables[0]).not.toHaveProperty('universe');
    expect(textOf(result)).not.toContain('**Universe:**');
  });

  /** Pinned before the sibling lookup landed: a lookup that finds every code sends no probe. */
  it('sends only variables.json and groups.json for codes the dataset lists (characterization)', async () => {
    serveAcs();

    const result = await runToolContract(censusGetVariable, {
      variables: ['b19013_001e', 'B19013_001M'],
    });

    expect(result.isError).toBeFalsy();
    expect(calls.map((u) => u.pathname)).toEqual([
      '/data/2024/acs/acs5/variables.json',
      '/data/2024/acs/acs5/groups.json',
    ]);
  });

  it('sends variables.json, the attribute record, then groups.json once each (characterization)', async () => {
    serveAcs();

    const result = await runToolContract(censusGetVariable, {
      variables: ['B19013_001EA', 'B19013_001E'],
    });

    expect(result.isError).toBeFalsy();
    expect(structured(result)).not.toHaveProperty('notice');
    expect(calls.map((u) => u.pathname)).toEqual([
      '/data/2024/acs/acs5/variables.json',
      '/data/2024/acs/acs5/variables/B19013_001EA.json',
      '/data/2024/acs/acs5/groups.json',
    ]);
  });
});

describe('census_get_variable when groups.json fails (#60)', () => {
  const GROUPS = '/data/2024/acs/acs5/groups.json';
  const groupsCalls = () => calls.filter((u) => u.pathname === GROUPS).length;

  /** `serveAcs` with `NAME` listed as its own column, as acs/acs5 variables.json lists it. */
  const serveAcsWithName = () => {
    serveAcs();
    routes['/data/2024/acs/acs5/variables.json'] = {
      variables: {
        ...acsVariables,
        NAME: { label: 'Geographic Area Name', predicateType: 'string', group: 'N/A' },
      },
    };
  };

  /** Rejects with the signal's reason once it aborts, as fetch does; never answers otherwise. */
  const hang: RouteFn = (init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });

  /** Run with fake timers driven past every retry backoff and the 30-second attempt timeout. */
  const runWithTimers = async (input: { variables: string[] }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = runToolContract(censusGetVariable, input);
      await vi.advanceTimersByTimeAsync(300_000);
      return await pending;
    } finally {
      vi.useRealTimers();
    }
  };

  /** Each failure with the groups.json requests it gets: four attempts, or one held to the deadline. */
  const failures: Array<[string, unknown, number]> = [
    ['an HTTP 503', new Response('Service Unavailable', { status: 503 }), 4],
    ['an HTTP 500', new Response('Internal Server Error', { status: 500 }), 4],
    ['a network error', (() => Promise.reject(new TypeError('fetch failed'))) satisfies RouteFn, 4],
    ['a hang', hang, 1],
    [
      'an HTML page answered 200',
      new Response('<!DOCTYPE html><html><body>Maintenance</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
      4,
    ],
    [
      'an unparseable body answered 200',
      new Response('{"groups": [trunc', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      4,
    ],
    ['a JSON body with no groups list', { error: 'unexpected' }, 1],
  ];

  it.each(failures)(
    'returns the variables without universe after %s, with a retry notice on both surfaces',
    async (_name, failure, requests) => {
      serveAcsWithName();
      routes[GROUPS] = failure;

      const result = await runWithTimers({
        variables: ['GEO_ID', 'B19013_001E', 'b19013_001e', 'B19013_001M', 'NAME'],
      });

      expect(result.isError).toBeFalsy();
      const out = structured(result);
      expect(out.variables.map((v) => v.variable_code)).toEqual([
        'GEO_ID',
        'B19013_001E',
        'B19013_001E',
        'B19013_001M',
        'NAME',
      ]);
      for (const variable of out.variables) expect(variable).not.toHaveProperty('universe');
      expect(out.variables[1]?.label).toContain('Median household income');
      // Each single-table code once, in request order; GEO_ID and NAME lost nothing.
      expect(out.notice?.match(/\b[A-Z0-9_]+_\d{3}[A-Z]*\b|GEO_ID|NAME/g)).toEqual([
        'B19013_001E',
        'B19013_001M',
      ]);
      expect(out.notice).toContain('acs/acs5 (2024)');
      expect(out.notice).toMatch(/retry/i);
      const text = textOf(result);
      expect(text).toContain(out.notice);
      expect(text).toContain('**Label:** Estimate!!Median household income');
      expect(text).not.toContain('**Universe:**');
      expect(groupsCalls()).toBe(requests);
    },
  );

  it('names every single-table code across tables, an attribute column included, once each (characterization)', async () => {
    serveAcs();
    routes[GROUPS] = new Response('Service Unavailable', { status: 503 });

    const result = await runWithTimers({
      variables: ['B25077_001E', 'GEO_ID', 'B19013_001EA', 'B19013_001E', 'B25077_001E'],
    });

    const notice = structured(result).notice ?? '';
    expect(notice.match(/\b[A-Z0-9]+_\d{3}[A-Z]*\b|GEO_ID/g)).toEqual([
      'B25077_001E',
      'B19013_001EA',
      'B19013_001E',
    ]);
    expect(textOf(result)).toContain(notice);
  });

  it('returns the universe with no notice on the next call, since the failure is not cached', async () => {
    serveAcs();
    routes[GROUPS] = new Response('Service Unavailable', { status: 503 });
    const failed = await runWithTimers({ variables: ['B19013_001E'] });
    expect(structured(failed).notice).toBeDefined();

    routes[GROUPS] = acsGroups;
    const result = await runToolContract(censusGetVariable, { variables: ['B19013_001E'] });

    expect(structured(result).variables[0]?.universe).toBe('Households');
    expect(structured(result)).not.toHaveProperty('notice');
    expect(textOf(result)).toContain('**Universe:** Households');
    expect(groupsCalls()).toBe(5);
  });

  it('omits the universe with no notice on a 404 (characterization)', async () => {
    serveAcs();
    routes[GROUPS] = new Response('<html><body>HTTP Status 404 – Not Found</body></html>', {
      status: 404,
      headers: { 'content-type': 'text/html' },
    });

    const result = await runToolContract(censusGetVariable, { variables: ['B19013_001E'] });

    expect(result.isError).toBeFalsy();
    expect(structured(result).variables[0]).not.toHaveProperty('universe');
    expect(structured(result)).not.toHaveProperty('notice');
    expect(textOf(result)).not.toContain('**Universe:**');
    expect(groupsCalls()).toBe(1);
  });

  it('sends no groups.json request and no notice for GEO_ID and NAME alone (characterization)', async () => {
    serveAcsWithName();
    routes[GROUPS] = new Response('Service Unavailable', { status: 503 });

    const result = await runToolContract(censusGetVariable, { variables: ['GEO_ID', 'NAME'] });

    expect(result.isError).toBeFalsy();
    expect(structured(result)).not.toHaveProperty('notice');
    expect(groupsCalls()).toBe(0);
  });

  it('is RequestCancelled, never a notice, when the caller cancels during the groups.json fetch', async () => {
    serveAcs();
    const controller = new AbortController();
    routes[GROUPS] = ((init) => {
      queueMicrotask(() => controller.abort());
      return hang(init);
    }) satisfies RouteFn;

    const result = await runToolContract(
      censusGetVariable,
      { variables: ['B19013_001E'] },
      { context: { signal: controller.signal } },
    );

    expect(result.isError).toBe(true);
    expect(structured(result).error?.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(structured(result)).not.toHaveProperty('notice');
    expect(groupsCalls()).toBe(1);
  });

  it('is RequestCancelled, never a notice, when the caller cancels during the retry backoff', async () => {
    serveAcs();
    routes[GROUPS] = new Response('Service Unavailable', { status: 503 });
    const controller = new AbortController();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = runToolContract(
        censusGetVariable,
        { variables: ['B19013_001E'] },
        { context: { signal: controller.signal } },
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(groupsCalls()).toBe(1);
      controller.abort(new Error('caller went away'));
      await vi.advanceTimersByTimeAsync(300_000);
      const result = await pending;

      expect(result.isError).toBe(true);
      expect(structured(result).error?.code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(structured(result)).not.toHaveProperty('notice');
      expect(groupsCalls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  /** variables.json is the record itself, so its failure still fails the call, as it did before. */
  it.each([
    ['an HTTP 503', new Response('Service Unavailable', { status: 503 }), 'upstream_error'],
    [
      'an HTML page answered 200',
      new Response('<!DOCTYPE html><html><body>Maintenance</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
      'variables_unavailable',
    ],
  ])(
    'still fails when variables.json answers %s (characterization)',
    async (_name, failure, reason) => {
      serveAcs();
      routes['/data/2024/acs/acs5/variables.json'] = failure;

      const result = await runWithTimers({ variables: ['B19013_001E'] });

      expect(result.isError).toBe(true);
      expect(structured(result).error?.data).toMatchObject({ reason });
      expect(groupsCalls()).toBe(0);
    },
  );

  it('still fails with variables_unavailable when an attribute record cannot be fetched', async () => {
    serveAcs();
    routes['/data/2024/acs/acs5/variables/B19013_001EA.json'] = new Response(
      'Service Unavailable',
      {
        status: 503,
      },
    );

    const result = await runWithTimers({ variables: ['B19013_001EA'] });

    expect(result.isError).toBe(true);
    expect(structured(result).error?.data).toMatchObject({ reason: 'variables_unavailable' });
  });
});

describe('census_get_variable spells attribute_type in upper-snake on every vintage (#61)', () => {
  it('returns ANNOTATION and MARGIN_OF_ERROR on acs/acs5 2009, which publishes "Annotation"', async () => {
    routes['/data/2009/acs/acs5/variables.json'] = {
      variables: {
        B19013_001E: {
          label:
            'Estimate!!Median household income in the past 12 months (in 2009 inflation-adjusted dollars)',
          concept:
            'MEDIAN HOUSEHOLD INCOME IN THE PAST 12 MONTHS (IN 2009 INFLATION-ADJUSTED DOLLARS)',
          predicateType: 'int',
          group: 'B19013',
          limit: 0,
          attributes: 'B19013_001EA,B19013_001M,B19013_001MA',
        },
      },
    };
    routes['/data/2009/acs/acs5/groups.json'] = {
      groups: [
        {
          name: 'B19013',
          description:
            'MEDIAN HOUSEHOLD INCOME IN THE PAST 12 MONTHS (IN 2009 INFLATION-ADJUSTED DOLLARS)',
        },
      ],
    };
    routes['/data/2009/acs/acs5/variables/B19013_001EA.json'] = {
      name: 'B19013_001EA',
      label:
        'Annotation of Estimate!!Median household income in the past 12 months (in 2009 inflation-adjusted dollars)',
      predicateType: 'string',
      group: 'B19013',
      limit: 0,
      'attribute of': 'B19013_001E',
      'attribute type': 'Annotation',
    };

    const result = await runToolContract(censusGetVariable, {
      dataset: 'acs/acs5',
      year: 2009,
      variables: ['B19013_001EA', 'B19013_001M'],
    });

    expect(
      structured(result).variables.map((v) => [v.variable_code, v.attribute_of, v.attribute_type]),
    ).toEqual([
      ['B19013_001EA', 'B19013_001E', 'ANNOTATION'],
      ['B19013_001M', 'B19013_001E', 'MARGIN_OF_ERROR'],
    ]);
    const text = textOf(result);
    expect(text).toContain('**Attribute type:** ANNOTATION');
    expect(text).toContain('**Attribute type:** MARGIN_OF_ERROR');
    expect(text).not.toContain('Attribute type:** Annotation');
  });

  it('returns STATISTICAL_SIGNIFICANCE on acs/acs1/cprofile 2010, which publishes "Statistical Significance"', async () => {
    routes['/data/2010/acs/acs1/cprofile/variables.json'] = {
      variables: {
        CP04_2010_119E: {
          label:
            '2010 Estimate!!SELECTED MONTHLY OWNER COSTS AS A PERCENTAGE OF HOUSEHOLD INCOME (SMOCAPI)!!20.0 to 24.9 percent',
          concept: 'SELECTED HOUSING CHARACTERISTICS',
          predicateType: 'float',
          group: 'CP04',
          limit: 0,
          attributes:
            'CP04_2010to2008_119SS,CP04_2010to2009_119SS,CP04_2010_119EA,CP04_2010to2006_119SS,CP04_2010to2007_119SS',
        },
      },
    };
    routes['/data/2010/acs/acs1/cprofile/groups.json'] = {
      groups: [{ name: 'CP04', description: 'SELECTED HOUSING CHARACTERISTICS' }],
    };
    routes['/data/2010/acs/acs1/cprofile/variables/CP04_2010to2008_119SS.json'] = {
      name: 'CP04_2010to2008_119SS',
      label:
        '2010 - 2008 Statistical Significance!!SELECTED MONTHLY OWNER COSTS AS A PERCENTAGE OF HOUSEHOLD INCOME (SMOCAPI)!!20.0 to 24.9 percent',
      concept: 'SELECTED HOUSING CHARACTERISTICS',
      predicateType: 'string',
      group: 'CP04',
      limit: 0,
      'attribute of': 'CP04_2008_119E',
      'attribute type': 'Statistical Significance',
    };

    const result = await runToolContract(censusGetVariable, {
      dataset: 'acs/acs1/cprofile',
      year: 2010,
      variables: ['CP04_2010to2008_119SS'],
    });

    expect(structured(result).variables[0]).toMatchObject({
      variable_code: 'CP04_2010to2008_119SS',
      attribute_of: 'CP04_2008_119E',
      attribute_type: 'STATISTICAL_SIGNIFICANCE',
    });
    expect(textOf(result)).toContain('**Attribute type:** STATISTICAL_SIGNIFICANCE');
  });

  it('returns ERRATA and LABEL on dec/pl 2010, which publishes "Errata" and "Label"', async () => {
    routes['/data/2010/dec/pl/variables.json'] = {
      variables: {
        P001001: {
          label: 'Total',
          concept: 'RACE',
          group: 'P1',
          limit: 0,
          attributes: 'P001001ERR',
        },
        GEOCOMP: {
          label: 'Geographic Component code',
          required: 'default displayed',
          predicateType: 'string',
          group: 'N/A',
          limit: 0,
          attributes: 'GEOCOMP_LABEL',
        },
      },
    };
    routes['/data/2010/dec/pl/groups.json'] = { groups: [{ name: 'P1', description: 'RACE' }] };
    routes['/data/2010/dec/pl/variables/P001001ERR.json'] = {
      name: 'P001001ERR',
      label: 'Errata of Total',
      predicateType: 'string',
      group: 'P1',
      limit: 0,
      'attribute of': 'P001001',
      'attribute type': 'Errata',
    };
    routes['/data/2010/dec/pl/variables/GEOCOMP_LABEL.json'] = {
      name: 'GEOCOMP_LABEL',
      label: 'Label for GEOCOMP',
      predicateType: 'string',
      group: 'N/A',
      limit: 0,
      'attribute of': 'GEOCOMP',
      'attribute type': 'Label',
    };

    const result = await runToolContract(censusGetVariable, {
      dataset: 'dec/pl',
      year: 2010,
      variables: ['P001001ERR', 'GEOCOMP_LABEL'],
    });

    expect(
      structured(result).variables.map((v) => [v.variable_code, v.attribute_of, v.attribute_type]),
    ).toEqual([
      ['P001001ERR', 'P001001', 'ERRATA'],
      ['GEOCOMP_LABEL', 'GEOCOMP', 'LABEL'],
    ]);
    const text = textOf(result);
    expect(text).toContain('**Attribute type:** ERRATA');
    expect(text).toContain('**Attribute type:** LABEL');
  });

  it('passes a kind no vintage publishes yet through the string output schema, normalized', async () => {
    serveAcs();
    routes['/data/2024/acs/acs5/variables/B19013_001EA.json'] = {
      ...(routes['/data/2024/acs/acs5/variables/B19013_001EA.json'] as Record<string, unknown>),
      'attribute type': 'Coverage note',
    };

    const result = await runToolContract(censusGetVariable, { variables: ['B19013_001EA'] });

    expect(result.isError).toBeFalsy();
    expect(structured(result).variables[0]?.attribute_type).toBe('COVERAGE_NOTE');
    expect(textOf(result)).toContain('**Attribute type:** COVERAGE_NOTE');
  });
});

describe('census_get_variable names the sibling dataset that holds a missing code (#65)', () => {
  const recoveryOf = (result: { structuredContent?: unknown }) =>
    (structured(result).error?.data.recovery as { hint: string } | undefined)?.hint;

  const notHeld = () =>
    new Response(
      '<!doctype html><html lang="en"><head><title>HTTP Status 404 – Not Found</title></head><body><h1>HTTP Status 404 – Not Found</h1></body></html>',
      { status: 404, headers: { 'content-type': 'text/html' } },
    );

  const lookups = () =>
    calls.map((u) => u.pathname).filter((path) => /\/variables\/[^/]+\.json$/.test(path));

  /** Live 2024 records, trimmed to the fields the endpoint returns. */
  const serveSiblings = () => {
    routes['/data/2024/acs/acs5/profile/variables/DP03_0062E.json'] = {
      name: 'DP03_0062E',
      label:
        'Estimate!!INCOME AND BENEFITS (IN 2024 INFLATION-ADJUSTED DOLLARS)!!Total households!!Median household income (dollars)',
      concept: 'Selected Economic Characteristics',
      predicateType: 'int',
      group: 'DP03',
    };
    routes['/data/2024/acs/acs5/cprofile/variables/CP03_2024_062E.json'] = {
      name: 'CP03_2024_062E',
      label:
        '2020-2024 Estimates!!INCOME AND BENEFITS (IN 2024 INFLATION-ADJUSTED DOLLARS)!!Total households!!Median household income (dollars)',
      concept: 'Comparative Economic Characteristics',
      predicateType: 'int',
      group: 'CP03',
    };
  };

  it('names acs/acs5/profile and acs/acs5/cprofile on both surfaces', async () => {
    serveAcs();
    serveSiblings();

    const result = await runToolContract(censusGetVariable, {
      variables: ['DP03_0062E', 'CP03_2024_062E'],
    });

    const error = structured(result).error;
    expect(error?.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error?.message).toBe(
      'Variable codes not found in acs/acs5 (2024): DP03_0062E, CP03_2024_062E',
    );
    expect(recoveryOf(result)).toBe(
      'DP03_0062E is in acs/acs5/profile and CP03_2024_062E is in acs/acs5/cprofile — query those datasets instead.',
    );
    expect(textOf(result)).toContain(
      'Recovery: DP03_0062E is in acs/acs5/profile and CP03_2024_062E is in acs/acs5/cprofile',
    );
    expect(lookups()).toEqual([
      '/data/2024/acs/acs5/profile/variables/DP03_0062E.json',
      '/data/2024/acs/acs5/cprofile/variables/CP03_2024_062E.json',
    ]);
  });

  it('keeps the search hint for the codes no sibling holds, after the ones it found', async () => {
    serveAcs();
    serveSiblings();
    routes['/data/2024/acs/acs5/subject/variables/S9999_C99_999E.json'] = notHeld();
    routes['/data/2024/acs/acs1/subject/variables/S9999_C99_999E.json'] = notHeld();
    routes['/data/2024/acs/acs1/spp/variables/S9999_C99_999E.json'] = notHeld();

    const result = await runToolContract(censusGetVariable, {
      variables: ['DP03_0062E', 'S9999_C99_999E', 'P1_001N'],
    });

    expect(recoveryOf(result)).toBe(
      'DP03_0062E is in acs/acs5/profile — query that dataset instead. For S9999_C99_999E and P1_001N, use census_search_variables to find valid codes for this dataset and year.',
    );
    // P1 has no sibling row, so it sends nothing; S9999 walks all three subject candidates.
    expect(lookups().sort()).toEqual(
      [
        '/data/2024/acs/acs5/profile/variables/DP03_0062E.json',
        '/data/2024/acs/acs5/subject/variables/S9999_C99_999E.json',
        '/data/2024/acs/acs1/subject/variables/S9999_C99_999E.json',
        '/data/2024/acs/acs1/spp/variables/S9999_C99_999E.json',
      ].sort(),
    );
  });

  it.each([
    ['a code no candidate holds', 'S9999_C99_999E', 2024],
    ['a prefix with no sibling row', 'P1_001N', 2024],
    ['a sibling the year does not list', 'K200101_001E', 2012],
  ])('keeps the search hint for %s', async (_case, code, year) => {
    routes[`/data/${year}/acs/acs5/variables.json`] = { variables: acsVariables };
    for (const sibling of ['acs/acs5/subject', 'acs/acs1/subject', 'acs/acs1/spp']) {
      routes[`/data/${year}/${sibling}/variables/${code}.json`] = notHeld();
    }

    const result = await runToolContract(censusGetVariable, { variables: [code], year });

    expect(recoveryOf(result)).toBe(
      'Use census_search_variables to find valid codes for this dataset and year.',
    );
    expect(textOf(result)).toContain(
      'Use census_search_variables to find valid codes for this dataset and year.',
    );
    if (code !== 'S9999_C99_999E') expect(lookups()).toEqual([]);
  });

  it('keeps the search hint when the lookup itself fails, without retrying it', async () => {
    serveAcs();
    routes['/data/2024/acs/acs5/profile/variables/DP03_0062E.json'] = new Response('boom', {
      status: 500,
      headers: { 'content-type': 'text/plain' },
    });

    const result = await runToolContract(censusGetVariable, { variables: ['DP03_0062E'] });

    expect(recoveryOf(result)).toBe(
      'Use census_search_variables to find valid codes for this dataset and year.',
    );
    // A failed lookup ends that table's chain and is never retried.
    expect(lookups()).toEqual(['/data/2024/acs/acs5/profile/variables/DP03_0062E.json']);
  });
});

describe('a dataset code resolves regardless of case, padding, or a bare acs5 (#32)', () => {
  const echoed = (result: { structuredContent?: unknown }) =>
    result.structuredContent as { dataset?: string; year?: number };

  it.each(['acs5', 'ACS5', 'ACS/ACS5', ' acs5 '])(
    'census_search_variables resolves %j to acs/acs5 on both surfaces',
    async (dataset) => {
      serveAcs();

      const result = await runToolContract(censusSearchVariables, {
        query: 'median household income',
        dataset,
      });

      expect(echoed(result)).toMatchObject({ dataset: 'acs/acs5', year: 2024 });
      expect(structured(result).variables[0]?.variable_code).toBe('B19013_001E');
      expect(textOf(result)).toContain('acs/acs5');
    },
  );

  it.each(['acs5', 'ACS5', 'ACS/ACS5', ' acs5 '])(
    'census_get_variable resolves %j to acs/acs5 on both surfaces',
    async (dataset) => {
      serveAcs();

      const result = await runToolContract(censusGetVariable, {
        variables: ['B19013_001E'],
        dataset,
      });

      expect(echoed(result)).toMatchObject({ dataset: 'acs/acs5', year: 2024 });
      expect(textOf(result)).toContain('## Variable Metadata — acs/acs5 (2024)');
    },
  );

  /** acs/acs5 filters on nothing, so the call ends at the dimension check — on the resolved code. */
  it.each(['acs5', 'ACS5', 'ACS/ACS5', ' acs5 '])(
    'census_list_predicate_values resolves %j to acs/acs5',
    async (dataset) => {
      serveAcs();
      routes['/data/2024/acs/acs5/variables.json'] = {
        variables: {
          ...acsVariables,
          GEOCOMP: {
            label: 'GEO_ID Component',
            required: 'default displayed',
            predicateType: 'string',
          },
        },
      };

      const result = await runToolContract(censusListPredicateValues, {
        predicate: 'GEOCOMP',
        dataset,
      });

      expect(structured(result).error?.data).toMatchObject({
        reason: 'not_a_filter_dimension',
        dataset: 'acs/acs5',
      });
      expect(calls.map((u) => u.pathname)).toEqual(['/data/2024/acs/acs5/variables.json']);
    },
  );

  it('census_list_predicate_values echoes the canonical code of a case-slipped dataset', async () => {
    routes['/data/2023/cbp/variables.json'] = {
      variables: {
        EMPSZES: {
          label: 'Employment size of establishments code',
          predicateType: 'string',
          group: 'CB2300CBP',
          required: 'default displayed',
          attributes: 'EMPSZES_LABEL',
        },
      },
    };
    routes['/data/2023/cbp'] = [
      ['EMPSZES_LABEL', 'EMPSZES', 'us'],
      ['All establishments', '001', '1'],
    ];

    const result = await runToolContract(censusListPredicateValues, {
      predicate: 'EMPSZES',
      dataset: ' CBP ',
    });

    expect((result.structuredContent as { dataset?: string }).dataset).toBe('cbp');
    expect(textOf(result)).toContain('**cbp (2023)**');
  });

  /** The default year follows the resolved code: dec/pl ends in 2020, not the server's 2024. */
  it('census_search_variables searches dec/pl 2020 for a bare "pl"', async () => {
    routes['/data/2020/dec/pl/variables.json'] = {
      variables: {
        P1_001N: { label: ' !!Total:', concept: 'RACE', predicateType: 'int', group: 'P1' },
      },
    };

    const result = await runToolContract(censusSearchVariables, { query: 'race', dataset: 'pl' });

    expect(echoed(result)).toMatchObject({ dataset: 'dec/pl', year: 2020 });
    expect(calls.map((u) => u.pathname)).toEqual(['/data/2020/dec/pl/variables.json']);
  });

  it.each([
    [
      'census_search_variables',
      () => runToolContract(censusSearchVariables, { query: 'x', dataset: 'profile' }),
    ],
    [
      'census_get_variable',
      () => runToolContract(censusGetVariable, { variables: ['X'], dataset: 'profile' }),
    ],
    [
      'census_list_predicate_values',
      () => runToolContract(censusListPredicateValues, { predicate: 'X', dataset: 'profile' }),
    ],
  ])('%s names both profile datasets for a bare "profile"', async (_name, run) => {
    const result = await run();

    expect(structured(result).error?.data).toMatchObject({ reason: 'dataset_not_found' });
    const text = textOf(result);
    expect(text).toContain('acs/acs5/profile');
    expect(text).toContain('acs/acs1/profile');
    expect(calls).toHaveLength(0);
  });

  it.each([
    [
      'census_search_variables',
      () => runToolContract(censusSearchVariables, { query: 'income', dataset: '' }),
    ],
    [
      'census_get_variable',
      () => runToolContract(censusGetVariable, { variables: ['B19013_001E'], dataset: '  ' }),
    ],
  ])('%s reads a blank dataset as acs/acs5', async (_name, run) => {
    serveAcs();

    const result = await run();

    expect(result.isError).toBeFalsy();
    expect(echoed(result).dataset).toBe('acs/acs5');
  });

  it('census_list_predicate_values rejects a blank dataset as missing, not unknown', async () => {
    const result = await runToolContract(censusListPredicateValues, {
      predicate: 'EMPSZES',
      dataset: ' ',
    });

    expect(structured(result).error?.data).toMatchObject({ reason: 'dataset_not_found' });
    const text = textOf(result);
    expect(text).toMatch(/no dataset code/i);
    expect(text).not.toContain('Unknown dataset: ""');
  });
});

describe('the comparison profiles publish no margins of error (#52)', () => {
  const serveCprofile = () => {
    routes['/data/2024/acs/acs5/cprofile/variables.json'] = {
      variables: {
        CP03_2024_062E: {
          label:
            '2020-2024 Estimates!!INCOME AND BENEFITS (IN 2024 INFLATION-ADJUSTED DOLLARS)!!Total households!!Median household income (dollars)',
          concept: 'Comparative Economic Characteristics',
          predicateType: 'int',
          group: 'CP03',
          attributes: 'CP03_2024_062EA,CP03_2024to2019_062SS',
        },
      },
    };
    routes['/data/2024/acs/acs5/cprofile/groups.json'] = {
      groups: [{ name: 'CP03', description: 'Comparative Economic Characteristics' }],
    };
  };

  it('census_get_variable returns no moe_code on either surface', async () => {
    serveCprofile();

    const result = await runToolContract(censusGetVariable, {
      variables: ['CP03_2024_062E'],
      dataset: 'acs/acs5/cprofile',
    });

    expect(structured(result).variables[0]).not.toHaveProperty('moe_code');
    expect(textOf(result)).not.toContain('MOE sibling');
  });

  it('census_get_variable refuses the M code the dataset does not publish', async () => {
    serveCprofile();

    const result = await runToolContract(censusGetVariable, {
      variables: ['CP03_2024_062M'],
      dataset: 'acs/acs5/cprofile',
    });

    expect(structured(result).error?.data).toMatchObject({
      reason: 'variable_not_found',
      missingCodes: ['CP03_2024_062M'],
    });
  });

  /**
   * The comparison profiles publish their statistical-significance columns in mixed case
   * (`CP03_2024to2019_062SS`); the uppercased `CP03_2024TO2019_062SS` is unknown upstream.
   */
  it('census_get_variable resolves a mixed-case significance column from any casing', async () => {
    serveCprofile();
    routes['/data/2024/acs/acs5/cprofile/variables/CP03_2024to2019_062SS.json'] = {
      name: 'CP03_2024to2019_062SS',
      label:
        'Statistical Significance!!INCOME AND BENEFITS (IN 2024 INFLATION-ADJUSTED DOLLARS)!!Total households!!Median household income (dollars)',
      predicateType: 'string',
      group: 'CP03',
      'attribute of': 'CP03_2024_062E',
      'attribute type': 'STATISTICAL_SIGNIFICANCE',
    };

    const result = await runToolContract(censusGetVariable, {
      variables: ['cp03_2024to2019_062ss'],
      dataset: 'acs/acs5/cprofile',
    });

    expect(structured(result).variables[0]).toMatchObject({
      variable_code: 'CP03_2024to2019_062SS',
      attribute_of: 'CP03_2024_062E',
      attribute_type: 'STATISTICAL_SIGNIFICANCE',
    });
    expect(textOf(result)).toContain('`CP03_2024to2019_062SS`');
    expect(calls.map((u) => u.pathname)).toContain(
      '/data/2024/acs/acs5/cprofile/variables/CP03_2024to2019_062SS.json',
    );
  });

  it('census_search_variables returns no synthesized M entry and no moe_code', async () => {
    serveCprofile();

    const result = await runToolContract(censusSearchVariables, {
      query: 'median household income',
      dataset: 'acs/acs5/cprofile',
    });

    const variables = structured(result).variables as Array<VariableRow & { moe_code?: string }>;
    expect(variables.map((v) => v.variable_code)).toEqual(['CP03_2024_062E']);
    expect(variables[0]).not.toHaveProperty('moe_code');
    const text = textOf(result);
    expect(text).not.toContain('CP03_2024_062M');
    expect(text).not.toContain('MOE code');
  });
});

describe('census_list_predicate_values code normalization (#50)', () => {
  const serveCbp = () => {
    routes['/data/2023/cbp/variables.json'] = {
      variables: {
        EMPSZES: {
          label: 'Employment size of establishments code',
          predicateType: 'string',
          group: 'CB2300CBP',
          required: 'default displayed',
          attributes: 'EMPSZES_LABEL',
        },
        EMP: {
          label: 'Number of employees',
          predicateType: 'int',
          group: 'CB2300CBP',
          attributes: 'EMP_F',
        },
      },
    };
    routes['/data/2023/cbp'] = [
      ['EMPSZES_LABEL', 'EMPSZES', 'us'],
      ['All establishments', '001', '1'],
      ['Establishments with less than 5 employees', '210', '1'],
    ];
  };

  it('enumerates a lowercase dimension code and echoes it uppercased', async () => {
    serveCbp();

    const result = await runToolContract(censusListPredicateValues, {
      predicate: ' empszes ',
      dataset: 'cbp',
    });

    const out = structured(result);
    expect(out.predicate).toBe('EMPSZES');
    expect(out.values?.map((v) => v.code)).toEqual(['001', '210']);
    expect(textOf(result)).toContain('## EMPSZES');
  });

  it('names the uppercased code when a lowercase code is unknown', async () => {
    serveCbp();

    const result = await runToolContract(censusListPredicateValues, {
      predicate: 'bogus',
      dataset: 'cbp',
    });

    const error = structured(result).error;
    expect(error?.data).toMatchObject({ reason: 'predicate_not_supported', predicate: 'BOGUS' });
    expect(textOf(result)).toContain('"BOGUS"');
  });

  it('does not treat an attribute column as a dimension (#48)', async () => {
    serveCbp();

    const result = await runToolContract(censusListPredicateValues, {
      predicate: 'emp_f',
      dataset: 'cbp',
    });

    expect(structured(result).error?.data).toMatchObject({ reason: 'predicate_not_supported' });
  });
});

// ---------------------------------------------------------------------------------------------
// #54 — the POPGROUP publication check on dec/ddhcb unions two tables; every other dataset keeps
// one probe. The check rethrows a caller's cancellation, and no_values names only the levers the
// call can change.
// ---------------------------------------------------------------------------------------------

/**
 * POPGROUP sets captured from api.census.gov on 2026-10-13 (`get=<measure>&POPGROUP=*&for=us:1`):
 * the 5,545 codes the dec/ddhcb dictionary declares, the labels of the few a test searches for, and
 * the codes each probe table publishes nationally.
 */
const ddhcbPopgroups = JSON.parse(
  readFileSync(new URL('../fixtures/dec-ddhcb-2020-popgroup.json', import.meta.url), 'utf8'),
) as {
  declared: string;
  labels: Record<string, string>;
  national: Record<string, string>;
};

const codesOf = (list: string) => list.split(' ');

/** The data request the fetch fake is answering, which `calls` holds last. */
const currentCall = () => calls.at(-1) as URL;

/** The national POPGROUP wildcard for one measure, as the Census answers it. */
const popgroupRows = (measure: string, codes: string[]) =>
  new Response(
    JSON.stringify([[measure, 'POPGROUP', 'us'], ...codes.map((code) => ['100', code, '1'])]),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const predicateValuesOut = (result: { structuredContent?: unknown }) =>
  result.structuredContent as {
    values?: Array<{ code: string; label: string }>;
    totalCount?: number;
    source?: string;
    notice?: string;
    error?: { code: number; message: string; data: Record<string, unknown> };
  };

/** The data requests a call sent — metadata requests left out. */
const dataRequests = (path: string) => calls.filter((u) => u.pathname === path);

describe('census_list_predicate_values checks dec/ddhcb POPGROUP against both tenure tables (#54)', () => {
  const DATA = '/data/2020/dec/ddhcb';

  const serveDdhcb = (answer: (measure: string) => Response | Promise<Response>) => {
    routes[`${DATA}/variables.json`] = {
      variables: {
        T03001_001N: { label: '!!Total', predicateType: 'int', group: 'T03001' },
        T03002_001N: { label: '!!Total:', predicateType: 'int', group: 'T03002' },
        T03002_002N: {
          label: '!!Total:!!Family households',
          predicateType: 'int',
          group: 'T03002',
        },
        T03003_001N: { label: '!!Total:', predicateType: 'int', group: 'T03003' },
        T03003_003N: { label: '!!Married couple family', predicateType: 'int', group: 'T03003' },
        T03004_001N: { label: '!!Total:', predicateType: 'int', group: 'T03004' },
        T03004_002N: { label: '!!Family households:', predicateType: 'int', group: 'T03004' },
        T04001_001N: { label: '!!Total', predicateType: 'int', group: 'T04001' },
        T04002_001N: { label: '!!Total:', predicateType: 'int', group: 'T04002' },
        T04002_004N: { label: '!!Total:!!Renter occupied', predicateType: 'int', group: 'T04002' },
        POPGROUP: {
          label: 'Race/Ethnic Group',
          required: 'default displayed',
          predicateType: 'string',
          group: 'T03002,T03001,T04002,T04001,T03004,T03003',
          attributes: 'POPGROUP_LABEL',
          values: {
            item: Object.fromEntries(
              codesOf(ddhcbPopgroups.declared).map((code) => [
                code,
                ddhcbPopgroups.labels[code] ?? `Group ${code}`,
              ]),
            ),
          },
        },
        GEOCOMP: {
          label: 'GEO_ID Component',
          required: 'default displayed',
          predicateType: 'string',
          group: 'N/A',
        },
      },
    };
    routes[DATA] = (() =>
      Promise.resolve(answer(currentCall().searchParams.get('get') ?? ''))) satisfies RouteFn;
  };

  /** Each tenure table answers with the groups the Census publishes in it nationally. */
  const published = (measure: string) =>
    popgroupRows(measure, codesOf(ddhcbPopgroups.national[measure] ?? ''));

  it('lists the 2,996 groups the two tables publish between them, on both surfaces', async () => {
    serveDdhcb(published);

    const result = await runToolContract(censusListPredicateValues, {
      predicate: 'POPGROUP',
      dataset: 'ddhcb',
      limit: 1,
    });

    expect(result.isError).toBeFalsy();
    const out = predicateValuesOut(result);
    expect(out.totalCount).toBe(2996);
    expect(out.source).toBe('dataset_dictionary_verified');
    expect(out.notice).toContain('declares 5,545 POPGROUP codes and publishes rows for 2,996');
    const text = textOf(result);
    expect(text).toContain('**totalCount:** 2996');
    expect(text).toContain('**source:** `dataset_dictionary_verified`');
    expect(text).toContain('publishes rows for 2,996');
  });

  it('spends two requests per cache refresh, one per tenure table, and none on a repeat call', async () => {
    serveDdhcb(published);

    await runToolContract(censusListPredicateValues, {
      predicate: 'POPGROUP',
      dataset: 'dec/ddhcb',
    });
    await runToolContract(censusListPredicateValues, {
      predicate: 'POPGROUP',
      dataset: 'dec/ddhcb',
      query: 'european',
    });

    expect(calls.map((u) => u.pathname)).toEqual([`${DATA}/variables.json`, DATA, DATA]);
    const probes = dataRequests(DATA);
    expect(probes.map((u) => u.searchParams.get('get')).sort()).toEqual([
      'T04001_001N',
      'T04002_001N',
    ]);
    for (const probe of probes) {
      expect(probe.searchParams.get('POPGROUP')).toBe('*');
      expect(probe.searchParams.get('for')).toBe('us:1');
    }
  });

  /** WA publishes 1360 in T03002 and the nation in T03003 — the old T03001-only check hid it. */
  it('finds Alaska Native alone, 1360, by keyword', async () => {
    serveDdhcb(published);

    const result = await runToolContract(censusListPredicateValues, {
      predicate: 'POPGROUP',
      dataset: 'dec/ddhcb',
      query: 'alaska native alone',
    });

    expect(predicateValuesOut(result).values?.map((v) => v.code)).toEqual([
      '1360',
      '1629',
      '2560',
      '2562',
      '2831',
      '3762',
    ]);
    expect(textOf(result)).toContain('**`1360`** — Alaska Native alone');
  });

  /** Half a union would withhold every group the silent table publishes. */
  it('returns the dictionary unchecked when one of the two tables answers with nothing', async () => {
    serveDdhcb((measure) =>
      measure === 'T04002_001N' ? new Response(null, { status: 204 }) : published(measure),
    );

    const result = await runToolContract(censusListPredicateValues, {
      predicate: 'POPGROUP',
      dataset: 'dec/ddhcb',
      limit: 1,
    });

    const out = predicateValuesOut(result);
    expect(out.source).toBe('dataset_dictionary');
    expect(out.totalCount).toBe(5545);
    expect(out.notice).toContain('was not possible on this call');
  });

  /** Run under fake timers, reporting whether the call settled within `withinMs` of starting. */
  const runTimed = async (withinMs: number) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let settled = false;
      const pending = runToolContract(censusListPredicateValues, {
        predicate: 'POPGROUP',
        dataset: 'dec/ddhcb',
        limit: 1,
      }).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(withinMs);
      const settledInTime = settled;
      await vi.advanceTimersByTimeAsync(300_000);
      return { result: await pending, settledInTime };
    } finally {
      vi.useRealTimers();
    }
  };

  const tenureRequests = (measure: string) =>
    dataRequests(DATA).filter((u) => u.searchParams.get('get') === measure);

  it('retries a failing tenure table, then lists the dictionary unchecked (characterization)', async () => {
    serveDdhcb((measure) =>
      measure === 'T04002_001N'
        ? new Response('Service Unavailable', { status: 503 })
        : published(measure),
    );

    const { result } = await runTimed(0);

    const out = predicateValuesOut(result);
    expect(out.source).toBe('dataset_dictionary');
    expect(out.notice).toContain('was not possible on this call');
    expect(tenureRequests('T04002_001N')).toHaveLength(4);
  });

  /**
   * The check is best-effort, so a tenure table that never answers must not hold the call past the
   * 60-second request timeout MCP SDK clients default to — four 15-second attempts and their
   * backoff came to 66 s, and the caller saw a timeout instead of the unchecked list.
   */
  it('lists the dictionary unchecked within 30 s when a tenure table hangs, on both surfaces', async () => {
    serveDdhcb(published);
    routes[DATA] = ((init) => {
      if (currentCall().searchParams.get('get') !== 'T04002_001N') {
        return Promise.resolve(published(currentCall().searchParams.get('get') ?? ''));
      }
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }) satisfies RouteFn;

    const { result, settledInTime } = await runTimed(30_000);

    expect(settledInTime).toBe(true);
    expect(result.isError).toBeFalsy();
    const out = predicateValuesOut(result);
    expect(out.source).toBe('dataset_dictionary');
    expect(out.totalCount).toBe(5545);
    expect(textOf(result)).toContain('**source:** `dataset_dictionary`');
    expect(textOf(result)).toContain('was not possible on this call');
  });
});

describe('the publication check stays one probe on every other dataset (characterization)', () => {
  it('dec/ddhca sends variables.json and one T01001_001N wildcard', async () => {
    routes['/data/2020/dec/ddhca/variables.json'] = {
      variables: {
        T01001_001N: { label: ' !!Total', predicateType: 'int', group: 'T01001' },
        T02001_001N: { label: ' !!Total:', predicateType: 'int', group: 'T02001' },
        T02001_002N: { label: ' !!Total:!!Male:', predicateType: 'int', group: 'T02001' },
        POPGROUP: {
          label: 'Race/Ethnic Group',
          required: 'default displayed',
          predicateType: 'string',
          group: 'T02001,T01001',
          attributes: 'POPGROUP_LABEL',
          values: { item: { '001': 'Total population', '1002': 'European alone' } },
        },
      },
    };
    routes['/data/2020/dec/ddhca'] = [
      ['T01001_001N', 'POPGROUP', 'us'],
      ['191697647', '1002', '1'],
    ];

    const result = await runToolContract(censusListPredicateValues, {
      predicate: 'POPGROUP',
      dataset: 'dec/ddhca',
    });

    expect(predicateValuesOut(result).values?.map((v) => v.code)).toEqual(['1002']);
    expect(calls.map((u) => u.pathname)).toEqual([
      '/data/2020/dec/ddhca/variables.json',
      '/data/2020/dec/ddhca',
    ]);
    expect(calls[1]?.searchParams.get('get')).toBe('T01001_001N');
  });

  it('cbp sends variables.json and one measure wildcard for NAICS2017', async () => {
    routes['/data/2023/cbp/variables.json'] = {
      variables: {
        ESTAB: { label: 'Number of establishments', predicateType: 'int', group: 'CB2300CBP' },
        EMP: { label: 'Number of employees', predicateType: 'int', group: 'CB2300CBP' },
        NAICS2017: {
          label: 'Meaning of NAICS code',
          required: 'default displayed',
          predicateType: 'string',
          group: 'CB2300CBP',
          values: { item: { '00': 'Total for all sectors', '0': 'Undefined' } },
        },
      },
    };
    routes['/data/2023/cbp'] = [
      ['EMP', 'NAICS2017', 'us'],
      ['134000000', '00', '1'],
    ];

    await runToolContract(censusListPredicateValues, { predicate: 'NAICS2017', dataset: 'cbp' });

    expect(calls.map((u) => u.pathname)).toEqual([
      '/data/2023/cbp/variables.json',
      '/data/2023/cbp',
    ]);
    expect(calls[1]?.searchParams.get('get')).toBe('EMP');
  });
});

describe('census_list_predicate_values publication check under cancellation and failure', () => {
  const serveDdhca = () => {
    routes['/data/2020/dec/ddhca/variables.json'] = {
      variables: {
        T01001_001N: { label: ' !!Total', predicateType: 'int', group: 'T01001' },
        POPGROUP: {
          label: 'Race/Ethnic Group',
          required: 'default displayed',
          predicateType: 'string',
          group: 'T01001',
          attributes: 'POPGROUP_LABEL',
          values: { item: { '001': 'Total population', '1002': 'European alone' } },
        },
      },
    };
  };

  /** Rejects with the signal's reason once it aborts, as fetch does; never answers otherwise. */
  const hang: RouteFn = (init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });

  /**
   * The check is best-effort, but a caller's cancellation is not a failed check: degrading to the
   * unchecked list turns the cancellation into a successful answer nobody is waiting for.
   */
  it('is RequestCancelled, never the unchecked list, when the caller cancels mid-check', async () => {
    serveDdhca();
    const controller = new AbortController();
    routes['/data/2020/dec/ddhca'] = ((init) => {
      queueMicrotask(() => controller.abort());
      return hang(init);
    }) satisfies RouteFn;

    const result = await runToolContract(
      censusListPredicateValues,
      { predicate: 'POPGROUP', dataset: 'dec/ddhca' },
      { context: { signal: controller.signal } },
    );

    expect(result.isError).toBe(true);
    expect(predicateValuesOut(result).error?.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(predicateValuesOut(result)).not.toHaveProperty('source');
    expect(dataRequests('/data/2020/dec/ddhca')).toHaveLength(1);
  });

  it('degrades to the unchecked list when the check itself fails (characterization)', async () => {
    serveDdhca();
    routes['/data/2020/dec/ddhca'] = new Response('error: unknown variable', { status: 400 });

    const result = await runToolContract(censusListPredicateValues, {
      predicate: 'POPGROUP',
      dataset: 'dec/ddhca',
    });

    expect(result.isError).toBeFalsy();
    const out = predicateValuesOut(result);
    expect(out.source).toBe('dataset_dictionary');
    expect(out.values?.map((v) => v.code)).toEqual(['001', '1002']);
    expect(out.notice).toContain('was not possible on this call');
  });
});

describe('no_values names within_naics only when the call set it', () => {
  const hintOf = (result: { structuredContent?: unknown }) =>
    (predicateValuesOut(result).error?.data as { recovery?: { hint?: string } } | undefined)
      ?.recovery?.hint;

  /** cbp declares no industry scope for EMPSZES, and this call sent none. */
  it('offers no within_naics lever to an unscoped enumeration that came back empty', async () => {
    routes['/data/2023/cbp/variables.json'] = {
      variables: {
        ESTAB: { label: 'Number of establishments', predicateType: 'int', group: 'CB2300CBP' },
        EMPSZES: {
          label: 'Employment size of establishments code',
          required: 'default displayed',
          predicateType: 'string',
          group: 'CB2300CBP',
          attributes: 'EMPSZES_LABEL',
        },
      },
    };
    routes['/data/2023/cbp'] = new Response(null, { status: 204 });

    const result = await runToolContract(censusListPredicateValues, {
      predicate: 'EMPSZES',
      dataset: 'cbp',
    });

    expect(predicateValuesOut(result).error?.data).toMatchObject({ reason: 'no_values' });
    expect(hintOf(result)).toBeDefined();
    expect(hintOf(result)).not.toContain('within_naics');
    expect(textOf(result)).toMatch(/^Recovery: /m);
    expect(textOf(result)).not.toContain('within_naics');
  });

  /** A value map whose published codes share none with it: within_naics is ignored on this route. */
  it('offers no within_naics lever when a value map kept no published code', async () => {
    routes['/data/2020/dec/ddhca/variables.json'] = {
      variables: {
        T01001_001N: { label: ' !!Total', predicateType: 'int', group: 'T01001' },
        POPGROUP: {
          label: 'Race/Ethnic Group',
          required: 'default displayed',
          predicateType: 'string',
          group: 'T01001',
          values: { item: { '001': 'Total population' } },
        },
      },
    };
    routes['/data/2020/dec/ddhca'] = [
      ['T01001_001N', 'POPGROUP', 'us'],
      ['191697647', '1002', '1'],
    ];

    const result = await runToolContract(censusListPredicateValues, {
      predicate: 'POPGROUP',
      dataset: 'dec/ddhca',
      within_naics: '62',
    });

    expect(predicateValuesOut(result).error?.data).toMatchObject({ reason: 'no_values' });
    expect(hintOf(result)).not.toContain('within_naics');
    expect(textOf(result)).not.toContain('within_naics');
  });

  it('keeps the within_naics lever for an industry-scoped enumeration (characterization)', async () => {
    routes['/data/2022/ecnbasic/variables.json'] = {
      variables: {
        ESTAB: { label: 'Number of establishments', predicateType: 'int', group: 'EC2200BASIC' },
        NAICS2022: {
          label: '2022 NAICS code',
          required: 'default displayed',
          predicateType: 'string',
          group: 'EC2200BASIC',
          attributes: 'NAICS2022_LABEL',
          values: { item: { '00': 'Total for all sectors' } },
        },
        TAXSTAT: {
          label: 'Tax status code',
          required: 'default displayed',
          predicateType: 'string',
          group: 'EC2200BASIC',
          attributes: 'TAXSTAT_LABEL',
        },
      },
    };
    routes['/data/2022/ecnbasic'] = new Response(null, { status: 204 });

    const result = await runToolContract(censusListPredicateValues, {
      predicate: 'TAXSTAT',
      dataset: 'ecnbasic',
      within_naics: '541990',
    });

    expect(predicateValuesOut(result).error?.data).toMatchObject({ reason: 'no_values' });
    expect(hintOf(result)).toContain('within_naics');
    expect(textOf(result)).toContain('within_naics');
  });
});
