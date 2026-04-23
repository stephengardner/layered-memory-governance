/**
 * Unit tests for the `decideAction` classifier in
 * scripts/update-branch-if-stale.mjs. Full script-level
 * integration is verified manually against a real PR (documented
 * in docs/dev/auto-update-branch.md); these tests cover the state
 * table the script dispatches on, which is the high-leverage part
 * of the logic.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Static import from the pure-logic sibling. The CLI wrapper
// (scripts/update-branch-if-stale.mjs) carries a `#!/usr/bin/env
// node` shebang, which vitest's Windows transformer appears to
// reject as "Invalid or unexpected token" when imported (three CI
// failures reproduced the issue across local-Windows-green runs).
// Importing the shebang-free library avoids that transformer path
// entirely. See scripts/lib/update-branch-decider.mjs.
import { decideAction } from '../../scripts/lib/update-branch-decider.mjs';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'scripts', 'update-branch-if-stale.mjs',
);

describe('update-branch-if-stale decideAction', () => {
  it('BEHIND -> update', () => {
    const r = decideAction({ mergeStateStatus: 'BEHIND' });
    expect(r.kind).toBe('update');
    expect(r.reason).toContain('BEHIND');
  });

  it('CLEAN -> noop (already fresh)', () => {
    const r = decideAction({ mergeStateStatus: 'CLEAN' });
    expect(r.kind).toBe('noop');
    expect(r.reason).toContain('CLEAN');
  });

  it('HAS_HOOKS -> noop (post-merge hooks are not our problem)', () => {
    const r = decideAction({ mergeStateStatus: 'HAS_HOOKS' });
    expect(r.kind).toBe('noop');
  });

  it('BLOCKED -> noop (required checks failing is a separate concern)', () => {
    const r = decideAction({ mergeStateStatus: 'BLOCKED' });
    expect(r.kind).toBe('noop');
    expect(r.reason).toContain('not a base-staleness issue');
  });

  it('DIRTY -> noop (merge conflicts need a human)', () => {
    const r = decideAction({ mergeStateStatus: 'DIRTY' });
    expect(r.kind).toBe('noop');
  });

  it('DRAFT -> noop (drafts are intentionally not merged)', () => {
    const r = decideAction({ mergeStateStatus: 'DRAFT' });
    expect(r.kind).toBe('noop');
  });

  it('UNSTABLE -> noop (failing checks is a separate concern)', () => {
    const r = decideAction({ mergeStateStatus: 'UNSTABLE' });
    expect(r.kind).toBe('noop');
  });

  it('UNKNOWN -> noop with retry hint', () => {
    const r = decideAction({ mergeStateStatus: 'UNKNOWN' });
    expect(r.kind).toBe('noop');
    expect(r.reason).toContain('UNKNOWN');
    expect(r.reason).toMatch(/retry/i);
  });

  it('an unrecognized value -> unknown (fail-closed, not fail-open)', () => {
    const r = decideAction({ mergeStateStatus: 'MARS_ALIGNED' });
    expect(r.kind).toBe('unknown');
    expect(r.reason).toContain('unrecognized');
    expect(r.reason).toContain('MARS_ALIGNED');
  });

  it('missing mergeStateStatus -> unknown (defensive)', () => {
    const r = decideAction({});
    expect(r.kind).toBe('unknown');
  });

  it('null state -> unknown (defensive)', () => {
    const r = decideAction(null);
    expect(r.kind).toBe('unknown');
  });
});

describe('update-branch-if-stale CLI arg parsing', () => {
  // Driving the script via spawnSync with invalid args exercises the
  // `parseArgs` branch + exit code mapping end-to-end without hitting
  // the network. A missing PR number must exit 2 (not 1, because
  // that code is reserved for update-branch API failures).
  it('exits 2 on missing PR number', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage');
  });

  it('exits 2 on non-numeric PR', () => {
    const r = spawnSync('node', [SCRIPT, 'not-a-number'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('invalid PR number');
  });

  it('exits 2 on unrecognized arg', () => {
    const r = spawnSync('node', [SCRIPT, '123', '--unknown=x'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unrecognized arg');
  });

  it('exits 2 on invalid --actor role shape', () => {
    const r = spawnSync('node', [SCRIPT, '123', '--actor=../etc/passwd'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('invalid --actor role');
  });
});
