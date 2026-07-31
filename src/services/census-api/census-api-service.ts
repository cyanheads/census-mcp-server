/**
 * @fileoverview Census Bureau Data API service. Handles data queries, response parsing,
 * and suppression code resolution for api.census.gov/data endpoints.
 * @module services/census-api/census-api-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError, serviceUnavailable, unauthorized } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, type RequestContext, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type { CensusDataRow, CensusRawResponse, CensusVariableValue } from './types.js';
import { SUPPRESSION_CODES } from './types.js';

const CENSUS_API_BASE = 'https://api.census.gov/data';

export class CensusApiService {
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

    const url = `${CENSUS_API_BASE}/${params.year}/${params.dataset}?get=${encodeURIComponent(varList)}&for=${encodeURIComponent(forClause)}${inClause}&key=${censusApiKey}`;

    ctx.log.debug('Census API query', {
      dataset: params.dataset,
      year: params.year,
      variables: params.variables,
      geographyLevel: params.geographyLevel,
      geographyFips: params.geographyFips,
    });

    const raw = await withRetry(
      async () => {
        const response = await fetchWithTimeout(url, 15_000, ctx as unknown as RequestContext, {
          signal: ctx.signal,
        });
        const text = await response.text();

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

    return this.parseResponse(raw, params.variables, params.geographyLevel, ctx);
  }

  /**
   * Fetch the list of geography levels supported by a dataset+year from the Census API.
   */
  fetchGeographyLevels(
    dataset: string,
    year: number,
    ctx: Context,
  ): Promise<
    Array<{
      name: string;
      geoLevelId: string;
      referenceDate?: string;
      requires?: string[];
      wildcard?: string[];
    }>
  > {
    const url = `${CENSUS_API_BASE}/${year}/${dataset}/geography.json`;

    ctx.log.debug('Fetching geography levels', { dataset, year });

    return withRetry(
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

        const obj = parsed as {
          fips?: Array<{
            name: string;
            geoLevelId: string;
            referenceDate?: string;
            requires?: string[];
            wildcard?: string[];
          }>;
        };
        return obj.fips ?? [];
      },
      {
        operation: 'CensusApiService.fetchGeographyLevels',
        context: ctx as unknown as RequestContext,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );
  }

  private parseResponse(
    raw: CensusRawResponse,
    requestedVariables: string[],
    geographyLevel: string,
    ctx: Context,
  ): CensusDataRow[] {
    if (raw.length < 1) return [];

    const headers = raw[0] as string[];
    const nameIdx = headers.indexOf('NAME');
    const geoIdx = headers.indexOf(geographyLevel);

    const rows: CensusDataRow[] = [];

    for (let i = 1; i < raw.length; i++) {
      const row = raw[i] as string[];
      const geographyName = nameIdx >= 0 ? (row[nameIdx] ?? '') : '';
      const geographyFips = geoIdx >= 0 ? (row[geoIdx] ?? '') : '';

      const variables: Record<string, CensusVariableValue> = {};

      for (const varCode of requestedVariables) {
        const idx = headers.indexOf(varCode);
        if (idx < 0) continue;

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

      rows.push({ geographyName, geographyFips, variables });
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
