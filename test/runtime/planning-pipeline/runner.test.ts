import { describe, expect, it, vi } from 'vitest';
import { runPipeline } from '../../../src/runtime/planning-pipeline/runner.js';
import {
  createMemoryHost,
  type MemoryHost,
} from '../../../src/adapters/memory/index.js';
import type { PlanningStage } from '../../../src/runtime/planning-pipeline/types.js';
import type { AtomId, PrincipalId, Time } from '../../../src/types.js';

const NOW = '2026-04-28T12:00:00.000Z' as Time;

function mkStage<TIn, TOut>(
  name: string,
  runFn: (i: TIn) => TOut,
  atomType = 'spec',
): PlanningStage<TIn, TOut> {
  return {
    name,
    async run(input) {
      return {
        value: runFn(input.priorOutput),
        cost_usd: 0,
        duration_ms: 0,
        atom_type: atomType,
      };
    },
  };
}

/**
 * Build a stage whose run() throws synchronously. Test fixtures use
 * this to drive the failure path through failPipeline + the
 * exit-failure event emit. Extracted at N=2+ per the duplication-floor
 * canon (`dev-extract-helper-at-n2`).
 */
function mkThrowingStage(
  name = 'fail-stage',
  message = 'boom',
): PlanningStage<unknown, unknown> {
  return {
    name,
    async run() {
      throw new Error(message);
    },
  };
}

/**
 * Seed pause_mode='never' policy atoms for the supplied stage names so
 * the runner does not halt on the fail-closed HIL default. Test
 * fixtures inline the policy because production deployments author it
 * via the bootstrap script.
 */
