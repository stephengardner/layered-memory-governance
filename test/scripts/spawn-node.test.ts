/**
 * Unit tests for scripts/lib/spawn-node.mjs.
 *
 * Helper-only tests (no spawn). The wrapper (`spawnNode`) is a thin
 * call-through to execa(process.execPath, ...); the only added logic
 * is the up-front validation guard. The integration that actually
 * spawns a child node lives in the runtime call sites
 * (autonomous-dispatch, intend, pr-observation-refresher) and is
 * exercised by their own tests / dogfeed runs.
 */

import { describe, expect, it } from 'vitest';

import { validateSpawnNodeArgs, spawnNode } from '../../scripts/lib/spawn-node.mjs';

describe('validateSpawnNodeArgs', () => {
  it('accepts a single-entry args array (script path only)', () => {
    expect(validateSpawnNodeArgs(['scripts/foo.mjs'])).toBe(true);
  });

  it('accepts a multi-entry args array', () => {
    expect(
      validateSpawnNodeArgs([
        'scripts/foo.mjs',
        '--flag',
        'value',
      ]),
    ).toBe(true);
  });

  it('rejects non-array input', () => {
    expect(() => validateSpawnNodeArgs(undefined as unknown as string[])).toThrow();
    expect(() => validateSpawnNodeArgs(null as unknown as string[])).toThrow();
    expect(() => validateSpawnNodeArgs('scripts/foo.mjs' as unknown as string[])).toThrow();
    expect(() => validateSpawnNodeArgs({ 0: 'scripts/foo.mjs', length: 1 } as unknown as string[])).toThrow();
  });

  it('rejects empty array', () => {
    // A zero-arg spawn would invoke node with no script and drop the
    // caller into a REPL inside a `stdio: 'inherit'` parent. That is
    // the kind of bug that is far easier to debug as a thrown Error
    // at validation time than as a hung child process minutes later.
    expect(() => validateSpawnNodeArgs([])).toThrow();
  });

  it('rejects non-string entries', () => {
    expect(() => validateSpawnNodeArgs([123 as unknown as string])).toThrow();
    expect(() => validateSpawnNodeArgs(['scripts/foo.mjs', null as unknown as string])).toThrow();
    expect(() => validateSpawnNodeArgs(['scripts/foo.mjs', undefined as unknown as string])).toThrow();
    expect(() => validateSpawnNodeArgs(['scripts/foo.mjs', { toString: () => 'x' } as unknown as string])).toThrow();
  });

  it('error message names the offending index for non-string entries', () => {
    expect(() => validateSpawnNodeArgs(['ok', 42 as unknown as string])).toThrow(/args\[1\]/);
  });
});

describe('spawnNode (validation pre-spawn)', () => {
  it('throws synchronously on bad args before invoking execa', () => {
    // The validation guard runs before execa is reached, so this
    // throw is synchronous (does not return a rejected Promise that
    // a forgotten-await might silently swallow).
    expect(() => spawnNode([] as unknown as string[])).toThrow();
    expect(() => spawnNode(undefined as unknown as string[])).toThrow();
  });
});
