/**
 * @fileoverview Tests for VariableCacheService — the ACS-scoped margin-of-error inference,
 * required-predicate reporting, and the dataset/code validation the tools depend on.
 * @module tests/services/variable-cache/variable-cache-service.test
 */

import {
  JsonRpcErrorCode,
  type McpError,
  McpError as McpErrorClass,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { httpStatusToErrorCode } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { censusHttpError } from '@/services/census-api/errors.js';
import {
  DATASET_AVAILABLE_YEARS,
  DATASET_LATEST_YEARS,
  describeAmbiguousRows,
  describeEmptyPredicatedResult,
  describeRecordRows,
  describeTableSplit,
  describeUnsetPredicates,
  getVariableCacheService,
  initVariableCacheService,
  isAcsDataset,
  KNOWN_DATASETS,
  resolveDataset,
  SIBLING_LOOKUP_DEADLINE_MS,
  VariableCacheService,
} from '@/services/variable-cache/variable-cache-service.js';

vi.mock('@/config/server-config.js', () => ({
  getDiscoveryConfig: vi.fn(() => ({ defaultYear: 2024, variableCacheTtlHours: 24 })),
  getServerConfig: vi.fn(() => ({
    defaultYear: 2024,
    censusApiKey: 'test-key',
    variableCacheTtlHours: 24,
  })),
}));

/**
 * Bodies handed out in call order; a request past the end sees an empty variables map. A queued
 * `Response` is served as-is, which is how a non-2xx status and its body are staged.
 */
let responses: unknown[] = [];
let requestedUrls: string[] = [];

const queue = (...bodies: unknown[]) => {
  responses = bodies;
};

/** The servlet container error page the Census API answers a missing dataset+year path with. */
const TOMCAT_404 =
  '<!doctype html><html lang="en"><head><title>HTTP Status 404 – Not Found</title><style type="text/css">body {font-family:Tahoma,Arial,sans-serif;}</style></head><body><h1>HTTP Status 404 – Not Found</h1></body></html>';

let service: VariableCacheService;

beforeEach(() => {
  responses = [];
  requestedUrls = [];
  service = new VariableCacheService();
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string | URL) => {
      requestedUrls.push(String(url));
      const body = responses.shift() ?? { variables: {} };
      if (body instanceof Response) return Promise.resolve(body);
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

/**
 * A trimmed acs/acs5 variables.json. The Census API omits the `B19013_001M` margin-of-error
 * entry even though the data API serves it — that omission is what the inference exists for.
 */
const acsVariablesJson = {
  variables: {
    B19013_001E: {
      label: 'Estimate!!Median household income in the past 12 months',
      concept: 'Median Household Income',
      predicateType: 'int',
    },
    GEOCOMP: { label: 'GEO_ID Component', required: 'default displayed', predicateType: 'string' },
    for: { label: 'Census API FIPS' },
  },
};

/**
 * A trimmed pep/charv variables.json, carrying the codes the fabricated MOE entries were
 * derived from: UNIVERSE, AGE, and MEDAGE all end in `E` without being ACS estimates.
 */
const pepVariablesJson = {
  variables: {
    UNIVERSE: { label: 'Universe', concept: 'Population Estimates', predicateType: 'string' },
    AGE: { label: 'Age Group Code', required: 'default displayed', predicateType: 'int' },
    MEDAGE: { label: 'Median Age', concept: 'Population Estimates', predicateType: 'float' },
    POP: { label: 'Population', concept: 'Population Estimates', predicateType: 'int' },
    SEX: { label: 'Sex Code', required: 'default displayed', predicateType: 'int' },
    GEOCOMP: { label: 'GEO_ID Component', required: 'default displayed', predicateType: 'string' },
  },
};

/** A trimmed cbp variables.json — `STATE` is a geography field that happens to end in `E`. */
const cbpVariablesJson = {
  variables: {
    ESTAB: {
      label: 'Number of establishments',
      concept: 'Business Patterns',
      predicateType: 'int',
    },
    STATE: { label: 'State', concept: '', predicateType: 'string' },
    NAICS2017: { label: '2017 NAICS code', required: 'default displayed', predicateType: 'string' },
    LFO: {
      label: 'Legal form of organization code',
      required: 'default displayed',
      predicateType: 'string',
    },
    GEOCOMP: { label: 'GEO_ID Component', required: 'default displayed', predicateType: 'string' },
  },
};

/**
 * A trimmed dec/ddhca variables.json. POPGROUP is the one dimension it filters on and it
 * carries both a published value map and the `_LABEL` attribute.
 */
const ddhcaVariablesJson = {
  variables: {
    T01001_001N: { label: 'Total population', concept: 'Total Population', predicateType: 'int' },
    POPGROUP: {
      label: 'Race/Ethnic Group',
      required: 'default displayed',
      predicateType: 'string',
      attributes: 'POPGROUP_LABEL',
      values: { item: { '001': 'Total population', '1002': 'European alone' } },
    },
    GEOCOMP: { label: 'GEO_ID Component', required: 'default displayed', predicateType: 'string' },
  },
};

/**
 * A trimmed ecnbasic variables.json. TAXSTAT publishes no value map, only a label attribute;
 * NAICS2022 carries the mixed flag/label `attributes` list the Census publishes for it.
 */
const ecnbasicVariablesJson = {
  variables: {
    ESTAB: { label: 'Number of establishments', concept: 'Economic Census', predicateType: 'int' },
    NAICS2022: {
      label: '2022 NAICS code',
      required: 'default displayed',
      predicateType: 'string',
      attributes: 'NAICS2022_F,NAICS2022_LABEL,NAICS2022_F',
      values: {
        item: { '00': 'Total for all sectors', '62': 'Health Care and Social Assistance' },
      },
    },
    TAXSTAT: {
      label: 'Tax status code',
      required: 'default displayed',
      predicateType: 'string',
      attributes: 'TAXSTAT_LABEL',
    },
  },
};

describe('isAcsDataset', () => {
  it.each([
    'acs/acs5',
    'acs/acs5/profile',
    'acs/acs5/subject',
    'acs/acs5/cprofile',
    'acs/acs1',
    'acs/acs1/profile',
    'acs/acs1/subject',
    'acs/acs1/cprofile',
    'acs/acs1/spp',
    'acs/acsse',
  ])('treats %s as ACS', (dataset) => {
    expect(isAcsDataset(dataset)).toBe(true);
  });

  it.each([
    'pep/charv',
    'dec/pl',
    'dec/dhc',
    'dec/dp',
    'dec/sdhc',
    'dec/ddhca',
    'cbp',
    'ecnbasic',
    'nonemp',
  ])('treats %s as non-ACS', (dataset) => {
    expect(isAcsDataset(dataset)).toBe(false);
  });

  it('covers every registered dataset — no code falls outside the two branches', () => {
    for (const dataset of KNOWN_DATASETS) {
      expect(typeof isAcsDataset(dataset)).toBe('boolean');
      expect(DATASET_LATEST_YEARS[dataset]).toBeTypeOf('number');
    }
  });
});

describe('VariableCacheService — margin-of-error inference on ACS', () => {
  it('infers the unlisted M sibling of an E-suffix estimate', async () => {
    queue(acsVariablesJson);

    const [estimate] = await service.getVariablesByCode(
      ['B19013_001E'],
      'acs/acs5',
      2024,
      createMockContext(),
    );

    expect(estimate?.moeCode).toBe('B19013_001M');
  });

  it('synthesizes the M entry so a direct lookup of it resolves', async () => {
    queue(acsVariablesJson);

    const [moe] = await service.getVariablesByCode(
      ['B19013_001M'],
      'acs/acs5',
      2024,
      createMockContext(),
    );

    expect(moe?.code).toBe('B19013_001M');
    expect(moe?.label).toContain('Margin of Error');
    expect(moe?.estimateCode).toBe('B19013_001E');
  });

  /**
   * The Census publishes each M column's own record (`…/variables/B19013_001M.json`): the label
   * swaps the estimate's leading `Estimate!!` for `Margin of Error!!`, and the record names the
   * estimate it annotates. The synthesized entry has to read the same without fetching it.
   */
  it('labels the synthesized M entry the way the Census publishes it (#58)', async () => {
    queue(acsVariablesJson);

    const [moe] = await service.getVariablesByCode(
      ['B19013_001M'],
      'acs/acs5',
      2024,
      createMockContext(),
    );

    expect(moe).toMatchObject({
      label: 'Margin of Error!!Median household income in the past 12 months',
      attributeOf: 'B19013_001E',
      attributeType: 'MARGIN_OF_ERROR',
      predicateType: 'int',
    });
    expect(requestedUrls.filter((u) => u.includes('/variables/'))).toEqual([]);
  });

  it('marks an M code variables.json does list as the margin of its estimate (#58)', async () => {
    queue({
      variables: {
        B01003_001E: {
          label: 'Estimate!!Total',
          concept: 'Total Population',
          predicateType: 'int',
        },
        B01003_001M: {
          label: 'Margin of Error!!Total',
          concept: 'Total Population',
          predicateType: 'int',
        },
      },
    });

    const [moe] = await service.getVariablesByCode(
      ['B01003_001M'],
      'acs/acs5',
      2024,
      createMockContext(),
    );

    expect(moe).toMatchObject({
      label: 'Margin of Error!!Total',
      estimateCode: 'B01003_001E',
      attributeOf: 'B01003_001E',
      attributeType: 'MARGIN_OF_ERROR',
    });
  });

  /** A profile percent column is labelled `Percent!!…`; its margin is `Percent Margin of Error!!…`. */
  it('labels the margin of a Percent!! estimate as a percent margin of error (#58)', async () => {
    queue({
      variables: {
        DP03_0062PE: {
          label:
            'Percent!!INCOME AND BENEFITS (IN 2024 INFLATION-ADJUSTED DOLLARS)!!Total households!!Median household income (dollars)',
          concept: 'Selected Economic Characteristics',
          predicateType: 'int',
          group: 'DP03',
        },
      },
    });

    const [moe] = await service.getVariablesByCode(
      ['DP03_0062PM'],
      'acs/acs5/profile',
      2024,
      createMockContext(),
    );

    expect(moe?.label).toBe(
      'Percent Margin of Error!!INCOME AND BENEFITS (IN 2024 INFLATION-ADJUSTED DOLLARS)!!Total households!!Median household income (dollars)',
    );
    expect(moe?.attributeOf).toBe('DP03_0062PE');
  });

  it('prefixes a label with no Estimate!! segment rather than dropping any of it (#58)', async () => {
    queue({
      variables: {
        B01003_001E: {
          label: 'Total population',
          concept: 'Total Population',
          predicateType: 'int',
        },
      },
    });

    const [moe] = await service.getVariablesByCode(
      ['B01003_001M'],
      'acs/acs5',
      2024,
      createMockContext(),
    );

    expect(moe?.label).toBe('Margin of Error!!Total population');
  });

  /** `S1701_C03_001E` is a float percentage and the Census publishes its M column as a float too. */
  it('gives the synthesized M entry the predicate type of its estimate', async () => {
    queue({
      variables: {
        S1701_C03_001E: {
          label:
            'Estimate!!Percent below poverty level!!Population for whom poverty status is determined',
          concept: 'Poverty Status in the Past 12 Months',
          predicateType: 'float',
          group: 'S1701',
        },
      },
    });

    const [moe] = await service.getVariablesByCode(
      ['S1701_C03_001M'],
      'acs/acs5/subject',
      2024,
      createMockContext(),
    );

    expect(moe?.predicateType).toBe('float');
    expect(moe?.label).toBe(
      'Margin of Error!!Percent below poverty level!!Population for whom poverty status is determined',
    );
  });

  /**
   * The year medians (`B25035_001E`, median year structure built) are typed `string`, but the
   * Census publishes their margins as `int` (`/data/2024/acs/acs5/variables/B25035_001M.json`).
   */
  it('types the margin of a string-typed estimate as int, as the Census publishes it', async () => {
    queue({
      variables: {
        B25035_001E: {
          label: 'Estimate!!Median year structure built',
          concept: 'Median Year Structure Built',
          predicateType: 'string',
          group: 'B25035',
        },
      },
    });

    const [moe] = await service.getVariablesByCode(
      ['B25035_001M'],
      'acs/acs5',
      2024,
      createMockContext(),
    );

    expect(moe?.predicateType).toBe('int');
  });

  /**
   * Older vintages put `Estimate` in a later segment, and the published margin replaces that
   * segment in place: `/data/2010/acs/acs5/subject/variables/S0101_C01_001M.json` is
   * "Total!!Margin of Error!!Total population", and the 2009 profile publishes
   * "Number!!Margin of Error!!…" and "Percent!!Margin of Error!!…".
   */
  it.each([
    [
      'acs/acs5/subject',
      2010,
      'S0101_C01_001',
      'Total!!Estimate!!Total population',
      'Total!!Margin of Error!!Total population',
    ],
    [
      'acs/acs5/profile',
      2009,
      'DP02_0001',
      'Number!!Estimate!!HOUSEHOLDS BY TYPE!!Total households',
      'Number!!Margin of Error!!HOUSEHOLDS BY TYPE!!Total households',
    ],
    [
      'acs/acs5/profile',
      2009,
      'DP02_0001P',
      'Percent!!Estimate!!HOUSEHOLDS BY TYPE!!Total households',
      'Percent!!Margin of Error!!HOUSEHOLDS BY TYPE!!Total households',
    ],
  ])(
    'labels a %s %i margin by replacing its Estimate segment in place (#58)',
    async (dataset, year, stem, label, expected) => {
      queue({
        variables: {
          [`${stem}E`]: {
            label,
            concept: 'Profile',
            predicateType: 'int',
            group: stem.slice(0, 4),
          },
        },
      });

      const [moe] = await service.getVariablesByCode(
        [`${stem}M`],
        dataset,
        year,
        createMockContext(),
      );

      expect(moe?.label).toBe(expected);
    },
  );

  /**
   * ACS variables.json lists geography columns beside the estimates — `STATE` and `PLACE` on every
   * vintage, `AITSCE` and `LSAD_NAME` on the older ones — each with `group: "N/A"`. They end in E
   * but are no estimate, and `/data/2024/acs/acs5/variables/STATM.json` is a 404.
   */
  it('infers no margin for a table-less column that happens to end in E', async () => {
    queue({
      variables: {
        STATE: { label: 'State', group: 'N/A', limit: 0 },
        LSAD_NAME: {
          label: 'Legal/Statistical Area Description name',
          predicateType: 'string',
          group: 'N/A',
        },
        B19013_001E: {
          label: 'Estimate!!Median household income in the past 12 months',
          concept: 'Median Household Income',
          predicateType: 'int',
          group: 'B19013',
        },
      },
    });
    const ctx = createMockContext();

    const [state, name] = await service.getVariablesByCode(
      ['STATE', 'LSAD_NAME'],
      'acs/acs5',
      2009,
      ctx,
    );
    expect(state?.moeCode).toBeUndefined();
    expect(name?.moeCode).toBeUndefined();
    await expect(
      service.getVariablesByCode(['STATM', 'LSAD_NAMM'], 'acs/acs5', 2009, ctx),
    ).rejects.toMatchObject({
      data: { reason: 'variable_not_found', missingCodes: ['STATM', 'LSAD_NAMM'] },
    });
    const { variables } = await service.searchVariables(
      { query: 'state', dataset: 'acs/acs5', year: 2009, limit: 10 },
      ctx,
    );
    expect(variables.map((v) => v.code)).toEqual(['STATE']);
  });

  /**
   * The synthesized label used to keep the estimate's `Estimate!!` segment, so every M code matched
   * one more word of an "estimate" query than its own estimate did and took the whole first tier.
   */
  it('ranks an estimate with its margin rather than behind it for an "estimate" query (#58)', async () => {
    queue(acsVariablesJson);

    const { variables } = await service.searchVariables(
      {
        query: 'annotation of estimate median household income',
        dataset: 'acs/acs5',
        year: 2024,
        limit: 20,
      },
      createMockContext(),
    );

    expect(variables[0]?.code).toBe('B19013_001E');
    expect(variables.map((v) => v.code)).toContain('B19013_001M');
  });
});

describe('VariableCacheService — margin-of-error inference off outside ACS', () => {
  it('leaves a pep/charv E-suffix code with no moeCode', async () => {
    queue(pepVariablesJson);

    const vars = await service.getVariablesByCode(
      ['UNIVERSE', 'MEDAGE'],
      'pep/charv',
      2023,
      createMockContext(),
    );

    expect(vars.map((v) => v.moeCode)).toEqual([undefined, undefined]);
  });

  it('reports variable_not_found for the M code pep/charv never had', async () => {
    queue(pepVariablesJson);

    await expect(
      service.getVariablesByCode(['UNIVERSM', 'AGM'], 'pep/charv', 2023, createMockContext()),
    ).rejects.toMatchObject({
      data: { reason: 'variable_not_found', missingCodes: ['UNIVERSM', 'AGM'] },
    });
  });

  it('keeps synthetic MOE entries out of pep/charv search results', async () => {
    queue(pepVariablesJson);

    const { variables } = await service.searchVariables(
      { query: 'population', dataset: 'pep/charv', year: 2023, limit: 50 },
      createMockContext(),
    );

    expect(variables.map((v) => v.code)).not.toContain('MEDAGM');
    expect(variables.every((v) => !v.label.startsWith('Margin of Error'))).toBe(true);
  });

  it('does not fabricate a margin of error for the cbp STATE geography field', async () => {
    queue(cbpVariablesJson);

    const [state] = await service.getVariablesByCode(['STATE'], 'cbp', 2023, createMockContext());
    expect(state?.moeCode).toBeUndefined();

    queue(cbpVariablesJson);
    await expect(
      service.getVariablesByCode(['STATM'], 'cbp', 2023, createMockContext()),
    ).rejects.toMatchObject({ data: { reason: 'variable_not_found' } });
  });
});

/**
 * A trimmed acs/acs5/cprofile 2024 variables.json. The comparison profiles publish no margins of
 * error at all: the data API answers `CP03_2024_062M` with HTTP 400, so an inferred M code would
 * advertise a column that cannot be queried.
 */
const cprofileVariablesJson = {
  variables: {
    CP03_2024_062E: {
      label:
        '2020-2024 Estimates!!INCOME AND BENEFITS (IN 2024 INFLATION-ADJUSTED DOLLARS)!!Total households!!Median household income (dollars)',
      concept: 'Comparative Economic Characteristics',
      predicateType: 'int',
      group: 'CP03',
      attributes: 'CP03_2024_062EA,CP03_2024to2019_062SS',
    },
    CP03_2019_062E: {
      label:
        '2015-2019 Estimates!!INCOME AND BENEFITS (IN 2024 INFLATION-ADJUSTED DOLLARS)!!Total households!!Median household income (dollars)',
      concept: 'Comparative Economic Characteristics',
      predicateType: 'int',
      group: 'CP03',
      attributes: 'CP03_2019_062EA,CP03_2024to2019_062SS',
    },
  },
};

describe('VariableCacheService — no margin-of-error inference on the comparison profiles (#52)', () => {
  it.each(['acs/acs5/cprofile', 'acs/acs1/cprofile'])(
    'leaves a %s estimate with no moeCode',
    async (dataset) => {
      queue(cprofileVariablesJson);

      const vars = await service.getVariablesByCode(
        ['CP03_2024_062E', 'CP03_2019_062E'],
        dataset,
        2024,
        createMockContext(),
      );

      expect(vars.map((v) => v.moeCode)).toEqual([undefined, undefined]);
    },
  );

  it('reports variable_not_found for the M code the comparison profile does not publish', async () => {
    queue(cprofileVariablesJson);

    await expect(
      service.getVariablesByCode(
        ['CP03_2024_062M'],
        'acs/acs5/cprofile',
        2024,
        createMockContext(),
      ),
    ).rejects.toMatchObject({
      data: { reason: 'variable_not_found', missingCodes: ['CP03_2024_062M'] },
    });
  });

  it('keeps synthesized margins out of a comparison-profile search', async () => {
    queue(cprofileVariablesJson);

    const { variables } = await service.searchVariables(
      { query: 'median household income', dataset: 'acs/acs5/cprofile', year: 2024, limit: 50 },
      createMockContext(),
    );

    expect(variables.map((v) => v.code)).toEqual(['CP03_2019_062E', 'CP03_2024_062E']);
    expect(variables.every((v) => v.moeCode === undefined)).toBe(true);
  });
});

/**
 * acs/acs1/spp labels POPGROUP through `POPGROUP_TTL` on the 2012 through 2017 vintages, and
 * through `POPGROUP_LABEL` elsewhere. Without the label column the applied default goes unnamed.
 */
const sppTtlVariablesJson = {
  variables: {
    S0201_001E: {
      label: 'Estimate!!TOTAL NUMBER OF RACES REPORTED!!Total population',
      concept: 'SELECTED POPULATION PROFILE IN THE UNITED STATES',
      predicateType: 'int',
      group: 'S0201',
    },
    POPGROUP: {
      label: 'Race/Ethnic Group',
      required: 'default displayed',
      predicateType: 'string',
      group: 'S0201PR,S0201',
      attributes: 'POPGROUP_TTL',
    },
    ITERATION: {
      label: 'Iteration code',
      predicateType: 'string',
      group: 'S0201',
      attributes: 'ITERATION_TTL',
    },
    GEOCOMP: { label: 'GEO_ID Component', required: 'default displayed', predicateType: 'string' },
  },
};

describe('VariableCacheService — a _TTL label attribute (#52)', () => {
  it('takes POPGROUP_TTL as the label column of a required dimension', async () => {
    queue(sppTtlVariablesJson);

    const check = await service.checkPredicates(
      { dataset: 'acs/acs1/spp', year: 2012, supplied: [] },
      createMockContext(),
    );

    expect(check.unset).toEqual([
      { code: 'POPGROUP', label: 'Race/Ethnic Group', labelAttribute: 'POPGROUP_TTL' },
    ]);
  });

  /**
   * A record dimension is recognized by its label column, and requesting one changes which rows
   * a query returns. `_TTL` is read as a label only where the dataset marks the dimension required.
   */
  it('does not turn a column with a _TTL attribute into a record dimension', async () => {
    queue(sppTtlVariablesJson);

    const dimensions = await service.getRecordDimensions('acs/acs1/spp', 2012, createMockContext());

    expect(dimensions).toEqual([]);
  });
});

describe('VariableCacheService.checkPredicates', () => {
  it('names every required predicate the caller left unset', async () => {
    queue(cbpVariablesJson);

    const check = await service.checkPredicates(
      { dataset: 'cbp', year: 2023, supplied: [] },
      createMockContext(),
    );

    expect(check.unset.map((p) => p.code)).toEqual(['LFO', 'NAICS2017']);
    expect(check.unset.find((p) => p.code === 'NAICS2017')?.label).toBe('2017 NAICS code');
    expect(check.unknown).toEqual([]);
  });

  it('drops a predicate from the unset list once it is supplied', async () => {
    queue(cbpVariablesJson);

    const check = await service.checkPredicates(
      { dataset: 'cbp', year: 2023, supplied: ['NAICS2017'] },
      createMockContext(),
    );

    expect(check.unset.map((p) => p.code)).toEqual(['LFO']);
  });

  it('never reports GEOCOMP — every dataset declares it and its default is the whole geography', async () => {
    queue(cbpVariablesJson);

    const check = await service.checkPredicates(
      { dataset: 'cbp', year: 2023, supplied: [] },
      createMockContext(),
    );

    expect(check.unset.map((p) => p.code)).not.toContain('GEOCOMP');
  });

  it('leaves an ACS query with nothing to report — GEOCOMP is its only required entry', async () => {
    queue(acsVariablesJson);

    const check = await service.checkPredicates(
      { dataset: 'acs/acs5', year: 2024, supplied: [] },
      createMockContext(),
    );

    expect(check.unset).toEqual([]);
  });

  it('reports pep/charv demographic dimensions, which default to an all-persons total', async () => {
    queue(pepVariablesJson);

    const check = await service.checkPredicates(
      { dataset: 'pep/charv', year: 2023, supplied: ['SEX'] },
      createMockContext(),
    );

    expect(check.unset.map((p) => p.code)).toEqual(['AGE']);
  });

  it('flags a supplied key that is not a variable in the dataset', async () => {
    queue(cbpVariablesJson);

    const check = await service.checkPredicates(
      { dataset: 'cbp', year: 2023, supplied: ['NAICS2022', 'BOGUSKEY'] },
      createMockContext(),
    );

    expect(check.unknown).toEqual(['NAICS2022', 'BOGUSKEY']);
  });

  it('accepts a known variable that is not marked required as a predicate', async () => {
    queue(cbpVariablesJson);

    const check = await service.checkPredicates(
      { dataset: 'cbp', year: 2023, supplied: ['ESTAB'] },
      createMockContext(),
    );

    expect(check.unknown).toEqual([]);
  });
});

describe('VariableCacheService — filter dimension metadata', () => {
  it('captures the published value map and the label attribute of a dimension', async () => {
    queue(ddhcaVariablesJson);

    const popgroup = await service.findVariable('POPGROUP', 'dec/ddhca', 2020, createMockContext());

    expect(popgroup?.labelAttribute).toBe('POPGROUP_LABEL');
    expect(popgroup?.values).toEqual({ '001': 'Total population', '1002': 'European alone' });
  });

  /**
   * `attributes` mixes flag columns with the label column, sometimes repeating one. Taking the
   * first entry would request `NAICS2022_F` and echo back a suppression flag instead of a label.
   */
  it('picks the label column out of a mixed attributes list', async () => {
    queue(ecnbasicVariablesJson);

    const naics = await service.findVariable('NAICS2022', 'ecnbasic', 2022, createMockContext());

    expect(naics?.labelAttribute).toBe('NAICS2022_LABEL');
  });

  it('leaves a dimension with no published values undecorated but still labeled', async () => {
    queue(ecnbasicVariablesJson);

    const taxstat = await service.findVariable('TAXSTAT', 'ecnbasic', 2022, createMockContext());

    expect(taxstat?.values).toBeUndefined();
    expect(taxstat?.labelAttribute).toBe('TAXSTAT_LABEL');
  });

  it('returns undefined for a code the dataset does not define', async () => {
    queue(cbpVariablesJson);

    await expect(
      service.findVariable('POPGROUP', 'cbp', 2023, createMockContext()),
    ).resolves.toBeUndefined();
  });

  it('carries the label attribute through to the unset-dimension report', async () => {
    queue(ddhcaVariablesJson);

    const check = await service.checkPredicates(
      { dataset: 'dec/ddhca', year: 2020, supplied: [] },
      createMockContext(),
    );

    expect(check.unset).toEqual([
      { code: 'POPGROUP', label: 'Race/Ethnic Group', labelAttribute: 'POPGROUP_LABEL' },
    ]);
  });

  it('lists the dimensions a dataset filters on, without GEOCOMP', async () => {
    queue(cbpVariablesJson);

    const dimensions = await service.getFilterDimensions('cbp', 2023, createMockContext());

    expect(dimensions.map((d) => d.code)).toEqual(['LFO', 'NAICS2017']);
  });
});

/**
 * A trimmed pep/charv variables.json carrying the two shapes #27 turns on: MONTH is not required
 * and publishes MONTH_DESC, so it labels which record a row is; YEAR is required and publishes no
 * attribute at all, so naming it in `get=` enumerates every vintage instead of echoing one.
 */
const charvRecordVariablesJson = {
  variables: {
    POP: {
      label: 'Population Estimate',
      concept: 'Population Estimates',
      predicateType: 'int',
      group: 'PEP_ALLDATA',
    },
    MEDAGE: {
      label: 'Median Age',
      concept: 'Population Estimates',
      predicateType: 'float',
      group: 'PEP_ALLDATA',
    },
    MONTH: {
      label: 'Vintage Month',
      predicateType: 'string',
      attributes: 'MONTH_DESC',
      group: 'PEP_ALLDATA',
    },
    UNIVERSE: {
      label: 'Universe',
      predicateType: 'string',
      attributes: 'UNIVERSE_DESC',
      group: 'PEP_ALLDATA',
    },
    YEAR: {
      label: 'Vintage Year',
      required: 'default displayed',
      predicateType: 'string',
      group: 'PEP_ALLDATA',
    },
    POPGROUP: {
      label: 'Population Group',
      required: 'default displayed',
      predicateType: 'string',
      attributes: 'POPGROUP_LABEL',
      group: 'PEP_ALLDATA',
    },
    SUMLEVEL: { label: 'Summary Level code', predicateType: 'string', group: 'N/A' },
  },
};

describe('VariableCacheService.getRecordDimensions', () => {
  /**
   * `pep/charv` returns an April estimates-base row and a July estimate row for one geography.
   * MONTH is what separates them; a query that does not request it gets two rows that differ only
   * in the number.
   *
   * The dimensions the dataset marks required are excluded even when they publish a label
   * attribute of their own. Those are not what splits the rows — the API applies one default to
   * them — and naming a required dimension's bare code in `get=` flips it from applying that
   * default to enumerating every category of it, which is thousands of rows for one geography.
   */
  it('finds the column that separates records and leaves the defaulted dimensions alone', async () => {
    queue(charvRecordVariablesJson);

    const dimensions = await service.getRecordDimensions('pep/charv', 2023, createMockContext());

    expect(dimensions).toEqual([
      { code: 'MONTH', label: 'Vintage Month', labelAttribute: 'MONTH_DESC' },
      { code: 'UNIVERSE', label: 'Universe', labelAttribute: 'UNIVERSE_DESC' },
    ]);
  });

  it('finds none on a dataset that returns one row per geography', async () => {
    queue(cbpVariablesJson);

    const dimensions = await service.getRecordDimensions('cbp', 2023, createMockContext());

    expect(dimensions).toEqual([]);
  });
});

describe('VariableCacheService.findPublicationProbes', () => {
  /**
   * A wildcard group-by only reads the data file when a measure is in `get=`, and how many codes
   * come back depends on which table that measure belongs to: on dec/ddhca the total-population
   * table publishes far more population groups than the sex-by-age tables do. The coarsest table
   * gives the widest set, and cell count is what identifies it.
   */
  it('picks one measure, from the coarsest table', async () => {
    queue({
      variables: {
        T01001_001N: { label: 'Total', predicateType: 'int', group: 'T01001' },
        T02001_001N: { label: 'Total', predicateType: 'int', group: 'T02001' },
        T02001_002N: { label: 'Male', predicateType: 'int', group: 'T02001' },
        T02003_001N: { label: 'Total', predicateType: 'int', group: 'T02003' },
        T02003_002N: { label: 'Male', predicateType: 'int', group: 'T02003' },
        T02003_003N: { label: 'Female', predicateType: 'int', group: 'T02003' },
        POPGROUP: {
          label: 'Race/Ethnic Group',
          required: 'default displayed',
          predicateType: 'string',
          group: 'T01001,T02001,T02003',
        },
        SUMLEVEL: { label: 'Summary Level code', predicateType: 'string', group: 'N/A' },
      },
    });

    const probes = await service.findPublicationProbes('dec/ddhca', 2020, createMockContext());

    expect(probes).toEqual(['T01001_001N']);
  });

  /**
   * dec/ddhcb has no table every group sits in: at each geography a group is published in only
   * one household-type table and only one tenure table (api.census.gov, 2026-10-13: T03001 alone
   * publishes 1,497 of the 2,996 groups nationally). The coarsest table would withhold the other
   * half, so the check unions the two tenure tables, the family with the fewest members.
   */
  it('unions the smallest table family on dec/ddhcb, one measure per table', async () => {
    queue({
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
        T03003_002N: { label: '!!Family households:', predicateType: 'int', group: 'T03003' },
        T03004_001N: { label: '!!Total:', predicateType: 'int', group: 'T03004' },
        T03004_002N: { label: '!!Family households:', predicateType: 'int', group: 'T03004' },
        T03004_003N: { label: '!!Married couple family', predicateType: 'int', group: 'T03004' },
        T03004_004N: { label: '!!Other family:', predicateType: 'int', group: 'T03004' },
        T04001_001N: { label: '!!Total', predicateType: 'int', group: 'T04001' },
        T04002_004N: { label: '!!Total:!!Renter occupied', predicateType: 'int', group: 'T04002' },
        T04002_001N: { label: '!!Total:', predicateType: 'int', group: 'T04002' },
        T04002_002N: { label: '!!Owned with a mortgage', predicateType: 'int', group: 'T04002' },
        POPGROUP: {
          label: 'Race/Ethnic Group',
          required: 'default displayed',
          predicateType: 'string',
          group: 'T03002,T03001,T04002,T04001,T03004,T03003',
        },
        GEO_ID: {
          label: 'Geography',
          predicateType: 'string',
          group: 'T03002,T03001,T04002,T04001,T03004,T03003',
        },
        SUMLEVEL: { label: 'Summary Level code', predicateType: 'string', group: 'N/A' },
      },
    });

    const probes = await service.findPublicationProbes('dec/ddhcb', 2020, createMockContext());

    expect(probes).toEqual(['T04001_001N', 'T04002_001N']);
    expect(requestedUrls).toHaveLength(1);
  });

  /**
   * Geography and metadata columns are answerable from the dataset's own dictionary, so naming
   * one leaves the wildcard reporting every declared code as if the dataset published it.
   */
  it('finds no probe when the dataset publishes no measure column', async () => {
    queue({
      variables: {
        SUMLEVEL: { label: 'Summary Level code', predicateType: 'string', group: 'N/A' },
        NAICS2002: {
          label: 'NAICS code',
          required: 'default displayed',
          predicateType: 'string',
          group: 'N/A',
        },
      },
    });

    const probes = await service.findPublicationProbes('nonemp', 2007, createMockContext());

    expect(probes).toEqual([]);
  });
});

describe('describeUnsetPredicates', () => {
  it('names each dimension with its label and says the API supplied the default', () => {
    const text = describeUnsetPredicates(
      [
        { code: 'LFO', label: 'Legal form of organization code' },
        { code: 'NAICS2017', label: '2017 NAICS code' },
      ],
      'cbp',
      2023,
    );

    expect(text).toContain('NAICS2017 (2017 NAICS code)');
    expect(text).toContain('LFO (Legal form of organization code)');
    expect(text).toContain('applied its own default');
    expect(text).toContain('census_list_predicate_values');
  });

  /**
   * The label of the default the API applied is the only thing separating an all-categories
   * total from one arbitrary category, so it has to reach the caller verbatim.
   */
  it('quotes the applied default label for each dimension that echoed one', () => {
    const text = describeUnsetPredicates(
      [{ code: 'POPGROUP', label: 'Race/Ethnic Group', labelAttribute: 'POPGROUP_LABEL' }],
      'dec/ddhca',
      2020,
      { POPGROUP: 'European alone' },
    );

    expect(text).toContain('POPGROUP (Race/Ethnic Group)');
    expect(text).toContain('"European alone"');
    expect(text).toContain('applied_filters');
  });

  /**
   * pep/charv defaults YEAR to one vintage and returns a row per matching combination, but
   * declares no label attribute for it — so two rows come back identical apart from the number.
   * Naming YEAR without saying its default is unreadable leaves it looking like the one
   * dimension nothing was applied to, which is the opposite of the truth.
   */
  it('says so when a dimension publishes no label to echo', () => {
    const text = describeUnsetPredicates(
      [
        { code: 'SEX', label: 'Sex Code', labelAttribute: 'SEX_DESC' },
        { code: 'YEAR', label: 'Vintage Year' },
      ],
      'pep/charv',
      2023,
      { SEX: 'Both Male and Female' },
    );

    expect(text).toContain('SEX (Sex Code) — the API applied "Both Male and Female"');
    expect(text).toContain('YEAR (Vintage Year) — which value the API applied is not visible');
    expect(text).not.toContain('YEAR (Vintage Year) — the API applied');
  });

  /**
   * nonemp vintages before 2012 declare a NAICS dimension with no label attribute at all, so
   * their rows carry no applied_filters — promising the labels are repeated there sends a caller
   * looking for a field that is absent.
   */
  it('promises no per-row echo when no dimension published a label', () => {
    const text = describeUnsetPredicates(
      [{ code: 'NAICS2002', label: 'NAICS Industry Code' }],
      'nonemp',
      2005,
    );

    expect(text).not.toContain('applied_filters');
    expect(text).toContain('publishes no label');
  });

  /**
   * Only some defaults are an all-categories total. `pep/charv` defaults `YEAR` to 2020, so a
   * blanket "this is the total" would misreport it. Several rows for one geography is a separate
   * matter with its own wording — this warning stays about what a default covers.
   */
  it('does not claim the values are a total across every category', () => {
    const text = describeUnsetPredicates(
      [{ code: 'YEAR', label: 'Vintage Year' }],
      'pep/charv',
      2023,
    );

    expect(text).not.toMatch(/total across all categories/);
    expect(text).toContain('one ordinary category on others');
  });

  /**
   * `census_get_variable` resolves the dimension, not its values — pointing a caller there for
   * the code to supply sends them back with the same question they arrived with.
   */
  it('points at the value lookup rather than the variable lookup', () => {
    const text = describeUnsetPredicates([{ code: 'LFO', label: 'Legal form' }], 'cbp', 2023);
    expect(text).toContain('census_list_predicate_values');
    expect(text).not.toContain('census_get_variable');
  });
});

describe('describeEmptyPredicatedResult', () => {
  it('names the unset dimensions as the likely cause of an empty result', () => {
    const text = describeEmptyPredicatedResult(
      [{ code: 'NAICS2022', label: '2022 NAICS code' }],
      [],
      'ecnbasic',
      2022,
      ['ESTAB'],
    );

    expect(text).toContain('until NAICS2022 is set');
    expect(text).toContain('{"NAICS2022": "<code>"}');
  });

  /**
   * An unknown predicate value is a 204, not a 400, so an empty result can come from a value
   * the caller supplied rather than from a dimension it left out.
   */
  it('points at the supplied values too, since a bad one returns nothing rather than erroring', () => {
    const text = describeEmptyPredicatedResult([], ['NAICS2017'], 'cbp', 2023, ['ESTAB']);

    expect(text).toContain('does not exist in cbp (2023)');
    expect(text).toContain('NAICS2017 value');
  });

  it('lists three codes as prose rather than chaining "and"', () => {
    const text = describeEmptyPredicatedResult(
      [
        { code: 'NAICS2022', label: '2022 NAICS code' },
        { code: 'TAXSTAT', label: 'Tax status code' },
        { code: 'TYPOP', label: 'Type of operation code' },
      ],
      [],
      'ecnbasic',
      2022,
      ['ESTAB'],
    );

    expect(text).toContain('NAICS2022, TAXSTAT, and TYPOP are set');
    expect(text).not.toContain('and TAXSTAT and');
  });

  it('returns nothing when the dataset has no predicates in play', () => {
    expect(describeEmptyPredicatedResult([], [], 'acs/acs5', 2024, ['B19013_001E'])).toBe('');
  });

  /**
   * #68: dec/ddhca publishes 1360 (Alaska Native alone) in T02002 at `us`, so a T02003 query for it
   * comes back empty although the value exists. The tables that split the groups lead the hint;
   * the value check stays behind them, since an unknown value also returns nothing.
   */
  it('leads with the sibling tables when a dec/ddhca sex-by-age table came back empty (#68)', () => {
    const text = describeEmptyPredicatedResult([], ['POPGROUP'], 'dec/ddhca', 2020, [
      'T02003_001N',
    ]);

    expect(text).toContain('T02001 or T02002');
    expect(text.indexOf('T02002')).toBeLessThan(text.indexOf('check the POPGROUP value'));
  });

  it('names T03002, T03003, and T03004 for an empty dec/ddhcb T03001 query (#54)', () => {
    const text = describeEmptyPredicatedResult([], ['POPGROUP'], 'dec/ddhcb', 2020, [
      'T03001_001N',
    ]);

    expect(text).toContain('T03002, T03003, or T03004');
    expect(text).not.toContain('T04001');
  });

  /** An unset POPGROUP applies one group, which sits in one table per family like any other. */
  it('names the sibling tables when POPGROUP was left unset too', () => {
    const text = describeEmptyPredicatedResult(
      [{ code: 'POPGROUP', label: 'Race/Ethnic Group', labelAttribute: 'POPGROUP_LABEL' }],
      [],
      'dec/ddhcb',
      2020,
      ['T04002_004N'],
    );

    expect(text).toContain('T04001');
    expect(text).toContain('until POPGROUP is set');
  });

  /** T01001 publishes every group the dataset serves, so nothing about it is split. */
  it('adds no table guidance for dec/ddhca T01001 (characterization)', () => {
    const text = describeEmptyPredicatedResult([], ['POPGROUP'], 'dec/ddhca', 2020, [
      'T01001_001N',
    ]);

    expect(text).toBe(
      'A predicate value that does not exist in dec/ddhca (2020) also returns nothing rather than an error, so check the POPGROUP value this query sent — census_list_predicate_values enumerates the codes each dimension accepts.',
    );
  });
});

describe('describeTableSplit (#54, #68)', () => {
  it('names every table of the family and the ones to look in', () => {
    const text = describeTableSplit(['T03001_001N'], 'dec/ddhcb', false);

    expect(text).toContain('in only one of T03001, T03002, T03003, and T03004');
    expect(text).toContain('missing from T03001');
    expect(text).toContain('T03002, T03003, or T03004');
    expect(text).not.toContain('first-listed');
  });

  it('stays silent on one geography and one group from one table', () => {
    expect(describeTableSplit(['T03004_002N', 'T03004_003N'], 'dec/ddhcb', true)).toBe('');
  });

  /**
   * The Census answers a multi-table query only where the first-listed table publishes the group,
   * and reads the others as null where they do not — `T03001_001N,T04002_004N` for 3910 in WA is
   * 997 and null; the reverse order is HTTP 204.
   */
  it('explains the first-listed table on a request spanning tables, even for one row', () => {
    const text = describeTableSplit(['T03001_001N', 'T04002_004N'], 'dec/ddhcb', true);

    expect(text).toContain('missing from T03001');
    expect(text).toContain('missing from T04002');
    expect(text).toContain('T04001');
    expect(text).toMatch(/first-listed one, T03001/);
    expect(text).toContain('null');
  });

  /** T01001 nests over the sex-by-age tables, so leading with it still leaves T02001 split. */
  it('covers a family table listed after one outside every family', () => {
    const text = describeTableSplit(['T01001_001N', 'T02001_002N'], 'dec/ddhca', true);

    expect(text).toContain('T02002 or T02003');
    expect(text).toMatch(/first-listed one, T01001/);
  });

  it('points at the rest of the family when every table of it was requested', () => {
    const text = describeTableSplit(['T04001_001N', 'T04002_004N'], 'dec/ddhcb', false);

    expect(text).toContain('missing from T04001 or T04002');
    expect(text).toContain('another of them');
  });

  it.each([
    ['dec/ddhca', ['T01001_001N']],
    ['acs/acs5', ['B19013_001E', 'B01003_001E']],
    ['dec/dhc', ['T03001_001N']],
  ])('says nothing on %s %j, which no family splits', (dataset, codes) => {
    expect(describeTableSplit(codes, dataset, false)).toBe('');
  });
});

describe('resolveDataset (#32)', () => {
  /** The error resolveDataset throws for `input`, or undefined when it resolves. */
  const rejectionOf = (input: string | undefined): McpError | undefined => {
    try {
      resolveDataset(input);
      return;
    } catch (e) {
      return e as McpError;
    }
  };

  it.each([...KNOWN_DATASETS])('resolves the registered code %s to itself', (dataset) => {
    expect(resolveDataset(dataset)).toBe(dataset);
  });

  it.each([
    ['acs5', 'acs/acs5'],
    ['ACS5', 'acs/acs5'],
    ['ACS/ACS5', 'acs/acs5'],
    [' acs5 ', 'acs/acs5'],
    [' acs/acs5 ', 'acs/acs5'],
    ['acs1', 'acs/acs1'],
    ['Acs1', 'acs/acs1'],
    ['charv', 'pep/charv'],
    ['pl', 'dec/pl'],
    ['ddhca', 'dec/ddhca'],
    ['ddhcb', 'dec/ddhcb'],
    ['dhc', 'dec/dhc'],
    ['DP', 'dec/dp'],
    ['sdhc', 'dec/sdhc'],
    ['acsse', 'acs/acsse'],
    ['CBP', 'cbp'],
    ['ACS/ACS5/PROFILE', 'acs/acs5/profile'],
  ])('resolves %j to %s', (input, expected) => {
    expect(resolveDataset(input)).toBe(expected);
  });

  it('reads a blank optional dataset as the fallback', () => {
    expect(resolveDataset(undefined, 'acs/acs5')).toBe('acs/acs5');
    expect(resolveDataset('', 'acs/acs5')).toBe('acs/acs5');
    expect(resolveDataset('   ', 'acs/acs5')).toBe('acs/acs5');
  });

  it('rejects a blank required dataset as a missing code, not an unknown one', () => {
    for (const input of [undefined, '', '  ']) {
      const error = rejectionOf(input);

      expect(error?.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error?.data).toMatchObject({ reason: 'dataset_not_found' });
      expect(error?.message).toMatch(/no dataset code/i);
      expect(error?.message).not.toContain('Unknown dataset: ""');
    }
  });

  /** #62: the message says what was wrong, the hint the next step — never both in each. */
  it('states a blank required code in the message and leaves census_list_datasets to the hint', () => {
    const error = rejectionOf('  ');
    const hint = (error?.data as { recovery: { hint: string } } | undefined)?.recovery.hint;

    expect(error?.message).toBe('No dataset code was given.');
    expect(hint).toBe('Call census_list_datasets to discover valid dataset codes like acs/acs5.');
  });

  it('states an unknown code in the message and leaves census_list_datasets to the hint', () => {
    const error = rejectionOf('bogus');
    const hint = (error?.data as { recovery: { hint: string } } | undefined)?.recovery.hint;

    expect(error?.message).toBe('Unknown dataset: "bogus".');
    expect(hint).toBe('Call census_list_datasets to discover valid dataset codes like acs/acs5.');
  });

  /**
   * A third segment is shared: `profile` is the last segment of both acs/acs5/profile and
   * acs/acs1/profile, and `subject` became shared once acs/acs1/subject joined acs/acs5/subject.
   * Resolving one while it is unique would break the input the day a sibling is added.
   */
  it.each([
    ['profile', ['acs/acs5/profile', 'acs/acs1/profile']],
    ['Subject', ['acs/acs5/subject', 'acs/acs1/subject']],
    ['cprofile', ['acs/acs5/cprofile', 'acs/acs1/cprofile']],
    ['spp', ['acs/acs1/spp']],
  ])(
    'never resolves the third segment %j, and its hint names the codes ending in it',
    (input, codes) => {
      const error = rejectionOf(input);
      const hint = (error?.data as { recovery: { hint: string } } | undefined)?.recovery.hint;

      expect(error?.data).toMatchObject({ reason: 'dataset_not_found', dataset: input });
      expect(error?.message).toBe(
        `Unknown dataset: "${input}" is the last segment of a dataset code, not a dataset code of its own.`,
      );
      for (const code of codes) {
        expect(hint).toContain(code);
        expect(error?.message).not.toContain(code);
      }
      expect(hint).toMatch(/^Pass the full code/);
    },
  );

  it.each(['acs', 'dec', 'pep', 'acs5/subject', 'nonemployer-statistics/ns'])(
    'rejects %j as an unknown dataset',
    (input) => {
      expect(() => resolveDataset(input)).toThrow(
        expect.objectContaining({
          code: JsonRpcErrorCode.NotFound,
          data: expect.objectContaining({ reason: 'dataset_not_found', dataset: input }),
        }),
      );
    },
  );

  it('carries the recovery hint that points at census_list_datasets', () => {
    expect(() => resolveDataset('nope/nope')).toThrow(
      expect.objectContaining({
        data: expect.objectContaining({
          recovery: { hint: expect.stringContaining('census_list_datasets') },
        }),
      }),
    );
  });

  /** A second segment two codes shared would make its shorthand ambiguous. */
  it('keeps the second segment of every two-segment code unique', () => {
    const seconds = [...KNOWN_DATASETS]
      .map((code) => code.split('/'))
      .filter((segments) => segments.length === 2)
      .map((segments) => segments[1]);

    expect(new Set(seconds).size).toBe(seconds.length);
  });
});

describe('VariableCacheService.validateDataset', () => {
  it('accepts the business datasets added to the registry', () => {
    for (const dataset of ['cbp', 'ecnbasic', 'nonemp']) {
      expect(() => service.validateDataset(dataset)).not.toThrow();
    }
  });

  it('rejects an unregistered dataset', () => {
    expect(() => service.validateDataset('nonemployer-statistics/ns')).toThrow(/Unknown dataset/);
  });

  it('names the step only in the hint', () => {
    let error: McpError | undefined;
    try {
      service.validateDataset('nonemployer-statistics/ns');
    } catch (err) {
      error = err as McpError;
    }

    expect(error?.message).toBe('Unknown dataset: "nonemployer-statistics/ns".');
    expect((error?.data as { recovery: { hint: string } } | undefined)?.recovery.hint).toBe(
      'Call census_list_datasets to discover valid dataset codes like acs/acs5.',
    );
  });
});

/**
 * A vintage a dataset does not serve used to reach the caller as the raw fetch failure, carrying
 * the first 500 bytes of the Census API's servlet-container error page in `data.body` and
 * `data.responseBody` — several hundred bytes of markup and no statement of what to do instead.
 */
describe('VariableCacheService — a vintage the dataset does not serve', () => {
  it('refuses a year outside the dataset catalog without spending a request', async () => {
    await expect(
      service.getVariablesByCode(['POP'], 'pep/charv', 2021, createMockContext()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'year_not_available', dataset: 'pep/charv', year: 2021 },
    });

    expect(requestedUrls).toEqual([]);
  });

  it('names the years the dataset does serve, collapsing contiguous runs', async () => {
    const error = await service
      .getVariablesByCode(['ESTAB'], 'cbp', 2009, createMockContext())
      .then(
        () => undefined,
        (err: McpError) => err,
      );

    expect(error).toBeDefined();
    // #62: the years are the next step, so they sit in the hint alone.
    expect(error?.message).toBe('cbp cannot be queried for 2009.');
    const data = error?.data as { recovery: { hint: string }; availableYears: number[] };
    expect(data.recovery.hint).toBe('Retry with a year this dataset serves: 2012-2023.');
    expect(data.availableYears).toContain(2012);
  });

  /**
   * The year was checked against the catalog before the request went out, so a 404 on a year the
   * catalog lists means the catalog has drifted from the API. Answering "no such vintage" while
   * naming that same vintage under available_years is a loop, not a recovery.
   */
  it('does not call a catalogued year unavailable when the API 404s it', async () => {
    queue(new Response(TOMCAT_404, { status: 404, headers: { 'content-type': 'text/html' } }));

    const error = await service
      .getVariablesByCode(['B19013_001E'], 'acs/acs5', 2024, createMockContext())
      .then(
        () => undefined,
        (err: McpError) => err,
      );

    expect(error?.data).toMatchObject({ reason: 'upstream_error', year: 2024, status: 404 });
    expect(error?.data).not.toMatchObject({ reason: 'year_not_available' });
    expect(error?.message).toContain('acs/acs5 (2024)');
    // The servlet error page never reaches the caller, at any status.
    expect(JSON.stringify(error?.data)).not.toContain('HTTP Status 404');
    expect(error?.data).not.toHaveProperty('body');
    expect(error?.data).not.toHaveProperty('responseBody');
    expect(error?.message).not.toContain('<');
  });

  it('strips the upstream error page from a status that is not a 404 as well', async () => {
    queue(
      new Response('<!doctype html><html><body>HTTP Status 400 – Bad Request</body></html>', {
        status: 400,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const error = await service
      .getVariablesByCode(['B19013_001E'], 'acs/acs5', 2024, createMockContext())
      .then(
        () => undefined,
        (err: McpError) => err,
      );

    expect(error?.data).toMatchObject({
      reason: 'upstream_error',
      dataset: 'acs/acs5',
      year: 2024,
    });
    expect(JSON.stringify(error?.data)).not.toContain('HTTP Status 400');
    expect(error?.data).not.toHaveProperty('body');
    expect(error?.data).not.toHaveProperty('upstreamMessage');
    expect(error?.message).toContain('acs/acs5 (2024)');
  });

  /**
   * The Census API states a rejected query's cause in one line of plain text and nowhere else.
   * Dropping it alongside the markup left the caller with a bare status and a maintainer with
   * only the log line.
   */
  it("carries the Census API's own one-line rejection through to the caller", async () => {
    queue(
      new Response("error: unknown variable 'NAME'", {
        status: 400,
        headers: { 'content-type': 'text/plain' },
      }),
    );

    const error = await service
      .getVariablesByCode(['B19013_001E'], 'acs/acs5', 2024, createMockContext())
      .then(
        () => undefined,
        (err: McpError) => err,
      );

    expect(error?.message).toContain("error: unknown variable 'NAME'");
    expect(error?.data).toMatchObject({ upstreamMessage: "error: unknown variable 'NAME'" });
    const data = error?.data as { recovery: { hint: string } };
    // A 400 is deterministic, so the hint must not send the caller back for another attempt.
    // #62: the upstream line is the diagnosis, so it stays in the message and out of the hint.
    expect(data.recovery.hint).toBe(
      'Change the query — the Census API rejected it rather than failing transiently, so retrying it unchanged returns the same status.',
    );
  });
});

/** Exercised directly: the retry path's own backoff makes a 5xx too slow to stage as a fetch. */
describe('censusHttpError', () => {
  const fetchFailure = (status: number, body: string) =>
    new McpErrorClass(
      httpStatusToErrorCode(status) ?? JsonRpcErrorCode.InternalError,
      `Fetch failed. Status: ${status}`,
      { status, statusCode: status, body, responseBody: body, errorSource: 'FetchHttpError' },
    );

  it('tells a caller to retry a status that is transient', () => {
    const error = censusHttpError(fetchFailure(503, 'upstream unavailable'), {
      dataset: 'acs/acs5',
      year: 2024,
      availableYears: DATASET_AVAILABLE_YEARS['acs/acs5'],
    }) as McpError;

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((error.data as { recovery: { hint: string } }).recovery.hint).toBe(
      'Retry the request; if it persists, the Census API is temporarily unavailable for this dataset and year.',
    );
    expect(error.message).toBe(
      'Census API returned HTTP 503 for acs/acs5 (2024). Upstream: upstream unavailable',
    );
  });

  it('leaves a timeout or network failure for its own handling', () => {
    const aborted = new McpErrorClass(JsonRpcErrorCode.Timeout, 'timed out', {
      errorSource: 'FetchTimeout',
    });

    expect(censusHttpError(aborted, { dataset: 'acs/acs5', year: 2024 })).toBe(aborted);
  });

  it('answers a year outside the catalog with year_not_available', () => {
    const error = censusHttpError(fetchFailure(404, TOMCAT_404), {
      dataset: 'pep/charv',
      year: 2021,
      availableYears: DATASET_AVAILABLE_YEARS['pep/charv'],
    }) as McpError;

    expect(error.data).toMatchObject({ reason: 'year_not_available', year: 2021 });
    expect(JSON.stringify(error.data)).not.toContain('HTTP Status 404');
  });
});

/**
 * `KNOWN_DATASETS` and `DATASET_LATEST_YEARS` derive from `DATASET_AVAILABLE_YEARS` rather than
 * standing as their own literals. A wrong maximum would silently redirect every query that omits
 * `year` to a different vintage, so the defaults are pinned rather than recomputed by the test.
 */
describe('dataset registries derived from DATASET_AVAILABLE_YEARS', () => {
  it('defaults each dataset to the same vintage it always has', () => {
    expect(DATASET_LATEST_YEARS).toEqual({
      'acs/acs5': 2024,
      'acs/acs5/profile': 2024,
      'acs/acs5/subject': 2024,
      'acs/acs1': 2024,
      'acs/acs1/profile': 2024,
      'acs/acs1/subject': 2024,
      'acs/acs5/cprofile': 2024,
      'acs/acs1/cprofile': 2024,
      'acs/acsse': 2024,
      'acs/acs1/spp': 2024,
      'pep/charv': 2023,
      'dec/pl': 2020,
      'dec/dhc': 2020,
      'dec/dp': 2020,
      'dec/sdhc': 2020,
      'dec/ddhca': 2020,
      'dec/ddhcb': 2020,
      cbp: 2023,
      ecnbasic: 2022,
      nonemp: 2023,
    });
  });

  /**
   * Checked against api.census.gov/data.json. `acs/acs1/spp` 2008 and 2010 are published but left
   * out: the Census answers HTTP 500 to `POPGROUP_LABEL` on 2008 and to every `us` query on 2010.
   */
  it.each([
    ['dec/dhc', [2020]],
    ['dec/dp', [2020]],
    ['dec/sdhc', [2020]],
    ['dec/ddhcb', [2020]],
    [
      'acs/acs1/subject',
      [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024],
    ],
    ['acs/acs5/cprofile', [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024]],
    [
      'acs/acs1/cprofile',
      [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024],
    ],
    ['acs/acsse', [2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024]],
    [
      'acs/acs1/spp',
      [2009, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024],
    ],
  ])('serves %s for the vintages it can be queried for (#43, #52)', (dataset, years) => {
    expect(DATASET_AVAILABLE_YEARS[dataset]).toEqual(years);
  });

  it('refuses the unreleased 2020 ACS1 subject tables before any request (#43)', async () => {
    await expect(
      service.searchVariables(
        { query: 'poverty', dataset: 'acs/acs1/subject', year: 2020, limit: 5 },
        createMockContext(),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'year_not_available', dataset: 'acs/acs1/subject', year: 2020 },
    });
    expect(requestedUrls).toEqual([]);
  });

  it('registers exactly the datasets the vintage table covers', () => {
    expect([...KNOWN_DATASETS].sort()).toEqual(Object.keys(DATASET_AVAILABLE_YEARS).sort());
  });

  /**
   * The Census API publishes these; a year the table omits is refused before the network, so an
   * omission here is a hard failure for a query that used to work rather than a missing hint.
   */
  it('serves the earliest vintage the Census API publishes for each ACS dataset', () => {
    expect(DATASET_AVAILABLE_YEARS['acs/acs5']?.[0]).toBe(2009);
    expect(DATASET_AVAILABLE_YEARS['acs/acs5/profile']?.[0]).toBe(2009);
    expect(DATASET_AVAILABLE_YEARS['acs/acs5/subject']?.[0]).toBe(2010);
    expect(DATASET_AVAILABLE_YEARS['acs/acs1']?.[0]).toBe(2005);
    expect(DATASET_AVAILABLE_YEARS['acs/acs1/profile']?.[0]).toBe(2005);
  });

  /** 2020 ACS1 was not released, and both ACS1 datasets follow the same release calendar. */
  it('omits the ACS1 vintage the Census never released', () => {
    expect(DATASET_AVAILABLE_YEARS['acs/acs1']).not.toContain(2020);
    expect(DATASET_AVAILABLE_YEARS['acs/acs1/profile']).not.toContain(2020);
  });
});

describe('VariableCacheService caching', () => {
  it('serves a repeat dataset+year from cache instead of refetching', async () => {
    queue(acsVariablesJson);
    const ctx = createMockContext();

    await service.getVariablesByCode(['B19013_001E'], 'acs/acs5', 2024, ctx);
    await service.getVariablesByCode(['B19013_001E'], 'acs/acs5', 2024, ctx);

    expect(requestedUrls).toHaveLength(1);
  });

  it('fetches separately per dataset', async () => {
    queue(acsVariablesJson, cbpVariablesJson);
    const ctx = createMockContext();

    await service.getVariablesByCode(['B19013_001E'], 'acs/acs5', 2024, ctx);
    await service.getVariablesByCode(['ESTAB'], 'cbp', 2023, ctx);

    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls[1]).toContain('/2023/cbp/variables.json');
  });
});

describe('VariableCacheService accessor', () => {
  it('throws until initVariableCacheService has run', async () => {
    vi.resetModules();
    const mod = await import('@/services/variable-cache/variable-cache-service.js');
    expect(() => mod.getVariableCacheService()).toThrow(/not initialized/);
    mod.initVariableCacheService();
    expect(mod.getVariableCacheService()).toBeInstanceOf(mod.VariableCacheService);
  });

  it('returns the initialized singleton', () => {
    initVariableCacheService();
    expect(getVariableCacheService()).toBeInstanceOf(VariableCacheService);
  });
});

/**
 * A trimmed ecnbasic 2022 variables.json. Each measure names its `_F` flag column in
 * `attributes`; `GEO_ID_F` is a flag too ("Geo Footnote"), but on a text column that holds no
 * measure, and `NAICS2022_F` flags a dimension rather than a value.
 */
const ecnbasicFlagsVariablesJson = {
  variables: {
    ESTAB: { label: 'Number of establishments', predicateType: 'int', attributes: 'ESTAB_F' },
    RCPTOT: {
      label: 'Sales, value of shipments, or revenue ($1,000)',
      predicateType: 'int',
      attributes: 'RCPTOT_F',
    },
    EMP: { label: 'Number of employees', predicateType: 'int', attributes: 'EMP_F' },
    GEO_ID: {
      label: 'Geographic identifier code',
      predicateType: 'string',
      attributes: 'GEO_ID_F,NAME',
    },
    NAICS2022: {
      label: '2022 NAICS code',
      required: 'default displayed',
      predicateType: 'string',
      attributes: 'NAICS2022_F,NAICS2022_LABEL,NAICS2022_F',
    },
  },
};

describe('VariableCacheService.lookupVariables', () => {
  it('names the flag column of each measure that publishes one', async () => {
    queue(ecnbasicFlagsVariablesJson);

    const found = await service.lookupVariables(
      ['RCPTOT', 'EMP', 'GEO_ID', 'NAICS2022'],
      'ecnbasic',
      2022,
      createMockContext(),
    );

    expect(found.get('RCPTOT')?.flagAttribute).toBe('RCPTOT_F');
    expect(found.get('EMP')?.flagAttribute).toBe('EMP_F');
    // A footnote on a text column and a flag on a dimension carry no withheld value.
    expect(found.get('GEO_ID')?.flagAttribute).toBeUndefined();
    expect(found.get('NAICS2022')?.flagAttribute).toBeUndefined();
    expect(found.get('NAICS2022')?.labelAttribute).toBe('NAICS2022_LABEL');
  });

  /** `nonemp` 1997–2007 publish the flag as a variable of its own rather than an attribute. */
  it('finds a flag published as a standalone variable', async () => {
    queue({
      variables: {
        NESTAB: { label: 'Total number of Establishments', predicateType: 'int' },
        NESTAB_F: { label: 'Flag for Number of establishments', predicateType: 'string' },
        NRCPTOT: { label: 'Total Receipts (in thousands of dollars)', predicateType: 'int' },
      },
    });

    const found = await service.lookupVariables(
      ['NESTAB', 'NRCPTOT'],
      'nonemp',
      2005,
      createMockContext(),
    );

    expect(found.get('NESTAB')?.flagAttribute).toBe('NESTAB_F');
    expect(found.get('NRCPTOT')?.flagAttribute).toBeUndefined();
  });

  /**
   * `variables.json` lists annotation columns only inside `attributes`, so `B19013_001EA` has no
   * entry of its own. A lookup that failed as a whole on it cost `B19013_001E` its label too.
   */
  it('resolves each code on its own and leaves out only the ones with no entry', async () => {
    queue(acsVariablesJson);

    const found = await service.lookupVariables(
      ['B19013_001E', 'B19013_001EA', 'B19013_001M'],
      'acs/acs5',
      2024,
      createMockContext(),
    );

    expect(found.get('B19013_001E')?.label).toBe(
      'Estimate!!Median household income in the past 12 months',
    );
    expect(found.get('B19013_001M')?.label).toContain('Margin of Error');
    expect(found.has('B19013_001EA')).toBe(false);
  });
});

/**
 * A `*` predicate splits one geography into a row per category — 1,552 on `cbp` `NAICS2017` for
 * one county. The notices name the values a caller pins with, and a list of all of them would be
 * longer than the data.
 */
describe('record-row notices over a wildcarded dimension', () => {
  const naics = Array.from({ length: 1552 }, (_, i) => ({
    code: String(1000 + i),
    label: `Industry ${i}`,
  }));

  it('describeRecordRows names the dimension and a bounded sample of its values', () => {
    const text = describeRecordRows('cbp', 2023, 1552, { NAICS2017: naics });

    expect(text).toContain('NAICS2017');
    expect(text).toContain('"1000" (Industry 0)');
    expect(text).toContain('1,542 more');
    expect(text).not.toContain('"2551"');
    expect(text.length).toBeLessThan(1500);
  });

  it('describeAmbiguousRows names the dimension to pin the same way', () => {
    const text = describeAmbiguousRows({ NAICS2017: naics });

    expect(text).toContain('NAICS2017');
    expect(text).toContain('1,542 more');
    expect(text.length).toBeLessThan(1500);
    // #62: the row count is the paired message's diagnosis, so the hint opens on the pin.
    expect(text).toMatch(
      /^Add the record you want to predicates, e\.g\. \{"NAICS2017": "1009"\} — /,
    );
  });

  it('describeAmbiguousRows keeps only the steps when nothing in the response separates the rows', () => {
    expect(describeAmbiguousRows({})).toBe(
      "Set the dataset's filter dimensions explicitly in predicates — census_list_predicate_values enumerates the codes each one accepts — or query one geography at a time with census_query_data.",
    );
  });

  it('lists every value when there are only a few', () => {
    const text = describeRecordRows('pep/charv', 2023, 2, {
      MONTH: [
        { code: '4', label: 'April' },
        { code: '7', label: 'July' },
      ],
    });

    expect(text).toContain('"4" (April) and "7" (July)');
    expect(text).not.toContain('more');
    expect(text).toContain('pick the record you want rather than the first row');
  });

  /**
   * A `"*"` predicate is a breakdown the caller asked for, not a split the dataset imposed, so
   * the notice says the rows are its categories rather than telling the caller to pick one.
   */
  it('describeRecordRows words a wildcarded dimension as the breakdown predicates asked for', () => {
    const text = describeRecordRows('cbp', 2023, 1552, { NAICS2017: naics }, ['NAICS2017']);

    expect(text).toContain('one row per category of NAICS2017');
    expect(text).toContain('predicates set it to "*"');
    expect(text).toContain('"1000" (Industry 0)');
    expect(text).toContain('1,542 more');
    expect(text).not.toContain('pick the record you want rather than the first row');
  });

  /**
   * Every other count in the notices is grouped ("1,542 more"), so the row count is too. The
   * ambiguous-rows count lives in census_compare_geographies' message, whose test pins it there.
   */
  it('groups the thousands of a per-geography row count', () => {
    const split = { NAICS2017: naics };
    for (const text of [
      describeRecordRows('cbp', 2023, 1552, split, ['NAICS2017']),
      describeRecordRows('cbp', 2023, 1552, split),
      describeRecordRows('cbp', 2023, 1552, {}),
    ]) {
      expect(text).toContain('1,552 rows');
      expect(text).not.toContain('1552');
    }
  });

  it('describeRecordRows words a wildcard and a record split each their own way', () => {
    const text = describeRecordRows(
      'pep/charv',
      2023,
      4,
      {
        MONTH: [
          { code: '4', label: 'April' },
          { code: '7', label: 'July' },
        ],
        SEX: [
          { code: '1', label: 'Male' },
          { code: '2', label: 'Female' },
        ],
      },
      ['SEX'],
    );

    expect(text).toContain('one row per category of SEX');
    expect(text).toContain('MONTH separates them');
    expect(text).toContain('{"MONTH": "7"}');
  });
});

/** A route that answers each request itself — a hang, a rejection, or a different answer per call. */
type RouteFn = (init?: RequestInit) => Promise<Response>;

/** Rejects with the signal's reason once it aborts, as fetch does; never answers otherwise. */
const hang: RouteFn = (init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

/**
 * Serve bodies by URL path, recording each request, for the lookups that reach more than one
 * endpoint per dataset. A path with no route fails the request, so an unexpected fetch surfaces.
 */
const serve = (routes: Record<string, unknown>) => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string | URL, init?: RequestInit) => {
      const href = String(url);
      requestedUrls.push(href);
      const body = routes[new URL(href).pathname];
      if (body === undefined) return Promise.reject(new Error(`unrouted fetch: ${href}`));
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
};

const requestsTo = (suffix: string) => requestedUrls.filter((url) => url.endsWith(suffix));

/**
 * A slice of acs/acs5 2024. Listing order matters: the rows a query should not rank first come
 * before the ones it should, so a sort that falls back to variables.json order fails here.
 */
const acsSearchVariablesJson = {
  variables: {
    GEO_ID: {
      label: 'Geography',
      concept:
        'Poverty Status in the Past 12 Months by Sex by Age;Housing Unit Coverage Rate;Median Household Income in the Past 12 Months (in 2024 Inflation-Adjusted Dollars);Travel Time to Work',
      predicateType: 'string',
      group: 'B17001,B98011,B19013,B08303',
      attributes: 'NAME',
    },
    B22008_001E: {
      label:
        'Estimate!!Median household income in the past 12 months (in 2024 inflation-adjusted dollars)--!!Total:',
      concept:
        'Median Household Income in the Past 12 Months (in 2024 Inflation-Adjusted Dollars) by Receipt of Food Stamps/SNAP in the Past 12 Months',
      predicateType: 'int',
      group: 'B22008',
      attributes: 'B22008_001EA,B22008_001M,B22008_001MA',
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
    B19301_001E: {
      label:
        'Estimate!!Per capita income in the past 12 months (in 2024 inflation-adjusted dollars)',
      concept: 'Per Capita Income in the Past 12 Months (in 2024 Inflation-Adjusted Dollars)',
      predicateType: 'int',
      group: 'B19301',
      attributes: 'B19301_001EA,B19301_001M,B19301_001MA',
    },
    B12001_004E: {
      label: 'Estimate!!Total:!!Male:!!Now married:!!Separated',
      concept: 'Sex by Marital Status for the Population 15 Years and Over',
      predicateType: 'int',
      group: 'B12001',
      attributes: 'B12001_004EA,B12001_004M,B12001_004MA',
    },
    B98011_001E: {
      label: 'Estimate!!Total',
      concept: 'Housing Unit Coverage Rate',
      predicateType: 'int',
      group: 'B98011',
      attributes: 'B98011_001EA,B98011_001M,B98011_001MA',
    },
    B17001_002E: {
      label: 'Estimate!!Total:!!Income in the past 12 months below poverty level:',
      concept: 'Poverty Status in the Past 12 Months by Sex by Age',
      predicateType: 'int',
      group: 'B17001',
      attributes: 'B17001_002EA,B17001_002M,B17001_002MA',
    },
    B08134_001E: {
      label: 'Estimate!!Total:',
      concept: 'Means of Transportation to Work by Travel Time to Work',
      predicateType: 'int',
      group: 'B08134',
      attributes: 'B08134_001EA,B08134_001M,B08134_001MA',
    },
    B08303_002E: {
      label: 'Estimate!!Total:!!Less than 5 minutes',
      concept: 'Travel Time to Work',
      predicateType: 'int',
      group: 'B08303',
      attributes: 'B08303_002EA,B08303_002M,B08303_002MA',
    },
    B08303_001E: {
      label: 'Estimate!!Total:',
      concept: 'Travel Time to Work',
      predicateType: 'int',
      group: 'B08303',
      attributes: 'B08303_001EA,B08303_001M,B08303_001MA',
    },
    B08103_007E: {
      label: 'Estimate!!Median age --!!Total:!!Worked from home',
      concept: 'Median Age by Means of Transportation to Work',
      predicateType: 'float',
      group: 'B08103',
      attributes: 'B08103_007EA,B08103_007M,B08103_007MA',
    },
    B25077_001E: {
      label: 'Estimate!!Median value (dollars)',
      concept: 'Median Value (Dollars)',
      predicateType: 'int',
      group: 'B25077',
      attributes: 'B25077_001EA,B25077_001M,B25077_001MA',
    },
    NAME: { label: 'Geographic Area Name', predicateType: 'string', group: 'N/A' },
  },
};

const acs = (query: string, limit = 50) =>
  service.searchVariables({ query, dataset: 'acs/acs5', year: 2024, limit }, createMockContext());

const codesFor = async (query: string, limit = 50) =>
  (await acs(query, limit)).variables.map((v) => v.code);

describe('VariableCacheService.searchVariables — whole-word, all-terms ranking (#34)', () => {
  beforeEach(() => serve({ '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson }));

  it('ranks the base variable ahead of its subgroup variants and other tables', async () => {
    const result = await acs('median household income');

    expect(result.variables[0]?.code).toBe('B19013_001E');
    expect(result.variables.map((v) => v.code)).toEqual([
      'B19013_001E',
      'B19013_001M',
      'B19013B_001E',
      'B19013B_001M',
      'B22008_001E',
      'B22008_001M',
    ]);
  });

  it('counts only the variables that contain every term', async () => {
    const result = await acs('median household income');

    // B19301 carries "income" alone; the any-term scoring counted it and every other income row.
    expect(result.variables.map((v) => v.code)).not.toContain('B19301_001E');
    expect(result.totalMatches).toBe(6);
    expect(result.matchedTermCount).toBe(3);
    expect(result.termCount).toBe(3);
  });

  it('requires the subgroup term, so the base variable drops out', async () => {
    const codes = await codesFor('median household income black');

    expect(codes[0]).toBe('B19013B_001E');
    expect(codes).not.toContain('B19013_001E');
  });

  it('puts a concept that equals the query ahead of a concept that only contains it', async () => {
    const codes = await codesFor('travel time to work');

    expect(codes.slice(0, 4)).toEqual(['B08303_001E', 'B08303_001M', 'B08303_002E', 'B08303_002M']);
    expect(codes.indexOf('B08134_001E')).toBeGreaterThan(codes.indexOf('B08303_002E'));
  });

  it('matches whole words, so "rate" misses the inside of "Separated"', async () => {
    const codes = await codesFor('rate');

    expect(codes).toContain('B98011_001E');
    expect(codes).not.toContain('B12001_004E');
  });

  it('sorts a tied estimate ahead of its margin of error', async () => {
    const codes = await codesFor('coverage rate');

    expect(codes).toEqual(['B98011_001E', 'B98011_001M']);
  });

  /**
   * A margin's published label opens with "Margin of Error!!", three words its estimate's label
   * lacks. Matched on them, "median value of" gives the margin one more word than its estimate and
   * puts it alone in the first tier, the way the old "Estimate!!" label did for "estimate" queries.
   */
  it('matches a margin of error on the words its estimate matches (#58)', async () => {
    const result = await acs('median value of');

    expect(result.variables.map((v) => v.code).slice(0, 2)).toEqual(['B25077_001E', 'B25077_001M']);
    expect(result.matchedTermCount).toBe(2);
  });

  it('falls back to the variables with the most terms when none has every one', async () => {
    const result = await acs('median home value');

    expect(result.variables[0]?.code).toBe('B25077_001E');
    expect(result.matchedTermCount).toBe(2);
    expect(result.termCount).toBe(3);
    // Two-term rows only: B25077 (median, value) and B08103 (median, home), each with its MOE.
    expect(result.totalMatches).toBe(4);
    expect(result.variables.map((v) => v.code)).not.toContain('B19013_001E');
  });

  it('reads case and punctuation out of the query the way it reads them out of labels', async () => {
    expect(await codesFor('Median, Household-INCOME')).toEqual(
      await codesFor('median household income'),
    );
  });

  it('counts a repeated query word once', async () => {
    const result = await acs('income income median household');

    expect(result.termCount).toBe(3);
    expect(result.variables[0]?.code).toBe('B19013_001E');
  });

  it('returns nothing for a query with no letters or digits', async () => {
    for (const query of ['', '   ', '!!--!!']) {
      const result = await acs(query);
      expect(result).toEqual({
        variables: [],
        totalMatches: 0,
        codeMatches: 0,
        matchedTermCount: 0,
        termCount: 0,
      });
    }
  });

  it('returns nothing, with no fallback, when no variable holds any term', async () => {
    const result = await acs('xyzzy');

    expect(result.variables).toEqual([]);
    expect(result.totalMatches).toBe(0);
    expect(result.matchedTermCount).toBe(0);
    expect(result.termCount).toBe(1);
  });

  it('cuts the ranked list at the limit and still counts every match', async () => {
    const result = await acs('median household income', 1);

    expect(result.variables.map((v) => v.code)).toEqual(['B19013_001E']);
    expect(result.totalMatches).toBe(6);
  });
});

describe('VariableCacheService.searchVariables — table totals and exact rows (#34)', () => {
  it('ranks a subject-table total ahead of its breakdown rows', async () => {
    serve({
      '/data/2024/acs/acs5/subject/variables.json': {
        variables: {
          S1701_C03_002E: {
            label:
              'Estimate!!Percent below poverty level!!Population for whom poverty status is determined!!AGE!!Under 18 years',
            concept: 'Poverty Status in the Past 12 Months',
            predicateType: 'float',
            group: 'S1701',
          },
          S1701_C02_001E: {
            label:
              'Estimate!!Below poverty level!!Population for whom poverty status is determined',
            concept: 'Poverty Status in the Past 12 Months',
            predicateType: 'int',
            group: 'S1701',
          },
          S1701_C03_001E: {
            label:
              'Estimate!!Percent below poverty level!!Population for whom poverty status is determined',
            concept: 'Poverty Status in the Past 12 Months',
            predicateType: 'float',
            group: 'S1701',
          },
        },
      },
    });

    const { variables } = await service.searchVariables(
      { query: 'percent below poverty level', dataset: 'acs/acs5/subject', year: 2024, limit: 10 },
      createMockContext(),
    );

    expect(variables.map((v) => v.code).filter((c) => c.endsWith('E'))).toEqual([
      'S1701_C03_001E',
      'S1701_C03_002E',
    ]);
  });

  it('ranks the row whose last label segment is the query first', async () => {
    serve({
      '/data/2020/dec/pl/variables.json': {
        variables: {
          P2_003N: {
            label: ' !!Total:!!Not Hispanic or Latino:',
            concept: 'HISPANIC OR LATINO, AND NOT HISPANIC OR LATINO BY RACE',
            predicateType: 'int',
            group: 'P2',
          },
          P2_001N: {
            label: ' !!Total:',
            concept: 'HISPANIC OR LATINO, AND NOT HISPANIC OR LATINO BY RACE',
            predicateType: 'int',
            group: 'P2',
          },
          P2_002N: {
            label: ' !!Total:!!Hispanic or Latino',
            concept: 'HISPANIC OR LATINO, AND NOT HISPANIC OR LATINO BY RACE',
            predicateType: 'int',
            group: 'P2',
          },
        },
      },
    });

    const { variables } = await service.searchVariables(
      { query: 'hispanic or latino', dataset: 'dec/pl', year: 2020, limit: 10 },
      createMockContext(),
    );

    expect(variables.map((v) => v.code)).toEqual(['P2_002N', 'P2_003N', 'P2_001N']);
  });
});

/** A slice of ecnbasic 2022, where every measure is shared across the 20 sector tables. */
const ecnbasicSharedVariablesJson = {
  variables: {
    EMP: {
      label: 'Number of employees',
      concept:
        'Accommodation and Food Services: Summary Statistics for the U.S., States, and Selected Geographies: 2022;Retail Trade: Summary Statistics for the U.S., States, and Selected Geographies: 2022',
      predicateType: 'int',
      group: 'EC2272BASIC,EC2244BASIC',
      attributes: 'EMP_F',
    },
    RCPTOT: {
      label: 'Sales, value of shipments, or revenue ($1,000)',
      concept:
        'Accommodation and Food Services: Summary Statistics for the U.S., States, and Selected Geographies: 2022;Retail Trade: Summary Statistics for the U.S., States, and Selected Geographies: 2022',
      predicateType: 'int',
      group: 'EC2272BASIC,EC2244BASIC',
      attributes: 'RCPTOT_F',
    },
  },
};

describe('VariableCacheService — columns shared across tables (#33)', () => {
  it('keeps a shared column out of a search its joined concept would match', async () => {
    serve({ '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson });

    expect(await codesFor('poverty rate')).not.toContain('GEO_ID');
    expect(await codesFor('travel time to work')).not.toContain('GEO_ID');
  });

  it('still finds a shared column by its label', async () => {
    serve({ '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson });

    const result = await acs('geography');

    expect(result.variables[0]?.code).toBe('GEO_ID');
    expect(result.variables[0]?.concept).toBeUndefined();
  });

  it('finds an ecnbasic measure by label and never by its joined concept', async () => {
    serve({ '/data/2022/ecnbasic/variables.json': ecnbasicSharedVariablesJson });
    const search = (query: string) =>
      service.searchVariables(
        { query, dataset: 'ecnbasic', year: 2022, limit: 10 },
        createMockContext(),
      );

    const revenue = await search('revenue');
    expect(revenue.variables.map((v) => v.code)).toEqual(['RCPTOT']);
    expect(revenue.variables[0]?.concept).toBeUndefined();

    expect((await search('summary statistics')).variables).toEqual([]);
  });

  it('drops the concept of a shared column and keeps a single-table concept verbatim', async () => {
    serve({
      '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson,
      '/data/2024/acs/acs5/groups.json': { groups: [] },
    });

    const [geoId, income, moe] = await service.getVariablesByCode(
      ['GEO_ID', 'B19013_001E', 'B19013_001M'],
      'acs/acs5',
      2024,
      createMockContext(),
    );

    expect(geoId?.code).toBe('GEO_ID');
    expect(geoId).not.toHaveProperty('concept');
    expect(income?.concept).toBe(
      'Median Household Income in the Past 12 Months (in 2024 Inflation-Adjusted Dollars)',
    );
    expect(moe?.concept).toBe(income?.concept);
  });
});

describe('VariableCacheService — annotation and flag columns (#48)', () => {
  const acsRoutes = {
    '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson,
    '/data/2024/acs/acs5/groups.json': { groups: [] },
    '/data/2024/acs/acs5/variables/B19013_001EA.json': {
      name: 'B19013_001EA',
      label:
        'Annotation of Estimate!!Median household income in the past 12 months (in 2024 inflation-adjusted dollars)',
      concept: 'Median Household Income in the Past 12 Months (in 2024 Inflation-Adjusted Dollars)',
      predicateType: 'string',
      group: 'B19013',
      limit: 0,
      'attribute of': 'B19013_001E',
      'attribute type': 'ANNOTATION',
    },
    '/data/2024/acs/acs5/variables/B19013_001MA.json': {
      name: 'B19013_001MA',
      label:
        'Annotation of Margin of Error!!Median household income in the past 12 months (in 2024 inflation-adjusted dollars)',
      concept: 'Median Household Income in the Past 12 Months (in 2024 Inflation-Adjusted Dollars)',
      predicateType: 'string',
      group: 'B19013',
      limit: 0,
      'attribute of': 'B19013_001M',
      'attribute type': 'ANNOTATION',
    },
  };

  const cbpRoutes = {
    '/data/2023/cbp/variables.json': {
      variables: {
        EMP: {
          label: 'Number of employees',
          concept: 'All Sectors: County Business Patterns',
          predicateType: 'int',
          group: 'CB2300CBP',
          attributes: 'EMP_F',
        },
        NAICS2017: {
          label: '2017 NAICS code',
          concept: 'All Sectors: County Business Patterns',
          predicateType: 'string',
          group: 'CB2300CBP',
          required: 'default displayed',
          attributes: 'NAICS2017_F,NAICS2017_LABEL,NAICS2017_F',
        },
      },
    },
    '/data/2023/cbp/groups.json': {
      groups: [{ name: 'CB2300CBP', description: 'All Sectors: County Business Patterns' }],
    },
    '/data/2023/cbp/variables/EMP_F.json': {
      name: 'EMP_F',
      label: 'Flag for number of employees',
      concept: 'All Sectors: County Business Patterns',
      predicateType: 'string',
      group: 'CB2300CBP',
      limit: 0,
      'attribute of': 'EMP',
      'attribute type': 'FLAG',
    },
    '/data/2023/cbp/variables/NAICS2017_F.json': {
      name: 'NAICS2017_F',
      label: '2017 NAICS Footnote',
      concept: 'All Sectors: County Business Patterns',
      predicateType: 'string',
      group: 'CB2300CBP',
      limit: 0,
      'attribute of': 'NAICS2017_LABEL',
      'attribute type': 'FLAG',
    },
  };

  const lookup = (codes: string[], dataset = 'acs/acs5', year = 2024) =>
    service.getVariablesByCode(codes, dataset, year, createMockContext());

  it('resolves an estimate annotation from the per-variable endpoint', async () => {
    serve(acsRoutes);

    const [annotation] = await lookup(['B19013_001EA']);

    expect(annotation).toMatchObject({
      code: 'B19013_001EA',
      label:
        'Annotation of Estimate!!Median household income in the past 12 months (in 2024 inflation-adjusted dollars)',
      predicateType: 'string',
      attributeOf: 'B19013_001E',
      attributeType: 'ANNOTATION',
    });
    expect(requestsTo('/variables/B19013_001EA.json')).toHaveLength(1);
  });

  it('resolves a margin-of-error annotation to the margin of error it annotates', async () => {
    serve(acsRoutes);

    const [annotation] = await lookup(['B19013_001MA']);

    expect(annotation?.attributeOf).toBe('B19013_001M');
    expect(annotation?.attributeType).toBe('ANNOTATION');
  });

  it('resolves a cbp flag column with its own label', async () => {
    serve(cbpRoutes);

    const [flag] = await lookup(['EMP_F'], 'cbp', 2023);

    expect(flag).toMatchObject({
      label: 'Flag for number of employees',
      attributeOf: 'EMP',
      attributeType: 'FLAG',
    });
  });

  it('relays the attribute-of value the endpoint publishes, not the entry that lists it', async () => {
    serve(cbpRoutes);

    const [flag] = await lookup(['NAICS2017_F'], 'cbp', 2023);

    expect(flag?.attributeOf).toBe('NAICS2017_LABEL');
  });

  /** Serve the B19013_001EA record with `attribute type` set to `published`. */
  const serveAttributeType = (published: string) =>
    serve({
      ...acsRoutes,
      '/data/2024/acs/acs5/variables/B19013_001EA.json': {
        ...acsRoutes['/data/2024/acs/acs5/variables/B19013_001EA.json'],
        'attribute type': published,
      },
    });

  /**
   * Spellings the per-variable endpoint publishes on the 5-year ACS through 2010, the 1-year ACS
   * through 2011, and 2010 `dec/pl`, beside a padded run of whitespace and a kind no vintage
   * publishes yet.
   */
  it.each([
    ['Annotation', 'ANNOTATION'],
    ['Margin of Error', 'MARGIN_OF_ERROR'],
    ['Label', 'LABEL'],
    ['Statistical Significance', 'STATISTICAL_SIGNIFICANCE'],
    ['Errata', 'ERRATA'],
    ['  Statistical \t Significance ', 'STATISTICAL_SIGNIFICANCE'],
    ['Coverage note', 'COVERAGE_NOTE'],
  ])('normalizes a published attribute type of %j to %s (#61)', async (published, expected) => {
    serveAttributeType(published);

    const [annotation] = await lookup(['B19013_001EA']);

    expect(annotation?.attributeType).toBe(expected);
    expect(annotation?.attributeOf).toBe('B19013_001E');
  });

  it.each([
    'ANNOTATION',
    'FLAG',
    'GROUPING',
    'LABEL',
    'MARGIN_OF_ERROR',
    'STATISTICAL_SIGNIFICANCE',
  ])(
    'keeps the current-vintage attribute type %s unchanged (#61, characterization)',
    async (published) => {
      serveAttributeType(published);

      const [annotation] = await lookup(['B19013_001EA']);

      expect(annotation?.attributeType).toBe(published);
    },
  );

  it('leaves out an attribute type that is only whitespace (#61)', async () => {
    serveAttributeType('   ');

    const [annotation] = await lookup(['B19013_001EA']);

    expect(annotation).not.toHaveProperty('attributeType');
    expect(annotation?.attributeOf).toBe('B19013_001E');
  });

  it('refuses a code in neither the variable map nor the attributes index without a request', async () => {
    serve(acsRoutes);

    await expect(lookup(['B19013_001XA', 'B19013_001EA'])).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'variable_not_found', missingCodes: ['B19013_001XA'] },
    });
    // No attribute fetch from acs/acs5 itself; a sibling probe of acs/acs1 may follow the miss.
    expect(requestedUrls.filter((url) => url.includes('/acs/acs5/variables/'))).toEqual([]);
  });

  it('resolves an estimate and its synthesized margin of error without a per-variable request', async () => {
    serve(acsRoutes);

    const [estimate, moe] = await lookup(['B19013_001E', 'B19013_001M']);

    expect(estimate?.code).toBe('B19013_001E');
    expect(moe?.label).toContain('Margin of Error');
    expect(requestedUrls.filter((url) => url.includes('/variables/'))).toEqual([]);
  });

  it('caches a resolved attribute column for the variables.json TTL', async () => {
    serve(acsRoutes);

    await lookup(['B19013_001EA']);
    await lookup(['B19013_001EA']);

    expect(requestsTo('/variables/B19013_001EA.json')).toHaveLength(1);
  });

  it('surfaces a failed per-variable fetch as variables_unavailable', async () => {
    serve({
      ...acsRoutes,
      '/data/2024/acs/acs5/variables/B19013_001EA.json': new Response(TOMCAT_404, {
        status: 404,
        headers: { 'content-type': 'text/html' },
      }),
    });

    const error = await lookup(['B19013_001EA']).then(
      () => undefined,
      (err: McpError) => err,
    );

    expect(error?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error?.data).toMatchObject({ reason: 'variables_unavailable' });
    expect(JSON.stringify(error?.data)).not.toContain('HTTP Status 404');
  });

  it('rethrows a caller cancellation during the per-variable fetch, not variables_unavailable', async () => {
    const controller = new AbortController();
    serve({
      ...acsRoutes,
      '/data/2024/acs/acs5/variables/B19013_001EA.json': ((init) => {
        queueMicrotask(() => controller.abort());
        return hang(init);
      }) satisfies RouteFn,
    });

    const error = await service
      .getVariablesByCode(
        ['B19013_001EA'],
        'acs/acs5',
        2024,
        createMockContext({ signal: controller.signal }),
      )
      .then(
        () => undefined,
        (err: McpError) => err,
      );

    expect(error?.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(error?.data?.reason).not.toBe('variables_unavailable');
  });

  it('rethrows a caller cancellation during the per-variable retry backoff, untouched', async () => {
    serve({
      ...acsRoutes,
      '/data/2024/acs/acs5/variables/B19013_001EA.json': new Response('Service Unavailable', {
        status: 503,
      }),
    });
    const controller = new AbortController();
    const reason = new Error('caller went away');

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const settled = service
        .getVariablesByCode(
          ['B19013_001EA'],
          'acs/acs5',
          2024,
          createMockContext({ signal: controller.signal }),
        )
        .then(
          () => undefined,
          (err: unknown) => err,
        );
      await vi.advanceTimersByTimeAsync(100);
      expect(requestsTo('/variables/B19013_001EA.json')).toHaveLength(1);

      controller.abort(reason);
      await vi.advanceTimersByTimeAsync(300_000);

      expect(await settled).toBe(reason);
      expect(requestsTo('/variables/B19013_001EA.json')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves out whatever the per-variable endpoint does not publish', async () => {
    serve({
      ...cbpRoutes,
      '/data/2023/cbp/variables/EMP_F.json': {
        name: 'EMP_F',
        label: 'Flag for number of employees',
      },
    });

    const [flag] = await lookup(['EMP_F'], 'cbp', 2023);

    expect(flag).toEqual({
      code: 'EMP_F',
      label: 'Flag for number of employees',
      predicateType: 'string',
    });
  });

  it('keeps attribute columns out of search results and the predicate check', async () => {
    serve(cbpRoutes);
    const ctx = createMockContext();

    await service.getVariablesByCode(['EMP_F'], 'cbp', 2023, ctx);

    const { variables } = await service.searchVariables(
      { query: 'flag employees', dataset: 'cbp', year: 2023, limit: 10 },
      ctx,
    );
    expect(variables.map((v) => v.code)).not.toContain('EMP_F');
    const check = await service.checkPredicates(
      { dataset: 'cbp', year: 2023, supplied: ['EMP_F', 'NAICS2017'] },
      ctx,
    );
    expect(check.unknown).toEqual(['EMP_F']);
    await expect(service.findVariable('EMP_F', 'cbp', 2023, ctx)).resolves.toBeUndefined();
  });
});

describe('VariableCacheService — universe from groups.json (#53)', () => {
  const groupsJson = {
    groups: [
      {
        name: 'B19013',
        description: 'Median Household Income',
        variables: 'http://api.census.gov/data/2024/acs/acs5/groups/B19013.json',
        'universe ': 'Households',
      },
      {
        name: 'B25077',
        description: 'Median Value (Dollars)',
        variables: 'http://api.census.gov/data/2024/acs/acs5/groups/B25077.json',
      },
    ],
  };

  const lookup = (codes: string[]) =>
    service.getVariablesByCode(codes, 'acs/acs5', 2024, createMockContext());

  it('joins the universe onto a variable through its group', async () => {
    serve({
      '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson,
      '/data/2024/acs/acs5/groups.json': groupsJson,
    });

    const [income, moe] = await lookup(['B19013_001E', 'B19013_001M']);

    expect(income?.universe).toBe('Households');
    expect(moe?.universe).toBe('Households');
  });

  it('fetches groups.json once per dataset and year', async () => {
    serve({
      '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson,
      '/data/2024/acs/acs5/groups.json': groupsJson,
    });

    await lookup(['B19013_001E']);
    await lookup(['B19013_001E']);

    expect(requestsTo('/groups.json')).toHaveLength(1);
    expect(requestsTo('/variables.json')).toHaveLength(1);
  });

  it('omits the universe for a group that publishes none', async () => {
    serve({
      '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson,
      '/data/2024/acs/acs5/groups.json': groupsJson,
    });

    const [value] = await lookup(['B25077_001E']);

    expect(value).not.toHaveProperty('universe');
  });

  it('omits the universe when the dataset publishes no groups.json', async () => {
    serve({
      '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson,
      '/data/2024/acs/acs5/groups.json': new Response(TOMCAT_404, {
        status: 404,
        headers: { 'content-type': 'text/html' },
      }),
    });

    const [income] = await lookup(['B19013_001E']);

    expect(income?.code).toBe('B19013_001E');
    expect(income).not.toHaveProperty('universe');
    // A 404 is an answer, not a failure: nothing is flagged and nothing is retried.
    expect(income).not.toHaveProperty('universeUnavailable');
    expect(requestsTo('/groups.json')).toHaveLength(1);
  });

  it('sends no groups.json request for columns that belong to no single table', async () => {
    serve({ '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson });

    const [geoId, name] = await lookup(['GEO_ID', 'NAME']);

    expect(geoId).not.toHaveProperty('universe');
    expect(name).not.toHaveProperty('universe');
    expect(requestsTo('/groups.json')).toEqual([]);
  });

  describe('when groups.json fails (#60)', () => {
    const GROUPS = '/data/2024/acs/acs5/groups.json';

    /**
     * Each way groups.json can fail short of a 404, with the requests it gets. Every one is
     * transient to the retry loop, so a fast failure is asked four times; a hang holds its first
     * attempt until the universe deadline ends the lookup.
     */
    const failures: Array<[string, unknown, number]> = [
      ['an HTTP 503', new Response('Service Unavailable', { status: 503 }), 4],
      ['an HTTP 500', new Response('Internal Server Error', { status: 500 }), 4],
      [
        'a network error',
        (() => Promise.reject(new TypeError('fetch failed'))) satisfies RouteFn,
        4,
      ],
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

    /**
     * Settle `run` with fake timers driven past every backoff and the 30-second attempt timeout,
     * so the real retry loop runs in full without the test waiting it out.
     */
    const settleWithTimers = async <T>(
      run: () => Promise<T>,
    ): Promise<{ value?: T; error?: unknown }> => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const settled = run().then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        await vi.advanceTimersByTimeAsync(300_000);
        return await settled;
      } finally {
        vi.useRealTimers();
      }
    };

    it.each(failures)(
      'returns the variables without universe after %s, flagging the single-table codes',
      async (_name, failure, requests) => {
        serve({ '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson, [GROUPS]: failure });

        const { value, error } = await settleWithTimers(() =>
          lookup(['GEO_ID', 'B19013_001E', 'B19013_001M', 'NAME']),
        );

        expect(error).toBeUndefined();
        const [geoId, income, moe, name] = value ?? [];
        expect(income).toMatchObject({ code: 'B19013_001E', universeUnavailable: true });
        expect(moe).toMatchObject({ code: 'B19013_001M', universeUnavailable: true });
        expect(income).not.toHaveProperty('universe');
        expect(moe).not.toHaveProperty('universe');
        // GEO_ID spans several tables and NAME none, so neither lost a universe.
        expect(geoId).not.toHaveProperty('universeUnavailable');
        expect(name).not.toHaveProperty('universeUnavailable');
        expect(requestsTo('/groups.json')).toHaveLength(requests);
      },
    );

    /**
     * groups.json adds one optional field, so a stalled one is given up on well inside the
     * 60-second request timeout MCP SDK clients apply by default; four 30-second attempt timeouts
     * and their backoff would answer after the client had already stopped waiting.
     */
    it('settles within 25 seconds when groups.json hangs, without universe', async () => {
      serve({ '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson, [GROUPS]: hang });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        let value: Awaited<ReturnType<typeof lookup>> | undefined;
        const settled = lookup(['B19013_001E']).then((v) => {
          value = v;
        });
        await vi.advanceTimersByTimeAsync(25_000);

        expect(value?.[0]).toMatchObject({ code: 'B19013_001E', universeUnavailable: true });
        await vi.advanceTimersByTimeAsync(300_000);
        await settled;
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps an empty groups list as the answer that no table publishes a universe (characterization)', async () => {
      serve({
        '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson,
        [GROUPS]: { groups: [] },
      });

      const [income] = await lookup(['B19013_001E']);
      await lookup(['B19013_001E']);

      expect(income).not.toHaveProperty('universe');
      expect(income).not.toHaveProperty('universeUnavailable');
      expect(requestsTo('/groups.json')).toHaveLength(1);
    });

    it('does not cache a body with no groups list: the next lookup refetches and joins the universe', async () => {
      const routes: Record<string, unknown> = {
        '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson,
        [GROUPS]: { error: 'unexpected' },
      };
      serve(routes);

      const [first] = await lookup(['B19013_001E']);
      expect(first).toMatchObject({ code: 'B19013_001E', universeUnavailable: true });

      routes[GROUPS] = groupsJson;
      const [income] = await lookup(['B19013_001E']);

      expect(income?.universe).toBe('Households');
      expect(requestsTo('/groups.json')).toHaveLength(2);
    });

    it('returns the universe when a retry of groups.json succeeds (characterization)', async () => {
      let attempts = 0;
      serve({
        '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson,
        [GROUPS]: (() =>
          Promise.resolve(
            ++attempts < 3
              ? new Response('Service Unavailable', { status: 503 })
              : Response.json(groupsJson),
          )) satisfies RouteFn,
      });

      const { value } = await settleWithTimers(() => lookup(['B19013_001E']));

      expect(value?.[0]).toMatchObject({ universe: 'Households' });
      expect(value?.[0]).not.toHaveProperty('universeUnavailable');
      expect(requestsTo('/groups.json')).toHaveLength(3);
    });

    it('does not cache the failure: the next lookup refetches groups.json and joins the universe', async () => {
      const routes: Record<string, unknown> = {
        '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson,
        [GROUPS]: new Response('Service Unavailable', { status: 503 }),
      };
      serve(routes);

      const first = await settleWithTimers(() => lookup(['B19013_001E']));
      expect(first.value?.[0]).toMatchObject({ universeUnavailable: true });

      routes[GROUPS] = groupsJson;
      const [income] = await lookup(['B19013_001E']);

      expect(income?.universe).toBe('Households');
      expect(income).not.toHaveProperty('universeUnavailable');
      expect(requestsTo('/groups.json')).toHaveLength(5);
      expect(requestsTo('/variables.json')).toHaveLength(1);
    });

    it('rethrows a caller cancellation during the groups.json fetch', async () => {
      const controller = new AbortController();
      serve({
        '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson,
        [GROUPS]: ((init) => {
          queueMicrotask(() => controller.abort());
          return hang(init);
        }) satisfies RouteFn,
      });

      const error = await service
        .getVariablesByCode(
          ['B19013_001E'],
          'acs/acs5',
          2024,
          createMockContext({ signal: controller.signal }),
        )
        .then(
          () => undefined,
          (err: McpError) => err,
        );

      expect(error?.code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(error?.data?.reason).not.toBe('variables_unavailable');
      expect(requestsTo('/groups.json')).toHaveLength(1);
    });

    /**
     * An abort that lands while `withRetry` sleeps between attempts rejects with the signal's raw
     * reason, not a `RequestCancelled` — so only the signal itself can tell it apart from a failure.
     */
    it('rethrows a caller cancellation during the retry backoff, untouched', async () => {
      serve({
        '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson,
        [GROUPS]: new Response('Service Unavailable', { status: 503 }),
      });
      const controller = new AbortController();
      const reason = new Error('caller went away');

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const settled = service
          .getVariablesByCode(
            ['B19013_001E'],
            'acs/acs5',
            2024,
            createMockContext({ signal: controller.signal }),
          )
          .then(
            () => undefined,
            (err: unknown) => err,
          );
        await vi.advanceTimersByTimeAsync(100);
        expect(requestsTo('/groups.json')).toHaveLength(1);

        controller.abort(reason);
        await vi.advanceTimersByTimeAsync(300_000);

        // A degraded success would settle to undefined here.
        expect(await settled).toBe(reason);
        expect(requestsTo('/groups.json')).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('VariableCacheService.resolveSpellings (#59)', () => {
  const resolve = (codes: string[], dataset = 'acs/acs5/cprofile') =>
    service.resolveSpellings(codes, dataset, 2024, createMockContext());

  beforeEach(() =>
    serve({
      '/data/2024/acs/acs5/cprofile/variables.json': cprofileVariablesJson,
      '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson,
    }),
  );

  it('maps every casing of a significance column to the spelling the dataset publishes', async () => {
    await expect(
      resolve([
        'cp03_2024to2019_062ss',
        'CP03_2024TO2019_062SS',
        'CP03_2024to2019_062SS',
        'cp03_2024_062e',
      ]),
    ).resolves.toEqual([
      'CP03_2024to2019_062SS',
      'CP03_2024to2019_062SS',
      'CP03_2024to2019_062SS',
      'CP03_2024_062E',
    ]);
  });

  it('uppercases a code the dataset does not list, so a rejection names it that way', async () => {
    await expect(resolve(['cp03_2024to2019_999ss', 'b19013_001x'])).resolves.toEqual([
      'CP03_2024TO2019_999SS',
      'B19013_001X',
    ]);
  });

  it('uppercases on a dataset that spells every column in uppercase', async () => {
    await expect(resolve(['b19013_001e', 'B19013_001M'], 'acs/acs5')).resolves.toEqual([
      'B19013_001E',
      'B19013_001M',
    ]);
  });

  it('reads the cached variables.json, so a repeat spends no request', async () => {
    await resolve(['cp03_2024to2019_062ss']);
    await resolve(['cp03_2024to2019_062ss']);

    expect(requestedUrls).toEqual([
      'https://api.census.gov/data/2024/acs/acs5/cprofile/variables.json',
    ]);
  });
});

describe('VariableCacheService.findSiblingDatasets (#65)', () => {
  const notHeld = () =>
    new Response(TOMCAT_404, { status: 404, headers: { 'content-type': 'text/html' } });

  /** A per-variable record as the endpoint publishes it; only its 200 is read. */
  const held = (code: string) => ({ name: code, label: `Estimate!!${code}`, predicateType: 'int' });

  const probes = () => requestedUrls.map((url) => new URL(url).pathname);

  const find = (
    codes: string[],
    dataset: string,
    year = 2024,
    ctx = createMockContext(),
    kind?: 'variables' | 'groups',
  ) => service.findSiblingDatasets(codes, dataset, year, ctx, kind);

  it('walks the chain past its first candidates: S0201_001E on acs/acs5 is in acs/acs1/spp', async () => {
    serve({
      '/data/2024/acs/acs5/subject/variables/S0201_001E.json': notHeld(),
      '/data/2024/acs/acs1/subject/variables/S0201_001E.json': notHeld(),
      '/data/2024/acs/acs1/spp/variables/S0201_001E.json': held('S0201_001E'),
    });

    await expect(find(['S0201_001E'], 'acs/acs5')).resolves.toEqual(
      new Map([['S0201_001E', 'acs/acs1/spp']]),
    );
    expect(probes()).toEqual([
      '/data/2024/acs/acs5/subject/variables/S0201_001E.json',
      '/data/2024/acs/acs1/subject/variables/S0201_001E.json',
      '/data/2024/acs/acs1/spp/variables/S0201_001E.json',
    ]);
  });

  it('tries the requested survey first: S0201_001E on acs/acs1/subject goes to acs/acs1/spp', async () => {
    serve({ '/data/2024/acs/acs1/spp/variables/S0201_001E.json': held('S0201_001E') });

    await expect(find(['S0201_001E'], 'acs/acs1/subject')).resolves.toEqual(
      new Map([['S0201_001E', 'acs/acs1/spp']]),
    );
    expect(probes()).toEqual(['/data/2024/acs/acs1/spp/variables/S0201_001E.json']);
  });

  it.each([
    ['S1701_C03_001E', 'acs/acs5', 2024, 'acs/acs5/subject'],
    ['B19013_001E', 'acs/acs5/subject', 2024, 'acs/acs5'],
    ['C27005_001E', 'acs/acs1/profile', 2024, 'acs/acs1'],
    ['DP03_0062E', 'acs/acs5', 2024, 'acs/acs5/profile'],
    ['CP03_2024_062E', 'acs/acs5', 2024, 'acs/acs5/cprofile'],
    ['K200101_001E', 'acs/acs1', 2024, 'acs/acsse'],
  ])('sends %s on %s (%i) to %s first', async (code, dataset, year, sibling) => {
    serve({ [`/data/${year}/${sibling}/variables/${code}.json`]: held(code) });

    await expect(find([code], dataset, year)).resolves.toEqual(new Map([[code, sibling]]));
    expect(probes()).toEqual([`/data/${year}/${sibling}/variables/${code}.json`]);
  });

  it('skips a candidate the year does not list: DP1_0001C on acs/acs5/profile 2020 is in dec/dp', async () => {
    serve({ '/data/2020/dec/dp/variables/DP1_0001C.json': held('DP1_0001C') });

    await expect(find(['DP1_0001C'], 'acs/acs5/profile', 2020)).resolves.toEqual(
      new Map([['DP1_0001C', 'dec/dp']]),
    );
    // acs/acs1/profile has no 2020 vintage, so it is never asked.
    expect(probes()).toEqual(['/data/2020/dec/dp/variables/DP1_0001C.json']);
  });

  it('asks only the candidates listed for the year', async () => {
    serve({ '/data/2012/acs/acs1/cprofile/variables/CP03_2024_062E.json': notHeld() });

    await expect(find(['CP03_2024_062E', 'K200101_001E'], 'acs/acs5', 2012)).resolves.toEqual(
      new Map(),
    );
    // acs/acs5/cprofile starts in 2015 and acs/acsse in 2014.
    expect(probes()).toEqual(['/data/2012/acs/acs1/cprofile/variables/CP03_2024_062E.json']);
  });

  it('sends nothing for a prefix with no sibling row or one not followed by a digit', async () => {
    serve({});

    await expect(
      find(['P1_001N', 'SEX', 'STATE', 'SECTOR', 'CPOP', 'DPX_1', 'H1_001N'], 'acs/acs5'),
    ).resolves.toEqual(new Map());
    expect(requestedUrls).toEqual([]);
  });

  it('probes one code per table and names only the code it confirmed', async () => {
    serve({ '/data/2024/acs/acs5/subject/variables/S1701_C03_001E.json': held('S1701_C03_001E') });

    await expect(
      find(['S1701_C03_001E', 'S1701_C03_002E', 'S1701_C01_001E'], 'acs/acs5'),
    ).resolves.toEqual(new Map([['S1701_C03_001E', 'acs/acs5/subject']]));
    expect(probes()).toEqual(['/data/2024/acs/acs5/subject/variables/S1701_C03_001E.json']);
  });

  it('asks for a significance column in the spelling the comparison profiles publish', async () => {
    // The per-variable endpoint is case-sensitive: the uppercased spelling 404s where this 200s.
    serve({
      '/data/2024/acs/acs5/cprofile/variables/CP03_2024to2019_062SS.json':
        held('CP03_2024to2019_062SS'),
    });

    await expect(find(['CP03_2024TO2019_062SS'], 'acs/acs5')).resolves.toEqual(
      new Map([['CP03_2024TO2019_062SS', 'acs/acs5/cprofile']]),
    );
    expect(probes()).toEqual(['/data/2024/acs/acs5/cprofile/variables/CP03_2024to2019_062SS.json']);
  });

  it('looks up the first five tables only, counting only tables that have a candidate', async () => {
    const codes = [
      'P1_001N',
      'S0101_C01_001E',
      'S0601_C01_001E',
      'S0801_C01_001E',
      'S1101_C01_001E',
      'S1501_C01_001E',
      'S1701_C03_001E',
    ];
    serve(
      Object.fromEntries(
        codes.map((code) => [`/data/2024/acs/acs5/subject/variables/${code}.json`, held(code)]),
      ),
    );

    const found = await find(codes, 'acs/acs5');

    expect([...found.keys()]).toEqual(codes.slice(1, 6));
    expect(probes()).toHaveLength(5);
    expect(probes()).not.toContain('/data/2024/acs/acs5/subject/variables/S1701_C03_001E.json');
  });

  it('ends a chain at a failed lookup without retrying it, and answers the other tables', async () => {
    serve({
      '/data/2024/acs/acs5/subject/variables/S1701_C03_001E.json': new Response('unavailable', {
        status: 503,
        headers: { 'content-type': 'text/plain' },
      }),
      '/data/2024/acs/acs5/profile/variables/DP03_0062E.json': held('DP03_0062E'),
    });

    await expect(
      find(['S1701_C03_001E', 'DP03_0062E', 'CP03_2024_062E'], 'acs/acs5'),
    ).resolves.toEqual(new Map([['DP03_0062E', 'acs/acs5/profile']]));
    expect(probes().sort()).toEqual(
      [
        '/data/2024/acs/acs5/subject/variables/S1701_C03_001E.json',
        '/data/2024/acs/acs5/profile/variables/DP03_0062E.json',
        // Unrouted, so the fetch rejects: a network failure ends that chain the same way.
        '/data/2024/acs/acs5/cprofile/variables/CP03_2024_062E.json',
      ].sort(),
    );
  });

  it('confirms a table ID against groups/<id>.json', async () => {
    serve({ '/data/2024/acs/acs5/subject/groups/S1701.json': { variables: {} } });

    await expect(find(['S1701'], 'acs/acs5', 2024, createMockContext(), 'groups')).resolves.toEqual(
      new Map([['S1701', 'acs/acs5/subject']]),
    );
    expect(probes()).toEqual(['/data/2024/acs/acs5/subject/groups/S1701.json']);
  });

  describe('under the shared deadline', () => {
    /** A fetch that answers `respond` after `delayMs`, or hangs until its signal aborts. */
    const scripted = (
      script: Record<string, { delayMs: number; respond: () => unknown } | 'hang'>,
    ) =>
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string | URL, init?: RequestInit) => {
          const href = String(url);
          requestedUrls.push(href);
          const step = script[new URL(href).pathname];
          return new Promise((resolve, reject) => {
            // As fetch does: an aborted signal rejects at once, a later abort mid-flight.
            if (init?.signal?.aborted) return reject(init.signal.reason);
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
            if (!step) return reject(new Error(`unrouted fetch: ${href}`));
            if (step === 'hang') return;
            setTimeout(() => {
              const body = step.respond();
              resolve(
                body instanceof Response
                  ? body
                  : new Response(JSON.stringify(body), {
                      status: 200,
                      headers: { 'content-type': 'application/json' },
                    }),
              );
            }, step.delayMs);
          });
        }),
      );

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('is 2.5 s, enough for a three-candidate chain at the slowest measured lookup', () => {
      expect(SIBLING_LOOKUP_DEADLINE_MS).toBe(2_500);
    });

    it('gives up on every lookup at one deadline the whole call shares', async () => {
      scripted({
        // 404 after 2 s, then the next candidate hangs: a per-lookup deadline would wait 4.5 s.
        '/data/2024/acs/acs5/subject/variables/S0201_001E.json': {
          delayMs: 2_000,
          respond: notHeld,
        },
        '/data/2024/acs/acs1/subject/variables/S0201_001E.json': 'hang',
        '/data/2024/acs/acs5/profile/variables/DP03_0062E.json': {
          delayMs: 300,
          respond: () => held('DP03_0062E'),
        },
      });

      let settled = false;
      const pending = find(['S0201_001E', 'DP03_0062E'], 'acs/acs5').finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(SIBLING_LOOKUP_DEADLINE_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(pending).resolves.toEqual(new Map([['DP03_0062E', 'acs/acs5/profile']]));
      // The timed-out chain never reached its third candidate.
      expect(probes()).not.toContain('/data/2024/acs/acs1/spp/variables/S0201_001E.json');
    });

    it("rethrows the caller's cancellation mid-lookup instead of answering without it", async () => {
      scripted({ '/data/2024/acs/acs5/subject/variables/S0201_001E.json': 'hang' });
      const controller = new AbortController();

      const pending = find(
        ['S0201_001E'],
        'acs/acs5',
        2024,
        createMockContext({ signal: controller.signal }),
      ).then(
        () => 'resolved',
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(probes()).toHaveLength(1);
      controller.abort();

      await expect(pending).resolves.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
      // Nothing more went out once the caller left.
      await vi.advanceTimersByTimeAsync(SIBLING_LOOKUP_DEADLINE_MS);
      expect(probes()).toHaveLength(1);
    });

    it('rejects at the first candidate when the caller has already gone', async () => {
      scripted({});
      const controller = new AbortController();
      controller.abort();

      await expect(
        find(['S0201_001E'], 'acs/acs5', 2024, createMockContext({ signal: controller.signal })),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
      // The one fetch carried the aborted signal; the chain's other two candidates were never asked.
      expect(probes()).toEqual(['/data/2024/acs/acs5/subject/variables/S0201_001E.json']);
    });
  });
});

describe('VariableCacheService.getVariablesByCode — sibling recovery (#65)', () => {
  const notHeld = () =>
    new Response(TOMCAT_404, { status: 404, headers: { 'content-type': 'text/html' } });

  it('names the sibling for each code it confirmed and searches for the rest', async () => {
    serve({
      '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson,
      '/data/2024/acs/acs5/subject/variables/S1701_C03_001E.json': { name: 'S1701_C03_001E' },
      '/data/2024/acs/acs5/subject/variables/S9999_C99_999E.json': notHeld(),
      '/data/2024/acs/acs1/subject/variables/S9999_C99_999E.json': notHeld(),
      '/data/2024/acs/acs1/spp/variables/S9999_C99_999E.json': notHeld(),
    });

    const error = await service
      .getVariablesByCode(
        ['S1701_C03_001E', 's9999_c99_999e', 'B19013_001E'],
        'acs/acs5',
        2024,
        createMockContext(),
      )
      .catch((e: unknown) => e as McpError);

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: 'Variable codes not found in acs/acs5 (2024): S1701_C03_001E, S9999_C99_999E',
      data: {
        reason: 'variable_not_found',
        missingCodes: ['S1701_C03_001E', 'S9999_C99_999E'],
        recovery: {
          hint: 'S1701_C03_001E is in acs/acs5/subject — query that dataset instead. For S9999_C99_999E, use census_search_variables to find valid codes for this dataset and year.',
        },
      },
    });
  });

  it('points a code at the sibling its table was found in, rather than back at the dataset', async () => {
    serve({
      '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson,
      '/data/2024/acs/acs5/subject/variables/S1701_C03_001E.json': { name: 'S1701_C03_001E' },
    });

    const error = await service
      .getVariablesByCode(
        ['S1701_C03_001E', 'S1701_C01_001E'],
        'acs/acs5',
        2024,
        createMockContext(),
      )
      .catch((e: unknown) => e as McpError);

    expect(error).toMatchObject({
      data: {
        recovery: {
          hint: 'S1701_C03_001E is in acs/acs5/subject — query that dataset instead. S1701_C01_001E is from a table found in acs/acs5/subject; look it up there.',
        },
      },
    });
    // One probe per table: the second code rides on the first one's answer.
    expect(requestsTo('/variables/S1701_C01_001E.json')).toEqual([]);
  });

  it('keeps the search hint when no sibling holds a missing code', async () => {
    serve({ '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson });

    await expect(
      service.getVariablesByCode(['NOPE_1'], 'acs/acs5', 2024, createMockContext()),
    ).rejects.toMatchObject({
      message: 'Variable codes not found in acs/acs5 (2024): NOPE_1',
      data: {
        recovery: {
          hint: 'Use census_search_variables to find valid codes for this dataset and year.',
        },
      },
    });
    expect(requestedUrls).toEqual(['https://api.census.gov/data/2024/acs/acs5/variables.json']);
  });
});

/** pep/charv 2023 as variables.json publishes it, `values` left out. */
const PEP_ALLDATA_CONCEPT =
  'Vintage 2023 Annual Resident Population Estimates by Age, Sex, Race, and Hispanic Origin: April 1, 2020 to July 1, 2023';
const PEP_AGESEX_CONCEPT =
  'Vintage 2023 Annual Resident Population Estimates by Selected Age Groups and Sex: April 1, 2020 to July 1, 2023';
const PEP_SHARED_CONCEPT = `${PEP_ALLDATA_CONCEPT};${PEP_AGESEX_CONCEPT};Vintage 2023 Annual Resident Population Estimates by Single Year of Age and Sex: April 1, 2020 to July 1, 2023`;
const PEP_SHARED_GROUP = 'PEP_SYASEX,PEP_AGESEX,PEP_ALLDATA';
const pepCharvLiveJson = {
  variables: {
    for: { label: "Census API FIPS 'for' clause", group: 'N/A', predicateType: 'fips-for' },
    MONTH: {
      label: 'Vintage Month',
      concept: PEP_SHARED_CONCEPT,
      predicateType: 'string',
      group: PEP_SHARED_GROUP,
      attributes: 'MONTH_DESC',
    },
    SEX: {
      label: 'Sex Code',
      concept: PEP_SHARED_CONCEPT,
      predicateType: 'string',
      group: PEP_SHARED_GROUP,
      required: 'default displayed',
      attributes: 'SEX_DESC',
    },
    STATE: { label: 'State', group: 'N/A' },
    YEAR: {
      label: 'Vintage Year',
      concept: PEP_SHARED_CONCEPT,
      predicateType: 'string',
      group: PEP_SHARED_GROUP,
      required: 'default displayed',
    },
    UNIVERSE: {
      label: 'Universe',
      concept: PEP_SHARED_CONCEPT,
      predicateType: 'string',
      group: PEP_SHARED_GROUP,
      attributes: 'UNIVERSE_DESC',
    },
    AGE: {
      label: 'Age Group Code',
      concept: PEP_SHARED_CONCEPT,
      predicateType: 'string',
      group: PEP_SHARED_GROUP,
      required: 'default displayed',
      attributes: 'AGE_DESC',
    },
    MEDAGE: {
      label: 'Median Age',
      concept: PEP_AGESEX_CONCEPT,
      predicateType: 'float',
      group: 'PEP_AGESEX',
    },
    GEO_ID: {
      label: 'Geography',
      concept: PEP_SHARED_CONCEPT,
      predicateType: 'string',
      group: PEP_SHARED_GROUP,
      attributes: 'NAME',
    },
    POP: {
      label: 'Population Estimate',
      concept: PEP_SHARED_CONCEPT,
      predicateType: 'int',
      group: PEP_SHARED_GROUP,
    },
    POPGROUP: {
      label: 'Population Group',
      concept: PEP_ALLDATA_CONCEPT,
      predicateType: 'string',
      group: 'PEP_ALLDATA',
      required: 'default displayed',
      attributes: 'POPGROUP_LABEL',
    },
    HISP: {
      label: 'Hispanic Origin Code',
      concept: PEP_ALLDATA_CONCEPT,
      predicateType: 'string',
      group: 'PEP_ALLDATA',
      required: 'default displayed',
      attributes: 'HISP_DESC',
    },
  },
};

/** acs/acs5 2024 rows for the `state` and `2020` keyword baselines. */
const acsKeywordBaselineJson = {
  variables: {
    B25034_001E: {
      label: 'Estimate!!Total:',
      concept: 'Year Structure Built',
      predicateType: 'int',
      group: 'B25034',
      attributes: 'B25034_001EA,B25034_001M,B25034_001MA',
    },
    B08007_002E: {
      label: 'Estimate!!Total:!!Worked in state of residence:',
      concept: 'Sex of Workers by Place of Work--State and County Level',
      predicateType: 'int',
      group: 'B08007',
      attributes: 'B08007_002EA,B08007_002M,B08007_002MA',
    },
    B25034_002E: {
      label: 'Estimate!!Total:!!Built 2020 or later',
      concept: 'Year Structure Built',
      predicateType: 'int',
      group: 'B25034',
      attributes: 'B25034_002EA,B25034_002M,B25034_002MA',
    },
    STATE: { label: 'State', group: 'N/A' },
  },
};

/**
 * A decennial table whose concept names its own code, the way the 2010 concepts did
 * (`P1. RACE`), so the code `P1` is also a keyword of every variable in it and of one outside it.
 */
const decPlCodeInConceptJson = {
  variables: {
    P3_001N: {
      label: ' !!Total:',
      concept: 'P3. Race for the Population 18 Years and Over (P1 universe restricted)',
      predicateType: 'int',
      group: 'P3',
    },
    P1_009N: {
      label: ' !!Total:!!Population of two or more races:',
      concept: 'P1. Race',
      predicateType: 'int',
      group: 'P1',
    },
    P1_003N: {
      label: ' !!Total:!!Population of one race:!!White alone',
      concept: 'P1. Race',
      predicateType: 'int',
      group: 'P1',
    },
    P1_002N: {
      label: ' !!Total:!!Population of one race:',
      concept: 'P1. Race',
      predicateType: 'int',
      group: 'P1',
    },
    P1_001N: { label: ' !!Total:', concept: 'P1. Race', predicateType: 'int', group: 'P1' },
  },
};

/** acs/acs5/subject 2024: three S1701 estimates, each with a margin the cache synthesizes. */
const subjectS1701Json = {
  variables: {
    S1701_C03_001E: {
      label:
        'Estimate!!Percent below poverty level!!Population for whom poverty status is determined',
      concept: 'Poverty Status in the Past 12 Months',
      predicateType: 'float',
      group: 'S1701',
    },
    S1701_C02_001E: {
      label: 'Estimate!!Below poverty level!!Population for whom poverty status is determined',
      concept: 'Poverty Status in the Past 12 Months',
      predicateType: 'int',
      group: 'S1701',
    },
    S1701_C01_001E: {
      label: 'Estimate!!Total!!Population for whom poverty status is determined',
      concept: 'Poverty Status in the Past 12 Months',
      predicateType: 'int',
      group: 'S1701',
    },
    S0101_C01_001E: {
      label: 'Estimate!!Total!!Total population',
      concept: 'Age and Sex',
      predicateType: 'int',
      group: 'S0101',
    },
  },
};

describe('VariableCacheService.searchVariables — keyword results the code tier leaves alone (#63, characterization)', () => {
  const search = (query: string, dataset: string, year: number) =>
    service.searchVariables({ query, dataset, year, limit: 20 }, createMockContext());
  const summary = async (query: string, dataset: string, year: number) => {
    const result = await search(query, dataset, year);
    return { codes: result.variables.map((v) => v.code), totalMatches: result.totalMatches };
  };

  beforeEach(() =>
    serve({
      '/data/2023/pep/charv/variables.json': pepCharvLiveJson,
      '/data/2024/acs/acs5/variables.json': acsKeywordBaselineJson,
    }),
  );

  it('keeps "age" on pep/charv in keyword order, though AGE is also a column code', async () => {
    // An unguarded code tier would lift AGE above MEDAGE.
    await expect(summary('age', 'pep/charv', 2023)).resolves.toEqual({
      codes: ['MEDAGE', 'AGE', 'HISP', 'POPGROUP'],
      totalMatches: 4,
    });
    await expect(summary('AGE', 'pep/charv', 2023)).resolves.toEqual({
      codes: ['MEDAGE', 'AGE', 'HISP', 'POPGROUP'],
      totalMatches: 4,
    });
  });

  it('keeps "sex" on pep/charv in keyword order', async () => {
    await expect(summary('sex', 'pep/charv', 2023)).resolves.toEqual({
      codes: ['SEX', 'MEDAGE', 'HISP', 'POPGROUP'],
      totalMatches: 4,
    });
  });

  it('keeps "state" and "2020" on acs/acs5 in keyword order', async () => {
    await expect(summary('state', 'acs/acs5', 2024)).resolves.toEqual({
      codes: ['STATE', 'B08007_002E', 'B08007_002M'],
      totalMatches: 3,
    });
    await expect(summary('2020', 'acs/acs5', 2024)).resolves.toEqual({
      codes: ['B25034_002E', 'B25034_002M'],
      totalMatches: 2,
    });
  });

  it('sends a keyword query, matched or not, to variables.json alone', async () => {
    for (const query of ['age', 'sex', 'xyzzy']) await search(query, 'pep/charv', 2023);
    for (const query of ['state', '2020', 'xyzzy', 'POPGROUP'])
      await search(query, 'acs/acs5', 2024);

    expect(requestedUrls.map((url) => new URL(url).pathname)).toEqual([
      '/data/2023/pep/charv/variables.json',
      '/data/2024/acs/acs5/variables.json',
    ]);
  });
});

describe('VariableCacheService.searchVariables — a query that is a variable or table code (#63)', () => {
  const search = (query: string, dataset = 'acs/acs5', year = 2024, limit = 20) =>
    service.searchVariables({ query, dataset, year, limit }, createMockContext());
  const codesFor = async (query: string, dataset?: string, year?: number) =>
    (await search(query, dataset, year)).variables.map((v) => v.code);

  it('returns every variable of a table, in code order, for its table ID', async () => {
    serve({ '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson });

    const result = await search('B19013');

    // GEO_ID lists B19013 among its tables, but belongs to no single one of them.
    expect(result.variables.map((v) => v.code)).toEqual(['B19013_001E', 'B19013_001M']);
    expect(result.totalMatches).toBe(2);
    expect(result.matchedTermCount).toBe(result.termCount);
  });

  it('returns a variable for its code given in any case, with every query word counted', async () => {
    serve({ '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson });

    const result = await search('  b19013_001e ');

    expect(result.variables.map((v) => v.code)).toEqual(['B19013_001E']);
    expect(result.totalMatches).toBe(1);
    expect(result.matchedTermCount).toBe(2);
    expect(result.termCount).toBe(2);
  });

  it('puts the code tier in code order ahead of the keyword matches, counting each variable once', async () => {
    serve({ '/data/2020/dec/pl/variables.json': decPlCodeInConceptJson });

    const result = await search('P1', 'dec/pl', 2020);

    // By keyword alone: P1_001N, P3_001N, P1_002N, P1_009N, P1_003N.
    expect(result.variables.map((v) => v.code)).toEqual([
      'P1_001N',
      'P1_002N',
      'P1_003N',
      'P1_009N',
      'P3_001N',
    ]);
    expect(result.totalMatches).toBe(5);
  });

  it('drops a most-words keyword fallback once the code itself matched', async () => {
    serve({ '/data/2020/dec/pl/variables.json': decPlCodeInConceptJson });

    const result = await search('P1_001N', 'dec/pl', 2020);

    expect(result.variables.map((v) => v.code)).toEqual(['P1_001N']);
    expect(result.totalMatches).toBe(1);
    expect(result.matchedTermCount).toBe(result.termCount);
  });

  it('gives a letter-only code the code tier when no keyword match holds its column', async () => {
    serve({ '/data/2023/pep/charv/variables.json': pepCharvLiveJson });

    await expect(codesFor('POPGROUP', 'pep/charv', 2023)).resolves.toEqual(['POPGROUP']);
    await expect(codesFor('popgroup', 'pep/charv', 2023)).resolves.toEqual(['POPGROUP']);
  });

  it('matches a group only where it names a single table', async () => {
    serve({ '/data/2023/pep/charv/variables.json': pepCharvLiveJson });

    // AGE, SEX, POP, and the rest list PEP_ALLDATA among three tables.
    await expect(codesFor('PEP_ALLDATA', 'pep/charv', 2023)).resolves.toEqual(['HISP', 'POPGROUP']);
    await expect(codesFor('PEP_SYASEX,PEP_AGESEX,PEP_ALLDATA', 'pep/charv', 2023)).resolves.toEqual(
      [],
    );
  });

  it('cuts a table at the limit in code order and counts all of it', async () => {
    serve({ '/data/2024/acs/acs5/subject/variables.json': subjectS1701Json });

    const result = await search('S1701', 'acs/acs5/subject', 2024, 4);

    expect(result.variables.map((v) => v.code)).toEqual([
      'S1701_C01_001E',
      'S1701_C01_001M',
      'S1701_C02_001E',
      'S1701_C02_001M',
    ]);
    expect(result.totalMatches).toBe(6);
  });

  it('matches a whole code only, never a prefix of one', async () => {
    serve({ '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson });

    await expect(codesFor('B1901')).resolves.toEqual([]);
    await expect(codesFor('B19013_001')).resolves.toEqual([]);
  });
});

describe('VariableCacheService.searchVariables — why a code matched nothing (#63)', () => {
  const notHeld = () =>
    new Response(TOMCAT_404, { status: 404, headers: { 'content-type': 'text/html' } });
  const paths = () => requestedUrls.map((url) => new URL(url).pathname);
  const search = (query: string, ctx = createMockContext()) =>
    service.searchVariables({ query, dataset: 'acs/acs5', year: 2024, limit: 20 }, ctx);

  it('names the sibling that holds a variable code, after one lookup', async () => {
    serve({
      '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson,
      '/data/2024/acs/acs5/subject/variables/S1701_C03_001E.json': { name: 'S1701_C03_001E' },
    });

    const result = await search('s1701_c03_001e');

    expect(result.variables).toEqual([]);
    expect(result.totalMatches).toBe(0);
    expect(result.codeMiss).toEqual({
      kind: 'sibling',
      code: 'S1701_C03_001E',
      sibling: 'acs/acs5/subject',
    });
    expect(paths()).toEqual([
      '/data/2024/acs/acs5/variables.json',
      '/data/2024/acs/acs5/subject/variables/S1701_C03_001E.json',
    ]);
  });

  it('confirms a table ID against groups/<id>.json, walking past the candidates that lack it', async () => {
    serve({
      '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson,
      '/data/2024/acs/acs5/subject/groups/S0201.json': notHeld(),
      '/data/2024/acs/acs1/subject/groups/S0201.json': notHeld(),
      '/data/2024/acs/acs1/spp/groups/S0201.json': { variables: {} },
    });

    const result = await search('S0201');

    expect(result.codeMiss).toEqual({ kind: 'sibling', code: 'S0201', sibling: 'acs/acs1/spp' });
    expect(paths()).toEqual([
      '/data/2024/acs/acs5/variables.json',
      '/data/2024/acs/acs5/subject/groups/S0201.json',
      '/data/2024/acs/acs1/subject/groups/S0201.json',
      '/data/2024/acs/acs1/spp/groups/S0201.json',
    ]);
  });

  it('names an attribute column the dataset lists without a lookup', async () => {
    serve({ '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson });

    const result = await search('b19013_001ea');

    expect(result.variables).toEqual([]);
    expect(result.codeMiss).toEqual({ kind: 'attribute', code: 'B19013_001EA' });
    expect(paths()).toEqual(['/data/2024/acs/acs5/variables.json']);
  });

  it('reports a code no candidate holds, after asking each', async () => {
    serve({
      '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson,
      '/data/2024/acs/acs5/subject/variables/S9999_C99_999E.json': notHeld(),
      '/data/2024/acs/acs1/subject/variables/S9999_C99_999E.json': notHeld(),
      '/data/2024/acs/acs1/spp/variables/S9999_C99_999E.json': notHeld(),
    });

    const result = await search('S9999_C99_999E');

    expect(result.codeMiss).toEqual({ kind: 'absent', code: 'S9999_C99_999E' });
    expect(paths()).toHaveLength(4);
  });

  it('reports a code with no sibling row without sending a lookup', async () => {
    serve({ '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson });

    await expect(search('NOPE_1')).resolves.toMatchObject({
      variables: [],
      codeMiss: { kind: 'absent', code: 'NOPE_1' },
    });
    expect(paths()).toEqual(['/data/2024/acs/acs5/variables.json']);
  });

  it('answers a failed lookup with the empty result, once and unretried', async () => {
    serve({
      '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson,
      '/data/2024/acs/acs5/subject/groups/S1701.json': new Response('unavailable', {
        status: 503,
        headers: { 'content-type': 'text/plain' },
      }),
    });

    const result = await search('S1701');

    expect(result).toMatchObject({
      variables: [],
      totalMatches: 0,
      codeMiss: { kind: 'absent', code: 'S1701' },
    });
    expect(paths()).toEqual([
      '/data/2024/acs/acs5/variables.json',
      '/data/2024/acs/acs5/subject/groups/S1701.json',
    ]);
  });

  it('sends no lookup and reports no code for a plain word that matched nothing', async () => {
    serve({ '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson });

    for (const query of ['xyzzy', 'POPGROUP', 'xyzzy B19013']) {
      const result = await search(query);
      expect(result.variables).toEqual([]);
      expect(result).not.toHaveProperty('codeMiss');
    }
    expect(paths()).toEqual(['/data/2024/acs/acs5/variables.json']);
  });

  it('reports no code for a number or a hyphenated word, which no Census code is shaped like', async () => {
    serve({ '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson });

    for (const query of ['2020', '65', '1st', 'covid-19']) {
      const result = await search(query);
      expect(result.variables).toEqual([]);
      expect(result).not.toHaveProperty('codeMiss');
    }
    expect(paths()).toEqual(['/data/2024/acs/acs5/variables.json']);
  });

  it("rethrows the caller's cancellation mid-lookup instead of answering", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL, init?: RequestInit) => {
        const href = String(url);
        requestedUrls.push(href);
        if (new URL(href).pathname === '/data/2024/acs/acs5/variables.json') {
          return Promise.resolve(
            new Response(JSON.stringify(acsSearchVariablesJson), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        // Every lookup hangs until its signal aborts.
        return new Promise((_, reject) => {
          if (init?.signal?.aborted) return reject(init.signal.reason);
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        });
      }),
    );
    const controller = new AbortController();

    const pending = search('S1701_C03_001E', createMockContext({ signal: controller.signal })).then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(paths()).toHaveLength(2));
    controller.abort();

    await expect(pending).resolves.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(paths()).toEqual([
      '/data/2024/acs/acs5/variables.json',
      '/data/2024/acs/acs5/subject/variables/S1701_C03_001E.json',
    ]);
  });

  it('names the sibling for a code whose year is also a word of some label', async () => {
    // "2024" is a word of every income label, so by keyword the code matches 1 of its 3 words.
    serve({
      '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson,
      '/data/2024/acs/acs5/cprofile/variables/CP03_2024_062E.json': { name: 'CP03_2024_062E' },
    });

    const result = await search('CP03_2024_062E');

    expect(result.variables).toEqual([]);
    expect(result.totalMatches).toBe(0);
    expect(result.codeMiss).toEqual({
      kind: 'sibling',
      code: 'CP03_2024_062E',
      sibling: 'acs/acs5/cprofile',
    });
  });

  /**
   * A comparison profile lists its significance columns only as attributes, in mixed case, so a
   * code typed in any case has to reach the attributes index in the dataset's own spelling.
   */
  it.each(['cp03_2024to2019_062ss', 'CP03_2024TO2019_062SS'])(
    'names the significance column %j in the spelling the comparison profile publishes',
    async (query) => {
      serve({ '/data/2024/acs/acs5/cprofile/variables.json': cprofileVariablesJson });

      const result = await service.searchVariables(
        { query, dataset: 'acs/acs5/cprofile', year: 2024, limit: 20 },
        createMockContext(),
      );

      expect(result.variables).toEqual([]);
      expect(result.totalMatches).toBe(0);
      expect(result.codeMiss).toEqual({ kind: 'attribute', code: 'CP03_2024to2019_062SS' });
      expect(paths()).toEqual(['/data/2024/acs/acs5/cprofile/variables.json']);
    },
  );

  it('names an attribute column whose year is also a word of some label, without a lookup', async () => {
    serve({ '/data/2024/acs/acs5/variables.json': acsWithYearAttributeJson });

    // Split into words, it is b19013, 2024, and 001ea; "2024" is a word of the label beside it.
    const result = await search('B19013_2024_001EA');

    expect(result.variables).toEqual([]);
    expect(result.codeMiss).toEqual({ kind: 'attribute', code: 'B19013_2024_001EA' });
    expect(paths()).toEqual(['/data/2024/acs/acs5/variables.json']);
  });

  it('keeps the most-words keyword results for a code-shaped query no sibling holds', async () => {
    serve({
      '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson,
      '/data/2024/acs/acs5/cprofile/variables/CP03_2024_999E.json': notHeld(),
      '/data/2024/acs/acs1/cprofile/variables/CP03_2024_999E.json': notHeld(),
    });

    const result = await search('CP03_2024_999E');

    // The labels holding "2024", one of the query's three words.
    expect(result.variables.map((v) => v.code)).toEqual([
      'B19301_001E',
      'B19301_001M',
      'B19013_001E',
      'B19013_001M',
      'B19013B_001E',
      'B19013B_001M',
      'B22008_001E',
      'B22008_001M',
    ]);
    expect(result).toMatchObject({ totalMatches: 8, matchedTermCount: 1, termCount: 3 });
    expect(result).not.toHaveProperty('codeMiss');
    // Both comparison profiles were asked before the keyword results were kept.
    expect(paths()).toEqual([
      '/data/2024/acs/acs5/variables.json',
      '/data/2024/acs/acs5/cprofile/variables/CP03_2024_999E.json',
      '/data/2024/acs/acs1/cprofile/variables/CP03_2024_999E.json',
    ]);
  });

  it('reads a code wrapped in quotes, backticks, or trailing punctuation as the code', async () => {
    serve({ '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson });

    for (const query of ['`B19013`', '"B19013"', 'B19013,']) {
      const result = await search(query);
      expect(result.variables.map((v) => v.code)).toEqual(['B19013_001E', 'B19013_001M']);
    }
    await expect(search('"b19013_001e".')).resolves.toMatchObject({
      variables: [expect.objectContaining({ code: 'B19013_001E' })],
    });
    expect(paths()).toEqual(['/data/2024/acs/acs5/variables.json']);
  });
});

/** acs/acs5 with an attribute column whose name holds a word ("2024") of the labels beside it. */
const acsWithYearAttributeJson = {
  variables: {
    B19013_001E: {
      label:
        'Estimate!!Median household income in the past 12 months (in 2024 inflation-adjusted dollars)',
      concept: 'Median Household Income in the Past 12 Months (in 2024 Inflation-Adjusted Dollars)',
      predicateType: 'int',
      group: 'B19013',
      attributes: 'B19013_001EA,B19013_2024_001EA',
    },
  },
};

describe('VariableCacheService.searchVariables — a letter-only code leads its keyword matches only when typed as spelled (#63)', () => {
  const ecnbasicBenefitJson = {
    variables: {
      BENPEB: {
        label: "Employer's cost for employee benefit plans ($1,000)",
        predicateType: 'int',
        group: 'EC2231BASIC',
      },
      BENEFIT: {
        label: 'Total fringe benefits ($1,000)',
        predicateType: 'int',
        group: 'EC2231BASIC,EC2221BASIC',
      },
    },
  };

  it('puts the column first when its own code is not among the keyword matches', async () => {
    serve({ '/data/2022/ecnbasic/variables.json': ecnbasicBenefitJson });

    const result = await service.searchVariables(
      { query: 'BENEFIT', dataset: 'ecnbasic', year: 2022, limit: 20 },
      createMockContext(),
    );

    // "benefit" is a word of BENPEB's label only; BENEFIT's says "benefits".
    expect(result.variables.map((v) => v.code)).toEqual(['BENEFIT', 'BENPEB']);
    expect(result.totalMatches).toBe(2);
  });

  it('keeps a lowercase word that matched a keyword out of the code tier', async () => {
    serve({ '/data/2022/ecnbasic/variables.json': ecnbasicBenefitJson });

    const result = await service.searchVariables(
      { query: 'benefit', dataset: 'ecnbasic', year: 2022, limit: 20 },
      createMockContext(),
    );

    expect(result.variables.map((v) => v.code)).toEqual(['BENPEB']);
    expect(result).toMatchObject({ totalMatches: 1, codeMatches: 0 });
  });

  /** dec/dhc 2020 as published: STATE is labelled "Geography", so no keyword search reaches it. */
  const decDhcStateJson = {
    variables: {
      STATE: { label: 'Geography', group: 'N/A', limit: 0 },
      PCT19_008N: {
        label:
          ' !!Total:!!Male:!!Under 18 years:!!Institutionalized population (101-106, 201-203, 301, 401-405):!!Correctional facilities for adults (101-106):!!State prisons (103)',
        concept: 'GROUP QUARTERS POPULATION BY SEX BY AGE BY GROUP QUARTERS TYPE',
        predicateType: 'int',
        group: 'PCT19',
      },
      PCT19_040N: {
        label:
          ' !!Total:!!Male:!!18 to 64 years:!!Institutionalized population (101-106, 201-203, 301, 401-405):!!Correctional facilities for adults (101-106):!!State prisons (103)',
        concept: 'GROUP QUARTERS POPULATION BY SEX BY AGE BY GROUP QUARTERS TYPE',
        predicateType: 'int',
        group: 'PCT19',
      },
    },
  };
  const searchDhc = (query: string) =>
    service.searchVariables(
      { query, dataset: 'dec/dhc', year: 2020, limit: 20 },
      createMockContext(),
    );

  it.each(['state', 'State', '"state"'])(
    'answers %j with its keyword matches alone, leaving the STATE column out',
    async (query) => {
      serve({ '/data/2020/dec/dhc/variables.json': decDhcStateJson });

      const result = await searchDhc(query);

      expect(result.variables.map((v) => v.code)).toEqual(['PCT19_008N', 'PCT19_040N']);
      expect(result).toMatchObject({ totalMatches: 2, codeMatches: 0 });
    },
  );

  it.each(['STATE', '"STATE"'])(
    'puts the STATE column ahead of the keyword matches for %j, typed as the code is spelled',
    async (query) => {
      serve({ '/data/2020/dec/dhc/variables.json': decDhcStateJson });

      const result = await searchDhc(query);

      expect(result.variables.map((v) => v.code)).toEqual(['STATE', 'PCT19_008N', 'PCT19_040N']);
      expect(result).toMatchObject({ totalMatches: 3, codeMatches: 1 });
    },
  );
});

describe('VariableCacheService.searchVariables — how many results the code matched (#63)', () => {
  it('counts the code tier apart from the keyword matches', async () => {
    serve({
      '/data/2024/acs/acs5/subject/variables.json': subjectS1701Json,
      '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson,
    });
    const search = (query: string, dataset: string) =>
      service.searchVariables({ query, dataset, year: 2024, limit: 4 }, createMockContext());

    await expect(search('S1701', 'acs/acs5/subject')).resolves.toMatchObject({
      totalMatches: 6,
      codeMatches: 6,
    });
    await expect(search('income', 'acs/acs5')).resolves.toMatchObject({ codeMatches: 0 });
  });
});
