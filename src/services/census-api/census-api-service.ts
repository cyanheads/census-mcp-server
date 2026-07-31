/**
 * @fileoverview Census Bureau Data API service. Handles data queries, response parsing,
 * and suppression code resolution for api.census.gov/data endpoints.
 * @module services/census-api/census-api-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError, serviceUnavailable, unauthorized } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, type RequestContext, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getDiscoveryConfig, getServerConfig } from '@/config/server-config.js';
import { isAcsDataset } from '@/services/variable-cache/variable-cache-service.js';
import type {
  CensusDataRow,
  CensusGeographyLevel,
  CensusPredicateValue,
  CensusRawResponse,
  CensusVariableValue,
  GeographyCheck,
} from './types.js';
import { SUPPRESSION_CODES } from './types.js';

const CENSUS_API_BASE = 'https://api.census.gov/data';

/**
 * Zero-pad a fixed-width parent FIPS code to the width the Census API matches on, returning
 * undefined for a blank value so it reads as omitted. State codes are 2 digits and county codes
 * 3; the API compares them literally, so `state:5` finds nothing where `state:05` finds Arkansas.
 *
 * `*` is a scope, not a code — `in=state:53 county:*` is the only way to reach every block group
 * in a state — so it passes through untouched rather than becoming `00*`.
 */
export function padFips(value: string | undefined, width: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return;
  return trimmed === '*' ? trimmed : trimmed.padStart(width, '0');
}

interface GeographyLevelsCacheEntry {
  fetchedAt: number;
  levels: CensusGeographyLevel[];
}

interface PredicateValuesCacheEntry {
  fetchedAt: number;
  values: CensusPredicateValue[];
}

export class CensusApiService {
  /** geography.json per dataset+year — immutable upstream, cached for the discovery TTL. */
  private readonly geographyLevelsCache = new Map<string, GeographyLevelsCacheEntry>();

  /** Wildcard group-by enumerations per dataset+year+dimension+NAICS scope. */
  private readonly predicateValuesCache = new Map<string, PredicateValuesCacheEntry>();

