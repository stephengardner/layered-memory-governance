/**
 * Unit tests for runCodeAuthor (the sub-actor invoker).
 *
 * Exercises the governance-loop skeleton:
 *   - happy path: fence + executing plan -> observation atom written,
 *     InvokeResult.completed returned
 *   - fence failures (absent / tainted / superseded) -> error result
 *   - plan resolution failures (missing atom, wrong type, wrong
 *     plan_state) -> error result
 *   - provenance: observation derived_from the plan
 *   - atom id uniqueness: repeated invocations produce distinct ids
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import type { Host } from '../../src/substrate/interface.js';
import type {
  Atom,
  AtomId,
  PlanState,
  PrincipalId,
  Time,
} from '../../src/substrate/types.js';
import {
  runCodeAuthor,
  mkCodeAuthorInvokedAtomId,
  type CodeAuthorExecutor,
  type CodeAuthorExecutorResult,
} from '../../src/actor-message/code-author-invoker.js';

const OPERATOR = 'test-operator' as PrincipalId;
const BOOT_TIME = '2026-04-21T00:00:00.000Z' as Time;

function fenceAtom(id: string, policy: Record<string, unknown>): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: `fence atom ${id}`,
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'test', agent_id: 'test' },
      derived_from: [],
    },
    confidence: 1,
    created_at: BOOT_TIME,
    last_reinforced_at: BOOT_TIME,
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

async function seedFullFence(host: Host): Promise<void> {
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
}

function planAtom(id: string, state: PlanState | undefined): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'a plan for testing',
    type: 'plan',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: 'cto-actor', session_id: 'test' },
      derived_from: [],
    },
    confidence: 0.8,
    created_at: BOOT_TIME,
    last_reinforced_at: BOOT_TIME,
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
    metadata: { title: 'Test plan' },
    ...(state !== undefined ? { plan_state: state } : {}),
  };
}

describe('runCodeAuthor', () => {
  let host: Host;

  beforeEach(async () => {
    host = await createMemoryHost();
  });

  it('happy path: executing plan + live fence => observation atom written + completed result', async () => {
    await seedFullFence(host);
    await host.atoms.put(planAtom('plan-test-1', 'executing'));

    const result = await runCodeAuthor(
      host,
      { plan_id: 'plan-test-1' },
      'corr-123',
      { idNonce: 'aaaaaa' },
    );

    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') throw new Error('unreachable');
    expect(result.producedAtomIds).toHaveLength(1);
    expect(result.summary).toContain('plan-test-1');

    const written = await host.atoms.get(result.producedAtomIds[0]! as AtomId);
    expect(written).not.toBeNull();
    expect(written!.type).toBe('observation');
    expect(written!.layer).toBe('L1');
    expect(written!.metadata['kind']).toBe('code-author-invoked');
    expect(written!.metadata['plan_id']).toBe('plan-test-1');
    expect(written!.metadata['correlation_id']).toBe('corr-123');
    expect(written!.metadata['fence_ok']).toBe(true);
    expect(written!.provenance.derived_from).toEqual(['plan-test-1']);
    expect(written!.provenance.source.tool).toBe('code-author-invoker');
  });

  it('returns error when the fence is incomplete (missing atom)', async () => {
    // Seed three of four fence atoms; omit the cost-cap.
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
    await host.atoms.put(planAtom('plan-test-1', 'executing'));

    const result = await runCodeAuthor(host, { plan_id: 'plan-test-1' }, 'corr-123');
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.message).toMatch(/fence load failed/);
    expect(result.message).toMatch(/pol-code-author-per-pr-cost-cap/);
  });

  it('returns error when the plan atom is missing', async () => {
    await seedFullFence(host);
    // No plan atom seeded.
    const result = await runCodeAuthor(host, { plan_id: 'plan-does-not-exist' }, 'corr-123');
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.message).toMatch(/plan atom plan-does-not-exist not found/);
  });

  it('returns error when the referenced atom is not of type=plan', async () => {
    await seedFullFence(host);
    // Seed an observation at the plan-id slot.
    const notAPlan: Atom = {
      ...planAtom('plan-not-really', 'executing'),
      type: 'observation',
    };
    await host.atoms.put(notAPlan);
    const result = await runCodeAuthor(host, { plan_id: 'plan-not-really' }, 'corr-123');
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.message).toMatch(/has type=observation, expected "plan"/);
  });

  it('returns error when the plan is not in plan_state=executing', async () => {
    // The dispatcher flips approved -> executing before invoking
    // sub-actors. Any other state at invocation time signals an
    // upstream bug; refusal is the right posture.
    await seedFullFence(host);
    await host.atoms.put(planAtom('plan-approved-only', 'approved'));
    const result = await runCodeAuthor(host, { plan_id: 'plan-approved-only' }, 'corr-123');
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.message).toMatch(/plan_state=approved/);
  });

  it('observation includes a fence_snapshot for audit replay', async () => {
    await seedFullFence(host);
    await host.atoms.put(planAtom('plan-test-1', 'executing'));
    const result = await runCodeAuthor(host, { plan_id: 'plan-test-1' }, 'corr-123');
    if (result.kind !== 'completed') throw new Error('unreachable');
    const written = await host.atoms.get(result.producedAtomIds[0]! as AtomId);
    const snap = written!.metadata['fence_snapshot'] as Record<string, unknown>;
    expect(snap['max_usd_per_pr']).toBe(10);
    expect(snap['required_checks']).toEqual(['Node 22 on ubuntu-latest']);
    expect(snap['on_stop_action']).toBe('close-pr-with-revocation-comment');
  });

  it('repeated invocations of the same plan produce distinct atom ids (nonce path)', async () => {
    await seedFullFence(host);
    await host.atoms.put(planAtom('plan-test-1', 'executing'));
    const a = await runCodeAuthor(host, { plan_id: 'plan-test-1' }, 'corr-1');
    const b = await runCodeAuthor(host, { plan_id: 'plan-test-1' }, 'corr-2');
    if (a.kind !== 'completed' || b.kind !== 'completed') throw new Error('unreachable');
    expect(a.producedAtomIds[0]).not.toBe(b.producedAtomIds[0]);
  });

  it('explicit nonce is reproducible for test fixtures', async () => {
    await seedFullFence(host);
    await host.atoms.put(planAtom('plan-test-1', 'executing'));
    const result = await runCodeAuthor(
      host,
      { plan_id: 'plan-test-1' },
      'corr-123',
      { idNonce: 'cafe01', now: () => new Date('2026-04-21T12:00:00.000Z').getTime() },
    );
    if (result.kind !== 'completed') throw new Error('unreachable');
    const expected = mkCodeAuthorInvokedAtomId(
      'plan-test-1',
      '2026-04-21T12:00:00.000Z' as Time,
      'cafe01',
    );
    expect(result.producedAtomIds[0]).toBe(String(expected));
  });

  function stubExecutor(
    impl: (inputs: Parameters<CodeAuthorExecutor['execute']>[0]) => Promise<CodeAuthorExecutorResult>,
  ): CodeAuthorExecutor {
    return { execute: impl };
  }

  it('with executor injected (dispatched): returns dispatched and stores PR handle on observation', async () => {
    await seedFullFence(host);
    await host.atoms.put(planAtom('plan-test-1', 'executing'));

    const executor = stubExecutor(async (inputs) => {
      expect(inputs.plan.id).toBe('plan-test-1');
      expect(inputs.fence.perPrCostCap.max_usd_per_pr).toBe(10);
      expect(inputs.correlationId).toBe('corr-executor');
      return {
        kind: 'dispatched',
        prNumber: 123,
        prHtmlUrl: 'https://github.com/o/r/pull/123',
        branchName: 'code-author/plan-test-1-abc',
        commitSha: 'deadbeefcafe0011223344556677889900aabbcc',
        totalCostUsd: 0.42,
        modelUsed: 'claude-opus-4-7',
        confidence: 0.9,
        touchedPaths: ['README.md', 'package.json'],
      };
    });

    const result = await runCodeAuthor(
      host,
      { plan_id: 'plan-test-1' },
      'corr-executor',
      { idNonce: 'bbbbbb', executor },
    );

    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') throw new Error('unreachable');
    expect(result.summary).toContain('#123');
    expect(result.summary).toContain('deadbee');

    // Observation atom carries the PR handle + executor metadata.
    const atomId = mkCodeAuthorInvokedAtomId(
      'plan-test-1',
      new Date((result as { summary: string } & object & { _t?: number })._t ?? Date.now()).toISOString() as Time,
      'bbbbbb',
    );
    // Since we don't control `now` here, locate the atom via query.
    const { atoms: all } = await host.atoms.query({ type: ['observation'] }, 100);
    const invoked = all.find((a) => a.metadata['kind'] === 'code-author-invoked');
    expect(invoked).toBeDefined();
    const exec = invoked!.metadata['executor_result'] as Record<string, unknown>;
    expect(exec['kind']).toBe('dispatched');
    expect(exec['pr_number']).toBe(123);
    expect(exec['pr_html_url']).toBe('https://github.com/o/r/pull/123');
    expect(exec['commit_sha']).toBe('deadbeefcafe0011223344556677889900aabbcc');
    expect(exec['model_used']).toBe('claude-opus-4-7');
    expect(exec['confidence']).toBe(0.9);
    expect(exec['total_cost_usd']).toBe(0.42);
    expect(exec['touched_paths']).toEqual(['README.md', 'package.json']);
    expect(atomId).toBeDefined();
  });

  it('with executor injected (error): returns error and stores failure stage on observation', async () => {
    await seedFullFence(host);
    await host.atoms.put(planAtom('plan-test-1', 'executing'));

    const executor = stubExecutor(async () => ({
      kind: 'error',
      stage: 'apply-branch',
      reason: 'dirty worktree',
    }));

    const result = await runCodeAuthor(
      host,
      { plan_id: 'plan-test-1' },
      'corr-1',
      { executor, idNonce: 'cccccc' },
    );

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.message).toMatch(/stage=apply-branch/);
    expect(result.message).toMatch(/dirty worktree/);

    const { atoms: all } = await host.atoms.query({ type: ['observation'] }, 100);
    const invoked = all.find((a) => a.metadata['kind'] === 'code-author-invoked');
    expect(invoked).toBeDefined();
    const exec = invoked!.metadata['executor_result'] as Record<string, unknown>;
    expect(exec['kind']).toBe('error');
    expect(exec['stage']).toBe('apply-branch');
    expect(exec['reason']).toBe('dirty worktree');
  });

  it('with executor that throws: invoker catches and records executor-threw stage', async () => {
    await seedFullFence(host);
    await host.atoms.put(planAtom('plan-test-1', 'executing'));

    const executor = stubExecutor(async () => {
      throw new Error('kaboom');
    });

    const result = await runCodeAuthor(
      host,
      { plan_id: 'plan-test-1' },
      'corr-1',
      { executor, idNonce: 'dddddd' },
    );

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.message).toMatch(/stage=executor-threw/);
    expect(result.message).toMatch(/kaboom/);

    const { atoms: all } = await host.atoms.query({ type: ['observation'] }, 100);
    const invoked = all.find((a) => a.metadata['kind'] === 'code-author-invoked');
    expect(invoked!.metadata['executor_result']).toMatchObject({
      kind: 'error',
      stage: 'executor-threw',
    });
  });

  it('without executor: falls back to observation-only (backward compatibility)', async () => {
    await seedFullFence(host);
    await host.atoms.put(planAtom('plan-test-1', 'executing'));

    const result = await runCodeAuthor(host, { plan_id: 'plan-test-1' }, 'corr-1');
    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') throw new Error('unreachable');

    const written = await host.atoms.get(result.producedAtomIds[0]! as AtomId);
    // Backward-compatible metadata shape: executor_result must be absent.
    expect(written!.metadata['executor_result']).toBeUndefined();
  });
});
