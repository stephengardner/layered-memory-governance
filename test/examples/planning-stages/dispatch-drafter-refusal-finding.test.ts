/**
 * Tests for the dispatch-stage drafter-refusal audit finding.
 *
 * The dispatch-stage's audit() emits a critical finding for each
 * code-author-invoked observation atom scoped to the current pipeline
 * whose executor terminated as a silent-skip no-op with the
 * 'drafter-emitted-empty-diff' reason. Without this finding the
 * pipeline shows as "succeeded" on /pipelines/<id> when the drafter
 * actually refused to ship any diff; visibility into the handoff is
 * the operator-stated north-star (2026-05-12).
 *
 * Reference real-world example: pipeline-cto-1778624059437-cm1f5c
 * dispatched a plan; the drafter refused with a detailed scope-impossibility
 * notes; auditDispatch returned 0 findings because dispatch_status was
 * 'completed'. This test pins the new behavior so future regressions
 * surface here rather than on a live pipeline.
 */

import { describe, expect, it } from 'vitest';
import { auditDispatch } from '../../../examples/planning-stages/dispatch/index.js';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../src/types.js';

const PIPELINE_ID = 'pipeline-corr' as AtomId;
const PLAN_ID = 'plan-drafter-refusal-1' as AtomId;
const OBSERVATION_ID =
  'code-author-invoked-plan-drafter-refusal-1-2026-05-12T22-21-47.366Z-702cee' as AtomId;

/**
 * Build a StageContext suitable for invoking auditDispatch() directly
 * (no full pipeline runner). Mirrors the ctx() helper in
 * dispatch-stage.test.ts but parameterizes the host so tests can seed
 * observation atoms before calling audit().
 */
function ctx(host: ReturnType<typeof createMemoryHost>) {
  return {
    host,
    principal: 'plan-dispatcher' as PrincipalId,
    correlationId: 'corr',
    pipelineId: PIPELINE_ID,
    stageName: 'dispatch-stage',
    verifiedCitedAtomIds: [] as ReadonlyArray<AtomId>,
    verifiedSubActorPrincipalIds: [] as ReadonlyArray<PrincipalId>,
    operatorIntentContent: '',
  };
}

async function seedPlanAtom(
  host: ReturnType<typeof createMemoryHost>,
  id: AtomId,
  pipelineId: AtomId,
): Promise<void> {
  const plan: Atom = {
    schema_version: 1,
    id,
    content: 'plan body',
    type: 'plan',
    layer: 'L0',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: 'cto-actor' },
      derived_from: [pipelineId],
    },
    confidence: 0.9,
    created_at: '2026-05-12T22:00:00.000Z' as Time,
    last_reinforced_at: '2026-05-12T22:00:00.000Z' as Time,
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
    plan_state: 'executing',
    taint: 'clean',
    metadata: {
      delegation: {
        sub_actor_principal_id: 'code-author',
        reason: 'drafter-refusal test',
        implied_blast_radius: 'tooling',
      },
    },
  };
  await host.atoms.put(plan);
}

async function seedDrafterRefusalObservation(
  host: ReturnType<typeof createMemoryHost>,
  observationId: AtomId,
  planId: AtomId,
  notes: string,
): Promise<void> {
  const atom: Atom = {
    schema_version: 1,
    id: observationId,
    content: `code-author invoked for plan ${planId}; drafter refused with empty diff.`,
    type: 'observation',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: 'code-author', tool: 'code-author-invoker' },
      derived_from: [planId],
    },
    confidence: 1.0,
    created_at: '2026-05-12T22:21:47.366Z' as Time,
    last_reinforced_at: '2026-05-12T22:21:47.366Z' as Time,
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
    principal_id: 'code-author' as PrincipalId,
    taint: 'clean',
    metadata: {
      kind: 'code-author-invoked',
      plan_id: planId,
      correlation_id: `dispatch-${planId}`,
      fence_ok: true,
      executor_result: {
        kind: 'noop',
        dispatch_outcome: 'no-op',
        reason: 'drafter-emitted-empty-diff',
        notes,
        model_used: 'claude-opus-4-7',
        confidence: 0.15,
        total_cost_usd: 0.6618,
      },
    },
  };
  await host.atoms.put(atom);
}

