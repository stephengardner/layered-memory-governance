/**
 * Plan terminal-state verifier tests.
 *
 * Coverage:
 *   - module loads (proves src/substrate/claim-verifiers/plan.ts exists);
 *   - match: a plan with plan_state in expectedStates returns ok=true;
 *   - mismatch: a plan with plan_state NOT in expectedStates returns
 *     ok=false plus the observed state for caller telemetry;
 *   - NOT_FOUND: a missing identifier returns ok=false with
 *     observed_state='NOT_FOUND' (substrate-meaningful, not a throw);
 *   - throw on AtomStore error: an underlying AtomStore failure
 *     propagates so the reaper marks the verification verifier-error
 *     rather than silently treating it as a mismatch.
 *
 * The AtomStore is exercised via `createMemoryHost`; tests seed plan
 * atoms via `host.atoms.put`. The throw-case stubs `host.atoms.get`
 * to reject so we never need to monkey-patch the adapter internals.
 */

import { describe, expect, it } from 'vitest';

// Runtime import forces the module to resolve so a missing file fails the run.
import * as planVerifier from '../../../src/substrate/claim-verifiers/plan.js';
import { verifyPlanTerminal } from '../../../src/substrate/claim-verifiers/plan.js';
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
    metadata: { title: 'verifier test plan' },
    plan_state: planState,
  };
}

describe('verifyPlanTerminal', () => {
  it('module loads (proves src/substrate/claim-verifiers/plan.ts exists)', () => {
    expect(planVerifier).toBeDefined();
  });

  it('returns ok=true when plan_state matches one of expected', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('plan-match', 'succeeded'));
    const result = await verifyPlanTerminal(
      'plan-match',
      ['succeeded', 'failed'],
      { host },
    );
    expect(result).toEqual({ ok: true, observed_state: 'succeeded' });
  });

  it('returns ok=false with observed_state when plan_state is not in expected', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('plan-mismatch', 'executing'));
    const result = await verifyPlanTerminal(
      'plan-mismatch',
      ['succeeded', 'failed'],
      { host },
    );
    expect(result).toEqual({ ok: false, observed_state: 'executing' });
  });

  it('returns ok=false NOT_FOUND when atom does not exist', async () => {
    const host = createMemoryHost();
    const result = await verifyPlanTerminal(
      'plan-never-was',
      ['succeeded'],
      { host },
    );
    expect(result).toEqual({ ok: false, observed_state: 'NOT_FOUND' });
  });

  it('throws when AtomStore.get rejects', async () => {
    const host = createMemoryHost();
    // Stub get() to simulate an AtomStore failure (e.g. disk read error
    // in a file-backed adapter). The verifier MUST throw so the caller's
    // markClaimComplete maps it to a verifier-error result rather than
    // silently treating the failure as a mismatch.
    const broken = {
      ...host,
      atoms: new Proxy(host.atoms, {
        get(target, prop, receiver) {
          if (prop === 'get') {
            return async () => {
              throw new Error('atomstore-down');
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }),
    };
    await expect(
      verifyPlanTerminal('plan-x', ['succeeded'], { host: broken }),
    ).rejects.toThrow(/atomstore-down/);
  });

  it('treats a missing plan_state field as a mismatch (observed = UNKNOWN)', async () => {
    // A non-plan atom seeded under the same id has no plan_state. The
    // verifier should NOT throw; it should report UNKNOWN so the caller
    // sees a loud mismatch instead of a coerced terminal state.
    const host = createMemoryHost();
    const noPlanState: Atom = {
      schema_version: 1,
      id: 'not-a-plan' as AtomId,
      content: 'observation body',
      type: 'observation',
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
      metadata: {},
    };
    await host.atoms.put(noPlanState);
    const result = await verifyPlanTerminal('not-a-plan', ['succeeded'], { host });
    expect(result).toEqual({ ok: false, observed_state: 'UNKNOWN' });
  });
});