async function seedPauseNeverPolicies(
  host: MemoryHost,
  stageNames: ReadonlyArray<string>,
): Promise<void> {
  for (const stageName of stageNames) {
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

describe('runPipeline', () => {
  it('advances pending -> running -> completed through linear stages', async () => {
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['stage-a', 'stage-b']);
    const stages = [
      mkStage<unknown, { a: number }>('stage-a', () => ({ a: 1 })),
      mkStage<{ a: number }, { b: number }>('stage-b', (i) => ({ b: i.a + 1 })),
    ];
    const result = await runPipeline(stages, host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-1',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('completed');
    if (result.kind === 'completed') {
      expect(result.pipelineId).toBeDefined();
    }
  });

  it('forwards options.verifiedCitedAtomIds to every stage StageInput', async () => {
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['stage-a', 'stage-b']);
    // Capture the StageInput each stage observes so the test can
    // assert the runner's plumbing is uniform across the pipeline:
    // every stage MUST see the same readonly array as its
    // input.verifiedCitedAtomIds. This is the substrate-side guard
    // for the closure-of-citations property the spec/plan/review
    // stage prompts depend on.
    const captured: Array<{ name: string; verified: ReadonlyArray<AtomId> }> = [];
    const stageA: PlanningStage<unknown, { a: number }> = {
      name: 'stage-a',
      async run(input) {
        captured.push({ name: 'stage-a', verified: input.verifiedCitedAtomIds });
        return { value: { a: 1 }, cost_usd: 0, duration_ms: 0, atom_type: 'spec' };
      },
    };
    const stageB: PlanningStage<{ a: number }, { b: number }> = {
      name: 'stage-b',
      async run(input) {
        captured.push({ name: 'stage-b', verified: input.verifiedCitedAtomIds });
        return { value: { b: 2 }, cost_usd: 0, duration_ms: 0, atom_type: 'spec' };
      },
    };
    const verified = [
      'intent-foo' as AtomId,
      'dev-canon-foo' as AtomId,
      'dev-canon-bar' as AtomId,
    ];
    const result = await runPipeline([stageA, stageB], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-verified-fanout',
      seedAtomIds: ['intent-foo' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
      verifiedCitedAtomIds: verified,
    });
    expect(result.kind).toBe('completed');
    expect(captured.length).toBe(2);
    expect(captured[0]?.verified).toEqual(verified);
    expect(captured[1]?.verified).toEqual(verified);
  });

  it('forwards an empty verifiedCitedAtomIds default when the option is omitted', async () => {
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['stage-a']);
    let observed: ReadonlyArray<AtomId> | null = null;
    const stage: PlanningStage<unknown, unknown> = {
      name: 'stage-a',
      async run(input) {
        observed = input.verifiedCitedAtomIds;
        return { value: {}, cost_usd: 0, duration_ms: 0, atom_type: 'spec' };
      },
    };
    await runPipeline([stage], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-verified-default',
      seedAtomIds: ['intent-foo' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(observed).not.toBeNull();
    expect(observed).toEqual([]);
  });

  it('forwards options.verifiedSubActorPrincipalIds to every stage StageInput and StageContext', async () => {
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['stage-a', 'stage-b']);
    // Capture both StageInput.verifiedSubActorPrincipalIds (run side)
    // AND StageContext.verifiedSubActorPrincipalIds (audit side) per
    // stage. The runner MUST forward the same frozen reference into
    // both surfaces so the prompt-side fence and the audit-side check
    // walk the same set; a mismatch would silently let an LLM ground
    // on one set while the auditor enforced another.
    const captured: Array<{
      name: string;
      input: ReadonlyArray<PrincipalId>;
      context: ReadonlyArray<PrincipalId>;
    }> = [];
    const mkCapturingStage = (
      name: string,
    ): PlanningStage<unknown, { ok: true }> => ({
      name,
      async run(input) {
        captured.push({
          name,
          input: input.verifiedSubActorPrincipalIds,
          context: [] as ReadonlyArray<PrincipalId>,
        });
        return {
          value: { ok: true },
          cost_usd: 0,
          duration_ms: 0,
          atom_type: 'spec',
        };
      },
      async audit(_value, ctx) {
        const last = captured[captured.length - 1];
        if (last !== undefined) {
          captured[captured.length - 1] = {
            ...last,
            context: ctx.verifiedSubActorPrincipalIds,
          };
        }
        return [];
      },
    });
    const verifiedSubActors = [
      'code-author' as PrincipalId,
      'auditor-actor' as PrincipalId,
    ];
    const result = await runPipeline(
      [mkCapturingStage('stage-a'), mkCapturingStage('stage-b')],
      host,
      {
        principal: 'cto-actor' as PrincipalId,
        correlationId: 'corr-sub-actor-fanout',
        seedAtomIds: ['intent-foo' as AtomId],
        now: () => NOW,
        mode: 'substrate-deep',
        stagePolicyAtomId: 'pol-test',
        verifiedSubActorPrincipalIds: verifiedSubActors,
      },
    );
    expect(result.kind).toBe('completed');
    expect(captured.length).toBe(2);
    expect(captured[0]?.input).toEqual(verifiedSubActors);
    expect(captured[0]?.context).toEqual(verifiedSubActors);
    expect(captured[1]?.input).toEqual(verifiedSubActors);
    expect(captured[1]?.context).toEqual(verifiedSubActors);
  });

  it('forwards an empty verifiedSubActorPrincipalIds default when the option is omitted', async () => {
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['stage-a']);
    let observed: ReadonlyArray<PrincipalId> | null = null;
    const stage: PlanningStage<unknown, unknown> = {
      name: 'stage-a',
      async run(input) {
        observed = input.verifiedSubActorPrincipalIds;
        return { value: {}, cost_usd: 0, duration_ms: 0, atom_type: 'spec' };
      },
    };
    await runPipeline([stage], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-sub-actor-default',
      seedAtomIds: ['intent-foo' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(observed).not.toBeNull();
    expect(observed).toEqual([]);
  });

  it('forwards options.operatorIntentContent to every stage StageInput and StageContext', async () => {
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['stage-a', 'stage-b']);
    // Capture both StageInput.operatorIntentContent (run side) AND
    // StageContext.operatorIntentContent (audit side) per stage. The
    // runner MUST forward the same string into both surfaces so the
    // prompt-side semantic-faithfulness anchor and the audit-side check
    // walk the same value; a mismatch would silently let an LLM ground
    // on one anchor while the auditor checked another. Closes the
    // dogfeed-8 gap surfaced 2026-04-30 where the literal intent
    // ("Add a one-line note to the README ...") drifted into a meta-
    // task plan ("Dogfeed deep-planning pipeline in research-then-
    // propose mode ...") because only the brainstorm-stage saw the
    // original request.
    const captured: Array<{
      name: string;
      input: string;
      context: string;
    }> = [];
    const mkCapturingStage = (
      name: string,
    ): PlanningStage<unknown, { ok: true }> => ({
      name,
      async run(input) {
        captured.push({
          name,
          input: input.operatorIntentContent,
          context: '',
        });
        return {
          value: { ok: true },
          cost_usd: 0,
          duration_ms: 0,
          atom_type: 'spec',
        };
      },
      async audit(_value, ctx) {
        const last = captured[captured.length - 1];
        if (last !== undefined) {
          captured[captured.length - 1] = {
            ...last,
            context: ctx.operatorIntentContent,
          };
        }
        return [];
      },
    });
    const literalIntent =
      'Add a one-line note to the README explaining what the deep planning pipeline does.';
    const result = await runPipeline(
      [mkCapturingStage('stage-a'), mkCapturingStage('stage-b')],
      host,
      {
        principal: 'cto-actor' as PrincipalId,
        correlationId: 'corr-intent-content-fanout',
        seedAtomIds: ['intent-foo' as AtomId],
        now: () => NOW,
        mode: 'substrate-deep',
        stagePolicyAtomId: 'pol-test',
        operatorIntentContent: literalIntent,
      },
    );
    expect(result.kind).toBe('completed');
    expect(captured.length).toBe(2);
    expect(captured[0]?.input).toBe(literalIntent);
    expect(captured[0]?.context).toBe(literalIntent);
    expect(captured[1]?.input).toBe(literalIntent);
    expect(captured[1]?.context).toBe(literalIntent);
  });

  it('forwards an empty operatorIntentContent default when the option is omitted', async () => {
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['stage-a']);
    let observed: string | null = null;
    const stage: PlanningStage<unknown, unknown> = {
      name: 'stage-a',
      async run(input) {
        observed = input.operatorIntentContent;
        return { value: {}, cost_usd: 0, duration_ms: 0, atom_type: 'spec' };
      },
    };
    await runPipeline([stage], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-intent-content-default',
      seedAtomIds: ['intent-foo' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(observed).not.toBeNull();
    expect(observed).toBe('');
  });

  it('halts on kill-switch before the first stage', async () => {
    const host = createMemoryHost();
    vi.spyOn(host.scheduler, 'killswitchCheck').mockReturnValue(true);
    const stages = [mkStage<unknown, unknown>('stage-a', () => ({}))];
    const result = await runPipeline(stages, host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-2',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('halted');
  });

  it('writes pipeline-failed atom when a stage throws', async () => {
    const host = createMemoryHost();
    const failingStage = mkThrowingStage();
    const result = await runPipeline([failingStage], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-3',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.failedStageName).toBe('fail-stage');
    }
  });

  it('halts on critical audit finding', async () => {
    const host = createMemoryHost();
    const auditedStage: PlanningStage<unknown, { x: number }> = {
      name: 'audited-stage',
      async run() {
        return { value: { x: 1 }, cost_usd: 0, duration_ms: 0, atom_type: 'spec' };
      },
      async audit() {
        return [
          {
            severity: 'critical',
            category: 'cite-fail',
            message: 'fabricated path',
            cited_atom_ids: [],
            cited_paths: ['nope.ts'],
          },
        ];
      },
    };
    const result = await runPipeline([auditedStage], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-4',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('failed');
  });

  it('rejects stage output whose cost_usd exceeds budget_cap_usd', async () => {
    const host = createMemoryHost();
    const expensiveStage: PlanningStage<unknown, unknown> = {
      name: 'expensive-stage',
      budget_cap_usd: 1.0,
      async run() {
        return { value: {}, cost_usd: 50.0, duration_ms: 0, atom_type: 'spec' };
      },
    };
    const result = await runPipeline([expensiveStage], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-5',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.cause).toMatch(/budget/);
  });

  it('forwards StageOutput.extraMetadata onto the persisted stage-output atom metadata', async () => {
    // Substrate fix coverage: a stage that returns extraMetadata on its
    // StageOutput must see those keys appear on the persisted typed
    // stage-output atom's metadata, shallow-merged below the runner-
    // supplied routing keys (pipeline_id, stage_name, stage_output) so
    // a misbehaving stage cannot shadow them. This wires the seam used
    // by examples/planning-stages/lib/run-stage-agent-loop.ts to stamp
    // canon_directives_applied + tool_policy_principal_id.
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['brainstorm-stage']);
    const stages: ReadonlyArray<PlanningStage<unknown, { goal: string }>> = [
      {
        name: 'brainstorm-stage',
        async run() {
          return {
            value: { goal: 'pick A' },
            cost_usd: 0,
            duration_ms: 0,
            atom_type: 'brainstorm-output',
            extraMetadata: {
              canon_directives_applied: ['dev-foo', 'dev-bar'],
              tool_policy_principal_id: 'brainstorm-actor',
            },
          };
        },
      },
    ];
    await runPipeline(stages, host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-extra-meta',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    const page = await host.atoms.query({ type: ['brainstorm-output'] }, 100);
    expect(page.atoms).toHaveLength(1);
    const meta = page.atoms[0]!.metadata as Record<string, unknown>;
    // Stamped fields surface verbatim.
    expect(meta.canon_directives_applied).toEqual(['dev-foo', 'dev-bar']);
    expect(meta.tool_policy_principal_id).toBe('brainstorm-actor');
    // Runner-supplied routing keys still win on shallow merge.
    expect(meta.pipeline_id).toBe('pipeline-corr-extra-meta');
    expect(meta.stage_name).toBe('brainstorm-stage');
  });

  it('plan-stage forwards extraMetadata onto every minted plan atom (below plan-shape keys)', async () => {
    // The plan-stage mints one plan atom per entry in `plans[]`; each
    // must carry the stamped canon-at-runtime bag. Plan-shape metadata
    // keys (title, pipeline_id, principles_applied, delegation,
    // alternatives_rejected, what_breaks_if_revisit) MUST win on
    // collision so a malformed extraMetadata cannot hijack a load-bearing
    // plan field a downstream consumer (dispatch, projections) reads.
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['plan-stage']);
    const stages: ReadonlyArray<PlanningStage<unknown, unknown>> = [
      {
        name: 'plan-stage',
        async run() {
          return {
            value: {
              plans: [
                {
                  title: 'Real plan title',
                  body: 'plan body',
                  derived_from: [],
                  principles_applied: [],
                  alternatives_rejected: [],
                  what_breaks_if_revisit: 'something',
                  confidence: 0.9,
                },
              ],
              cost_usd: 0,
            },
            cost_usd: 0,
            duration_ms: 0,
            atom_type: 'plan',
            extraMetadata: {
              canon_directives_applied: ['dev-extreme-rigor-and-research'],
              tool_policy_principal_id: 'cto-actor',
              // Attempt to shadow a plan-shape key; runner must NOT
              // honour this because plan readers depend on the shape.
              title: 'malicious title',
            },
          };
        },
      },
    ];
    await runPipeline(stages, host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-plan-extra-meta',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    const page = await host.atoms.query({ type: ['plan'] }, 100);
    expect(page.atoms).toHaveLength(1);
    const planAtom = page.atoms[0]!;
    const meta = planAtom.metadata as Record<string, unknown>;
    expect(meta.canon_directives_applied).toEqual(['dev-extreme-rigor-and-research']);
    expect(meta.tool_policy_principal_id).toBe('cto-actor');
    // Plan-shape title wins over the extraMetadata's malicious title.
    expect(meta.title).toBe('Real plan title');
    expect(meta.pipeline_id).toBe('pipeline-corr-plan-extra-meta');
  });

  it('emits a pipeline-stage-event atom per state transition', async () => {
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['a', 'b']);
    const stages = [
      mkStage<unknown, unknown>('a', () => ({})),
      mkStage<unknown, unknown>('b', () => ({})),
    ];
    await runPipeline(stages, host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-6',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    const page = await host.atoms.query({ type: ['pipeline-stage-event'] }, 100);
    // Verify the actual transition sequence rather than just counting
    // atoms: a malformed runner could emit four atoms with the wrong
    // transition kinds and still pass a length check.
    const transitions = page.atoms.map((a) => {
      const meta = a.metadata as Record<string, unknown>;
      return [meta.stage_name, meta.transition] as [unknown, unknown];
    });
    expect(transitions).toEqual([
      ['a', 'enter'],
      ['a', 'exit-success'],
      ['b', 'enter'],
      ['b', 'exit-success'],
    ]);
  });

  // Terminal-transition timestamp parity. Substrate-fix in this PR:
  // failPipeline marked pipeline_state='failed' but never stamped
  // metadata.completed_at, leaving the field at its mkPipelineAtom
  // initial value of null. The completed path stamped it correctly.
  // Audit consumers projecting pipeline duration ("how long did this
  // run before failing") couldn't tell from the atom alone; they had
  // to derive the time from the chain of pipeline-stage-event atoms.
  // Mirror the started_at pattern: stamp completed_at on every
  // terminal transition (failed or completed).
  describe('terminal-transition completed_at stamp', () => {
    it('stamps metadata.completed_at on successful completion', async () => {
      const host = createMemoryHost();
      await seedPauseNeverPolicies(host, ['stage-a']);
      const stages = [mkStage<unknown, unknown>('stage-a', () => ({}))];
      const result = await runPipeline(stages, host, {
        principal: 'cto-actor' as PrincipalId,
        correlationId: 'corr-completed-at-success',
        seedAtomIds: ['intent-1' as AtomId],
        now: () => NOW,
        mode: 'substrate-deep',
        stagePolicyAtomId: 'pol-test',
      });
      expect(result.kind).toBe('completed');
      const pipelineAtom = await host.atoms.get(
        `pipeline-corr-completed-at-success` as AtomId,
      );
      expect(pipelineAtom).not.toBeNull();
      const meta = pipelineAtom!.metadata as Record<string, unknown>;
      expect(meta.completed_at).toBe(NOW);
      expect(pipelineAtom!.pipeline_state).toBe('completed');
    });

    it('stamps metadata.completed_at on stage-thrown failure', async () => {
      const host = createMemoryHost();
      const failingStage = mkThrowingStage();
      const result = await runPipeline([failingStage], host, {
        principal: 'cto-actor' as PrincipalId,
        correlationId: 'corr-completed-at-fail',
        seedAtomIds: ['intent-1' as AtomId],
        now: () => NOW,
        mode: 'substrate-deep',
        stagePolicyAtomId: 'pol-test',
      });
      expect(result.kind).toBe('failed');
      const pipelineAtom = await host.atoms.get(
        `pipeline-corr-completed-at-fail` as AtomId,
      );
      expect(pipelineAtom).not.toBeNull();
      const meta = pipelineAtom!.metadata as Record<string, unknown>;
      // Mirrors the started_at pattern in mkPipelineAtom: terminal
      // transitions stamp completed_at to the run's terminal time.
      expect(meta.completed_at).toBe(NOW);
      expect(pipelineAtom!.pipeline_state).toBe('failed');
    });

    it('stamps metadata.completed_at on critical-audit-finding failure', async () => {
      const host = createMemoryHost();
      const auditedStage: PlanningStage<unknown, { x: number }> = {
        name: 'audited-stage',
        async run() {
          return { value: { x: 1 }, cost_usd: 0, duration_ms: 0, atom_type: 'spec' };
        },
        async audit() {
          return [
            {
              severity: 'critical',
              category: 'cite-fail',
              message: 'fabricated path',
              cited_atom_ids: [],
              cited_paths: ['nope.ts'],
            },
          ];
        },
      };
      const result = await runPipeline([auditedStage], host, {
        principal: 'cto-actor' as PrincipalId,
        correlationId: 'corr-completed-at-audit',
        seedAtomIds: ['intent-1' as AtomId],
        now: () => NOW,
        mode: 'substrate-deep',
        stagePolicyAtomId: 'pol-test',
      });
      expect(result.kind).toBe('failed');
      const pipelineAtom = await host.atoms.get(
        `pipeline-corr-completed-at-audit` as AtomId,
      );
      expect(pipelineAtom).not.toBeNull();
      const meta = pipelineAtom!.metadata as Record<string, unknown>;
      expect(meta.completed_at).toBe(NOW);
      expect(pipelineAtom!.pipeline_state).toBe('failed');
    });

    it('preserves started_at when stamping completed_at on failure', async () => {
      // Regression guard: the metadata patch must be a shallow-merge,
      // not a clobber. mkPipelineAtom initialises started_at + null
      // completed_at + total_cost_usd; failPipeline must not erase
      // started_at when it stamps completed_at.
      const host = createMemoryHost();
      const failingStage = mkThrowingStage();
      await runPipeline([failingStage], host, {
        principal: 'cto-actor' as PrincipalId,
        correlationId: 'corr-completed-at-merge',
        seedAtomIds: ['intent-1' as AtomId],
        now: () => NOW,
        mode: 'substrate-deep',
        stagePolicyAtomId: 'pol-test',
      });
      const pipelineAtom = await host.atoms.get(
        `pipeline-corr-completed-at-merge` as AtomId,
      );
      const meta = pipelineAtom!.metadata as Record<string, unknown>;
      expect(meta.started_at).toBe(NOW);
      expect(meta.completed_at).toBe(NOW);
      // Confirm the mode + stage_policy fields from mkPipelineAtom
      // survive the failure-path metadata write too.
      expect(meta.stage_policy_atom_id).toBe('pol-test');
      expect(meta.mode).toBe('substrate-deep');
    });

    // CR PR #244 #4195194861 nit: timestamp-parity guard. The earlier
    // tests used a constant now() and could not distinguish "single
    // now() call shared between writes" from "two now() calls that
    // happen to return the same value". This test uses an
    // incrementing clock so the assertion catches a future regression
    // that splits the terminal timestamp across two now() invocations.
    it('reuses a single now() across pipeline-failed and pipeline atom writes', async () => {
      const host = createMemoryHost();
      // Closure that returns a distinct ISO timestamp on each call.
      // The runner currently calls now() at: mkPipelineAtom (start),
      // each emitStageEvent, the terminal failPipeline (single
      // shared call), and one trailing pipeline-stage-event 'enter'
      // emit. A regression that introduces a second now() call
      // between the pipeline-failed atom and the pipeline atom
      // metadata write would shift completed_at off pipeline-failed
      // .created_at; this assertion would catch that.
      let i = 0;
      const incNow = () =>
        new Date(Date.UTC(2026, 3, 28, 12, 0, i++)).toISOString() as Time;
      const failingStage = mkThrowingStage();
      await runPipeline([failingStage], host, {
        principal: 'cto-actor' as PrincipalId,
        correlationId: 'corr-parity-test',
        seedAtomIds: ['intent-1' as AtomId],
        now: incNow,
        mode: 'substrate-deep',
        stagePolicyAtomId: 'pol-test',
      });
      const pipelineAtom = await host.atoms.get(
        `pipeline-corr-parity-test` as AtomId,
      );
      const failedAtom = await host.atoms.get(
        `pipeline-failed-pipeline-corr-parity-test-0` as AtomId,
      );
      expect(pipelineAtom).not.toBeNull();
      expect(failedAtom).not.toBeNull();
      const meta = pipelineAtom!.metadata as Record<string, unknown>;
      // Parity invariant: the pipeline-failed atom's created_at is
      // the same terminalNow used to stamp the pipeline atom's
      // metadata.completed_at. A regression that splits these into
      // two now() calls would surface as drift here.
      expect(meta.completed_at).toBe(failedAtom!.created_at);
    });
  });

  // Stage-output atom persistence (substrate-fix in this PR).
  // Without this wiring, each stage's StageOutput.value lived only
  // in-memory as priorOutput between adjacent stages and was
  // unreachable from host.atoms.query: the dispatch-stage's planFilter
  // walked derived_from chains and found zero plan atoms because no
  // plan atom had been written upstream. The runner now mints a typed
  // atom for each stage and propagates priorOutputAtomIds so each
  // downstream stage's atom chain captures the full pipeline lineage.
  describe('stage-output atom persistence', () => {
    it('mints one stage-output atom per default stage and chains derived_from back through the pipeline', async () => {
      const host = createMemoryHost();
      await seedPauseNeverPolicies(host, [
        'brainstorm-stage',
        'spec-stage',
        'plan-stage',
        'review-stage',
        'dispatch-stage',
      ]);
      // Use the canonical stage names so the runner's persistStageOutput
      // routing dispatches to the dedicated mint helpers (vs the
      // generic fallback). Each stage's run() returns a minimal
      // payload that satisfies the shape assertions below; the
      // runner's outputSchema validation is opt-in (no schema =
      // skip) so these stages do not need a zod schema attached.
      const stages: ReadonlyArray<PlanningStage> = [
        {
          name: 'brainstorm-stage',
          async run() {
            return {
              value: { open_questions: [], cost_usd: 0 },
              cost_usd: 0,
              duration_ms: 0,
              atom_type: 'brainstorm-output',
            };
          },
        },
        {
          name: 'spec-stage',
          async run() {
            return {
              value: { goal: 'g', body: 'b', cost_usd: 0 },
              cost_usd: 0,
              duration_ms: 0,
              atom_type: 'spec-output',
            };
          },
        },
        {
          name: 'plan-stage',
          async run() {
            return {
              value: {
                plans: [{
                  title: 'persisted plan',
                  body: 'plan body',
                  derived_from: ['intent-1'],
                  principles_applied: [],
                  alternatives_rejected: [],
                  what_breaks_if_revisit: 'nothing',
                  confidence: 0.9,
                  delegation: {
                    sub_actor_principal_id: 'code-author',
                    reason: 'implements',
                    implied_blast_radius: 'framework',
                  },
                }],
                cost_usd: 0,
              },
              cost_usd: 0,
              duration_ms: 0,
              atom_type: 'plan',
            };
          },
        },
        {
          name: 'review-stage',
          async run() {
            return {
              value: { audit_status: 'clean', findings: [], total_bytes_read: 0, cost_usd: 0 },
              cost_usd: 0,
              duration_ms: 0,
              atom_type: 'review-report',
            };
          },
        },
        {
          name: 'dispatch-stage',
          async run() {
            return {
              value: {
                dispatch_status: 'completed',
                scanned: 0, dispatched: 0, failed: 0, cost_usd: 0,
              },
              cost_usd: 0,
              duration_ms: 0,
              atom_type: 'dispatch-record',
            };
          },
        },
      ];
      const result = await runPipeline(stages, host, {
        principal: 'cto-actor' as PrincipalId,
        correlationId: 'corr-stage-outputs',
        seedAtomIds: ['intent-1' as AtomId],
        now: () => NOW,
        mode: 'substrate-deep',
        stagePolicyAtomId: 'pol-test',
      });
      expect(result.kind).toBe('completed');
      if (result.kind !== 'completed') return;

      // brainstorm-output, spec-output, review-report, dispatch-record:
      // one atom each, queryable by type.
      const brainstormPage = await host.atoms.query(
        { type: ['brainstorm-output'] }, 100,
      );
      expect(brainstormPage.atoms.length).toBe(1);
      const brainstormAtom = brainstormPage.atoms[0]!;
      expect(brainstormAtom.provenance.derived_from).toContain(result.pipelineId);

      const specOutputPage = await host.atoms.query(
        { type: ['spec-output'] }, 100,
      );
      expect(specOutputPage.atoms.length).toBe(1);
      const specOutputAtom = specOutputPage.atoms[0]!;
      // spec-output's derived_from chains through the brainstorm-output
      // atom id; the chain captures both the pipeline and the prior
      // stage's output.
      expect(specOutputAtom.provenance.derived_from).toContain(result.pipelineId);
      expect(specOutputAtom.provenance.derived_from).toContain(brainstormAtom.id);

      const reviewPage = await host.atoms.query({ type: ['review-report'] }, 100);
      expect(reviewPage.atoms.length).toBe(1);
      const dispatchPage = await host.atoms.query({ type: ['dispatch-record'] }, 100);
      expect(dispatchPage.atoms.length).toBe(1);

      // plan atom: persisted under the canonical 'plan' type so the
      // dispatch-stage's planFilter (matching plans whose
      // derived_from includes the pipelineId) finds it.
      const planPage = await host.atoms.query({ type: ['plan'] }, 100);
      expect(planPage.atoms.length).toBe(1);
      const planAtom = planPage.atoms[0]!;
      expect(planAtom.plan_state).toBe('proposed');
      expect(planAtom.provenance.derived_from).toContain(result.pipelineId);
      // The plan's chain also captures the spec-output atom id (the
      // immediately upstream stage), so a walk back from the plan
      // atom reaches every prior stage and the seed intent.
      expect(planAtom.provenance.derived_from).toContain(specOutputAtom.id);
      // The plan's chain captures the original derived_from from the
      // plan-stage payload too.
      expect(planAtom.provenance.derived_from).toContain('intent-1');
    });

    it('emits exit-success with output_atom_id pointing at the persisted stage-output atom', async () => {
      const host = createMemoryHost();
      await seedPauseNeverPolicies(host, ['spec-stage']);
      const stages: ReadonlyArray<PlanningStage> = [
        {
          name: 'spec-stage',
          async run() {
            return {
              value: { goal: 'g', body: 'b', cost_usd: 0 },
              cost_usd: 0,
              duration_ms: 0,
              atom_type: 'spec-output',
            };
          },
        },
      ];
      const result = await runPipeline(stages, host, {
        principal: 'cto-actor' as PrincipalId,
        correlationId: 'corr-spec-output-event',
        seedAtomIds: ['intent-1' as AtomId],
        now: () => NOW,
        mode: 'substrate-deep',
        stagePolicyAtomId: 'pol-test',
      });
      expect(result.kind).toBe('completed');
      const events = await host.atoms.query(
        { type: ['pipeline-stage-event'] }, 100,
      );
      const exitSuccess = events.atoms.find((a) => {
        const meta = a.metadata as Record<string, unknown>;
        return meta.transition === 'exit-success' && meta.stage_name === 'spec-stage';
      });
      expect(exitSuccess).toBeDefined();
      const exitMeta = exitSuccess!.metadata as Record<string, unknown>;
      expect(exitMeta.output_atom_id).toBeDefined();
      // The output_atom_id resolves to a real spec-output atom.
      const specOutputAtom = await host.atoms.get(exitMeta.output_atom_id as AtomId);
      expect(specOutputAtom).not.toBeNull();
      expect(specOutputAtom!.type).toBe('spec-output');
    });

    it('falls back to a generic stage-output atom for unknown stage names', async () => {
      const host = createMemoryHost();
      await seedPauseNeverPolicies(host, ['legal-review']);
      // Custom stage name outside the default 5-stage set: routes
      // through the generic-stage-output fallback.
      const stages: ReadonlyArray<PlanningStage> = [
        {
          name: 'legal-review',
          async run() {
            return {
              value: { compliance_status: 'reviewed', cost_usd: 0 },
              cost_usd: 0,
              duration_ms: 0,
              atom_type: 'observation',
            };
          },
        },
      ];
      const result = await runPipeline(stages, host, {
        principal: 'cto-actor' as PrincipalId,
        correlationId: 'corr-custom-stage',
        seedAtomIds: ['intent-1' as AtomId],
        now: () => NOW,
        mode: 'substrate-deep',
        stagePolicyAtomId: 'pol-test',
      });
      expect(result.kind).toBe('completed');
      const observations = await host.atoms.query(
        { type: ['observation'] }, 100,
      );
      // Filter to the runner-emitted generic stage-output atom by
      // metadata.generic_stage_output to avoid colliding with any
      // other observation atoms a future test fixture may seed.
      const genericAtoms = observations.atoms.filter((a) => {
        const meta = a.metadata as Record<string, unknown>;
        return meta.generic_stage_output === true;
      });
      expect(genericAtoms.length).toBe(1);
      const meta = genericAtoms[0]!.metadata as Record<string, unknown>;
      expect(meta.stage_name).toBe('legal-review');
    });

    it('seeds priorOutputAtomIds from options on resume so the upstream chain survives', async () => {
      // When a pipeline is resumed mid-walk, the resume entrypoint
      // passes the already-written upstream stage-output atom ids via
      // options.priorOutputAtomIds so the first newly-persisted stage
      // captures the full chain. Without this seed, a resumed plan
      // atom's derived_from would only chain to the pipelineId, losing
      // the upstream brainstorm-output / spec-output / etc. links.
      const host = createMemoryHost();
      await seedPauseNeverPolicies(host, ['plan-stage']);
      const upstreamAtomId = 'spec-output-pipeline-corr-resume-from-plan-spec-stage-corr-resume-from-plan' as AtomId;
      const stages: ReadonlyArray<PlanningStage> = [
        // Stages 0-1 (brainstorm + spec) skipped because resume starts
        // at plan-stage; the dispatch + review stages aren't included
        // either to keep the test tight.
        {
          name: 'brainstorm-stage',
          async run() {
            return { value: {}, cost_usd: 0, duration_ms: 0, atom_type: 'brainstorm-output' };
          },
        },
        {
          name: 'spec-stage',
          async run() {
            return { value: {}, cost_usd: 0, duration_ms: 0, atom_type: 'spec-output' };
          },
        },
        {
          name: 'plan-stage',
          async run() {
            return {
              value: {
                plans: [{
                  title: 'resumed plan',
                  body: 'plan body',
                  derived_from: ['intent-1'],
                  principles_applied: [],
                  alternatives_rejected: [],
                  what_breaks_if_revisit: 'nothing',
                  confidence: 0.9,
                  delegation: {
                    sub_actor_principal_id: 'code-author',
                    reason: 'implements',
                    implied_blast_radius: 'framework',
                  },
                }],
                cost_usd: 0,
              },
              cost_usd: 0,
              duration_ms: 0,
              atom_type: 'plan',
            };
          },
        },
      ];
      // Pre-seed the pipeline atom (resume requires the pipeline atom
      // to already exist; no resume entrypoint hydration here, the
      // test seeds it inline).
      await host.atoms.put({
        schema_version: 1,
        id: 'pipeline-corr-resume-from-plan' as AtomId,
        content: 'test fixture',
        type: 'pipeline',
        layer: 'L0',
        provenance: {
          kind: 'agent-observed',
          source: { tool: 'test-fixture' },
          derived_from: ['intent-1' as AtomId],
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
        principal_id: 'cto-actor' as PrincipalId,
        taint: 'clean',
        metadata: { mode: 'substrate-deep', started_at: NOW, current_stage_index: 1 },
        pipeline_state: 'hil-paused',
      });
      const result = await runPipeline(stages, host, {
        principal: 'cto-actor' as PrincipalId,
        correlationId: 'corr-resume-from-plan',
        seedAtomIds: ['intent-1' as AtomId],
        now: () => NOW,
        mode: 'substrate-deep',
        stagePolicyAtomId: 'pol-test',
        resumeFromStage: 'plan-stage',
        priorOutputAtomIds: [upstreamAtomId],
      });
      expect(result.kind).toBe('completed');
      // The plan atom's derived_from must include the upstream
      // spec-output atom id passed in via options.priorOutputAtomIds,
      // not just the pipelineId.
      const planPage = await host.atoms.query({ type: ['plan'] }, 100);
      expect(planPage.atoms.length).toBe(1);
      const planAtom = planPage.atoms[0]!;
      expect(planAtom.provenance.derived_from).toContain(upstreamAtomId);
    });

    it('writes the stage-output atom even on critical-audit-halt so the operator can inspect it', async () => {
      const host = createMemoryHost();
      const stages: ReadonlyArray<PlanningStage> = [
        {
          name: 'brainstorm-stage',
          async run() {
            return {
              value: { open_questions: ['q'], cost_usd: 0 },
              cost_usd: 0,
              duration_ms: 0,
              atom_type: 'brainstorm-output',
            };
          },
          async audit() {
            return [
              {
                severity: 'critical',
                category: 'fabricated-cited-atom',
                message: 'forced critical for test',
                cited_atom_ids: [],
                cited_paths: [],
              },
            ];
          },
        },
      ];
      const result = await runPipeline(stages, host, {
        principal: 'cto-actor' as PrincipalId,
        correlationId: 'corr-audit-halt-persists',
        seedAtomIds: ['intent-1' as AtomId],
        now: () => NOW,
        mode: 'substrate-deep',
        stagePolicyAtomId: 'pol-test',
      });
      expect(result.kind).toBe('failed');
      // Stage-output atom WAS persisted before the audit ran, so the
      // operator can inspect it after the pipeline halts.
      const brainstormAtoms = await host.atoms.query(
        { type: ['brainstorm-output'] }, 100,
      );
      expect(brainstormAtoms.atoms.length).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // plan-stage auto-approval (runPipelinePlanAutoApproval wire-up)
  // ---------------------------------------------------------------------------
  describe('plan-stage auto-approval', () => {
    /**
     * Seed the canonical pol-plan-autonomous-intent-approve and
     * pol-operator-intent-creation atoms so the auto-approval helper
     * has a non-empty allowlist + a principal whitelist. Without these
     * the helper short-circuits to notEligible and the integration test
     * cannot verify the wire-up.
     */
    async function seedAutoApprovePolicies(host: MemoryHost): Promise<void> {
      await host.atoms.put({
        schema_version: 1,
        id: 'pol-plan-autonomous-intent-approve' as AtomId,
        content: 'intent-approve policy fixture',
        type: 'directive',
        layer: 'L3',
        provenance: { kind: 'operator-seeded', source: { tool: 'test-fixture' }, derived_from: [] },
        confidence: 1,
        created_at: NOW,
        last_reinforced_at: NOW,
        expires_at: null,
        supersedes: [],
        superseded_by: [],
        scope: 'project',
        signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
        principal_id: 'operator' as PrincipalId,
        taint: 'clean',
        metadata: {
          policy: {
            subject: 'plan-autonomous-intent-approve',
            allowed_sub_actors: ['code-author'],
          },
        },
      });
      await host.atoms.put({
        schema_version: 1,
        id: 'pol-operator-intent-creation' as AtomId,
        content: 'intent-creation policy fixture',
        type: 'directive',
        layer: 'L3',
        provenance: { kind: 'operator-seeded', source: { tool: 'test-fixture' }, derived_from: [] },
        confidence: 1,
        created_at: NOW,
        last_reinforced_at: NOW,
        expires_at: null,
        supersedes: [],
        superseded_by: [],
        scope: 'project',
        signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
        principal_id: 'operator' as PrincipalId,
        taint: 'clean',
        metadata: {
          policy: {
            subject: 'operator-intent-creation',
            allowed_principal_ids: ['operator-principal'],
          },
        },
      });
    }

    /**
     * Seed an operator-intent atom whose trust envelope authorizes the
     * plan-stage emission shape used by the test fixtures below
     * (sub_actor_principal_id: 'code-author', implied_blast_radius:
     * 'tooling').
     */
    async function seedOperatorIntent(host: MemoryHost, intentId: string): Promise<void> {
      const FUTURE_EXPIRY = new Date(Date.parse(NOW) + 24 * 60 * 60 * 1000).toISOString() as Time;
      await host.atoms.put({
        schema_version: 1,
        id: intentId as AtomId,
        content: 'autonomous-solve fixture intent',
        type: 'operator-intent',
        layer: 'L1',
        provenance: { kind: 'operator-seeded', source: { tool: 'test-fixture' }, derived_from: [] },
        confidence: 1,
        created_at: NOW,
        last_reinforced_at: NOW,
        expires_at: null,
        supersedes: [],
        superseded_by: [],
        scope: 'project',
        signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
        principal_id: 'operator-principal' as PrincipalId,
        taint: 'clean',
        metadata: {
          trust_envelope: {
            min_plan_confidence: 0.55,
            max_blast_radius: 'tooling',
            allowed_sub_actors: ['code-author'],
          },
          expires_at: FUTURE_EXPIRY,
        },
      });
    }

    it('transitions plan_state proposed -> approved when the seed-intent envelope authorizes', async () => {
      const host = createMemoryHost();
      await seedPauseNeverPolicies(host, ['plan-stage']);
      await seedAutoApprovePolicies(host);
      await seedOperatorIntent(host, 'intent-pipeline-approve');

      const stages: ReadonlyArray<PlanningStage> = [
        {
          name: 'plan-stage',
          async run() {
            return {
              value: {
                plans: [{
                  title: 'auto-approvable plan',
                  body: 'plan body',
                  derived_from: ['intent-pipeline-approve'],
                  principles_applied: [],
                  alternatives_rejected: [],
                  what_breaks_if_revisit: 'nothing',
                  confidence: 0.9,
                  delegation: {
                    sub_actor_principal_id: 'code-author',
                    reason: 'implements',
                    implied_blast_radius: 'tooling',
                  },
                }],
                cost_usd: 0,
              },
              cost_usd: 0,
              duration_ms: 0,
              atom_type: 'plan',
            };
          },
        },
      ];
      const result = await runPipeline(stages, host, {
        principal: 'cto-actor' as PrincipalId,
        correlationId: 'corr-auto-approve',
        seedAtomIds: ['intent-pipeline-approve' as AtomId],
        now: () => NOW,
        mode: 'substrate-deep',
        stagePolicyAtomId: 'pol-test',
      });
      expect(result.kind).toBe('completed');

      // The plan atom emerges as 'approved', not 'proposed'.
      const plans = await host.atoms.query({ type: ['plan'] }, 100);
      expect(plans.atoms.length).toBe(1);
      const planAtom = plans.atoms[0]!;
      expect(planAtom.plan_state).toBe('approved');
      const meta = planAtom.metadata as Record<string, unknown>;
      expect(meta['approved_via']).toBe('pol-plan-autonomous-intent-approve');
      expect(meta['approved_intent_id']).toBe('intent-pipeline-approve');

      // Audit event recorded.
      const events = await host.auditor.query({ kind: ['plan.approved-by-intent'] }, 10);
      expect(events.length).toBe(1);
      expect(events[0]?.details['source']).toBe('planning-pipeline');
    });

    it('leaves plan_state proposed when no operator-intent is seeded (not-eligible)', async () => {
      const host = createMemoryHost();
      await seedPauseNeverPolicies(host, ['plan-stage']);
      await seedAutoApprovePolicies(host);
      // No seedOperatorIntent: the plan's derived_from references
      // 'intent-1' but no operator-intent atom is in the store, so
      // the auto-approval helper treats the plan as not-eligible.
      const stages: ReadonlyArray<PlanningStage> = [
        {
          name: 'plan-stage',
          async run() {
            return {
              value: {
                plans: [{
                  title: 'plan without intent',
                  body: 'plan body',
                  derived_from: ['intent-missing'],
                  principles_applied: [],
                  alternatives_rejected: [],
                  what_breaks_if_revisit: 'nothing',
                  confidence: 0.9,
                  delegation: {
                    sub_actor_principal_id: 'code-author',
                    reason: 'implements',
                    implied_blast_radius: 'tooling',
                  },
                }],
                cost_usd: 0,
              },
              cost_usd: 0,
              duration_ms: 0,
              atom_type: 'plan',
            };
          },
        },
      ];
      const result = await runPipeline(stages, host, {
        principal: 'cto-actor' as PrincipalId,
        correlationId: 'corr-no-intent',
        seedAtomIds: ['intent-missing' as AtomId],
        now: () => NOW,
        mode: 'substrate-deep',
        stagePolicyAtomId: 'pol-test',
      });
      expect(result.kind).toBe('completed');

      const plans = await host.atoms.query({ type: ['plan'] }, 100);
      expect(plans.atoms.length).toBe(1);
      // Plan stays proposed because no operator-intent could be located.
      expect(plans.atoms[0]!.plan_state).toBe('proposed');
    });

    it('leaves plan_state proposed when the envelope mismatches', async () => {
      const host = createMemoryHost();
      await seedPauseNeverPolicies(host, ['plan-stage']);
      await seedAutoApprovePolicies(host);
      await seedOperatorIntent(host, 'intent-mismatch');

      // Plan delegates to a sub-actor NOT in the envelope's allowed
      // list (envelope allows code-author; plan requests plan-dispatcher).
      const stages: ReadonlyArray<PlanningStage> = [
        {
          name: 'plan-stage',
          async run() {
            return {
              value: {
                plans: [{
                  title: 'mismatch plan',
                  body: 'plan body',
                  derived_from: ['intent-mismatch'],
                  principles_applied: [],
                  alternatives_rejected: [],
                  what_breaks_if_revisit: 'nothing',
                  confidence: 0.9,
                  delegation: {
                    sub_actor_principal_id: 'plan-dispatcher',
                    reason: 'mismatched delegation',
                    implied_blast_radius: 'tooling',
                  },
                }],
                cost_usd: 0,
              },
              cost_usd: 0,
              duration_ms: 0,
              atom_type: 'plan',
            };
          },
        },
      ];
      const result = await runPipeline(stages, host, {
        principal: 'cto-actor' as PrincipalId,
        correlationId: 'corr-mismatch',
        seedAtomIds: ['intent-mismatch' as AtomId],
        now: () => NOW,
        mode: 'substrate-deep',
        stagePolicyAtomId: 'pol-test',
      });
      expect(result.kind).toBe('completed');

      const plans = await host.atoms.query({ type: ['plan'] }, 100);
      expect(plans.atoms.length).toBe(1);
      // Envelope mismatched on sub-actor, so plan stays proposed and
      // the auditor logs a 'plan.skipped-by-intent' event.
      expect(plans.atoms[0]!.plan_state).toBe('proposed');

      const events = await host.auditor.query({ kind: ['plan.skipped-by-intent'] }, 10);
      expect(events.length).toBe(1);
      expect(events[0]?.details['source']).toBe('planning-pipeline');
    });

    it('routes auto-approval errors through failPipeline so the pipeline reaches a terminal state', async () => {
      const host = createMemoryHost();
      await seedPauseNeverPolicies(host, ['plan-stage']);
      await seedAutoApprovePolicies(host);
      await seedOperatorIntent(host, 'intent-throw');

      // Make host.atoms.update throw on the auto-approve transition so
      // the runner's try/catch is exercised. The stage output has
      // already been persisted by the time auto-approval runs, so the
      // throw must NOT leave the pipeline stuck in 'running' with no
      // pipeline-failed atom.
      const realUpdate = host.atoms.update.bind(host.atoms);
      let updateAttempts = 0;
      vi.spyOn(host.atoms, 'update').mockImplementation(async (id, patch) => {
        // Allow pipeline-state transitions to proceed; only block the
        // plan-stage's plan_state -> approved transition.
        if (
          patch.plan_state === 'approved'
          && String(id).startsWith('plan-')
        ) {
          updateAttempts++;
          throw new Error('forced auto-approve failure for test');
        }
        return realUpdate(id, patch);
      });

      const stages: ReadonlyArray<PlanningStage> = [
        {
          name: 'plan-stage',
          async run() {
            return {
              value: {
                plans: [{
                  title: 'throwing plan',
                  body: 'plan body',
                  derived_from: ['intent-throw'],
                  principles_applied: [],
                  alternatives_rejected: [],
                  what_breaks_if_revisit: 'nothing',
                  confidence: 0.9,
                  delegation: {
                    sub_actor_principal_id: 'code-author',
                    reason: 'implements',
                    implied_blast_radius: 'tooling',
                  },
                }],
                cost_usd: 0,
              },
              cost_usd: 0,
              duration_ms: 0,
              atom_type: 'plan',
            };
          },
        },
      ];
      const result = await runPipeline(stages, host, {
        principal: 'cto-actor' as PrincipalId,
        correlationId: 'corr-auto-approve-throw',
        seedAtomIds: ['intent-throw' as AtomId],
        now: () => NOW,
        mode: 'substrate-deep',
        stagePolicyAtomId: 'pol-test',
      });
      // Auto-approve threw; runner routed through failPipeline.
      expect(result.kind).toBe('failed');
      if (result.kind !== 'failed') return;
      expect(result.failedStageName).toBe('plan-stage');
      expect(result.cause).toContain('plan-auto-approve-failed');
      // The auto-approve attempt was actually made (substrate reached
      // the update call before throwing).
      expect(updateAttempts).toBeGreaterThan(0);
      // Pipeline atom transitioned to a terminal failed state, not stuck in 'running'.
      const pipelineAtom = await host.atoms.get(result.pipelineId);
      expect(pipelineAtom?.pipeline_state).toBe('failed');
      // pipeline-failed atom written for audit walks.
      const failedAtoms = await host.atoms.query({ type: ['pipeline-failed'] }, 10);
      expect(failedAtoms.atoms.length).toBe(1);
    });

    it('does not auto-approve when a critical audit finding halts the stage', async () => {
      const host = createMemoryHost();
      await seedPauseNeverPolicies(host, ['plan-stage']);
      await seedAutoApprovePolicies(host);
      await seedOperatorIntent(host, 'intent-critical-halt');

      const stages: ReadonlyArray<PlanningStage> = [
        {
          name: 'plan-stage',
          async run() {
            return {
              value: {
                plans: [{
                  title: 'critical-halt plan',
                  body: 'plan body',
                  derived_from: ['intent-critical-halt'],
                  principles_applied: [],
                  alternatives_rejected: [],
                  what_breaks_if_revisit: 'nothing',
                  confidence: 0.9,
                  delegation: {
                    sub_actor_principal_id: 'code-author',
                    reason: 'implements',
                    implied_blast_radius: 'tooling',
                  },
                }],
                cost_usd: 0,
              },
              cost_usd: 0,
              duration_ms: 0,
              atom_type: 'plan',
            };
          },
          async audit() {
            return [
              {
                severity: 'critical',
                category: 'forced-test-finding',
                message: 'forced critical for halt-before-approve test',
                cited_atom_ids: [],
                cited_paths: [],
              },
            ];
          },
        },
      ];
      const result = await runPipeline(stages, host, {
        principal: 'cto-actor' as PrincipalId,
        correlationId: 'corr-critical-halt',
        seedAtomIds: ['intent-critical-halt' as AtomId],
        now: () => NOW,
        mode: 'substrate-deep',
        stagePolicyAtomId: 'pol-test',
      });
      expect(result.kind).toBe('failed');

      const plans = await host.atoms.query({ type: ['plan'] }, 100);
      expect(plans.atoms.length).toBe(1);
      // Critical finding halted before auto-approval, so plan stays proposed.
      expect(plans.atoms[0]!.plan_state).toBe('proposed');
      const events = await host.auditor.query({ kind: ['plan.approved-by-intent'] }, 10);
      expect(events.length).toBe(0);
    });
  });
});
