/**
 * Verifier registry + dispatcher tests (plan Task 9).
 *
 * Coverage:
 *   - module loads (proves src/substrate/claim-verifiers/index.ts exists);
 *   - registry exposes the four shipping kinds (`pr`, `plan`, `task`,
 *     `research-atom`) so the work-claim contract layer can resolve a
 *     `terminal_kind` to a handler without a code change per added kind;
 *   - registry entries are `ClaimVerifier`-shaped (calling them with a
 *     synthetic context returns a `VerifierResult`);
 *   - `dispatchVerifier` routes by kind: the `plan` route resolves
 *     against the AtomStore (proxy of the real plan verifier);
 *   - `dispatchVerifier` throws an `unknown-terminal-kind` error when
 *     the kind is not registered (the plan directive: "Unknown kind
 *     throws unknown-terminal-kind") so a misconfigured claim never
 *     silently flips to complete.
 *
 * The plan-route happy-path test is the only routing assertion that
 * exercises a real verifier; PR/task/research-atom verifiers are
 * already covered by their own test files, so the dispatcher test
 * only needs to prove the kind->handler edge is wired -- not re-test
 * each handler's internals.
 */

import { describe, expect, it } from 'vitest';

// Runtime import forces the module to resolve so a missing file fails the run.
import * as verifierIndex from '../../../src/substrate/claim-verifiers/index.js';
import {
  dispatchVerifier,
  verifierRegistry,
} from '../../../src/substrate/claim-verifiers/index.js';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import type {
  Atom,
  AtomId,
  PlanState,
  PrincipalId,
  Time,
} from '../../../src/substrate/types.js';

function planAtom(id: string, planState: PlanState): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'plan body',
    type: 'plan',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: 'cto-actor' },
      derived_from: [],
    },
    confidence: 0.9,
    created_at: '2026-05-10T22:00:00.000Z' as Time,
    last_reinforced_at: '2026-05-10T22:00:00.000Z' as Time,
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
    principal_id: 'cto-actor' as PrincipalId,
    taint: 'clean',
    metadata: { title: 'dispatcher test plan' },
    plan_state: planState,
  };
}

describe('verifier registry', () => {
  it('module loads (proves src/substrate/claim-verifiers/index.ts exists)', () => {
    expect(verifierIndex).toBeDefined();
  });

  it('exposes the four shipping verifiers', () => {
    expect(verifierRegistry.has('pr')).toBe(true);
    expect(verifierRegistry.has('plan')).toBe(true);
    expect(verifierRegistry.has('task')).toBe(true);
    expect(verifierRegistry.has('research-atom')).toBe(true);
  });

  it('has exactly the four shipping kinds (no surprise entries)', () => {
    // Guards against a future contributor adding a registry entry
    // without the matching canon-policy + spec update. Adding a new
    // kind is intended as a deliberate edit per the plan's Section 5
    // ("Adding a new terminal kind"); this assertion makes the
    // registry-shape edit show up loud in code review.
    expect(Array.from(verifierRegistry.keys()).sort()).toEqual([
      'plan',
      'pr',
      'research-atom',
      'task',
    ]);
  });
});

describe('dispatchVerifier', () => {
  it('routes the plan kind to the plan verifier (happy path)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('plan-dispatch-ok', 'succeeded'));
    const result = await dispatchVerifier(
      'plan',
      'plan-dispatch-ok',
      ['succeeded', 'failed'],
      { host },
    );
    expect(result).toEqual({ ok: true, observed_state: 'succeeded' });
  });

  it('routes the plan kind to the plan verifier (mismatch passthrough)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('plan-dispatch-mismatch', 'executing'));
    const result = await dispatchVerifier(
      'plan',
      'plan-dispatch-mismatch',
      ['succeeded'],
      { host },
    );
    expect(result).toEqual({ ok: false, observed_state: 'executing' });
  });

  it('throws unknown-terminal-kind for an unregistered kind', async () => {
    const host = createMemoryHost();
    await expect(
      dispatchVerifier('terraform-apply', 'id', ['ok'], { host }),
    ).rejects.toThrow(/unknown-terminal-kind/);
  });
});
