/**
 * @fileoverview Pins the wire-facing input contract every tool inherits from the
 * framework: inputs are strict, that strictness is advertised to clients as
 * `additionalProperties: false`, and a rejected call comes back as the
 * `InvalidParams` error envelope a client actually receives.
 *
 * mcp-ts-core 0.12.0 made tool inputs strict. Before it, an undeclared key was
 * silently stripped and the call proceeded; now it is rejected. A caller that
 * sends a typo'd or stale argument gets a validation error instead of a result
 * computed from arguments it did not supply — so the strictness is the tool's
 * observable behavior, not an implementation detail, and regressing it would
 * change what every client sees without failing any per-tool test.
 *
 * Two layers, deliberately both: `input.safeParse` pins the schema, and
 * `runToolContract` pins what reaches the client through the production
 * rejection path — the `-32602` code, `data.reason`, and the recovery hint and
 * reason terms appended to `content[0].text`. The schema alone no longer tells
 * the whole story, because 0.13.4 added a pre-validation step that drops
 * client-added root keys before the schema ever sees them.
 *
 * Text assertions check containment, never equality: the framework owns the
 * exact wording and has moved it twice (0.13.3 appended `Recovery: …`, 0.13.5
 * appended the reason term).
 *
 * @module tests/tools/tool-input-contract.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { censusListDatasets } from '@/mcp-server/tools/definitions/census-list-datasets.tool.js';
import { censusListGeographies } from '@/mcp-server/tools/definitions/census-list-geographies.tool.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';

/** JSON-RPC code for an argument rejection, as a client reads it off the wire. */
const INVALID_PARAMS = -32602;

interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: { error?: { code?: number; data?: Record<string, unknown> } };
}

const errorOf = (result: unknown) => {
  const typed = result as ToolResult;
  return {
    isError: typed.isError,
    text: typed.content?.[0]?.text ?? '',
    code: typed.structuredContent?.error?.code,
    data: typed.structuredContent?.error?.data ?? {},
  };
};

describe('tool input contract', () => {
  it.each(allToolDefinitions.map((d) => [d.name, d] as const))(
    '%s rejects an undeclared input key rather than stripping it',
    (_name, definition) => {
      const result = definition.input.safeParse({ undeclaredKey: 'x' });

      expect(result.success).toBe(false);
      // Asserting on the issue, not just the throw: a tool with required fields
      // would fail this input either way, so only the unrecognized-key issue
      // distinguishes strict rejection from incidental failure.
      expect(result.error?.issues.map((i) => i.code)).toContain('unrecognized_keys');
    },
  );

  it.each(allToolDefinitions.map((d) => [d.name, d] as const))(
    '%s advertises additionalProperties: false so clients see the strictness',
    (_name, definition) => {
      const schema = definition.input.toJSONSchema() as { additionalProperties?: unknown };
      expect(schema.additionalProperties).toBe(false);
    },
  );

  it.each(allToolDefinitions.map((d) => [d.name, d] as const))(
    '%s surfaces an undeclared key as an InvalidParams envelope naming the key',
    async (_name, definition) => {
      // The handler never runs on a rejected call, so no tool reaches its upstream API here.
      const { isError, text, code, data } = errorOf(
        await runToolContract(definition, { undeclaredKey: 'x' } as never),
      );

      expect(isError).toBe(true);
      expect(code).toBe(INVALID_PARAMS);
      expect(data.reason).toBe('invalid_arguments');
      expect(data.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'unrecognized_keys' })]),
      );
      expect(text).toContain('undeclaredKey');
    },
  );

  it('appends the synthesized recovery hint and reason term to the rejection text', async () => {
    const { text, data } = errorOf(
      await runToolContract(censusListDatasets, { filter: 1 } as never),
    );

    expect(text).toContain('filter');
    expect(text).toContain('Recovery:');
    expect(text).toContain('(reason invalid_arguments');
    expect(data.recovery).toEqual(expect.objectContaining({ hint: expect.any(String) }));
  });

  it('drops an underscore-prefixed client key instead of rejecting the call', async () => {
    // No declared input starts with `_`, so the framework reads such a key as client
    // bookkeeping and strips it pre-validation — the opposite of the schema's verdict above.
    const result = (await runToolContract(censusListDatasets, {
      filter: 'acs',
      _clientCallId: 'abc',
    } as never)) as ToolResult;

    expect(result.isError).toBeFalsy();
  });

  it('carries the declared recovery hint and reason for a handler-thrown failure', async () => {
    const { isError, text, code, data } = errorOf(
      await runToolContract(censusListGeographies, { dataset: 'nope/nope' } as never),
    );

    expect(isError).toBe(true);
    expect(code).not.toBe(INVALID_PARAMS);
    expect(data.reason).toBe('dataset_not_found');
    expect(text).toContain('Call census_list_datasets to discover valid dataset codes');
    expect(text).toContain('(reason dataset_not_found');
  });
});
