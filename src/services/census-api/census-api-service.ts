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
  CensusRawResponse,
  CensusVariableValue,
  GeographyCheck,
} from './types.js';
import { SUPPRESSION_CODES } from './types.js';

const CENSUS_API_BASE = 'https://api.census.gov/data';

interface GeographyLevelsCacheEntry {
  fetchedAt: number;
  levels: CensusGeographyLevel[];
}

export class CensusApiService {
  /** geography.json per dataset+year — immutable upstream, cached for the discovery TTL. */
  private readonly geographyLevelsCache = new Map<string, GeographyLevelsCacheEntry>();

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
      dataset: string;
      year: number;
    },
    ctx: Context,
  ): Promise<CensusDataRow[]> {
    const { censusApiKey } = getServerConfig();

    const varList = ['NAME', ...params.variables].join(',');
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
    if (missingParents.length === 0) return { status: 'ok' };

    // A concrete target can demand parents (e.g. block group needs its tract) that a `*`
    // target would not — worth telling the caller, since `*` is an input they control.
    const wildcardRelaxes =
      params.geographyFips !== '*' &&
      underWildcard.filter((name) => !supplied.has(name)).length < missingParents.length;

    return { status: 'parent_required', missingParents, wildcardRelaxes };
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

  private parseResponse(
    raw: CensusRawResponse,
    requestedVariables: string[],
    geographyLevel: string,
    dataset: string,
    predicateKeys: string[],
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
    const nonGeoColumns = new Set([...requestedVariables, ...predicateKeys]);
    const geoColumnIdxs = headers.flatMap((header, idx) =>
      header !== 'NAME' && !nonGeoColumns.has(header) ? [idx] : [],
    );
    const variableIdxs = requestedVariables
      .map((code) => [code, headers.indexOf(code)] as const)
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

      rows.push({ geographyName, geographyFips, geographyGeoid, variables });
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
