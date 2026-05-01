/**
 * End-to-end integration test for the deep planning pipeline.
 *
 * Composes all five reference stage adapters (brainstorm, spec, plan,
 * review, dispatch) against a createMemoryHost() fixture and exercises:
 *
 *   - the happy-path 5-stage walk with the runner emitting
 *     pipeline-stage-event atoms whose provenance.derived_from chains
 *     back to the pipeline atom and through it to the seed
 *     operator-intent atom;
 *
 *   - the confabulation regression: a spec atom carrying a fabricated
 *     cited_paths entry causes the review stage's auditor to emit a
 *     critical pipeline-audit-finding, halting the runner with a
 *     pipeline-failed atom;
 *
 *   - the resume-from-stage path: re-running with resumeFromStage
 *     'spec-stage' starts the runner mid-pipeline at spec-stage rather
 *     than re-emitting brainstorm-stage events;
 *
 *   - the malformed stages negative: passing resumeFromStage that does
 *     not match any stage halts at pre-flight with a pipeline-failed
 *     atom citing the unknown-stage cause.
 *
 * Test-seam choices:
 *
 *   - host.llm.judge is stubbed via vi.spyOn so the brainstorm, spec,
 *     and plan stages do not invoke a real LLM. Each stub returns a
 *     deterministic payload keyed on the system prompt; the runner's
 *     outputSchema validation still runs against the stub output.
 *
 *   - The dispatch stage is constructed with an empty SubActorRegistry.
 *     runDispatchTick scans for plan_state='approved' plan atoms; the
 *     runner DOES persist stage outputs as typed atoms (substrate-fix
 *     in PR #stage-output-atom-persistence), so a plan atom IS written
 *     by plan-stage with plan_state='proposed'. Without an approval
 *     transition (the e2e fixture stops at 'proposed'), runDispatchTick
 *     finds zero APPROVED plans and the dispatch-stage runs to
 *     dispatch_status='completed' with scanned=0 / dispatched=0 /
 *     failed=0. The persisted plan atom is queryable via host.atoms.query
 *     and its provenance.derived_from chains back to the pipeline atom.
 *
 *   - The spec stage's auditSpec calls fs.access on cited_paths; the
 *     stubs emit empty cited_paths for the happy-path test and a
 *     guaranteed-unreachable path for the confabulation regression.
 */

import { describe, expect, it, vi } from 'vitest';
import { runPipeline } from '../../../src/runtime/planning-pipeline/runner.js';
import {
  createMemoryHost,
  type MemoryHost,
} from '../../../src/adapters/memory/index.js';
import type { PlanningStage } from '../../../src/runtime/planning-pipeline/types.js';
import type {
  Atom,
  AtomId,
  PrincipalId,
  Time,
} from '../../../src/types.js';
import { brainstormStage } from '../../../examples/planning-stages/brainstorm/index.js';
import { specStage } from '../../../examples/planning-stages/spec/index.js';
import { planStage } from '../../../examples/planning-stages/plan/index.js';
import { reviewStage } from '../../../examples/planning-stages/review/index.js';
import { createDispatchStage } from '../../../examples/planning-stages/dispatch/index.js';
import { SubActorRegistry } from '../../../src/runtime/actor-message/index.js';

const NOW = '2026-04-28T12:00:00.000Z' as Time;
const SEED_INTENT_ID = 'operator-intent-test-1' as AtomId;
const PRINCIPAL = 'cto-actor' as PrincipalId;

