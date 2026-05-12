/**
 * Unit tests for scripts/lib/resolve-bot-creds-state-dir.mjs.
 *
 * The helper is consumed by gh-as.mjs, git-as.mjs, and
 * gh-token-for.mjs so a sub-agent dispatched into a freshly-created
 * worktree (no `.lag/apps/` copied) still finds the parent repo's
 * bot creds via walk-up resolution. A drift between the helper and
 * its callers reintroduces the manual `cp -r .lag/apps` workaround.
 *
 * Behaviour pinned:
 *   - creds at supplied stateDir -> first-hit short-circuit, no walk.
 *   - creds only in an ancestor -> walk up to ancestor's `.lag/`.
 *   - creds nowhere -> fall back to supplied stateDir (loud-failure
 *     downstream preserved).
 *   - LAG_STATE_DIR override -> skip walk-up entirely, return as-is.
 *   - role name with `/`, `..`, `\` -> assertSafeRoleForResolution
 *     rejects the name before any filesystem access.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  assertSafeRoleForResolution,
  resolveBotCredsStateDir,
} from '../../scripts/lib/resolve-bot-creds-state-dir.mjs';

// Create a unique scratch tree per test so concurrent runs do not
// fight over the same directories. The cleanup in afterEach removes
// the entire tree.
function makeScratchRoot(): string {
  const root = path.join(
    tmpdir(),
    `lag-resolve-creds-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  );
  mkdirSync(root, { recursive: true });
  return root;
}

function writeRoleCreds(stateDir: string, role: string): void {
  const appsDir = path.join(stateDir, 'apps');
  mkdirSync(appsDir, { recursive: true });
  writeFileSync(path.join(appsDir, `${role}.json`), '{}');
}

describe('assertSafeRoleForResolution', () => {
  it('accepts lowercase ascii with hyphens', () => {
    expect(() => assertSafeRoleForResolution('lag-ceo')).not.toThrow();
    expect(() => assertSafeRoleForResolution('a1b2c3')).not.toThrow();
  });

  it('rejects path-traversal characters', () => {
    expect(() => assertSafeRoleForResolution('../etc/passwd')).toThrow(
      /unsafe role name/,
    );
    expect(() => assertSafeRoleForResolution('foo/bar')).toThrow(
      /unsafe role name/,
    );
    expect(() => assertSafeRoleForResolution('foo\\bar')).toThrow(
      /unsafe role name/,
    );
  });

  it('rejects empty string', () => {
    expect(() => assertSafeRoleForResolution('')).toThrow(/unsafe role name/);
  });

  it('rejects non-string', () => {
    expect(() => assertSafeRoleForResolution(null as unknown as string)).toThrow(
      /unsafe role name/,
    );
    expect(() => assertSafeRoleForResolution(undefined as unknown as string)).toThrow(
      /unsafe role name/,
    );
  });

  it('rejects uppercase letters', () => {
    expect(() => assertSafeRoleForResolution('Lag-Ceo')).toThrow(
      /unsafe role name/,
    );
  });

  it('rejects leading and trailing hyphens', () => {
    expect(() => assertSafeRoleForResolution('-foo')).toThrow(/unsafe role name/);
    expect(() => assertSafeRoleForResolution('foo-')).toThrow(/unsafe role name/);
  });
});

describe('resolveBotCredsStateDir', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = makeScratchRoot();
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
    delete process.env.LAG_STATE_DIR;
  });

  it('returns the supplied stateDir on first-hit (no walk-up)', () => {
    const repoRoot = path.join(scratch, 'repo');
    const stateDir = path.join(repoRoot, '.lag');
    writeRoleCreds(stateDir, 'lag-ceo');

    const resolved = resolveBotCredsStateDir(stateDir, 'lag-ceo', { env: undefined });
    expect(resolved).toBe(stateDir);
  });

  it('walks up to a parent .lag/ when the supplied stateDir is missing creds', () => {
    // Layout:
    //   <scratch>/primary/.lag/apps/lag-ceo.json   <-- has creds
    //   <scratch>/primary/.claude/worktrees/agent-x/.lag  <-- no creds
    const primary = path.join(scratch, 'primary');
    const primaryState = path.join(primary, '.lag');
    writeRoleCreds(primaryState, 'lag-ceo');

    const worktree = path.join(primary, '.claude', 'worktrees', 'agent-x');
    const worktreeState = path.join(worktree, '.lag');
    mkdirSync(worktreeState, { recursive: true });

    const resolved = resolveBotCredsStateDir(worktreeState, 'lag-ceo', {
      env: undefined,
    });
    expect(resolved).toBe(primaryState);
  });

  it('walks up multiple levels when intermediate ancestors lack creds', () => {
    // Layout: creds two levels up.
    //   <scratch>/grand/.lag/apps/lag-ceo.json
    //   <scratch>/grand/middle/ (no .lag)
    //   <scratch>/grand/middle/leaf/.lag  (no creds)
    const grand = path.join(scratch, 'grand');
    const grandState = path.join(grand, '.lag');
    writeRoleCreds(grandState, 'lag-ceo');

    const leaf = path.join(grand, 'middle', 'leaf');
    const leafState = path.join(leaf, '.lag');
    mkdirSync(leafState, { recursive: true });

    const resolved = resolveBotCredsStateDir(leafState, 'lag-ceo', {
      env: undefined,
    });
    expect(resolved).toBe(grandState);
  });

  it('falls back to the supplied stateDir when creds are nowhere', () => {
    const repoRoot = path.join(scratch, 'lonely');
    const stateDir = path.join(repoRoot, '.lag');
    mkdirSync(stateDir, { recursive: true });

    const resolved = resolveBotCredsStateDir(stateDir, 'lag-ceo', {
      env: undefined,
    });
    expect(resolved).toBe(stateDir);
  });

  it('honors LAG_STATE_DIR override (skips walk-up)', () => {
    // Even if creds happen to exist higher up, an explicit operator
    // override binds: return the supplied stateDir untouched.
    const primary = path.join(scratch, 'primary');
    const primaryState = path.join(primary, '.lag');
    writeRoleCreds(primaryState, 'lag-ceo');

    const worktree = path.join(primary, '.claude', 'worktrees', 'agent-x');
    const worktreeState = path.join(worktree, '.lag');
    mkdirSync(worktreeState, { recursive: true });

    const resolved = resolveBotCredsStateDir(worktreeState, 'lag-ceo', {
      env: '/srv/canon',
    });
    expect(resolved).toBe(worktreeState);
  });

  it('treats empty LAG_STATE_DIR string as unset (walk-up still applies)', () => {
    const primary = path.join(scratch, 'primary');
    const primaryState = path.join(primary, '.lag');
    writeRoleCreds(primaryState, 'lag-ceo');

    const worktree = path.join(primary, '.claude', 'worktrees', 'agent-x');
    const worktreeState = path.join(worktree, '.lag');
    mkdirSync(worktreeState, { recursive: true });

    const resolved = resolveBotCredsStateDir(worktreeState, 'lag-ceo', {
      env: '',
    });
    expect(resolved).toBe(primaryState);
  });

  it('reads process.env.LAG_STATE_DIR when opts.env is undefined', () => {
    const primary = path.join(scratch, 'primary');
    const primaryState = path.join(primary, '.lag');
    writeRoleCreds(primaryState, 'lag-ceo');

    const worktree = path.join(primary, '.claude', 'worktrees', 'agent-x');
    const worktreeState = path.join(worktree, '.lag');
    mkdirSync(worktreeState, { recursive: true });

    process.env.LAG_STATE_DIR = '/srv/canon';
    const resolved = resolveBotCredsStateDir(worktreeState, 'lag-ceo');
    expect(resolved).toBe(worktreeState);
  });

  it('matches the role exactly: a parent provisioned for a DIFFERENT role is skipped', () => {
    // Layout:
    //   <scratch>/grand/.lag/apps/lag-cto.json    <-- different role
    //   <scratch>/grand/parent/.lag/apps/lag-ceo.json  <-- target role
    //   <scratch>/grand/parent/leaf/.lag  (no creds)
    const grand = path.join(scratch, 'grand');
    writeRoleCreds(path.join(grand, '.lag'), 'lag-cto');

    const parent = path.join(grand, 'parent');
    const parentState = path.join(parent, '.lag');
    writeRoleCreds(parentState, 'lag-ceo');

    const leaf = path.join(parent, 'leaf');
    const leafState = path.join(leaf, '.lag');
    mkdirSync(leafState, { recursive: true });

    const resolved = resolveBotCredsStateDir(leafState, 'lag-ceo', {
      env: undefined,
    });
    expect(resolved).toBe(parentState);
  });

  it('rejects an unsafe role name before touching the filesystem', () => {
    const stateDir = path.join(scratch, '.lag');
    expect(() =>
      resolveBotCredsStateDir(stateDir, '../etc/passwd', { env: undefined }),
    ).toThrow(/unsafe role name/);
    expect(() =>
      resolveBotCredsStateDir(stateDir, 'foo/bar', { env: undefined }),
    ).toThrow(/unsafe role name/);
  });

  it('rejects a non-string stateDir', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolveBotCredsStateDir(null as unknown as string, 'lag-ceo', { env: undefined }),
    ).toThrow(/stateDir must be a non-empty string/);
    expect(() =>
      resolveBotCredsStateDir('', 'lag-ceo', { env: undefined }),
    ).toThrow(/stateDir must be a non-empty string/);
  });
});
