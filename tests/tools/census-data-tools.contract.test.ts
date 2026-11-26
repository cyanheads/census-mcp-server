/**
 * @fileoverview Contract tests for census_query_data and census_compare_geographies, run through
 * the real CensusApiService and VariableCacheService over a strict fetch fake. Response parsing,
 * the column plan, and error classification all sit inside the tools here, so these tests exercise
 * them on both client surfaces rather than a stubbed service's return value. The file closes with
 * a sweep across every tool's declared failure reasons, checking that no error repeats itself
 * between its message and its recovery hint.
 * @module tests/tools/census-data-tools.contract.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { censusCompareGeographies } from '@/mcp-server/tools/definitions/census-compare-geographies.tool.js';
import { censusListPredicateValues } from '@/mcp-server/tools/definitions/census-list-predicate-values.tool.js';
import { censusQueryData } from '@/mcp-server/tools/definitions/census-query-data.tool.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { initCensusApiService } from '@/services/census-api/census-api-service.js';
import { initGeographyService } from '@/services/geography/geography-service.js';
import { initVariableCacheService } from '@/services/variable-cache/variable-cache-service.js';
import { readNotice, readParagraphs } from '../helpers/markdown-readback.js';
import { readVariableLabels } from '../helpers/variable-labels-readback.js';

vi.mock('@/config/server-config.js', () => ({
  activeDiscoveryConfig: vi.fn(() => ({ variableCacheTtlHours: 24, clampLimits: true })),
  getDiscoveryConfig: vi.fn(() => ({ variableCacheTtlHours: 24, clampLimits: true })),
  getServerConfig: vi.fn(() => ({
    censusApiKey: 'test-key',
    variableCacheTtlHours: 24,
    clampLimits: true,
  })),
}));

/** A request the upstream accepts and never answers; it settles only when its signal aborts. */
const HANG = Symbol('hang');

type Body = unknown[][] | Record<string, unknown> | Response | typeof HANG;

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
    vi.fn((input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(url);
      const route = routes.find((r) => r.match(url));
      if (!route) return Promise.reject(new Error(`unmocked fetch: ${url.pathname}`));
      const body = route.respond(url);
      if (body === HANG) {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        });
      }
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
    variable_labels: Record<string, string>;
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

