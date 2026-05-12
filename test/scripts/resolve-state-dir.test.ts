/**
 * Unit tests for scripts/lib/resolve-state-dir.mjs.
 *
 * The helper is consumed by every bootstrap-* canon-seed script, by
 * cr-precheck.mjs, and by the dispatch invoker so a deployment that
 * points LAG_STATE_DIR at a different on-disk path sees every
 * subprocess agree on where canon lives. A drift between the helper
 * and any caller produces a state-dir fork: one process writes atoms
 * to <repoRoot>/.lag, the next reads from $LAG_STATE_DIR and sees
 * nothing.
 *
 * Behaviour pinned:
 *   - LAG_STATE_DIR unset -> <repoRoot>/.lag (indie-floor default).
 *   - LAG_STATE_DIR absolute -> path.resolve(env), unchanged.
 *   - LAG_STATE_DIR relative -> resolved against cwd (matches
 *     path.resolve semantics; the helper does NOT join with repoRoot
 *     because the env var is the operator override and operators
 *     supply absolute paths by convention).
 *   - LAG_STATE_DIR empty string -> treated as unset (typical
 *     `LAG_STATE_DIR= node ...` accident shape from a shell that
 *     exports the var with no value).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

import { resolveStateDir } from '../../scripts/lib/resolve-state-dir.mjs';

describe('resolveStateDir', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.LAG_STATE_DIR;
    delete process.env.LAG_STATE_DIR;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.LAG_STATE_DIR;
    } else {
      process.env.LAG_STATE_DIR = originalEnv;
    }
  });

  it('falls back to <repoRoot>/.lag when LAG_STATE_DIR is unset', () => {
    const repoRoot = path.resolve('/tmp/lag-repo');
    expect(resolveStateDir(repoRoot)).toBe(path.join(repoRoot, '.lag'));
  });

  it('honors LAG_STATE_DIR when set to an absolute path', () => {
    const target = path.resolve('/var/lib/lag-state');
    process.env.LAG_STATE_DIR = target;
    expect(resolveStateDir('/tmp/lag-repo')).toBe(target);
  });

  it('resolves LAG_STATE_DIR to an absolute path when set to a relative path', () => {
    process.env.LAG_STATE_DIR = './relative-state-dir';
    expect(resolveStateDir('/tmp/lag-repo')).toBe(path.resolve('./relative-state-dir'));
  });

  it('falls back to <repoRoot>/.lag when LAG_STATE_DIR is the empty string', () => {
    const repoRoot = path.resolve('/tmp/lag-repo');
    process.env.LAG_STATE_DIR = '';
    expect(resolveStateDir(repoRoot)).toBe(path.join(repoRoot, '.lag'));
  });

  it('ignores the repoRoot argument when LAG_STATE_DIR is set', () => {
    const target = path.resolve('/srv/canon');
    process.env.LAG_STATE_DIR = target;
    expect(resolveStateDir('/totally/unrelated/path')).toBe(target);
  });
});
