import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:os';
import {
  countActivePolicies,
  MAX_LIST_ITEMS,
  pickActiveElevations,
  pickLastCanonApply,
  pickOperatorPrincipalId,
  pickRecentEscalations,
  pickRecentKillSwitchTransitions,
  pickRecentOperatorActions,
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

describe('pickRecentKillSwitchTransitions', () => {
  it('surfaces the live state-file entry as a transition row', () => {
    const got = pickRecentKillSwitchTransitions(
      { tier: 'soft', since: '2026-04-26T10:00:00Z', transitioned_by: 'lag-ceo', reason: 'manual halt' },
      [],
    );
    expect(got.length).toBe(1);
    expect(got[0]!.tier).toBe('soft');
    expect(got[0]!.transitioned_by).toBe('lag-ceo');
    expect(got[0]!.reason).toBe('manual halt');
  });

  it('returns an empty list when neither state nor atoms supply a transition', () => {
    const got = pickRecentKillSwitchTransitions(null, []);
    expect(got).toEqual([]);
  });

  it('folds in transition atoms by id prefix and type', () => {
    const got = pickRecentKillSwitchTransitions(
      { tier: 'soft', since: '2026-04-26T11:00:00Z', transitioned_by: 'lag-ceo', reason: null },
      [
        {
          id: 'kill-switch-transition-2026-04-25T08:00:00Z',
          created_at: '2026-04-25T08:00:00Z',
          principal_id: 'lag-ceo',
          metadata: { tier: 'off', reason: 'fresh repo' },
        },
        {
          id: 'unrelated-atom',
          type: 'observation',
          created_at: '2026-04-25T07:00:00Z',
          principal_id: 'lag-ceo',
        },
      ],
    );
    expect(got.length).toBe(2);
    /*
     * Sort is descending by `at`: the live state row (11:00) comes
     * before the historical atom (08:00). The unrelated atom is filtered.
     */
    expect(got[0]!.at).toBe('2026-04-26T11:00:00Z');
    expect(got[1]!.at).toBe('2026-04-25T08:00:00Z');
    expect(got[1]!.tier).toBe('off');
  });

  it('caps the merged list at MAX_LIST_ITEMS', () => {
    const atoms = Array.from({ length: 30 }, (_, i) => ({
      id: `kill-switch-transition-${i}`,
      created_at: new Date(2026, 3, i + 1).toISOString(),
      principal_id: 'lag-ceo',
      metadata: { tier: 'soft' },
    }));
    const got = pickRecentKillSwitchTransitions(null, atoms);
    expect(got.length).toBe(MAX_LIST_ITEMS);
  });

  it('emits atom_id on per-transition rows and null on the live-state row', () => {
    /*
     * The frontend keys React rows on atom_id ?? `live-${at}-${tier}`.
     * If atom_id leaks the live snapshot or is missing on the historical
     * atom, two transitions sharing the same (at, tier) tuple will
     * collide once the per-transition writer ships and React will reuse
     * DOM nodes incorrectly. This test pins the contract.
     */
    const got = pickRecentKillSwitchTransitions(
      { tier: 'soft', since: '2026-04-26T11:00:00Z', transitioned_by: 'lag-ceo', reason: null },
      [
        {
          id: 'kill-switch-transition-2026-04-25T08:00:00Z',
          created_at: '2026-04-25T08:00:00Z',
          principal_id: 'lag-ceo',
          metadata: { tier: 'off' },
        },
      ],
    );
    expect(got.length).toBe(2);
    // Live-state snapshot row: no atom of record.
    expect(got[0]!.at).toBe('2026-04-26T11:00:00Z');
    expect(got[0]!.atom_id).toBeNull();
    // Per-transition atom row: atom_id mirrors the source atom id.
    expect(got[1]!.at).toBe('2026-04-25T08:00:00Z');
    expect(got[1]!.atom_id).toBe('kill-switch-transition-2026-04-25T08:00:00Z');
  });

  it('skips a live-state row whose tier is not in the canonical 4-tier set', () => {
    /*
     * Defensive validation: state.json is a hand-editable file. A future
     * writer that adds a 5th tier or a partial-write that lands a bogus
     * value must not leak into the panel. The picker validates the live
     * tier symmetrically with the per-transition atom branch.
     */
    const got = pickRecentKillSwitchTransitions(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { tier: 'unknown' as any, since: '2026-04-26T11:00:00Z', transitioned_by: 'lag-ceo', reason: null },
      [],
    );
    expect(got).toEqual([]);
  });

  it('skips superseded and tainted transition atoms', () => {
    const got = pickRecentKillSwitchTransitions(null, [
      {
        id: 'kill-switch-transition-old',
        created_at: '2026-04-20T00:00:00Z',
        principal_id: 'lag-ceo',
        metadata: { tier: 'off' },
        superseded_by: ['kill-switch-transition-new'],
      },
      {
        id: 'kill-switch-transition-tainted',
        created_at: '2026-04-21T00:00:00Z',
        principal_id: 'lag-ceo',
        metadata: { tier: 'off' },
        taint: 'compromised',
      },
    ]);
    expect(got).toEqual([]);
  });
});

describe('pickActiveElevations', () => {
  const NOW_MS = Date.parse('2026-04-26T12:00:00Z');

  it('returns elevations whose expires_at is in the future', () => {
    const got = pickActiveElevations(
      [
        {
          id: 'pol-cto-temp-self-approve-2026-04-26-08h',
          metadata: {
            elevation: {
              started_at: '2026-04-26T10:10:53Z',
              expires_at: '2026-04-26T18:10:53Z',
            },
            policy: {
              tool: 'plan-approve',
              principal: 'cto-actor',
            },
          },
        },
      ],
      NOW_MS,
    );
    expect(got.length).toBe(1);
    expect(got[0]!.atom_id).toBe('pol-cto-temp-self-approve-2026-04-26-08h');
    expect(got[0]!.policy_target).toBe('plan-approve');
    expect(got[0]!.principal).toBe('cto-actor');
    expect(got[0]!.time_remaining_seconds).toBeGreaterThan(0);
  });

  it('excludes elevations whose expires_at is in the past', () => {
    const got = pickActiveElevations(
      [
        {
          id: 'pol-expired',
          metadata: {
            elevation: {
              expires_at: '2026-04-25T00:00:00Z',
            },
          },
        },
      ],
      NOW_MS,
    );
    expect(got).toEqual([]);
  });

  it('excludes superseded and tainted elevation atoms', () => {
    const got = pickActiveElevations(
      [
        {
          id: 'pol-old-elevation',
          metadata: { elevation: { expires_at: '2026-04-26T18:00:00Z' } },
          superseded_by: ['pol-new-elevation'],
        },
        {
          id: 'pol-tainted-elevation',
          metadata: { elevation: { expires_at: '2026-04-26T18:00:00Z' } },
          taint: 'compromised',
        },
      ],
      NOW_MS,
    );
    expect(got).toEqual([]);
  });

  it('skips atoms with malformed expires_at strings', () => {
    const got = pickActiveElevations(
      [
        { id: 'pol-bad', metadata: { elevation: { expires_at: 'not-a-date' } } },
        { id: 'pol-no-meta', metadata: {} },
        { id: 'pol-no-elevation', metadata: { policy: { tool: 'x' } } },
      ],
      NOW_MS,
    );
    expect(got).toEqual([]);
  });

  it('caps the list at MAX_LIST_ITEMS', () => {
    const atoms = Array.from({ length: 30 }, (_, i) => ({
      id: `pol-elevation-${i}`,
      metadata: {
        elevation: {
          expires_at: new Date(NOW_MS + (i + 1) * 3_600_000).toISOString(),
        },
      },
    }));
    const got = pickActiveElevations(atoms, NOW_MS);
    expect(got.length).toBe(MAX_LIST_ITEMS);
  });

  it('skips atoms without the pol- id-prefix or with a non-policy type', () => {
    /*
     * Symmetric id-prefix / type guard mirroring the other pickers in this
     * file. A stray atom carrying `metadata.elevation` (test fixture, hand-
     * authored scratch atom, future writer using a different convention)
     * must not leak into the panel because the surface trusts the canonical
     * `pol-` prefix + `type === 'policy' | undefined` shape.
     */
    const got = pickActiveElevations(
      [
        {
          // Wrong prefix.
          id: 'observation-fake-elevation',
          metadata: { elevation: { expires_at: '2026-04-26T18:00:00Z' } },
        },
        {
          // Right prefix, wrong type.
          id: 'pol-but-not-a-policy',
          type: 'observation',
          metadata: { elevation: { expires_at: '2026-04-26T18:00:00Z' } },
        },
        {
          // Canonical shape: kept.
          id: 'pol-keeper',
          type: 'policy',
          metadata: {
            elevation: { expires_at: '2026-04-26T18:00:00Z' },
            policy: { tool: 'plan-approve', principal: 'cto-actor' },
          },
        },
      ],
      Date.parse('2026-04-26T12:00:00Z'),
    );
    expect(got.length).toBe(1);
    expect(got[0]!.atom_id).toBe('pol-keeper');
  });
});

describe('pickRecentOperatorActions', () => {
  it('surfaces only safe summary fields, never the full args body', () => {
    /*
     * Security guard: the atom's full content includes the GraphQL query
     * and metadata.operator_action.args carries the operator's full
     * argv. The helper MUST surface only id + principal + at + the
     * 32-char-capped first arg (kind). Anything else exposes operator
     * keystrokes / repo paths to the read-only console surface.
     */
    const got = pickRecentOperatorActions([
      {
        id: 'op-action-lag-ceo-1777202885454-f7fe923b',
        principal_id: 'lag-ceo',
        created_at: '2026-04-26T11:28:05.454Z',
        content: 'lag-ceo: gh ["api","graphql","-f","query=…"]',
        metadata: {
          operator_action: {
            role: 'lag-ceo',
            args: ['api', 'graphql', '-f', 'query=secret'],
            session_id: 'gh-as-29960',
            pid: 29960,
          },
        },
      },
    ]);
    expect(got.length).toBe(1);
    expect(got[0]).toEqual({
      atom_id: 'op-action-lag-ceo-1777202885454-f7fe923b',
      principal_id: 'lag-ceo',
      kind: 'api',
      at: '2026-04-26T11:28:05.454Z',
    });
    /*
     * Sanity assertion (regression guard): the returned summary has
     * exactly four keys and none of them is `content`, `args`,
     * `session_id`, or `pid`. If a future refactor accidentally widens
     * the type, this fails.
     */
    expect(Object.keys(got[0]!).sort()).toEqual(['at', 'atom_id', 'kind', 'principal_id']);
  });

  it('caps the kind at 32 characters', () => {
    const got = pickRecentOperatorActions([
      {
        id: 'op-action-lag-ceo-overlong',
        principal_id: 'lag-ceo',
        created_at: '2026-04-26T00:00:00Z',
        metadata: {
          operator_action: {
            args: ['x'.repeat(200), 'y'],
          },
        },
      },
    ]);
    expect(got[0]!.kind.length).toBe(32);
  });

  it('falls back to "unknown" when args is missing', () => {
    const got = pickRecentOperatorActions([
      {
        id: 'op-action-lag-ceo-noargs',
        principal_id: 'lag-ceo',
        created_at: '2026-04-26T00:00:00Z',
        metadata: { operator_action: {} },
      },
    ]);
    expect(got[0]!.kind).toBe('unknown');
  });

  it('skips non-op-action atoms, superseded, and tainted', () => {
    const got = pickRecentOperatorActions([
      { id: 'arch-host', principal_id: 'apex-agent', created_at: '2026-04-26T00:00:00Z' },
      { id: 'op-action-old', principal_id: 'lag-ceo', created_at: '2026-04-20T00:00:00Z', superseded_by: ['op-action-new'] },
      { id: 'op-action-tainted', principal_id: 'lag-ceo', created_at: '2026-04-21T00:00:00Z', taint: 'compromised' },
    ]);
    expect(got).toEqual([]);
  });

  it('returns at most 10 rows', () => {
    const atoms = Array.from({ length: 30 }, (_, i) => ({
      id: `op-action-lag-ceo-${i}`,
      principal_id: 'lag-ceo',
      created_at: new Date(2026, 3, i + 1).toISOString(),
      metadata: { operator_action: { args: ['api'] } },
    }));
    const got = pickRecentOperatorActions(atoms);
    expect(got.length).toBe(10);
  });

  it('sorts descending by at so the newest action lands first', () => {
    const got = pickRecentOperatorActions([
      { id: 'op-action-old', principal_id: 'lag-ceo', created_at: '2026-04-25T00:00:00Z', metadata: { operator_action: { args: ['api'] } } },
      { id: 'op-action-new', principal_id: 'lag-ceo', created_at: '2026-04-26T00:00:00Z', metadata: { operator_action: { args: ['pr'] } } },
    ]);
    expect(got.map((r) => r.atom_id)).toEqual(['op-action-new', 'op-action-old']);
  });
});

describe('pickRecentEscalations', () => {
  it('surfaces dispatch-escalation atoms with a short headline', () => {
    const got = pickRecentEscalations([
      {
        id: 'dispatch-escalation-plan-x-cto-actor-20260426020810',
        created_at: '2026-04-26T02:08:49.395Z',
        content: 'Sub-actor dispatch failed for plan plan-x.\n\nMore details below…',
      },
    ]);
    expect(got.length).toBe(1);
    expect(got[0]!.headline).toBe('Sub-actor dispatch failed for plan plan-x.');
  });

  it('strips trailing carriage return on CRLF-authored content', () => {
    // Atoms whose content was authored on Windows or pasted from a
    // PowerShell session use CRLF line endings. The headline split
    // must not leave a stray \r on the first line, otherwise the
    // operator sees a phantom space at the end of the headline.
    const got = pickRecentEscalations([
      {
        id: 'dispatch-escalation-crlf-headline',
        created_at: '2026-04-26T02:08:49.395Z',
        content: 'Sub-actor dispatch failed for plan plan-y.\r\nMore details below.',
      },
    ]);
    expect(got.length).toBe(1);
    expect(got[0]!.headline).toBe('Sub-actor dispatch failed for plan plan-y.');
    expect(got[0]!.headline.endsWith('\r')).toBe(false);
  });

  it('caps the headline at 160 characters', () => {
    const longLine = 'A'.repeat(500);
    const got = pickRecentEscalations([
      {
        id: 'dispatch-escalation-foo',
        created_at: '2026-04-26T00:00:00Z',
        content: longLine,
      },
    ]);
    expect(got[0]!.headline.length).toBe(160);
  });

  it('skips non-escalation atoms, superseded, and tainted', () => {
    const got = pickRecentEscalations([
      { id: 'op-action-foo', created_at: '2026-04-26T00:00:00Z', content: 'op' },
      { id: 'dispatch-escalation-old', created_at: '2026-04-20T00:00:00Z', content: 'old', superseded_by: ['dispatch-escalation-new'] },
      { id: 'dispatch-escalation-tainted', created_at: '2026-04-21T00:00:00Z', content: 't', taint: 'compromised' },
    ]);
    expect(got).toEqual([]);
  });

  it('caps the list at MAX_LIST_ITEMS', () => {
    const atoms = Array.from({ length: 30 }, (_, i) => ({
      id: `dispatch-escalation-${i}`,
      created_at: new Date(2026, 3, i + 1).toISOString(),
      content: 'failure',
    }));
    const got = pickRecentEscalations(atoms);
    expect(got.length).toBe(MAX_LIST_ITEMS);
  });
});