function operatorIntentAtom(id: AtomId): Atom {
  return {
    schema_version: 1,
    id,
    content: 'integration-test seed intent',
    type: 'operator-intent',
    layer: 'L1',
    provenance: {
      kind: 'operator-seeded',
      source: { tool: 'test-fixture' },
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
    principal_id: 'operator-principal' as PrincipalId,
    taint: 'clean',
    metadata: {},
  };
}

interface StubPayloads {
  readonly brainstormCitedAtomId?: string;
  readonly specCitedPaths?: ReadonlyArray<string>;
  readonly planDerivedFrom?: ReadonlyArray<string>;
}

/**
 * Install a host.llm.judge spy that dispatches to a canned payload
 * based on the system-prompt content. The reference stage adapters
 * differentiate their prompts by a leading sentence ("You are the
 * brainstorm stage", "You are the spec stage", "You are the plan
 * stage"); matching by substring is robust to incidental prompt edits
 * downstream.
 */
function stubLlm(
  host: MemoryHost,
  payloads: StubPayloads = {},
): void {
  vi.spyOn(host.llm, 'judge').mockImplementation(
    async (_schema: unknown, system: string) => {
      if (system.includes('brainstorm stage')) {
        return {
          output: {
            open_questions: ['what is the goal?'],
            alternatives_surveyed: [
              {
                option: 'option-a',
                rejection_reason:
                  payloads.brainstormCitedAtomId !== undefined
                    ? `superseded by atom:${payloads.brainstormCitedAtomId}`
                    : 'incomplete coverage',
              },
            ],
            decision_points: ['shape'],
            cost_usd: 0,
          },
          metadata: {
            model_used: 'stub',
            input_tokens: -1,
            output_tokens: -1,
            cost_usd: -1,
            latency_ms: 0,
            prompt_fingerprint: 'stub-fp',
            schema_fingerprint: 'stub-fp',
          },
        };
      }
      if (system.includes('spec stage')) {
        return {
          output: {
            goal: 'integration goal',
            body: 'spec body without injection markup',
            cited_paths: payloads.specCitedPaths ?? [],
            cited_atom_ids: [],
            alternatives_rejected: [
              { option: 'opt-x', reason: 'less precise' },
            ],
            cost_usd: 0,
          },
          metadata: {
            model_used: 'stub',
            input_tokens: -1,
            output_tokens: -1,
            cost_usd: -1,
            latency_ms: 0,
            prompt_fingerprint: 'stub-fp',
            schema_fingerprint: 'stub-fp',
          },
        };
      }
      if (system.includes('plan stage')) {
        return {
          output: {
            plans: [
              {
                title: 'integration-plan',
                body: 'plan body',
                derived_from:
                  payloads.planDerivedFrom !== undefined
                    ? [...payloads.planDerivedFrom]
                    : [String(SEED_INTENT_ID)],
                principles_applied: [],
                alternatives_rejected: [
                  { option: 'opt-z', reason: 'higher risk' },
                ],
                what_breaks_if_revisit: 'nothing material',
                confidence: 0.9,
                delegation: {
                  sub_actor_principal_id: 'code-author',
                  reason: 'implements the plan',
                  implied_blast_radius: 'framework',
                },
              },
            ],
            cost_usd: 0,
          },
          metadata: {
            model_used: 'stub',
            input_tokens: -1,
            output_tokens: -1,
            cost_usd: -1,
            latency_ms: 0,
            prompt_fingerprint: 'stub-fp',
            schema_fingerprint: 'stub-fp',
          },
        };
      }
      throw new Error(`stubLlm: unrecognised system prompt: ${system.slice(0, 80)}`);
    },
  );
}

function buildStages(): ReadonlyArray<PlanningStage> {
  const registry = new SubActorRegistry();
  return [
    brainstormStage,
    specStage,
    planStage,
    reviewStage,
    createDispatchStage(registry),
  ];
}

const STAGE_NAMES = [
  'brainstorm-stage',
  'spec-stage',
  'plan-stage',
  'review-stage',
  'dispatch-stage',
] as const;

/**
 * Seed pause_mode='never' policy atoms for each default stage so the
 * pipeline walks end-to-end without halting on the fail-closed HIL
 * default introduced for governance-before-autonomy. Production
 * deployments author equivalent atoms via the bootstrap script; tests
 * inline them so the runner observes substrate-pure policy state.
 */
async function seedPauseNeverPolicies(host: MemoryHost): Promise<void> {
  for (const stageName of STAGE_NAMES) {
    await host.atoms.put({
      schema_version: 1,
      id: `pol-pipeline-stage-hil-${stageName}-test` as AtomId,
      content: `test-fixture pause_mode=never for ${stageName}`,
      type: 'directive',
      layer: 'L3',
      provenance: {
        kind: 'operator-seeded',
        source: { tool: 'test-fixture' },
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
      principal_id: 'operator-principal' as PrincipalId,
      taint: 'clean',
      metadata: {
        policy: {
          subject: 'pipeline-stage-hil',
          stage_name: stageName,
          pause_mode: 'never',
          auto_resume_after_ms: null,
          allowed_resumers: [],
        },
      },
    });
  }
}

/**
 * Build runPipeline options with the standard test seeds + an optional
 * override slice. Centralises the four call sites in this file so each
 * test only declares the field that differs (correlationId, optional
 * resumeFromStage).
 */
function makeRunOptions(
  overrides: { correlationId: string; resumeFromStage?: string },
): {
  principal: PrincipalId;
  correlationId: string;
  seedAtomIds: ReadonlyArray<AtomId>;
  now: () => Time;
  mode: 'substrate-deep';
  stagePolicyAtomId: string;
  resumeFromStage?: string;
} {
  return {
    principal: PRINCIPAL,
    correlationId: overrides.correlationId,
    seedAtomIds: [SEED_INTENT_ID],
    now: () => NOW,
    mode: 'substrate-deep',
    stagePolicyAtomId: 'pol-test',
    ...(overrides.resumeFromStage !== undefined
      ? { resumeFromStage: overrides.resumeFromStage }
      : {}),
  };
}

describe('deep planning pipeline end-to-end', () => {
  it('walks all five default stages and emits a stage-event atom chain rooted at the pipeline atom', async () => {
    const host = createMemoryHost();
    await host.atoms.put(operatorIntentAtom(SEED_INTENT_ID));
    await seedPauseNeverPolicies(host);
    stubLlm(host);

    const result = await runPipeline(
      buildStages(),
      host,
      makeRunOptions({ correlationId: 'corr-e2e-happy' }),
    );

    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') return;

    // Pipeline atom carries the seed operator-intent in its provenance
    // chain; the substrate-level "every atom must carry provenance"
    // contract is the test-target.
    const pipelineAtom = await host.atoms.get(result.pipelineId);
    expect(pipelineAtom).not.toBeNull();
    expect(pipelineAtom!.provenance.derived_from).toContain(SEED_INTENT_ID);
    expect(pipelineAtom!.pipeline_state).toBe('completed');

    // Stage-event atoms exist for every default stage and chain back
    // to the pipeline atom via derived_from.
    const events = await host.atoms.query(
      { type: ['pipeline-stage-event'] },
      500,
    );
    const stageNames = new Set(
      events.atoms
        .filter((a) => a.provenance.derived_from.includes(result.pipelineId))
        .map(
          (a) =>
            (a.metadata as Record<string, unknown>).stage_name as string,
        ),
    );
    expect(stageNames).toEqual(
      new Set([
        'brainstorm-stage',
        'spec-stage',
        'plan-stage',
        'review-stage',
        'dispatch-stage',
      ]),
    );

    // Every stage produced an exit-success event (no failure halt
    // mid-walk).
    const exitSuccesses = events.atoms.filter((a) => {
      const meta = a.metadata as Record<string, unknown>;
      return (
        meta.pipeline_id === result.pipelineId
        && meta.transition === 'exit-success'
      );
    });
    expect(exitSuccesses.length).toBe(5);

    // Stage-output atom persistence regression guard. Each default
    // stage now mints a typed atom whose provenance.derived_from
    // chains back to the pipeline atom (and through it to the seed
    // operator-intent). Without this wiring the dispatch-stage's
    // planFilter found zero plan atoms and dispatch ran vacuously;
    // the dogfeed of 2026-04-30 surfaced the gap. The plan atom
    // type stays 'plan' so console plan-detail and the
    // single-pass dispatch path consume one shape.
    const brainstormPage = await host.atoms.query(
      { type: ['brainstorm-output'] }, 100,
    );
    expect(brainstormPage.atoms.length).toBe(1);
    const specOutputPage = await host.atoms.query(
      { type: ['spec-output'] }, 100,
    );
    expect(specOutputPage.atoms.length).toBe(1);
    const planPage = await host.atoms.query({ type: ['plan'] }, 100);
    expect(planPage.atoms.length).toBeGreaterThanOrEqual(1);
    const planAtom = planPage.atoms.find(
      (a) => a.provenance.derived_from.includes(result.pipelineId),
    );
    expect(planAtom).toBeDefined();
    expect(planAtom!.plan_state).toBe('proposed');
    const reviewPage = await host.atoms.query(
      { type: ['review-report'] }, 100,
    );
    expect(reviewPage.atoms.length).toBe(1);
    const dispatchPage = await host.atoms.query(
      { type: ['dispatch-record'] }, 100,
    );
    expect(dispatchPage.atoms.length).toBe(1);
  });

  it('halts on a fabricated cited_path (confabulation regression)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(operatorIntentAtom(SEED_INTENT_ID));
    await seedPauseNeverPolicies(host);
    // The spec stub emits a cited path that fs.access cannot reach,
    // which is the substrate-level failure mode the review stage
    // exists to catch.
    stubLlm(host, {
      specCitedPaths: ['nonexistent/path/forced-by-test.fabricated'],
    });

    const result = await runPipeline(
      buildStages(),
      host,
      makeRunOptions({ correlationId: 'corr-e2e-confab' }),
    );

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    // The spec stage's auditor catches the unreachable path BEFORE
    // the runner advances to plan/review/dispatch; the failure lands
    // at spec-stage with a critical-audit-finding cause.
    expect(result.failedStageName).toBe('spec-stage');
    expect(result.cause).toMatch(/critical-audit-finding/);

    // A pipeline-audit-finding atom of severity 'critical' was
    // written naming the fabricated path.
    const findings = await host.atoms.query(
      { type: ['pipeline-audit-finding'] },
      500,
    );
    const critical = findings.atoms.find((a) => {
      const meta = a.metadata as Record<string, unknown>;
      return (
        meta.pipeline_id === result.pipelineId && meta.severity === 'critical'
      );
    });
    expect(critical).toBeDefined();
    const meta = critical!.metadata as Record<string, unknown>;
    expect(meta.cited_paths).toEqual(['nonexistent/path/forced-by-test.fabricated']);
  });

  it('resume-from-stage starts mid-pipeline at the named stage', async () => {
    const host = createMemoryHost();
    await host.atoms.put(operatorIntentAtom(SEED_INTENT_ID));
    await seedPauseNeverPolicies(host);
    stubLlm(host);

    const result = await runPipeline(
      buildStages(),
      host,
      makeRunOptions({
        correlationId: 'corr-e2e-resume',
        resumeFromStage: 'spec-stage',
      }),
    );

    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') return;

    // No brainstorm-stage events emitted because the runner started
    // at spec-stage; the resume-from-stage seam skips upstream stages.
    const events = await host.atoms.query(
      { type: ['pipeline-stage-event'] },
      500,
    );
    const stageNames = new Set(
      events.atoms
        .filter((a) => {
          const meta = a.metadata as Record<string, unknown>;
          return meta.pipeline_id === result.pipelineId;
        })
        .map(
          (a) =>
            (a.metadata as Record<string, unknown>).stage_name as string,
        ),
    );
    expect(stageNames.has('brainstorm-stage')).toBe(false);
    expect(stageNames.has('spec-stage')).toBe(true);
    expect(stageNames.has('dispatch-stage')).toBe(true);
  });

  it('halts at pre-flight when resumeFromStage names an unknown stage', async () => {
    const host = createMemoryHost();
    await host.atoms.put(operatorIntentAtom(SEED_INTENT_ID));
    await seedPauseNeverPolicies(host);
    stubLlm(host);

    const result = await runPipeline(
      buildStages(),
      host,
      makeRunOptions({
        correlationId: 'corr-e2e-malformed',
        resumeFromStage: 'never-defined-stage',
      }),
    );

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.failedStageName).toBe('unknown-stage');
    expect(result.cause).toMatch(/resume-from-stage/);

    // A pipeline-failed atom is the terminal artifact for a malformed
    // resume invocation; the runner does not silently no-op.
    const failed = await host.atoms.query({ type: ['pipeline-failed'] }, 100);
    const match = failed.atoms.find((a) => {
      const meta = a.metadata as Record<string, unknown>;
      return meta.pipeline_id === result.pipelineId;
    });
    expect(match).toBeDefined();
  });
});