  /**
   * Query a Census dataset for variables at a specific geography.
   * Returns parsed rows with suppression codes resolved.
   */
  async queryData(
    params: {
      variables: string[];
      geographyLevel: string;
      geographyFips: string;
      /** State FIPS code — required for sub-state geography levels. */
      parentFips?: string;
      /** County FIPS code — required when querying tracts or block groups within a specific county. */
      countyFips?: string;
      /**
       * Dataset-specific filter values sent as extra query parameters, keyed by variable code
       * (e.g. `{ NAICS2017: '5112' }`). Omitting one the dataset requires is not an error
       * upstream — the API returns the aggregate across that dimension instead.
       */
      predicates?: Record<string, string>;
      /**
       * Attribute column to request per filter dimension the query left unset, keyed by
       * predicate code (e.g. `{ POPGROUP: 'POPGROUP_LABEL' }`). The attribute carries the
       * label of the default the API applied; requesting the bare predicate code instead
       * would flip the API from applying one default to enumerating every category.
       */
      defaultLabelColumns?: Record<string, string>;
      dataset: string;
      year: number;
    },
    ctx: Context,
  ): Promise<CensusDataRow[]> {
    const { censusApiKey } = getServerConfig();

    const defaultLabelColumns = params.defaultLabelColumns ?? {};
    const varList = ['NAME', ...params.variables, ...Object.values(defaultLabelColumns)].join(',');
    const forClause = `${params.geographyLevel}:${params.geographyFips}`;

    // Build compound in= clause: county FIPS requires state FIPS as the outer scope.
    let inClause = '';
    if (params.parentFips) {
      inClause = `&in=state:${params.parentFips}`;
      if (params.countyFips) {
        inClause += `%20county:${params.countyFips}`;
      }
    }

    const predicateKeys = Object.keys(params.predicates ?? {});
    const predicateClause = Object.entries(params.predicates ?? {})
      .map(([key, value]) => `&${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('');

    const url = `${CENSUS_API_BASE}/${params.year}/${params.dataset}?get=${encodeURIComponent(varList)}&for=${encodeURIComponent(forClause)}${inClause}${predicateClause}&key=${censusApiKey}`;

    ctx.log.debug('Census API query', {
      dataset: params.dataset,
      year: params.year,
      variables: params.variables,
      geographyLevel: params.geographyLevel,
      geographyFips: params.geographyFips,
      predicates: predicateKeys,
    });

    const raw = await withRetry(
      async () => {
        const response = await fetchWithTimeout(url, 15_000, ctx as unknown as RequestContext, {
          signal: ctx.signal,
        });
        const text = await response.text();

        // A well-formed query that matches nothing answers 204 with an empty body — the
        // caller's problem is no_data, not an unparseable upstream response worth retrying.
        if (response.status === 204 || text.trim() === '') return [] as CensusRawResponse;

        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          if (text.includes('Invalid Key') || text.includes('key_signup')) {
            throw unauthorized(
              'Census API key is invalid or missing. Set CENSUS_API_KEY and restart.',
              { reason: 'missing_api_key' },
            );
          }
          throw serviceUnavailable(
            'Census API returned HTML instead of JSON — may be temporarily unavailable.',
            { reason: 'upstream_error' },
          );
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw serviceUnavailable('Census API returned unparseable response.', {
            reason: 'upstream_error',
          });
        }

        if (!Array.isArray(parsed)) {
          throw serviceUnavailable('Census API response was not an array.', {
            reason: 'upstream_error',
          });
        }

        return parsed as CensusRawResponse;
      },
      {
        operation: 'CensusApiService.queryData',
        context: ctx as unknown as RequestContext,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );

    return this.parseResponse(
      raw,
      params.variables,
      params.geographyLevel,
      params.dataset,
      predicateKeys,
      defaultLabelColumns,
      ctx,
    );
  }

  /**
   * Check a geography level and its supplied parents against the dataset's own
   * geography.json before spending a data query on a request the Census API will reject.
   *
   * Returns `ok` when the dataset has no metadata for the year — the data call then
   * reports the real problem rather than this check guessing at one.
   */
  async checkGeography(
    params: {
      dataset: string;
      year: number;
      geographyLevel: string;
      /** The `for=` value — `*` relaxes the innermost required parent. */
      geographyFips: string;
      /** State FIPS, when supplied by the caller. */
      parentFips?: string;
      /** County FIPS, when supplied by the caller. */
      countyFips?: string;
    },
    ctx: Context,
  ): Promise<GeographyCheck> {
    const levels = await this.fetchGeographyLevels(params.dataset, params.year, ctx);
    if (levels.length === 0) return { status: 'ok' };

    const target = params.geographyLevel.trim().toLowerCase();
    const level = levels.find((l) => l.name.toLowerCase() === target);
    if (!level) {
      return {
        status: 'level_not_supported',
        availableLevels: [...new Set(levels.map((l) => l.name))],
      };
    }

    const required = level.requires ?? [];
    // A `*` target lets the Census API infer the innermost optional parent and everything
    // below it — `optionalWithWCFor` names where that cutoff starts. Without it, or with a
    // concrete FIPS target, every required parent must be supplied.
    const cutoff = level.optionalWithWCFor ? required.indexOf(level.optionalWithWCFor) : -1;
    const underWildcard = cutoff >= 0 ? required.slice(0, cutoff) : required;
    const effective = params.geographyFips === '*' ? underWildcard : required;

    // state and county are the only parents the `in=` clause can express.
    const supplied = new Set<string>();
    if (params.parentFips) supplied.add('state');
    if (params.countyFips) supplied.add('county');

    const missingParents = effective.filter((name) => !supplied.has(name));
    if (missingParents.length > 0) {
      // A concrete target can demand parents (e.g. block group needs its tract) that a `*`
      // target would not — worth telling the caller, since `*` is an input they control.
      const wildcardRelaxes =
        params.geographyFips !== '*' &&
        underWildcard.filter((name) => !supplied.has(name)).length < missingParents.length;

      return { status: 'parent_required', missingParents, wildcardRelaxes };
    }

    // The mirror of the missing-parent case: a parent the level never names produces an
    // `in=` clause the Census API answers with an opaque 400. Acceptance is a property of
    // the level, so it is checked against the full `requires` list rather than `effective` —
    // the `*` wildcard relaxes which parents are mandatory, never which ones are allowed.
    const unacceptedParents = [...supplied].filter((name) => !required.includes(name));
    if (unacceptedParents.length > 0) {
      return { status: 'parent_not_accepted', unacceptedParents, acceptedParents: required };
    }

    return { status: 'ok' };
  }

  /**
   * Fetch the list of geography levels supported by a dataset+year from the Census API.
   * Cached in-memory per dataset+year with the discovery TTL.
   */
  async fetchGeographyLevels(
    dataset: string,
    year: number,
    ctx: Context,
  ): Promise<CensusGeographyLevel[]> {
    const ttlMs = getDiscoveryConfig().variableCacheTtlHours * 60 * 60 * 1000;
    const cacheKey = `${dataset}|${year}`;
    const cached = this.geographyLevelsCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < ttlMs) {
      ctx.log.debug('Geography levels cache hit', { dataset, year });
      return cached.levels;
    }

    const url = `${CENSUS_API_BASE}/${year}/${dataset}/geography.json`;

    ctx.log.debug('Fetching geography levels', { dataset, year });

    const levels = await withRetry(
      async () => {
        let response: Response;
        try {
          response = await fetchWithTimeout(url, 10_000, ctx as unknown as RequestContext, {
            signal: ctx.signal,
            // A 404 here is an expected outcome, not a fault — log it at debug.
            expectedStatuses: [404],
          });
        } catch (err) {
          // 404 means the year has no data for this dataset — return empty so the handler
          // can throw year_not_available instead of a generic upstream error.
          if (err instanceof McpError && (err.data as { status?: number })?.status === 404) {
            return [];
          }
          throw err;
        }

        const text = await response.text();

        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable('Census API geography endpoint returned HTML.', {
            reason: 'upstream_error',
          });
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw serviceUnavailable('Census API geography response unparseable.', {
            reason: 'upstream_error',
          });
        }

        const obj = parsed as { fips?: CensusGeographyLevel[] };
        return obj.fips ?? [];
      },
      {
        operation: 'CensusApiService.fetchGeographyLevels',
        context: ctx as unknown as RequestContext,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );

    this.geographyLevelsCache.set(cacheKey, { levels, fetchedAt: Date.now() });
    return levels;
  }

  /**
   * Enumerate the codes a filter dimension accepts, by wildcarding it on the data endpoint.
   *
   * Setting `<CODE>=*` turns the predicate into a group-by, so the response carries one row
   * per code the dimension takes for the scope queried. `variables.json` publishes a
   * `values.item` map for only two dimensions across the whole catalog, so this is the only
   * route to the rest. Cached per dataset+year+dimension+scope with the discovery TTL.
   *
   * The scope matters: on `ecnbasic` the codes `TAXSTAT` and `TYPOP` take are published per
   * industry, so an unscoped call returns only the all-establishments row and a `naicsScope`
   * is what makes the enumeration useful — and complete only for that industry.
   */
  async fetchPredicateValues(
    params: {
      dataset: string;
      year: number;
      /** The filter dimension to enumerate (e.g. "EMPSZES"). */
      code: string;
      /** Attribute column carrying each code's label (e.g. "EMPSZES_LABEL"), when published. */
      labelAttribute?: string;
      /** NAICS dimension code and industry value to scope the enumeration by. */
      naicsScope?: { code: string; value: string };
    },
    ctx: Context,
  ): Promise<CensusPredicateValue[]> {
    const { censusApiKey } = getServerConfig();
    const ttlMs = getDiscoveryConfig().variableCacheTtlHours * 60 * 60 * 1000;
    const scopeKey = params.naicsScope
      ? `${params.naicsScope.code}=${params.naicsScope.value}`
      : '';
    const cacheKey = `${params.dataset}|${params.year}|${params.code}|${scopeKey}`;
    const cached = this.predicateValuesCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < ttlMs) {
      ctx.log.debug('Predicate values cache hit', { dataset: params.dataset, code: params.code });
      return cached.values;
    }

    const scopeClause = params.naicsScope
      ? `&${encodeURIComponent(params.naicsScope.code)}=${encodeURIComponent(params.naicsScope.value)}`
      : '';
    const url = `${CENSUS_API_BASE}/${params.year}/${params.dataset}?get=${encodeURIComponent(params.labelAttribute ?? params.code)}&${encodeURIComponent(params.code)}=*${scopeClause}&for=us:1&key=${censusApiKey}`;

    ctx.log.debug('Enumerating predicate values', {
      dataset: params.dataset,
      year: params.year,
      code: params.code,
    });

    const raw = await withRetry(
      async () => {
        const response = await fetchWithTimeout(url, 15_000, ctx as unknown as RequestContext, {
          signal: ctx.signal,
        });
        const text = await response.text();

        // A dimension with nothing to enumerate under this scope answers 204 with no body.
        if (response.status === 204 || text.trim() === '') return [] as CensusRawResponse;

        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable('Census API returned HTML instead of JSON.', {
            reason: 'upstream_error',
          });
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw serviceUnavailable('Census API returned unparseable response.', {
            reason: 'upstream_error',
          });
        }

        if (!Array.isArray(parsed)) {
          throw serviceUnavailable('Census API response was not an array.', {
            reason: 'upstream_error',
          });
        }

        return parsed as CensusRawResponse;
      },
      {
        operation: 'CensusApiService.fetchPredicateValues',
        context: ctx as unknown as RequestContext,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );

    const values: CensusPredicateValue[] = [];
    if (raw.length > 1) {
      const headers = raw[0] as string[];
      const codeIdx = headers.indexOf(params.code);
      const labelIdx = params.labelAttribute ? headers.indexOf(params.labelAttribute) : -1;
      const seen = new Set<string>();

      for (let i = 1; i < raw.length; i++) {
        const row = raw[i] as string[];
        const code = codeIdx >= 0 ? (row[codeIdx] ?? '') : '';
        // A wildcarded dimension repeats codes across the other dimensions' rows.
        if (!code || seen.has(code)) continue;
        seen.add(code);
        values.push({ code, label: (labelIdx >= 0 ? row[labelIdx] : undefined) || code });
      }
      values.sort((a, b) => a.code.localeCompare(b.code));
    }

    this.predicateValuesCache.set(cacheKey, { values, fetchedAt: Date.now() });
    ctx.log.info('Predicate values enumerated', { code: params.code, valueCount: values.length });
    return values;
  }

  private parseResponse(
    raw: CensusRawResponse,
    requestedVariables: string[],
    geographyLevel: string,
    dataset: string,
    predicateKeys: string[],
    defaultLabelColumns: Record<string, string>,
    ctx: Context,
  ): CensusDataRow[] {
    if (raw.length < 1) return [];

    const headers = raw[0] as string[];
    const nameIdx = headers.indexOf('NAME');
    // The Census API echoes the level name in its own casing, so match it the way
    // checkGeography does rather than requiring the caller's exact spelling.
    const geoTarget = geographyLevel.trim().toLowerCase();
    const geoIdx = headers.findIndex((h) => h.toLowerCase() === geoTarget);

    // The Census API appends one column per geography level in the resolved hierarchy —
    // a county query returns state + county, a tract query state + county + tract. It also
    // echoes back every predicate that was filtered on. Once NAME, the requested variables,
    // and those echoed predicates are excluded, what remains is the geography hierarchy, and
    // concatenating it in order composes the full GEOID.
    const nonGeoColumns = new Set([
      ...requestedVariables,
      ...predicateKeys,
      ...Object.values(defaultLabelColumns),
    ]);
    const geoColumnIdxs = headers.flatMap((header, idx) =>
      header !== 'NAME' && !nonGeoColumns.has(header) ? [idx] : [],
    );
    const variableIdxs = requestedVariables
      .map((code) => [code, headers.indexOf(code)] as const)
      .filter(([, idx]) => idx >= 0);
    const appliedFilterIdxs = Object.entries(defaultLabelColumns)
      .map(([code, column]) => [code, headers.indexOf(column)] as const)
      .filter(([, idx]) => idx >= 0);

    const rows: CensusDataRow[] = [];

    for (let i = 1; i < raw.length; i++) {
      const row = raw[i] as string[];
      const geographyName = nameIdx >= 0 ? (row[nameIdx] ?? '') : '';
      const geographyFips = geoIdx >= 0 ? (row[geoIdx] ?? '') : '';
      const geographyGeoid = geoColumnIdxs.map((idx) => row[idx] ?? '').join('') || geographyFips;

      const variables: Record<string, CensusVariableValue> = {};

      for (const [varCode, idx] of variableIdxs) {
        const rawValue = row[idx] ?? null;
        const numValue = rawValue !== null ? Number(rawValue) : null;
        const suppressionReason = rawValue !== null ? SUPPRESSION_CODES[rawValue] : undefined;
        const suppressed =
          suppressionReason !== undefined || (numValue !== null && numValue < -100_000_000);

        variables[varCode] = {
          estimate: suppressed ? null : numValue,
          label: varCode,
          suppressed,
          ...(suppressionReason && { suppressionReason }),
        };
      }

      // Pair each requested estimate with its margin of error. Only ACS uses the E/M suffix
      // for that relationship — elsewhere an E-final code is just a code, so pairing two of
      // them would attach a margin of error to a value that has none.
      if (isAcsDataset(dataset)) {
        for (const varCode of requestedVariables) {
          if (varCode.endsWith('E')) {
            const moeCode = `${varCode.slice(0, -1)}M`;
            const est = variables[varCode];
            const moe = variables[moeCode];
            if (est && moe) {
              est.moe = moe.estimate;
            }
          }
        }
      }

      const appliedFilters: Record<string, string> = {};
      for (const [code, idx] of appliedFilterIdxs) {
        const label = row[idx];
        if (label) appliedFilters[code] = label;
      }

      rows.push({
        geographyName,
        geographyFips,
        geographyGeoid,
        variables,
        ...(Object.keys(appliedFilters).length > 0 && { appliedFilters }),
      });
    }

    ctx.log.info('Census API response parsed', { rowCount: rows.length });
    return rows;
  }
}

// --- Init/accessor pattern ---

let _service: CensusApiService | undefined;

export function initCensusApiService(): void {
  _service = new CensusApiService();
}

export function getCensusApiService(): CensusApiService {
  if (!_service) {
    throw new Error('CensusApiService not initialized — call initCensusApiService() in setup()');
  }
  return _service;
}
