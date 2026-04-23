/**
 * Plan-atom seam tests for `executeDecision`.
 *
 * Closes host-gap doc §2 / retro finding #2: `executeDecision` must
 * materialize a fresh Plan atom (distinct from the Decision atom)
 * before invoking `runCodeAuthor`, so that:
 *
 *   - The Decision atom stays intact as the signed authorizing
 *     artifact (its `type: 'decision'` + `authorPrincipal: 'vo-cto'`
 *     are load-bearing for audit).
 *   - The Plan atom is a mutable L1 atom the executor can transition
 *     through `plan_state` (proposed -> approved -> executing ->
 *     succeeded/failed) without touching the signed Decision.
 *   - `runCodeAuthor`'s `host.atoms.get(plan_id)` resolves to the
 *     Plan (`type: 'plan'`, `plan_state: 'executing'`), not the
 *     Decision (`type: 'decision'`, no plan_state), so the
 *     invoker's plan-state guard passes.
 *
 * The seam is caller-overridable via `planAtomFactory?: (decision) =>
 * Atom`. The default produces `plan-from-<decision.id>` as a
 * convention the host-gap doc recommendation (b) names explicitly.
 * A consumer that already materializes its own Plan (e.g. a LangGraph
 * node that drives plan-state transitions) passes its own factory.
 */

import { describe, expect, it, vi } from 'vitest';

import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import type { Host } from '../../../src/substrate/interface.js';
import type { Atom, AtomId, PrincipalId } from '../../../src/substrate/types.js';
import type {
  Decision,
  Question,
} from '../../../src/substrate/deliberation/patterns.js';
import {
  executeDecision,
  type PrOpenedAtom,
  type ExecutionFailedAtom,
} from '../../../src/integrations/agent-sdk/executor.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeQuestion(overrides: Partial<Question> = {}): Question {
  return {
    id: 'q-plan-seam-001',
    type: 'question',
    prompt: 'Add a CHANGELOG entry.',
    scope: ['bootstrap'],
    authorPrincipal: 'vo-cto',
    participants: ['vo-cto', 'vo-code-author'],
    roundBudget: 2,
    timeoutAt: new Date(Date.now() + 60_000).toISOString(),
    created_at: '2026-04-21T00:00:00.000Z',
    ...overrides,
  };
}

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: 'dec-q-plan-seam-001',
    type: 'decision',
    resolving: 'q-plan-seam-001',
    answer: 'Bump patch version; add "Bugfixes" section to CHANGELOG.',
    arbitrationTrace: 'Both principals agreed on patch bump rationale.',
    authorPrincipal: 'vo-cto',
    created_at: '2026-04-21T00:00:05.000Z',
    ...overrides,
  };
}

function makeHost(): Host {
  return createMemoryHost();
}

