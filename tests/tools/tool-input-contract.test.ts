/**
 * @fileoverview Pins the wire-facing input contract every tool inherits from the
 * framework: inputs are strict, and that strictness is advertised to clients as
 * `additionalProperties: false`.
 *
 * mcp-ts-core 0.12.0 made tool inputs strict. Before it, an undeclared key was
 * silently stripped and the call proceeded; now it is rejected. A caller that
 * sends a typo'd or stale argument gets a validation error instead of a result
 * computed from arguments it did not supply — so the strictness is the tool's
 * observable behavior, not an implementation detail, and regressing it would
 * change what every client sees without failing any per-tool test.
 *
 * @module tests/tools/tool-input-contract.test
 */

import { describe, expect, it } from 'vitest';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';

describe('tool input contract', () => {
  it.each(allToolDefinitions.map((d) => [d.name, d] as const))(
    '%s rejects an undeclared input key rather than stripping it',
    (_name, definition) => {
      const result = definition.input.safeParse({ __undeclaredKey: 'x' });

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
});
