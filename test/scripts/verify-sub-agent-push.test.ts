/**
 * Smoke tests for `scripts/verify-sub-agent-push.mjs`.
 *
 * The script's behavior depends on real git + gh CLI state, which is
 * unreliable to mock. These tests cover the parser branches that do not
 * require external state: the usage path and the unrecognized-flag
 * paths exit fast with the expected error code BEFORE any git or gh
 * call runs. The end-to-end against-origin path is exercised by the
 * smoke command in the PR description rather than CI.
 *
 * Substrate posture: this script is a deployment-shell tool, not a
 * framework primitive. Tests live under test/scripts/ alongside other
 * shell helpers (intend, gh-as, git-as) and import the script via its
 * module-level functions where possible.
 */

import { describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/verify-sub-agent-push.mjs');

describe('verify-sub-agent-push.mjs (parser + early-exit paths)', () => {
  it('exits 5 with usage on no arguments', async () => {
    const r = await execa('node', [SCRIPT], { reject: false });
    expect(r.exitCode).toBe(5);
    expect(r.stderr).toMatch(/--branch is required/);
    expect(r.stderr).toMatch(/usage:/);
  });

  it('exits 5 with usage on --help', async () => {
    const r = await execa('node', [SCRIPT, '--help'], { reject: false });
    expect(r.exitCode).toBe(5);
    expect(r.stderr).toMatch(/usage:/);
  });

  it('exits 5 with usage on unknown flag', async () => {
    const r = await execa('node', [SCRIPT, '--something'], { reject: false });
    expect(r.exitCode).toBe(5);
    expect(r.stderr).toMatch(/unknown argument: --something/);
  });

  it('exits 5 with usage on non-numeric --expect-pr', async () => {
    const r = await execa('node', [SCRIPT, '--branch', 'x', '--expect-pr', 'not-a-number'], { reject: false });
    expect(r.exitCode).toBe(5);
    expect(r.stderr).toMatch(/--expect-pr must be a positive integer/);
  });

  it('exits 5 with usage on negative --expect-pr', async () => {
    const r = await execa('node', [SCRIPT, '--branch', 'x', '--expect-pr', '-1'], { reject: false });
    expect(r.exitCode).toBe(5);
    expect(r.stderr).toMatch(/--expect-pr must be a positive integer/);
  });
});

describe('verify-sub-agent-push.mjs (missing-branch path)', () => {
  it('exits 1 with missing-branch JSON for a branch that does not exist on origin', async () => {
    // Use a UUID-shaped branch name that is guaranteed not to exist on
    // origin. The script fetches origin, then ls-remote returns empty
    // for an unknown branch, exit 1.
    const fakeBranch = 'no-such-branch-2026-05-08-test-fixture-xyz123';
    const r = await execa('node', [SCRIPT, '--branch', fakeBranch], { reject: false });
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('missing-branch');
    expect(parsed.branch).toBe(fakeBranch);
  }, { timeout: 30_000 });
});
