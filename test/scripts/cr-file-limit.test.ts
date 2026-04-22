// Regression tests for scripts/lib/cr-file-limit.mjs.
//
// The precheck is the fast-fail mirror of the CI step
// ".github/workflows/ci.yml :: PR under CodeRabbit file-review limit".
// Both enforce the same 150-file cap; this module is what callers like
// scripts/gh-as.mjs invoke BEFORE minting a bot token, so an overweight
// PR is caught before any GitHub-side side effect. Incident anchor:
// PRs #92 (205 files) and #93 (158 files) on 2026-04-22 both tripped
// CR's silent-skip behaviour and blocked merge with no loud signal.

import { describe, expect, it } from 'vitest';

import {
  CR_FILE_LIMIT,
  CR_FILE_LIMIT_ENV,
  decideCrFileLimit,
  isPrCreateSubcommand,
  parseBaseBranch,
} from '../../scripts/lib/cr-file-limit.mjs';

describe('isPrCreateSubcommand', () => {
  it('matches `pr create`', () => {
    expect(isPrCreateSubcommand(['pr', 'create', '--title', 'x'])).toBe(true);
  });
  it('rejects `pr view`', () => {
    expect(isPrCreateSubcommand(['pr', 'view', '92'])).toBe(false);
  });
  it('rejects `pr merge`', () => {
    expect(isPrCreateSubcommand(['pr', 'merge', '91', '--squash'])).toBe(false);
  });
  it('rejects `api repos/.../pulls`', () => {
    expect(isPrCreateSubcommand(['api', 'repos/o/r/pulls', '-X', 'POST'])).toBe(false);
  });
  it('rejects empty argv', () => {
    expect(isPrCreateSubcommand([])).toBe(false);
  });
});

describe('parseBaseBranch', () => {
  it('returns null when --base is absent', () => {
    expect(parseBaseBranch(['pr', 'create', '--title', 'x'])).toBe(null);
  });
  it('parses --base <branch>', () => {
    expect(parseBaseBranch(['pr', 'create', '--base', 'develop'])).toBe('develop');
  });
  it('parses -B <branch>', () => {
    expect(parseBaseBranch(['pr', 'create', '-B', 'release/1.0'])).toBe('release/1.0');
  });
  it('parses --base=<branch>', () => {
    expect(parseBaseBranch(['pr', 'create', '--base=substrate/1-core'])).toBe('substrate/1-core');
  });
  it('ignores --base inside earlier positional args', () => {
    // First two positionals are `pr create`; --base appears after.
    expect(parseBaseBranch(['pr', 'create', '--title', '--base is neat', '--base', 'main'])).toBe('main');
  });
});

// Fake counter so tests don't depend on real git state. Tests exercise
// the decision logic end-to-end: args in → verdict out.
function fakeCounter(returns: { count: number; ref: string } | null) {
  return () => returns;
}

describe('decideCrFileLimit', () => {
  it('skips non-pr-create commands', () => {
    const v = decideCrFileLimit(['pr', 'view', '92'], {
      env: {},
      countChangedFiles: fakeCounter(null),
    });
    expect(v.action).toBe('skip');
    expect((v as { reason: string }).reason).toBe('not-pr-create');
  });

  it('skips when env bypass is set', () => {
    const v = decideCrFileLimit(['pr', 'create'], {
      env: { [CR_FILE_LIMIT_ENV]: '1' },
      countChangedFiles: fakeCounter({ count: 500, ref: 'origin/main' }),
    });
    expect(v.action).toBe('skip');
    expect((v as { reason: string }).reason).toBe('env-bypass');
  });

  it('warns and continues when base ref cannot be resolved', () => {
    const v = decideCrFileLimit(['pr', 'create', '--base', 'missing-branch'], {
      env: {},
      countChangedFiles: fakeCounter(null),
    });
    expect(v.action).toBe('warn');
    expect((v as { reason: string }).reason).toContain('missing-branch');
  });

  it('allows when count <= limit', () => {
    const v = decideCrFileLimit(['pr', 'create'], {
      env: {},
      countChangedFiles: fakeCounter({ count: CR_FILE_LIMIT, ref: 'origin/main' }),
    });
    expect(v.action).toBe('allow');
    // Exactly at the limit is ALLOWED (CR's "150 over the limit of 150"
    // means strictly greater-than blocks).
    expect((v as { count: number }).count).toBe(CR_FILE_LIMIT);
  });

  it('blocks when count > limit', () => {
    const v = decideCrFileLimit(['pr', 'create'], {
      env: {},
      countChangedFiles: fakeCounter({ count: CR_FILE_LIMIT + 1, ref: 'origin/main' }),
    });
    expect(v.action).toBe('block');
    expect((v as { count: number }).count).toBe(CR_FILE_LIMIT + 1);
  });

  it('blocks on the PR #92 shape (205 files vs main)', () => {
    // Pin the literal historical incident so a regression in the
    // threshold wiring shows up as a readable failure, not a
    // numeric-drift mystery.
    const v = decideCrFileLimit(['pr', 'create', '--base', 'main'], {
      env: {},
      countChangedFiles: fakeCounter({ count: 205, ref: 'origin/main' }),
    });
    expect(v.action).toBe('block');
  });

  it('blocks on the PR #93 shape (158 files vs substrate/1-core)', () => {
    const v = decideCrFileLimit(['pr', 'create', '--base', 'substrate/1-core'], {
      env: {},
      countChangedFiles: fakeCounter({ count: 158, ref: 'origin/substrate/1-core' }),
    });
    expect(v.action).toBe('block');
  });

  it('defaults base to main when --base is omitted', () => {
    let capturedBase: string | undefined;
    const counter = (base: string) => {
      capturedBase = base;
      return { count: 10, ref: `origin/${base}` };
    };
    decideCrFileLimit(['pr', 'create', '--title', 'x', '--body', 'y'], {
      env: {},
      countChangedFiles: counter,
    });
    expect(capturedBase).toBe('main');
  });

  it('honours a custom --base when provided', () => {
    let capturedBase: string | undefined;
    const counter = (base: string) => {
      capturedBase = base;
      return { count: 10, ref: `origin/${base}` };
    };
    decideCrFileLimit(['pr', 'create', '--base', 'substrate/2-runtime-adapters'], {
      env: {},
      countChangedFiles: counter,
    });
    expect(capturedBase).toBe('substrate/2-runtime-adapters');
  });

  it('uses a custom limit when passed', () => {
    // Verifies the `limit` option (not exercised by gh-as.mjs today)
    // doesn't silently fall back to CR_FILE_LIMIT.
    const v = decideCrFileLimit(['pr', 'create'], {
      env: {},
      limit: 50,
      countChangedFiles: fakeCounter({ count: 75, ref: 'origin/main' }),
    });
    expect(v.action).toBe('block');
    expect((v as { limit: number }).limit).toBe(50);
  });
});
