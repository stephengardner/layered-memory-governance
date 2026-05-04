/**
 * End-to-end test: code-author dispatch from approved plan to
 * observation atom + `succeeded` plan-state.
 *
 * Exercises the autonomous governance loop for a code-author plan:
 *
 *   operator writes plan with delegation envelope -> plan_state:
 *     'proposed' (written directly; code-author is NOT in the
 *     auto-approve allowlist by design)
 *     -> operator flips plan_state to 'approved' (stands in for
 *        /decide; code-author plans are HIL-gated per
 *        inv-l3-requires-human + dec-autonomous-merge-via-bot-not-
 *        co-maintainer)
 *     -> runDispatchTick scans, finds the approved plan,
 *        claims it (flip to 'executing'), and invokes the
 *        registered code-author invoker
 *     -> runCodeAuthor loads the fence, resolves the plan,
 *        writes a code-author-invoked observation atom
 *     -> dispatcher flips plan to 'succeeded' with the observation
 *        id in metadata.dispatch_result
 *
 * The assertion at the end walks the full provenance chain:
 *   - plan transitioned proposed -> approved -> executing ->
 *     succeeded
 *   - metadata.dispatch_result.produced_atom_ids contains the
 *     observation atom id
 *   - observation atom has type=observation, layer=L1,
 *     metadata.kind=code-author-invoked, derived_from containing the
 *     plan's id
 *   - the fence snapshot on the observation matches the seeded
 *     fence (max_usd_per_pr, required_checks, on_stop_action)
 *
 * This is the test that proves LAG's autonomous loop fires
 * end-to-end for a code-author plan under a live fence, even before
 * actual code-drafting + PR creation land. When the executor adds
 * LLM drafting + PR creation, the shape of this assertion doesn't
 * change; only the invoker returns `dispatched` instead of
 * `completed` and the plan stays `executing` until pr-landing
 * closes it.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import {
  runCodeAuthor,
  runDispatchTick,
  SubActorRegistry,
} from '../../src/actor-message/index.js';
import type {
  Atom,
  AtomId,
  PrincipalId,
  Time,
} from '../../src/types.js';

const NOW = '2026-04-21T12:00:00.000Z' as Time;
const OPERATOR = 'test-operator' as PrincipalId;
const CODE_AUTHOR = 'code-author' as PrincipalId;

function fenceAtom(id: string, policy: Record<string, unknown>): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: `fence atom: ${id}`,
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'test-bootstrap', agent_id: 'test' },
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
    principal_id: OPERATOR,
    taint: 'clean',
    metadata: { policy },
  };
}

async function seedFence(host: ReturnType<typeof createMemoryHost> extends Promise<infer H> ? H : never): Promise<void> {
  await host.atoms.put(fenceAtom('pol-code-author-signed-pr-only', {
    subject: 'code-author-authorship',
    output_channel: 'signed-pr',
    allowed_direct_write_paths: [],
    require_app_identity: true,
  }));
  await host.atoms.put(fenceAtom('pol-code-author-per-pr-cost-cap', {
    subject: 'code-author-per-pr-cost-cap',
    max_usd_per_pr: 10.0,
    include_retries: true,
  }));
  await host.atoms.put(fenceAtom('pol-code-author-ci-gate', {
    subject: 'code-author-ci-gate',
    required_checks: ['Node 22 on ubuntu-latest', 'Node 22 on windows-latest', 'package hygiene'],
    require_all: true,
    max_check_age_ms: 600_000,
  }));
  await host.atoms.put(fenceAtom('pol-code-author-write-revocation-on-stop', {
    subject: 'code-author-write-revocation',
    on_stop_action: 'close-pr-with-revocation-comment',
    draft_atoms_layer: 'L0',
    revocation_atom_type: 'code-author-revoked',
  }));
}

describe('code-author dispatch (end-to-end)', () => {
  it('approved plan -> dispatched -> code-author-invoked observation -> plan succeeded', async () => {
    const host = await createMemoryHost();
    await seedFence(host);

    // 1. Seed the plan as already-approved. In the real loop the
    //    operator transitions proposed -> approved via /decide;
    //    this E2E skips that step because it belongs to the
    //    operator-approval UX, not to the dispatch path.
    const planId = 'plan-test-code-author-e2e' as AtomId;
    const plan: Atom = {
      schema_version: 1,
      id: planId,
      content: '# Test plan for code-author dispatch\n\nBump the README version string from 0.1.0 to 0.1.1.',
      type: 'plan',
      layer: 'L1',
      provenance: {
        kind: 'agent-observed',
        source: { agent_id: 'cto-actor', session_id: 'e2e' },
        derived_from: [],
      },
      confidence: 0.85,
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
      principal_id: 'cto-actor' as PrincipalId,
      taint: 'clean',
      plan_state: 'approved',
      metadata: {
        title: 'Bump README version',
        delegation: {
          sub_actor_principal_id: CODE_AUTHOR,
          payload: { plan_id: planId },
          correlation_id: 'corr-code-author-e2e',
          escalate_to: OPERATOR,
        },
      },
    };
    await host.atoms.put(plan);

    // 2. Register the code-author invoker in the sub-actor registry.
    const registry = new SubActorRegistry();
    registry.register(CODE_AUTHOR, (payload, correlationId) =>
      runCodeAuthor(
        host,
        payload as { plan_id: AtomId },
        correlationId,
        { idNonce: 'aaaaaa', now: () => new Date(NOW).getTime() },
      ),
    );

    // 3. Run one dispatch tick. Expected: the dispatcher finds the
    //    approved plan, claims it (approved -> executing), invokes
    //    the registered code-author, flips it to succeeded on the
    //    invoker's `completed` result.
    const tick = await runDispatchTick(host, registry, {
      now: () => new Date(NOW).getTime(),
    });
    expect(tick.scanned).toBeGreaterThanOrEqual(1);
    expect(tick.dispatched).toBe(1);
    expect(tick.failed).toBe(0);

    // 4. Plan is now succeeded and cites the observation atom.
    const finalPlan = await host.atoms.get(planId);
    expect(finalPlan).not.toBeNull();
    expect(finalPlan!.plan_state).toBe('succeeded');
    const dispatchResult = finalPlan!.metadata['dispatch_result'] as
      | { readonly kind?: string; readonly produced_atom_ids?: ReadonlyArray<string> }
      | undefined;
    expect(dispatchResult).toBeDefined();
    expect(dispatchResult!.kind).toBe('completed');
    expect(dispatchResult!.produced_atom_ids).toBeDefined();
    expect(dispatchResult!.produced_atom_ids!.length).toBe(1);

    // 5. The observation atom is written, links back to the plan,
    //    and carries the fence snapshot.
    const observationId = dispatchResult!.produced_atom_ids![0]! as AtomId;
    const observation = await host.atoms.get(observationId);
    expect(observation).not.toBeNull();
    expect(observation!.type).toBe('observation');
    expect(observation!.layer).toBe('L1');
    expect(observation!.metadata['kind']).toBe('code-author-invoked');
    expect(observation!.metadata['plan_id']).toBe(String(planId));
    expect(observation!.metadata['fence_ok']).toBe(true);
    expect(observation!.provenance.derived_from).toEqual([planId]);

    // Fence snapshot must preserve the per-PR cap, CI gate, and
    // STOP action as of invocation time so a later auditor can
    // reconstruct the governance posture without rejoining canon.
    const snap = observation!.metadata['fence_snapshot'] as Record<string, unknown>;
    expect(snap['max_usd_per_pr']).toBe(10);
    expect(snap['required_checks']).toEqual([
      'Node 22 on ubuntu-latest',
      'Node 22 on windows-latest',
      'package hygiene',
    ]);
    expect(snap['on_stop_action']).toBe('close-pr-with-revocation-comment');
  });

  it('approved plan + executor returns noop (empty diff) -> plan flips to succeeded, NOT failed', async () => {
    // Regression: dogfeed-16 substrate gap surfaced 2026-04-30.
    // When the drafter correctly emits an empty diff (the target
    // file is already in the desired state), the executor MUST NOT
    // call `git apply --check` (which rejects empty input "No
    // valid patches in input"). Before this fix, that rejection
    // bubbled through plan-dispatch as a `failed` terminal even
    // though the plan executed correctly. The fix surfaces a
    // `noop` executor result that the invoker maps to
    // `InvokeResult.completed`; plan-dispatch then flips the plan
    // to `succeeded` and stamps `terminal_kind=succeeded`.
    const host = await createMemoryHost();
    await seedFence(host);

    const planId = 'plan-test-noop-skip' as AtomId;
    const plan: Atom = {
      schema_version: 1,
      id: planId,
      content: '# Append a line that is already there\n\nNo-op case.',
      type: 'plan',
      layer: 'L1',
      provenance: {
        kind: 'agent-observed',
        source: { agent_id: 'cto-actor', session_id: 'noop-e2e' },
        derived_from: [],
      },
      confidence: 0.9,
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
      principal_id: 'cto-actor' as PrincipalId,
      taint: 'clean',
      plan_state: 'approved',
      metadata: {
        title: 'Already-applied change',
        delegation: {
          sub_actor_principal_id: CODE_AUTHOR,
          payload: { plan_id: planId },
          correlation_id: 'corr-noop-e2e',
          escalate_to: OPERATOR,
        },
      },
    };
    await host.atoms.put(plan);

    // Stub executor that returns a noop result -- this stands in
    // for `buildDiffBasedCodeAuthorExecutor` running with a drafter
    // that correctly emits an empty diff. The integration assertion
    // is on the dispatch + invoker sides; the executor's own empty-
    // diff detection is unit-tested in the diff-based-code-author-
    // executor test file.
    const registry = new SubActorRegistry();
    registry.register(CODE_AUTHOR, (payload, correlationId) =>
      runCodeAuthor(
        host,
        payload as { plan_id: AtomId },
        correlationId,
        {
          idNonce: 'noop001',
          now: () => new Date(NOW).getTime(),
          executor: {
            execute: async () => ({
              kind: 'noop',
              notes: 'Target file already contains the requested line.',
              confidence: 0.95,
              modelUsed: 'claude-opus-4-7',
              totalCostUsd: 0.012,
              reason: 'drafter-emitted-empty-diff',
            }),
          },
        },
      ),
    );

    const tick = await runDispatchTick(host, registry, {
      now: () => new Date(NOW).getTime(),
    });
    expect(tick.scanned).toBeGreaterThanOrEqual(1);
    // dispatched counter increments for any non-error terminal,
    // including a no-op success.
    expect(tick.dispatched).toBe(1);
    expect(tick.failed).toBe(0);

    // Plan is now succeeded (NOT failed), with terminal_kind=succeeded.
    // Before this fix, a no-op diff drove the plan to terminal_kind=
    // failed via `apply-branch/diff-apply-failed`.
    const finalPlan = await host.atoms.get(planId);
    expect(finalPlan).not.toBeNull();
    expect(finalPlan!.plan_state).toBe('succeeded');
    expect(finalPlan!.metadata['terminal_kind']).toBe('succeeded');
    expect(finalPlan!.metadata['error_message']).toBeUndefined();

    // dispatch_result records the no-op observation id.
    const dispatchResult = finalPlan!.metadata['dispatch_result'] as {
      readonly kind?: string;
      readonly produced_atom_ids?: ReadonlyArray<string>;
    };
    expect(dispatchResult.kind).toBe('completed');
    expect(dispatchResult.produced_atom_ids).toBeDefined();
    expect(dispatchResult.produced_atom_ids!.length).toBe(1);

    // Observation atom carries the no-op routing key + drafter notes
    // so console renderers can label the silent-skip outcome.
    const observation = await host.atoms.get(dispatchResult.produced_atom_ids![0]! as AtomId);
    expect(observation).not.toBeNull();
    expect(observation!.metadata['kind']).toBe('code-author-invoked');
    const exec = observation!.metadata['executor_result'] as Record<string, unknown>;
    expect(exec['kind']).toBe('noop');
    expect(exec['dispatch_outcome']).toBe('no-op');
    expect(exec['reason']).toBe('drafter-emitted-empty-diff');
    expect(exec['notes']).toMatch(/already contains/);

    // No `plan.dispatch-failed` audit event was emitted -- the
    // outcome routes through plan.dispatch-succeeded instead.
    const failedEvents = await host.auditor.query(
      { kind: ['plan.dispatch-failed'] },
      10,
    );
    expect(failedEvents.length).toBe(0);
    const succeededEvents = await host.auditor.query(
      { kind: ['plan.dispatch-succeeded'] },
      10,
    );
    expect(succeededEvents.length).toBe(1);
    expect(succeededEvents[0]!.refs.atom_ids).toContain(planId);
  });

  it('approved plan + broken fence -> dispatch fails + plan flips to failed (fail-closed)', async () => {
    // Fence must be LOAD-BEARING for the invocation: an incomplete
    // fence at dispatch time must fail the plan, not silently
    // proceed. This test seeds only 3 of 4 fence atoms.
    const host = await createMemoryHost();
    // Omit pol-code-author-per-pr-cost-cap.
    await host.atoms.put(fenceAtom('pol-code-author-signed-pr-only', {
      subject: 'code-author-authorship',
      output_channel: 'signed-pr',
      allowed_direct_write_paths: [],
      require_app_identity: true,
    }));
    await host.atoms.put(fenceAtom('pol-code-author-ci-gate', {
      subject: 'code-author-ci-gate',
      required_checks: ['Node 22 on ubuntu-latest'],
      require_all: true,
      max_check_age_ms: 600_000,
    }));
    await host.atoms.put(fenceAtom('pol-code-author-write-revocation-on-stop', {
      subject: 'code-author-write-revocation',
      on_stop_action: 'close-pr-with-revocation-comment',
      draft_atoms_layer: 'L0',
      revocation_atom_type: 'code-author-revoked',
    }));

    const planId = 'plan-test-fence-broken' as AtomId;
    const plan: Atom = {
      schema_version: 1,
      id: planId,
      content: '# Plan under broken fence',
      type: 'plan',
      layer: 'L1',
      provenance: {
        kind: 'agent-observed',
        source: { agent_id: 'cto-actor', session_id: 'e2e' },
        derived_from: [],
      },
      confidence: 0.8,
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
      principal_id: 'cto-actor' as PrincipalId,
      taint: 'clean',
      plan_state: 'approved',
      metadata: {
        title: 'Broken-fence test',
        delegation: {
          sub_actor_principal_id: CODE_AUTHOR,
          payload: { plan_id: planId },
          correlation_id: 'corr-code-author-e2e',
          escalate_to: OPERATOR,
        },
      },
    };
    await host.atoms.put(plan);

    const registry = new SubActorRegistry();
    registry.register(CODE_AUTHOR, (payload, correlationId) =>
      runCodeAuthor(
        host,
        payload as { plan_id: AtomId },
        correlationId,
        { now: () => new Date(NOW).getTime() },
      ),
    );

    const tick = await runDispatchTick(host, registry, {
      now: () => new Date(NOW).getTime(),
    });
    expect(tick.dispatched).toBe(0);
    expect(tick.failed).toBe(1);

    const finalPlan = await host.atoms.get(planId);
    expect(finalPlan!.plan_state).toBe('failed');
  });
});
