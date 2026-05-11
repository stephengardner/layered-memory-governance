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

  it('halts the pipeline when a stage exceeds its timeout_ms', async () => {
    const host = createMemoryHost();
    // No HIL-pause seeding required: the failure path returns before
    // the HIL gate runs, so the default 'always' policy never fires.
    const hangingStage: PlanningStage<unknown, unknown> = {
      name: 'hang-stage',
      timeout_ms: 25,
      async run() {
        // Sleep well past the deadline. The setTimeout reject fires
        // first; the runner catches it and routes through failPipeline.
        await new Promise((resolve) => setTimeout(resolve, 250));
        return {
          value: {},
          cost_usd: 0,
          duration_ms: 250,
          atom_type: 'spec-output',
        };
      },
    };
    const result = await runPipeline([hangingStage], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-timeout-stage',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.failedStageName).toBe('hang-stage');
      expect(result.cause).toMatch(/pipeline-stage-timeout/);
      expect(result.cause).toMatch(/25ms/);
    }
  });

  it('honors stage.timeout_ms = 0 as "disable at the stage layer" (does NOT fall through to canon)', async () => {
    // The PlanningStage.timeout_ms contract: any explicit value the
    // stage adapter declares (defined, including zero / negative)
    // overrides the canon `pipeline-stage-timeout` policy fallback.
    // A stage that says "I do NOT want a timeout at this layer" by
    // setting timeout_ms = 0 must NOT silently inherit canon. CR
    // caught the original asymmetry where `> 0` tested both fields,
    // pushing zero-valued stage entries into the canon path. Lock the
    // intent here: a slow stage with timeout_ms=0 and a 30ms canon
    // policy completes successfully, NOT failed-with-timeout.
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['no-timeout-stage']);
    await host.atoms.put({
      schema_version: 1,
      id: 'pol-pipeline-stage-timeout-no-timeout-stage' as AtomId,
      content: 'pipeline-stage-timeout for no-timeout-stage = 30ms',
      type: 'directive',
      layer: 'L3',
      provenance: {
        kind: 'human-asserted',
        source: { tool: 'test' },
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
          subject: 'pipeline-stage-timeout',
          stage_name: 'no-timeout-stage',
          timeout_ms: 30,
        },
      },
    });
    const stage: PlanningStage<unknown, unknown> = {
      name: 'no-timeout-stage',
      timeout_ms: 0,
      async run() {
        // Intentionally slower than the canon 30ms cap. If the runner
        // mistakenly fell through to canon, this would fail.
        await new Promise((resolve) => setTimeout(resolve, 80));
        return {
          value: { ok: true },
          cost_usd: 0,
          duration_ms: 80,
          atom_type: 'spec-output',
        };
      },
    };
    const result = await runPipeline([stage], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-disable-timeout',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('completed');
  });

  it('respects the canon `pipeline-stage-timeout` policy when the stage adapter omits timeout_ms', async () => {
    // Operator-tunable knob: an org wants a global per-stage timeout
    // without forcing every stage adapter to declare one. Seed a
    // canon directive with subject='pipeline-stage-timeout' for the
    // stage and verify the runner picks it up via the policy
    // resolver. Mirrors how cost-cap policy and HIL policy already
    // ship.
    const host = createMemoryHost();
    await host.atoms.put({
      schema_version: 1,
      id: 'pol-pipeline-stage-timeout-slow' as AtomId,
      content: 'pipeline-stage-timeout for slow-stage = 30ms',
      type: 'directive',
      layer: 'L3',
      provenance: {
        kind: 'human-asserted',
        source: { tool: 'test' },
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
          subject: 'pipeline-stage-timeout',
          stage_name: 'slow-stage',
          timeout_ms: 30,
        },
      },
    });
    const slowStage: PlanningStage<unknown, unknown> = {
      name: 'slow-stage',
      async run() {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return {
          value: {},
          cost_usd: 0,
          duration_ms: 250,
          atom_type: 'spec-output',
        };
      },
    };
    const result = await runPipeline([slowStage], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-timeout-policy',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.cause).toMatch(/pipeline-stage-timeout/);
      expect(result.cause).toMatch(/30ms/);
    }
  });

  it('halts the pipeline when total stage cost exceeds the per-pipeline `pipeline-cost-cap` policy', async () => {
    // Per-pipeline cap is the run-level fence on cumulative cost: a
    // long-running deep-pipeline run can stay under each per-stage cap
    // and still burn a multiple of any single stage's budget. The
    // canon directive `pipeline-cost-cap` (no stage_name; global)
    // governs the total. Two cheap stages here: 0.20 + 0.15 = 0.35,
    // cap = 0.30, so the cap trips on the second stage's accumulator
    // update -- not the first -- proving the runner sums across
    // stages rather than checking a single-stage value.
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['stage-a', 'stage-b']);
    await host.atoms.put({
      schema_version: 1,
      id: 'pol-pipeline-cost-cap' as AtomId,
      content: 'pipeline-cost-cap = 0.30',
      type: 'directive',
      layer: 'L3',
      provenance: {
        kind: 'human-asserted',
        source: { tool: 'test' },
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
          subject: 'pipeline-cost-cap',
          cap_usd: 0.30,
        },
      },
    });
    const stageA: PlanningStage<unknown, unknown> = {
      name: 'stage-a',
      async run() {
        return {
          value: {},
          cost_usd: 0.20,
          duration_ms: 0,
          atom_type: 'spec-output',
        };
      },
    };
    const stageB: PlanningStage<unknown, unknown> = {
      name: 'stage-b',
      async run() {
        return {
          value: {},
          cost_usd: 0.15,
          duration_ms: 0,
          atom_type: 'spec-output',
        };
      },
    };
    const result = await runPipeline([stageA, stageB], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-pipeline-cost-cap',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.cause).toMatch(/pipeline-cost-overflow/);
      expect(result.cause).toMatch(/0\.3/);
      expect(result.failedStageName).toBe('stage-b');
    }
  });

  it('allows the pipeline when total stage cost exactly equals the per-pipeline `pipeline-cost-cap` policy (boundary)', async () => {
    // Locks the strict-greater-than contract: total === cap MUST NOT
    // fail. An off-by-one regression that flipped > to >= would push
    // an exactly-budgeted run into failed; this test catches that.
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['stage-a', 'stage-b']);
    await host.atoms.put({
      schema_version: 1,
      id: 'pol-pipeline-cost-cap' as AtomId,
      content: 'pipeline-cost-cap = 0.50',
      type: 'directive',
      layer: 'L3',
      provenance: {
        kind: 'human-asserted',
        source: { tool: 'test' },
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
          subject: 'pipeline-cost-cap',
          cap_usd: 0.5,
        },
      },
    });
    const stageA: PlanningStage<unknown, unknown> = {
      name: 'stage-a',
      async run() {
        return { value: {}, cost_usd: 0.25, duration_ms: 0, atom_type: 'spec-output' };
      },
    };
    const stageB: PlanningStage<unknown, unknown> = {
      name: 'stage-b',
      async run() {
        return { value: {}, cost_usd: 0.25, duration_ms: 0, atom_type: 'spec-output' };
      },
    };
    const result = await runPipeline([stageA, stageB], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-pipeline-cost-cap-equality',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('completed');
  });

  it('retries a stage with `retry: with-jitter` until it succeeds within max_attempts', async () => {
    // The PlanningStage.retry seam was reserved as a type but never
    // wired into the runner; this test locks the wiring. A flaky
    // stage that throws on the first two calls and succeeds on the
    // third must complete the pipeline when retry.max_attempts >= 3.
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['flaky-stage']);
    let attempts = 0;
    const flakyStage: PlanningStage<unknown, unknown> = {
      name: 'flaky-stage',
      retry: { kind: 'with-jitter', max_attempts: 3, base_delay_ms: 1 },
      async run() {
        attempts++;
        if (attempts < 3) {
          throw new Error('transient: connection reset');
        }
        return {
          value: {},
          cost_usd: 0,
          duration_ms: 0,
          atom_type: 'spec-output',
        };
      },
    };
    const result = await runPipeline([flakyStage], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-retry-success',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('completed');
    expect(attempts).toBe(3);
  });

  it('fails the pipeline when a stage throws on every retry attempt', async () => {
    // Once max_attempts is reached, the runner re-throws the last
    // error and the existing failPipeline path takes over. The cause
    // surfaces the original message so an operator can read what the
    // final attempt hit.
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['always-fails']);
    let attempts = 0;
    const failingStage: PlanningStage<unknown, unknown> = {
      name: 'always-fails',
      retry: { kind: 'with-jitter', max_attempts: 2, base_delay_ms: 1 },
      async run() {
        attempts++;
        throw new Error('upstream-LLM-503');
      },
    };
    const result = await runPipeline([failingStage], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-retry-exhausted',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.cause).toMatch(/upstream-LLM-503/);
      expect(result.failedStageName).toBe('always-fails');
    }
    expect(attempts).toBe(2);
  });

  it('does NOT retry on timeout errors (timeout = stage hung; retry would overlap)', async () => {
    // CR-flagged Critical: raceStageWithTimeout does not cancel the
    // underlying stage.run() promise. Retrying on timeout would start
    // a fresh stage.run() while the prior one is still in flight,
    // which is unsafe for any non-idempotent stage. Lock the
    // contract: timeout = terminal, no retry. The pipeline fails on
    // attempt 1 even when max_attempts > 1.
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['hang-stage']);
    let attempts = 0;
    const hangStage: PlanningStage<unknown, unknown> = {
      name: 'hang-stage',
      timeout_ms: 25,
      retry: { kind: 'with-jitter', max_attempts: 5, base_delay_ms: 1 },
      async run() {
        attempts++;
        await new Promise((resolve) => setTimeout(resolve, 250));
        return {
          value: {},
          cost_usd: 0,
          duration_ms: 250,
          atom_type: 'spec-output',
        };
      },
    };
    const result = await runPipeline([hangStage], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-no-retry-on-timeout',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.cause).toMatch(/pipeline-stage-timeout/);
    }
    expect(attempts).toBe(1);
  });

  it('falls back to canon `pipeline-stage-retry` policy when stage.retry is omitted', async () => {
    // Operator-tunable knob: an org wants a global per-stage retry
    // strategy without forcing every stage adapter to declare one.
    // Seed a canon directive with subject='pipeline-stage-retry' for
    // the stage and verify the runner picks it up. Mirrors how cost-cap
    // and timeout policies already ship.
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['canon-flaky']);
    await host.atoms.put({
      schema_version: 1,
      id: 'pol-pipeline-stage-retry-canon-flaky' as AtomId,
      content: 'canon retry for canon-flaky = max 3 / base 1ms',
      type: 'directive',
      layer: 'L3',
      provenance: { kind: 'human-asserted', source: { tool: 'test' }, derived_from: [] },
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
          subject: 'pipeline-stage-retry',
          stage_name: 'canon-flaky',
          max_attempts: 3,
          base_delay_ms: 1,
        },
      },
    });
    let attempts = 0;
    const stage: PlanningStage<unknown, unknown> = {
      name: 'canon-flaky',
      // No `retry` field declared on the adapter; rely on canon.
      async run() {
        attempts++;
        if (attempts < 3) {
          throw new Error('transient: canon-driven retry');
        }
        return { value: {}, cost_usd: 0, duration_ms: 0, atom_type: 'spec-output' };
      },
    };
    const result = await runPipeline([stage], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-canon-retry-fallback',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('completed');
    expect(attempts).toBe(3);
  });

  it('prefers explicit stage.retry over canon `pipeline-stage-retry` policy', async () => {
    // Precedence contract: stage.retry on the adapter is authoritative;
    // canon is the fallback when the adapter omits it. Seed a permissive
    // canon (max 5 / base 1ms) and a stage that explicitly sets
    // { kind: 'no-retry' }; verify the stage runs exactly once.
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['canon-vs-explicit']);
    await host.atoms.put({
      schema_version: 1,
      id: 'pol-pipeline-stage-retry-canon-vs-explicit' as AtomId,
      content: 'canon retry for canon-vs-explicit = max 5 / base 1ms',
      type: 'directive',
      layer: 'L3',
      provenance: { kind: 'human-asserted', source: { tool: 'test' }, derived_from: [] },
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
          subject: 'pipeline-stage-retry',
          stage_name: 'canon-vs-explicit',
          max_attempts: 5,
          base_delay_ms: 1,
        },
      },
    });
    let attempts = 0;
    const stage: PlanningStage<unknown, unknown> = {
      name: 'canon-vs-explicit',
      retry: { kind: 'no-retry' },
      async run() {
        attempts++;
        throw new Error('boom: canon would retry but explicit no-retry wins');
      },
    };
    const result = await runPipeline([stage], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-explicit-retry-wins',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('failed');
    expect(attempts).toBe(1);
  });

  it('does not retry when stage.retry is omitted (default no-retry posture)', async () => {
    // Default-deny: no retry config means a single attempt. Lock it
    // so future agents do not assume retry-on-by-default and ship a
    // change that quietly multiplies LLM spend.
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['no-retry-stage']);
    let attempts = 0;
    const stage: PlanningStage<unknown, unknown> = {
      name: 'no-retry-stage',
      async run() {
        attempts++;
        throw new Error('boom');
      },
    };
    const result = await runPipeline([stage], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-no-retry-default',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('failed');
    expect(attempts).toBe(1);
  });

  it('stamps cost_projection on the pipeline atom at run start when every stage has an effective cap', async () => {
    // Operator visibility: the upfront projection sums each stage's
    // effective cap (stage.budget_cap_usd or canon
    // pipeline-stage-cost-cap) and lands on the pipeline atom's
    // metadata so Console can show "estimated total" alongside the
    // running total. Two capped stages: 0.40 + 0.10 = 0.50 projected.
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['stage-a', 'stage-b']);
    const stageA: PlanningStage<unknown, unknown> = {
      name: 'stage-a',
      budget_cap_usd: 0.4,
      async run() {
        return { value: {}, cost_usd: 0, duration_ms: 0, atom_type: 'spec-output' };
      },
    };
    const stageB: PlanningStage<unknown, unknown> = {
      name: 'stage-b',
      budget_cap_usd: 0.1,
      async run() {
        return { value: {}, cost_usd: 0, duration_ms: 0, atom_type: 'spec-output' };
      },
    };
    await runPipeline([stageA, stageB], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-projection-fully-capped',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    const persisted = await host.atoms.get('pipeline-corr-projection-fully-capped' as AtomId);
    expect(persisted).not.toBeNull();
    const projection = (persisted?.metadata as Record<string, unknown> | undefined)?.cost_projection;
    expect(projection).toEqual({
      projected_total_usd: 0.5,
      capped_stage_count: 2,
      uncapped_stage_names: [],
    });
  });

  it('marks projected_total_usd null when any stage is uncapped (cannot estimate)', async () => {
    // Default-deny: an uncapped stage means the upper bound is
    // unknowable. Returning a misleading partial sum would mask the
    // real risk; stamp null + the offending stage names so the
    // operator sees the gap explicitly rather than a confident-looking
    // wrong number.
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['capped-stage', 'free-stage']);
    const cappedStage: PlanningStage<unknown, unknown> = {
      name: 'capped-stage',
      budget_cap_usd: 1,
      async run() {
        return { value: {}, cost_usd: 0, duration_ms: 0, atom_type: 'spec-output' };
      },
    };
    const freeStage: PlanningStage<unknown, unknown> = {
      name: 'free-stage',
      async run() {
        return { value: {}, cost_usd: 0, duration_ms: 0, atom_type: 'spec-output' };
      },
    };
    await runPipeline([cappedStage, freeStage], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-projection-partially-uncapped',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    const persisted = await host.atoms.get('pipeline-corr-projection-partially-uncapped' as AtomId);
    const projection = (persisted?.metadata as Record<string, unknown> | undefined)?.cost_projection;
    expect(projection).toEqual({
      projected_total_usd: null,
      capped_stage_count: 1,
      uncapped_stage_names: ['free-stage'],
    });
  });

  it('reads the canon `pipeline-stage-cost-cap` policy when stage.budget_cap_usd is not declared', async () => {
    // Mirrors readPipelineStageCostCapPolicy resolution: stage-supplied
    // wins, canon falls through. The projection treats both the same
    // -- a canon-resolved cap counts as "capped" for the projection.
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['canon-capped']);
    await host.atoms.put({
      schema_version: 1,
      id: 'pol-pipeline-stage-cost-cap-canon-capped' as AtomId,
      content: 'canon cap for canon-capped = 0.25',
      type: 'directive',
      layer: 'L3',
      provenance: { kind: 'human-asserted', source: { tool: 'test' }, derived_from: [] },
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
        policy: { subject: 'pipeline-stage-cost-cap', stage_name: 'canon-capped', cap_usd: 0.25 },
      },
    });
    const stage: PlanningStage<unknown, unknown> = {
      name: 'canon-capped',
      async run() {
        return { value: {}, cost_usd: 0, duration_ms: 0, atom_type: 'spec-output' };
      },
    };
    await runPipeline([stage], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-projection-canon-fallback',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    const persisted = await host.atoms.get('pipeline-corr-projection-canon-fallback' as AtomId);
    const projection = (persisted?.metadata as Record<string, unknown> | undefined)?.cost_projection;
    expect(projection).toEqual({
      projected_total_usd: 0.25,
      capped_stage_count: 1,
      uncapped_stage_names: [],
    });
  });

  it('treats stage.budget_cap_usd === 0 as an explicit cap (not "uncapped"), matching runtime resolution', async () => {
    // CR-flagged Major: runtime uses `stage.budget_cap_usd ?? policyCap`
    // so an explicit 0 is a real cap. The projection MUST match that
    // semantics or it will mis-classify a 0-cap stage as uncapped + emit
    // null projected_total_usd when the runtime would actually enforce 0.
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['zero-cap', 'one-dollar']);
    const zeroCap: PlanningStage<unknown, unknown> = {
      name: 'zero-cap',
      budget_cap_usd: 0,
      async run() {
        return { value: {}, cost_usd: 0, duration_ms: 0, atom_type: 'spec-output' };
      },
    };
    const oneDollar: PlanningStage<unknown, unknown> = {
      name: 'one-dollar',
      budget_cap_usd: 1,
      async run() {
        return { value: {}, cost_usd: 0, duration_ms: 0, atom_type: 'spec-output' };
      },
    };
    await runPipeline([zeroCap, oneDollar], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-projection-zero-cap',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    const persisted = await host.atoms.get('pipeline-corr-projection-zero-cap' as AtomId);
    const projection = (persisted?.metadata as Record<string, unknown> | undefined)?.cost_projection;
    expect(projection).toEqual({
      projected_total_usd: 1,
      capped_stage_count: 2,
      uncapped_stage_names: [],
    });
  });

  it('uses integer micros to sum projection caps so 0.1 + 0.2 yields exactly 0.3 (no IEEE-754 drift)', async () => {
    // CR-flagged Major: direct float summation would leak IEEE-754
    // representation drift into projected_total_usd. Using integer
    // micros (matching the runtime cap-check at runner.ts:479+496)
    // keeps the projection exact for canonical values.
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['stage-a', 'stage-b']);
    const stageA: PlanningStage<unknown, unknown> = {
      name: 'stage-a',
      budget_cap_usd: 0.1,
      async run() {
        return { value: {}, cost_usd: 0, duration_ms: 0, atom_type: 'spec-output' };
      },
    };
    const stageB: PlanningStage<unknown, unknown> = {
      name: 'stage-b',
      budget_cap_usd: 0.2,
      async run() {
        return { value: {}, cost_usd: 0, duration_ms: 0, atom_type: 'spec-output' };
      },
    };
    await runPipeline([stageA, stageB], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-projection-precision',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    const persisted = await host.atoms.get('pipeline-corr-projection-precision' as AtomId);
    const projection = (persisted?.metadata as Record<string, unknown> | undefined)?.cost_projection;
    expect((projection as { projected_total_usd: number }).projected_total_usd).toBe(0.3);
  });

  it('does not falsely trip the per-pipeline cost cap on IEEE-754 representation drift (0.1 + 0.2 vs 0.3)', async () => {
    // Regression for CR-flagged precision bug: comparing accumulated
    // USD floats directly trips when 0.1 + 0.2 evaluates to
    // 0.30000000000000004 > 0.3. The runner converts to integer micros
    // before comparing so the canonical floating-point footgun does
    // NOT cause a false overflow.
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['stage-a', 'stage-b']);
    await host.atoms.put({
      schema_version: 1,
      id: 'pol-pipeline-cost-cap' as AtomId,
      content: 'pipeline-cost-cap = 0.30',
      type: 'directive',
      layer: 'L3',
      provenance: {
        kind: 'human-asserted',
        source: { tool: 'test' },
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
          subject: 'pipeline-cost-cap',
          cap_usd: 0.3,
        },
      },
    });
    const stageA: PlanningStage<unknown, unknown> = {
      name: 'stage-a',
      async run() {
        return {
          value: {},
          cost_usd: 0.1,
          duration_ms: 0,
          atom_type: 'spec-output',
        };
      },
    };
    const stageB: PlanningStage<unknown, unknown> = {
      name: 'stage-b',
      async run() {
        return {
          value: {},
          cost_usd: 0.2,
          duration_ms: 0,
          atom_type: 'spec-output',
        };
      },
    };
    const result = await runPipeline([stageA, stageB], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-pipeline-cost-cap-precision',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).not.toBe('failed');
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
      // operator can inspect it after the pipeline halts. Under the
      // auditor-feedback re-prompt loop, the runner attempts the stage
      // up to pol-auditor-feedback-reprompt-default.max_attempts times
      // (default 2). When every attempt produces a critical finding,
      // the runner persists one stage-output atom per attempt and then
      // halts -- so the operator sees BOTH attempts' outputs and can
      // diff them to understand what the LLM tried.
      const brainstormAtoms = await host.atoms.query(
        { type: ['brainstorm-output'] }, 100,
      );
      expect(brainstormAtoms.atoms.length).toBe(2);
      // The attempt-2 atom carries the suffix in its id and the
      // attempt_index in its metadata for audit-side filtering.
      const attempt2 = brainstormAtoms.atoms.find(
        (a) => (a.metadata as Record<string, unknown>)?.attempt_index === 2,
      );
      expect(attempt2).toBeDefined();
      expect(String(attempt2?.id)).toContain('-attempt-2');
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

      // Under the auditor-feedback re-prompt loop, the runner attempts
      // the plan-stage up to pol-auditor-feedback-reprompt-default.max_attempts
      // times (default 2). When every attempt produces a critical finding,
      // the runner persists one plan atom per attempt and then halts on
      // the second attempt's finding. Neither plan gets auto-approved
      // because each attempt's critical-audit-finding halts BEFORE the
      // auto-approve pass runs.
      const plans = await host.atoms.query({ type: ['plan'] }, 100);
      expect(plans.atoms.length).toBe(2);
      // Both plans stay proposed -- critical findings halt before
      // auto-approval runs on either attempt.
      for (const plan of plans.atoms) {
        expect(plan.plan_state).toBe('proposed');
      }
      const events = await host.auditor.query({ kind: ['plan.approved-by-intent'] }, 10);
      expect(events.length).toBe(0);
    });
  });

  /*
   * Pipeline-abandon coverage.
   *
   * The runner observes a `pipeline-abandoned` atom matching the
   * current pipeline before each stage transition and halts cleanly
   * with kind: 'abandoned'. The atom-store filter is `type ==
   * 'pipeline-abandoned'` plus `metadata.pipeline_id` join, so atoms
   * for OTHER pipelines must not divert the current pipeline.
   *
   * The check runs BEFORE the next stage's enter event; an abandon
   * that lands mid-stage does NOT cancel the in-flight stage (the
   * substrate has no AgentLoopAdapter cancel seam yet), but the next
   * stage is NEVER dispatched.
   */
  describe('pipeline-abandon halt', () => {
    /*
     * Helper to seed a pipeline-abandoned atom into the memory host.
     * Mirrors the substrate's pipeline-abandoned shape but stays
     * minimal -- the runner observes the atom by type + metadata
     * pipeline_id and does not require the full Console-side audit
     * fields.
     */
    async function seedAbandonAtom(
      host: MemoryHost,
      opts: {
        pipelineId: string;
        atomId?: string;
        reason?: string;
      },
    ): Promise<string> {
      const atomId = opts.atomId ?? `pipeline-abandoned-${opts.pipelineId}-test`;
      await host.atoms.put({
        schema_version: 1,
        id: atomId as AtomId,
        content: `abandoned:${opts.pipelineId}`,
        type: 'pipeline-abandoned',
        layer: 'L0',
        provenance: {
          kind: 'user-directive',
          source: { tool: 'test-fixture' },
          derived_from: [opts.pipelineId as AtomId],
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
          pipeline_id: opts.pipelineId,
          reason: opts.reason ?? 'test-fixture abandon',
          abandoned_at: NOW,
          abandoner_principal_id: 'apex-agent',
        },
      });
      return atomId;
    }

    it('halts with kind="abandoned" when an abandon atom lands before the first stage', async () => {
      const host = createMemoryHost();
      await seedPauseNeverPolicies(host, ['stage-a', 'stage-b']);
      const pipelineId = 'pipeline-corr-abandon-pre';
      // Seed the abandon atom BEFORE runPipeline starts so the
      // first-stage check finds it.
      const abandonId = await seedAbandonAtom(host, {
        pipelineId,
        atomId: 'pipeline-abandoned-pre-1',
      });
      let runCount = 0;
      const stages = [
        mkStage<unknown, { a: number }>('stage-a', () => {
          runCount += 1;
          return { a: 1 };
        }),
        mkStage<{ a: number }, { b: number }>('stage-b', (i) => {
          runCount += 1;
          return { b: i.a + 1 };
        }),
      ];
      const result = await runPipeline(stages, host, {
        principal: 'cto-actor' as PrincipalId,
        correlationId: 'corr-abandon-pre',
        seedAtomIds: ['intent-1' as AtomId],
        now: () => NOW,
        mode: 'substrate-deep',
        stagePolicyAtomId: 'pol-test',
      });
      expect(result.kind).toBe('abandoned');
      if (result.kind === 'abandoned') {
        expect(result.pipelineId).toBe(pipelineId);
        expect(result.abandonAtomId).toBe(abandonId);
      }
      // No stages should have dispatched.
      expect(runCount).toBe(0);
      // The pipeline atom should carry pipeline_state='abandoned'.
      const pipelineAtom = await host.atoms.get(pipelineId as AtomId);
      expect(pipelineAtom?.pipeline_state).toBe('abandoned');
    });

    it('halts between stages when an abandon atom lands after the first stage completes', async () => {
      const host = createMemoryHost();
      await seedPauseNeverPolicies(host, ['stage-a', 'stage-b']);
      const pipelineId = 'pipeline-corr-abandon-mid';
      // Stage-a writes the abandon atom from inside its run handler.
      // This simulates the operator clicking abandon AFTER stage-a
      // emits its output but BEFORE stage-b dispatches. The runner's
      // next-iteration check should catch it.
      let stageAReached = false;
      let stageBReached = false;
      const stageA: PlanningStage<unknown, { a: number }> = {
        name: 'stage-a',
        async run() {
          stageAReached = true;
          // Write the abandon atom from inside the stage to simulate
          // an out-of-band write (the substrate has no cancel seam yet
          // so the in-flight stage runs to completion; the next stage
          // is what gets cancelled).
          await seedAbandonAtom(host, {
            pipelineId,
            atomId: 'pipeline-abandoned-mid-1',
          });
          return {
            value: { a: 1 },
            cost_usd: 0,
            duration_ms: 0,
            atom_type: 'spec',
          };
        },
      };
      const stageB: PlanningStage<{ a: number }, { b: number }> = {
        name: 'stage-b',
        async run(input) {
          stageBReached = true;
          return {
            value: { b: input.a + 1 },
            cost_usd: 0,
            duration_ms: 0,
            atom_type: 'spec',
          };
        },
      };
      const result = await runPipeline([stageA, stageB], host, {
        principal: 'cto-actor' as PrincipalId,
        correlationId: 'corr-abandon-mid',
        seedAtomIds: ['intent-1' as AtomId],
        now: () => NOW,
        mode: 'substrate-deep',
        stagePolicyAtomId: 'pol-test',
      });
      expect(result.kind).toBe('abandoned');
      // Stage-a IS allowed to complete; stage-b never dispatches.
      expect(stageAReached).toBe(true);
      expect(stageBReached).toBe(false);
    });

    it('ignores tainted pipeline-abandoned atoms', async () => {
      const host = createMemoryHost();
      await seedPauseNeverPolicies(host, ['stage-a']);
      const pipelineId = 'pipeline-corr-abandon-tainted';
      // Seed a TAINTED abandon atom; the runner must not honor it.
      await host.atoms.put({
        schema_version: 1,
        id: 'pipeline-abandoned-tainted-1' as AtomId,
        content: `abandoned:${pipelineId}`,
        type: 'pipeline-abandoned',
        layer: 'L0',
        provenance: {
          kind: 'user-directive',
          source: { tool: 'test-fixture' },
          derived_from: [pipelineId as AtomId],
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
        taint: 'compromised',
        metadata: {
          pipeline_id: pipelineId,
          reason: 'tainted abandon should be ignored',
          abandoned_at: NOW,
          abandoner_principal_id: 'apex-agent',
        },
      });
      const stages = [
        mkStage<unknown, { a: number }>('stage-a', () => ({ a: 1 })),
      ];
      const result = await runPipeline(stages, host, {
        principal: 'cto-actor' as PrincipalId,
        correlationId: 'corr-abandon-tainted',
        seedAtomIds: ['intent-1' as AtomId],
        now: () => NOW,
        mode: 'substrate-deep',
        stagePolicyAtomId: 'pol-test',
      });
      // Tainted abandon should be ignored; pipeline completes normally.
      expect(result.kind).toBe('completed');
    });

    it('returns kind="abandoned" via the race backstop when pipeline_state is already abandoned', async () => {
      /*
       * Race-backstop path: a concurrent writer flipped the pipeline
       * atom to pipeline_state='abandoned' between the abandon-poll
       * and the claim-before-mutate re-read AFTER our findPipelineAbandonAtom
       * walk failed (e.g., the atom landed in a paginated section past
       * our walk cap). The runner's claim-check path observes the
       * terminal state and must preserve the 'abandoned' return kind
       * rather than collapsing into 'halted' (which is the global
       * kill-switch reason).
       *
       * Fixture: a memory host whose pipeline atom is already at
       * pipeline_state='abandoned' from a prior writer; no
       * pipeline-abandoned atom is added (forces the
       * findPipelineAbandonAtom poll to miss + the claim-before-mutate
       * re-read to catch). Tests the CR PR #402 outside-diff finding.
       */
      const host = createMemoryHost();
      await seedPauseNeverPolicies(host, ['stage-a']);
      const pipelineId = 'pipeline-corr-abandon-backstop';
      // Seed the pipeline atom directly in abandoned state with the
      // metadata.abandon_atom_id set, simulating a writer-side flip
      // that the abandon-atom poll missed.
      await host.atoms.put({
        schema_version: 1,
        id: pipelineId as AtomId,
        content: '',
        type: 'pipeline',
        layer: 'L0',
        provenance: {
          kind: 'observation',
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
        principal_id: 'cto-actor' as PrincipalId,
        taint: 'clean',
        pipeline_state: 'abandoned',
        metadata: {
          abandon_atom_id: 'pipeline-abandoned-prior-1',
        },
      });
      const stages = [
        mkStage<unknown, { a: number }>('stage-a', () => ({ a: 1 })),
      ];
      const result = await runPipeline(stages, host, {
        principal: 'cto-actor' as PrincipalId,
        correlationId: 'corr-abandon-backstop',
        seedAtomIds: ['intent-1' as AtomId],
        now: () => NOW,
        mode: 'substrate-deep',
        stagePolicyAtomId: 'pol-test',
      });
      // The race-backstop must surface 'abandoned' kind, NOT 'halted',
      // and carry the abandon_atom_id from the pipeline metadata.
      expect(result.kind).toBe('abandoned');
      if (result.kind === 'abandoned') {
        expect(result.abandonAtomId).toBe('pipeline-abandoned-prior-1');
      }
    });

    it('falls through to halted when pipeline_state is abandoned but abandon_atom_id is missing', async () => {
      /*
       * Defensive fallback: if for any reason the pipeline atom is in
       * pipeline_state='abandoned' but metadata.abandon_atom_id is
       * absent (unusual: writer side stamps it on every flip), the
       * race-backstop falls through to halted rather than fabricating
       * an atom id. The pipeline_state='abandoned' is still observable
       * on disk for audit consumers.
       */
      const host = createMemoryHost();
      await seedPauseNeverPolicies(host, ['stage-a']);
      const pipelineId = 'pipeline-corr-abandon-no-id';
      await host.atoms.put({
        schema_version: 1,
        id: pipelineId as AtomId,
        content: '',
        type: 'pipeline',
        layer: 'L0',
        provenance: {
          kind: 'observation',
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
        principal_id: 'cto-actor' as PrincipalId,
        taint: 'clean',
        pipeline_state: 'abandoned',
        // No abandon_atom_id in metadata.
        metadata: {},
      });
      const stages = [
        mkStage<unknown, { a: number }>('stage-a', () => ({ a: 1 })),
      ];
      const result = await runPipeline(stages, host, {
        principal: 'cto-actor' as PrincipalId,
        correlationId: 'corr-abandon-no-id',
        seedAtomIds: ['intent-1' as AtomId],
        now: () => NOW,
        mode: 'substrate-deep',
        stagePolicyAtomId: 'pol-test',
      });
      // No abandon_atom_id -> fall through to halted.
      expect(result.kind).toBe('halted');
    });

    it('ignores abandon atoms targeting a different pipeline', async () => {
      const host = createMemoryHost();
      await seedPauseNeverPolicies(host, ['stage-a']);
      const myPipelineId = 'pipeline-corr-abandon-mine';
      const otherPipelineId = 'pipeline-corr-abandon-other';
      // Seed an abandon atom whose pipeline_id targets a DIFFERENT
      // pipeline. The runner's join must scope the abandon-poll to
      // the running pipeline only.
      await seedAbandonAtom(host, {
        pipelineId: otherPipelineId,
        atomId: 'pipeline-abandoned-other-1',
      });
      const stages = [
        mkStage<unknown, { a: number }>('stage-a', () => ({ a: 1 })),
      ];
      const result = await runPipeline(stages, host, {
        principal: 'cto-actor' as PrincipalId,
        correlationId: 'corr-abandon-mine',
        seedAtomIds: ['intent-1' as AtomId],
        now: () => NOW,
        mode: 'substrate-deep',
        stagePolicyAtomId: 'pol-test',
      });
      // Pipeline completes normally; the other pipeline's abandon
      // atom MUST NOT divert this run.
      expect(result.kind).toBe('completed');
      if (result.kind === 'completed') {
        expect(result.pipelineId).toBe(myPipelineId);
      }
    });
  });
});
