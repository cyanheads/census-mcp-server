/**
 * @fileoverview Contract tests for census_search_variables, census_get_variable, and
 * census_list_predicate_values, run through the real VariableCacheService and CensusApiService
 * over a routed fetch fake. The ranking, the shared-table rule, attribute resolution, the universe
 * join, and code normalization all live below the handlers, so these tests read both client
 * surfaces the tools produce rather than a stubbed service's return value.
 * @module tests/tools/census-variable-tools.contract.test
 */

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

let routes: Record<string, unknown> = {};
let calls: URL[] = [];

beforeEach(() => {
  routes = {};
  calls = [];
  initCensusApiService();
  initVariableCacheService();
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL) => {
      const url = new URL(String(input));
      calls.push(url);
      const body = routes[url.pathname];
      if (body === undefined) return Promise.reject(new Error(`unmocked fetch: ${url.pathname}`));
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
    expect(calls.some((u) => u.pathname.includes('/variables/'))).toBe(false);
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
