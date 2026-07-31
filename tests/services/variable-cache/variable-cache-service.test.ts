/**
 * @fileoverview Tests for VariableCacheService — the ACS-scoped margin-of-error inference,
 * required-predicate reporting, and the dataset/code validation the tools depend on.
 * @module tests/services/variable-cache/variable-cache-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DATASET_LATEST_YEARS,
  describeEmptyPredicatedResult,
  describeUnsetPredicates,
  getVariableCacheService,
  initVariableCacheService,
  isAcsDataset,
  KNOWN_DATASETS,
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

/** Bodies handed out in call order; a request past the end sees an empty variables map. */
let responses: unknown[] = [];
let requestedUrls: string[] = [];

const queue = (...bodies: unknown[]) => {
  responses = bodies;
};

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
  it.each(['acs/acs5', 'acs/acs5/profile', 'acs/acs5/subject', 'acs/acs1', 'acs/acs1/profile'])(
    'treats %s as ACS',
    (dataset) => {
      expect(isAcsDataset(dataset)).toBe(true);
    },
  );

  it.each(['pep/charv', 'dec/pl', 'dec/ddhca', 'cbp', 'ecnbasic', 'nonemp'])(
    'treats %s as non-ACS',
    (dataset) => {
      expect(isAcsDataset(dataset)).toBe(false);
    },
  );

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
