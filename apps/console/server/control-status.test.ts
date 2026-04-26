import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:os';
import {
  countActivePolicies,
  pickLastCanonApply,
  pickOperatorPrincipalId,
  readSentinelState,
  resolveSentinelInside,
  SENTINEL_DISPLAY_PATH,
  tierFromKillSwitch,
} from './control-status';

/*
 * control-status helpers are pure (or take an absolute path + return
 * the snapshot). Tests cover:
 *   - tier collapse: off -> soft, soft -> soft, medium -> medium,
 *     hard -> hard (the operator-readable view of the kill-switch tier)
 *   - sentinel resolution: in-tree absolute path is returned;
 *     out-of-tree paths (../ escape) are rejected with null
 *   - sentinel state: file present -> engaged + mtime; absent -> not
 *     engaged + null timestamp; permission denial / EACCES -> not
 *     engaged (fail-safe, never silently report engaged)
 *   - operator principal pick: first root by id; fallback to
 *     'unknown' when no roots exist
 *   - active policy count: layer + supersession + taint filters
 *   - last canon apply: prefers explicit canon-applied atoms, falls
 *     back to newest L3 created_at
 */

describe('tierFromKillSwitch', () => {
  it('collapses off and soft to operator-readable soft', () => {
    expect(tierFromKillSwitch('off')).toBe('soft');
    expect(tierFromKillSwitch('soft')).toBe('soft');
  });
  it('passes medium and hard through', () => {
    expect(tierFromKillSwitch('medium')).toBe('medium');
    expect(tierFromKillSwitch('hard')).toBe('hard');
  });
});

describe('resolveSentinelInside', () => {
  it('returns the absolute path inside the lag dir', () => {
    const lagDir = '/tmp/lag-fixture';
    const got = resolveSentinelInside(lagDir, 'STOP');
    expect(got).not.toBeNull();
    expect(got!.endsWith('STOP')).toBe(true);
  });
  it('rejects paths that traverse outside the lag dir', () => {
    const lagDir = '/tmp/lag-fixture';
    expect(resolveSentinelInside(lagDir, '../STOP')).toBeNull();
    expect(resolveSentinelInside(lagDir, '../../etc/passwd')).toBeNull();
    expect(resolveSentinelInside(lagDir, 'sub/../../escape')).toBeNull();
  });

  it('does not over-reject filenames that contain a ".." substring', () => {
    /*
     * Regression guard: an earlier check used `rel.includes('..')`,
     * which rejected legitimate filenames like `STOP..bak` whose
     * relative path contains `..` as a substring without being a
     * traversal segment. The contract is: only `..` as a complete
     * path component is a traversal.
     */
    const lagDir = '/tmp/lag-fixture';
    expect(resolveSentinelInside(lagDir, 'STOP..bak')).not.toBeNull();
    expect(resolveSentinelInside(lagDir, 'my..config')).not.toBeNull();
  });
});

