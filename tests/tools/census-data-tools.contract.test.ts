/**
 * @fileoverview Contract tests for census_query_data and census_compare_geographies, run through
 * the real CensusApiService and VariableCacheService over a strict fetch fake. Response parsing,
 * the column plan, and error classification all sit inside the tools here, so these tests exercise
 * them on both client surfaces rather than a stubbed service's return value.
 * @module tests/tools/census-data-tools.contract.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { censusCompareGeographies } from '@/mcp-server/tools/definitions/census-compare-geographies.tool.js';
import { censusQueryData } from '@/mcp-server/tools/definitions/census-query-data.tool.js';
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

type Body = unknown[][] | Record<string, unknown> | Response;

interface Route {
  match: (url: URL) => boolean;
  respond: (url: URL) => Body;
}

let routes: Route[] = [];
let calls: URL[] = [];

beforeEach(() => {
  routes = [];
  calls = [];
  initCensusApiService();
  initVariableCacheService();
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL) => {
      const url = new URL(String(input));
      calls.push(url);
      const route = routes.find((r) => r.match(url));
      if (!route) return Promise.reject(new Error(`unmocked fetch: ${url.pathname}`));
      const body = route.respond(url);
      return Promise.resolve(
        body instanceof Response
          ? body
          : new Response(JSON.stringify(body), {
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

const at = (dataset: string, year: number) => `/data/${year}/${dataset}`;

/** Serve a dataset's variables.json and a geography.json with state, county, and tract. */
const serveMetadata = (dataset: string, year: number, variables: Record<string, unknown>) => {
  routes.push(
    {
      match: (u) => u.pathname === `${at(dataset, year)}/variables.json`,
      respond: () => ({ variables }),
    },
    {
      match: (u) => u.pathname === `${at(dataset, year)}/geography.json`,
      respond: () => ({
        fips: [
          { name: 'us', geoLevelDisplay: '010' },
          { name: 'state', geoLevelDisplay: '040' },
          {
            name: 'county',
            geoLevelDisplay: '050',
            requires: ['state'],
            wildcard: ['state'],
            optionalWithWCFor: 'state',
          },
          {
            name: 'tract',
            geoLevelDisplay: '140',
            requires: ['state', 'county'],
            wildcard: ['county'],
            optionalWithWCFor: 'county',
          },
        ],
      }),
    },
  );
};

/** Serve the data endpoint itself. */
const serveData = (dataset: string, year: number, respond: (url: URL) => Body) => {
  routes.push({ match: (u) => u.pathname === at(dataset, year), respond });
};

/** The data requests that went out (metadata requests excluded). */
const dataCalls = (dataset: string, year: number) =>
  calls.filter((u) => u.pathname === at(dataset, year));

const getList = (url: URL | undefined) => (url?.searchParams.get('get') ?? '').split(',');

const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((c) => c.text ?? '').join('\n');

const structured = (result: { structuredContent?: unknown }) =>
  result.structuredContent as {
    rows: Array<{
      geography_name: string;
      geography_geoid: string;
      rank?: number;
      record?: Record<string, { code: string; label: string }>;
      applied_filters?: Record<string, string>;
      variables: Record<
        string,
        {
          estimate: number | null;
          moe?: number | null;
          label: string;
          suppressed: boolean;
          suppression_reason?: string;
          open_ended?: boolean;
          flag?: { code: string; meaning: string };
          value?: string;
        }
      >;
    }>;
    notice?: string;
    sortVariable?: string;
  };

const errorOf = (result: { structuredContent?: unknown }) =>
  (
    result.structuredContent as {
      error: { code: number; message: string; data: Record<string, unknown> };
    }
  ).error;

const acsVariables = {
  B01003_001E: { label: 'Estimate!!Total', concept: 'Total Population', predicateType: 'int' },
  B19013_001E: {
    label: 'Estimate!!Median household income in the past 12 months',
    concept: 'Median Household Income',
    predicateType: 'int',
    attributes: 'B19013_001EA,B19013_001M,B19013_001MA',
  },
  GEOCOMP: { label: 'GEO_ID Component', required: 'default displayed', predicateType: 'string' },
};

// ---------------------------------------------------------------------------------------------
// #37 — ACS sentinel values
// ---------------------------------------------------------------------------------------------