describe('auditDispatch - drafter-refusal finding', () => {
  it('emits a critical finding when a pipeline-scoped code-author-invoked observation has executor_result.kind=noop AND reason=drafter-emitted-empty-diff', async () => {
    const host = createMemoryHost();
    await seedPlanAtom(host, PLAN_ID, PIPELINE_ID);
    const drafterNotes =
      'Empty diff with a scope-impossibility flag. The plan target_paths cannot be implemented as written without modifying files outside the declared scope.';
    await seedDrafterRefusalObservation(
      host,
      OBSERVATION_ID,
      PLAN_ID,
      drafterNotes,
    );

    const findings = await auditDispatch(
      {
        dispatch_status: 'completed',
        scanned: 1,
        dispatched: 1,
        failed: 0,
        cost_usd: 0,
      },
      ctx(host),
    );

    expect(findings.length).toBe(1);
    const finding = findings[0];
    expect(finding.severity).toBe('critical');
    expect(finding.category).toBe('dispatch-drafter-refusal');
    expect(finding.message).toContain(PLAN_ID);
    expect(finding.message).toContain('drafter-emitted-empty-diff');
    expect(finding.message).toContain(drafterNotes.slice(0, 50));
    expect(finding.cited_atom_ids).toContain(OBSERVATION_ID);
    expect(finding.cited_atom_ids).toContain(PLAN_ID);
    expect(finding.cited_paths.length).toBe(0);
  });

  it('truncates the drafter notes to the first 1024 chars in the finding message', async () => {
    const host = createMemoryHost();
    await seedPlanAtom(host, PLAN_ID, PIPELINE_ID);
    const longNotes = 'x'.repeat(5000);
    await seedDrafterRefusalObservation(
      host,
      OBSERVATION_ID,
      PLAN_ID,
      longNotes,
    );

    const findings = await auditDispatch(
      {
        dispatch_status: 'completed',
        scanned: 1,
        dispatched: 1,
        failed: 0,
        cost_usd: 0,
      },
      ctx(host),
    );

    expect(findings.length).toBe(1);
    // Message embeds the first 1024 chars of notes; substantially longer
    // notes (5000 chars here) MUST be truncated. The full notes length
    // would push message past 5KB; truncation keeps the audit-finding
    // atom bounded.
    expect(findings[0].message.length).toBeLessThan(2048);
    // The truncated prefix is still present.
    expect(findings[0].message).toContain('x'.repeat(100));
  });

  it('returns 0 findings when dispatch_status=completed and NO drafter-refusal observation exists', async () => {
    const host = createMemoryHost();
    await seedPlanAtom(host, PLAN_ID, PIPELINE_ID);

    const findings = await auditDispatch(
      {
        dispatch_status: 'completed',
        scanned: 1,
        dispatched: 1,
        failed: 0,
        cost_usd: 0,
      },
      ctx(host),
    );

    expect(findings.length).toBe(0);
  });

  it('returns the existing critical "dispatch-gated" finding when dispatch_status=gated (existing behavior unchanged)', async () => {
    const host = createMemoryHost();

    const findings = await auditDispatch(
      {
        dispatch_status: 'gated',
        scanned: 0,
        dispatched: 0,
        failed: 0,
        cost_usd: 0,
        gating_reason: 'review-report not clean and no resume atom present',
      },
      ctx(host),
    );

    expect(findings.length).toBe(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].category).toBe('dispatch-gated');
  });

  it('ignores observation atoms outside the current pipeline scope', async () => {
    const host = createMemoryHost();
    // Plan scoped to a DIFFERENT pipeline; the observation derives from
    // that out-of-scope plan. The audit MUST NOT emit a finding for it
    // when ctx.pipelineId points at PIPELINE_ID.
    const otherPipeline = 'pipeline-other-pipeline-id' as AtomId;
    const otherPlanId = 'plan-other-pipeline-1' as AtomId;
    const otherObservationId = 'observation-other-pipeline-1' as AtomId;
    await seedPlanAtom(host, otherPlanId, otherPipeline);
    await seedDrafterRefusalObservation(
      host,
      otherObservationId,
      otherPlanId,
      'drafter notes for the OTHER pipeline',
    );

    const findings = await auditDispatch(
      {
        dispatch_status: 'completed',
        scanned: 1,
        dispatched: 1,
        failed: 0,
        cost_usd: 0,
      },
      ctx(host),
    );

    expect(findings.length).toBe(0);
  });

  it('ignores observation atoms whose executor_result.kind is NOT noop', async () => {
    const host = createMemoryHost();
    await seedPlanAtom(host, PLAN_ID, PIPELINE_ID);

    // Observation with executor_result.kind = 'dispatched' (success)
    // MUST NOT trigger the drafter-refusal finding.
    const successObservation: Atom = {
      schema_version: 1,
      id: OBSERVATION_ID,
      content: 'code-author invoked; PR opened',
      type: 'observation',
      layer: 'L1',
      provenance: {
        kind: 'agent-observed',
        source: { agent_id: 'code-author', tool: 'code-author-invoker' },
        derived_from: [PLAN_ID],
      },
      confidence: 1.0,
      created_at: '2026-05-12T22:21:47.366Z' as Time,
      last_reinforced_at: '2026-05-12T22:21:47.366Z' as Time,
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
      principal_id: 'code-author' as PrincipalId,
      taint: 'clean',
      metadata: {
        kind: 'code-author-invoked',
        plan_id: PLAN_ID,
        executor_result: {
          kind: 'dispatched',
          pr_url: 'https://example.test/pr/1',
        },
      },
    };
    await host.atoms.put(successObservation);

    const findings = await auditDispatch(
      {
        dispatch_status: 'completed',
        scanned: 1,
        dispatched: 1,
        failed: 0,
        cost_usd: 0,
      },
      ctx(host),
    );

    expect(findings.length).toBe(0);
  });

  it('ignores observation atoms whose executor_result.reason is NOT drafter-emitted-empty-diff', async () => {
    const host = createMemoryHost();
    await seedPlanAtom(host, PLAN_ID, PIPELINE_ID);

    // Observation with executor_result.kind = 'noop' but a different
    // reason (e.g., 'dirty-worktree') MUST NOT trigger the
    // drafter-refusal finding. Scope this audit to the specific
    // drafter-refusal mode the operator wants visibility on.
    const otherNoopObservation: Atom = {
      schema_version: 1,
      id: OBSERVATION_ID,
      content: 'code-author invoked; noop for other reason',
      type: 'observation',
      layer: 'L1',
      provenance: {
        kind: 'agent-observed',
        source: { agent_id: 'code-author', tool: 'code-author-invoker' },
        derived_from: [PLAN_ID],
      },
      confidence: 1.0,
      created_at: '2026-05-12T22:21:47.366Z' as Time,
      last_reinforced_at: '2026-05-12T22:21:47.366Z' as Time,
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
      principal_id: 'code-author' as PrincipalId,
      taint: 'clean',
      metadata: {
        kind: 'code-author-invoked',
        plan_id: PLAN_ID,
        executor_result: {
          kind: 'noop',
          reason: 'dirty-worktree',
          notes: 'worktree was dirty at dispatch time',
        },
      },
    };
    await host.atoms.put(otherNoopObservation);

    const findings = await auditDispatch(
      {
        dispatch_status: 'completed',
        scanned: 1,
        dispatched: 1,
        failed: 0,
        cost_usd: 0,
      },
      ctx(host),
    );

    expect(findings.length).toBe(0);
  });

  it('skips observations whose plan_id resolves to a non-plan atom (type guard)', async () => {
    const host = createMemoryHost();
    // Seed an atom under PLAN_ID whose `type` is NOT 'plan'. The
    // observation references it via plan_id; without the type guard
    // the audit would walk provenance on a non-plan artifact and
    // emit a false refusal finding.
    const nonPlan: Atom = {
      schema_version: 1,
      id: PLAN_ID,
      content: 'unrelated observation that happens to share an id',
      type: 'observation',
      layer: 'L1',
      provenance: {
        kind: 'agent-observed',
        source: { agent_id: 'cto-actor' },
        derived_from: [PIPELINE_ID],
      },
      confidence: 0.9,
      created_at: '2026-05-12T22:00:00.000Z' as Time,
      last_reinforced_at: '2026-05-12T22:00:00.000Z' as Time,
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
    await host.atoms.put(nonPlan);
    await seedDrafterRefusalObservation(
      host,
      OBSERVATION_ID,
      PLAN_ID,
      'notes that should be ignored because plan_id resolves to a non-plan atom',
    );

    const findings = await auditDispatch(
      {
        dispatch_status: 'completed',
        scanned: 1,
        dispatched: 1,
        failed: 0,
        cost_usd: 0,
      },
      ctx(host),
    );

    expect(findings.length).toBe(0);
  });

  it('emits ONE finding per drafter-refusal observation when multiple exist for the same pipeline', async () => {
    const host = createMemoryHost();
    const planAId = 'plan-refusal-A' as AtomId;
    const planBId = 'plan-refusal-B' as AtomId;
    await seedPlanAtom(host, planAId, PIPELINE_ID);
    await seedPlanAtom(host, planBId, PIPELINE_ID);
    await seedDrafterRefusalObservation(
      host,
      'observation-refusal-A' as AtomId,
      planAId,
      'notes A',
    );
    await seedDrafterRefusalObservation(
      host,
      'observation-refusal-B' as AtomId,
      planBId,
      'notes B',
    );

    const findings = await auditDispatch(
      {
        dispatch_status: 'completed',
        scanned: 2,
        dispatched: 2,
        failed: 0,
        cost_usd: 0,
      },
      ctx(host),
    );

    expect(findings.length).toBe(2);
    expect(findings.every((f) => f.severity === 'critical')).toBe(true);
    expect(findings.every((f) => f.category === 'dispatch-drafter-refusal')).toBe(true);
  });
});