describe('ACS missing-geography coverage on both client surfaces', () => {
  it.each([
    { tool: 'query', dataset: 'acs/acsse', mode: 'empty', threshold: '20,000' },
    { tool: 'query', dataset: 'acs/acs1', mode: 'partial', threshold: '65,000' },
    { tool: 'compare', dataset: 'acs/acsse', mode: 'empty', threshold: '20,000' },
    { tool: 'compare', dataset: 'acs/acs5/cprofile', mode: 'partial', threshold: '5,000' },
    { tool: 'compare', dataset: 'acs/acs5/cprofile', mode: 'all-missing', threshold: '5,000' },
    { tool: 'compare', dataset: 'acs/acs1/spp', mode: 'all-missing', threshold: '500,000' },
  ])(
    '$tool $dataset $mode retains code checks and explains possible coverage',
    async ({ tool, dataset, mode, threshold }) => {
      serveMetadata(dataset, 2024, {
        B01003_001E: { label: 'Population', predicateType: 'int' },
      });
      serveData(dataset, 2024, (url) =>
        mode === 'empty'
          ? new Response(null, { status: 204 })
          : [
              [...getList(url), 'state', 'county'],
              ...['033', '053'].map((county) => [
                ...getList(url).map((code) => (code === 'NAME' ? `County ${county}` : '100000')),
                '53',
                county,
              ]),
            ],
      );
      const common = {
        variables: ['B01003_001E'],
        dataset,
        year: 2024,
        geography_level: 'county',
        limit: 1,
      };
      const result =
        tool === 'query'
          ? await runToolContract(censusQueryData, {
              ...common,
              parent_fips: '53',
              geography_fips: '019,033,053',
            })
          : await runToolContract(censusCompareGeographies, {
              ...common,
              within: '53',
              geographies: mode === 'all-missing' ? ['53019'] : ['53019', '53033', '53053'],
            });
      if (mode === 'partial') {
        expect(result.isError).not.toBe(true);
        const notice = structured(result).notice;
        expect(notice).toContain(threshold);
        expect(notice).toContain('possible');
        expect(notice).toContain('census_search_variables');
        expect(notice).toContain(tool === 'query' ? '1 of the 3' : '1 of the requested');
        expect(readNotice(result)).toBe(notice);
      } else {
        expect(result.isError).toBe(true);
        const error = errorOf(result);
        expect(error.data.reason).toBe('no_data');
        const recovery = error.data.recovery as { hint: string };
        expect(recovery.hint).toContain(threshold);
        expect(recovery.hint).toContain('possible');
        expect(recovery.hint).toContain('census_search_variables');
        expect(recovery.hint).toContain(
          mode === 'all-missing' ? 'GEOID' : 'census_resolve_geography',
        );
        expect(textOf(result)).toContain(threshold);
        expect(textOf(result)).toContain('census_search_variables');
      }
      expect(dataCalls(dataset, 2024)).toHaveLength(1);
    },
  );

  it.each(['acs/acs5', 'acs/acs5/profile', 'cbp'])(
    'does not invent a population floor for %s',
    async (dataset) => {
      const year = dataset === 'cbp' ? 2023 : 2024;
      serveMetadata(dataset, year, { B01003_001E: { label: 'Population', predicateType: 'int' } });
      serveData(dataset, year, () => new Response(null, { status: 204 }));
      const common = { variables: ['B01003_001E'], dataset, year, geography_level: 'county' };
      const results = [
        await runToolContract(censusQueryData, {
          ...common,
          parent_fips: '53',
          geography_fips: '999',
        }),
        await runToolContract(censusCompareGeographies, { ...common, within: '53' }),
      ];
      for (const result of results) {
        expect(errorOf(result).data.reason).toBe('no_data');
        expect(textOf(result)).not.toContain('population');
        expect(textOf(result)).not.toContain('Coverage is a possible');
      }
    },
  );

  it('does not call a matched but off-page geography missing', async () => {
    serveMetadata('acs/acs1', 2024, { B01003_001E: { label: 'Population', predicateType: 'int' } });
    serveData('acs/acs1', 2024, (url) => [
      [...getList(url), 'state', 'county'],
      ...['033', '053'].map((county) => [
        ...getList(url).map((code) => (code === 'NAME' ? `County ${county}` : '100000')),
        '53',
        county,
      ]),
    ]);
    const common = {
      variables: ['B01003_001E'],
      dataset: 'acs/acs1',
      year: 2024,
      geography_level: 'county',
      limit: 1,
    };
    const results = [
      await runToolContract(censusQueryData, {
        ...common,
        parent_fips: '53',
        geography_fips: '033,053',
      }),
      await runToolContract(censusCompareGeographies, {
        ...common,
        within: '53',
        geographies: ['53033', '53053'],
      }),
    ];
    for (const result of results) {
      expect(result.isError).not.toBe(true);
      expect(textOf(result)).not.toContain('Coverage is a possible');
      expect(textOf(result)).not.toContain('No row came back');
      expect(textOf(result)).not.toContain('No county matched');
    }
  });
});

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
    });
    expect(structured(result).variable_labels.B19013_001E).toBe(
      'Estimate!!Median household income in the past 12 months',
    );
  });

  /**
   * `B19013_001EA` is accepted by the data API but has no `variables.json` entry. Before, its miss
   * failed the whole label lookup and every code in the response lost its label. It keys its row
   * values, and has no label of its own to state.
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

    const out = structured(result);
    const v = out.rows[0]?.variables ?? {};
    expect(Object.keys(v)).toEqual(['B19013_001E', 'B19013_001M', 'B19013_001EA']);
    for (const entry of Object.values(v)) expect(entry).not.toHaveProperty('label');
    expect(out.variable_labels).toEqual({
      B19013_001E: 'Estimate!!Median household income in the past 12 months',
      B19013_001M: 'Margin of Error!!Median household income in the past 12 months',
    });
    const text = textOf(result);
    expect(readVariableLabels(text)).toEqual(out.variable_labels);
    for (const label of Object.values(out.variable_labels)) {
      expect(JSON.stringify(result.structuredContent).split(label)).toHaveLength(2);
      expect(text.split(label)).toHaveLength(2);
    }
  });

  /** A business dataset's flag column, like an ACS annotation, sits only in another entry. */
  it('census_query_data gives a cbp flag column requested as a code no label', async () => {
    serveMetadata('cbp', 2023, {
      EMP: { label: 'Number of employees', predicateType: 'int', attributes: 'EMP_F' },
    });
    serveData('cbp', 2023, () => [
      ['NAME', 'EMP', 'EMP_F', 'state', 'county'],
      ['King County, Washington', '1234567', 'r', '53', '033'],
    ]);

    const result = await runToolContract(censusQueryData, {
      variables: ['EMP', 'EMP_F'],
      geography_level: 'county',
      geography_fips: '033',
      parent_fips: '53',
      dataset: 'cbp',
      year: 2023,
    });

    const out = structured(result);
    expect(Object.keys(out.rows[0]?.variables ?? {})).toEqual(['EMP', 'EMP_F']);
    expect(out.variable_labels).toEqual({ EMP: 'Number of employees' });
    expect(readVariableLabels(textOf(result))).toEqual({ EMP: 'Number of employees' });
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
// #59 — the comparison profiles' mixed-case significance columns
// ---------------------------------------------------------------------------------------------

/**
 * acs/acs5/cprofile 2024 names each compared line's significance column in mixed case. The data
 * fake answers the way the Census API does: the dataset's spelling is a column, the uppercased one
 * is a 400 naming it. Values are the live response for Alabama, Alaska, and Washington.
 */
describe('the comparison-profile significance columns are sent and keyed as the dataset spells them', () => {
  const CPROFILE_COLUMNS: Record<string, Record<string, string>> = {
    '01': { NAME: 'Alabama', CP03_2024_062E: '63999', CP03_2024to2019_062SS: '*' },
    '02': { NAME: 'Alaska', CP03_2024_062E: '92788', CP03_2024to2019_062SS: '*' },
    '53': { NAME: 'Washington', CP03_2024_062E: '98141', CP03_2024to2019_062SS: '*' },
  };

  const serveCprofile = () => {
    serveMetadata('acs/acs5/cprofile', 2024, {
      CP03_2024_062E: {
        label:
          '2020-2024 Estimates!!INCOME AND BENEFITS (IN 2024 INFLATION-ADJUSTED DOLLARS)!!Total households!!Median household income (dollars)',
        concept: 'Comparative Economic Characteristics',
        predicateType: 'int',
        group: 'CP03',
        attributes: 'CP03_2024_062EA,CP03_2024to2019_062SS',
      },
      GEOCOMP: {
        label: 'GEO_ID Component',
        required: 'default displayed',
        predicateType: 'string',
      },
    });
    serveData('acs/acs5/cprofile', 2024, (url) => {
      const get = getList(url);
      const unknown = get.find((code) => !(code in (CPROFILE_COLUMNS['53'] ?? {})));
      if (unknown) {
        return new Response(`error: unknown variable '${unknown}'`, {
          status: 400,
          headers: { 'content-type': 'text/plain' },
        });
      }
      const fips = url.searchParams.get('for')?.split(':')[1] ?? '';
      const states = fips === '*' ? ['01', '02', '53'] : [fips];
      return [
        [...get, 'state'],
        ...states.map((state) => [...get.map((code) => CPROFILE_COLUMNS[state]?.[code]), state]),
      ];
    });
  };

  it.each(['CP03_2024to2019_062SS', 'cp03_2024to2019_062ss', 'CP03_2024TO2019_062SS'])(
    'census_query_data sends %s as CP03_2024to2019_062SS and keys the row by it',
    async (code) => {
      serveCprofile();

      const result = await runToolContract(censusQueryData, {
        dataset: 'acs/acs5/cprofile',
        variables: ['CP03_2024_062E', code],
        geography_level: 'state',
        geography_fips: '53',
      });

      expect(result.isError).toBeFalsy();
      expect(getList(dataCalls('acs/acs5/cprofile', 2024)[0])).toEqual([
        'NAME',
        'CP03_2024_062E',
        'CP03_2024to2019_062SS',
      ]);
      const [row] = structured(result).rows;
      expect(row?.geography_name).toBe('Washington');
      expect(Object.keys(row?.variables ?? {})).toEqual([
        'CP03_2024_062E',
        'CP03_2024to2019_062SS',
      ]);
      expect(row?.variables.CP03_2024_062E?.estimate).toBe(98141);
      expect(row?.variables.CP03_2024to2019_062SS).toMatchObject({ estimate: null, value: '*' });
      expect(textOf(result)).toContain('CP03_2024to2019_062SS');
    },
  );

  it('census_compare_geographies ranks on a lowercase sort_by naming the significance column', async () => {
    serveCprofile();

    const result = await runToolContract(censusCompareGeographies, {
      dataset: 'acs/acs5/cprofile',
      variables: ['CP03_2024_062E', 'cp03_2024to2019_062ss'],
      geography_level: 'state',
      sort_by: 'cp03_2024to2019_062ss',
    });

    expect(result.isError).toBeFalsy();
    expect(getList(dataCalls('acs/acs5/cprofile', 2024)[0])).toEqual([
      'NAME',
      'CP03_2024_062E',
      'CP03_2024to2019_062SS',
    ]);
    const out = structured(result);
    expect(out.sortVariable).toBe('CP03_2024to2019_062SS');
    expect(out.rows.map((r) => r.variables.CP03_2024to2019_062SS?.value)).toEqual(['*', '*', '*']);
    // The column holds text on every row, so the notice names it as the unranked sort key.
    expect(out.notice).toContain('No row carries a number for CP03_2024to2019_062SS');
    expect(textOf(result)).toContain('No row carries a number for CP03_2024to2019_062SS');
  });

  it('census_compare_geographies still ranks the estimate when sort_by names it in lowercase', async () => {
    serveCprofile();

    const result = await runToolContract(censusCompareGeographies, {
      dataset: 'acs/acs5/cprofile',
      variables: ['cp03_2024_062e', 'CP03_2024to2019_062SS'],
      geography_level: 'state',
      sort_by: 'cp03_2024_062e',
    });

    const out = structured(result);
    expect(out.sortVariable).toBe('CP03_2024_062E');
    expect(out.rows.map((r) => r.geography_name)).toEqual(['Washington', 'Alaska', 'Alabama']);
  });

  it('refuses a sort_by outside the variables before any request, in uppercase', async () => {
    serveCprofile();

    const result = await runToolContract(censusCompareGeographies, {
      dataset: 'acs/acs5/cprofile',
      variables: ['CP03_2024_062E'],
      geography_level: 'state',
      sort_by: 'cp03_2024to2019_062ss',
    });

    expect(errorOf(result).data).toMatchObject({
      reason: 'sort_by_not_requested',
      sortBy: 'CP03_2024TO2019_062SS',
      variables: ['CP03_2024_062E'],
    });
    expect(calls).toHaveLength(0);
  });

  it('names an unknown code in its uppercased form', async () => {
    serveMetadata('acs/acs5', 2024, acsVariables);
    serveData('acs/acs5', 2024, (url) => {
      const unknown = getList(url).find((code) => code !== 'NAME' && !(code in acsVariables));
      return new Response(`error: unknown variable '${unknown}'`, {
        status: 400,
        headers: { 'content-type': 'text/plain' },
      });
    });

    const result = await runToolContract(censusQueryData, {
      variables: ['b19013_001x'],
      geography_level: 'state',
      geography_fips: '53',
    });

    expect(errorOf(result).data).toMatchObject({
      reason: 'variable_not_found',
      missingCodes: ['B19013_001X'],
    });
    expect(getList(dataCalls('acs/acs5', 2024)[0])).toEqual(['NAME', 'B19013_001X']);
  });

  /**
   * The predicate check has already loaded variables.json when the codes are spelled, so a
   * successful call sends the same requests it always has: geography.json, variables.json, data.
   */
  it.each([
    [
      'census_query_data',
      censusQueryData,
      { geography_fips: '53', variables: ['CP03_2024_062E', 'cp03_2024to2019_062ss'] },
    ],
    [
      'census_compare_geographies',
      censusCompareGeographies,
      { variables: ['CP03_2024_062E', 'cp03_2024to2019_062ss'] },
    ],
  ] as const)('%s spends no request on spelling', async (_name, definition, input) => {
    serveCprofile();

    const result = await runToolContract(
      definition as typeof censusQueryData,
      { dataset: 'acs/acs5/cprofile', geography_level: 'state', ...input } as never,
    );

    expect(result.isError).toBeFalsy();
    expect(calls.map((u) => u.pathname)).toEqual([
      '/data/2024/acs/acs5/cprofile/geography.json',
      '/data/2024/acs/acs5/cprofile/variables.json',
      '/data/2024/acs/acs5/cprofile',
    ]);
  });
});

/**
 * A successful call's upstream requests, pinned before the spelling and sibling lookups landed:
 * neither may add a request to a call that succeeds.
 */
describe('a successful data call sends the same requests as before (characterization)', () => {
  it.each([
    ['census_query_data', censusQueryData, { geography_fips: '53' }],
    ['census_compare_geographies', censusCompareGeographies, {}],
  ] as const)(
    '%s sends geography.json, variables.json, then the data request',
    async (_n, def, scope) => {
      serveMetadata('acs/acs5', 2024, acsVariables);
      serveData('acs/acs5', 2024, () => [
        ['NAME', 'B19013_001E', 'state'],
        ['Washington', '103748', '53'],
      ]);

      const result = await runToolContract(
        def as typeof censusQueryData,
        { variables: ['b19013_001e'], geography_level: 'state', ...scope } as never,
      );

      expect(result.isError).toBeFalsy();
      expect(calls.map((u) => u.pathname)).toEqual([
        '/data/2024/acs/acs5/geography.json',
        '/data/2024/acs/acs5/variables.json',
        '/data/2024/acs/acs5',
      ]);
    },
  );
});

// ---------------------------------------------------------------------------------------------
// #65 — variable_not_found names the sibling dataset that holds the code
// ---------------------------------------------------------------------------------------------

describe('variable_not_found names the sibling dataset that publishes the code', () => {
  /** The servlet container page the per-variable endpoint answers a code it lacks with. */
  const notHeld = () =>
    new Response(
      '<!doctype html><html lang="en"><head><title>HTTP Status 404 – Not Found</title></head><body><h1>HTTP Status 404 – Not Found</h1></body></html>',
      { status: 404, headers: { 'content-type': 'text/html' } },
    );

  /** The live 2024 acs/acs5/subject record for S1701_C03_001E. */
  const S1701_RECORD = {
    name: 'S1701_C03_001E',
    label:
      'Estimate!!Percent below poverty level!!Population for whom poverty status is determined',
    concept: 'Poverty Status in the Past 12 Months',
    predicateType: 'float',
    group: 'S1701',
    limit: 0,
    attributes: 'S1701_C03_001EA,S1701_C03_001M,S1701_C03_001MA',
  };

  const rejectUnknown = (url: URL) => {
    const unknown = getList(url).find((code) => code !== 'NAME' && !(code in acsVariables));
    return new Response(`error: unknown variable '${unknown}'`, {
      status: 400,
      headers: { 'content-type': 'text/plain' },
    });
  };

  const lookups = () => calls.filter((u) => u.pathname.includes('/variables/'));

  it.each([
    ['census_query_data', censusQueryData, { geography_fips: '53' }],
    ['census_compare_geographies', censusCompareGeographies, {}],
  ] as const)(
    '%s points S1701_C03_001E on acs/acs5 at acs/acs5/subject',
    async (_n, def, scope) => {
      serveMetadata('acs/acs5', 2024, acsVariables);
      serveData('acs/acs5', 2024, rejectUnknown);
      routes.push({
        match: (u) => u.pathname === '/data/2024/acs/acs5/subject/variables/S1701_C03_001E.json',
        respond: () => S1701_RECORD,
      });

      const result = await runToolContract(
        def as typeof censusQueryData,
        { variables: ['S1701_C03_001E'], geography_level: 'state', ...scope } as never,
      );

      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data).toMatchObject({
        reason: 'variable_not_found',
        missingCodes: ['S1701_C03_001E'],
        dataset: 'acs/acs5',
      });
      const hint = (error.data.recovery as { hint: string }).hint;
      expect(hint).toContain('S1701_C03_001E is in acs/acs5/subject — query that dataset');
      expect(hint).not.toContain('not acs/acs5');
      expect(hint).toContain('names only the first unknown code');
      expect(textOf(result)).toContain('S1701_C03_001E is in acs/acs5/subject');
      expect(dataCalls('acs/acs5', 2024)).toHaveLength(1);
      expect(lookups().map((u) => u.pathname)).toEqual([
        '/data/2024/acs/acs5/subject/variables/S1701_C03_001E.json',
      ]);
    },
  );

  it('keeps the search hint when no candidate holds the code', async () => {
    serveMetadata('acs/acs5', 2024, acsVariables);
    serveData('acs/acs5', 2024, rejectUnknown);
    routes.push({ match: (u) => u.pathname.includes('/variables/S9999_'), respond: notHeld });

    const result = await runToolContract(censusQueryData, {
      variables: ['S9999_C99_999E'],
      geography_level: 'state',
      geography_fips: '53',
    });

    const hint = (errorOf(result).data.recovery as { hint: string }).hint;
    expect(hint).toBe(
      'Call census_search_variables to find valid codes for this dataset and year, or census_get_variable to confirm one. The Census API names only the first unknown code in a request, so check the others before retrying.',
    );
    expect(lookups().map((u) => u.pathname)).toEqual([
      '/data/2024/acs/acs5/subject/variables/S9999_C99_999E.json',
      '/data/2024/acs/acs1/subject/variables/S9999_C99_999E.json',
      '/data/2024/acs/acs1/spp/variables/S9999_C99_999E.json',
    ]);
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

  /**
   * Two King County rows nothing in the response separates. cbp declares filter dimensions, so
   * both tools send the caller to them — never to GEO_ID, which pins rows only on a dataset that
   * declares none (geoinfo, #92).
   */
  const unseparatedRows = (url: URL) => {
    const [header = [], row = []] = cbpRows(url);
    return [header, row, header.map((column, i) => (column === 'ESTAB' ? '612' : row[i]))];
  };
  const pinned = { NAICS2017: '00', LFO: '001', EMPSZES: '001' };

  it('census_query_data names the filter dimensions for one geography on rows nothing separates', async () => {
    serveMetadata('cbp', 2023, cbpVariables);
    serveData('cbp', 2023, unseparatedRows);

    const result = await runToolContract(censusQueryData, {
      variables: ['ESTAB'],
      geography_level: 'county',
      geography_fips: '033',
      parent_fips: '53',
      dataset: 'cbp',
      predicates: pinned,
    });

    expect(structured(result).rows).toHaveLength(2);
    const notice = structured(result).notice ?? '';
    expect(notice).toContain(
      "cbp (2023) returned 2 rows for a single geography and nothing in the response separates them. Set the dataset's filter dimensions explicitly in predicates to pin one — census_list_predicate_values enumerates the codes each one accepts.",
    );
    expect(notice).not.toContain('GEO_ID');
    expect(readNotice(result)).toBe(notice);
  });

  it('census_compare_geographies names the filter dimensions for rows nothing separates', async () => {
    serveMetadata('cbp', 2023, cbpVariables);
    serveData('cbp', 2023, unseparatedRows);

    const result = await runToolContract(censusCompareGeographies, {
      variables: ['ESTAB'],
      geography_level: 'county',
      within: '53',
      dataset: 'cbp',
      predicates: pinned,
    });

    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.data).toMatchObject({ reason: 'ambiguous_rows', rowsPerGeography: 2 });
    const hint = (error.data.recovery as { hint: string }).hint;
    expect(hint).toBe(
      "Set the dataset's filter dimensions explicitly in predicates — census_list_predicate_values enumerates the codes each one accepts — or query one geography at a time with census_query_data.",
    );
    const paragraphs = readParagraphs(textOf(result));
    expect(paragraphs.find((p) => p.startsWith('Recovery: '))).toBe(`Recovery: ${hint}`);
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
  nextOffset?: number;
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
    expect(pages.map((p) => p.totalCount)).toEqual([1234, 1234, 1234]);
    expect(pages.map((p) => p.truncated)).toEqual([true, true, false]);
    expect(pages.map((p) => p.nextOffset)).toEqual([500, 1000, undefined]);
    expect(pages[1]?.notice).toContain('Rows 501–1,000 of 1,234');
    expect(pages[1]?.notice).toContain('offset: 1000');
    // The last page names no next offset: there is nothing after it.
    expect(pages[2]?.notice).toContain('Rows 1,001–1,234 of 1,234');
    expect(pages[2]?.notice).toMatch(/last page/i);
    expect(pages[2]?.notice).not.toContain('offset: 1500');
  });

  /** #95: a limit above the 500 cap is served at the cap and said so, ahead of the paging sentence. */
  it.each([501, '600'])(
    'serves limit %j at 500 rows, saying so on both surfaces',
    async (limit) => {
      serveTracts(1234);

      const result = await runToolContract(censusQueryData, laTracts({ limit }));

      expect(result.isError).toBeFalsy();
      const out = paged(result);
      expect(out.rows).toHaveLength(500);
      expect(out.totalCount).toBe(1234);
      expect(out.nextOffset).toBe(500);
      const sentence = `limit ${Number(limit)} is over the 500-row cap, so this page holds up to 500 rows. Rows 1–500 of 1,234`;
      expect(out.notice).toContain(sentence);
      expect(out.notice).not.toContain('raise limit');
      expect(textOf(result)).toContain(sentence);
    },
  );

  it('reads the served limit past the end, naming the last 500 rows rather than 600', async () => {
    serveTracts(1234);

    const out = paged(
      await runToolContract(censusQueryData, laTracts({ limit: 600, offset: 1234 })),
    );

    expect(out.rows).toEqual([]);
    expect(out.notice).toContain('offset: 734 returns the last 500.');
  });

  it('adds no clamp sentence at the cap itself', async () => {
    serveTracts(1234);

    const out = paged(await runToolContract(censusQueryData, laTracts({ limit: 500 })));

    expect(out.rows).toHaveLength(500);
    expect(out.notice).not.toContain('is over the');
    expect(out.notice).toContain('Rows 1–500 of 1,234');
  });

  it('serves limit 600 at 500 and says so when every row fits the page', async () => {
    serveTracts(3);

    const out = paged(await runToolContract(censusQueryData, laTracts({ limit: 600 })));

    expect(out.rows).toHaveLength(3);
    expect(out.notice).toBe(
      'limit 600 is over the 500-row cap, so this page holds up to 500 rows.',
    );
  });

  it('names the last rows a past-end offset reaches when fewer rows match than the limit', async () => {
    serveTracts(3);

    const out = paged(await runToolContract(censusQueryData, laTracts({ offset: 10 })));

    expect(out.rows).toEqual([]);
    expect(out.notice).toBe(
      'offset 10 is past the last of the 3 rows this query matched, so no rows are returned. Pass an offset below 3 — offset: 0 returns the last 3.',
    );
  });

  it('states the default page and the cap in the tool description', () => {
    expect(censusQueryData.description).toContain(
      'rows come back in GEOID order, up to limit per call (default 50, at most 500), with totalCount giving how many matched',
    );
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
      expect(out.truncated).toBe(false);
      expect(out.nextOffset).toBeUndefined();
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

  it('offers the next page when an unranked, unscoped list is at the maximum limit', async () => {
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
    expect(out.notice).toContain('offset: 500');
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
    // #62: the message states what is missing; where to find codes is the hint's.
    expect(error.message).toBe('At least one variable code is required.');
    expect(error.data).toMatchObject({
      variableCount: 0,
      recovery: {
        hint: 'Pass variable codes such as B01003_001E — census_search_variables finds them.',
      },
    });
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
    // #88: a table in group is the other way to name something to retrieve.
    expect(errorOf(result).message).toBe(
      'At least one variable code or a table in group is required.',
    );
    expect(errorOf(result).data.reason).toBe('variables_or_group_required');
    expect(textOf(result)).toContain(
      'Recovery: Pass variable codes such as `B01003_001E`, or a table ID such as `B01001` in group — census_search_variables finds both.',
    );
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

  /** Adding the tract alone would leave `county:*` under it, which the Census API refuses. */
  it('names the concrete county and the tract a single block group under a "*" county needs', async () => {
    serveBlockGroups();

    const result = await runToolContract(
      censusQueryData,
      kingBlockGroups({ county_fips: '*', tract_fips: '' }),
    );

    const error = errorOf(result);
    expect(error.data.reason).toBe('parent_required');
    expect(error.data.missingParents).toEqual(['county', 'tract']);
    expect((error.data.recovery as { hint: string }).hint).toBe(
      'To query this level, set county_fips to one 3-digit county FIPS instead of "*" (census_resolve_geography returns it as county_fips), and add tract_fips (census_resolve_geography returns it as tract_fips, and for a street address also returns the block group as block_group_fips).',
    );
    expect(dataCalls('acs/acs5', 2024)).toHaveLength(0);
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
      // The 2021–2024 vintages carry the 2020 columns; the 2025 default does not (#91).
      year: 2024,
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
// #54, #68 — tables that split POPGROUP groups between them
// ---------------------------------------------------------------------------------------------

/**
 * A tables-of-one-family model of dec/ddhcb and dec/ddhca, built from api.census.gov answers
 * captured on 2026-10-13. Each table publishes a group at a geography or it does not; within a
 * family a group sits in only one table there. A request is answered the way the Census answers
 * it: rows only where the first-listed table publishes the group (HTTP 204 when none), and null in
 * a later column whose table does not.
 */
interface SplitModel {
  /** Cell values by `<code>|<group>|<geography key>`; any other published cell reads 100. */
  cells: Record<string, string>;
  /** The groups each table publishes, per geography key (`us`, `53`, `53:011`). */
  publishes: Record<string, Record<string, readonly string[]>>;
}

const ddhcbWashingtonT03004 = (
  JSON.parse(
    readFileSync(new URL('../fixtures/dec-ddhcb-2020-popgroup.json', import.meta.url), 'utf8'),
  ) as { washington: { T03004_001N: string } }
).washington.T03004_001N.split(' ');

const WA_COUNTIES_WITH_1002_IN_T03004 = {
  '011': ['Clark County, Washington', '71093'],
  '033': ['King County, Washington', '240919'],
  '053': ['Pierce County, Washington', '108879'],
  '061': ['Snohomish County, Washington', '103172'],
  '063': ['Spokane County, Washington', '76863'],
} as const;

const ddhcbModel: SplitModel = {
  publishes: {
    '53': {
      T03001: ['3910'],
      T03002: ['1360'],
      T03003: ['1631'],
      T03004: ddhcbWashingtonT03004,
      T04001: ['3910'],
      T04002: ['1002'],
    },
    ...Object.fromEntries(
      Object.keys(WA_COUNTIES_WITH_1002_IN_T03004).map((county) => [
        `53:${county}`,
        { T03004: ['1002'] },
      ]),
    ),
  },
  cells: {
    'T03001_001N|3910|53': '997',
    'T03002_002N|1360|53': '1769',
    'T03003_003N|1631|53': '9491',
    'T03004_002N|1002|53': '932571',
    'T04001_001N|3910|53': '950',
    'T04002_004N|1002|53': '457109',
    'T04002_001N|1002|53': '1467827',
    ...Object.fromEntries(
      Object.entries(WA_COUNTIES_WITH_1002_IN_T03004).map(([county, [, value]]) => [
        `T03004_002N|1002|53:${county}`,
        value,
      ]),
    ),
  },
};

const ddhcaModel: SplitModel = {
  publishes: {
    us: { T01001: ['1002', '1360'], T02002: ['1360'], T02003: ['1002'] },
    '02': { T01001: ['1360'], T02002: ['1360'] },
    '06': { T01001: ['1002'], T02001: ['1002'] },
    '53': { T01001: ['1002'], T02001: ['1002'] },
  },
  cells: {
    'T02002_001N|1360|us': '133311',
    'T01001_001N|1360|us': '133311',
    'T02003_001N|1002|us': '120113090',
    'T02002_001N|1360|02': '102765',
  },
};

const GROUP_LABELS: Record<string, string> = {
  '1002': 'European alone',
  '1360': 'Alaska Native alone',
  '1631': 'Mexican',
  '3910': 'Thai alone',
};

/** Answer a data request against a model; the default POPGROUP is 1002 (European alone). */
const answerSplit =
  (model: SplitModel) =>
  (url: URL): Body => {
    const get = getList(url);
    const measures = get.filter((code) => /^T\d{5}_\d{3}N$/.test(code));
    const tableOf = (code: string) => code.split('_')[0] as string;
    const [level, fips] = (url.searchParams.get('for') ?? '').split(':') as [string, string];
    const state = url.searchParams.get('in')?.split(':')[1];
    const keys =
      level === 'us'
        ? ['us']
        : level === 'state'
          ? fips === '*'
            ? Object.keys(model.publishes).filter((key) => /^\d{2}$/.test(key))
            : fips.split(',').filter((one) => Object.hasOwn(model.publishes, one))
          : Object.keys(model.publishes).filter(
              (key) =>
                key.startsWith(`${state}:`) &&
                (fips === '*' || fips.split(',').some((one) => key === `${state}:${one}`)),
            );
    const sent = url.searchParams.get('POPGROUP');
    const published = (table: string, key: string) => model.publishes[key]?.[table] ?? [];
    const first = tableOf(measures[0] as string);

    const rows = keys.flatMap((key) => {
      const groups = sent === '*' ? published(first, key) : [sent ?? '1002'];
      return groups
        .filter((group) => published(first, key).includes(group))
        .map((group) => [
          ...get.map((code) => {
            if (code === 'NAME') return level === 'us' ? 'United States' : `Place ${key}`;
            if (code === 'GEO_ID') return `GEO${key.replace(':', '')}`;
            if (code === 'POPGROUP_LABEL') return GROUP_LABELS[group] ?? `Group ${group}`;
            return published(tableOf(code), key).includes(group)
              ? (model.cells[`${code}|${group}|${key}`] ?? '100')
              : null;
          }),
          ...(sent ? [group] : []),
          ...(level === 'county' ? [state, key.split(':')[1]] : [key === 'us' ? '1' : key]),
        ]);
    });
    if (rows.length === 0) return new Response(null, { status: 204 });
    const geoColumns = level === 'county' ? ['state', 'county'] : [level];
    return [[...get, ...(sent ? ['POPGROUP'] : []), ...geoColumns], ...rows];
  };

const popgroupDimension = (group: string) => ({
  POPGROUP: {
    label: 'Race/Ethnic Group',
    required: 'default displayed',
    predicateType: 'string',
    group,
    attributes: 'POPGROUP_LABEL',
  },
  GEOCOMP: { label: 'GEO_ID Component', required: 'default displayed', predicateType: 'string' },
});

const ddhcbVariables = {
  T03001_001N: { label: '!!Total', predicateType: 'int', group: 'T03001' },
  T03002_002N: { label: '!!Total:!!Family households', predicateType: 'int', group: 'T03002' },
  T03003_003N: {
    label: '!!Total:!!Family households:!!Married couple family',
    predicateType: 'int',
    group: 'T03003',
  },
  T03004_002N: { label: '!!Total:!!Family households:', predicateType: 'int', group: 'T03004' },
  T04001_001N: { label: '!!Total', predicateType: 'int', group: 'T04001' },
  T04002_001N: { label: '!!Total:', predicateType: 'int', group: 'T04002' },
  T04002_004N: { label: '!!Total:!!Renter occupied', predicateType: 'int', group: 'T04002' },
  ...popgroupDimension('T03002,T03001,T04002,T04001,T03004,T03003'),
};

const ddhcaVariables = {
  T01001_001N: { label: ' !!Total', predicateType: 'int', group: 'T01001' },
  T02001_001N: { label: ' !!Total:', predicateType: 'int', group: 'T02001' },
  T02002_001N: { label: ' !!Total:', predicateType: 'int', group: 'T02002' },
  T02003_001N: { label: ' !!Total:', predicateType: 'int', group: 'T02003' },
  ...popgroupDimension('T02001,T01001,T02002,T02003'),
};

const serveDdhcb = () => {
  serveMetadata('dec/ddhcb', 2020, ddhcbVariables);
  serveData('dec/ddhcb', 2020, answerSplit(ddhcbModel));
};

const serveDdhca = () => {
  serveMetadata('dec/ddhca', 2020, ddhcaVariables);
  serveData('dec/ddhca', 2020, answerSplit(ddhcaModel));
};

const inWashington = { dataset: 'dec/ddhcb', geography_level: 'state', geography_fips: '53' };

/** The table-split guidance, recognized by the sentence every form of it carries. */
const SPLIT = /publishes a POPGROUP group in only one of/;

describe('dec/ddhcb answers the acceptance cells in WA, with no guidance on a one-cell result (#54)', () => {
  it.each([
    ['T03001_001N', '3910', 997],
    ['T03002_002N', '1360', 1769],
    ['T03003_003N', '1631', 9491],
    ['T03004_002N', '1002', 932571],
    ['T04001_001N', '3910', 950],
    ['T04002_004N', '1002', 457109],
  ])('%s for POPGROUP %s is %d', async (code, group, value) => {
    serveDdhcb();

    const result = await runToolContract(censusQueryData, {
      ...inWashington,
      variables: [code],
      predicates: { POPGROUP: group },
    });

    expect(result.isError).toBeFalsy();
    expect(structured(result).rows[0]?.variables[code]?.estimate).toBe(value);
    expect(structured(result)).not.toHaveProperty('notice');
    expect(textOf(result)).toContain(value.toLocaleString('en-US'));
    expect(textOf(result)).not.toMatch(SPLIT);
    expect(calls.map((u) => u.pathname)).toEqual([
      '/data/2020/dec/ddhcb/geography.json',
      '/data/2020/dec/ddhcb/variables.json',
      '/data/2020/dec/ddhcb',
    ]);
  });

  /** An unset POPGROUP applies 1002, European alone — echoed, and the one value asked for. */
  it('answers T04002_001N with POPGROUP unset as European alone, 1,467,827', async () => {
    serveDdhcb();

    const result = await runToolContract(censusQueryData, {
      ...inWashington,
      variables: ['T04002_001N'],
    });

    const [row] = structured(result).rows;
    expect(row?.variables.T04002_001N?.estimate).toBe(1467827);
    expect(row?.applied_filters).toEqual({ POPGROUP: 'European alone' });
    expect(structured(result).notice).toContain('the API applied "European alone"');
    expect(structured(result).notice).not.toMatch(SPLIT);
    expect(textOf(result)).toContain('**Applied filter defaults:** POPGROUP = European alone');
  });
});

describe('dec/ddhcb results that can miss a group or geography carry the table guidance (#54)', () => {
  it('no_data on T03001_001N for 1002 names T03002, T03003, and T03004, on both surfaces', async () => {
    serveDdhcb();

    const result = await runToolContract(censusQueryData, {
      ...inWashington,
      variables: ['T03001_001N'],
      predicates: { POPGROUP: '1002' },
    });

    const error = errorOf(result);
    expect(error.data).toMatchObject({ reason: 'no_data' });
    const hint = (error.data.recovery as { hint: string }).hint;
    expect(hint).toMatch(SPLIT);
    expect(hint).toContain('T03002, T03003, or T03004');
    expect(textOf(result)).toContain(`Recovery: ${hint}`);
    expect(calls).toHaveLength(3);
  });

  it('explains the null in T04002_004N when T03001_001N leads, on both surfaces', async () => {
    serveDdhcb();

    const result = await runToolContract(censusQueryData, {
      ...inWashington,
      variables: ['T03001_001N', 'T04002_004N'],
      predicates: { POPGROUP: '3910' },
    });

    const [row] = structured(result).rows;
    expect(row?.variables.T03001_001N?.estimate).toBe(997);
    expect(row?.variables.T04002_004N).toMatchObject({ estimate: null, suppressed: false });
    const notice = structured(result).notice as string;
    expect(notice).toContain('missing from T04002');
    expect(notice).toContain('T04001');
    expect(notice).toMatch(/first-listed one, T03001/);
    expect(textOf(result)).toContain(notice);
    expect(dataCalls('dec/ddhcb', 2020)).toHaveLength(1);
  });

  it('answers the reverse order with no_data and the same guidance', async () => {
    serveDdhcb();

    const result = await runToolContract(censusQueryData, {
      ...inWashington,
      variables: ['T04002_004N', 'T03001_001N'],
      predicates: { POPGROUP: '3910' },
    });

    const hint = (errorOf(result).data.recovery as { hint: string }).hint;
    expect(errorOf(result).data).toMatchObject({ reason: 'no_data' });
    expect(hint).toContain('missing from T04002');
    expect(hint).toContain('T04001');
    expect(hint).toMatch(/first-listed one, T04002/);
    expect(textOf(result)).toContain(`Recovery: ${hint}`);
  });

  it('breaks T03004_002N out by POPGROUP "*" into 160 rows, with the guidance', async () => {
    serveDdhcb();

    const result = await runToolContract(censusQueryData, {
      ...inWashington,
      variables: ['T03004_002N'],
      predicates: { POPGROUP: '*' },
      limit: 500,
    });

    const out = structured(result);
    expect(out.rows).toHaveLength(160);
    expect(out.rows.find((r) => r.record?.POPGROUP?.code === '1002')?.variables).toMatchObject({
      T03004_002N: { estimate: 932571 },
    });
    expect(out.notice).toContain('one row per category of POPGROUP');
    expect(out.notice).toContain('missing from T03004');
    expect(out.notice).toContain('T03001, T03002, or T03003');
    // The notice quotes "*", which content[] carries escaped and reads back as written (#72).
    expect(readNotice(result)).toBe(out.notice);
    expect(dataCalls('dec/ddhcb', 2020)).toHaveLength(1);
  });

  /** WA has 39 counties; 1002 sits in T03004 in 5 of them, T03003 in 19, T03002 in 10, T03001 in 5. */
  it('ranks the 5 counties T03004 publishes 1002 in, and says the rest may sit elsewhere', async () => {
    serveDdhcb();

    const result = await runToolContract(censusCompareGeographies, {
      dataset: 'dec/ddhcb',
      variables: ['T03004_002N'],
      geography_level: 'county',
      within: '53',
      predicates: { POPGROUP: '1002' },
    });

    const out = structured(result);
    expect(out.rows.map((r) => r.variables.T03004_002N?.estimate)).toEqual([
      240919, 108879, 103172, 76863, 71093,
    ]);
    expect(out.notice).toMatch(SPLIT);
    expect(out.notice).toContain('T03001, T03002, or T03003');
    expect(textOf(result)).toContain(out.notice as string);
    expect(calls.map((u) => u.pathname)).toEqual([
      '/data/2020/dec/ddhcb/geography.json',
      '/data/2020/dec/ddhcb/variables.json',
      '/data/2020/dec/ddhcb',
    ]);
  });

  it('carries the guidance on a comparison that came back empty', async () => {
    serveDdhcb();

    const result = await runToolContract(censusCompareGeographies, {
      dataset: 'dec/ddhcb',
      variables: ['T03002_002N'],
      geography_level: 'county',
      within: '53',
      predicates: { POPGROUP: '1360' },
    });

    expect(errorOf(result).data).toMatchObject({ reason: 'no_data' });
    const hint = (errorOf(result).data.recovery as { hint: string }).hint;
    expect(hint).toContain('T03001, T03003, or T03004');
    expect(textOf(result)).toContain(`Recovery: ${hint}`);
  });

  it('carries the guidance when a geographies filter matched no row', async () => {
    serveDdhcb();

    const result = await runToolContract(censusCompareGeographies, {
      dataset: 'dec/ddhcb',
      variables: ['T03004_002N'],
      geography_level: 'county',
      within: '53',
      predicates: { POPGROUP: '1002' },
      geographies: ['53001'],
    });

    expect(errorOf(result).data).toMatchObject({ reason: 'no_data' });
    const hint = (errorOf(result).data.recovery as { hint: string }).hint;
    expect(hint).toContain('GEOID');
    expect(hint).toContain('T03001, T03002, or T03003');
  });
});

describe('dec/ddhca T02001–T02003 carry the same guidance (#68)', () => {
  const atUs = { dataset: 'dec/ddhca', geography_level: 'us', geography_fips: '1' };

  it('no_data on T02003_001N for 1360 names T02001 and T02002', async () => {
    serveDdhca();

    const result = await runToolContract(censusQueryData, {
      ...atUs,
      variables: ['T02003_001N'],
      predicates: { POPGROUP: '1360' },
    });

    expect(errorOf(result).data).toMatchObject({ reason: 'no_data' });
    const hint = (errorOf(result).data.recovery as { hint: string }).hint;
    expect(hint).toContain('T02001 or T02002');
    expect(hint.indexOf('T02002')).toBeLessThan(hint.indexOf('check the POPGROUP value'));
    expect(textOf(result)).toContain(`Recovery: ${hint}`);
  });

  it('answers T02002_001N for 1360 with 133,311 and no notice', async () => {
    serveDdhca();

    const result = await runToolContract(censusQueryData, {
      ...atUs,
      variables: ['T02002_001N'],
      predicates: { POPGROUP: '1360' },
    });

    expect(structured(result).rows[0]?.variables.T02002_001N?.estimate).toBe(133311);
    expect(structured(result)).not.toHaveProperty('notice');
    expect(textOf(result)).toContain('133,311');
  });

  /** T01001 publishes every group the dataset serves: nothing about it is split. */
  it('adds nothing to a T01001_001N comparison across states (characterization)', async () => {
    serveDdhca();

    const result = await runToolContract(censusCompareGeographies, {
      dataset: 'dec/ddhca',
      variables: ['T01001_001N'],
      geography_level: 'state',
      predicates: { POPGROUP: '1002' },
    });

    expect(structured(result).rows).toHaveLength(2);
    expect(structured(result)).not.toHaveProperty('notice');
  });

  it('adds the guidance to a T02001_001N comparison across states', async () => {
    serveDdhca();

    const result = await runToolContract(censusCompareGeographies, {
      dataset: 'dec/ddhca',
      variables: ['T02001_001N'],
      geography_level: 'state',
      predicates: { POPGROUP: '1002' },
    });

    expect(structured(result).rows).toHaveLength(2);
    expect(structured(result).notice).toContain('T02002 or T02003');
    expect(textOf(result)).toContain(structured(result).notice as string);
    expect(dataCalls('dec/ddhca', 2020)).toHaveLength(1);
  });
});

/**
 * GEO_ID and NAME are columns of every table, not tables: the Census picks the rows by the first
 * measure listed, so `GEO_ID,T03001_001N` for 1002 in WA is HTTP 204 and `GEO_ID,T03004_002N` is
 * T03004's one row (api.census.gov, 2026-10-13).
 */
describe('table-split guidance reads only measure codes as tables (#54, #68)', () => {
  it('stays off a one-cell, one-table answer that also asks for GEO_ID, on both surfaces', async () => {
    serveDdhcb();

    const result = await runToolContract(censusQueryData, {
      ...inWashington,
      variables: ['GEO_ID', 'T03004_002N'],
      predicates: { POPGROUP: '1002' },
    });

    expect(structured(result).rows[0]?.variables.T03004_002N?.estimate).toBe(932571);
    expect(structured(result)).not.toHaveProperty('notice');
    expect(textOf(result)).not.toMatch(SPLIT);
  });

  it('stays off a one-cell, one-table answer that lists NAME after the measure', async () => {
    serveDdhcb();

    const result = await runToolContract(censusQueryData, {
      ...inWashington,
      variables: ['T03004_002N', 'NAME'],
      predicates: { POPGROUP: '1002' },
    });

    expect(structured(result).rows[0]?.variables.T03004_002N?.estimate).toBe(932571);
    expect(structured(result)).not.toHaveProperty('notice');
  });

  it('blames the measure table, not GEO_ID, when GEO_ID leads an empty query', async () => {
    serveDdhcb();

    const result = await runToolContract(censusQueryData, {
      ...inWashington,
      variables: ['GEO_ID', 'T03001_001N'],
      predicates: { POPGROUP: '1002' },
    });

    expect(errorOf(result).data).toMatchObject({ reason: 'no_data' });
    const hint = (errorOf(result).data.recovery as { hint: string }).hint;
    expect(hint).toContain('missing from T03001 may be published in T03002, T03003, or T03004');
    expect(hint).not.toContain('first-listed');
    expect(hint).not.toMatch(/\bGEO\b/);
    expect(textOf(result)).toContain(`Recovery: ${hint}`);
  });

  it('names the first measure table on a multi-table comparison that leads with GEO_ID', async () => {
    serveDdhcb();

    const result = await runToolContract(censusCompareGeographies, {
      dataset: 'dec/ddhcb',
      variables: ['GEO_ID', 'T03004_002N', 'T04002_004N'],
      sort_by: 'T03004_002N',
      geography_level: 'county',
      within: '53',
      predicates: { POPGROUP: '1002' },
    });

    const notice = structured(result).notice as string;
    expect(notice).toMatch(/first-listed one, T03004/);
    expect(notice).not.toMatch(/\bGEO\b/);
    expect(textOf(result)).toContain(notice);
  });
});

/**
 * The Census API takes a comma-separated list in `for=` (`county:033,001`), and the tool passes
 * geography_fips through, so a list is several geographies: Adams County (001) publishes 1002 in
 * T03001, not T03004, and drops out of the rows.
 */
describe('a comma-separated geography_fips gets the table guidance (#54)', () => {
  it('names the sibling tables when a listed county has no row, on both surfaces', async () => {
    serveDdhcb();

    const result = await runToolContract(censusQueryData, {
      dataset: 'dec/ddhcb',
      geography_level: 'county',
      geography_fips: '033,001',
      parent_fips: '53',
      variables: ['T03004_002N'],
      predicates: { POPGROUP: '1002' },
    });

    expect(structured(result).rows.map((r) => r.geography_geoid)).toEqual(['53033']);
    const notice = structured(result).notice as string;
    expect(notice).toContain('missing from T03004 may be published in T03001, T03002, or T03003');
    expect(textOf(result)).toContain(notice);
  });

  it('stays off one county named on its own (characterization)', async () => {
    serveDdhcb();

    const result = await runToolContract(censusQueryData, {
      dataset: 'dec/ddhcb',
      geography_level: 'county',
      geography_fips: '033',
      parent_fips: '53',
      variables: ['T03004_002N'],
      predicates: { POPGROUP: '1002' },
    });

    expect(structured(result).rows[0]?.variables.T03004_002N?.estimate).toBe(240919);
    expect(structured(result)).not.toHaveProperty('notice');
  });

  /** #100: the list reads as one county, so it is one cell like the code on its own. */
  it('stays off one county listed twice by its GEOID', async () => {
    serveDdhcb();

    const result = await runToolContract(censusQueryData, {
      dataset: 'dec/ddhcb',
      geography_level: 'county',
      geography_fips: '53033,53033',
      variables: ['T03004_002N'],
      predicates: { POPGROUP: '1002' },
    });

    expect(structured(result).rows[0]?.variables.T03004_002N?.estimate).toBe(240919);
    expect(structured(result)).not.toHaveProperty('notice');
  });
});

// ---------------------------------------------------------------------------------------------
// #74 — a comma-separated geography_fips names the members that matched no row
// #72 — caller text quoted in a notice reads back literally from content[]
// ---------------------------------------------------------------------------------------------

/**
 * acs/acs5 2024 as api.census.gov answers a `for=` list (2026-10-29): each member trimmed, a code
 * it does not publish (99, or the unpadded 6) dropped without an error, a repeat collapsed, rows in
 * GEOID order whatever the list order, and HTTP 204 when no member matched.
 */
const LIST_STATES: Record<string, string> = {
  '02': 'Alaska',
  '06': 'California',
  '16': 'Idaho',
  '32': 'Nevada',
  '41': 'Oregon',
  '53': 'Washington',
};
const LIST_COUNTIES: Record<string, string> = {
  '033': 'King County, Washington',
  '061': 'Snohomish County, Washington',
};

const serveLists = () => {
  serveMetadata('acs/acs5', 2024, acsVariables);
  serveData('acs/acs5', 2024, (url) => {
    const get = getList(url);
    const [level, list] = (url.searchParams.get('for') ?? '').split(':') as [string, string];
    const known = level === 'state' ? LIST_STATES : LIST_COUNTIES;
    const codes =
      list === '*'
        ? Object.keys(known)
        : [...new Set(list.split(',').map((m) => m.trim()))].filter((m) => Object.hasOwn(known, m));
    if (codes.length === 0) return new Response(null, { status: 204 });
    const geo = level === 'state' ? ['state'] : ['state', 'county'];
    return [
      [...get, ...geo],
      ...codes
        .sort()
        .map((code) => [
          ...get.map((c) => (c === 'NAME' ? (known[code] as string) : '100')),
          ...(level === 'state' ? [code] : ['53', code]),
        ]),
    ];
  });
};

const listQuery = (geography_fips: string, extra: Record<string, unknown> = {}) => ({
  variables: ['B01003_001E'],
  geography_level: 'state',
  geography_fips,
  ...extra,
});

describe('a comma-separated geography_fips names the members that matched no row (#74)', () => {
  it.each([
    ['06,53', ['06', '53']],
    ['53,06', ['06', '53']],
    ['06, 53', ['06', '53']],
    ['06,06', ['06']],
  ])('%j returns %j with no notice (characterization)', async (fips, expected) => {
    serveLists();

    const result = await runToolContract(censusQueryData, listQuery(fips));

    expect(result.isError).toBeFalsy();
    expect(structured(result).rows.map((r) => r.geography_geoid)).toEqual(expected);
    expect(paged(result).totalCount).toBe(expected.length);
    expect(structured(result)).not.toHaveProperty('notice');
  });

  it('returns two counties for "033,061" under parent_fips 53, with no notice (characterization)', async () => {
    serveLists();

    const result = await runToolContract(
      censusQueryData,
      listQuery('033,061', { geography_level: 'county', parent_fips: '53' }),
    );

    expect(structured(result).rows.map((r) => r.geography_geoid)).toEqual(['53033', '53061']);
    expect(structured(result)).not.toHaveProperty('notice');
  });

  it.each(['06', '*'])('%j behaves as before, with no notice (characterization)', async (fips) => {
    serveLists();

    const result = await runToolContract(censusQueryData, listQuery(fips));

    expect(result.isError).toBeFalsy();
    expect(structured(result).rows.length).toBe(fips === '*' ? 6 : 1);
    expect(structured(result)).not.toHaveProperty('notice');
  });

  it.each([
    ['06,99', '99'],
    ['06,6', '6'],
    ['06,99,99', '99'],
  ])('%j returns California and names %j on both surfaces', async (fips, missing) => {
    serveLists();

    const result = await runToolContract(censusQueryData, listQuery(fips));

    expect(structured(result).rows.map((r) => r.geography_name)).toEqual(['California']);
    expect(paged(result).totalCount).toBe(1);
    const notice = structured(result).notice as string;
    expect(notice).toContain(`No row came back for 1 of the 2 geography_fips codes: ${missing}.`);
    expect(notice).toContain('the codes that did come back, such as "06".');
    expect(readNotice(result)).toBe(notice);
  });

  /** The width a code needs is the level's, shown by a code that matched, not a fixed table. */
  it('shows a code that matched at the level queried as the one to check against', async () => {
    serveLists();

    const result = await runToolContract(
      censusQueryData,
      listQuery('033,61', { geography_level: 'county', parent_fips: '53' }),
    );

    expect(structured(result).rows.map((r) => r.geography_geoid)).toEqual(['53033']);
    const notice = structured(result).notice as string;
    expect(notice).toContain('No row came back for 1 of the 2 geography_fips codes: 61.');
    expect(notice).toContain(
      'the codes that did come back, such as "033" or its full GEOID "53033".',
    );
    expect(notice).not.toContain('a state is 2 digits');
  });

  /** The paging notice and the unmatched-code notice describe the same response; both survive. */
  it('judges the members against every matched row, not the page', async () => {
    serveLists();

    const result = await runToolContract(
      censusQueryData,
      listQuery('53,06,41,16,99', { limit: 2 }),
    );

    expect(structured(result).rows.map((r) => r.geography_geoid)).toEqual(['06', '16']);
    expect(paged(result).totalCount).toBe(4);
    const notice = structured(result).notice as string;
    expect(notice).toContain('No row came back for 1 of the 5 geography_fips codes: 99.');
    expect(notice).toContain('Rows 1–2 of 4');
    expect(readNotice(result)).toBe(notice);
  });

  it('pages a list with no unmatched member and adds no unmatched notice (characterization)', async () => {
    serveLists();

    const result = await runToolContract(
      censusQueryData,
      listQuery('53,06,41,16,32', { limit: 2, offset: 2 }),
    );

    expect(structured(result).rows.map((r) => r.geography_geoid)).toEqual(['32', '41']);
    expect(paged(result).totalCount).toBe(5);
    const notice = structured(result).notice as string;
    expect(notice).toContain('Rows 3–4 of 5');
    expect(notice).not.toContain('geography_fips codes');
  });

  /**
   * A list member holding anything but a code never reaches a notice — api.census.gov answers
   * `state:06,_9_` with HTTP 400 — so the read-back runs on the other quoted text the notice
   * carries: the label of the default the API applied to an unset dimension, an upstream string.
   */
  it('quotes an applied-default label literally in content[] and raw in structuredContent (#72)', async () => {
    const label = 'Total *for* `all` [sectors](x)';
    serveMetadata('cbp', 2023, {
      ESTAB: { label: 'Number of establishments', predicateType: 'int' },
      NAICS2017: {
        label: '2017 NAICS code',
        required: 'default displayed',
        predicateType: 'string',
        attributes: 'NAICS2017_LABEL',
      },
    });
    serveData('cbp', 2023, (url) => {
      const get = getList(url);
      return [
        [...get, 'state'],
        [...get.map((c) => (c === 'NAME' ? 'Washington' : c === 'ESTAB' ? '5' : label)), '53'],
      ];
    });

    const result = await runToolContract(
      censusQueryData,
      listQuery('53', { dataset: 'cbp', variables: ['ESTAB'] }),
    );

    const notice = structured(result).notice as string;
    expect(notice).toContain(`"${label}"`);
    expect(readNotice(result)).toBe(notice);
  });

  /** WA publishes 1360 (Alaska Native alone) in no T02 sex-by-age table; Alaska does in T02002. */
  it('names 53 for dec/ddhca T02002_001N under 1360 and keeps the table guidance', async () => {
    serveDdhca();

    const result = await runToolContract(censusQueryData, {
      dataset: 'dec/ddhca',
      variables: ['T02002_001N'],
      geography_level: 'state',
      geography_fips: '02,53',
      predicates: { POPGROUP: '1360' },
    });

    const [row] = structured(result).rows;
    expect(structured(result).rows).toHaveLength(1);
    expect(row?.geography_geoid).toBe('02');
    expect(row?.variables.T02002_001N?.estimate).toBe(102765);
    const notice = structured(result).notice as string;
    expect(notice).toContain('No row came back for 1 of the 2 geography_fips codes: 53.');
    expect(notice).toMatch(SPLIT);
    expect(notice).toContain('T02001 or T02003');
    // The missing code first, then where its group may sit instead.
    expect(notice.indexOf('geography_fips codes: 53.')).toBeLessThan(notice.search(SPLIT));
    expect(readNotice(result)).toBe(notice);
    expect(textOf(result)).toContain('102,765');
  });
});

describe('census_compare_geographies quotes unmatched geographies literally (#72)', () => {
  it('reads the unmatched entry back from content[] exactly as structuredContent holds it', async () => {
    serveLists();

    const result = await runToolContract(censusCompareGeographies, {
      variables: ['B01003_001E'],
      geography_level: 'county',
      within: '53',
      geographies: ['53033', '*x* `y` [z](w)'],
      limit: 2,
    });

    expect(structured(result).rows.map((r) => r.geography_geoid)).toEqual(['53033']);
    const notice = structured(result).notice as string;
    expect(notice).toContain('requested geographies: *x* `y` [z](w).');
    expect(readNotice(result)).toBe(notice);
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

// ---------------------------------------------------------------------------------------------
// census_list_geographies and the data tools count the same levels
// ---------------------------------------------------------------------------------------------

describe('census_list_geographies and the data tools give one level count per dataset-year', () => {
  const listGeographies = allToolDefinitions.find((d) => d.name === 'census_list_geographies');

  /**
   * 13 levels in 16 entries: geography.json lists a level once per parent hierarchy it is
   * published under, as acs/acs5 2024 lists county five times (65 entries, 43 levels).
   */
  const serveRepeatedLevels = () => {
    routes.unshift({
      match: (u) => u.pathname === '/data/2024/acs/acs5/geography.json',
      respond: () => ({
        fips: [
          { name: 'us', geoLevelDisplay: '010' },
          { name: 'state', geoLevelDisplay: '040' },
          { name: 'county', geoLevelDisplay: '050', requires: ['state'] },
          ...[['combined statistical area'], ['urban area'], ['state', 'place']].map(
            (requires) => ({ name: 'county', geoLevelDisplay: '050', requires }),
          ),
          ...Array.from({ length: 10 }, (_, i) => ({
            name: `level ${i}`,
            geoLevelDisplay: `9${i}`,
          })),
        ],
      }),
    });
    serveMetadata('acs/acs5', 2024, acsVariables);
  };

  it('census_list_geographies counts distinct levels and names the extra hierarchy entries', async () => {
    serveRepeatedLevels();

    const result = await runToolContract(
      listGeographies as never,
      { dataset: 'acs/acs5' } as never,
    );

    const out = result.structuredContent as {
      geography_levels: Array<{ geography_level: string }>;
      totalLevels: number;
    };
    expect(out.geography_levels).toHaveLength(16);
    expect(out.totalLevels).toBe(13);
    const text = textOf(result);
    expect(text).toContain('**13 levels available**');
    expect(text).toContain('16 entries');
  });

  it('lists entries with no note when no level repeats', async () => {
    serveMetadata('acs/acs5', 2024, acsVariables);

    const result = await runToolContract(
      listGeographies as never,
      { dataset: 'acs/acs5' } as never,
    );

    expect((result.structuredContent as { totalLevels: number }).totalLevels).toBe(4);
    expect(textOf(result)).toContain('**4 levels available**\n');
    expect(textOf(result)).not.toContain('entries');
  });

  it.each([
    ['census_query_data', censusQueryData, { geography_fips: '53' }],
    ['census_compare_geographies', censusCompareGeographies, {}],
  ] as const)(
    '%s refuses an unknown level with the same count',
    async (_name, definition, scope) => {
      serveRepeatedLevels();

      const result = await runToolContract(
        definition as typeof censusQueryData,
        { variables: ['B01003_001E'], geography_level: 'bogus', ...scope } as never,
      );

      const error = errorOf(result);
      expect(error.data).toMatchObject({ reason: 'geography_not_supported' });
      expect(error.message).toBe(
        'Geography level "bogus" does not exist in acs/acs5 (2024). It publishes 13 geography levels.',
      );
      expect(error.data.availableLevels).toHaveLength(13);
    },
  );

  it('census_list_geographies names the years a dataset serves when geography.json 404s for one it does not', async () => {
    routes.push({
      match: (u) => u.pathname === '/data/1999/acs/acs5/geography.json',
      respond: () => new Response('Not Found', { status: 404 }),
    });

    const result = await runToolContract(
      listGeographies as never,
      { dataset: 'acs/acs5', year: 1999 } as never,
    );

    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.message).toBe('acs/acs5 cannot be queried for 1999.');
    expect(error.data).toMatchObject({
      reason: 'year_not_available',
      dataset: 'acs/acs5',
      year: 1999,
      availableYears: expect.arrayContaining([2009, 2024]),
      recovery: { hint: 'Retry with a year this dataset serves: 2009-2024.' },
    });
    const text = textOf(result);
    expect(text).toContain('Error: acs/acs5 cannot be queried for 1999.');
    expect(text).toContain('Recovery: Retry with a year this dataset serves: 2009-2024.');
  });
});

// ---------------------------------------------------------------------------------------------
// #70 — a level geography.json lists under several hierarchies
// ---------------------------------------------------------------------------------------------

describe('a level listed under several hierarchies runs when any of them accepts the call (#70)', () => {
  const NECTA = 'new england city and town area';
  const NECTA_PART = 'new england city and town area (or part)';
  const AIANNH_PART = 'american indian area/alaska native area/hawaiian home land (or part)';

  /** The dec/dhc 2020 entries for these levels, in the order geography.json publishes them. */
  const serveDhc = () => {
    routes.push(
      {
        match: (u) => u.pathname === '/data/2020/dec/dhc/variables.json',
        respond: () => ({
          variables: {
            P1_001N: { label: ' !!Total', concept: 'Total Population', predicateType: 'int' },
          },
        }),
      },
      {
        match: (u) => u.pathname === '/data/2020/dec/dhc/geography.json',
        respond: () => ({
          fips: [
            { name: 'state', geoLevelDisplay: '040' },
            { name: AIANNH_PART, geoLevelDisplay: '144', requires: ['state', 'county', 'tract'] },
            {
              name: AIANNH_PART,
              geoLevelDisplay: '154',
              requires: ['state', 'county', 'tract', 'block group'],
            },
            { name: AIANNH_PART, geoLevelDisplay: '280', requires: ['state'] },
            {
              name: NECTA,
              geoLevelDisplay: '337',
              requires: ['combined new england city and town area'],
            },
            {
              name: NECTA_PART,
              geoLevelDisplay: '346',
              requires: ['state', 'combined new england city and town area (or part)'],
            },
            { name: NECTA, geoLevelDisplay: '350' },
            { name: NECTA_PART, geoLevelDisplay: '360', requires: ['state'] },
          ],
        }),
      },
    );
    // Three geographies at whatever level was asked for, under whatever state scoped it.
    serveData('dec/dhc', 2020, (url) => {
      const level = (url.searchParams.get('for') ?? '').split(':')[0] as string;
      const state = url.searchParams.get('in')?.match(/state:(\d+)/)?.[1];
      const geo = state ? ['state', level] : [level];
      return [
        [...getList(url), ...geo],
        ...['70450', '71650', '72400'].map((code, i) => [
          `Area ${code}`,
          String(5_064_479 - i * 1000),
          ...(state ? [state] : []),
          code,
        ]),
      ];
    });
  };

  const dhc = { variables: ['P1_001N'], dataset: 'dec/dhc', year: 2020 };
  const query = (input: Record<string, unknown>) =>
    runToolContract(censusQueryData, { ...dhc, geography_fips: '*', ...input } as never);
  const compare = (input: Record<string, unknown>) =>
    runToolContract(censusCompareGeographies, { ...dhc, ...input } as never);
  const hintOf = (result: { structuredContent?: unknown }) =>
    (errorOf(result).data.recovery as { hint: string }).hint;

  beforeEach(serveDhc);

  it('census_query_data lists a NECTA nationally — the entry that names no parent', async () => {
    const result = await query({ geography_level: NECTA });

    expect(result.isError).toBeFalsy();
    expect(structured(result).rows.map((row) => row.geography_geoid)).toEqual([
      '70450',
      '71650',
      '72400',
    ]);
    expect(structured(result).rows[0]?.variables.P1_001N?.estimate).toBe(5_064_479);
    expect(textOf(result)).toContain('Area 70450');
    const [request] = dataCalls('dec/dhc', 2020);
    expect(request?.searchParams.get('for')).toBe(`${NECTA}:*`);
    expect(request?.searchParams.has('in')).toBe(false);
  });

  /**
   * The scopes the paging notice offers come from the entry that accepted the call. The first
   * AIANNH (or part) entry names county and tract as well; offering them would send the next call
   * into a hierarchy this one never ran in.
   */
  it('census_query_data pages an AIANNH (or part) query with the accepting entry’s scopes', async () => {
    const result = await query({ geography_level: AIANNH_PART, parent_fips: '04', limit: 1 });

    expect(result.isError).toBeFalsy();
    const out = structured(result);
    expect(out.rows.map((row) => row.geography_geoid)).toEqual(['0470450']);
    expect(out.notice).toContain('Rows 1–1 of 3');
    expect(out.notice).not.toContain('narrow the scope');
    expect(textOf(result)).toContain('Rows 1–1 of 3');
    expect(dataCalls('dec/dhc', 2020)[0]?.searchParams.get('in')).toBe('state:04');
  });

  it('census_compare_geographies ranks NECTA (or part) within a state', async () => {
    const result = await compare({ geography_level: NECTA_PART, within: '25' });

    expect(result.isError).toBeFalsy();
    expect(structured(result).rows.map((row) => [row.rank, row.geography_geoid])).toEqual([
      [1, '2570450'],
      [2, '2571650'],
      [3, '2572400'],
    ]);
    expect(textOf(result)).toContain('Area 70450');
  });

  it('a state scope on a NECTA is the parent to drop, not a CNECTA to add', async () => {
    const result = await query({ geography_level: NECTA, parent_fips: '25' });

    const error = errorOf(result);
    expect(error.data).toMatchObject({
      reason: 'parent_not_accepted',
      unacceptedParents: ['state'],
      acceptedParents: [],
    });
    expect(hintOf(result)).toContain('Drop parent_fips');
    expect(textOf(result)).toContain('Recovery: Drop parent_fips');
    expect(dataCalls('dec/dhc', 2020)).toHaveLength(0);
  });

  it('a NECTA (or part) with no parent needs the state alone', async () => {
    const result = await query({ geography_level: NECTA_PART });

    const error = errorOf(result);
    expect(error.data).toMatchObject({ reason: 'parent_required', missingParents: ['state'] });
    expect(error.message).not.toContain('combined');
    expect(hintOf(result)).toContain('add parent_fips');
    expect(dataCalls('dec/dhc', 2020)).toHaveLength(0);
  });

  it('an AIANNH (or part) with no parent needs the state alone', async () => {
    const result = await compare({ geography_level: AIANNH_PART });

    expect(errorOf(result).data).toMatchObject({
      reason: 'parent_required',
      missingParents: ['state'],
    });
    expect(hintOf(result)).toContain('add within');
  });

  /**
   * Reachability is per tool. Under a state and county, census_query_data can add the tract the
   * first entry needs; census_compare_geographies has no tract input, so its one move is dropping
   * the county to reach the state-only entry.
   */
  it('a state and county on AIANNH (or part) is a tract to add or a county to drop, by tool', async () => {
    const queried = await query({
      geography_level: AIANNH_PART,
      parent_fips: '04',
      county_fips: '001',
    });
    expect(errorOf(queried).data).toMatchObject({
      reason: 'parent_required',
      missingParents: ['tract'],
    });
    expect(hintOf(queried)).toContain('add tract_fips');

    const compared = await compare({
      geography_level: AIANNH_PART,
      within: '04',
      within_county: '001',
    });
    expect(errorOf(compared).data).toMatchObject({
      reason: 'parent_not_accepted',
      unacceptedParents: ['county'],
      acceptedParents: ['state'],
    });
    expect(hintOf(compared)).toContain('Drop within_county');
    expect(textOf(compared)).toContain('Recovery: Drop within_county');
    // within stays, so the comparison keeps its state scope rather than running unscoped.
    expect(hintOf(compared)).toContain(
      'it sits within state only, so the comparison needs no other scope.',
    );
  });

  /**
   * The state-only NECTA (or part) entry needs a state added and does not take the county, so the
   * one error names both changes, and making them is the whole fix.
   */
  it('census_query_data names the parent to add and the one to drop in one error', async () => {
    const result = await query({ geography_level: NECTA_PART, county_fips: '009' });

    const error = errorOf(result);
    expect(error.data).toMatchObject({
      reason: 'parent_required',
      missingParents: ['state'],
      unacceptedParents: ['county'],
    });
    expect(error.message).toBe(
      `Geography level "${NECTA_PART}" in dec/dhc (2020) must be scoped by state, and does not accept county as a parent.`,
    );
    expect(hintOf(result)).toBe(
      'To query this level, add parent_fips (census_resolve_geography returns it as state_fips), and drop county_fips.',
    );
    expect(readParagraphs(textOf(result))).toContain(`Recovery: ${hintOf(result)}`);
    expect(dataCalls('dec/dhc', 2020)).toHaveLength(0);

    const retried = await query({ geography_level: NECTA_PART, parent_fips: '25' });
    expect(retried.isError).toBeFalsy();
    expect(structured(retried).rows).toHaveLength(3);
  });

  it('census_compare_geographies names within to add and within_county to drop', async () => {
    const result = await compare({ geography_level: NECTA_PART, within_county: '009' });

    expect(errorOf(result).data).toMatchObject({
      reason: 'parent_required',
      missingParents: ['state'],
      unacceptedParents: ['county'],
    });
    expect(hintOf(result)).toBe(
      'To compare at this level, add within (census_resolve_geography returns it as state_fips), and drop within_county.',
    );
    expect(readParagraphs(textOf(result))).toContain(`Recovery: ${hintOf(result)}`);

    const retried = await compare({ geography_level: NECTA_PART, within: '25' });
    expect(retried.isError).toBeFalsy();
  });
});

describe('a "*" parent the level does not wildcard is refused before the data request (#77)', () => {
  const serveAcs = () => {
    serveMetadata('acs/acs5', 2024, acsVariables);
    routes.push({
      match: (u) => u.pathname === '/data/2024/acs/acs5/groups.json',
      respond: () => ({ groups: [] }),
    });
    serveData('acs/acs5', 2024, (url) => [
      [...getList(url), 'state', 'county'],
      ...['01', '02'].map((state) => [
        ...getList(url).map((h) => (h === 'NAME' ? `County in ${state}` : '100')),
        state,
        '001',
      ]),
    ]);
  };
  const base = { variables: ['B01003_001E'], dataset: 'acs/acs5', year: 2024 };
  const hintOf = (result: { structuredContent?: unknown }) =>
    (errorOf(result).data.recovery as { hint: string }).hint;

  beforeEach(serveAcs);

  it('census_query_data names the state to send in place of "*" on a tract query', async () => {
    const result = await runToolContract(censusQueryData, {
      ...base,
      geography_level: 'tract',
      geography_fips: '*',
      parent_fips: '*',
      county_fips: '*',
    } as never);

    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.data).toMatchObject({ reason: 'parent_required', missingParents: ['state'] });
    expect(error.message).toBe(
      'Geography level "tract" in acs/acs5 (2024) must be scoped by state; "*" does not stand in for state here.',
    );
    expect(hintOf(result)).toBe(
      'To query this level, set parent_fips to one 2-digit state FIPS instead of "*" (census_resolve_geography returns it as state_fips).',
    );
    expect(readParagraphs(textOf(result))).toEqual(
      expect.arrayContaining([`Error: ${error.message}`, `Recovery: ${hintOf(result)}`]),
    );
    expect(dataCalls('acs/acs5', 2024)).toHaveLength(0);
  });

  it('census_compare_geographies names the state to send in place of "*" on a tract comparison', async () => {
    const result = await runToolContract(censusCompareGeographies, {
      ...base,
      geography_level: 'tract',
      within: '*',
    } as never);

    expect(result.isError).toBe(true);
    expect(errorOf(result).data).toMatchObject({
      reason: 'parent_required',
      missingParents: ['state'],
    });
    expect(hintOf(result)).toContain('set within to one 2-digit state FIPS instead of "*"');
    expect(textOf(result)).toContain('Recovery: To compare at this level, set within to one');
    expect(dataCalls('acs/acs5', 2024)).toHaveLength(0);
  });

  /** county lists state under `wildcard`, so `in=state:*` is a request the Census API answers. */
  it.each([
    [
      'census_query_data',
      () =>
        runToolContract(censusQueryData, {
          ...base,
          geography_level: 'county',
          geography_fips: '*',
          parent_fips: '*',
        } as never),
    ],
    [
      'census_compare_geographies',
      () =>
        runToolContract(censusCompareGeographies, {
          ...base,
          geography_level: 'county',
          within: '*',
        } as never),
    ],
  ])('%s still sends a "*" state on a county query (characterization)', async (_tool, call) => {
    const result = await call();

    expect(result.isError).toBeFalsy();
    expect(
      structured(result)
        .rows.map((row) => row.geography_geoid)
        .sort(),
    ).toEqual(['01001', '02001']);
    expect(dataCalls('acs/acs5', 2024)[0]?.searchParams.get('in')).toBe('state:*');
  });
});

describe('keyed calls share one upstream budget (#79)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Successful metadata remains useful even when it consumes most of the call budget. */
  const slowMetadata = (data: Body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push(url);
        const delayMs = url.pathname.endsWith('geography.json') ? 9_000 : 29_000;
        const metadata = url.pathname.endsWith('geography.json')
          ? { fips: [{ name: 'state', geoLevelDisplay: '040' }] }
          : { variables: acsVariables };
        if (url.pathname.endsWith('.json')) {
          return new Promise<Response>((resolve) =>
            setTimeout(() => resolve(new Response(JSON.stringify(metadata))), delayMs),
          );
        }
        if (data === HANG)
          return new Promise<Response>((_, reject) =>
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            }),
          );
        return Promise.resolve(new Response(JSON.stringify(data)));
      }),
    );
  };
  const input = { variables: ['B19013_001E'], geography_level: 'state', geography_fips: '53' };

  it('slow successful metadata still produces the same answer (characterization)', async () => {
    slowMetadata([
      ['NAME', 'B19013_001E', 'state'],
      ['Washington', '103748', '53'],
    ]);
    const pending = runToolContract(censusQueryData, input);
    await vi.advanceTimersByTimeAsync(38_000);
    const result = await pending;
    expect(result.isError).toBeFalsy();
    expect(structured(result).rows[0]?.geography_name).toBe('Washington');
    expect(textOf(result)).toContain('Washington');
    expect(calls).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the data request gets only the time left after metadata', async () => {
    slowMetadata(HANG);
    let settled = false;
    const pending = runToolContract(censusQueryData, input).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(50_000);
    const atDeadline = settled;
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(atDeadline).toBe(true);
    expect(result.isError).toBe(true);
    expect(errorOf(result).data).toMatchObject({ reason: 'upstream_error', retryable: true });
    const hint = (errorOf(result).data.recovery as { hint: string }).hint;
    expect(textOf(result)).toContain(hint);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['query', censusQueryData, input],
    ['compare', censusCompareGeographies, { variables: ['B19013_001E'], geography_level: 'state' }],
    ['predicate', censusListPredicateValues, { dataset: 'cbp', year: 2023, predicate: 'EMPSZES' }],
  ] as const)(
    '%s caps cold variables metadata on both error surfaces',
    async (_name, definition, args) => {
      serveMetadata('acs/acs5', 2024, acsVariables);
      routes.unshift({ match: (u) => u.pathname.endsWith('variables.json'), respond: () => HANG });
      let settled = false;
      const pending = runToolContract(definition as never, args as never).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(50_000);
      const atDeadline = settled;
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(atDeadline).toBe(true);
      const error = errorOf(result);
      expect(['upstream_error', 'variables_unavailable']).toContain(error.data.reason);
      expect(error.data.retryable).toBe(true);
      expect(textOf(result)).toContain((error.data.recovery as { hint: string }).hint);
      expect(textOf(result)).toContain(`reason ${error.data.reason}`);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['headers', 'body', 'backoff'] as const)(
    'caller cancellation during metadata %s remains cancellation',
    async (stage) => {
      const controller = new AbortController();
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string | URL, init?: RequestInit) => {
          calls.push(new URL(String(url)));
          if (String(url).endsWith('geography.json'))
            return Promise.resolve(
              new Response(JSON.stringify({ fips: [{ name: 'state', geoLevelDisplay: '040' }] })),
            );
          if (stage === 'backoff') return Promise.reject(new TypeError('connection refused'));
          if (stage === 'body')
            return Promise.resolve(
              new Response(
                new ReadableStream({
                  start(stream) {
                    init?.signal?.addEventListener(
                      'abort',
                      () => stream.error(init.signal?.reason),
                      { once: true },
                    );
                  },
                }),
              ),
            );
          return new Promise<Response>((_, reject) =>
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            }),
          );
        }),
      );
      const pending = runToolContract(censusQueryData, input, {
        context: { signal: controller.signal },
      });
      await vi.advanceTimersByTimeAsync(100);
      controller.abort();
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(errorOf(result).data?.reason).toBeUndefined();
      expect(textOf(result)).not.toContain('Recovery:');
      expect(textOf(result)).toContain(errorOf(result).message);
      expect(calls).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('exhausted transport failures carry reason and recovery on both surfaces', async () => {
    serveMetadata('acs/acs5', 2024, acsVariables);
    serveData('acs/acs5', 2024, () => {
      throw new TypeError('connection reset');
    });
    const pending = runToolContract(censusQueryData, input);
    await vi.runAllTimersAsync();
    const result = await pending;
    const error = errorOf(result);
    expect(error.data).toMatchObject({
      reason: 'upstream_error',
      retryable: true,
      retryAttempts: 4,
    });
    expect(textOf(result)).toContain((error.data.recovery as { hint: string }).hint);
    expect(textOf(result)).toContain('reason upstream_error');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a sibling-enrichment hang cannot outlive the call or replace variable_not_found', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push(url);
        if (url.pathname.includes('/variables/'))
          return new Promise<Response>((_, reject) =>
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            }),
          );
        const delayMs = url.pathname.endsWith('geography.json')
          ? 9_000
          : url.pathname.endsWith('variables.json')
            ? 29_000
            : 11_000;
        const body = url.pathname.endsWith('geography.json')
          ? { fips: [{ name: 'state', geoLevelDisplay: '040' }] }
          : { variables: acsVariables };
        return new Promise<Response>((resolve) =>
          setTimeout(
            () =>
              resolve(
                url.pathname.endsWith('.json')
                  ? new Response(JSON.stringify(body))
                  : new Response("error: unknown variable 'S1701_C03_001E'", { status: 400 }),
              ),
            delayMs,
          ),
        );
      }),
    );
    const pending = runToolContract(censusQueryData, { ...input, variables: ['S1701_C03_001E'] });
    await vi.advanceTimersByTimeAsync(50_000);
    const result = await pending;
    expect(errorOf(result).data.reason).toBe('variable_not_found');
    expect(textOf(result)).toContain('census_search_variables');
    expect(calls.filter((url) => url.pathname.includes('/variables/'))).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('a hung data endpoint settles inside the client timeout (#78)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    serveMetadata('acs/acs5', 2024, acsVariables);
    serveData('acs/acs5', 2024, () => HANG);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const atState = {
    variables: ['B19013_001E'],
    dataset: 'acs/acs5',
    year: 2024,
    geography_level: 'state',
  };

  /** The service seam tables the deadline itself; this pins that it reaches each data tool's wire. */
  it.each([
    ['census_query_data', censusQueryData, { ...atState, geography_fips: '53' }],
    ['census_compare_geographies', censusCompareGeographies, atState],
  ] as const)(
    '%s reports it as a retryable upstream_error on both surfaces',
    async (_n, definition, input) => {
      let settled = false;
      const pending = runToolContract(definition as never, input as never).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(39_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;

      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({
        reason: 'upstream_error',
        retryable: true,
        deadlineMs: 40_000,
      });
      const paragraphs = readParagraphs(textOf(result));
      expect(paragraphs).toContain(`Error: ${error.message}`);
      expect(paragraphs).toContain(
        'Recovery: Retry the request once. If it fails the same way, request a narrower geography or fewer variables per call: a response too large to arrive within one attempt fails on every retry. Otherwise the Census API is temporarily unavailable for this dataset and year.',
      );
      expect(textOf(result)).toContain('(reason upstream_error · retryable');
      expect(dataCalls('acs/acs5', 2024)).toHaveLength(3);
    },
  );

  it('a caller cancelling the hung request gets a cancellation', async () => {
    const controller = new AbortController();
    const pending = runToolContract(
      censusQueryData,
      { ...atState, geography_fips: '53' } as never,
      { context: { signal: controller.signal } },
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(dataCalls('acs/acs5', 2024)).toHaveLength(1);
    controller.abort();
    // Nothing waits on the clock past the abort; this only lets the settle path's timers run.
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(error.data.reason).toBeUndefined();
    expect(error.message).toMatch(/was aborted\.$/);
    expect(readParagraphs(textOf(result))).toEqual([`Error: ${error.message}`]);
    expect(dataCalls('acs/acs5', 2024)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// #62 — no error says the same thing twice
// ---------------------------------------------------------------------------------------------

/**
 * Words too common to make two clauses one statement. "no" stays a content word: "No county
 * matched" and "No county named" open the same miss.
 */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'so',
  'that',
  'the',
  'this',
  'to',
  'with',
]);

const tokensOf = (text: string) =>
  text
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/^[^\w/]+|[^\w/]+$/g, ''))
    .filter(Boolean);

const clausesOf = (text: string) => text.split(/(?<=[.;!?])\s+|\s+—\s+/).filter(Boolean);

const contentTokensOf = (clause: string) =>
  new Set(tokensOf(clause).filter((token) => !STOPWORDS.has(token)));

/** Year runs (`2012-2023`) and comma lists of three or more items, each as a set of its items. */
const valueListsOf = (text: string): Array<Set<string>> => {
  const runs = (text.match(/\b\d{4}-\d{4}\b/g) ?? []).map((run) => new Set([run]));
  const item = String.raw`(?:"[^"]*"|[\w/.-]+)`;
  const lists =
    text.match(new RegExp(`${item}(?:, ${item})+(?:,? (?:and|or) ${item})?`, 'g')) ?? [];
  return [
    ...runs,
    ...lists
      .map(
        (list) =>
          new Set(list.split(/,\s*(?:and\s+|or\s+)?|\s+(?:and|or)\s+/).map((v) => v.trim())),
      )
      .filter((set) => set.size >= 3),
  ];
};

/** The longest run of consecutive tokens two token lists share. */
const longestSharedRun = (a: string[], b: string[]): string[] => {
  let best: string[] = [];
  const lengths = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] !== b[j - 1]) continue;
      const length = (lengths[i - 1]?.[j - 1] ?? 0) + 1;
      (lengths[i] as number[])[j] = length;
      if (length > best.length) best = a.slice(i - length, i);
    }
  }
  return best;
};

/**
 * Every way an error's message and its recovery hint repeat each other, empty when they do not:
 * a tool both name (the step stated twice), a value list both carry, a run of four or more words
 * both contain, or a clause of three or more content words of which 60% sit inside a clause of
 * the other (a diagnosis or a step restated in other words).
 */
const repeatsBetween = (message: string, hint: string): string[] => {
  const found: string[] = [];

  const toolsIn = (text: string) => new Set(text.match(/\bcensus_[a-z_]+/g) ?? []);
  const hintTools = toolsIn(hint);
  for (const tool of toolsIn(message)) if (hintTools.has(tool)) found.push(`both name ${tool}`);

  for (const list of valueListsOf(message)) {
    for (const other of valueListsOf(hint)) {
      const shared = [...list].filter((value) => other.has(value));
      if (shared.length === list.size || shared.length >= 3) {
        found.push(`both list ${shared.join(', ')}`);
      }
    }
  }

  const run = longestSharedRun(tokensOf(message), tokensOf(hint));
  if (run.length >= 4) found.push(`both say "${run.join(' ')}"`);

  for (const a of clausesOf(message)) {
    for (const b of clausesOf(hint)) {
      const [small, large] = [contentTokensOf(a), contentTokensOf(b)].sort(
        (x, y) => x.size - y.size,
      );
      if (!small || !large || small.size < 3) continue;
      const inside = [...small].filter((token) => large.has(token)).length;
      if (inside / small.size >= 0.6) found.push(`"${a}" restates "${b}"`);
    }
  }

  return found;
};

describe('repeatsBetween (the detector the sweep below runs)', () => {
  it.each([
    [
      'Unknown dataset: "bogus". Use census_list_datasets to see valid dataset codes.',
      'Call census_list_datasets to discover valid dataset codes like acs/acs5.',
    ],
    [
      'acs/acs5 cannot be queried for 1999. Years available: 2009-2024.',
      'Retry with a year acs/acs5 serves: 2009-2024.',
    ],
    [
      "Census API returned HTTP 400 for acs/acs5 (2024). Upstream: error: invalid 'for' argument",
      "The Census API rejected this request rather than failing transiently: error: invalid 'for' argument. Change the query.",
    ],
    [
      'No county matched "Chatham County, WA".',
      'No county named "Chatham County" exists in WA — check the spelling.',
    ],
    [
      'Address "1 Main St, Faketown, WA 98999" could not be geocoded. Verify the address format and include a ZIP code.',
      'Include a full address with ZIP code (e.g., "1600 Pennsylvania Ave NW, Washington, DC 20500").',
    ],
    [
      'Census API key is invalid or missing. Set CENSUS_API_KEY and restart.',
      'Set the CENSUS_API_KEY environment variable and restart the server.',
    ],
  ])('flags %j', (message, hint) => {
    expect(repeatsBetween(message, hint)).not.toEqual([]);
  });

  it.each([
    [
      'Unknown dataset: "bogus".',
      'Call census_list_datasets to discover valid dataset codes like acs/acs5.',
    ],
    ['acs/acs5 cannot be queried for 1999.', 'Retry with a year this dataset serves: 2009-2024.'],
    [
      'No data returned for state in acs/acs5 (2024).',
      'Confirm the FIPS codes exist in acs/acs5 (2024) — census_resolve_geography returns them.',
    ],
  ])('passes %j', (message, hint) => {
    expect(repeatsBetween(message, hint)).toEqual([]);
  });
});

describe('no error repeats itself between its message and its recovery hint (#62)', () => {
  type Definition = (typeof allToolDefinitions)[number];

  beforeEach(() => {
    initGeographyService();
  });

  afterEach(() => {
    vi.mocked(getServerConfig).mockReset();
  });

  /** Configure the server with no key, as an unset, blank, or unsubstituted one parses. */
  const unsetKey = () => {
    vi.mocked(getServerConfig).mockReturnValue({ variableCacheTtlHours: 24, clampLimits: true });
  };

  interface Scenario {
    /** Drive retry backoffs with fake timers — the failure is one `withRetry` retries. */
    backoff?: boolean;
    input: Record<string, unknown>;
    label: string;
    /** The `data.reason` the call fails with; `undefined` for a reasonless validation error. */
    reason: string | undefined;
    serve?: () => void;
    tool: Definition;
  }

  const tool = (name: string) => {
    const found = allToolDefinitions.find((definition) => definition.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
  };

  const plain = (status: number, body: string) =>
    new Response(body, { status, headers: { 'content-type': 'text/plain' } });
  const htmlPage = (body = 'Maintenance') =>
    new Response(`<!DOCTYPE html><html><body>${body}</body></html>`, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  const noContent = () => new Response(null, { status: 204 });

  /** A route for one exact path, ahead of every route already registered. */
  const override = (path: string, respond: (url: URL) => Body) => {
    routes.unshift({ match: (u) => u.pathname === path, respond });
  };

  /** Rows for every geography, one per record, each requested column filled. */
  const answer =
    (geoColumn: string, geos: string[], records: Array<Record<string, string>> = [{}]) =>
    (url: URL): Body => {
      const header = getList(url);
      return [
        [...header, geoColumn],
        ...geos.flatMap((geo) =>
          records.map((record) => [
            ...header.map((h) => (h === 'NAME' ? `Place ${geo}` : (record[h] ?? '100'))),
            geo,
          ]),
        ),
      ];
    };

  const serveAcs = () => {
    serveMetadata('acs/acs5', 2024, acsVariables);
    routes.push({
      match: (u) => u.pathname === '/data/2024/acs/acs5/groups.json',
      respond: () => ({ groups: [] }),
    });
    serveData('acs/acs5', 2024, answer('state', ['53', '06']));
  };

  /** A geography.json that publishes more levels than a message spells out. */
  const serveManyLevels = () => {
    override('/data/2024/acs/acs5/geography.json', () => ({
      fips: Array.from({ length: 13 }, (_, i) => ({
        name: `level ${i}`,
        geoLevelDisplay: `9${i}`,
      })),
    }));
    serveAcs();
  };

  /** A geography.json whose county subdivision needs a county and offers no wildcard for it. */
  const serveSubdivisions = () => {
    override('/data/2024/acs/acs5/geography.json', () => ({
      fips: [
        { name: 'state', geoLevelDisplay: '040' },
        { name: 'county', geoLevelDisplay: '050', requires: ['state'] },
        { name: 'county subdivision', geoLevelDisplay: '060', requires: ['state', 'county'] },
      ],
    }));
    serveAcs();
  };

  const cbpVariables = {
    ESTAB: { label: 'Number of establishments', predicateType: 'int', group: 'CB2300CBP' },
    NAICS2017: {
      label: 'Meaning of NAICS code',
      required: 'default displayed',
      predicateType: 'string',
      values: { item: { '00': 'Total for all sectors' } },
    },
    EMPSZES: {
      label: 'Employment size of establishments code',
      required: 'default displayed',
      predicateType: 'string',
    },
  };
  const serveCbp = () => serveMetadata('cbp', 2023, cbpVariables);

  const charvVariables = {
    POP: { label: 'Population', predicateType: 'int' },
    MONTH: { label: 'Vintage Month', predicateType: 'int', attributes: 'MONTH_DESC' },
  };
  const serveCharv = () => {
    serveMetadata('pep/charv', 2023, charvVariables);
    serveData(
      'pep/charv',
      2023,
      answer(
        'state',
        ['53', '06'],
        [
          { MONTH: '4', MONTH_DESC: 'April' },
          { MONTH: '7', MONTH_DESC: 'July' },
        ],
      ),
    );
  };

  const tigerweb = (respond: (url: URL) => Body = () => ({ features: [] })) => {
    routes.push({ match: (u) => u.hostname === 'tigerweb.geo.census.gov', respond });
  };
  const geocoderMisses = () => {
    routes.push({
      match: (u) => u.hostname === 'geocoding.geo.census.gov',
      respond: () => ({ result: { addressMatches: [] } }),
    });
  };
  const twoWashingtonCounties = (url: URL): Body =>
    url.pathname.includes('State_County/MapServer/1')
      ? {
          features: [
            {
              attributes: {
                NAME: 'Washington County',
                BASENAME: 'Washington',
                STATE: '05',
                COUNTY: '143',
              },
            },
            {
              attributes: {
                NAME: 'Washington County',
                BASENAME: 'Washington',
                STATE: '51',
                COUNTY: '191',
              },
            },
          ],
        }
      : { features: [] };

  const fiftyCodes = Array.from(
    { length: 50 },
    (_, i) => `B99999_${String(i + 1).padStart(3, '0')}E`,
  );
  const CBSA = 'metropolitan statistical area/micropolitan statistical area';

  const query = tool('census_query_data');
  const compare = tool('census_compare_geographies');
  const atState = { geography_level: 'state', geography_fips: '53' };

  const scenarios: Scenario[] = [
    // census_search_variables
    ...(['bogus', 'profile'] as const).map((dataset) => ({
      tool: tool('census_search_variables'),
      reason: 'dataset_not_found',
      label: `dataset "${dataset}"`,
      input: { query: 'income', dataset },
    })),
    {
      tool: tool('census_search_variables'),
      reason: 'year_not_available',
      label: 'a year acs/acs5 does not serve',
      input: { query: 'income', year: 1999 },
    },
    {
      tool: tool('census_search_variables'),
      reason: 'variables_unavailable',
      label: 'variables.json answered as HTML',
      input: { query: 'income' },
      serve: () => override('/data/2024/acs/acs5/variables.json', () => htmlPage()),
      backoff: true,
    },
    {
      tool: tool('census_search_variables'),
      reason: 'upstream_error',
      label: 'variables.json rejected with a 400',
      input: { query: 'income' },
      serve: () =>
        override('/data/2024/acs/acs5/variables.json', () =>
          plain(400, 'error: unsupported request'),
        ),
    },

    // census_get_variable
    {
      tool: tool('census_get_variable'),
      reason: 'variable_not_found',
      label: 'a code no dataset publishes',
      input: { variables: ['X99_001E'] },
      serve: serveAcs,
    },
    {
      tool: tool('census_get_variable'),
      reason: 'dataset_not_found',
      label: 'dataset "bogus"',
      input: { variables: ['B19013_001E'], dataset: 'bogus' },
    },
    {
      tool: tool('census_get_variable'),
      reason: 'year_not_available',
      label: 'a year acs/acs5 does not serve',
      input: { variables: ['B19013_001E'], year: 1999 },
    },
    {
      tool: tool('census_get_variable'),
      reason: 'variables_unavailable',
      label: 'an attribute record that cannot be fetched',
      input: { variables: ['B19013_001EA'] },
      serve: () => {
        override('/data/2024/acs/acs5/variables/B19013_001EA.json', () =>
          plain(503, 'unavailable'),
        );
        serveAcs();
      },
      backoff: true,
    },
    {
      tool: tool('census_get_variable'),
      reason: 'upstream_error',
      label: 'variables.json failing with a 503',
      input: { variables: ['B19013_001E'] },
      serve: () => override('/data/2024/acs/acs5/variables.json', () => plain(503, 'unavailable')),
      backoff: true,
    },

    // census_list_geographies
    {
      tool: tool('census_list_geographies'),
      reason: 'dataset_not_found',
      label: 'a blank required dataset',
      input: { dataset: ' ' },
    },
    {
      tool: tool('census_list_geographies'),
      reason: 'year_not_available',
      label: 'geography.json answered 404 for a listed year',
      input: { dataset: 'acs/acs5' },
      serve: () => override('/data/2024/acs/acs5/geography.json', () => plain(404, 'Not Found')),
    },
    {
      tool: tool('census_list_geographies'),
      reason: 'year_not_available',
      label: 'a year acs/acs5 does not serve',
      input: { dataset: 'acs/acs5', year: 1999 },
      serve: () => override('/data/1999/acs/acs5/geography.json', () => plain(404, 'Not Found')),
    },
    {
      tool: tool('census_list_geographies'),
      reason: 'upstream_error',
      label: 'geography.json rejected with a 400',
      input: { dataset: 'acs/acs5' },
      serve: () =>
        override('/data/2024/acs/acs5/geography.json', () => plain(400, 'error: bad request')),
    },

    // census_list_predicate_values
    {
      tool: tool('census_list_predicate_values'),
      reason: 'geography_not_supported',
      label: 'an unknown live enumeration level',
      input: { dataset: 'cbp', predicate: 'EMPSZES', geography_level: 'unknown level' },
      serve: serveCbp,
    },
    {
      tool: tool('census_list_predicate_values'),
      reason: 'parent_required',
      label: 'a live enumeration level requiring a concrete parent',
      input: { dataset: 'cbp', predicate: 'EMPSZES', geography_level: 'tract' },
      serve: serveCbp,
    },
    {
      tool: tool('census_list_predicate_values'),
      reason: 'dataset_not_found',
      label: 'a blank required dataset',
      input: { dataset: ' ', predicate: 'NAICS2017' },
    },
    {
      tool: tool('census_list_predicate_values'),
      reason: 'year_not_available',
      label: 'a year cbp does not serve',
      input: { dataset: 'cbp', year: 2009, predicate: 'NAICS2017' },
    },
    {
      tool: tool('census_list_predicate_values'),
      reason: 'predicate_not_supported',
      label: 'a code cbp does not define',
      input: { dataset: 'cbp', predicate: 'FOO' },
      serve: serveCbp,
    },
    {
      tool: tool('census_list_predicate_values'),
      reason: 'not_a_filter_dimension',
      label: 'a measure, not a dimension',
      input: { dataset: 'cbp', predicate: 'ESTAB' },
      serve: serveCbp,
    },
    {
      tool: tool('census_list_predicate_values'),
      reason: 'no_values',
      label: 'a dimension the data endpoint enumerates as empty',
      input: { dataset: 'cbp', predicate: 'EMPSZES' },
      serve: () => {
        serveCbp();
        serveData('cbp', 2023, noContent);
      },
    },
    {
      tool: tool('census_list_predicate_values'),
      reason: 'missing_api_key',
      label: 'a live-route dimension with CENSUS_API_KEY unset',
      input: { dataset: 'cbp', predicate: 'EMPSZES' },
      serve: () => {
        serveCbp();
        unsetKey();
      },
    },
    {
      tool: tool('census_list_predicate_values'),
      reason: 'missing_api_key',
      label: 'a live-route dimension with the Census API refusing the key',
      input: { dataset: 'cbp', predicate: 'EMPSZES' },
      serve: () => {
        serveCbp();
        serveData('cbp', 2023, () => htmlPage('Invalid Key — see key_signup'));
      },
    },
    {
      tool: tool('census_list_predicate_values'),
      reason: 'upstream_error',
      label: 'the enumeration rejected with a 400',
      input: { dataset: 'cbp', predicate: 'EMPSZES' },
      serve: () => {
        serveCbp();
        serveData('cbp', 2023, () => plain(400, "error: unknown predicate variable: 'X'"));
      },
    },
    {
      tool: tool('census_list_predicate_values'),
      reason: 'upstream_error',
      label: 'an enumeration the data endpoint never answers',
      input: { dataset: 'cbp', predicate: 'EMPSZES' },
      serve: () => {
        serveCbp();
        serveData('cbp', 2023, () => HANG);
      },
      backoff: true,
    },
    {
      tool: tool('census_list_predicate_values'),
      reason: 'variables_unavailable',
      label: 'variables.json answered as HTML',
      input: { dataset: 'cbp', predicate: 'EMPSZES' },
      serve: () => override('/data/2023/cbp/variables.json', () => htmlPage()),
      backoff: true,
    },

    // census_resolve_geography
    ...(
      [
        [
          'a county miss in a named state',
          { name: 'Chatham County, WA', geography_type: 'county' },
        ],
        ['an auto-detected miss in a named state', { name: 'Nonexistent Place XYZ, WA' }],
        ['a miss with no state', { name: 'Nonexistent Place XYZ' }],
        [
          'a county-scoped miss',
          { name: 'Nowhere County, WA', geography_type: 'county', county_fips: '033' },
        ],
        ['a borough asked for as a place', { name: 'Brooklyn, NY', geography_type: 'place' }],
        ['a borough ruled out by its county scope', { name: 'Brooklyn, NY', county_fips: '061' }],
        ['an economic place miss', { name: 'Krupp, WA', geography_type: 'economic place' }],
        ['a statistical area miss', { name: 'Nowhere-Else, CO', geography_type: CBSA }],
        ['a ZIP with no ZCTA', { name: '98111' }],
        [
          'a name sent to the ZCTA level',
          { name: 'Seattle', geography_type: 'zip code tabulation area' },
        ],
        ['an address with a ZIP', { name: '99999 Nonexistent Boulevard, Faketown, WA 98999' }],
        ['an address without a ZIP', { name: '99999 Nonexistent Boulevard, Faketown, WA' }],
      ] as const
    ).map(([label, input]) => ({
      tool: tool('census_resolve_geography'),
      reason: 'no_match',
      label,
      input,
      serve: () => {
        tigerweb();
        geocoderMisses();
      },
    })),
    {
      tool: tool('census_resolve_geography'),
      reason: 'ambiguous_name',
      label: 'a county name two states share',
      input: { name: 'Washington County' },
      serve: () => tigerweb(twoWashingtonCounties),
    },
    {
      tool: tool('census_resolve_geography'),
      reason: 'county_scope_unsupported',
      label: 'county_fips on a state',
      input: { name: 'California', county_fips: '001' },
    },
    {
      tool: tool('census_resolve_geography'),
      reason: 'resolution_unavailable',
      label: 'TIGERweb answering with an error',
      input: { name: 'Seattle, WA' },
      serve: () => tigerweb(() => ({ error: { message: 'Unable to complete operation.' } })),
      backoff: true,
    },
    {
      tool: tool('census_resolve_geography'),
      reason: 'address_rejected',
      label: 'an address the geocoder rejects as too long',
      input: { name: `1 ${'Long '.repeat(25)}St, Seattle, WA 98109` },
      serve: () => {
        routes.push({
          match: (u) => u.hostname === 'geocoding.geo.census.gov',
          respond: () =>
            new Response(
              JSON.stringify({
                errors: ['Address cannot be empty and cannot exceed 100 characters'],
                status: '400',
              }),
              { status: 400, headers: { 'content-type': 'application/json' } },
            ),
        });
      },
    },
    {
      tool: tool('census_resolve_geography'),
      reason: undefined,
      label: 'a blank name',
      input: { name: '   ' },
    },

    // census_query_data and census_compare_geographies share most of their failures.
    ...[query, compare].flatMap((definition): Scenario[] => {
      const base =
        definition === query
          ? { variables: ['B19013_001E'], ...atState }
          : { variables: ['B19013_001E'], geography_level: 'state' };
      const atLevel = (geography_level: string) =>
        definition === query
          ? { variables: ['B19013_001E'], geography_level, geography_fips: '*' }
          : { variables: ['B19013_001E'], geography_level };
      const scoped =
        definition === query
          ? { ...atLevel('county subdivision'), parent_fips: '53' }
          : { ...atLevel('county subdivision'), within: '53' };
      const parented =
        definition === query ? { ...base, parent_fips: '06' } : { ...base, within: '06' };
      return [
        {
          tool: definition,
          reason: 'dataset_not_found',
          label: 'dataset "bogus"',
          input: { ...base, dataset: 'bogus' },
        },
        {
          tool: definition,
          reason: 'dataset_not_found',
          label: 'dataset "profile"',
          input: { ...base, dataset: 'profile' },
        },
        {
          tool: definition,
          reason: 'year_not_available',
          label: 'a year acs/acs5 does not serve',
          input: { ...base, year: 1999 },
        },
        {
          tool: definition,
          reason: 'missing_api_key',
          label: 'the Census API refusing the key',
          input: base,
          serve: () => {
            serveMetadata('acs/acs5', 2024, acsVariables);
            serveData('acs/acs5', 2024, () => htmlPage('Invalid Key — see key_signup'));
          },
        },
        {
          tool: definition,
          reason: 'missing_api_key',
          label: 'CENSUS_API_KEY unset',
          input: base,
          serve: () => {
            serveAcs();
            unsetKey();
          },
        },
        {
          tool: definition,
          reason: 'variable_not_found',
          label: 'a code the Census API rejects as unknown',
          input: { ...base, variables: ['X99_001E'] },
          serve: () => {
            serveMetadata('acs/acs5', 2024, acsVariables);
            serveData('acs/acs5', 2024, () => plain(400, "error: unknown variable 'X99_001E'"));
          },
        },
        {
          tool: definition,
          reason: 'variables_unavailable',
          label: 'variables.json answered as HTML',
          input: base,
          serve: () => {
            override('/data/2024/acs/acs5/variables.json', () => htmlPage());
            serveAcs();
          },
          backoff: true,
        },
        {
          tool: definition,
          reason: 'geography_not_supported',
          label: 'a level outside a short list',
          input: atLevel('place'),
          serve: serveAcs,
        },
        {
          tool: definition,
          reason: 'geography_not_supported',
          label: 'a level outside a long list',
          input: atLevel('place'),
          serve: serveManyLevels,
        },
        {
          tool: definition,
          reason: 'parent_required',
          label: 'a county subdivision with no county',
          input: scoped,
          serve: serveSubdivisions,
        },
        {
          tool: definition,
          reason: 'parent_required',
          label: 'a "*" state on a tract, which does not wildcard it',
          input:
            definition === query
              ? { ...atLevel('tract'), parent_fips: '*' }
              : { ...atLevel('tract'), within: '*' },
          serve: serveAcs,
        },
        {
          tool: definition,
          reason: 'parent_required',
          label: 'a county subdivision under a "*" state and a county it does take',
          input:
            definition === query
              ? { ...atLevel('county subdivision'), parent_fips: '*', county_fips: '033' }
              : { ...atLevel('county subdivision'), within: '*', within_county: '033' },
          serve: serveSubdivisions,
        },
        {
          tool: definition,
          reason: 'parent_required',
          label: 'a parent to add and one to drop',
          input:
            definition === query
              ? { ...atLevel('state legislative district (upper chamber)'), county_fips: '033' }
              : { ...atLevel('state legislative district (upper chamber)'), within_county: '033' },
          serve: () => {
            override('/data/2024/acs/acs5/geography.json', () => ({
              fips: [
                { name: 'state', geoLevelDisplay: '040' },
                {
                  name: 'state legislative district (upper chamber)',
                  geoLevelDisplay: '610',
                  requires: ['state'],
                },
              ],
            }));
            serveAcs();
          },
        },
        {
          tool: definition,
          reason: 'parent_not_accepted',
          label: 'a state with a parent',
          input: parented,
          serve: serveAcs,
        },
        {
          tool: definition,
          reason: 'too_many_variables',
          label: 'fifty codes',
          input: {
            ...base,
            variables: fiftyCodes,
            ...(definition === compare && { sort_by: fiftyCodes[0] }),
          },
          serve: serveAcs,
        },
        {
          tool: definition,
          reason: 'predicate_not_supported',
          label: 'a predicate the dataset does not define',
          input: { ...base, predicates: { FOO: '1' } },
          serve: serveAcs,
        },
        {
          tool: definition,
          reason: 'no_data',
          label: 'a query that matches nothing',
          input: base,
          serve: () => {
            serveMetadata('acs/acs5', 2024, acsVariables);
            serveData('acs/acs5', 2024, noContent);
          },
        },
        {
          tool: definition,
          reason: 'upstream_error',
          label: 'a query the Census API rejects',
          input: base,
          serve: () => {
            serveMetadata('acs/acs5', 2024, acsVariables);
            serveData('acs/acs5', 2024, () => plain(400, "error: invalid 'for' argument"));
          },
        },
        {
          tool: definition,
          reason: 'upstream_error',
          label: 'a data response that is an HTML page',
          input: base,
          serve: () => {
            serveMetadata('acs/acs5', 2024, acsVariables);
            serveData('acs/acs5', 2024, () => htmlPage());
          },
          backoff: true,
        },
        {
          tool: definition,
          reason: 'upstream_error',
          label: 'a data endpoint that never answers',
          input: base,
          serve: () => {
            serveMetadata('acs/acs5', 2024, acsVariables);
            serveData('acs/acs5', 2024, () => HANG);
          },
          backoff: true,
        },
        {
          tool: definition,
          // census_query_data also takes a table in group, so its refusal names a reason (#88).
          reason: definition === query ? 'variables_or_group_required' : undefined,
          label: 'only blank codes',
          input: { ...base, variables: ['  '] },
        },
      ];
    }),
    {
      tool: compare,
      reason: 'sort_by_not_requested',
      label: 'a sort_by outside the variables',
      input: { variables: ['B19013_001E'], geography_level: 'state', sort_by: 'B01003_001E' },
    },
    {
      tool: compare,
      reason: 'ambiguous_rows',
      label: 'two records per state',
      input: { variables: ['POP'], geography_level: 'state', dataset: 'pep/charv' },
      serve: serveCharv,
    },
    {
      tool: compare,
      reason: 'no_data',
      label: 'a geographies filter that matches no row',
      input: { variables: ['B19013_001E'], geography_level: 'state', geographies: ['99'] },
      serve: serveAcs,
    },

    // Tables that split POPGROUP groups between them (#54, #68).
    {
      tool: query,
      reason: 'no_data',
      label: 'a dec/ddhcb table that does not publish the group there',
      input: { ...inWashington, variables: ['T03001_001N'], predicates: { POPGROUP: '1002' } },
      serve: serveDdhcb,
    },
    {
      tool: query,
      reason: 'no_data',
      label: 'a dec/ddhcb request whose first-listed table lacks the group',
      input: {
        ...inWashington,
        variables: ['T04002_004N', 'T03001_001N'],
        predicates: { POPGROUP: '3910' },
      },
      serve: serveDdhcb,
    },
    {
      tool: query,
      reason: 'no_data',
      label: 'a dec/ddhca sex-by-age table that does not publish the group',
      input: {
        dataset: 'dec/ddhca',
        geography_level: 'us',
        geography_fips: '1',
        variables: ['T02003_001N'],
        predicates: { POPGROUP: '1360' },
      },
      serve: serveDdhca,
    },
    {
      tool: compare,
      reason: 'no_data',
      label: 'a dec/ddhcb comparison no county publishes the group in',
      input: {
        dataset: 'dec/ddhcb',
        variables: ['T03002_002N'],
        geography_level: 'county',
        within: '53',
        predicates: { POPGROUP: '1360' },
      },
      serve: serveDdhcb,
    },
    {
      tool: compare,
      reason: 'no_data',
      label: 'a dec/ddhcb geographies filter that matches no row',
      input: {
        dataset: 'dec/ddhcb',
        variables: ['T03004_002N'],
        geography_level: 'county',
        within: '53',
        predicates: { POPGROUP: '1002' },
        geographies: ['53001'],
      },
      serve: serveDdhcb,
    },

    // no_values names within_naics only when the call set it.
    {
      tool: tool('census_list_predicate_values'),
      reason: 'no_values',
      label: 'an industry-scoped enumeration that came back empty',
      input: { dataset: 'ecnbasic', predicate: 'TAXSTAT', within_naics: '541990' },
      serve: () => {
        serveMetadata('ecnbasic', 2022, {
          ESTAB: { label: 'Number of establishments', predicateType: 'int', group: 'EC2200BASIC' },
          NAICS2022: {
            label: '2022 NAICS code',
            required: 'default displayed',
            predicateType: 'string',
            values: { item: { '00': 'Total for all sectors' } },
          },
          TAXSTAT: {
            label: 'Tax status code',
            required: 'default displayed',
            predicateType: 'string',
            attributes: 'TAXSTAT_LABEL',
          },
        });
        serveData('ecnbasic', 2022, noContent);
      },
    },
    {
      tool: tool('census_list_predicate_values'),
      reason: 'no_values',
      label: 'a value map that kept no published code',
      input: { dataset: 'dec/ddhca', predicate: 'POPGROUP' },
      serve: () => {
        serveMetadata('dec/ddhca', 2020, {
          T01001_001N: { label: ' !!Total', predicateType: 'int', group: 'T01001' },
          POPGROUP: {
            label: 'Race/Ethnic Group',
            required: 'default displayed',
            predicateType: 'string',
            values: { item: { '001': 'Total population' } },
          },
        });
        serveData('dec/ddhca', 2020, () => [
          ['T01001_001N', 'POPGROUP', 'us'],
          ['191697647', '1002', '1'],
        ]);
      },
    },

    // variable_not_found when a sibling dataset is confirmed to hold the code (#65): the hint
    // then names that dataset instead of the search step.
    {
      tool: tool('census_get_variable'),
      reason: 'variable_not_found',
      label: 'a code a sibling dataset holds',
      input: { variables: ['S1701_C03_001E'] },
      serve: () => {
        serveAcs();
        override('/data/2024/acs/acs5/subject/variables/S1701_C03_001E.json', () => ({
          name: 'S1701_C03_001E',
        }));
      },
    },
    {
      tool: tool('census_get_variable'),
      reason: 'variable_not_found',
      label: 'codes a sibling holds, its table holds, and nothing holds',
      input: { variables: ['S1701_C03_001E', 'S1701_C03_002E', 'X99_001E', 'X98_001E'] },
      serve: () => {
        serveAcs();
        override('/data/2024/acs/acs5/subject/variables/S1701_C03_001E.json', () => ({
          name: 'S1701_C03_001E',
        }));
      },
    },
    ...[query, compare].map(
      (definition): Scenario => ({
        tool: definition,
        reason: 'variable_not_found',
        label: 'a code the Census API rejects and a sibling dataset holds',
        input:
          definition === query
            ? { variables: ['S1701_C03_001E'], ...atState }
            : { variables: ['S1701_C03_001E'], geography_level: 'state' },
        serve: () => {
          serveMetadata('acs/acs5', 2024, acsVariables);
          serveData('acs/acs5', 2024, () => plain(400, "error: unknown variable 'S1701_C03_001E'"));
          override('/data/2024/acs/acs5/subject/variables/S1701_C03_001E.json', () => ({
            name: 'S1701_C03_001E',
          }));
        },
      }),
    ),

    // A table requested whole through group (#88).
    {
      tool: query,
      reason: 'group_not_supported',
      label: 'a table on a dataset whose tables carry filter dimensions',
      input: { ...atState, dataset: 'cbp', group: 'CB2300CBP' },
      serve: serveCbp,
    },
    {
      tool: query,
      reason: 'multiple_groups',
      label: 'group and a group() entry naming two tables',
      input: { ...atState, variables: ['group(B19013)'], group: 'B01001' },
    },
    {
      tool: query,
      reason: 'variable_not_found',
      label: 'a table the dataset does not publish',
      input: { ...atState, group: 'B99999' },
      serve: () => {
        serveAcs();
        override('/data/2024/acs/acs1/groups/B99999.json', () => plain(404, 'Not Found'));
      },
    },
    {
      tool: query,
      reason: 'variable_not_found',
      label: 'a table a sibling dataset publishes',
      input: { ...atState, group: 'S1701' },
      serve: () => {
        serveAcs();
        override('/data/2024/acs/acs5/subject/groups/S1701.json', () => ({ name: 'S1701' }));
      },
    },
    {
      tool: query,
      reason: 'upstream_error',
      label: 'a whole table the data endpoint never answers',
      input: { ...atState, group: 'B19013' },
      serve: () => {
        serveMetadata('acs/acs5', 2024, {
          ...acsVariables,
          B19013_001E: { ...acsVariables.B19013_001E, group: 'B19013' },
        });
        serveData('acs/acs5', 2024, () => HANG);
      },
      backoff: true,
    },
  ];

  const run = async (scenario: Scenario) => {
    scenario.serve?.();
    const pending = runToolContract(scenario.tool as never, scenario.input as never);
    if (!scenario.backoff) return await pending;
    await vi.advanceTimersByTimeAsync(300_000);
    return await pending;
  };

  it('has a scenario for every reason every tool declares', () => {
    const covered = new Set(scenarios.map((s) => `${s.tool.name} ${s.reason}`));
    const declared = allToolDefinitions.flatMap((definition) =>
      ((definition as { errors?: ReadonlyArray<{ reason: string }> }).errors ?? []).map(
        (entry) => `${definition.name} ${entry.reason}`,
      ),
    );

    expect(declared.filter((key) => !covered.has(key))).toEqual([]);
  });

  it.each(
    scenarios.map(
      (scenario) =>
        [
          `${scenario.tool.name} ${scenario.reason ?? '(no reason)'}: ${scenario.label}`,
          scenario,
        ] as const,
    ),
  )('%s', async (_name, scenario) => {
    if (scenario.backoff) vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const result = await run(scenario);

      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error.data.reason).toBe(scenario.reason);
      // A reason a tool can fail with is one its contract declares.
      if (scenario.reason !== undefined) {
        const declared =
          (scenario.tool as { errors?: ReadonlyArray<{ reason: string }> }).errors ?? [];
        expect(declared.map((entry) => entry.reason)).toContain(scenario.reason);
      }

      // Read back as a client renders it: the text escapes Markdown punctuation such as "*".
      const paragraphs = readParagraphs(textOf(result));
      const message = paragraphs.find((p) => p.startsWith('Error: '))?.slice('Error: '.length);
      const hint = paragraphs.find((p) => p.startsWith('Recovery: '))?.slice('Recovery: '.length);
      expect(message).toBe(error.message);
      expect(hint, 'every failure names a next step').toBeDefined();
      expect(repeatsBetween(message ?? '', hint ?? '')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// #92 — geoinfo: land area and internal points
// ---------------------------------------------------------------------------------------------

/**
 * geoinfo modelled on api.census.gov answers captured on 2026-11-15, in the shape every query here
 * sends. GEOCOMP is its only required variable, so it declares no filter dimension, and its 2020
 * vintage publishes a ZCTA once per delineation, told apart only by GEO_ID.
 */
describe('geoinfo answers land area and internal points (#92)', () => {
  type Cells = Readonly<Record<string, string>>;

  const measure = (label: string, predicateType: 'int' | 'float') => ({
    label,
    concept: 'Annual Geographic Information Table',
    predicateType,
    group: 'GEOINFO',
  });
  const geoinfoVariables = {
    AREALAND: measure('Area (Land, in square meters)', 'int'),
    AREAWATR: measure('Area (Water, in square meters)', 'int'),
    AREALAND_SQMI: measure('Area (Land, in square miles)', 'float'),
    AREAWATR_SQMI: measure('Area (Water, in square miles)', 'float'),
    INTPTLAT: measure('Internal Point (Latitude)', 'float'),
    INTPTLON: measure('Internal Point (Longitude)', 'float'),
    GEO_ID: {
      label: 'Geographic Identifier',
      concept: 'Annual Geographic Information Table',
      predicateType: 'string',
      group: 'GEOINFO',
      attributes: 'NAME',
    },
    GEOCOMP: {
      label: 'GEO_ID Component',
      required: 'default displayed',
      predicateType: 'string',
      group: 'N/A',
    },
    // The geography columns publish no predicate type.
    STATE: { label: 'State', predicateType: null, group: 'N/A' },
    ZCTA: { label: 'ZIP Code Tabulation Area', predicateType: null, group: 'N/A' },
  };

  const ZCTA = 'zip code tabulation area';
  const levels = [
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
    {
      name: 'place',
      geoLevelDisplay: '160',
      requires: ['state'],
      wildcard: ['state'],
      optionalWithWCFor: 'state',
    },
    { name: ZCTA, geoLevelDisplay: '860' },
  ];

  /** Land area in square miles of every Washington county, 2024. */
  const WA_COUNTIES = [
    ['001', 'Adams', '1924.989'],
    ['003', 'Asotin', '636.075'],
    ['005', 'Benton', '1700.128'],
    ['007', 'Chelan', '2921.178'],
    ['009', 'Clallam', '1738.774'],
    ['011', 'Clark', '628.501'],
    ['013', 'Columbia', '868.585'],
    ['015', 'Cowlitz', '1141.159'],
    ['017', 'Douglas', '1819.244'],
    ['019', 'Ferry', '2203.241'],
    ['021', 'Franklin', '1241.596'],
    ['023', 'Garfield', '710.835'],
    ['025', 'Grant', '2679.547'],
    ['027', 'Grays Harbor', '1901.464'],
    ['029', 'Island', '208.474'],
    ['031', 'Jefferson', '1803.728'],
    ['033', 'King', '2115.696'],
    ['035', 'Kitsap', '395.111'],
    ['037', 'Kittitas', '2297.291'],
    ['039', 'Klickitat', '1871.636'],
    ['041', 'Lewis', '2402.782'],
    ['043', 'Lincoln', '2310.599'],
    ['045', 'Mason', '959.553'],
    ['047', 'Okanogan', '5266.193'],
    ['049', 'Pacific', '933.373'],
    ['051', 'Pend Oreille', '1400.245'],
    ['053', 'Pierce', '1668.004'],
    ['055', 'San Juan', '173.914'],
    ['057', 'Skagit', '1730.231'],
    ['059', 'Skamania', '1658.268'],
    ['061', 'Snohomish', '2086.515'],
    ['063', 'Spokane', '1764.224'],
    ['065', 'Stevens', '2477.103'],
    ['067', 'Thurston', '722.501'],
    ['069', 'Wahkiakum', '262.928'],
    ['071', 'Walla Walla', '1270.033'],
    ['073', 'Whatcom', '2107.949'],
    ['075', 'Whitman', '2159.262'],
    ['077', 'Yakima', '4294.512'],
  ] as const;

  /** King County's other measures, as the Census prints them. */
  const KING_COUNTY = {
    AREAWATR_SQMI: '191.707',
    INTPTLAT: '47.49055180',
    INTPTLON: '-121.83397650',
  };

  const published2024: Cells[] = [
    ...WA_COUNTIES.map(([county, name, landSqmi]) => ({
      NAME: `${name} County, Washington`,
      AREALAND_SQMI: landSqmi,
      ...(county === '033' && KING_COUNTY),
      state: '53',
      county,
    })),
    {
      NAME: 'Census Tract 71.01; King County; Washington',
      AREALAND_SQMI: '0.191',
      state: '53',
      county: '033',
      tract: '007101',
    },
    { NAME: 'Seattle city, Washington', AREALAND_SQMI: '84.000', state: '53', place: '63000' },
  ];

  /** 2020 publishes each ZCTA under its 2010 (8600000) and its 2020 (860Z200) delineation. */
  const published2020: Cells[] = (
    [
      ['98101', '0.519', '0.528'],
      ['98102', '1.292', '1.273'],
    ] as const
  ).flatMap(([zcta, land2010, land2020]) => [
    { NAME: `ZCTA5 ${zcta}`, AREALAND_SQMI: land2010, GEO_ID: `8600000US${zcta}`, [ZCTA]: zcta },
    { NAME: `ZCTA5 ${zcta}`, AREALAND_SQMI: land2020, GEO_ID: `860Z200US${zcta}`, [ZCTA]: zcta },
  ]);

  /**
   * Answer a data request the way the Census does: the rows matching `for`, `in`, and a GEO_ID
   * predicate, with the requested columns, the echoed predicate, then the geography columns.
   */
  const answer =
    (published: readonly Cells[]) =>
    (url: URL): Body => {
      const [level = '', codes = ''] = (url.searchParams.get('for') ?? '').split(':');
      const parents = (url.searchParams.get('in') ?? '')
        .split(' ')
        .filter(Boolean)
        .map((clause) => clause.split(':') as [string, string]);
      // A row is at the requested level when its geography columns are exactly the clause's.
      const geoColumns = [...parents.map(([column]) => column), level];
      const pinned = url.searchParams.get('GEO_ID');
      const rows = published.filter(
        (cells) =>
          Object.keys(cells)
            .filter((column) => /^[a-z]/.test(column))
            .join('|') === geoColumns.join('|') &&
          (codes === '*' || codes.split(',').includes(cells[level] ?? '')) &&
          parents.every(([column, code]) => cells[column] === code) &&
          (pinned === null || cells.GEO_ID === pinned),
      );
      if (rows.length === 0) return new Response(null, { status: 204 });
      const header = [...getList(url), ...(pinned === null ? [] : ['GEO_ID']), ...geoColumns];
      return [header, ...rows.map((cells) => header.map((column) => cells[column] ?? null))];
    };

  const serveGeoinfo = (year: number, published: readonly Cells[]) => {
    routes.push(
      {
        match: (u) => u.pathname === `${at('geoinfo', year)}/variables.json`,
        respond: () => ({ variables: geoinfoVariables }),
      },
      {
        match: (u) => u.pathname === `${at('geoinfo', year)}/geography.json`,
        respond: () => ({ fips: levels }),
      },
    );
    serveData('geoinfo', year, answer(published));
  };

  it('census_query_data returns the areas and internal point of a county, with no notice and no applied_filters', async () => {
    serveGeoinfo(2024, published2024);

    const result = await runToolContract(censusQueryData, {
      variables: ['AREALAND_SQMI', 'AREAWATR_SQMI', 'INTPTLAT', 'INTPTLON'],
      geography_level: 'county',
      geography_fips: '033',
      parent_fips: '53',
      dataset: 'geoinfo',
      year: 2024,
    });

    expect(result.isError).toBeFalsy();
    // No filter dimension, record dimension, or flag column adds anything to the request.
    expect(getList(dataCalls('geoinfo', 2024)[0])).toEqual([
      'NAME',
      'AREALAND_SQMI',
      'AREAWATR_SQMI',
      'INTPTLAT',
      'INTPTLON',
    ]);
    const out = structured(result);
    expect(out.rows).toHaveLength(1);
    const [row] = out.rows;
    expect(row?.geography_name).toBe('King County, Washington');
    expect(row?.geography_geoid).toBe('53033');
    expect(row?.variables.AREALAND_SQMI?.estimate).toBe(2115.696);
    expect(row?.variables.AREAWATR_SQMI?.estimate).toBe(191.707);
    expect(row?.variables.INTPTLAT?.estimate).toBe(47.4905518);
    expect(row?.variables.INTPTLON?.estimate).toBe(-121.8339765);
    expect(row).not.toHaveProperty('applied_filters');
    expect(row).not.toHaveProperty('record');
    expect(out.notice).toBeUndefined();
    expect(textOf(result)).toContain('King County, Washington');
  });

  it.each([
    [
      'tract 007101',
      { geography_level: 'tract', geography_fips: '007101', parent_fips: '53', county_fips: '033' },
      'Census Tract 71.01; King County; Washington',
      0.191,
    ],
    [
      'place 63000',
      { geography_level: 'place', geography_fips: '63000', parent_fips: '53' },
      'Seattle city, Washington',
      84,
    ],
  ])('census_query_data returns the land area of %s', async (_name, geography, name, landSqmi) => {
    serveGeoinfo(2024, published2024);

    const result = await runToolContract(censusQueryData, {
      variables: ['AREALAND_SQMI'],
      dataset: 'geoinfo',
      year: 2024,
      ...geography,
    });

    const [row] = structured(result).rows;
    expect(row?.geography_name).toBe(name);
    expect(row?.variables.AREALAND_SQMI?.estimate).toBe(landSqmi);
    expect(structured(result).notice).toBeUndefined();
  });

  it('census_compare_geographies ranks Washington counties by land area, Okanogan first of 39', async () => {
    serveGeoinfo(2024, published2024);

    const result = await runToolContract(censusCompareGeographies, {
      variables: ['AREALAND_SQMI'],
      geography_level: 'county',
      within: '53',
      dataset: 'geoinfo',
      year: 2024,
      limit: 3,
    });

    expect(result.isError).toBeFalsy();
    const out = structured(result) as ReturnType<typeof structured> & { totalCount: number };
    expect(out.totalCount).toBe(39);
    expect(
      out.rows.map((row) => [row.rank, row.geography_name, row.variables.AREALAND_SQMI?.estimate]),
    ).toEqual([
      [1, 'Okanogan County, Washington', 5266.193],
      [2, 'Yakima County, Washington', 4294.512],
      [3, 'Chelan County, Washington', 2921.178],
    ]);
  });

  it('census_query_data returns one 2020 ZCTA on two rows, which GEO_ID labels when requested', async () => {
    serveGeoinfo(2020, published2020);

    const bare = await runToolContract(censusQueryData, {
      variables: ['AREALAND_SQMI'],
      geography_level: ZCTA,
      geography_fips: '98101',
      dataset: 'geoinfo',
      year: 2020,
    });
    expect(structured(bare).rows.map((row) => row.variables.AREALAND_SQMI?.estimate)).toEqual([
      0.519, 0.528,
    ]);
    const notice = structured(bare).notice ?? '';
    expect(notice).toContain('returned 2 rows for a single geography');
    // geoinfo declares no filter dimension, so the notice names the one column that separates them.
    expect(notice).toContain('only GEO_ID tells them apart');
    expect(notice).toContain('{"GEO_ID": "<its GEO_ID>"}');
    expect(notice).not.toMatch(/filter dimension/);
    expect(notice).not.toContain('census_list_predicate_values');
    expect(readNotice(bare)).toBe(notice);

    const labelled = await runToolContract(censusQueryData, {
      variables: ['AREALAND_SQMI', 'GEO_ID'],
      geography_level: ZCTA,
      geography_fips: '98101',
      dataset: 'geoinfo',
      year: 2020,
    });
    expect(structured(labelled).rows.map((row) => row.variables.GEO_ID?.value)).toEqual([
      '8600000US98101',
      '860Z200US98101',
    ]);
    const text = textOf(labelled);
    expect(text).toContain('8600000US98101');
    expect(text).toContain('860Z200US98101');
  });

  it('census_query_data pins one 2020 delineation with a GEO_ID predicate, as the catalog says', async () => {
    serveGeoinfo(2020, published2020);

    const result = await runToolContract(censusQueryData, {
      variables: ['AREALAND_SQMI'],
      geography_level: ZCTA,
      geography_fips: '98101',
      dataset: 'geoinfo',
      year: 2020,
      predicates: { GEO_ID: '860Z200US98101' },
    });

    expect(dataCalls('geoinfo', 2020)[0]?.searchParams.get('GEO_ID')).toBe('860Z200US98101');
    const out = structured(result);
    expect(out.rows.map((row) => row.variables.AREALAND_SQMI?.estimate)).toEqual([0.528]);
    expect(out.notice).toBeUndefined();
  });

  it('census_compare_geographies refuses to rank 2020 ZCTAs published once per delineation', async () => {
    serveGeoinfo(2020, published2020);

    const result = await runToolContract(censusCompareGeographies, {
      variables: ['AREALAND_SQMI'],
      geography_level: ZCTA,
      geographies: ['98101', '98102'],
      dataset: 'geoinfo',
      year: 2020,
    });

    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.data).toMatchObject({
      reason: 'ambiguous_rows',
      dataset: 'geoinfo',
      year: 2020,
      rowsPerGeography: 2,
    });
    // The recovery names GEO_ID, not filter dimensions geoinfo does not have.
    const hint = (error.data.recovery as { hint: string }).hint;
    expect(hint).toMatch(/^Only GEO_ID tells the rows apart/);
    expect(hint).toContain('census_query_data');
    expect(hint).not.toMatch(/filter dimension/);
    expect(hint).not.toContain('census_list_predicate_values');
    const paragraphs = readParagraphs(textOf(result));
    expect(paragraphs.find((p) => p.startsWith('Recovery: '))).toBe(`Recovery: ${hint}`);
    expect(repeatsBetween(error.message, hint)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// #94 — a vintage drawn on earlier tracts, and Connecticut's two county schemes
// ---------------------------------------------------------------------------------------------

/**
 * Modelled on api.census.gov answers probed on 2026-11-15: King County, WA tract 007100 (Census
 * Tract 71) is published through 2019, and the 2020 Census split it into 007101 and 007102; acs/acs5
 * 2021 publishes Connecticut's eight counties and 2022 its nine planning regions, with the same
 * tract codes under each.
 */
describe('a code a vintage draws differently from the resolver is named as a possible cause (#94)', () => {
  const TRACT_2010 =
    'acs/acs5 (2019) publishes census tracts as drawn for the 2010 Census, not the 2020 tracts census_resolve_geography returns — the 2020 Census split, merged, or renumbered many of them, so a 2020 tract code can be missing here';
  const QUERY_LISTING =
    'geography_fips "*" at geography_level "tract", with the same parent_fips and county_fips, lists the tracts this vintage publishes.';
  const WIDTH = 'Confirm the FIPS codes exist in';
  const GEOID_GUIDANCE = "The geographies filter matches a row's full GEOID";

  /** Every level from state down to block, each listed with the parents and wildcards it takes. */
  const serveLevels = (dataset: string, year: number) => {
    routes.push(
      {
        match: (u) => u.pathname === `${at(dataset, year)}/variables.json`,
        respond: () => ({ variables: acsVariables }),
      },
      {
        match: (u) => u.pathname === `${at(dataset, year)}/geography.json`,
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
              name: 'county subdivision',
              geoLevelDisplay: '060',
              requires: ['state', 'county'],
              wildcard: ['county'],
              optionalWithWCFor: 'county',
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
            {
              name: 'block',
              geoLevelDisplay: '100',
              requires: ['state', 'county', 'tract'],
              wildcard: ['county', 'tract'],
              optionalWithWCFor: 'tract',
            },
          ],
        }),
      },
    );
  };

  /** The geography columns the Census API answers a level with ahead of its own, named or not. */
  const PARENT_COLUMNS: Readonly<Record<string, string[]>> = {
    county: ['state'],
    'county subdivision': ['state', 'county'],
    tract: ['state', 'county'],
    'block group': ['state', 'county', 'tract'],
    block: ['state', 'county', 'tract'],
  };

  /**
   * Answer the data endpoint from the codes `published` holds, each a row of codes from state down
   * to the requested level, filtered by the request's `for` and `in` as the Census API filters them.
   * A parent the request leaves out of `in` is still a column of every row. Nothing selected is a
   * 204, as the Census API answers it. The level name matches regardless of case and surrounding
   * space, as it does there (`for=County:053` and `for= county:053` answer as `county:053`).
   */
  const servePublished = (dataset: string, year: number, published: string[][]) => {
    serveLevels(dataset, year);
    serveData(dataset, year, (url) => {
      const header = getList(url);
      const [name = '', target = '*'] = (url.searchParams.get('for') ?? '').split(':');
      const level = name.trim().toLowerCase();
      const scope = (url.searchParams.get('in') ?? '').split(' ').filter(Boolean);
      const levels = [...(PARENT_COLUMNS[level] ?? []), level];
      const targets = target.split(',');
      const rows = published.filter(
        (codes) =>
          codes.length === levels.length &&
          scope.every((part) => {
            const [column = '', code] = part.split(':');
            return code === '*' || code === codes[levels.indexOf(column)];
          }) &&
          (target === '*' || targets.includes(codes.at(-1) ?? '')),
      );
      if (rows.length === 0) return new Response(null, { status: 204 });
      return [
        [...header, ...levels],
        ...rows.map((codes) => [
          ...header.map((h) => (h === 'NAME' ? `${level} ${codes.at(-1)}` : '5301')),
          ...codes,
        ]),
      ];
    });
  };

  /** The King County tracts and block groups a 2019 vintage publishes around Tract 71. */
  const king2019 = (dataset = 'acs/acs5', year = 2019) =>
    servePublished(dataset, year, [
      ['53', '033'],
      ['53', '033', '007000'],
      ['53', '033', '007100'],
      ['53', '033', '007100', '1'],
      ['53', '033', '007100', '2'],
    ]);

  const hintOf = (result: { structuredContent?: unknown }) =>
    (errorOf(result).data.recovery as { hint: string }).hint;

  /** content[]'s Recovery paragraph, read back with each code span's text in place of its marker. */
  const recoveryShown = (result: { content: Array<{ type: string; text?: string }> }) =>
    readParagraphs(textOf(result))
      .find((p) => p.startsWith('Recovery: '))
      ?.slice('Recovery: '.length)
      .replace(/«code_inline:([^»]*)»/g, '$1');

  /** The no_data contract for a hint that names a boundary change ahead of the code guidance. */
  const expectBoundaryHint = (
    result: Awaited<ReturnType<typeof runToolContract>>,
    boundary: string,
    guidance: string,
  ) => {
    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.data.reason).toBe('no_data');
    const hint = hintOf(result);
    expect(hint).toContain(boundary);
    // The width or GEOID guidance stays, as the second cause.
    expect(hint.indexOf(guidance)).toBeGreaterThan(hint.indexOf(boundary));
    // A value to send back ("*", "09") reaches content[] as a code span a model copies verbatim,
    // and the whole hint reads back as structuredContent carries it.
    for (const value of ['*', '09']) {
      if (hint.includes(`"${value}"`)) expect(textOf(result)).toContain(`"\`${value}\`"`);
    }
    expect(recoveryShown(result)).toBe(hint);
    expect(repeatsBetween(error.message, hint)).toEqual([]);
  };

  const kingTract = (overrides: Record<string, unknown> = {}) => ({
    variables: ['B01003_001E'],
    geography_level: 'tract',
    geography_fips: '007101',
    parent_fips: '53',
    county_fips: '033',
    year: 2019,
    ...overrides,
  });

  it('census_query_data: a 2020 tract on acs/acs5 2019 names the 2010 tracts and the listing first', async () => {
    king2019();

    const result = await runToolContract(censusQueryData, kingTract());

    expectBoundaryHint(result, `${TRACT_2010}. ${QUERY_LISTING}`, WIDTH);
    expect(errorOf(result).message).toBe('No data returned for tract in acs/acs5 (2019).');
    expect(hintOf(result)).toContain('a county is "051", not "51"');
    expect(dataCalls('acs/acs5', 2019)).toHaveLength(1);
  });

  it('census_compare_geographies: a 2020 tract GEOID on 2019 names the 2010 tracts and the listing first', async () => {
    king2019();

    const result = await runToolContract(censusCompareGeographies, {
      variables: ['B01003_001E'],
      geography_level: 'tract',
      within: '53',
      within_county: '033',
      geographies: ['53033007101'],
      year: 2019,
    });

    expectBoundaryHint(
      result,
      `${TRACT_2010}. Omitting geographies, with the same within and within_county, lists every tract this vintage publishes, each GEOID carrying its tract.`,
      GEOID_GUIDANCE,
    );
  });

  it('census_query_data: a list returns the 2010 tract and names the 2020 one with the tract change', async () => {
    king2019();

    const result = await runToolContract(
      censusQueryData,
      kingTract({ geography_fips: '007101,007100' }),
    );

    expect(result.isError).not.toBe(true);
    expect(structured(result).rows.map((row) => row.geography_geoid)).toEqual(['53033007100']);
    const notice = structured(result).notice ?? '';
    expect(notice).toContain(
      `No row came back for 1 of the 2 geography_fips codes: 007101. ${TRACT_2010}. ${QUERY_LISTING} The Census API matches each code literally`,
    );
    expect(readNotice(result)).toBe(notice);
  });

  it('census_compare_geographies: a list ranks the 2010 tract and names the 2020 one with the tract change', async () => {
    king2019();

    const result = await runToolContract(censusCompareGeographies, {
      variables: ['B01003_001E'],
      geography_level: 'tract',
      within: '53',
      within_county: '033',
      geographies: ['53033007101', '53033007100'],
      year: 2019,
    });

    expect(result.isError).not.toBe(true);
    expect(structured(result).rows.map((row) => row.geography_geoid)).toEqual(['53033007100']);
    const notice = structured(result).notice ?? '';
    expect(notice).toContain(
      `No tract matched 1 of the requested geographies: 53033007101. ${TRACT_2010}. Omitting geographies`,
    );
    expect(notice).toContain('. Entries must be a full GEOID');
    expect(readNotice(result)).toBe(notice);
  });

  it.each([
    ['block group "2"', { geography_level: 'block group', geography_fips: '2' }],
    ['block group "*"', { geography_level: 'block group', geography_fips: '*' }],
  ])(
    'census_query_data: a %s inside the 2020 tract on 2019 gets the tract-vintage hint',
    async (_label, level) => {
      king2019();

      const result = await runToolContract(
        censusQueryData,
        kingTract({ ...level, tract_fips: '007101' }),
      );

      expectBoundaryHint(
        result,
        `${TRACT_2010}, along with its block groups. ${QUERY_LISTING}`,
        WIDTH,
      );
    },
  );

  it('census_query_data: a block group GEOID carrying the 2020 tract on 2019 gets the tract-vintage hint', async () => {
    king2019();

    const result = await runToolContract(
      censusQueryData,
      kingTract({ geography_level: 'block group', geography_fips: '530330071012' }),
    );

    expectBoundaryHint(
      result,
      `${TRACT_2010}, along with its block groups. ${QUERY_LISTING}`,
      WIDTH,
    );
  });

  it('census_query_data: block "*" inside the 2020 tract on dec/pl 2010 gets the tract-vintage hint', async () => {
    king2019('dec/pl', 2010);

    const result = await runToolContract(
      censusQueryData,
      kingTract({
        dataset: 'dec/pl',
        year: 2010,
        geography_level: 'block',
        geography_fips: '*',
        tract_fips: '007101',
      }),
    );

    expectBoundaryHint(
      result,
      'dec/pl (2010) publishes census tracts as drawn for the 2010 Census, not the 2020 tracts census_resolve_geography returns — the 2020 Census split, merged, or renumbered many of them, so a 2020 tract code can be missing here, along with its blocks.',
      WIDTH,
    );
  });

  it('census_compare_geographies: a block group GEOID inside the 2020 tract on 2019 gets the tract-vintage hint', async () => {
    king2019();

    const result = await runToolContract(censusCompareGeographies, {
      variables: ['B01003_001E'],
      geography_level: 'block group',
      within: '53',
      within_county: '033',
      geographies: ['530330071012'],
      year: 2019,
    });

    expectBoundaryHint(result, `${TRACT_2010}, along with its block groups.`, GEOID_GUIDANCE);
  });

  it('census_compare_geographies: a bare block group code on 2019 names no tract change, carrying no tract', async () => {
    king2019();

    const result = await runToolContract(censusCompareGeographies, {
      variables: ['B01003_001E'],
      geography_level: 'block group',
      within: '53',
      within_county: '033',
      geographies: ['1', '3'],
      year: 2019,
    });

    expect(result.isError).not.toBe(true);
    expect(structured(result).rows.map((row) => row.geography_geoid)).toEqual(['530330071001']);
    const notice = structured(result).notice ?? '';
    expect(notice).toContain(
      'No block group matched 1 of the requested geographies: 3. Entries must be a full GEOID',
    );
    expect(notice).not.toContain('census tracts as drawn');
  });

  it.each([
    ['acs/acs5', 2009],
    ['dec/pl', 2000],
  ])('%s %i names 2000 tracts', async (dataset, year) => {
    king2019(dataset, year);

    const result = await runToolContract(censusQueryData, kingTract({ dataset, year }));

    expectBoundaryHint(
      result,
      `${dataset} (${year}) publishes census tracts as drawn for the 2000 Census`,
      WIDTH,
    );
  });

  it.each([
    ['a 2020 vintage', kingTract({ year: 2020, geography_fips: '999999' }), 2020],
    ['a tract-level "*"', kingTract({ geography_fips: '*', county_fips: '999' }), 2019],
    [
      'the county level',
      {
        ...kingTract({ geography_level: 'county', geography_fips: '999' }),
        county_fips: undefined,
      },
      2019,
    ],
    [
      'a block group "*" with a blank tract_fips',
      kingTract({
        geography_level: 'block group',
        geography_fips: '*',
        county_fips: '999',
        tract_fips: '',
      }),
      2019,
    ],
  ])('names no tract change for %s', async (_label, input, year) => {
    king2019('acs/acs5', year);

    const result = await runToolContract(censusQueryData, input);

    expect(errorOf(result).data.reason).toBe('no_data');
    expect(hintOf(result)).not.toContain('census tracts as drawn');
    expect(textOf(result)).not.toContain('census tracts as drawn');
  });

  /** Connecticut on acs/acs5 2021 and 2022: the eight counties, then the nine planning regions. */
  const connecticut = () => {
    servePublished('acs/acs5', 2021, [
      ['09', '001'],
      ['09', '005'],
      ['09', '001', '010101'],
    ]);
    servePublished('acs/acs5', 2022, [
      ['09', '110'],
      ['09', '190'],
      ['09', '190', '010101'],
    ]);
  };
  const ctCounty = (year: number, code: string) => ({
    variables: ['B01003_001E'],
    geography_level: 'county',
    geography_fips: code,
    parent_fips: '09',
    year,
  });

  it.each([
    [
      2021,
      '190',
      "Connecticut's county 190 is among the nine planning regions (110–190) that vintages from 2022 publish; acs/acs5 (2021) publishes the eight counties from before 2022 (001–015) in their place.",
    ],
    [
      2022,
      '001',
      "Connecticut's county 001 is among the eight counties from before 2022 (001–015); acs/acs5 (2022) publishes the nine planning regions (110–190) that replaced them.",
    ],
  ])(
    'census_query_data: a Connecticut county on %i in the other scheme (%s) names the scheme change',
    async (year, code, sentence) => {
      connecticut();

      const result = await runToolContract(censusQueryData, ctCounty(year, code));

      expectBoundaryHint(
        result,
        `${sentence} geography_fips "*" at the county level with parent_fips "09" lists them.`,
        WIDTH,
      );
      expect(textOf(result)).toContain('"`09`"');
    },
  );

  it('census_query_data: a tract scoped by a planning region on 2021 names the earlier counties', async () => {
    connecticut();

    const result = await runToolContract(censusQueryData, {
      ...ctCounty(2021, '010101'),
      geography_level: 'tract',
      county_fips: '190',
    });

    expectBoundaryHint(
      result,
      "Connecticut's county 190 is among the nine planning regions (110–190) that vintages from 2022 publish; acs/acs5 (2021) publishes the eight counties from before 2022 (001–015) in their place. Tracts and county subdivisions kept their codes and changed only county",
      WIDTH,
    );
    // A 2021 vintage is drawn on 2020 tracts, so no tract change is named.
    expect(hintOf(result)).not.toContain('census tracts as drawn');
  });

  it('census_query_data: a tract GEOID in a planning region on 2021 names the earlier counties', async () => {
    connecticut();

    const result = await runToolContract(censusQueryData, {
      variables: ['B01003_001E'],
      geography_level: 'tract',
      geography_fips: '09190010101',
      year: 2021,
    });

    expectBoundaryHint(
      result,
      `Connecticut's county 190 is among the nine planning regions (110–190) that vintages from 2022 publish; acs/acs5 (2021) publishes the eight counties from before 2022 (001–015) in their place. Tracts and county subdivisions kept their codes and changed only county: at either level, geography_fips "*" with county_fips "*" and parent_fips "09" lists each under the county this vintage publishes it in.`,
      WIDTH,
    );
  });

  it('census_query_data: a Connecticut county list names only the code of the other scheme', async () => {
    connecticut();

    const result = await runToolContract(censusQueryData, ctCounty(2021, '001,190'));

    expect(result.isError).not.toBe(true);
    const notice = structured(result).notice ?? '';
    expect(notice).toContain(
      "No row came back for 1 of the 2 geography_fips codes: 190. Connecticut's county 190 is among the nine planning regions",
    );
    expect(readNotice(result)).toBe(notice);
  });

  it('census_compare_geographies: a planning-region within_county on 2021 names the earlier counties', async () => {
    connecticut();

    const result = await runToolContract(censusCompareGeographies, {
      variables: ['B01003_001E'],
      geography_level: 'tract',
      within: '09',
      within_county: '190',
      year: 2021,
    });

    expectBoundaryHint(
      result,
      'Tracts and county subdivisions kept their codes and changed only county: within_county "*" with within "09", and no geographies, lists each under the county this vintage publishes it in.',
      'Confirm tract is supported',
    );
  });

  it.each([
    ['GEOID', '09001'],
    ['bare code within "09"', '001'],
  ])(
    'census_compare_geographies: a pre-2022 county %s on 2022 names the planning regions',
    async (_label, entry) => {
      connecticut();

      const result = await runToolContract(censusCompareGeographies, {
        variables: ['B01003_001E'],
        geography_level: 'county',
        within: '09',
        geographies: [entry],
        year: 2022,
      });

      expectBoundaryHint(
        result,
        'Connecticut\'s county 001 is among the eight counties from before 2022 (001–015); acs/acs5 (2022) publishes the nine planning regions (110–190) that replaced them. Omitting geographies at the county level with within "09" lists them.',
        GEOID_GUIDANCE,
      );
    },
  );

  /**
   * Below the county level a GEOID carries its county after the state, at a width set by the level.
   * Greenwich town (county subdivision 33620) sits in Fairfield County (001) on 2021 and in the
   * Western Connecticut planning region (190) from 2022.
   */
  it.each([
    ['county subdivision', '0919033620', ['09', '001', '33620']],
    ['tract', '09190010101', ['09', '001', '010101']],
    ['block group', '091900101011', ['09', '001', '010101', '1']],
  ])(
    'census_compare_geographies: a %s GEOID under a planning region on 2021 names the earlier counties',
    async (level, entry, published) => {
      servePublished('acs/acs5', 2021, [published]);

      const result = await runToolContract(censusCompareGeographies, {
        variables: ['B01003_001E'],
        geography_level: level,
        within: '09',
        within_county: '*',
        geographies: [entry],
        year: 2021,
      });

      expectBoundaryHint(
        result,
        'Connecticut\'s county 190 is among the nine planning regions (110–190) that vintages from 2022 publish; acs/acs5 (2021) publishes the eight counties from before 2022 (001–015) in their place. Tracts and county subdivisions kept their codes and changed only county: within_county "*" with within "09", and no geographies, lists each under the county this vintage publishes it in.',
        GEOID_GUIDANCE,
      );
    },
  );

  it.each([
    [2021, '001'],
    [2022, '190'],
  ])(
    'census_query_data names no scheme change for a county in the scheme %i publishes (%s)',
    async (year, code) => {
      connecticut();

      const result = await runToolContract(censusQueryData, ctCounty(year, `${code},999`));

      expect(result.isError).not.toBe(true);
      expect(structured(result).notice).toContain('No row came back for 1 of the 2');
      expect(structured(result).notice).not.toContain('planning regions');
    },
  );

  it('census_query_data describes the boundary guidance its notice can carry', () => {
    expect(censusQueryData.enrichment?.notice.description).toContain(
      'for a list of tracts on a vintage before 2020 or of Connecticut counties in the other county scheme, which boundaries that vintage publishes',
    );
  });

  /**
   * The Census API matches a level name regardless of case, so "Tract" and "County" reach the rows
   * "tract" and "county" do; the guidance keyed on the level follows them, and the request carries
   * the level as geography.json names it.
   */
  it.each([
    ['Tract', {}, `${TRACT_2010}. ${QUERY_LISTING}`, 'tract:007101'],
    [
      'Block Group',
      { geography_fips: '2', tract_fips: '007101' },
      `${TRACT_2010}, along with its block groups. ${QUERY_LISTING}`,
      'block group:2',
    ],
  ])(
    'census_query_data: geography_level %j on 2019 names the 2010 tracts',
    async (level, extra, boundary, request) => {
      king2019();

      const result = await runToolContract(
        censusQueryData,
        kingTract({ geography_level: level, ...extra }),
      );

      expectBoundaryHint(result, boundary, WIDTH);
      expect(dataCalls('acs/acs5', 2019).map((url) => url.searchParams.get('for'))).toEqual([
        request,
      ]);
    },
  );

  it('census_query_data: geography_level "County" names the scheme change for a Connecticut county', async () => {
    connecticut();

    const result = await runToolContract(censusQueryData, {
      ...ctCounty(2021, '190'),
      geography_level: 'County',
    });

    expectBoundaryHint(
      result,
      `Connecticut's county 190 is among the nine planning regions (110–190) that vintages from 2022 publish; acs/acs5 (2021) publishes the eight counties from before 2022 (001–015) in their place. geography_fips "*" at the county level with parent_fips "09" lists them.`,
      WIDTH,
    );
  });

  it('census_query_data: a " County " list names the scheme change for its unmatched code', async () => {
    connecticut();

    const result = await runToolContract(censusQueryData, {
      ...ctCounty(2021, '001,190'),
      geography_level: ' County ',
    });

    expect(result.isError).not.toBe(true);
    const notice = structured(result).notice ?? '';
    expect(notice).toContain(
      "No row came back for 1 of the 2 geography_fips codes: 190. Connecticut's county 190 is among the nine planning regions",
    );
    expect(readNotice(result)).toBe(notice);
  });

  it('census_compare_geographies: geography_level "Tract" names the 2010 tracts for an unmatched tract', async () => {
    king2019();

    const result = await runToolContract(censusCompareGeographies, {
      variables: ['B01003_001E'],
      geography_level: 'Tract',
      within: '53',
      within_county: '033',
      geographies: ['53033007101'],
      year: 2019,
    });

    expectBoundaryHint(
      result,
      `${TRACT_2010}. Omitting geographies, with the same within and within_county, lists every tract this vintage publishes, each GEOID carrying its tract.`,
      GEOID_GUIDANCE,
    );
  });

  it('census_compare_geographies: geography_level "Tract" is sent as geography.json names it', async () => {
    king2019();

    const result = await runToolContract(censusCompareGeographies, {
      variables: ['B01003_001E'],
      geography_level: 'Tract',
      within: '53',
      within_county: '033',
      year: 2019,
    });

    expect(result.isError).not.toBe(true);
    expect(dataCalls('acs/acs5', 2019).map((url) => url.searchParams.get('for'))).toEqual([
      'tract:*',
    ]);
  });

  it('census_compare_geographies: geography_level "Block Group" names the 2010 tracts for an unmatched block group GEOID', async () => {
    king2019();

    const result = await runToolContract(censusCompareGeographies, {
      variables: ['B01003_001E'],
      geography_level: 'Block Group',
      within: '53',
      within_county: '033',
      geographies: ['530330071012'],
      year: 2019,
    });

    expectBoundaryHint(result, `${TRACT_2010}, along with its block groups.`, GEOID_GUIDANCE);
  });

  it('census_compare_geographies: geography_level "County" names the planning regions for a pre-2022 county', async () => {
    connecticut();

    const result = await runToolContract(censusCompareGeographies, {
      variables: ['B01003_001E'],
      geography_level: 'County',
      within: '09',
      geographies: ['001'],
      year: 2022,
    });

    expectBoundaryHint(
      result,
      'Connecticut\'s county 001 is among the eight counties from before 2022 (001–015); acs/acs5 (2022) publishes the nine planning regions (110–190) that replaced them. Omitting geographies at the county level with within "09" lists them.',
      GEOID_GUIDANCE,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// #100 — a full GEOID in geography_fips is read as its parents and its level code
// ---------------------------------------------------------------------------------------------

/**
 * Modelled on api.census.gov answers to acs/acs5 2021 and 2022 probed on 2026-11-26: each `for=`
 * member is matched literally against the level's own code, so a full GEOID ("53053" at county)
 * matches nothing, alone (HTTP 204) or in a list (left out), and every row carries its parent
 * columns ahead of the level's own. The levels take the parents and wildcards the 2022
 * geography.json lists. Codes and names are the published ones; only Pierce County's population
 * (918,993) is the published figure, the rest are the fixture's own.
 */
describe('a full GEOID in geography_fips is read as its parents and its level code (#100)', () => {
  const PARENT_COLUMNS: Readonly<Record<string, string[]>> = {
    county: ['state'],
    place: ['state'],
    'state legislative district (upper chamber)': ['state'],
    tract: ['state', 'county'],
    'block group': ['state', 'county', 'tract'],
    'zip code tabulation area': [],
  };

  /** A published geography: its level, its codes from the state down, its name, its population. */
  type Published = [level: string, codes: string[], name: string, population: string];
  const PUBLISHED_2022: Published[] = [
    ['county', ['06', '037'], 'Los Angeles County, California', '9800'],
    ['county', ['29', '213'], 'Taney County, Missouri', '5600'],
    ['county', ['53', '033'], 'King County, Washington', '2200'],
    ['county', ['53', '053'], 'Pierce County, Washington', '918993'],
    ['county', ['53', '061'], 'Snohomish County, Washington', '8200'],
    ['place', ['53', '53545'], 'Pasco city, Washington', '7700'],
    ['tract', ['29', '213', '480108'], 'Census Tract 4801.08; Taney County; Missouri', '4100'],
    ['tract', ['53', '033', '007101'], 'Census Tract 71.01; King County; Washington', '3700'],
    [
      'block group',
      ['53', '033', '007101', '1'],
      'Block Group 1; Census Tract 71.01; King County; Washington',
      '1200',
    ],
  ];
  /** acs/acs5 2021 publishes Connecticut's eight counties, so planning region 110 has no row. */
  const PUBLISHED_2021: Published[] = [
    ['county', ['09', '001'], 'Fairfield County, Connecticut', '9500'],
    ['county', ['09', '003'], 'Hartford County, Connecticut', '8900'],
  ];

  const serveYear = (year: number, published: Published[]) => {
    routes.push(
      {
        match: (u) => u.pathname === `${at('acs/acs5', year)}/variables.json`,
        respond: () => ({ variables: acsVariables }),
      },
      {
        match: (u) => u.pathname === `${at('acs/acs5', year)}/geography.json`,
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
              name: 'place',
              geoLevelDisplay: '160',
              requires: ['state'],
              wildcard: ['state'],
              optionalWithWCFor: 'state',
            },
            {
              name: 'state legislative district (upper chamber)',
              geoLevelDisplay: '610',
              requires: ['state'],
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
            { name: 'zip code tabulation area', geoLevelDisplay: '860' },
          ],
        }),
      },
    );
    serveData('acs/acs5', year, (url) => {
      const get = getList(url);
      const [level = '', target = ''] = (url.searchParams.get('for') ?? '').split(':');
      const parents = PARENT_COLUMNS[level] ?? [];
      const scope = (url.searchParams.get('in') ?? '').split(' ').filter(Boolean);
      const targets = target.split(',').map((member) => member.trim());
      const rows = published.filter(
        ([rowLevel, codes]) =>
          rowLevel === level &&
          scope.every((part) => {
            const [column = '', code] = part.split(':');
            return code === '*' || code === codes[parents.indexOf(column)];
          }) &&
          (target === '*' || targets.includes(codes.at(-1) ?? '')),
      );
      if (rows.length === 0) return new Response(null, { status: 204 });
      return [
        [...get, ...parents, level],
        ...rows.map(([, codes, name, population]) => [
          ...get.map((column) => (column === 'NAME' ? name : population)),
          ...codes,
        ]),
      ];
    });
  };

  beforeEach(() => {
    serveYear(2022, PUBLISHED_2022);
    serveYear(2021, PUBLISHED_2021);
  });

  const query = (
    geography_level: string,
    geography_fips: string,
    extra: Record<string, unknown> = {},
  ) =>
    runToolContract(censusQueryData, {
      variables: ['B01003_001E'],
      year: 2022,
      geography_level,
      geography_fips,
      ...extra,
    });

  /** The `for` and `in` clauses of each data request that went out. */
  const sent = (year = 2022) =>
    dataCalls('acs/acs5', year).map((url) => [
      url.searchParams.get('for'),
      url.searchParams.get('in'),
    ]);

  const namesOf = (result: { structuredContent?: unknown }) =>
    structured(result).rows.map((row) => row.geography_name);

  const hintOf = (result: { structuredContent?: unknown }) =>
    (errorOf(result).data.recovery as { hint: string }).hint;

  /** content[]'s Recovery paragraph, read back with each code span's text in place of its marker. */
  const recoveryShown = (result: { content: Array<{ type: string; text?: string }> }) =>
    readParagraphs(textOf(result))
      .find((p) => p.startsWith('Recovery: '))
      ?.slice('Recovery: '.length)
      .replace(/«code_inline:([^»]*)»/g, '$1');

  it.each([
    ['county', '053', { parent_fips: '53' }, 'state:53', ['Pierce County, Washington']],
    [
      'county',
      '*',
      { parent_fips: '53' },
      'state:53',
      ['King County, Washington', 'Pierce County, Washington', 'Snohomish County, Washington'],
    ],
    ['place', '53545', { parent_fips: '53' }, 'state:53', ['Pasco city, Washington']],
  ])(
    'sends %s %j as written and returns its rows (characterization)',
    async (level, fips, extra, scope, names) => {
      const result = await query(level, fips, extra);

      expect(sent()).toEqual([[`${level}:${fips}`, scope]]);
      expect(namesOf(result)).toEqual(names);
    },
  );

  it.each([
    ['county', '51', { parent_fips: '53' }, 'state:53'],
    ['county', '53053', { parent_fips: '*' }, 'state:*'],
    ['zip code tabulation area', '5398109', {}, null],
    ['state legislative district (upper chamber)', '53001', { parent_fips: '53' }, 'state:53'],
  ])(
    'sends %s %j as written and finds no row (characterization)',
    async (level, fips, extra, scope) => {
      const result = await query(level, fips, extra);

      expect(sent()).toEqual([[`${level}:${fips}`, scope]]);
      expect(errorOf(result).data.reason).toBe('no_data');
      expect(hintOf(result)).toContain('a county is "051", not "51"');
      expect(hintOf(result)).not.toContain('is a GEOID in');
    },
  );

  it.each([
    ['zip code tabulation area', '5398109', {}],
    ['state legislative district (upper chamber)', '53001', { parent_fips: '53' }],
  ])(
    'adds no GEOID form to the no_data hint of %s, a level the reading leaves alone (characterization)',
    async (level, fips, extra) => {
      const result = await query(level, fips, extra);

      expect(hintOf(result)).not.toContain('GEOID');
    },
  );

  it('keeps "53053,061" with no parent_fips parent_required, unchanged (characterization)', async () => {
    const result = await query('county', '53053,061');

    expect(errorOf(result).data).toMatchObject({
      reason: 'parent_required',
      missingParents: ['state'],
    });
    expect(hintOf(result)).toBe(
      'To query this level, add parent_fips (census_resolve_geography returns it as state_fips).',
    );
    expect(sent()).toEqual([]);
  });

  it('reads "53053" under parent_fips "53" as county 053 and returns Pierce County', async () => {
    const result = await query('county', '53053', { parent_fips: '53' });

    expect(result.isError).toBeFalsy();
    expect(sent()).toEqual([['county:053', 'state:53']]);
    const [row] = structured(result).rows;
    expect(row).toMatchObject({
      geography_name: 'Pierce County, Washington',
      geography_fips: '053',
      geography_geoid: '53053',
    });
    expect(row?.variables.B01003_001E?.estimate).toBe(918993);
    expect(textOf(result)).toContain('### Pierce County, Washington');
    expect(textOf(result)).toContain('918,993');
    expect(structured(result)).not.toHaveProperty('notice');
  });

  it('returns "53053,053" as Pierce County once, with no unmatched notice', async () => {
    const result = await query('county', '53053,053', { parent_fips: '53' });

    expect(sent()).toEqual([['county:053', 'state:53']]);
    expect(structured(result).rows.map((row) => row.geography_geoid)).toEqual(['53053']);
    expect(paged(result).totalCount).toBe(1);
    expect(structured(result)).not.toHaveProperty('notice');
  });

  it('reads tract "29213480108" under parent_fips "29" as tract 480108 of county 213', async () => {
    const result = await query('tract', '29213480108', { parent_fips: '29' });

    expect(sent()).toEqual([['tract:480108', 'state:29 county:213']]);
    expect(namesOf(result)).toEqual(['Census Tract 4801.08; Taney County; Missouri']);
    expect(textOf(result)).toContain('### Census Tract 4801.08; Taney County; Missouri');
  });

  it.each([
    ['county', '53053', 'county:053', 'state:53', 'Pierce County, Washington'],
    [
      'tract',
      '53033007101',
      'tract:007101',
      'state:53 county:033',
      'Census Tract 71.01; King County; Washington',
    ],
  ])(
    'reads the parents of %s %j from its prefix when no parent is given',
    async (level, fips, target, scope, name) => {
      const result = await query(level, fips);

      expect(result.isError).toBeFalsy();
      expect(sent()).toEqual([[target, scope]]);
      expect(namesOf(result)).toEqual([name]);
    },
  );

  it('reads a block group GEOID as its tract as well, under the given state and county', async () => {
    const result = await query('block group', '530330071011', {
      parent_fips: '53',
      county_fips: '033',
    });

    expect(sent()).toEqual([['block group:1', 'state:53 county:033 tract:007101']]);
    expect(namesOf(result)).toEqual(['Block Group 1; Census Tract 71.01; King County; Washington']);
  });

  it('returns two rows for "53053,061" under parent_fips "53"', async () => {
    const result = await query('county', '53053,061', { parent_fips: '53' });

    expect(sent()).toEqual([['county:053,061', 'state:53']]);
    expect(structured(result).rows.map((row) => row.geography_geoid)).toEqual(['53053', '53061']);
    expect(structured(result)).not.toHaveProperty('notice');
  });

  it('keeps "53033,06037" with no parent_fips parent_required, naming census_compare_geographies or a call per state', async () => {
    const result = await query('county', '53033,06037');

    const error = errorOf(result);
    expect(error.data).toMatchObject({ reason: 'parent_required', missingParents: ['state'] });
    expect(hintOf(result)).toBe(
      'To query this level, add parent_fips (census_resolve_geography returns it as state_fips). The geography_fips GEOIDs name more than one state (53 and 06), and one call takes one parent_fips: pass them as geographies to census_compare_geographies, or make one call per state.',
    );
    expect(recoveryShown(result)).toBe(hintOf(result));
    expect(repeatsBetween(error.message, hintOf(result))).toEqual([]);
    expect(sent()).toEqual([]);
  });

  it.each([
    [
      'county',
      '06037',
      { parent_fips: '53' },
      ['county:06037', 'state:53'],
      '"06037" is a GEOID in state 06, not parent_fips "53", so it was sent as written; query it as geography_fips "037" with parent_fips "06".',
      ['037', '06'],
    ],
    [
      'tract',
      '53033007101',
      { parent_fips: '53', county_fips: '061' },
      ['tract:53033007101', 'state:53 county:061'],
      '"53033007101" is a GEOID in county 033, not county_fips "061", so it was sent as written; query it as geography_fips "007101" with parent_fips "53" and county_fips "033".',
      ['007101', '53', '033'],
    ],
    [
      // The county is read from the GEOID, so the call to make names it beside the state.
      'tract',
      '06037007101',
      { parent_fips: '53' },
      ['tract:06037007101', 'state:53 county:037'],
      '"06037007101" is a GEOID in state 06, not parent_fips "53", so it was sent as written; query it as geography_fips "007101" with parent_fips "06" and county_fips "037".',
      ['007101', '06', '037'],
    ],
    [
      'tract',
      '06037007101',
      { parent_fips: '53', county_fips: '033' },
      ['tract:06037007101', 'state:53 county:033'],
      '"06037007101" is a GEOID in state 06 and county 037, not parent_fips "53" and county_fips "033", so it was sent as written; query it as geography_fips "007101" with parent_fips "06" and county_fips "037".',
      ['007101', '06', '037'],
    ],
  ])(
    'sends %s %j under %j, which it contradicts, as written and names the code and parents to send',
    async (level, fips, extra, request, sentence, literals) => {
      const result = await query(level, fips, extra);

      expect(sent()).toEqual([request]);
      const error = errorOf(result);
      expect(error.data.reason).toBe('no_data');
      expect(hintOf(result)).toContain(sentence);
      // The values to send back reach content[] as code spans, and the hint reads back whole.
      for (const value of literals) expect(textOf(result)).toContain(`"\`${value}\`"`);
      expect(recoveryShown(result)).toBe(hintOf(result));
      expect(repeatsBetween(error.message, hintOf(result))).toEqual([]);
    },
  );

  it('names only the contradicting member of a list, with the code and parent to send', async () => {
    const result = await query('county', '53053,06037', { parent_fips: '53' });

    expect(sent()).toEqual([['county:053,06037', 'state:53']]);
    expect(structured(result).rows.map((row) => row.geography_geoid)).toEqual(['53053']);
    const notice = structured(result).notice as string;
    expect(notice).toBe(
      'No row came back for 1 of the 2 geography_fips codes: 06037. "06037" is a GEOID in state 06, not parent_fips "53", so it was sent as written; query it as geography_fips "037" with parent_fips "06". The Census API matches each code literally, width and case included, and leaves out one it publishes nothing for in this query, so check each against the codes that did come back, such as "053" or its full GEOID "53053".',
    );
    expect(readNotice(result)).toBe(notice);
  });

  it('judges GEOID members against every matched row, not the page', async () => {
    const result = await query('county', '53053,53061', { parent_fips: '53', limit: 1, offset: 1 });

    expect(sent()).toEqual([['county:053,061', 'state:53']]);
    expect(structured(result).rows.map((row) => row.geography_geoid)).toEqual(['53061']);
    expect(paged(result).totalCount).toBe(2);
    const notice = structured(result).notice as string;
    expect(notice).toContain('Rows 2–2 of 2');
    expect(notice).not.toContain('geography_fips codes');
  });

  it('offers no parent_fips narrowing for a page whose state the GEOIDs supplied', async () => {
    const result = await query('county', '53033,53053,53061', { limit: 1 });

    expect(sent()).toEqual([['county:033,053,061', 'state:53']]);
    expect(structured(result).notice).toBe(
      'Rows 1–1 of 3, in GEOID order — not a ranking or a sample. To see more, call again with offset: 1 for the next page, raise limit (max 500), or use census_compare_geographies to rank rather than list.',
    );
  });

  it('names the levels a GEOID is read at, and how it is read, in the geography_fips description', () => {
    const description = censusQueryData.input.shape.geography_fips.description;

    expect(description).toContain(
      'A full GEOID, as geography_geoid returns it, is also accepted at the levels whose GEOID carries its parents (county, place, school district (unified), economic place, congressional district, county subdivision, tract, block group, and block): it is read as those parents and the level code, so "53053" is county "053" with parent_fips "53".',
    );
    expect(description).toContain(
      'The parents it carries can be omitted when every listed code names the same ones, and must match it when given — a GEOID naming another parent is sent as written and returns no row.',
    );
  });

  it('quotes an unmatched GEOID member as the caller wrote it, not as it was sent', async () => {
    const result = await query('county', '53053,53099', { parent_fips: '53' });

    expect(sent()).toEqual([['county:053,099', 'state:53']]);
    const notice = structured(result).notice as string;
    expect(notice).toContain('No row came back for 1 of the 2 geography_fips codes: 53099.');
    expect(notice).not.toContain('is a GEOID in');
  });

  it.each([
    [
      'county',
      '51',
      { parent_fips: '53' },
      'a county is "051", not "51". A full county GEOID (5 digits) is also accepted, read as its state code plus the 3-digit county code; parent_fips can then be omitted, and must match the GEOID when given. If the level itself is in doubt',
    ],
    [
      'tract',
      '999999',
      { parent_fips: '53', county_fips: '033' },
      'a county is "051", not "51". A full tract GEOID (11 digits) is also accepted, read as its state and county codes plus the 6-digit tract code; parent_fips and county_fips can then be omitted, and must match the GEOID when given. If the level itself is in doubt',
    ],
  ])(
    'adds the %s GEOID form to the width guidance of a no_data hint',
    async (level, fips, extra, guidance) => {
      const result = await query(level, fips, extra);

      expect(errorOf(result).data.reason).toBe('no_data');
      expect(hintOf(result)).toContain(guidance);
      expect(recoveryShown(result)).toBe(hintOf(result));
    },
  );

  it('names the planning-region change for "09110" on 2021, its state read from the prefix', async () => {
    const result = await query('county', '09110', { year: 2021 });

    expect(sent(2021)).toEqual([['county:110', 'state:09']]);
    expect(errorOf(result).data.reason).toBe('no_data');
    expect(hintOf(result)).toContain(
      `Connecticut's county 110 is among the nine planning regions (110–190) that vintages from 2022 publish; acs/acs5 (2021) publishes the eight counties from before 2022 (001–015) in their place. geography_fips "*" at the county level with parent_fips "09" lists them.`,
    );
    expect(textOf(result)).toContain('"`09`"');
    expect(recoveryShown(result)).toBe(hintOf(result));
  });

  it('names the planning-region change for an unmatched "09110" in a 2021 list of GEOIDs', async () => {
    const result = await query('county', '09001,09110', { year: 2021 });

    expect(sent(2021)).toEqual([['county:001,110', 'state:09']]);
    expect(namesOf(result)).toEqual(['Fairfield County, Connecticut']);
    const notice = structured(result).notice as string;
    expect(notice).toContain(
      "No row came back for 1 of the 2 geography_fips codes: 09110. Connecticut's county 110 is among the nine planning regions",
    );
    expect(readNotice(result)).toBe(notice);
  });
});

// ---------------------------------------------------------------------------------------------
// #97 — dec/pl 2000 lists a whole-number tract by 4 digits
// ---------------------------------------------------------------------------------------------

/**
 * Modelled on api.census.gov answers probed on 2026-11-26. dec/pl 2000 lists King County's Tract 71
 * as "0071" (GEOID 530330071, PL001001 1,809) beside Tract 4.01 as "000401", and answers
 * `for=tract:007100` and blocks under `in=…tract:007100` with a 204, as it answers `tract:0004`.
 * acs/acs5 2009 and dec/pl 2010 list Tract 71 as "007100". Tract 71's and Block 1000's (87)
 * populations are the published ones; the rest are the fixture's own.
 */
describe('dec/pl 2000 reads a 6-digit whole-number tract as the 4 digits it lists (#97)', () => {
  const PARENT_COLUMNS: Readonly<Record<string, string[]>> = {
    county: ['state'],
    tract: ['state', 'county'],
    block: ['state', 'county', 'tract'],
  };
  const plVariables = {
    PL001001: { label: 'Total', concept: 'RACE', predicateType: 'int' },
  };
  const SHORTENED =
    'dec/pl (2000) lists a census tract whose 6-digit code ends in 00 by its first 4 digits, the form its rows and GEOIDs carry, so';

  /** A published geography: its level, its codes from the state down, its name, its population. */
  type Published = [level: string, codes: string[], name: string, population: string];
  const KING_2000: Published[] = [
    ['tract', ['53', '033', '000401'], 'Census Tract 4.01, King County, Washington', '4100'],
    ['tract', ['53', '033', '0071'], 'Census Tract 71, King County, Washington', '1809'],
    [
      'block',
      ['53', '033', '0071', '1000'],
      'Block 1000, Census Tract 71, King County, Washington',
      '87',
    ],
    [
      'block',
      ['53', '033', '0071', '1001'],
      'Block 1001, Census Tract 71, King County, Washington',
      '40',
    ],
  ];
  const KING_6_DIGITS: Published[] = [
    ['tract', ['53', '033', '007100'], 'Census Tract 71, King County, Washington', '2000'],
  ];

  const serve = (dataset: string, year: number, published: Published[]) => {
    routes.push(
      {
        match: (u) => u.pathname === `${at(dataset, year)}/variables.json`,
        respond: () => ({ variables: { ...acsVariables, ...plVariables } }),
      },
      {
        match: (u) => u.pathname === `${at(dataset, year)}/geography.json`,
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
              name: 'block',
              geoLevelDisplay: '100',
              requires: ['state', 'county', 'tract'],
              wildcard: ['county', 'tract'],
              optionalWithWCFor: 'tract',
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
    serveData(dataset, year, (url) => {
      const get = getList(url);
      const [level = '', target = ''] = (url.searchParams.get('for') ?? '').split(':');
      const parents = PARENT_COLUMNS[level] ?? [];
      const scope = (url.searchParams.get('in') ?? '').split(' ').filter(Boolean);
      const targets = target.split(',').map((member) => member.trim());
      const rows = published.filter(
        ([rowLevel, codes]) =>
          rowLevel === level &&
          scope.every((part) => {
            const [column = '', code] = part.split(':');
            return code === '*' || code === codes[parents.indexOf(column)];
          }) &&
          (target === '*' || targets.includes(codes.at(-1) ?? '')),
      );
      if (rows.length === 0) return new Response(null, { status: 204 });
      return [
        [...get, ...parents, level],
        ...rows.map(([, codes, name, population]) => [
          ...get.map((column) => (column === 'NAME' ? name : population)),
          ...codes,
        ]),
      ];
    });
  };

  beforeEach(() => {
    serve('dec/pl', 2000, KING_2000);
    serve('acs/acs5', 2009, KING_6_DIGITS);
    serve('dec/pl', 2010, KING_6_DIGITS);
  });

  const KING = { parent_fips: '53', county_fips: '033' };
  const query = (geography_fips: string, extra: Record<string, unknown> = {}) =>
    runToolContract(censusQueryData, {
      variables: ['PL001001'],
      dataset: 'dec/pl',
      year: 2000,
      geography_level: 'tract',
      geography_fips,
      ...extra,
    });

  /** The `for` and `in` clauses of each data request that went out. */
  const sent = (dataset = 'dec/pl', year = 2000) =>
    dataCalls(dataset, year).map((url) => [
      url.searchParams.get('for'),
      url.searchParams.get('in'),
    ]);

  const geoidsOf = (result: { structuredContent?: unknown }) =>
    structured(result).rows.map((row) => row.geography_geoid);

  const hintOf = (result: { structuredContent?: unknown }) =>
    (errorOf(result).data.recovery as { hint: string }).hint;

  /** content[]'s Recovery paragraph, read back with each code span's text in place of its marker. */
  const recoveryShown = (result: { content: Array<{ type: string; text?: string }> }) =>
    readParagraphs(textOf(result))
      .find((p) => p.startsWith('Recovery: '))
      ?.slice('Recovery: '.length)
      .replace(/«code_inline:([^»]*)»/g, '$1');

  it('sends tract "007100" as "0071" and returns Tract 71, naming the code it was read as', async () => {
    const result = await query('007100', KING);

    expect(result.isError).toBeFalsy();
    expect(sent()).toEqual([['tract:0071', 'state:53 county:033']]);
    const [row] = structured(result).rows as Array<Record<string, unknown>>;
    expect(row).toMatchObject({
      geography_name: 'Census Tract 71, King County, Washington',
      geography_fips: '0071',
      geography_geoid: '530330071',
    });
    expect(structured(result).rows[0]?.variables.PL001001?.estimate).toBe(1809);
    expect(textOf(result)).toContain('1,809');
    const notice = structured(result).notice;
    expect(notice).toBe(`${SHORTENED} "007100" was read as "0071".`);
    expect(readNotice(result)).toBe(notice);
  });

  it('sends tract_fips "007100" as "0071" and returns the blocks of Tract 71', async () => {
    const result = await query('*', { geography_level: 'block', ...KING, tract_fips: '007100' });

    expect(sent()).toEqual([['block:*', 'state:53 county:033 tract:0071']]);
    expect(structured(result).rows.map((row) => row.geography_name)).toEqual([
      'Block 1000, Census Tract 71, King County, Washington',
      'Block 1001, Census Tract 71, King County, Washington',
    ]);
    expect(structured(result).rows[0]?.variables.PL001001?.estimate).toBe(87);
    expect(structured(result).notice).toBe(`${SHORTENED} "007100" was read as "0071".`);
  });

  it('returns "0071,007100,000401" as two rows with no unmatched-code notice', async () => {
    const result = await query('0071,007100,000401', KING);

    expect(sent()).toEqual([['tract:0071,000401', 'state:53 county:033']]);
    expect(geoidsOf(result)).toEqual(['53033000401', '530330071']);
    expect(structured(result).notice).toBe(`${SHORTENED} "007100" was read as "0071".`);
  });

  it.each([
    ['tract', '53033007100', 'tract:0071', 'state:53 county:033', ['530330071'], true],
    ['tract', '530330071', 'tract:0071', 'state:53 county:033', ['530330071'], false],
    [
      'block',
      '530330071001000',
      'block:1000',
      'state:53 county:033 tract:0071',
      ['5303300711000'],
      true,
    ],
    [
      'block',
      '5303300711000',
      'block:1000',
      'state:53 county:033 tract:0071',
      ['5303300711000'],
      false,
    ],
  ])(
    'reads the %s GEOID %j, with no parent given, as %j under %j',
    async (level, fips, target, scope, geoids, noticed) => {
      const result = await query(fips, { geography_level: level });

      expect(result.isError).toBeFalsy();
      expect(sent()).toEqual([[target, scope]]);
      expect(geoidsOf(result)).toEqual(geoids);
      expect(structured(result).notice).toBe(
        noticed ? `${SHORTENED} "007100" was read as "0071".` : undefined,
      );
    },
  );

  it.each([
    ['0071', 'tract:0071'],
    ['000401', 'tract:000401'],
  ])('sends %j as written and returns its row with no notice', async (fips, target) => {
    const result = await query(fips, KING);

    expect(sent()).toEqual([[target, 'state:53 county:033']]);
    expect(geoidsOf(result)).toHaveLength(1);
    expect(structured(result)).not.toHaveProperty('notice');
  });

  it('keeps "0004" no_data, sent as written, with no shortened code named', async () => {
    const result = await query('0004', KING);

    expect(sent()).toEqual([['tract:0004', 'state:53 county:033']]);
    expect(errorOf(result).data.reason).toBe('no_data');
    // The whole hint, so a 4-digit code that gained a shortened-code sentence, or lost the
    // boundary-vintage cause ahead of the width guidance, fails here.
    expect(hintOf(result)).toBe(
      'dec/pl (2000) publishes census tracts as drawn for the 2000 Census, not the 2020 tracts census_resolve_geography returns — the 2020 Census split, merged, or renumbered many of them, so a 2020 tract code can be missing here. geography_fips "*" at geography_level "tract", with the same parent_fips and county_fips, lists the tracts this vintage publishes. Confirm the FIPS codes exist in dec/pl (2000) — census_resolve_geography returns them for a place name. The Census API matches geography_fips literally at the width of its level, so a short code finds nothing: a county is "051", not "51". A full tract GEOID (11 digits, or 9 with a whole-number tract in the 4 digits dec/pl (2000) lists it by) is also accepted, read as its state and county codes plus the 6-digit tract code; parent_fips and county_fips can then be omitted, and must match the GEOID when given. If the level itself is in doubt, call census_list_geographies.',
    );
  });

  it.each([
    ['acs/acs5', 2009],
    ['dec/pl', 2010],
  ])('sends "007100" on %s %i as written', async (dataset, year) => {
    const result = await query('007100', { dataset, year, ...KING });

    expect(sent(dataset, year)).toEqual([['tract:007100', 'state:53 county:033']]);
    expect(geoidsOf(result)).toEqual(['53033007100']);
    expect(structured(result)).not.toHaveProperty('notice');
  });

  it('names the 4-digit code a 6-digit code it lists in neither form was sent as, beside the boundary-vintage hint', async () => {
    const result = await query('999900', KING);

    expect(sent()).toEqual([['tract:9999', 'state:53 county:033']]);
    const error = errorOf(result);
    expect(error.data.reason).toBe('no_data');
    const hint = hintOf(result);
    expect(hint).toContain(
      `${SHORTENED} "999900" was read as "9999". dec/pl (2000) publishes census tracts as drawn for the 2000 Census`,
    );
    expect(hint.indexOf('Confirm the FIPS codes exist in')).toBeGreaterThan(
      hint.indexOf('drawn for the 2000 Census'),
    );
    expect(recoveryShown(result)).toBe(hint);
    expect(repeatsBetween(error.message, hint)).toEqual([]);
  });

  it('offers the 9-digit tract GEOID dec/pl 2000 carries beside the 11-digit one in a no_data hint', async () => {
    const result = await query('999900', KING);

    expect(hintOf(result)).toContain(
      'A full tract GEOID (11 digits, or 9 with a whole-number tract in the 4 digits dec/pl (2000) lists it by) is also accepted',
    );
  });

  it('names a block GEOID in another tract than tract_fips with the 6-digit tract_fips to send', async () => {
    const result = await query('5303300721000', {
      geography_level: 'block',
      ...KING,
      tract_fips: '007100',
    });

    expect(sent()).toEqual([['block:5303300721000', 'state:53 county:033 tract:0071']]);
    expect(errorOf(result).data.reason).toBe('no_data');
    expect(hintOf(result)).toContain(
      '"5303300721000" is a GEOID in tract 007200, not tract_fips "007100", so it was sent as written; query it as geography_fips "1000" with parent_fips "53", county_fips "033", and tract_fips "007200".',
    );
    // The tract to send back reaches content[] as a code span, and the hint reads back whole.
    expect(textOf(result)).toContain('"`007200`"');
    expect(recoveryShown(result)).toBe(hintOf(result));
  });

  const compare = (input: Record<string, unknown>) =>
    runToolContract(censusCompareGeographies, {
      variables: ['PL001001'],
      dataset: 'dec/pl',
      year: 2000,
      geography_level: 'tract',
      within: '53',
      within_county: '033',
      ...input,
    });

  it.each([['53033007100'], ['007100']])(
    'census_compare_geographies matches Tract 71 for [%j], naming the form it was read as',
    async (entry) => {
      const result = await compare({ geographies: [entry] });

      expect(result.isError).toBeFalsy();
      expect(geoidsOf(result)).toEqual(['530330071']);
      const notice = structured(result).notice;
      expect(notice).toBe(
        `${SHORTENED} "${entry}" was read as "${entry === '007100' ? '0071' : '530330071'}".`,
      );
      expect(readNotice(result)).toBe(notice);
    },
  );

  it('census_compare_geographies matches "530330071" and "000401" as written, with no notice', async () => {
    const result = await compare({ geographies: ['530330071', '000401'] });

    // Ranked by PL001001, highest first.
    expect(geoidsOf(result)).toEqual(['53033000401', '530330071']);
    expect(structured(result)).not.toHaveProperty('notice');
  });

  it('census_compare_geographies names an entry it read in neither listed form as unmatched, as written', async () => {
    const result = await compare({ geographies: ['53033007100', '53033999900'] });

    expect(geoidsOf(result)).toEqual(['530330071']);
    const notice = structured(result).notice ?? '';
    expect(notice).toContain(
      `${SHORTENED} "53033007100" was read as "530330071" and "53033999900" was read as "530339999".`,
    );
    expect(notice).toContain('No tract matched 1 of the requested geographies: 53033999900.');
    expect(readNotice(result)).toBe(notice);
  });

  it('census_compare_geographies names the form a lone unmatched entry was read as in its no_data hint', async () => {
    const result = await compare({ geographies: ['53033999900'] });

    const error = errorOf(result);
    expect(error.data).toMatchObject({ reason: 'no_data', unmatchedGeographies: ['53033999900'] });
    expect(error.message).toBe(
      'None of the 1 requested geographies matched a tract in dec/pl (2000): 53033999900.',
    );
    const hint = hintOf(result);
    expect(hint).toContain(
      `${SHORTENED} "53033999900" was read as "530339999". dec/pl (2000) publishes census tracts as drawn for the 2000 Census`,
    );
    expect(recoveryShown(result)).toBe(hint);
  });

  it('census_compare_geographies matches "53033007100" on acs/acs5 2009 as written', async () => {
    const result = await compare({ dataset: 'acs/acs5', year: 2009, geographies: ['53033007100'] });

    expect(geoidsOf(result)).toEqual(['53033007100']);
    expect(structured(result)).not.toHaveProperty('notice');
  });

  it.each([
    [
      'census_query_data geography_fips',
      censusQueryData.input.shape.geography_fips.description,
      'except that dec/pl 2000 lists a tract whose code ends in 00 by its first 4 digits ("0071" for Tract 71), so on dec/pl 2000 such a 6-digit code is sent in that form and the notice says so.',
    ],
    [
      'census_query_data geography_fips',
      censusQueryData.input.shape.geography_fips.description,
      'On dec/pl 2000 a tract or block GEOID carrying a 4-digit tract (9 or 13 digits) is read the same way.',
    ],
    [
      'census_query_data tract_fips',
      censusQueryData.input.shape.tract_fips.description,
      'dec/pl 2000 lists a tract whose code ends in 00 by its first 4 digits, so there such a code is sent in that form ("007100" as "0071") and the notice says so.',
    ],
    [
      'census_compare_geographies geographies',
      censusCompareGeographies.input.shape.geographies.description,
      'dec/pl 2000 lists a tract whose code ends in 00 by its first 4 digits (Tract 71 is "0071", GEOID "530330071"), so there an entry carrying such a tract in 6 digits ("007100", "53033007100") matches it, and the notice names the form it was read as.',
    ],
  ])(
    '%s describes the 4-digit form dec/pl 2000 lists a tract by',
    (_field, description, sentence) => {
      expect(description).toContain(sentence);
    },
  );
});

// ---------------------------------------------------------------------------------------------
// #88 — a whole table through group(<ID>)
// ---------------------------------------------------------------------------------------------

/**
 * census_query_data's `group` input, end to end through the real services. The data endpoint lays
 * a response out as api.census.gov does (2024 vintages, captured 2026-11-15): `NAME` and the codes
 * named one by one, then every column of the table in its own order, then the geography.
 */
describe('census_query_data reads a whole table through group (#88)', () => {
  /** Two lines of acs/acs5 B01001; GEO_ID is filed under every table and NAME is its attribute. */
  const groupAcsVariables = {
    ...acsVariables,
    B01001_002E: {
      label: 'Estimate!!Total:!!Male:',
      concept: 'Sex by Age',
      predicateType: 'int',
      group: 'B01001',
      attributes: 'B01001_002EA,B01001_002M,B01001_002MA',
    },
    B01001_001E: {
      label: 'Estimate!!Total:',
      concept: 'Sex by Age',
      predicateType: 'int',
      group: 'B01001',
      attributes: 'B01001_001EA,B01001_001M,B01001_001MA',
    },
    GEO_ID: {
      label: 'Geography',
      predicateType: 'string',
      group: 'B19013,B01001',
      attributes: 'NAME',
    },
  };

  /** Each table as `group(<ID>)` lays it out. */
  const tables: Record<string, readonly string[]> = {
    B01001: [
      'B01001_001E',
      'B01001_001EA',
      'B01001_001M',
      'B01001_001MA',
      'B01001_002E',
      'B01001_002EA',
      'B01001_002M',
      'B01001_002MA',
      'GEO_ID',
      'NAME',
    ],
    DP05: [
      'DP05_0001E',
      'DP05_0001EA',
      'DP05_0001M',
      'DP05_0001MA',
      'DP05_0001PE',
      'DP05_0001PEA',
      'DP05_0001PM',
      'DP05_0001PMA',
      'GEO_ID',
      'NAME',
    ],
    CP03: [
      'CP03_2019_001E',
      'CP03_2019_001EA',
      'CP03_2024to2019_001SS',
      'CP03_2024_001E',
      'CP03_2024_001EA',
      'GEO_ID',
      'NAME',
    ],
    P1: ['GEO_ID', 'NAME', 'P1_001N', 'P1_001NA', 'P1_002N', 'P1_002NA'],
  };

  const cells: Record<string, string> = {
    B19013_001E: '122148',
    B19013_001M: '1808',
    B01001_001E: '2287171',
    B01001_001M: '-555555555',
    B01001_002E: '1140843',
    B01001_002M: '1234',
    DP05_0001E: '7785786',
    DP05_0001M: '-555555555',
    DP05_0001PE: '7785786',
    DP05_0001PM: '-888888888',
    CP03_2019_001E: '6100000',
    CP03_2024to2019_001SS: '*',
    CP03_2024_001E: '6300000',
    P1_001N: '7705281',
    P1_002N: '7101093',
  };

  /** Answer as api.census.gov does, for one geography whose columns `geography` gives. */
  const answerGroup =
    (geography: Record<string, string>, name = 'King County, Washington') =>
    (url: URL): Body => {
      const items = getList(url);
      const token = items.find((item) => item.startsWith('group('));
      const header = [
        ...items.filter((item) => item !== token),
        ...(token ? (tables[token.slice('group('.length, -1)] ?? []) : []),
        ...Object.keys(geography),
      ];
      return [
        header,
        header.map(
          (column) =>
            geography[column] ??
            cells[column] ??
            (column === 'NAME' ? name : column === 'GEO_ID' ? `0500000US53033` : null),
        ) as string[],
      ];
    };

  const atKing = { geography_level: 'county', geography_fips: '033', parent_fips: '53' };
  const kingGeography = { state: '53', county: '033' };

  /** Pins the request a call without group sends — the regression the feature must not move. */
  it('sends the same get= and returns the same row without group (characterization)', async () => {
    serveMetadata('acs/acs5', 2024, groupAcsVariables);
    serveData('acs/acs5', 2024, answerGroup(kingGeography));

    const result = await runToolContract(censusQueryData, {
      ...atKing,
      variables: ['b19013_001e', 'B19013_001M'],
    });

    expect(getList(dataCalls('acs/acs5', 2024)[0])).toEqual(['NAME', 'B19013_001E', 'B19013_001M']);
    expect(structured(result).rows).toEqual([
      {
        geography_name: 'King County, Washington',
        geography_fips: '033',
        geography_geoid: '53033',
        variables: {
          B19013_001E: { estimate: 122148, moe: 1808, suppressed: false },
          B19013_001M: { estimate: 1808, suppressed: false },
        },
      },
    ]);
  });

  /** Sent as a code, it went out as `GROUP(B01001)`, which api.census.gov answers 204. */
  it('sends a group(<ID>) entry of variables as the table, in the dataset spelling', async () => {
    serveMetadata('acs/acs5', 2024, groupAcsVariables);
    serveData('acs/acs5', 2024, answerGroup(kingGeography));

    const result = await runToolContract(censusQueryData, {
      ...atKing,
      variables: ['group(b01001)'],
    });

    expect(result.isError).toBeFalsy();
    expect(getList(dataCalls('acs/acs5', 2024)[0])).toEqual(['NAME', 'group(B01001)']);
  });

  it('returns the table E/M-paired without annotations, its GEOID free of table columns', async () => {
    serveMetadata('acs/acs5', 2024, groupAcsVariables);
    serveData('acs/acs5', 2024, answerGroup(kingGeography));

    const result = await runToolContract(censusQueryData, { ...atKing, group: 'b01001' });
    const out = structured(result);

    expect(out.rows).toHaveLength(1);
    const row = out.rows[0];
    expect(row?.geography_geoid).toBe('53033');
    expect(Object.keys(row?.variables ?? {})).toEqual([
      'B01001_001E',
      'B01001_001M',
      'B01001_002E',
      'B01001_002M',
    ]);
    expect(row?.variables.B01001_001E).toEqual({ estimate: 2287171, moe: 0, suppressed: false });
    expect(row?.variables.B01001_002E).toEqual({ estimate: 1140843, moe: 1234, suppressed: false });
    expect(out.variable_labels).toEqual({
      B01001_001E: 'Estimate!!Total:',
      B01001_001M: 'Margin of Error!!Total:',
      B01001_002E: 'Estimate!!Total:!!Male:',
      B01001_002M: 'Margin of Error!!Total:!!Male:',
    });

    // content[] carries the same columns, labels, and numbers.
    const text = textOf(result);
    expect(readVariableLabels(text)).toEqual(out.variable_labels);
    expect(text).toContain('**GEOID:** `53033`');
    expect(text).toContain('- **B01001_001E:** 2,287,171 ± 0');
    expect(text).toContain('- **B01001_002E:** 1,140,843 ± 1,234');
    expect(text).toContain('- **B01001_002M:** 1,234');
    expect(text).not.toContain('B01001_001EA');
  });

  it('keys the listed codes first and sends a code the table returns only once', async () => {
    serveMetadata('acs/acs5', 2024, groupAcsVariables);
    serveData('acs/acs5', 2024, answerGroup(kingGeography));

    const result = await runToolContract(censusQueryData, {
      ...atKing,
      variables: ['B19013_001E', 'B01001_001E'],
      group: 'B01001',
    });

    expect(getList(dataCalls('acs/acs5', 2024)[0])).toEqual([
      'NAME',
      'B19013_001E',
      'group(B01001)',
    ]);
    const out = structured(result);
    expect(Object.keys(out.rows[0]?.variables ?? {})).toEqual([
      'B19013_001E',
      'B01001_001E',
      'B01001_001M',
      'B01001_002E',
      'B01001_002M',
    ]);
    expect(Object.keys(out.variable_labels)).toEqual([
      'B19013_001E',
      'B01001_001E',
      'B01001_001M',
      'B01001_002E',
      'B01001_002M',
    ]);
  });

  it.each([
    [
      'acs/acs5/profile',
      'DP05',
      {
        DP05_0001E: { estimate: 7785786, moe: 0, suppressed: false },
        DP05_0001M: { estimate: 0, suppressed: false },
        DP05_0001PE: { estimate: 7785786, moe: null, suppressed: false },
        DP05_0001PM: {
          estimate: null,
          suppressed: true,
          suppression_reason: 'Not applicable or not available',
        },
      },
    ],
    [
      'acs/acs5/cprofile',
      'CP03',
      {
        CP03_2019_001E: { estimate: 6100000, suppressed: false },
        CP03_2024to2019_001SS: { estimate: null, suppressed: false, value: '*' },
        CP03_2024_001E: { estimate: 6300000, suppressed: false },
      },
    ],
    [
      'dec/pl',
      'P1',
      {
        P1_001N: { estimate: 7705281, suppressed: false },
        P1_002N: { estimate: 7101093, suppressed: false },
      },
    ],
  ])('keys each column family %s publishes in %s', async (dataset, table, expected) => {
    const year = dataset === 'dec/pl' ? 2020 : 2024;
    const columns = tables[table] ?? [];
    // variables.json for the table: each member with the attribute columns that follow it.
    const isAttribute = (column: string) =>
      column === 'NAME' ||
      /(?:\d+M|PM|SS)$/.test(column) ||
      (column.endsWith('A') && columns.includes(column.slice(0, -1)));
    const members: Array<[string, string[]]> = [];
    for (const column of columns) {
      if (isAttribute(column)) members.at(-1)?.[1].push(column);
      else members.push([column, []]);
    }
    const variables = Object.fromEntries(
      members.map(([code, attributes]) => [
        code,
        {
          label: `Label of ${code}`,
          predicateType: code === 'GEO_ID' ? 'string' : 'int',
          group: table,
          attributes: attributes.join(','),
        },
      ]),
    );
    serveMetadata(dataset, year, variables);
    serveData(dataset, year, answerGroup({ state: '53' }, 'Washington'));

    const result = await runToolContract(censusQueryData, {
      dataset,
      year,
      group: table,
      geography_level: 'state',
      geography_fips: '53',
    });

    expect(result.isError).toBeFalsy();
    const row = structured(result).rows[0];
    expect(row?.variables).toEqual(expected);
    expect(Object.keys(row?.variables ?? {})).toEqual(Object.keys(expected));
    expect(row?.geography_geoid).toBe('53');
  });

  it('fails an unknown table before any data request, naming search', async () => {
    serveMetadata('acs/acs5', 2024, groupAcsVariables);
    routes.push({
      match: (u) => u.pathname === '/data/2024/acs/acs1/groups/B99999.json',
      respond: () => new Response('Not Found', { status: 404 }),
    });

    const result = await runToolContract(censusQueryData, { ...atKing, group: 'B99999' });

    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: 'Table B99999 not found in acs/acs5 (2024).',
      data: { reason: 'variable_not_found', group: 'B99999' },
    });
    expect(dataCalls('acs/acs5', 2024)).toEqual([]);
  });

  it('names the sibling dataset that publishes the table, as a code span', async () => {
    serveMetadata('acs/acs5', 2024, groupAcsVariables);
    routes.push({
      match: (u) => u.pathname === '/data/2024/acs/acs5/subject/groups/S1701.json',
      respond: () => ({ name: 'S1701' }),
    });

    const result = await runToolContract(censusQueryData, { ...atKing, group: 'S1701' });

    expect(errorOf(result).data).toMatchObject({
      reason: 'variable_not_found',
      recovery: { hint: 'S1701 is in acs/acs5/subject — query that dataset instead.' },
    });
    expect(textOf(result)).toContain(
      'Recovery: S1701 is in `acs/acs5/subject` — query that dataset instead.',
    );
    expect(dataCalls('acs/acs5', 2024)).toEqual([]);
  });

  it('refuses a table on cbp, whose tables carry its filter dimensions, before the data request', async () => {
    serveMetadata('cbp', 2023, {
      ESTAB: { label: 'Number of establishments', predicateType: 'int', group: 'CB2300CBP' },
      NAICS2017: {
        label: 'Meaning of NAICS code',
        required: 'default displayed',
        predicateType: 'string',
        group: 'CB2300CBP',
      },
      LFO: { label: 'Legal form', required: 'default displayed', predicateType: 'string' },
      EMPSZES: { label: 'Employment size', required: 'default displayed', predicateType: 'string' },
    });

    const result = await runToolContract(censusQueryData, {
      ...atKing,
      dataset: 'cbp',
      group: 'CB2300CBP',
    });

    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'group_not_supported', dimensions: ['EMPSZES', 'LFO', 'NAICS2017'] },
    });
    expect(dataCalls('cbp', 2023)).toEqual([]);
  });

  it('names a narrower geography or the needed codes when the data deadline runs out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      serveMetadata('acs/acs5', 2024, groupAcsVariables);
      serveData('acs/acs5', 2024, () => HANG);

      const pending = runToolContract(censusQueryData, {
        geography_level: 'county',
        geography_fips: '*',
        parent_fips: '*',
        group: 'B01001',
      });
      await vi.advanceTimersByTimeAsync(300_000);
      const result = await pending;

      expect(errorOf(result).data).toMatchObject({
        reason: 'upstream_error',
        recovery: {
          hint: 'Retry the request once. If it fails the same way, request a narrower geography, or list only the codes you need from the table in variables in place of group: a response too large to arrive within one attempt fails on every retry. Otherwise the Census API is temporarily unavailable for this dataset and year.',
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