describe('ACS sentinel values reach both surfaces with the Census meaning', () => {
  it('census_query_data reads a controlled-estimate MOE as zero', async () => {
    serveMetadata('acs/acs5', 2024, acsVariables);
    serveData('acs/acs5', 2024, () => [
      ['NAME', 'B01003_001E', 'B01003_001M', 'state', 'county'],
      ['King County, Washington', '2287171', '-555555555', '53', '033'],
    ]);

    const result = await runToolContract(censusQueryData, {
      variables: ['B01003_001E', 'B01003_001M'],
      geography_level: 'county',
      geography_fips: '033',
      parent_fips: '53',
    });

    const v = structured(result).rows[0]?.variables ?? {};
    expect(v.B01003_001E).toMatchObject({ estimate: 2287171, moe: 0, suppressed: false });
    expect(v.B01003_001M).toMatchObject({ estimate: 0, suppressed: false });
    expect(v.B01003_001M?.suppression_reason).toBeUndefined();
    const text = textOf(result);
    expect(text).toContain('**B01003_001E:** 2,287,171 ± 0');
    expect(text).not.toContain('Suppressed');
  });

  it('census_query_data gives a float sentinel the same reason as its integer form', async () => {
    serveMetadata('acs/acs5/subject', 2024, {
      S1701_C03_001E: { label: 'Percent below poverty level', predicateType: 'float' },
      S1903_C03_001E: { label: 'Median income (dollars)', predicateType: 'int' },
      GEOCOMP: {
        label: 'GEO_ID Component',
        required: 'default displayed',
        predicateType: 'string',
      },
    });
    serveData('acs/acs5/subject', 2024, () => [
      ['NAME', 'S1701_C03_001E', 'S1903_C03_001E', 'state', 'county', 'tract'],
      [
        'Census Tract 9901; King County; Washington',
        '-666666666.0',
        '-666666666',
        '53',
        '033',
        '990100',
      ],
    ]);

    const result = await runToolContract(censusQueryData, {
      variables: ['S1701_C03_001E', 'S1903_C03_001E'],
      geography_level: 'tract',
      geography_fips: '990100',
      parent_fips: '53',
      county_fips: '033',
      dataset: 'acs/acs5/subject',
    });

    const v = structured(result).rows[0]?.variables ?? {};
    const reason = v.S1903_C03_001E?.suppression_reason;
    expect(reason).toMatch(/too few sample observations/i);
    expect(v.S1701_C03_001E?.suppression_reason).toBe(reason);
    expect(textOf(result).split(`Suppressed (${reason})`)).toHaveLength(3);
  });

  it('census_query_data marks a top-coded median open-ended on both surfaces', async () => {
    serveMetadata('acs/acs5', 2024, acsVariables);
    serveData('acs/acs5', 2024, () => [
      ['NAME', 'B19013_001E', 'B19013_001M', 'state', 'county', 'tract'],
      [
        'Census Tract 41.01; King County; Washington',
        '250001',
        '-333333333',
        '53',
        '033',
        '004101',
      ],
    ]);

    const result = await runToolContract(censusQueryData, {
      variables: ['B19013_001E', 'B19013_001M'],
      geography_level: 'tract',
      geography_fips: '004101',
      parent_fips: '53',
      county_fips: '033',
    });

    const v = structured(result).rows[0]?.variables ?? {};
    expect(v.B19013_001E).toMatchObject({ estimate: 250001, open_ended: true, suppressed: false });
    expect(v.B19013_001M?.suppressed).toBe(true);
    expect(v.B19013_001M?.suppression_reason).toMatch(/open-ended/i);
    expect(textOf(result)).toMatch(/\*\*B19013_001E:\*\* 250,001 \(open-ended/);
  });

  /**
   * The captured King County tract ranking: 20 tracts share the `250001` top code, and two cannot
   * be computed at all. Rows here are a slice of that response.
   */
  const tractRows = [
    ['NAME', 'B19013_001E', 'B19013_001M', 'state', 'county', 'tract'],
    [
      'Census Tract 118.02; King County; Washington',
      '-666666666',
      '-222222222',
      '53',
      '033',
      '011802',
    ],
    ['Census Tract 1.01; King County; Washington', '69577', '14341', '53', '033', '000101'],
    ['Census Tract 41.01; King County; Washington', '250001', '-333333333', '53', '033', '004101'],
    ['Census Tract 1.02; King County; Washington', '89840', '23009', '53', '033', '000102'],
    ['Census Tract 62; King County; Washington', '250001', '-333333333', '53', '033', '006200'],
  ];

  it.each(['desc', 'asc'] as const)(
    'census_compare_geographies carries the reason and ranks the suppressed row last (%s)',
    async (sortDir) => {
      serveMetadata('acs/acs5', 2024, acsVariables);
      serveData('acs/acs5', 2024, () => tractRows);

      const result = await runToolContract(censusCompareGeographies, {
        variables: ['B19013_001E', 'B19013_001M'],
        geography_level: 'tract',
        within: '53',
        within_county: '033',
        sort_dir: sortDir,
      });

      const rows = structured(result).rows;
      expect(rows.at(-1)?.geography_name).toBe('Census Tract 118.02; King County; Washington');
      expect(rows.at(-1)?.variables.B19013_001E?.suppression_reason).toMatch(
        /too few sample observations/i,
      );
      expect(rows.at(-1)?.variables.B19013_001M?.suppression_reason).toMatch(/margin of error/i);
      const order = rows.map((r) => r.variables.B19013_001E?.estimate);
      expect(order).toEqual(
        sortDir === 'desc'
          ? [250001, 250001, 89840, 69577, null]
          : [69577, 89840, 250001, 250001, null],
      );
      const topCoded = rows.filter((r) => r.variables.B19013_001E?.estimate === 250001);
      expect(topCoded.every((r) => r.variables.B19013_001E?.open_ended === true)).toBe(true);
      expect(
        rows.find((r) => r.variables.B19013_001E?.estimate === 69577)?.variables.B19013_001E
          ?.open_ended,
      ).toBeUndefined();

      const text = textOf(result);
      expect(text).toMatch(/\*\*B19013_001E:\*\* Suppressed \(.*too few sample observations/i);
      expect(text).toMatch(/250,001 \(open-ended/);
    },
  );
});

// ---------------------------------------------------------------------------------------------
// #45 — unknown variables and case
// ---------------------------------------------------------------------------------------------

describe('an unknown variable code is variable_not_found, and case is normalized', () => {
  const rejectUnknown = (code: string) => () =>
    new Response(`error: unknown variable '${code}'`, {
      status: 400,
      headers: { 'content-type': 'text/plain' },
    });

  it.each([
    ['census_query_data', censusQueryData, { geography_fips: '033', parent_fips: '53' }],
    ['census_compare_geographies', censusCompareGeographies, { within: '53' }],
  ] as const)(
    '%s reports it as NotFound and points at variable search',
    async (_name, definition, scope) => {
      serveMetadata('acs/acs5', 2024, acsVariables);
      serveData('acs/acs5', 2024, rejectUnknown('B19013_001X'));

      const result = await runToolContract(
        definition as typeof censusQueryData,
        {
          variables: ['B19013_001X'],
          geography_level: 'county',
          ...scope,
        } as never,
      );

      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data).toMatchObject({
        reason: 'variable_not_found',
        missingCodes: ['B19013_001X'],
      });
      expect(error.message).toContain('B19013_001X');
      const text = textOf(result);
      expect(text).toContain('census_search_variables');
      expect(text).toContain('reason variable_not_found');
      expect(text).not.toMatch(/(^|\W)retryable/);
      expect(dataCalls('acs/acs5', 2024)).toHaveLength(1);
    },
  );

  it('census_query_data uppercases codes and keys the response by the canonical code', async () => {
    serveMetadata('acs/acs5', 2024, acsVariables);
    serveData('acs/acs5', 2024, () => [
      ['NAME', 'B19013_001E', 'B19013_001M', 'GEO_ID', 'state', 'county'],
      ['King County, Washington', '122148', '1808', '0500000US53033', '53', '033'],
    ]);

    const result = await runToolContract(censusQueryData, {
      variables: ['b19013_001e', ' B19013_001m ', 'geo_id'],
      geography_level: 'county',
      geography_fips: '033',
      parent_fips: '53',
    });

    expect(getList(dataCalls('acs/acs5', 2024)[0])).toEqual([
      'NAME',
      'B19013_001E',
      'B19013_001M',
      'GEO_ID',
    ]);
    const v = structured(result).rows[0]?.variables ?? {};
    expect(Object.keys(v)).toEqual(['B19013_001E', 'B19013_001M', 'GEO_ID']);
    expect(v.B19013_001E).toMatchObject({
      estimate: 122148,
      moe: 1808,
      label: 'Estimate!!Median household income in the past 12 months',
    });
  });

  /**
   * `B19013_001EA` is accepted by the data API but has no `variables.json` entry. Before, its miss
   * failed the whole label lookup and every code in the response lost its label.
   */
  it('census_query_data keeps each label when an annotation column rides along', async () => {
    serveMetadata('acs/acs5', 2024, acsVariables);
    serveData('acs/acs5', 2024, () => [
      ['NAME', 'B19013_001E', 'B19013_001M', 'B19013_001EA', 'state', 'county'],
      ['King County, Washington', '122148', '1808', null, '53', '033'],
    ]);

    const result = await runToolContract(censusQueryData, {
      variables: ['B19013_001E', 'B19013_001M', 'b19013_001ea'],
      geography_level: 'county',
      geography_fips: '033',
      parent_fips: '53',
    });

    const v = structured(result).rows[0]?.variables ?? {};
    expect(v.B19013_001E?.label).toBe('Estimate!!Median household income in the past 12 months');
    expect(v.B19013_001M?.label).toContain('Margin of Error');
    expect(v.B19013_001EA?.label).toBe('B19013_001EA');
    expect(textOf(result)).toContain('*Estimate!!Median household income in the past 12 months*');
  });

  it('census_compare_geographies ranks by a lowercase sort_by as its canonical code', async () => {
    serveMetadata('acs/acs5', 2024, acsVariables);
    serveData('acs/acs5', 2024, () => [
      ['NAME', 'B19013_001E', 'state'],
      ['Alabama', '62027', '01'],
      ['Alaska', '95665', '02'],
      ['Arizona', '77315', '04'],
    ]);

    const result = await runToolContract(censusCompareGeographies, {
      variables: ['b19013_001e'],
      geography_level: 'state',
      sort_by: 'b19013_001e',
    });

    const out = structured(result);
    expect(out.rows.map((r) => r.geography_name)).toEqual(['Alaska', 'Arizona', 'Alabama']);
    expect(out.rows[0]?.variables.B19013_001E?.estimate).toBe(95665);
    expect(out.sortVariable).toBe('B19013_001E');
  });
});

// ---------------------------------------------------------------------------------------------
// #46 — the 50-column get= limit
// ---------------------------------------------------------------------------------------------

describe('the Census 50-column limit is enforced before the data request', () => {
  const codes = (n: number) =>
    Array.from({ length: n }, (_, i) => `B01001_${String(i + 1).padStart(3, '0')}E`);

  it.each([
    ['census_query_data', censusQueryData, { geography_fips: '53' }],
    ['census_compare_geographies', censusCompareGeographies, {}],
  ] as const)(
    '%s refuses 50 ACS codes, which with NAME is 51 columns',
    async (_name, definition, scope) => {
      serveMetadata('acs/acs5', 2024, acsVariables);
      serveData('acs/acs5', 2024, () => [
        ['NAME', 'state'],
        ['Washington', '53'],
      ]);

      const result = await runToolContract(
        definition as typeof censusQueryData,
        {
          variables: codes(50),
          geography_level: 'state',
          ...scope,
        } as never,
      );

      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toMatchObject({
        reason: 'too_many_variables',
        maxVariables: 49,
        requested: 50,
      });
      expect(error.message).toContain('49');
      expect(textOf(result)).toMatch(/at most 49/);
      expect(dataCalls('acs/acs5', 2024)).toHaveLength(0);
    },
  );

  it('census_query_data sends 49 ACS codes', async () => {
    serveMetadata('acs/acs5', 2024, acsVariables);
    serveData('acs/acs5', 2024, (url) => {
      const header = getList(url);
      return [
        [...header, 'state'],
        ['Washington', ...header.slice(1).map(() => '1'), '53'],
      ];
    });

    const result = await runToolContract(censusQueryData, {
      variables: codes(49),
      geography_level: 'state',
      geography_fips: '53',
    });

    expect(result.isError).toBeFalsy();
    expect(getList(dataCalls('acs/acs5', 2024)[0])).toHaveLength(50);
  });

  /** cbp 2023 adds a label column for every filter dimension the query leaves unset. */
  const cbpVariables = {
    ESTAB: { label: 'Number of establishments', predicateType: 'int', attributes: 'ESTAB_F' },
    EMP: { label: 'Number of employees', predicateType: 'int', attributes: 'EMP_F' },
    PAYANN: { label: 'Annual payroll ($1,000)', predicateType: 'int', attributes: 'PAYANN_F' },
    NAICS2017: {
      label: '2017 NAICS code',
      required: 'default displayed',
      predicateType: 'string',
      attributes: 'NAICS2017_F,NAICS2017_LABEL,NAICS2017_F',
    },
    LFO: {
      label: 'Legal form of organization code',
      required: 'default displayed',
      predicateType: 'string',
      attributes: 'LFO_LABEL',
    },
    EMPSZES: {
      label: 'Employment size of establishments code',
      required: 'default displayed',
      predicateType: 'string',
      attributes: 'EMPSZES_LABEL',
    },
    GEOCOMP: { label: 'GEO_ID Component', required: 'default displayed', predicateType: 'string' },
  };

  it('counts the label columns added for unset dimensions, and names them', async () => {
    serveMetadata('cbp', 2023, cbpVariables);
    serveData('cbp', 2023, () => [
      ['NAME', 'state'],
      ['Washington', '53'],
    ]);

    const result = await runToolContract(censusQueryData, {
      variables: codes(47),
      geography_level: 'state',
      geography_fips: '53',
      dataset: 'cbp',
    });

    const error = errorOf(result);
    expect(error.data).toMatchObject({
      reason: 'too_many_variables',
      maxVariables: 46,
      requested: 47,
    });
    for (const column of ['EMPSZES_LABEL', 'LFO_LABEL', 'NAICS2017_LABEL']) {
      expect(error.message).toContain(column);
    }
    expect(dataCalls('cbp', 2023)).toHaveLength(0);
  });

  /**
   * Flag columns are extras the server adds. When they do not fit, the request still goes out and
   * the response says which values went unchecked — a request that fit before must not fail now.
   */
  it('sends the request without the flag columns that do not fit, and says so', async () => {
    serveMetadata('cbp', 2023, cbpVariables);
    serveData('cbp', 2023, (url) => {
      const header = getList(url);
      return [
        [...header, 'state'],
        ['Washington', ...header.slice(1).map((h) => (h.endsWith('_LABEL') ? 'All' : '5')), '53'],
      ];
    });

    // NAME + 3 label columns + 45 codes = 49, leaving room for one of the three flag columns.
    const result = await runToolContract(censusQueryData, {
      variables: ['ESTAB', 'EMP', 'PAYANN', ...codes(42)],
      geography_level: 'state',
      geography_fips: '53',
      dataset: 'cbp',
    });

    expect(result.isError).toBeFalsy();
    const sent = getList(dataCalls('cbp', 2023)[0]);
    expect(sent).toHaveLength(50);
    expect(sent).toContain('ESTAB_F');
    expect(sent).not.toContain('EMP_F');
    const notice = structured(result).notice ?? '';
    expect(notice).toMatch(/not checked/i);
    expect(notice).toContain('EMP');
    expect(notice).toContain('PAYANN');
    expect(textOf(result)).toMatch(/not checked/i);
  });
});

// ---------------------------------------------------------------------------------------------
// #47 — business-dataset flag columns
// ---------------------------------------------------------------------------------------------

describe('a withheld business-dataset value is reported as withheld, not zero', () => {
  const ecnbasicVariables = {
    ESTAB: { label: 'Number of establishments', predicateType: 'int', attributes: 'ESTAB_F' },
    RCPTOT: {
      label: 'Sales, value of shipments, or revenue ($1,000)',
      predicateType: 'int',
      attributes: 'RCPTOT_F',
    },
    EMP: { label: 'Number of employees', predicateType: 'int', attributes: 'EMP_F' },
    NAICS2022: {
      label: '2022 NAICS code',
      required: 'default displayed',
      predicateType: 'string',
      attributes: 'NAICS2022_F,NAICS2022_LABEL,NAICS2022_F',
    },
    GEOCOMP: { label: 'GEO_ID Component', required: 'default displayed', predicateType: 'string' },
  };

  /** Live `ecnbasic` 2022 hospital rows (NAICS2022=622), trimmed to the columns requested. */
  const hospitalRows = (url: URL) => {
    const rows: Record<string, Record<string, string | null>> = {
      '007': {
        NAME: 'Chelan County, Washington',
        ESTAB: '4',
        RCPTOT: '0',
        RCPTOT_F: 'D',
        EMP: '2955',
        EMP_F: null,
      },
      '033': {
        NAME: 'King County, Washington',
        ESTAB: '25',
        RCPTOT: '14293515',
        RCPTOT_F: null,
        EMP: '54853',
        EMP_F: null,
      },
      '053': {
        NAME: 'Pierce County, Washington',
        ESTAB: '11',
        RCPTOT: '0',
        RCPTOT_F: 'D',
        EMP: '0',
        EMP_F: 'j',
      },
      '057': {
        NAME: 'Skagit County, Washington',
        ESTAB: '3',
        RCPTOT: '504352',
        RCPTOT_F: null,
        EMP: '2472',
        EMP_F: null,
      },
    };
    const header = getList(url);
    const county = url.searchParams.get('for')?.split(':')[1] ?? '*';
    const pick = county === '*' ? Object.keys(rows) : [county];
    return [
      [...header, 'NAICS2022', 'state', 'county'],
      ...pick.map((c) => [...header.map((h) => rows[c]?.[h] ?? null), '622', '53', c]),
    ];
  };

  it('census_query_data reports the flagged receipts as suppressed on both surfaces', async () => {
    serveMetadata('ecnbasic', 2022, ecnbasicVariables);
    serveData('ecnbasic', 2022, hospitalRows);

    const result = await runToolContract(censusQueryData, {
      variables: ['ESTAB', 'RCPTOT', 'EMP'],
      geography_level: 'county',
      geography_fips: '007',
      parent_fips: '53',
      dataset: 'ecnbasic',
      predicates: { NAICS2022: '622' },
    });

    expect(getList(dataCalls('ecnbasic', 2022)[0])).toEqual([
      'NAME',
      'ESTAB',
      'RCPTOT',
      'EMP',
      'ESTAB_F',
      'RCPTOT_F',
      'EMP_F',
    ]);
    const v = structured(result).rows[0]?.variables ?? {};
    expect(v.RCPTOT).toMatchObject({ estimate: null, suppressed: true, flag: { code: 'D' } });
    expect(v.RCPTOT?.suppression_reason).toMatch(/withheld to avoid disclosing/i);
    expect(v.EMP).toMatchObject({ estimate: 2955, suppressed: false });
    expect(v.ESTAB).toMatchObject({ estimate: 4, suppressed: false });
    expect(structured(result).rows[0]?.geography_geoid).toBe('53007');
    const text = textOf(result);
    expect(text).toMatch(/\*\*RCPTOT:\*\* Suppressed \(Withheld to avoid disclosing/);
    expect(text).not.toMatch(/\*\*RCPTOT:\*\* 0/);
  });

  it.each(['desc', 'asc'] as const)(
    'census_compare_geographies never ranks a withheld zero as a number (%s)',
    async (sortDir) => {
      serveMetadata('ecnbasic', 2022, ecnbasicVariables);
      serveData('ecnbasic', 2022, hospitalRows);

      const result = await runToolContract(censusCompareGeographies, {
        variables: ['RCPTOT', 'EMP'],
        geography_level: 'county',
        within: '53',
        dataset: 'ecnbasic',
        predicates: { NAICS2022: '622' },
        sort_dir: sortDir,
      });

      const rows = structured(result).rows;
      const ranked = rows.map((r) => [
        r.geography_name.split(' ')[0],
        r.variables.RCPTOT?.estimate,
      ]);
      expect(ranked.slice(0, 2)).toEqual(
        sortDir === 'desc'
          ? [
              ['King', 14293515],
              ['Skagit', 504352],
            ]
          : [
              ['Skagit', 504352],
              ['King', 14293515],
            ],
      );
      expect(ranked.slice(2).map(([, estimate]) => estimate)).toEqual([null, null]);
      const pierce = rows.find((r) => r.geography_name.startsWith('Pierce'));
      expect(pierce?.variables.EMP?.suppression_reason).toContain('10,000 to 24,999 employees');
      expect(pierce?.variables.RCPTOT?.flag).toMatchObject({ code: 'D' });
      expect(textOf(result)).toMatch(/\*\*EMP:\*\* Suppressed \(.*10,000 to 24,999 employees/);
    },
  );

  /**
   * `RCPTOT_IMP` publishes its answer as a digit band in its flag and `0` in the measure on every
   * row. Ranked as numbers, every county ties at 0 and the Census return order reads as a ranking.
   */
  it('census_compare_geographies does not rank the zeros of a range column', async () => {
    serveMetadata('ecnbasic', 2022, {
      ...ecnbasicVariables,
      RCPTOT_IMP: {
        label: 'Range indicating imputed percentage of total sales, value of shipments, or revenue',
        predicateType: 'int',
        attributes: 'RCPTOT_IMP_F',
      },
    });
    serveData('ecnbasic', 2022, (url) => {
      const header = getList(url);
      const bands: Record<string, string> = { '001': '4', '003': '1', '005': '3' };
      return [
        [...header, 'NAICS2022', 'state', 'county'],
        ...Object.entries(bands).map(([county, band]) => [
          ...header.map((h) =>
            h === 'NAME' ? `County ${county}, Washington` : h === 'RCPTOT_IMP_F' ? band : '0',
          ),
          '62',
          '53',
          county,
        ]),
      ];
    });

    const result = await runToolContract(censusCompareGeographies, {
      variables: ['RCPTOT_IMP'],
      geography_level: 'county',
      within: '53',
      dataset: 'ecnbasic',
      predicates: { NAICS2022: '62' },
    });

    const out = structured(result);
    expect(out.rows.map((r) => r.variables.RCPTOT_IMP?.estimate)).toEqual([null, null, null]);
    expect(out.rows[0]?.variables.RCPTOT_IMP?.flag).toMatchObject({ code: '4' });
    expect(out.notice).toMatch(/not ranked/i);
    expect(textOf(result)).toMatch(/\*\*RCPTOT_IMP:\*\* Suppressed \(.*40% to less than 50%/);
  });
});

// ---------------------------------------------------------------------------------------------
// #41 — blank and "*" predicate values
// ---------------------------------------------------------------------------------------------

describe('predicate values: blank is omitted, "*" is a labelled breakdown', () => {
  const cbpVariables = {
    ESTAB: { label: 'Number of establishments', predicateType: 'int', attributes: 'ESTAB_F' },
    NAICS2017: {
      label: '2017 NAICS code',
      required: 'default displayed',
      predicateType: 'string',
      attributes: 'NAICS2017_F,NAICS2017_LABEL,NAICS2017_F',
    },
    LFO: {
      label: 'Legal form of organization code',
      required: 'default displayed',
      predicateType: 'string',
      attributes: 'LFO_LABEL',
    },
    EMPSZES: {
      label: 'Employment size of establishments code',
      required: 'default displayed',
      predicateType: 'string',
      attributes: 'EMPSZES_LABEL',
    },
    GEOCOMP: { label: 'GEO_ID Component', required: 'default displayed', predicateType: 'string' },
  };

  /** Echo the requested columns, one row per NAICS category when NAICS2017 is wildcarded. */
  const cbpRows = (url: URL) => {
    const header = getList(url);
    const naics = url.searchParams.get('NAICS2017');
    const categories =
      naics === '*'
        ? [
            ['00', 'Total for all sectors', '93517'],
            ['11', 'Agriculture, forestry, fishing and hunting', '177'],
            ['1151', 'Support activities for crop production', '12'],
          ]
        : [[naics ?? '00', 'Total for all sectors', naics ? '577' : '202177']];
    const echoed = ['NAICS2017', 'LFO', 'EMPSZES'].filter((k) => url.searchParams.has(k));
    return [
      [...header, ...echoed, 'state', 'county'],
      ...categories.map(([code, label, estab]) => [
        ...header.map((h) =>
          h === 'NAME'
            ? 'King County, Washington'
            : h === 'ESTAB'
              ? estab
              : h === 'NAICS2017_LABEL'
                ? label
                : h.endsWith('_LABEL')
                  ? 'All establishments'
                  : null,
        ),
        ...echoed.map((k) => (k === 'NAICS2017' ? code : url.searchParams.get(k))),
        '53',
        '033',
      ]),
    ];
  };

  it('census_query_data labels each category row from the dimension label column', async () => {
    serveMetadata('cbp', 2023, cbpVariables);
    serveData('cbp', 2023, cbpRows);

    const result = await runToolContract(censusQueryData, {
      variables: ['ESTAB'],
      geography_level: 'county',
      geography_fips: '033',
      parent_fips: '53',
      dataset: 'cbp',
      predicates: { NAICS2017: '*', LFO: '001', EMPSZES: '001' },
    });

    const call = dataCalls('cbp', 2023)[0];
    expect(call?.searchParams.get('NAICS2017')).toBe('*');
    expect(getList(call)).toEqual(['NAME', 'ESTAB', 'NAICS2017_LABEL', 'ESTAB_F']);
    const out = structured(result);
    expect(out.rows.map((r) => r.record)).toEqual([
      { NAICS2017: { code: '00', label: 'Total for all sectors' } },
      { NAICS2017: { code: '11', label: 'Agriculture, forestry, fishing and hunting' } },
      { NAICS2017: { code: '1151', label: 'Support activities for crop production' } },
    ]);
    expect(out.rows.every((r) => r.geography_geoid === '53033')).toBe(true);
    expect(out.notice).toContain('NAICS2017');
    expect(out.notice).toContain('"11" (Agriculture, forestry, fishing and hunting)');
    const text = textOf(result);
    expect(text).toContain(
      '### King County, Washington — NAICS2017 11 (Agriculture, forestry, fishing and hunting)',
    );
  });

  it('census_query_data treats a blank value as omitted and reports the default applied', async () => {
    serveMetadata('cbp', 2023, cbpVariables);
    serveData('cbp', 2023, cbpRows);

    const result = await runToolContract(censusQueryData, {
      variables: ['ESTAB'],
      geography_level: 'county',
      geography_fips: '033',
      parent_fips: '53',
      dataset: 'cbp',
      predicates: { NAICS2017: '  ', LFO: '001', EMPSZES: '001' },
    });

    const call = dataCalls('cbp', 2023)[0];
    expect(call?.searchParams.has('NAICS2017')).toBe(false);
    expect(getList(call)).toContain('NAICS2017_LABEL');
    const out = structured(result);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]?.applied_filters).toEqual({ NAICS2017: 'Total for all sectors' });
    expect(out.rows[0]?.record).toBeUndefined();
    expect(out.notice).toContain(
      'NAICS2017 (2017 NAICS code) — the API applied "Total for all sectors"',
    );
  });

  it('census_query_data matches a lowercase predicate key to its canonical code', async () => {
    serveMetadata('cbp', 2023, cbpVariables);
    serveData('cbp', 2023, cbpRows);

    const result = await runToolContract(censusQueryData, {
      variables: ['ESTAB'],
      geography_level: 'county',
      geography_fips: '033',
      parent_fips: '53',
      dataset: 'cbp',
      predicates: { naics2017: '5112', lfo: '001', Empszes: '001' },
    });

    expect(result.isError).toBeFalsy();
    const call = dataCalls('cbp', 2023)[0];
    expect(call?.searchParams.get('NAICS2017')).toBe('5112');
    expect(call?.searchParams.has('naics2017')).toBe(false);
    expect(structured(result).rows[0]?.variables.ESTAB?.estimate).toBe(577);
    expect(structured(result).notice).toBeUndefined();
  });

  it('census_compare_geographies refuses a "*" breakdown and names the dimension to pin', async () => {
    serveMetadata('cbp', 2023, cbpVariables);
    serveData('cbp', 2023, cbpRows);

    const result = await runToolContract(censusCompareGeographies, {
      variables: ['ESTAB'],
      geography_level: 'county',
      within: '53',
      dataset: 'cbp',
      predicates: { NAICS2017: '*', LFO: '001', EMPSZES: '001' },
    });

    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.data).toMatchObject({ reason: 'ambiguous_rows' });
    const hint = (error.data.recovery as { hint: string }).hint;
    expect(hint).toContain('NAICS2017');
    expect(hint).toContain('"11" (Agriculture, forestry, fishing and hunting)');
  });
});

// ---------------------------------------------------------------------------------------------
// #35 — census_query_data caps and pages its rows
// ---------------------------------------------------------------------------------------------

/**
 * A deterministic shuffle, so the fake answers out of GEOID order and a test can tell a sort from
 * an upstream order that happened to be sorted already.
 */
const shuffled = <T>(items: T[]): T[] => {
  const out = [...items];
  let seed = 7;
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
};

/** `n` Los Angeles County tract codes, ascending. */
const tractCodes = (n: number) =>
  Array.from({ length: n }, (_, i) => String(101 + i * 3).padStart(6, '0'));

/** Serve LA County tracts for `acs/acs5` 2024, answering in a shuffled order. */
const serveTracts = (n: number) => {
  serveMetadata('acs/acs5', 2024, acsVariables);
  const tracts = shuffled(tractCodes(n));
  serveData('acs/acs5', 2024, (url) => {
    const header = getList(url);
    const tract = url.searchParams.get('for')?.split(':')[1] ?? '*';
    const pick = tract === '*' ? tracts : tracts.filter((t) => t === tract);
    return [
      [...header, 'state', 'county', 'tract'],
      ...pick.map((t) => [
        ...header.map((h) =>
          h === 'NAME' ? `Census Tract ${Number(t) / 100}; Los Angeles County; California` : '1000',
        ),
        '06',
        '037',
        t,
      ]),
    ];
  });
};

const laTracts = (overrides: Record<string, unknown> = {}) => ({
  variables: ['B19013_001E'],
  geography_level: 'tract',
  geography_fips: '*',
  parent_fips: '06',
  county_fips: '037',
  ...overrides,
});

type Paged = ReturnType<typeof structured> & {
  totalCount?: number;
  totalRows?: number;
  truncated?: boolean;
};

const paged = (result: { structuredContent?: unknown }) => structured(result) as Paged;

describe('census_query_data returns at most limit rows, in GEOID order, paged by offset', () => {
  const all = tractCodes(1234).map((t) => `06037${t}`);

  it('caps an unbounded wildcard at 50 rows and discloses the total on both surfaces', async () => {
    serveTracts(1234);

    const result = await runToolContract(censusQueryData, laTracts());

    expect(result.isError).toBeFalsy();
    const out = paged(result);
    expect(out.rows.map((r) => r.geography_geoid)).toEqual(all.slice(0, 50));
    expect(out.totalCount).toBe(1234);
    expect(out.totalRows).toBe(50);
    expect(out.truncated).toBe(true);
    expect(out.notice).toContain('Rows 1–50 of 1,234');
    expect(out.notice).toContain('in GEOID order — not a ranking or a sample');
    expect(out.notice).toContain('offset: 50');

    const text = textOf(result);
    expect(text).toContain('Rows 1–50 of 1,234');
    expect(text).toContain('offset: 50');
    expect(text).toMatch(/totalCount:\*\* 1234/);
    expect(text).toMatch(/truncated:\*\* true/);
    // format() sees the rows it renders, not the enrichment, so the total rides in the trailer.
    expect(text).toContain('**50 geography rows**');
    // The request is the one wildcard it always was — paging slices it, it never re-queries.
    expect(dataCalls('acs/acs5', 2024)).toHaveLength(1);
  });

  it('walks every page in order without overlap or gap, ending on a short page', async () => {
    serveTracts(1234);

    const pages: Paged[] = [];
    for (const offset of [0, 500, 1000]) {
      pages.push(paged(await runToolContract(censusQueryData, laTracts({ limit: 500, offset }))));
    }

    expect(pages.map((p) => p.rows.length)).toEqual([500, 500, 234]);
    expect(pages.flatMap((p) => p.rows.map((r) => r.geography_geoid))).toEqual(all);
    expect(pages.every((p) => p.totalCount === 1234 && p.truncated === true)).toBe(true);
    expect(pages[1]?.notice).toContain('Rows 501–1,000 of 1,234');
    expect(pages[1]?.notice).toContain('offset: 1000');
    // The last page names no next offset: there is nothing after it.
    expect(pages[2]?.notice).toContain('Rows 1,001–1,234 of 1,234');
    expect(pages[2]?.notice).toMatch(/last page/i);
    expect(pages[2]?.notice).not.toContain('offset: 1500');
  });

  it.each([1234, 5000])(
    'answers an offset of %s, at or past the end, with no rows rather than no_data',
    async (offset) => {
      serveTracts(1234);

      const result = await runToolContract(censusQueryData, laTracts({ offset }));

      expect(result.isError).toBeFalsy();
      const out = paged(result);
      expect(out.rows).toEqual([]);
      expect(out.totalCount).toBe(1234);
      expect(out.totalRows).toBe(0);
      expect(out.truncated).toBe(true);
      expect(out.notice).toContain(`offset ${offset.toLocaleString('en-US')}`);
      expect(out.notice).toContain('1,234 rows');
      expect(out.notice).toMatch(/offset below 1,234/);
      const text = textOf(result);
      expect(text).toContain('**0 geography rows**');
      expect(text).toMatch(/totalCount:\*\* 1234/);
      expect(text).toContain(`offset ${offset.toLocaleString('en-US')}`);
    },
  );

  it('returns a single geography as before, with totalCount 1 and truncated false', async () => {
    serveTracts(1234);

    const result = await runToolContract(
      censusQueryData,
      laTracts({ geography_fips: tractCodes(1234)[7] }),
    );

    const out = paged(result);
    expect(out.rows).toHaveLength(1);
    expect(out.totalCount).toBe(1);
    expect(out.totalRows).toBe(1);
    expect(out.truncated).toBe(false);
    expect(out.notice).toBeUndefined();
    expect(textOf(result)).toContain('**1 geography row**');
  });

  it('returns a full final page exactly, naming no next offset', async () => {
    serveTracts(1234);

    const out = paged(await runToolContract(censusQueryData, laTracts({ offset: 1184 })));

    expect(out.rows.map((r) => r.geography_geoid)).toEqual(all.slice(1184));
    expect(out.notice).toContain('Rows 1,185–1,234 of 1,234');
    expect(out.notice).toMatch(/last page/i);
  });

  /**
   * Narrowing is advice only where a scope input is still open. One county's tracts are already
   * as narrow as this tool can express, so pointing at parent_fips or county_fips there sends the
   * caller nowhere.
   */
  it('suggests narrowing only through a scope input the query left open', async () => {
    serveTracts(1234);
    const pinned = paged(await runToolContract(censusQueryData, laTracts()));
    expect(pinned.notice).not.toContain('narrow the scope');

    const everyCounty = paged(
      await runToolContract(censusQueryData, laTracts({ county_fips: '*' })),
    );
    expect(everyCounty.notice).toContain('narrow the scope with county_fips');
    expect(everyCounty.notice).not.toContain('parent_fips');
  });

  it('suggests parent_fips for a nationwide wildcard', async () => {
    serveMetadata('acs/acs5', 2024, acsVariables);
    serveData('acs/acs5', 2024, (url) => {
      const header = getList(url);
      return [
        [...header, 'state', 'county'],
        ...Array.from({ length: 60 }, (_, i) => [
          ...header.map((h) => (h === 'NAME' ? `County ${i}` : '1')),
          String(1 + Math.floor(i / 10)).padStart(2, '0'),
          String(1 + (i % 10) * 2).padStart(3, '0'),
        ]),
      ];
    });

    const out = paged(
      await runToolContract(censusQueryData, {
        variables: ['B19013_001E'],
        geography_level: 'county',
        geography_fips: '*',
      }),
    );

    expect(out.totalCount).toBe(60);
    expect(out.notice).toContain('narrow the scope with parent_fips');
  });

  it('suggests county_fips for a statewide tract wildcard, and no scope for states', async () => {
    serveTracts(1234);
    const statewide = paged(
      await runToolContract(censusQueryData, {
        variables: ['B19013_001E'],
        geography_level: 'tract',
        geography_fips: '*',
        parent_fips: '06',
      }),
    );
    expect(statewide.notice).toContain('narrow the scope with county_fips');
    expect(statewide.notice).not.toContain('parent_fips');

    // A state takes no parent, so 52 states past the default 50 have only offset and limit.
    serveData('acs/acs5', 2024, () => []);
    routes.unshift({
      match: (u) => u.pathname === at('acs/acs5', 2024) && u.searchParams.get('for') === 'state:*',
      respond: (url) => {
        const header = getList(url);
        return [
          [...header, 'state'],
          ...Array.from({ length: 52 }, (_, i) => [
            ...header.map((h) => (h === 'NAME' ? `State ${i}` : '1')),
            String(i + 1).padStart(2, '0'),
          ]),
        ];
      },
    });
    const states = paged(
      await runToolContract(censusQueryData, {
        variables: ['B19013_001E'],
        geography_level: 'state',
        geography_fips: '*',
      }),
    );
    expect(states.totalCount).toBe(52);
    expect(states.notice).toContain('offset: 50');
    expect(states.notice).not.toContain('narrow the scope');
  });

  /** Three counties, each split into three NAICS categories by a `"*"` predicate. */
  const cbpVariables = {
    ESTAB: { label: 'Number of establishments', predicateType: 'int', attributes: 'ESTAB_F' },
    NAICS2017: {
      label: '2017 NAICS code',
      required: 'default displayed',
      predicateType: 'string',
      attributes: 'NAICS2017_F,NAICS2017_LABEL,NAICS2017_F',
    },
    GEOCOMP: { label: 'GEO_ID Component', required: 'default displayed', predicateType: 'string' },
  };

  const serveCbpBreakdown = () => {
    serveMetadata('cbp', 2023, cbpVariables);
    const categories = [
      ['00', 'Total for all sectors'],
      ['11', 'Agriculture, forestry, fishing and hunting'],
      ['1151', 'Support activities for crop production'],
    ];
    // Upstream order within each county is category order; the counties themselves arrive shuffled.
    const counties = ['063', '007', '033'];
    serveData('cbp', 2023, (url) => {
      const header = getList(url);
      return [
        [...header, 'NAICS2017', 'state', 'county'],
        ...counties.flatMap((county) =>
          categories.map(([code, label]) => [
            ...header.map((h) =>
              h === 'NAME'
                ? `County ${county}, Washington`
                : h === 'NAICS2017_LABEL'
                  ? label
                  : h === 'ESTAB'
                    ? String(Number(county) * 10)
                    : null,
            ),
            code,
            '53',
            county,
          ]),
        ),
      ];
    });
  };

  /**
   * The Census documents no row order, and the category order within one geography has changed
   * between identical live requests (`cbp` 2023 King County `NAICS2017=*` put `11521` before
   * `1151` in one response and after it in the next). Each page is its own request, so paging on
   * the upstream order within a geography can repeat one category and skip another.
   */
  it('pages a "*" breakdown without overlap or gap when upstream category order varies', async () => {
    serveMetadata('cbp', 2023, cbpVariables);
    const categories = ['00', '11', '1151', '11511', '1152', '11521'];
    let call = 0;
    serveData('cbp', 2023, (url) => {
      const header = getList(url);
      call += 1;
      const order = call % 2 === 0 ? [...categories].reverse() : categories;
      return [
        [...header, 'NAICS2017', 'state', 'county'],
        ...order.map((code) => [
          ...header.map((h) =>
            h === 'NAME' ? 'County 033, Washington' : h === 'ESTAB' ? '5' : null,
          ),
          code,
          '53',
          '033',
        ]),
      ];
    });
    const input = {
      variables: ['ESTAB'],
      geography_level: 'county',
      geography_fips: '033',
      parent_fips: '53',
      dataset: 'cbp',
      predicates: { NAICS2017: '*' },
      limit: 3,
    };

    const codes = [];
    for (const offset of [0, 3]) {
      const page = paged(await runToolContract(censusQueryData, { ...input, offset }));
      codes.push(...page.rows.map((r) => r.record?.NAICS2017?.code));
    }

    expect(codes).toEqual(categories);
  });

  it('counts each category row a "*" predicate returns against limit', async () => {
    serveCbpBreakdown();
    const input = {
      variables: ['ESTAB'],
      geography_level: 'county',
      geography_fips: '*',
      parent_fips: '53',
      dataset: 'cbp',
      predicates: { NAICS2017: '*' },
      limit: 4,
    };

    const pages = [
      paged(await runToolContract(censusQueryData, { ...input, offset: 0 })),
      paged(await runToolContract(censusQueryData, { ...input, offset: 4 })),
      paged(await runToolContract(censusQueryData, { ...input, offset: 8 })),
    ];

    expect(pages.map((p) => p.rows.length)).toEqual([4, 4, 1]);
    expect(pages.every((p) => p.totalCount === 9)).toBe(true);
    // GEOID order across counties, category code order within each one.
    expect(
      pages.flatMap((p) => p.rows.map((r) => `${r.geography_geoid}/${r.record?.NAICS2017?.code}`)),
    ).toEqual([
      '53007/00',
      '53007/11',
      '53007/1151',
      '53033/00',
      '53033/11',
      '53033/1151',
      '53063/00',
      '53063/11',
      '53063/1151',
    ]);
    // A ranking cannot hold a per-category breakdown, so the notice does not send the caller there.
    expect(pages[0]?.notice).toContain('offset: 4');
    expect(pages[0]?.notice).not.toContain('census_compare_geographies');
  });

  /** `pep/charv` with its MONTH record dimension and one unset filter dimension. */
  const charvVariables = {
    POP: { label: 'Population', predicateType: 'int' },
    MONTH: { label: 'Vintage Month', predicateType: 'int', attributes: 'MONTH_DESC' },
    YEAR: { label: 'Year', required: 'default displayed', predicateType: 'int' },
    GEOCOMP: { label: 'GEO_ID Component', required: 'default displayed', predicateType: 'string' },
  };

  /** Every county answers with an April and a July row, in that order. */
  const serveCharvCounties = (n: number) => {
    serveMetadata('pep/charv', 2023, charvVariables);
    const counties = Array.from({ length: n }, (_, i) => String(1 + i * 2).padStart(3, '0'));
    serveData('pep/charv', 2023, (url) => {
      const header = getList(url);
      const month = url.searchParams.get('MONTH');
      const records = [
        ['4', 'April'],
        ['7', 'July'],
      ].filter(([code]) => !month || code === month);
      return [
        [...header, ...(month ? ['MONTH'] : []), 'state', 'county'],
        ...shuffled(counties).flatMap((county) =>
          records.map(([code, label]) => [
            ...header.map((h) =>
              h === 'NAME'
                ? `County ${county}, Washington`
                : h === 'MONTH'
                  ? code
                  : h === 'MONTH_DESC'
                    ? label
                    : String(1000 + Number(county)),
            ),
            ...(month ? [month] : []),
            '53',
            county,
          ]),
        ),
      ];
    });
  };

  const charvCounties = (overrides: Record<string, unknown> = {}) => ({
    variables: ['POP'],
    geography_level: 'county',
    geography_fips: '*',
    parent_fips: '53',
    dataset: 'pep/charv',
    ...overrides,
  });

  it('keeps the unset-dimension and record-row notices together (characterization)', async () => {
    serveCharvCounties(3);

    const result = await runToolContract(censusQueryData, charvCounties());

    const notice = structured(result).notice ?? '';
    expect(notice).toContain('YEAR (Year)');
    expect(notice).toContain('MONTH separates them');
    expect(notice).toContain('"4" (April) and "7" (July)');
    expect(textOf(result)).toContain('MONTH separates them');
  });

  it('counts both pep/charv records per county against limit and keeps every notice', async () => {
    serveCharvCounties(30);

    const result = await runToolContract(censusQueryData, charvCounties());

    const out = paged(result);
    expect(out.rows).toHaveLength(50);
    expect(out.totalCount).toBe(60);
    expect(out.truncated).toBe(true);
    // April before July within each county, by MONTH code.
    expect(
      out.rows.slice(0, 4).map((r) => `${r.geography_geoid}/${r.record?.MONTH?.code}`),
    ).toEqual(['53001/4', '53001/7', '53003/4', '53003/7']);
    const notice = out.notice ?? '';
    expect(notice).toContain('YEAR (Year)');
    expect(notice).toContain('MONTH separates them');
    expect(notice).toContain('Rows 1–50 of 60');
    expect(notice).toContain('offset: 50');
    const text = textOf(result);
    expect(text).toContain('YEAR (Year)');
    expect(text).toContain('Rows 1–50 of 60');
  });

  it('fits both pep/charv records per county under the cap', async () => {
    serveCharvCounties(20);

    const out = paged(await runToolContract(censusQueryData, charvCounties()));

    expect(out.rows).toHaveLength(40);
    expect(out.totalCount).toBe(40);
    expect(out.truncated).toBe(false);
    expect(out.notice).not.toContain('Rows ');
  });

  /**
   * A record column the caller also names as a variable used to go out twice in `get=`, and the
   * column plan counted it twice, so a query that fit was refused one code early.
   */
  it('sends a record column the caller also requests once, and counts it once', async () => {
    serveCharvCounties(1);
    const codes = Array.from({ length: 46 }, (_, i) => `POP${i}`);

    const result = await runToolContract(
      censusQueryData,
      charvCounties({
        variables: ['POP', ...codes, 'MONTH_DESC'],
        geography_fips: '001',
        predicates: { MONTH: '7' },
      }),
    );

    expect(result.isError).toBeFalsy();
    const sent = getList(dataCalls('pep/charv', 2023)[0]);
    expect(sent.filter((c) => c === 'MONTH_DESC')).toHaveLength(1);
    expect(sent).toHaveLength(50);
    expect(new Set(sent).size).toBe(sent.length);
    const row = structured(result).rows[0];
    expect(row?.variables.MONTH_DESC?.value).toBe('July');
    expect(row?.record).toEqual({ MONTH: { code: '7', label: 'July' } });
  });
});

describe('a "*" breakdown notice says the rows are categories the caller asked for', () => {
  it('words the split as one row per category of the wildcarded dimension', async () => {
    serveMetadata('cbp', 2023, {
      ESTAB: { label: 'Number of establishments', predicateType: 'int', attributes: 'ESTAB_F' },
      NAICS2017: {
        label: '2017 NAICS code',
        required: 'default displayed',
        predicateType: 'string',
        attributes: 'NAICS2017_F,NAICS2017_LABEL,NAICS2017_F',
      },
      GEOCOMP: {
        label: 'GEO_ID Component',
        required: 'default displayed',
        predicateType: 'string',
      },
    });
    serveData('cbp', 2023, (url) => {
      const header = getList(url);
      return [
        [...header, 'NAICS2017', 'state', 'county'],
        ...[
          ['00', 'Total for all sectors'],
          ['11', 'Agriculture, forestry, fishing and hunting'],
        ].map(([code, label]) => [
          ...header.map((h) =>
            h === 'NAME' ? 'King County, Washington' : h === 'NAICS2017_LABEL' ? label : '5',
          ),
          code,
          '53',
          '033',
        ]),
      ];
    });

    const result = await runToolContract(censusQueryData, {
      variables: ['ESTAB'],
      geography_level: 'county',
      geography_fips: '033',
      parent_fips: '53',
      dataset: 'cbp',
      predicates: { NAICS2017: '*' },
    });

    const notice = structured(result).notice ?? '';
    expect(notice).toContain('one row per category of NAICS2017');
    expect(notice).toContain('predicates set it to "*"');
    expect(notice).toContain('"11" (Agriculture, forestry, fishing and hunting)');
    expect(notice).not.toContain('pick the record you want rather than the first row');
    expect(textOf(result)).toContain('one row per category of NAICS2017');
  });
});

// ---------------------------------------------------------------------------------------------
// #38, #49 — census_compare_geographies ranks only on a requested, numeric column
// ---------------------------------------------------------------------------------------------

describe('census_compare_geographies refuses a ranking it cannot make', () => {
  const states = [
    ['NAME', 'B19013_001E', 'GEO_ID', 'state'],
    ['Alabama', '63999', '0400000US01', '01'],
    ['Alaska', '92788', '0400000US02', '02'],
    ['District of Columbia', '109870', '0400000US11', '11'],
  ];

  const serveStates = () => {
    serveMetadata('acs/acs5', 2024, acsVariables);
    serveData('acs/acs5', 2024, (url) => {
      const header = getList(url);
      return [
        [...header, 'state'],
        ...states
          .slice(1)
          .map((row) => [...header.map((h) => row[states[0]?.indexOf(h) ?? -1] ?? null), row[3]]),
      ];
    });
  };

  it('rejects a sort_by that names no requested code, before any Census request', async () => {
    serveStates();

    const result = await runToolContract(censusCompareGeographies, {
      variables: ['B19013_001E'],
      geography_level: 'state',
      sort_by: 'B19013_01E',
      limit: 3,
    });

    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'sort_by_not_requested',
      sortBy: 'B19013_01E',
      variables: ['B19013_001E'],
    });
    expect(error.message).toContain('B19013_01E');
    expect(error.message).toContain('B19013_001E');
    const text = textOf(result);
    expect(text).toContain('reason sort_by_not_requested');
    expect(text).toMatch(/sort_by to one of the codes in variables/);
    expect(calls).toHaveLength(0);
  });

  it('ranks a case-slipped sort_by on the requested code and echoes it as spelled there', async () => {
    serveStates();

    const result = await runToolContract(censusCompareGeographies, {
      variables: ['B19013_001E'],
      geography_level: 'state',
      sort_by: 'b19013_001e',
    });

    const out = structured(result);
    expect(out.rows[0]?.geography_name).toBe('District of Columbia');
    expect(out.sortVariable).toBe('B19013_001E');
    expect(out.notice ?? '').not.toMatch(/not ranked/i);
  });

  /** A state takes no parent, so `within` cannot narrow a ranking of states. */
  it('offers only the scope inputs the level takes when a ranking is truncated', async () => {
    serveStates();

    const states = structured(
      await runToolContract(censusCompareGeographies, {
        variables: ['B19013_001E'],
        geography_level: 'state',
        limit: 2,
      }),
    );
    expect(states.notice).toContain('1 more geography not shown');
    expect(states.notice).toContain('increase the limit parameter (max 500)');
    expect(states.notice).not.toContain('within');

    serveData('acs/acs5', 2024, () => []);
    routes.unshift({
      match: (u) => u.pathname === at('acs/acs5', 2024) && u.searchParams.get('for') === 'county:*',
      respond: (url) => {
        const header = getList(url);
        return [
          [...header, 'state', 'county'],
          ...['001', '003', '005'].map((county, i) => [
            ...header.map((h) => (h === 'NAME' ? `County ${county}` : String(1000 + i))),
            '53',
            county,
          ]),
        ];
      },
    });
    const counties = structured(
      await runToolContract(censusCompareGeographies, {
        variables: ['B19013_001E'],
        geography_level: 'county',
        limit: 2,
      }),
    );
    expect(counties.notice).toContain('use within to narrow the scope');
    expect(counties.notice).not.toContain('within_county');
  });

  it('keeps the rows but says they are unranked when the sort column holds no number', async () => {
    serveStates();

    const result = await runToolContract(censusCompareGeographies, {
      variables: ['GEO_ID', 'B19013_001E'],
      geography_level: 'state',
    });

    expect(result.isError).toBeFalsy();
    const out = structured(result);
    expect(out.rows.map((r) => r.geography_name)).toEqual([
      'Alabama',
      'Alaska',
      'District of Columbia',
    ]);
    expect(out.sortVariable).toBe('GEO_ID');
    const notice = out.notice ?? '';
    expect(notice).toContain('GEO_ID');
    expect(notice).toMatch(/not ranked/i);
    expect(notice).toContain('order the Census returned them');
    expect(textOf(result)).toMatch(/not ranked/i);
  });

  /** Rows that are not ranked have no other end, so flipping sort_dir reaches nothing new. */
  it('does not offer the other end of a ranking it did not make', async () => {
    serveStates();

    const out = structured(
      await runToolContract(censusCompareGeographies, {
        variables: ['GEO_ID', 'B19013_001E'],
        geography_level: 'state',
        limit: 2,
      }),
    );

    expect(out.notice).toMatch(/not ranked/i);
    expect(out.notice).toContain('1 more geography not shown');
    expect(out.notice).not.toContain('sort_dir');
  });

  it('offers no way to see more when an unranked, unscoped list is at the maximum limit', async () => {
    serveMetadata('acs/acs5', 2024, acsVariables);
    serveData('acs/acs5', 2024, (url) => {
      const header = getList(url);
      return [
        [...header, 'state'],
        ...Array.from({ length: 501 }, (_, i) => [
          ...header.map((h) => (h === 'NAME' ? `Area ${i}` : `0400000US${i}`)),
          String(i).padStart(2, '0'),
        ]),
      ];
    });

    const out = structured(
      await runToolContract(censusCompareGeographies, {
        variables: ['GEO_ID'],
        geography_level: 'state',
        limit: 500,
      }),
    );

    expect(out.rows).toHaveLength(500);
    expect(out.notice).toContain('Results truncated — 1 more geography not shown.');
    expect(out.notice).not.toContain('undefined');
    expect(out.notice).not.toContain('To see more');
  });

  it.each([
    ['an empty list', []],
    ['only blank codes', ['  ', '']],
  ])('rejects %s of variables before any Census request', async (_label, variables) => {
    serveStates();

    const result = await runToolContract(censusCompareGeographies, {
      variables,
      geography_level: 'state',
    });

    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.message).toContain('At least one variable code is required');
    expect(calls).toHaveLength(0);
  });

  /** A form-based client sends a field it left empty as "", which reads as omitted everywhere else. */
  it.each([
    ['census_query_data', censusQueryData, { geography_fips: '53' }],
    ['census_compare_geographies', censusCompareGeographies, {}],
  ] as const)(
    '%s reads a blank dataset as the acs/acs5 default',
    async (_name, definition, scope) => {
      serveStates();

      const result = await runToolContract(
        definition as typeof censusQueryData,
        { variables: ['B19013_001E'], geography_level: 'state', dataset: ' ', ...scope } as never,
      );

      expect(result.isError).toBeFalsy();
      expect(dataCalls('acs/acs5', 2024)).toHaveLength(1);
    },
  );

  it('census_query_data rejects only blank codes the same way', async () => {
    serveStates();

    const result = await runToolContract(censusQueryData, {
      variables: ['  '],
      geography_level: 'state',
      geography_fips: '53',
    });

    expect(result.isError).toBe(true);
    expect(errorOf(result).message).toContain('At least one variable code is required');
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// #42 — a tract scope reaches one block group
// ---------------------------------------------------------------------------------------------

describe('census_query_data scopes block groups by tract_fips', () => {
  /** King County block groups, two to a tract, answered the way the Census API scopes them. */
  const kingTracts = Array.from({ length: 40 }, (_, i) => String(100 + i * 100).padStart(6, '0'));
  const blockGroups = [...kingTracts, '007101'].flatMap((tract) => [`${tract}1`, `${tract}2`]);

  const serveBlockGroups = () => {
    routes.push({
      match: (u) => u.pathname === `${at('acs/acs5', 2024)}/variables.json`,
      respond: () => ({ variables: acsVariables }),
    });
    routes.push({
      match: (u) => u.pathname === `${at('acs/acs5', 2024)}/geography.json`,
      respond: () => ({
        fips: [
          { name: 'state', geoLevelDisplay: '040' },
          {
            name: 'county',
            geoLevelDisplay: '050',
            requires: ['state'],
            wildcard: ['state'],
            optionalWithWCFor: 'state',
          },
          {
            name: 'tract',
            geoLevelDisplay: '140',
            requires: ['state', 'county'],
            wildcard: ['county'],
            optionalWithWCFor: 'county',
          },
          {
            name: 'block group',
            geoLevelDisplay: '150',
            requires: ['state', 'county', 'tract'],
            wildcard: ['county', 'tract'],
            optionalWithWCFor: 'tract',
          },
        ],
      }),
    });
    serveData('acs/acs5', 2024, (url) => {
      const header = getList(url);
      const target = url.searchParams.get('for')?.split(':')[1] ?? '*';
      const tract = /tract:(\d{6})/.exec(url.searchParams.get('in') ?? '')?.[1];
      const pick = blockGroups.filter(
        (bg) => (!tract || bg.startsWith(tract)) && (target === '*' || bg.endsWith(target)),
      );
      return [
        [...header, 'state', 'county', 'tract', 'block group'],
        ...pick.map((bg) => [
          ...header.map((h) =>
            h === 'NAME'
              ? `Block Group ${bg.slice(6)}; Census Tract ${Number(bg.slice(0, 6)) / 100}; King County; Washington`
              : bg === '0071012'
                ? '136034'
                : '1000',
          ),
          '53',
          '033',
          bg.slice(0, 6),
          bg.slice(6),
        ]),
      ];
    });
  };

  const kingBlockGroups = (overrides: Record<string, unknown> = {}) => ({
    variables: ['B19013_001E'],
    geography_level: 'block group',
    geography_fips: '2',
    parent_fips: '53',
    county_fips: '033',
    tract_fips: '007101',
    ...overrides,
  });

  it('returns the one block group a tract scope names, on both surfaces', async () => {
    serveBlockGroups();

    const result = await runToolContract(censusQueryData, kingBlockGroups());

    expect(result.isError).toBeFalsy();
    const out = paged(result);
    expect(out.rows.map((r) => r.geography_geoid)).toEqual(['530330071012']);
    expect(out.rows[0]?.variables.B19013_001E?.estimate).toBe(136034);
    expect(out.totalCount).toBe(1);
    expect(dataCalls('acs/acs5', 2024)[0]?.searchParams.get('in')).toBe(
      'state:53 county:033 tract:007101',
    );
    const text = textOf(result);
    expect(text).toContain('`530330071012`');
    expect(text).toContain('136,034');
  });

  it('returns every block group in the tract for "*"', async () => {
    serveBlockGroups();

    const out = paged(
      await runToolContract(censusQueryData, kingBlockGroups({ geography_fips: '*' })),
    );

    expect(out.rows.map((r) => r.geography_geoid)).toEqual(['530330071011', '530330071012']);
    expect(out.truncated).toBe(false);
  });

  it('answers an offset past the tract with no rows and no narrower scope to offer', async () => {
    serveBlockGroups();

    const result = await runToolContract(
      censusQueryData,
      kingBlockGroups({ geography_fips: '*', offset: 5 }),
    );

    expect(result.isError).toBeFalsy();
    const out = paged(result);
    expect(out.rows).toEqual([]);
    expect(out.totalCount).toBe(2);
    expect(out.notice).toContain('offset 5');
    expect(out.notice).toMatch(/offset below 2/);
    expect(out.notice).not.toContain('narrow the scope');
    expect(dataCalls('acs/acs5', 2024)[0]?.searchParams.get('in')).toBe(
      'state:53 county:033 tract:007101',
    );
    expect(textOf(result)).toContain('**0 geography rows**');
  });

  it.each([
    ['omitted', {}],
    ['"*"', { county_fips: '*' }],
  ])(
    'refuses a tract scope whose county_fips is %s with parent_required, before the data call',
    async (_label, county) => {
      serveBlockGroups();
      const { county_fips: _drop, ...scope } = kingBlockGroups();

      const result = await runToolContract(censusQueryData, { ...scope, ...county });

      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error.data.reason).toBe('parent_required');
      expect(error.data.missingParents).toEqual(['county']);
      expect(String((error.data.recovery as { hint: string }).hint)).toContain('county_fips');
      expect(textOf(result)).toContain('county_fips');
      expect(dataCalls('acs/acs5', 2024)).toHaveLength(0);
    },
  );

  it.each([
    ['tract', '007101'],
    ['county', '033'],
  ])('refuses tract_fips on the %s level with parent_not_accepted', async (level, fips) => {
    serveBlockGroups();

    const result = await runToolContract(
      censusQueryData,
      kingBlockGroups({
        geography_level: level,
        geography_fips: fips,
        ...(level === 'county' && { county_fips: '' }),
      }),
    );

    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.data.reason).toBe('parent_not_accepted');
    expect(error.data.unacceptedParents).toEqual(['tract']);
    expect(textOf(result)).toContain('Drop tract_fips');
    expect(dataCalls('acs/acs5', 2024)).toHaveLength(0);
  });

  it('names tract_fips, not the wildcard, when a single block group has no tract', async () => {
    serveBlockGroups();

    const result = await runToolContract(censusQueryData, kingBlockGroups({ tract_fips: '' }));

    const error = errorOf(result);
    expect(error.data.reason).toBe('parent_required');
    expect(error.data.missingParents).toEqual(['tract']);
    expect(textOf(result)).toContain('tract_fips');
    expect(textOf(result)).not.toContain('geography_fips to "*"');
  });

  it('offers tract_fips as a narrowing scope when a county-wide list is truncated', async () => {
    serveBlockGroups();

    const out = paged(
      await runToolContract(
        censusQueryData,
        kingBlockGroups({ geography_fips: '*', tract_fips: '' }),
      ),
    );

    expect(out.totalCount).toBe(blockGroups.length);
    expect(out.truncated).toBe(true);
    expect(out.notice).toContain('narrow the scope with tract_fips');
    expect(out.notice).not.toContain('county_fips');
  });

  it('never offers tract_fips once the tract is set, or while the county is open', async () => {
    serveBlockGroups();

    const statewide = paged(
      await runToolContract(
        censusQueryData,
        kingBlockGroups({ geography_fips: '*', county_fips: '*', tract_fips: '' }),
      ),
    );
    expect(statewide.notice).toContain('narrow the scope with county_fips');
    expect(statewide.notice).not.toContain('tract_fips');

    const oneTract = paged(
      await runToolContract(censusQueryData, kingBlockGroups({ geography_fips: '*', limit: 1 })),
    );
    expect(oneTract.truncated).toBe(true);
    expect(oneTract.notice).not.toContain('narrow the scope');
  });
});

// ---------------------------------------------------------------------------------------------
// #43, #52 — added datasets
// ---------------------------------------------------------------------------------------------

describe('the added datasets answer on both surfaces', () => {
  /**
   * acs/acs1/spp 2012 through 2017 label POPGROUP through POPGROUP_TTL. Requesting it is what names
   * the default the API applied when the query leaves POPGROUP unset.
   */
  it('census_query_data names the acs/acs1/spp POPGROUP default through POPGROUP_TTL (#52)', async () => {
    serveMetadata('acs/acs1/spp', 2012, {
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
      GEOCOMP: {
        label: 'GEO_ID Component',
        required: 'default displayed',
        predicateType: 'string',
      },
    });
    serveData('acs/acs1/spp', 2012, () => [
      ['NAME', 'S0201_001E', 'POPGROUP_TTL', 'state'],
      ['Washington', '6897012', 'Total population', '53'],
    ]);

    const result = await runToolContract(censusQueryData, {
      variables: ['S0201_001E'],
      geography_level: 'state',
      geography_fips: '53',
      dataset: 'acs/acs1/spp',
      year: 2012,
    });

    expect(getList(dataCalls('acs/acs1/spp', 2012)[0])).toContain('POPGROUP_TTL');
    const [row] = structured(result).rows;
    expect(row?.variables.S0201_001E?.estimate).toBe(6897012);
    expect(row?.applied_filters).toEqual({ POPGROUP: 'Total population' });
    expect(structured(result).notice).toContain(
      'POPGROUP (Race/Ethnic Group) — the API applied "Total population"',
    );
    const text = textOf(result);
    expect(text).toContain('**Applied filter defaults:** POPGROUP = Total population');
    expect(text).toContain('6,897,012');
  });

  /** The comparison profiles publish no margins, but keep the ACS sentinel meanings. */
  it('census_query_data decodes an acs/acs1/cprofile sentinel with its ACS meaning (#52)', async () => {
    serveMetadata('acs/acs1/cprofile', 2024, {
      CP03_2020_062E: {
        label: '2020 Estimates!!Median household income (dollars)',
        concept: 'Comparative Economic Characteristics',
        predicateType: 'int',
        group: 'CP03',
      },
      GEOCOMP: {
        label: 'GEO_ID Component',
        required: 'default displayed',
        predicateType: 'string',
      },
    });
    serveData('acs/acs1/cprofile', 2024, () => [
      ['NAME', 'CP03_2020_062E', 'state'],
      ['Washington', '-888888888', '53'],
    ]);

    const result = await runToolContract(censusQueryData, {
      variables: ['CP03_2020_062E'],
      geography_level: 'state',
      geography_fips: '53',
      dataset: 'acs/acs1/cprofile',
    });

    const value = structured(result).rows[0]?.variables.CP03_2020_062E;
    expect(value).toMatchObject({
      estimate: null,
      suppressed: true,
      suppression_reason: 'Not applicable or not available',
    });
    expect(textOf(result)).toContain('Not applicable or not available');
  });
});

// ---------------------------------------------------------------------------------------------
// #32 — dataset-code case and shorthand
// ---------------------------------------------------------------------------------------------

describe('a dataset code resolves regardless of case, padding, or a bare acs5/acs1', () => {
  const serveWashington = () => {
    serveMetadata('acs/acs5', 2024, acsVariables);
    serveData('acs/acs5', 2024, () => [
      ['NAME', 'B19013_001E', 'state'],
      ['Washington', '103748', '53'],
    ]);
  };

  const enrichmentOf = (result: { structuredContent?: unknown }) =>
    result.structuredContent as { dataset?: string; year?: number };

  it.each(['acs5', 'ACS5', 'ACS/ACS5', ' acs5 '])(
    'census_query_data resolves %j to acs/acs5 and echoes the canonical code',
    async (dataset) => {
      serveWashington();

      const result = await runToolContract(censusQueryData, {
        variables: ['B19013_001E'],
        geography_level: 'state',
        geography_fips: '53',
        dataset,
      });

      expect(result.isError).toBeFalsy();
      expect(dataCalls('acs/acs5', 2024)).toHaveLength(1);
      expect(enrichmentOf(result)).toMatchObject({ dataset: 'acs/acs5', year: 2024 });
      expect(textOf(result)).toContain('acs/acs5');
    },
  );

  it.each(['acs5', 'ACS5', 'ACS/ACS5', ' acs5 '])(
    'census_compare_geographies resolves %j to acs/acs5 and echoes the canonical code',
    async (dataset) => {
      serveWashington();

      const result = await runToolContract(censusCompareGeographies, {
        variables: ['B19013_001E'],
        geography_level: 'state',
        dataset,
      });

      expect(result.isError).toBeFalsy();
      expect(dataCalls('acs/acs5', 2024)).toHaveLength(1);
      expect(enrichmentOf(result)).toMatchObject({ dataset: 'acs/acs5', year: 2024 });
    },
  );

  it.each([
    ['census_query_data', censusQueryData, { geography_fips: '53' }],
    ['census_compare_geographies', censusCompareGeographies, {}],
  ] as const)(
    '%s names both profile datasets for a bare "profile", before any request',
    async (_name, definition, scope) => {
      const result = await runToolContract(
        definition as typeof censusQueryData,
        {
          variables: ['B19013_001E'],
          geography_level: 'state',
          dataset: 'profile',
          ...scope,
        } as never,
      );

      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data).toMatchObject({ reason: 'dataset_not_found' });
      const text = textOf(result);
      expect(text).toContain('acs/acs5/profile');
      expect(text).toContain('acs/acs1/profile');
      expect(calls).toHaveLength(0);
    },
  );
});
