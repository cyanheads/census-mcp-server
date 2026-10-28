/**
 * @fileoverview The `.mcpb` cleaner and the packaging check agree on which `node_modules/` entries
 * are agent docs: trees at an installed package's root go, while same-named directories deeper in
 * a package — the MCP SDK's `dist/ext/skills/` runtime modules — stay (mcp-ts-core#794).
 * @module tests/scripts/bundle-agent-docs
 */
import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY, filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

/**
 * Loaded by URL at run time rather than imported: the script's repo-only fallback import of
 * `../src/mcp-server/skills.js` fails typecheck once `tsc` reaches it (mcp-ts-core#797).
 */
const lintPackaging: {
  AGENT_DOC_ENTRY: RegExp;
  checkBundleEntries: (entries: string[], bundleLabel: string) => string[];
} = await import(new URL('../../scripts/lint-packaging.ts', import.meta.url).href);

const retained = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.cjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.d.mts',
  'node_modules/parent/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@scope/parent/node_modules/child/lib/skills/loader.js',
  'node_modules/child/dist/.claude/settings.js',
  'node_modules/@scope/skills/index.js',
  'node_modules/skills/index.js',
  'node_modules/@cyanheads/mcp-ts-core/dist/index.js',
  'skills/census-guide/SKILL.md',
  'dist/index.js',
];

const removed = [
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/api-utils/references/formatting.md',
  'node_modules/dotenv/skills/dotenv/SKILL.md',
  'node_modules/@scope/child/skills/guide/reference.md',
  'node_modules/thread-stream/.claude/settings.json',
  'node_modules/child/.agents/skills/guide.md',
  'node_modules/parent/node_modules/child/framework-skills/guide/SKILL.md',
  'node_modules/@scope/parent/node_modules/@scope/child/.claude/settings.json',
  'node_modules/child/SKILL.md',
  'node_modules/child/docs/SKILL.md',
];

describe('bundle agent-doc matcher', () => {
  it('is the same pattern in the cleaner and the packaging check', () => {
    expect(lintPackaging.AGENT_DOC_ENTRY).toBeInstanceOf(RegExp);
    expect(lintPackaging.AGENT_DOC_ENTRY.source).toBe(AGENT_DOC_ENTRY.source);
    expect(lintPackaging.AGENT_DOC_ENTRY.flags).toBe(AGENT_DOC_ENTRY.flags);
  });

  it.each(retained)('keeps runtime and published content: %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([]);
    expect(lintPackaging.checkBundleEntries([entry], 'census-mcp-server.mcpb')).toEqual([]);
  });

  it.each(removed)('strips package-root agent docs: %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([entry]);
    const errors = lintPackaging.checkBundleEntries([entry], 'census-mcp-server.mcpb');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(entry);
  });

  it('selects exactly the agent docs from a mixed listing', () => {
    expect(filterAgentDocEntries([...retained, ...removed])).toEqual(removed);
  });
});