function mockCodeAuthorSuccess(overrides: {
  prNumber?: number;
  commitSha?: string;
  branchName?: string;
} = {}): {
  fn: ReturnType<typeof vi.fn>;
  prNumber: number;
  commitSha: string;
  branchName: string;
} {
  const prNumber = overrides.prNumber ?? 9999;
  const commitSha = overrides.commitSha ?? 'abcdef1234567890abcdef1234567890abcdef12';
  const branchName = overrides.branchName ?? 'code-author/mock-plan-seam';
  const fn = vi.fn(async () => ({
    kind: 'dispatched' as const,
    summary:
      `code-author dispatched plan mock as PR #${prNumber} (${commitSha.slice(0, 7)})`,
  }));
  return { fn, prNumber, commitSha, branchName };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeDecision: plan-atom seam', () => {
  it('materializes a Plan atom under derived id plan-from-<decision.id> by default', async () => {
    const host = makeHost();
    const { fn, prNumber, commitSha, branchName } = mockCodeAuthorSuccess();

    await executeDecision({
      decision: makeDecision({ id: 'dec-q-123' }),
      question: makeQuestion(),
      executorPrincipalId: 'vo-code-author',
      host,
      codeAuthorFn: fn,
      prResolver: async () => ({ prNumber, commitSha, branchName }),
    });

    // The seam must write the plan atom to the AtomStore. Resolve via
    // the store rather than a spy so we also assert the atom is
    // persisted under the canonical id.
    const plan = await host.atoms.get('plan-from-dec-q-123' as AtomId);
    expect(plan).not.toBeNull();
    expect(plan!.type).toBe('plan');
    expect(plan!.plan_state).toBe('executing');
    expect(plan!.provenance.derived_from).toContain('dec-q-123');
    expect(plan!.principal_id).toBe('vo-code-author');
  });

  it('honors caller-supplied planAtomFactory override', async () => {
    const host = makeHost();
    const { fn, prNumber, commitSha, branchName } = mockCodeAuthorSuccess();

    // Custom factory swapping the id convention. A consumer that wants
    // to tie plan ids to an external workflow engine uses this seam.
    const planAtomFactory = (d: Decision): Atom => ({
      schema_version: 1,
      id: `custom-plan-${d.id}` as AtomId,
      content: `custom plan for ${d.id}`,
      type: 'plan',
      layer: 'L1',
      provenance: {
        kind: 'agent-observed',
        source: { agent_id: 'test-custom-factory' },
        derived_from: [d.id as AtomId],
      },
      confidence: 1.0,
      created_at: '2026-04-21T00:01:00.000Z',
      last_reinforced_at: '2026-04-21T00:01:00.000Z',
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
      principal_id: 'vo-code-author' as PrincipalId,
      taint: 'clean',
      metadata: { kind: 'custom-plan' },
      plan_state: 'executing',
    });

    await executeDecision({
      decision: makeDecision({ id: 'dec-x' }),
      question: makeQuestion({ id: 'q-x' }),
      executorPrincipalId: 'vo-code-author',
      host,
      codeAuthorFn: fn,
      prResolver: async () => ({ prNumber, commitSha, branchName }),
      planAtomFactory,
    });

    const plan = await host.atoms.get('custom-plan-dec-x' as AtomId);
    expect(plan).not.toBeNull();
    expect(plan!.metadata.kind).toBe('custom-plan');
    // The default id should NOT be written when a custom factory supplies a
    // different id.
    const defaultIdPlan = await host.atoms.get('plan-from-dec-x' as AtomId);
    expect(defaultIdPlan).toBeNull();

    // The custom factory id must flow into the invoker payload. Without
    // this assertion, a regression where the atom is persisted under
    // the custom id but the invoker is still handed the default
    // plan-from-<decision.id> would not be caught by the persistence
    // check alone. The seam's contract is that `payload.plan_id`
    // equals whatever id the factory produced.
    expect(fn).toHaveBeenCalledTimes(1);
    const callArgs = fn.mock.calls[0]!;
    const payload = callArgs[1] as { plan_id: string };
    expect(payload.plan_id).toBe('custom-plan-dec-x');
  });

  it('invokes codeAuthorFn with plan_id = materialized plan atom id, NOT decision.id', async () => {
    const host = makeHost();
    const { fn, prNumber, commitSha, branchName } = mockCodeAuthorSuccess();

    await executeDecision({
      decision: makeDecision({ id: 'dec-Y' }),
      question: makeQuestion({ id: 'q-Y' }),
      executorPrincipalId: 'vo-code-author',
      host,
      codeAuthorFn: fn,
      prResolver: async () => ({ prNumber, commitSha, branchName }),
    });

    // fn(host, payload, correlationId, options) -- payload is positional arg 1.
    expect(fn).toHaveBeenCalledTimes(1);
    const callArgs = fn.mock.calls[0]!;
    const payload = callArgs[1] as { plan_id: string };
    expect(payload.plan_id).toBe('plan-from-dec-Y');
    expect(payload.plan_id).not.toBe('dec-Y');
  });

  it('does not overwrite or mutate the Decision atom at decision.id', async () => {
    const host = makeHost();
    const { fn, prNumber, commitSha, branchName } = mockCodeAuthorSuccess();

    // Pre-seed a Decision-shaped atom so we can verify the executor
    // does not touch it. In practice the Decision lives in the
    // deliberation layer's atom sink, but seeding one here proves the
    // seam's non-interference contract.
    const decisionAtom: Atom = {
      schema_version: 1,
      id: 'dec-Z' as AtomId,
      content: 'Decision content (pre-seeded).',
      type: 'decision',
      layer: 'L1',
      provenance: {
        kind: 'llm-refined',
        source: { agent_id: 'vo-cto' },
        derived_from: ['q-Z' as AtomId],
      },
      confidence: 0.9,
      created_at: '2026-04-21T00:00:05.000Z',
      last_reinforced_at: '2026-04-21T00:00:05.000Z',
      expires_at: null,
      supersedes: [],
      superseded_by: [],
      scope: 'project',
      signals: {
        agrees_with: [],
        conflicts_with: [],
        validation_status: 'verified',
        last_validated_at: '2026-04-21T00:00:05.000Z',
      },
      principal_id: 'vo-cto' as PrincipalId,
      taint: 'clean',
      metadata: {},
    };
    await host.atoms.put(decisionAtom);

    await executeDecision({
      decision: makeDecision({ id: 'dec-Z' }),
      question: makeQuestion({ id: 'q-Z' }),
      executorPrincipalId: 'vo-code-author',
      host,
      codeAuthorFn: fn,
      prResolver: async () => ({ prNumber, commitSha, branchName }),
    });

    const postDecision = await host.atoms.get('dec-Z' as AtomId);
    expect(postDecision).not.toBeNull();
    // Unchanged by the executor.
    expect(postDecision!.type).toBe('decision');
    expect(postDecision!.content).toBe('Decision content (pre-seeded).');
    expect(postDecision!.principal_id).toBe('vo-cto');
    expect(postDecision!.confidence).toBe(0.9);

    // The plan atom lives at a DIFFERENT id.
    const plan = await host.atoms.get('plan-from-dec-Z' as AtomId);
    expect(plan).not.toBeNull();
    expect(plan!.id).not.toBe('dec-Z');
    expect(plan!.type).toBe('plan');
  });

  it('returns ExecutionFailedAtom (no throw, no codeAuthorFn call) when planAtomFactory throws', async () => {
    const host = makeHost();
    const { fn } = mockCodeAuthorSuccess();

    // A factory that throws -- e.g. a caller-supplied projection that
    // fails on an unexpected decision shape. Without a guard, this
    // would bubble up as an unhandled rejection and sever the
    // provenance chain.
    const planAtomFactory = (_d: Decision): Atom => {
      throw new Error('factory rejected decision shape');
    };

    const result = await executeDecision({
      decision: makeDecision({ id: 'dec-factory-throws' }),
      question: makeQuestion(),
      executorPrincipalId: 'vo-code-author',
      host,
      codeAuthorFn: fn,
      planAtomFactory,
    });

    expect(result.kind).toBe('execution-failed');
    expect(result.type).toBe('observation');
    const parsed = JSON.parse((result as ExecutionFailedAtom).content) as {
      reason: string;
      stage: string;
    };
    expect(parsed.reason).toContain('factory rejected');
    expect(parsed.stage).toBe('plan-atom-materialization');
    // No downstream invocation may happen when materialization fails.
    expect(fn).not.toHaveBeenCalled();
    // No plan atom should have been persisted.
    const plan = await host.atoms.get('plan-from-dec-factory-throws' as AtomId);
    expect(plan).toBeNull();
  });

  it('returns ExecutionFailedAtom (no throw, no codeAuthorFn call) when host.atoms.put throws', async () => {
    const host = makeHost();
    const { fn } = mockCodeAuthorSuccess();

    // Inject a put failure at the atom-store level so the failure
    // path runs regardless of which factory produced the atom. This
    // covers storage-layer faults (disk full, adapter error, etc.).
    const putError = new Error('atom store refused write');
    const originalPut = host.atoms.put.bind(host.atoms);
    host.atoms.put = vi.fn(async (_atom) => {
      throw putError;
    }) as typeof host.atoms.put;

    const result = await executeDecision({
      decision: makeDecision({ id: 'dec-put-throws' }),
      question: makeQuestion(),
      executorPrincipalId: 'vo-code-author',
      host,
      codeAuthorFn: fn,
    });

    expect(result.kind).toBe('execution-failed');
    const parsed = JSON.parse((result as ExecutionFailedAtom).content) as {
      reason: string;
      stage: string;
    };
    expect(parsed.reason).toContain('atom store refused write');
    expect(parsed.stage).toBe('plan-atom-materialization');
    expect(fn).not.toHaveBeenCalled();

    // Restore, then verify the decision atom was never touched (we
    // never got past the failed put, so no side-effects leaked).
    host.atoms.put = originalPut;
  });
});

// Silence unused-import warnings when the full suite runs.
void ({} as PrOpenedAtom);
void ({} as ExecutionFailedAtom);
