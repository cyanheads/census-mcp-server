/**
 * @fileoverview The server entry point started as a process: a malformed CENSUS_* value stops
 * startup with the framework's configuration banner naming the variable, rather than starting a
 * server whose tools fail at call time. Runs `src/index.ts` under Bun with stdin closed, so a
 * server that does start shuts down on the stdin EOF and exits 0.
 * @module tests/index.test
 */

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

interface Exit {
  code: number | null;
  stderr: string;
}

/** Start the server with `env` laid over the inherited environment, every CENSUS_* tunable unset. */
function start(env: Record<string, string>): Promise<Exit> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        key !== 'CENSUS_VARIABLE_CACHE_TTL_HOURS' &&
        key !== 'CENSUS_CLAMP_LIMITS' &&
        key !== 'CENSUS_DEFAULT_YEAR',
    ),
  );
  return new Promise((resolve) => {
    const child = execFile(
      'bun',
      ['src/index.ts'],
      { cwd: ROOT, env: { ...inherited, MCP_TRANSPORT_TYPE: 'stdio', ...env }, timeout: 20_000 },
      (_error, _stdout, stderr) => resolve({ code: child.exitCode, stderr }),
    );
    child.stdin?.end();
  });
}

describe('server startup', () => {
  it.each([
    ['CENSUS_VARIABLE_CACHE_TTL_HOURS', 'abc'],
    ['CENSUS_CLAMP_LIMITS', 'maybe'],
  ])('fails to start on %s=%s, naming the variable in the banner', async (name, value) => {
    const { code, stderr } = await start({ [name]: value });

    expect(code).toBe(1);
    expect(stderr).toContain('Configuration error');
    expect(stderr).toContain(name);
  });

  it('starts with every tunable unset, ignoring a malformed CENSUS_DEFAULT_YEAR', async () => {
    const { code, stderr } = await start({ CENSUS_DEFAULT_YEAR: 'not-a-year' });

    expect(stderr).not.toContain('Configuration error');
    expect(code).toBe(0);
  });
});