describe('readSentinelState', () => {
  let lagDir: string;
  let sentinelPath: string;

  beforeEach(async () => {
    lagDir = await mkdtemp(join(tmpdir(), 'lag-cp-'));
    sentinelPath = join(lagDir, 'STOP');
  });

  afterEach(async () => {
    await rm(lagDir, { recursive: true, force: true });
  });

  it('reports engaged + mtime when the sentinel file exists', async () => {
    await writeFile(sentinelPath, 'manual halt 2026-04-26\n', 'utf8');
    const state = await readSentinelState(sentinelPath);
    expect(state.engaged).toBe(true);
    expect(state.engaged_at).not.toBeNull();
    expect(state.engaged_at && Date.parse(state.engaged_at)).toBeGreaterThan(0);
    expect(state.sentinel_path).toBe(SENTINEL_DISPLAY_PATH);
  });

  it('reports not-engaged + null mtime when the sentinel file is absent', async () => {
    const state = await readSentinelState(sentinelPath);
    expect(state.engaged).toBe(false);
    expect(state.engaged_at).toBeNull();
    expect(state.sentinel_path).toBe(SENTINEL_DISPLAY_PATH);
  });

  it('reports not-engaged when the absolute path is null (rejected by traversal)', async () => {
    const state = await readSentinelState(null);
    expect(state.engaged).toBe(false);
    expect(state.engaged_at).toBeNull();
    expect(state.sentinel_path).toBe(SENTINEL_DISPLAY_PATH);
  });

  it('reports not-engaged on stat failure (EACCES, ENOTDIR, broken symlink)', async () => {
    /*
     * Pointing at a nested path under a missing directory triggers an
     * ENOTDIR/ENOENT at stat time; the helper must NOT fail-open to
     * engaged. Operators expect "no STOP, no halt".
     */
    const broken = join(lagDir, 'no-such-dir', 'STOP');
    const state = await readSentinelState(broken);
    expect(state.engaged).toBe(false);
    expect(state.engaged_at).toBeNull();
  });

  it('uses sub-second mtime precision when present', async () => {
    await writeFile(sentinelPath, 'now', 'utf8');
    const state = await readSentinelState(sentinelPath);
    expect(state.engaged).toBe(true);
    /*
     * Exact ISO format is what the UI renders. We sanity-check the
     * shape so a future refactor does not silently switch to epoch
     * milliseconds and break the operator-facing copy.
     */
    expect(state.engaged_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('rejects a symlink as the sentinel even when the target exists', async () => {
    /*
     * Threat model: an actor that can write inside .lag (lower trust
     * than the operator) plants a symlink at .lag/STOP -> /etc/passwd.
     * `path.resolve` is a pure string op, so resolveSentinelInside
     * returns the in-tree path; without an lstat reject, fs.stat would
     * follow the symlink and surface /etc/passwd's mtime as the halt
     * timestamp. The contract is: STOP is a regular file the operator
     * created via `touch`, anything else is "no sentinel".
     *
     * Skipped on Windows where symlink creation requires elevated
     * privileges in CI; the underlying lstat check fires identically
     * on Windows when the privilege is granted.
     */
    if (platform() === 'win32') return;
    const target = join(lagDir, 'real-target');
    await writeFile(target, 'pretend this is /etc/passwd', 'utf8');
    await symlink(target, sentinelPath);
    const state = await readSentinelState(sentinelPath);
    expect(state.engaged).toBe(false);
    expect(state.engaged_at).toBeNull();
  });

  it('rejects a directory as the sentinel', async () => {
    /*
     * Defense in depth: lstat against a directory returns isFile() ==
     * false. A directory-shaped sentinel is not what the operator
     * created via `touch`, so we treat it as "no sentinel" rather
     * than surfacing a directory mtime as a halt timestamp.
     */
    await mkdir(sentinelPath, { recursive: true });
    const state = await readSentinelState(sentinelPath);
    expect(state.engaged).toBe(false);
    expect(state.engaged_at).toBeNull();
  });
});

describe('pickOperatorPrincipalId', () => {
  it('returns the lone root principal', () => {
    const got = pickOperatorPrincipalId([
      { id: 'apex-agent', signed_by: null, active: true },
      { id: 'cto-actor', signed_by: 'apex-agent', active: true },
    ]);
    expect(got).toBe('apex-agent');
  });

  it('returns the first root by id when multiple roots exist', () => {
    const got = pickOperatorPrincipalId([
      { id: 'zeta-root', signed_by: null, active: true },
      { id: 'alpha-root', signed_by: null, active: true },
    ]);
    expect(got).toBe('alpha-root');
  });

  it('skips inactive roots', () => {
    const got = pickOperatorPrincipalId([
      { id: 'old-root', signed_by: null, active: false },
      { id: 'live-root', signed_by: null, active: true },
    ]);
    expect(got).toBe('live-root');
  });

  it('falls back to unknown when no roots exist', () => {
    const got = pickOperatorPrincipalId([
      { id: 'cto-actor', signed_by: 'apex-agent', active: true },
    ]);
    expect(got).toBe('unknown');
  });

  it('prefers a root with role:apex over a role-less root', () => {
    /*
     * Invariant guard: the org bootstrap canon assigns role:apex to
     * the operator root. `actors_governed` elsewhere is
     * `principals - apex`, so the operator-id picker MUST line up
     * with that filter. Putting both kinds of root in the input and
     * asserting the apex one wins makes the coupling explicit.
     */
    const got = pickOperatorPrincipalId([
      { id: 'legacy-root', signed_by: null, active: true },
      { id: 'apex-root', signed_by: null, active: true, role: 'apex' },
    ]);
    expect(got).toBe('apex-root');
  });

  it('returns the first apex root by id when multiple apex roots exist', () => {
    const got = pickOperatorPrincipalId([
      { id: 'zeta-apex', signed_by: null, active: true, role: 'apex' },
      { id: 'alpha-apex', signed_by: null, active: true, role: 'apex' },
    ]);
    expect(got).toBe('alpha-apex');
  });
});

describe('countActivePolicies', () => {
  it('counts L3 atoms with policy type or pol- prefix', () => {
    const n = countActivePolicies([
      { id: 'pol-rate-limit', type: 'preference', layer: 'L3' },
      { id: 'pol-circuit', type: 'directive', layer: 'L3' },
      { id: 'arch-host', type: 'decision', layer: 'L3' },
      { id: 'something', type: 'policy', layer: 'L3' },
    ]);
    expect(n).toBe(3);
  });

  it('excludes superseded policies', () => {
    const n = countActivePolicies([
      { id: 'pol-old', type: 'preference', layer: 'L3', superseded_by: ['pol-new'] },
      { id: 'pol-new', type: 'preference', layer: 'L3' },
    ]);
    expect(n).toBe(1);
  });

  it('excludes tainted policies', () => {
    const n = countActivePolicies([
      { id: 'pol-bad', type: 'preference', layer: 'L3', taint: 'compromised' },
      { id: 'pol-clean', type: 'preference', layer: 'L3', taint: 'clean' },
    ]);
    expect(n).toBe(1);
  });

  it('excludes non-L3 atoms', () => {
    const n = countActivePolicies([
      { id: 'pol-l1-draft', type: 'preference', layer: 'L1' },
      { id: 'pol-live', type: 'preference', layer: 'L3' },
    ]);
    expect(n).toBe(1);
  });
});

describe('pickLastCanonApply', () => {
  it('prefers explicit canon-applied atoms over generic L3 writes', () => {
    const got = pickLastCanonApply([
      { type: 'directive', layer: 'L3', created_at: '2026-04-25T12:00:00Z' },
      { type: 'canon-applied', created_at: '2026-04-20T08:00:00Z' },
    ]);
    expect(got).toBe('2026-04-20T08:00:00Z');
  });

  it('falls back to newest L3 atom when no explicit marker exists', () => {
    const got = pickLastCanonApply([
      { type: 'directive', layer: 'L3', created_at: '2026-04-22T00:00:00Z' },
      { type: 'decision', layer: 'L3', created_at: '2026-04-26T00:00:00Z' },
      { type: 'observation', layer: 'L1', created_at: '2026-04-26T01:00:00Z' },
    ]);
    expect(got).toBe('2026-04-26T00:00:00Z');
  });

  it('returns null when neither explicit markers nor L3 atoms exist', () => {
    const got = pickLastCanonApply([
      { type: 'observation', layer: 'L1', created_at: '2026-04-26T00:00:00Z' },
    ]);
    expect(got).toBeNull();
  });
});
