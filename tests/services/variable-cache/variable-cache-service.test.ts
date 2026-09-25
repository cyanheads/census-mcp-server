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
  describeUnsetPredicates,
  getVariableCacheService,
  initVariableCacheService,
  isAcsDataset,
  KNOWN_DATASETS,
  resolveDataset,
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

describe('VariableCacheService.findPublicationProbe', () => {
  /**
   * A wildcard group-by only reads the data file when a measure is in `get=`, and how many codes
   * come back depends on which table that measure belongs to: on dec/ddhca the total-population
   * table publishes far more population groups than the sex-by-age tables do. The coarsest table
   * gives the widest set, and cell count is what identifies it.
   */
  it('picks a measure from the coarsest table', async () => {
    queue({
      variables: {
        T01001_001N: { label: 'Total', predicateType: 'int', group: 'T01001' },
        T02003_001N: { label: 'Total', predicateType: 'int', group: 'T02003' },
        T02003_002N: { label: 'Male', predicateType: 'int', group: 'T02003' },
        T02003_003N: { label: 'Female', predicateType: 'int', group: 'T02003' },
        POPGROUP: {
          label: 'Race/Ethnic Group',
          required: 'default displayed',
          predicateType: 'string',
          group: 'T01001,T02003',
        },
        SUMLEVEL: { label: 'Summary Level code', predicateType: 'string', group: 'N/A' },
      },
    });

    const probe = await service.findPublicationProbe('dec/ddhca', 2020, createMockContext());

    expect(probe).toBe('T01001_001N');
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

    const probe = await service.findPublicationProbe('nonemp', 2007, createMockContext());

    expect(probe).toBeUndefined();
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
    );

    expect(text).toContain('until NAICS2022 is set');
    expect(text).toContain('{"NAICS2022": "<code>"}');
  });

  /**
   * An unknown predicate value is a 204, not a 400, so an empty result can come from a value
   * the caller supplied rather than from a dimension it left out.
   */
  it('points at the supplied values too, since a bad one returns nothing rather than erroring', () => {
    const text = describeEmptyPredicatedResult([], ['NAICS2017'], 'cbp', 2023);

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
    );

    expect(text).toContain('NAICS2022, TAXSTAT, and TYPOP are set');
    expect(text).not.toContain('and TAXSTAT and');
  });

  it('returns nothing when the dataset has no predicates in play', () => {
    expect(describeEmptyPredicatedResult([], [], 'acs/acs5', 2024)).toBe('');
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
  ])('never resolves the third segment %j, and names the codes ending in it', (input, codes) => {
    const error = rejectionOf(input);

    expect(error?.data).toMatchObject({ reason: 'dataset_not_found', dataset: input });
    for (const code of codes) expect(error?.message).toContain(code);
  });

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
    expect(error?.message).toContain('2012-2023');
    const data = error?.data as { recovery: { hint: string }; availableYears: number[] };
    expect(data.recovery.hint).toContain('2012-2023');
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
    expect(data.recovery.hint).toContain("error: unknown variable 'NAME'");
    expect(data.recovery.hint).toMatch(/rejected/i);
    expect(data.recovery.hint).not.toMatch(/^Retry/);
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
    expect((error.data as { recovery: { hint: string } }).recovery.hint).toMatch(/^Retry/);
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
    const text = describeAmbiguousRows('cbp', 2023, 1552, { NAICS2017: naics });

    expect(text).toContain('NAICS2017');
    expect(text).toContain('1,542 more');
    expect(text.length).toBeLessThan(1500);
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

  /** Every other count in the notices is grouped ("1,542 more"), so the row count is too. */
  it('groups the thousands of a per-geography row count', () => {
    const split = { NAICS2017: naics };
    for (const text of [
      describeRecordRows('cbp', 2023, 1552, split, ['NAICS2017']),
      describeRecordRows('cbp', 2023, 1552, split),
      describeRecordRows('cbp', 2023, 1552, {}),
      describeAmbiguousRows('cbp', 2023, 1552, split),
      describeAmbiguousRows('cbp', 2023, 1552, {}),
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

/**
 * Serve bodies by URL path, recording each request, for the lookups that reach more than one
 * endpoint per dataset. A path with no route fails the request, so an unexpected fetch surfaces.
 */
const serve = (routes: Record<string, unknown>) => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string | URL) => {
      const href = String(url);
      requestedUrls.push(href);
      const body = routes[new URL(href).pathname];
      if (body === undefined) return Promise.reject(new Error(`unrouted fetch: ${href}`));
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
      expect(result).toEqual({ variables: [], totalMatches: 0, matchedTermCount: 0, termCount: 0 });
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

  it('refuses a code in neither the variable map nor the attributes index without a request', async () => {
    serve(acsRoutes);

    await expect(lookup(['B19013_001XA', 'B19013_001EA'])).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'variable_not_found', missingCodes: ['B19013_001XA'] },
    });
    expect(requestedUrls.filter((url) => url.includes('/variables/'))).toEqual([]);
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
  });

  it('sends no groups.json request for columns that belong to no single table', async () => {
    serve({ '/data/2024/acs/acs5/variables.json': acsSearchVariablesJson });

    const [geoId, name] = await lookup(['GEO_ID', 'NAME']);

    expect(geoId).not.toHaveProperty('universe');
    expect(name).not.toHaveProperty('universe');
    expect(requestsTo('/groups.json')).toEqual([]);
  });
});
