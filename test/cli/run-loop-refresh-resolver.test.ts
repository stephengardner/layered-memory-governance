/**
 * Tests for the three-state refresh-plan-observations CLI resolver in
 * `src/cli/run-loop.ts`.
 *
 * The CLI surface exposes two flags --refresh-plan-observations and
 * --no-refresh-plan-observations whose presence in argv is load-bearing:
 *
 *   - --refresh-plan-observations present, --no-* absent -> true
 *   - --no-refresh-plan-observations present             -> false
 *   - both absent                                        -> defer to
 *     canon policy `pol-loop-pass-pr-observation-refresh-default`
 *     (`readBooleanCanonPolicy` with fallback `true`)
 *   - both present                                       -> --no-* wins
 *     (mirrors the embed-cache / no-embed-cache pattern)
 *
 * Two helpers are exercised: `resolveCliFlagState` (pure argv parse;
 * returns boolean | null) and `resolveRefreshPlanObservations` (folds
 * the three-state value against canon). Both are exported from
 * src/cli/run-loop.ts so tests run without spawning a subprocess.
 */

import { describe, expect, it } from 'vitest';

import { createMemoryHost } from '../../src/adapters/memory/index.js';
import {
  resolveCliFlagState,
  resolveRefreshPlanObservations,
} from '../../src/cli/run-loop.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../src/types.js';

const NOW = '2026-05-10T00:00:00.000Z' as Time;

function refreshPolicyAtom(enabled: unknown): Atom {
  return {
    schema_version: 1,
    id: 'pol-loop-pass-pr-observation-refresh-default' as AtomId,
    content: 'policy',
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { agent_id: 'bootstrap' },
      derived_from: [],
    },
    confidence: 1,
    created_at: NOW,
    last_reinforced_at: NOW,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: 'apex-agent' as PrincipalId,
    taint: 'clean',
    metadata: {
      policy: {
        subject: 'loop-pass-pr-observation-refresh-default',
        enabled,
      },
    },
  };
}

const POS = '--refresh-plan-observations';
const NEG = '--no-refresh-plan-observations';

describe('resolveCliFlagState', () => {
  it('returns true when only the positive flag is in argv', () => {
    expect(resolveCliFlagState(['node', 'run-loop', POS], POS, NEG)).toBe(true);
  });

  it('returns false when only the negative flag is in argv', () => {
    expect(resolveCliFlagState(['node', 'run-loop', NEG], POS, NEG)).toBe(false);
  });

  it('returns null when neither flag is in argv', () => {
    expect(
      resolveCliFlagState(['node', 'run-loop', '--root-dir', '/tmp'], POS, NEG),
    ).toBe(null);
  });

  it('negative wins when both flags are in argv', () => {
    // Mirrors the --embed-cache / --no-embed-cache pattern: explicit
    // disable always trumps explicit enable. Documented behavior so a
    // future refactor that flips it must update this assertion.
    expect(
      resolveCliFlagState(['node', 'run-loop', POS, NEG], POS, NEG),
    ).toBe(false);
    expect(
      resolveCliFlagState(['node', 'run-loop', NEG, POS], POS, NEG),
    ).toBe(false);
  });

  it('only matches exact tokens (=value form treated as absent)', () => {
    // Node's parseArgs already rejects `--flag=value` for boolean
    // options at the parse layer; this helper enforces the same
    // expectation at the resolution layer for defense-in-depth.
    expect(
      resolveCliFlagState(['node', 'run-loop', `${POS}=true`], POS, NEG),
    ).toBe(null);
  });
});

describe('resolveRefreshPlanObservations', () => {
  it('returns true when cliState is explicit true (canon ignored)', async () => {
    const host = createMemoryHost();
    // Even if canon says false, the explicit CLI flag wins.
    await host.atoms.put(refreshPolicyAtom(false));
    expect(await resolveRefreshPlanObservations(host, true)).toBe(true);
  });

  it('returns false when cliState is explicit false (canon ignored)', async () => {
    const host = createMemoryHost();
    // Even if canon says true, the explicit CLI flag wins.
    await host.atoms.put(refreshPolicyAtom(true));
    expect(await resolveRefreshPlanObservations(host, false)).toBe(false);
  });

  it('returns canon true when cliState is null and policy enabled=true', async () => {
    const host = createMemoryHost();
    await host.atoms.put(refreshPolicyAtom(true));
    expect(await resolveRefreshPlanObservations(host, null)).toBe(true);
  });

  it('returns canon false when cliState is null and policy enabled=false', async () => {
    const host = createMemoryHost();
    await host.atoms.put(refreshPolicyAtom(false));
    expect(await resolveRefreshPlanObservations(host, null)).toBe(false);
  });

  it('returns fallback true when cliState is null and no policy atom exists', async () => {
    // Fresh deployment that hasn't run bootstrap-inbox-canon.mjs yet:
    // the hardcoded fallback in resolveRefreshPlanObservations matches
    // the indie-floor seed (enabled=true) so behavior is identical
    // pre- and post-bootstrap.
    const host = createMemoryHost();
    expect(await resolveRefreshPlanObservations(host, null)).toBe(true);
  });

  it('returns fallback true when cliState is null and policy is malformed', async () => {
    // A malformed payload (operator typed enabled="true" with quotes)
    // falls through to the fallback rather than coercing to truthy
    // garbage. Boolean('false') is true, which would lie.
    const host = createMemoryHost();
    await host.atoms.put(refreshPolicyAtom('false'));
    expect(await resolveRefreshPlanObservations(host, null)).toBe(true);
  });
});
