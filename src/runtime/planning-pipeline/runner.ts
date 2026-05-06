/**
 * PipelineRunner state machine.
 *
 * Walks a ReadonlyArray<PlanningStage> sequentially, projecting state
 * via atom writes (mirrors the intent-approve and plan-dispatch passes
 * in src/runtime/actor-message/). Pure mechanism: concrete stage logic
 * lives in stage adapters, NOT here.
 *
 * Threat-model posture (mirrors the existing actor-message passes):
 *
 * - Kill-switch absolute priority: scheduler.killswitchCheck() is
 *   polled BEFORE any write and BEFORE every stage transition. On
 *   STOP the runner returns `halted`; an in-flight stage's promise is
 *   awaited then ignored rather than left dangling.
 * - Claim-before-mutate: every transition re-reads the pipeline atom
 *   and aborts if the atom is missing or tainted, so two concurrent
 *   ticks cannot both advance the same pipeline.
 * - Per-stage budget cap: stage.budget_cap_usd, with a canon-policy
 *   fallback. A breach halts the stage with cause: 'budget-overflow'.
 * - Schema validation: stage.outputSchema?.safeParse(output.value)
 *   runs before the stage's output is treated as valid. A schema-fail
 *   halts the stage; the LLM-emitted payload outside the schema NEVER
 *   reaches a downstream stage.
 * - Auditor wiring: stage.audit?(value, ctx) runs after run(); each
 *   finding produces a pipeline-audit-finding atom. A 'critical'
 *   finding halts the stage. Default-deny: a stage with NO auditor
 *   cannot auto-advance past an `on-critical-finding` HIL gate; that
 *   forces the runner into hil-paused.
 * - HIL pause flow: when the resolved policy says 'always' or
 *   'on-critical-finding', the runner transitions the pipeline atom
 *   to 'hil-paused' and writes a pipeline-stage-event with
 *   transition: 'hil-pause'. Resume happens via a pipeline-resume
 *   atom signed by an allowed_resumers principal (validated by the
 *   resume entrypoint, not the runner).
 * - Bounded loop: MAX_STAGES bounds runaway stage lists with cycles
 *   in dependsOn (forward-compat seam).
 */

import type { Host } from '../../substrate/interface.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../substrate/types.js';
import type {
  AuditFinding,
  PlanningStage,
  StageInput,
  StageOutput,
} from './types.js';
import {
  mkBrainstormOutputAtom,
  mkDispatchRecordAtom,
  mkPipelineAtom,
  mkPipelineAuditFindingAtom,
  mkPipelineFailedAtom,
  mkPipelineStageEventAtom,
  mkPlanOutputAtoms,
  mkReviewReportAtom,
  mkSpecOutputAtom,
  projectStageOutputForMetadata,
  serializeStageOutput,
} from './atom-shapes.js';
import {
  readPipelineStageCostCapPolicy,
  readPipelineStageHilPolicy,
} from './policy.js';
import { runPipelinePlanAutoApproval } from './auto-approve.js';

/**
 * Bound on the number of stages a single pipeline run may walk.
 * Mechanism constant: a malformed stages list with a cycle in the
 * forward-compat dependsOn seam cannot infinite-loop here.
 */
const MAX_STAGES = 64;

export type PipelineResult =
  | { readonly kind: 'completed'; readonly pipelineId: AtomId }
  | {
      readonly kind: 'failed';
      readonly pipelineId: AtomId;
      readonly failedStageName: string;
      readonly cause: string;
    }
  | {
      readonly kind: 'hil-paused';
      readonly pipelineId: AtomId;
      readonly stageName: string;
    }
  | { readonly kind: 'halted'; readonly pipelineId?: AtomId };

export interface RunPipelineOptions {
  readonly principal: PrincipalId;
  readonly correlationId: string;
  readonly seedAtomIds: ReadonlyArray<AtomId>;
  readonly stagePolicyAtomId: string;
  readonly mode: 'single-pass' | 'substrate-deep';
  readonly now?: () => Time;
  readonly resumeFromStage?: string;
  /**
   * Optional priorOutput hydration for the resumeFromStage path. When
   * resuming mid-pipeline, the caller supplies the prior stage's
   * StageOutput.value so the named stage's StageInput.priorOutput is
   * not silently `null`. Stage outputs ARE persisted as typed atoms
   * in the substrate; the resume entrypoint reads the prior stage's
   * output atom and passes its value via this option, keeping the
   * resume contract independent of the persistence shape.
   */
  readonly priorOutput?: unknown;
  /**
   * Optional prior stage-output atom-id chain for the resumeFromStage
   * path. When a pipeline is resumed mid-walk, the resume entrypoint
   * MUST pass the chain of stage-output atom ids written by the
   * already-completed upstream stages so the first newly-persisted
   * stage's derived_from chain captures the full upstream lineage.
   * Without this, resumed runs lose the upstream stage-output
   * provenance link and the dispatch-stage's planFilter (or any
   * audit walk) cannot reconstruct the full pipeline chain from a
   * resumed plan atom alone.
   *
   * Defaults to empty (the runner walks the whole pipeline freshly);
   * the resume entrypoint is the canonical caller that supplies a
   * non-empty chain.
   */
  readonly priorOutputAtomIds?: ReadonlyArray<AtomId>;
  /**
   * Verified citation set forwarded to every stage's StageInput. The
   * caller (e.g. a deep-pipeline driver) computes this from the seed
   * atoms plus the canon atoms applicable at the planning principal's
   * scope, and the runner threads it through to each stage's
   * StageInput.verifiedCitedAtomIds without inspecting the contents.
   * When omitted the runner forwards an empty list; stage adapters
   * with a non-empty grounding contract must fail closed in that case.
   */
  readonly verifiedCitedAtomIds?: ReadonlyArray<AtomId>;
  /**
   * Verified sub-actor principal-id set forwarded to every stage's
   * StageInput. The caller (e.g. a deep-pipeline driver) computes
   * this from the seed operator-intent's
   * metadata.trust_envelope.allowed_sub_actors -- the intent envelope
   * IS the per-run "allowed sub-actors" coordinate, so reading from
   * any other source would drift from the auto-approve gate. The
   * runner threads it through to each stage's
   * StageInput.verifiedSubActorPrincipalIds and
   * StageContext.verifiedSubActorPrincipalIds without inspecting the
   * contents. When omitted the runner forwards an empty list; stage
   * adapters whose audit depends on a non-empty grounding contract
   * fall back to resolvability-only (legacy callers, including direct
   * audit() invocations from tests, do not compute a verified set).
   */
  readonly verifiedSubActorPrincipalIds?: ReadonlyArray<PrincipalId>;
  /**
   * Literal seed operator-intent content forwarded to every stage's
   * StageInput and StageContext. The caller (e.g. a deep-pipeline
   * driver) reads this from the seed operator-intent atom's `content`
   * field at preflight; the runner threads it through to each stage
   * unchanged so every LLM-driven stage anchors its output to the
   * ORIGINAL operator request rather than the prior stage's
   * abstraction. Without this anchor downstream stages drift
   * semantically -- brainstorm sees the literal intent, spec sees the
   * brainstorm's interpretation, plan sees the spec's framing, and by
   * the time plan runs the work it describes is N abstractions removed
   * from what the operator asked for.
   *
   * Defaults to the empty string when the runner is invoked without a
   * computed value (legacy callers and direct test invocations); stage
   * adapters treat an empty string as "no anchor available; fall back
   * to prior-stage output" rather than fail-closed. Mirrors the
   * empty-default pattern of verifiedCitedAtomIds /
   * verifiedSubActorPrincipalIds.
   */
  readonly operatorIntentContent?: string;
}

export async function runPipeline(
  stages: ReadonlyArray<PlanningStage>,
  host: Host,
  options: RunPipelineOptions,
): Promise<PipelineResult> {
  if (stages.length > MAX_STAGES) {
    throw new Error(
      `runPipeline: stage count ${stages.length} exceeds MAX_STAGES ${MAX_STAGES}`,
    );
  }

  // Kill-switch absolute priority: poll BEFORE any reads or writes.
  if (host.scheduler.killswitchCheck()) {
    return { kind: 'halted' };
  }

  const now = options.now ?? (() => new Date().toISOString() as Time);
  // Freeze the verified citation set once per run so a stage cannot
  // mutate the array reference and skew later-stage grounding. The
  // runner forwards this same frozen reference into every
  // StageInput.verifiedCitedAtomIds and StageContext.verifiedCitedAtomIds
  // so the LLM-prompt-side grounding signal and the audit-side check
  // walk the same set. Defensive copy first (Object.freeze is shallow)
  // so a mutating caller cannot reach back through the original
  // options.verifiedCitedAtomIds reference to pollute the frozen view.
  const verifiedCitedAtomIds = Object.freeze(
    [...(options.verifiedCitedAtomIds ?? [])],
  ) as ReadonlyArray<AtomId>;
  // Same defensive freeze for the verified sub-actor principal-id set.
  // Threaded uniformly into every StageInput + StageContext so the
  // plan-stage prompt and the plan-stage auditor walk the same set.
  // The set comes from the seed operator-intent's
  // metadata.trust_envelope.allowed_sub_actors at the runDeepPipeline
  // boundary; the runner does not inspect the contents.
  const verifiedSubActorPrincipalIds = Object.freeze(
    [...(options.verifiedSubActorPrincipalIds ?? [])],
  ) as ReadonlyArray<PrincipalId>;
  // Literal operator-intent content. Threaded uniformly into every
  // StageInput + StageContext so the LLM at every stage anchors to the
  // ORIGINAL operator request rather than the prior stage's
  // abstraction. Strings are immutable in JavaScript, so a defensive
  // freeze is unnecessary; the read here pins the value once per run
  // for symmetry with the verified-set fields above and so a malformed
  // caller that mutates options.operatorIntentContent (impossible for
  // a string but the contract signals intent) cannot skew downstream
  // stages mid-walk. Default to empty string when the caller did not
  // compute a value; stage adapters treat empty as "no anchor" and
  // fall back to prior-stage output. The empty default is intentional
  // and mirrors verifiedCitedAtomIds / verifiedSubActorPrincipalIds
  // (those default to []): the runner is mechanism, the canonical
  // caller (e.g. run-cto-actor.mjs) is responsible for computing the
  // anchor and forwarding it. Failing closed here would break legacy
  // test-only callers and direct stage invocations from tests, which
  // are the load-bearing users of the empty-default path.
  const operatorIntentContent: string = options.operatorIntentContent ?? '';

  const pipelineId = `pipeline-${options.correlationId}` as AtomId;
  // First-run vs resume: only seed a fresh pipeline atom when none
  // exists. A resume path with an existing atom must NOT reset
  // pipeline_state, started_at, total_cost_usd, or current_stage
  // metadata; the resume entrypoint is responsible for verifying the
  // atom is in a resumable state before calling runPipeline.
  const existingPipelineAtom = await host.atoms.get(pipelineId);
  if (existingPipelineAtom === null) {
    const pipelineAtom = mkPipelineAtom({
      pipelineId,
      principalId: options.principal,
      correlationId: options.correlationId,
      now: now(),
      seedAtomIds: options.seedAtomIds,
      stagePolicyAtomId: options.stagePolicyAtomId,
      mode: options.mode,
    });
    await host.atoms.put(pipelineAtom);
  } else if (options.resumeFromStage === undefined) {
    // No resume requested but the atom already exists: a fresh-run
    // collision. Halt rather than overwrite history.
    return { kind: 'halted', pipelineId };
  }

  // Local helper: every mkPipelineStageEventAtom call site shares the
  // same invariant fields (pipelineId, principal, correlationId, now)
  // and varies only in transition + cost + duration + optional
  // outputAtomId. Extracted at N=2 per the repo's duplication-floor
  // canon; reduces drift across the kill-switch / claim-before-mutate
  // / HIL fixes that touch these emit sites.
  async function emitStageEvent(
    stageName: string,
    transition: 'enter' | 'exit-success' | 'exit-failure' | 'hil-pause' | 'hil-resume',
    durationMs: number,
    costUsd: number,
    outputAtomId?: AtomId,
  ): Promise<void> {
    await host.atoms.put(
      mkPipelineStageEventAtom({
        pipelineId,
        stageName,
        principalId: options.principal,
        correlationId: options.correlationId,
        now: now(),
        transition,
        durationMs,
        costUsd,
        ...(outputAtomId !== undefined ? { outputAtomId } : {}),
      }),
    );
  }

  const startIdx =
    options.resumeFromStage === undefined
      ? 0
      : stages.findIndex((s) => s.name === options.resumeFromStage);
  if (startIdx < 0) {
    return await failPipeline(
      host,
      pipelineId,
      options,
      now,
      'unknown-stage',
      'resume-from-stage not found in stages list',
      0,
    );
  }

  // Resume path may hydrate priorOutput from caller. Stage outputs
  // ARE now persisted as typed atoms (substrate-fix in this PR); the
  // resume entrypoint can read the prior stage's output atom directly
  // and pass its value via options.priorOutput, which keeps the
  // resume-mid-pipeline contract independent of the persistence shape
  // (the runner does not re-query the atom store on every resume).
  let priorOutput: unknown =
    options.resumeFromStage !== undefined && options.priorOutput !== undefined
      ? options.priorOutput
      : null;
  // Prior stage-output atom ids accumulated as the pipeline walks. Each
  // new stage's derived_from chain begins with `[pipelineId, ...priorOutputAtomIds]`
  // so a walk back from any stage-output atom reaches every upstream
  // stage's atom AND the pipeline atom AND the seed operator-intent.
  // Indie-floor consumers querying for a specific stage's output by id
  // get the full chain in one read; org-ceiling consumers querying by
  // pipeline_id metadata get the same set without walking provenance.
  //
  // Resume path: seeded from options.priorOutputAtomIds so a resumed
  // pipeline's first newly-persisted stage carries the upstream chain
  // already written by the completed stages. Defensive copy via
  // spread so a mutating caller cannot reach back through the
  // original options reference and skew downstream chains.
  const priorOutputAtomIds: AtomId[] = [
    ...(options.priorOutputAtomIds ?? []),
  ];
  let totalCostUsd = 0;

  for (let i = startIdx; i < stages.length; i++) {
    const stage = stages[i]!;

    // Kill-switch poll before each stage transition. STOP is an operator
    // halt, NOT a stage failure: per the file-header contract
    // ("polled BEFORE any write"), the runner returns halted without
    // emitting an exit-failure event. Misclassifying a STOP as a
    // failure would pollute the audit chain and trigger downstream
    // failure-recovery flows that should not fire on a clean halt.
    if (host.scheduler.killswitchCheck()) {
      return { kind: 'halted', pipelineId };
    }

    // Claim-before-mutate: re-read pipeline atom to prevent double-advance
    // under concurrent ticks. Halt if the atom is missing, tainted, or
    // already in a terminal state (completed, failed) which would mean
    // another tick raced ahead.
    const fresh = await host.atoms.get(pipelineId);
    if (fresh === null) return { kind: 'halted', pipelineId };
    if (fresh.taint !== 'clean') return { kind: 'halted', pipelineId };
    const currentState = fresh.pipeline_state;
    if (
      currentState !== undefined
      && currentState !== 'pending'
      && currentState !== 'running'
      && currentState !== 'hil-paused'
    ) {
      return { kind: 'halted', pipelineId };
    }
    // Stage-level claim: a peer tick that already advanced past index
    // i is ahead of us; halt rather than re-execute. The peer marks
    // its progress via current_stage_index on the pipeline atom. The
    // AtomStore lacks true compare-and-swap so the claim is
    // best-effort: file/memory adapters serialise calls in practice
    // and avoid the race; a multi-process adapter must add a native
    // conditional update.
    const freshMeta = (fresh.metadata as Record<string, unknown>) ?? {};
    const peerIndex = freshMeta.current_stage_index;
    if (typeof peerIndex === 'number' && peerIndex > i) {
      return { kind: 'halted', pipelineId };
    }

    await host.atoms.update(pipelineId, {
      pipeline_state: 'running',
      metadata: { current_stage: stage.name, current_stage_index: i },
    });
    // Re-read after write to confirm we still hold the claim. If a
    // concurrent tick clobbered current_stage_index above our value
    // between our update and this read, halt rather than proceed.
    const claimed = await host.atoms.get(pipelineId);
    const claimedMeta = (claimed?.metadata as Record<string, unknown>) ?? {};
    const claimedIndex = claimedMeta.current_stage_index;
    if (typeof claimedIndex !== 'number' || claimedIndex !== i) {
      return { kind: 'halted', pipelineId };
    }
    await emitStageEvent(stage.name, 'enter', 0, 0);

    const t0 = Date.now();
    let output: StageOutput<unknown>;
    try {
      const stageInput: StageInput<unknown> = {
        host,
        principal: options.principal,
        correlationId: options.correlationId,
        priorOutput,
        pipelineId,
        seedAtomIds: options.seedAtomIds,
        verifiedCitedAtomIds,
        verifiedSubActorPrincipalIds,
        operatorIntentContent,
      };
      output = await stage.run(stageInput);
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      // Even when the stage threw, re-check the kill switch before
      // post-run writes: if STOP flipped while the promise was in
      // flight, we honour the absolute-priority guarantee from the
      // file header and halt without writing the failure event /
      // pipeline-failed atom.
      if (host.scheduler.killswitchCheck()) {
        return { kind: 'halted', pipelineId };
      }
      await emitStageEvent(stage.name, 'exit-failure', Date.now() - t0, 0);
      return await failPipeline(host, pipelineId, options, now, stage.name, cause, i);
    }
    // Re-check the kill switch on the success path before any post-run
    // writes. Without this, a STOP that flipped while stage.run was
    // in flight still produces schema-failure atoms, audit findings,
    // exit-success events, and pipeline_state='completed' downstream;
    // that would break the absolute-priority guarantee.
    if (host.scheduler.killswitchCheck()) {
      return { kind: 'halted', pipelineId };
    }
    const durationMs = Date.now() - t0;

    // Schema validation. Run before persistence so an LLM-emitted
    // payload outside the schema NEVER becomes the priorOutput of a
    // downstream stage.
    if (stage.outputSchema !== undefined) {
      const parsed = stage.outputSchema.safeParse(output.value);
      if (!parsed.success) {
        await emitStageEvent(stage.name, 'exit-failure', durationMs, output.cost_usd);
        return await failPipeline(
          host,
          pipelineId,
          options,
          now,
          stage.name,
          `schema-validation-failed: ${parsed.error.message}`,
          i,
        );
      }
    }

    // Per-stage budget enforcement. Stage-supplied cap takes precedence;
    // canon policy is the fallback. A null cap means "no limit at this
    // layer" -- the per-pipeline total is a forward-compat fence.
    const stageCap =
      stage.budget_cap_usd
      ?? (await readPipelineStageCostCapPolicy(host, stage.name)).cap_usd;
    if (
      stageCap !== null
      && stageCap !== undefined
      && output.cost_usd > stageCap
    ) {
      await emitStageEvent(stage.name, 'exit-failure', durationMs, output.cost_usd);
      return await failPipeline(
        host,
        pipelineId,
        options,
        now,
        stage.name,
        `budget-overflow: cost ${output.cost_usd} > cap ${stageCap}`,
        i,
      );
    }
    totalCostUsd += output.cost_usd;

    // Persist the stage's StageOutput.value as a typed queryable atom
    // BEFORE audit runs. The atom serves two consumers regardless of
    // outcome: (a) on critical-audit-halt the operator inspects the
    // persisted output to understand what triggered the finding;
    // (b) on HIL pause the operator reviews the persisted output
    // before deciding whether to resume; (c) on exit-success the
    // downstream stage receives the priorOutput value plus the new
    // atom id is appended to priorOutputAtomIds for the next stage's
    // derived_from chain. Schema validation already ran above so the
    // value is guaranteed to match the stage's declared shape.
    //
    // Persistence is best-effort within the runner's threat model: a
    // failed put rejects the pipeline tick into the existing failure
    // path so the operator sees an explicit error rather than a
    // silently-missing atom downstream. Atom-mint helpers themselves
    // are pure (no I/O; pure shape validation), so a put failure here
    // is an AtomStore-side problem the substrate already routes
    // through failPipeline.
    let stageOutputAtomId: AtomId | undefined;
    let persistedPlanAtomIds: ReadonlyArray<AtomId> = [];
    try {
      // Forward stage-runner-supplied extraMetadata (e.g.
      // canon_directives_applied + tool_policy_principal_id from
      // runStageAgentLoop) into the typed mint helpers. The runner
      // stays canon-agnostic: it propagates the bag without inspecting
      // contents, so the substrate does not need to know what stage
      // runners chose to stamp. The runner-supplied keys (pipeline_id,
      // stage_name, stage_output) still win on shallow-merge collision
      // inside the mint helpers, so a misbehaving stage cannot shadow
      // load-bearing routing keys.
      const extraMetadata = output.extraMetadata;
      const persisted = await persistStageOutput(
        host,
        stage.name,
        output.atom_type,
        output.value,
        {
          pipelineId,
          principalId: options.principal,
          correlationId: options.correlationId,
          now: now(),
          derivedFrom: [pipelineId, ...priorOutputAtomIds],
          ...(extraMetadata !== undefined ? { extraMetadata } : {}),
        },
      );
      stageOutputAtomId = persisted.anchorId;
      persistedPlanAtomIds = persisted.planAtomIds;
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      await emitStageEvent(stage.name, 'exit-failure', durationMs, output.cost_usd);
      return await failPipeline(
        host,
        pipelineId,
        options,
        now,
        stage.name,
        `stage-output-persist-failed: ${cause}`,
        i,
      );
    }

    // Auditor wiring. Each finding produces a pipeline-audit-finding
    // atom; a 'critical' finding halts the stage.
    let findings: ReadonlyArray<AuditFinding> = [];
    if (stage.audit !== undefined) {
      findings = await stage.audit(output.value, {
        host,
        principal: options.principal,
        correlationId: options.correlationId,
        pipelineId,
        stageName: stage.name,
        verifiedCitedAtomIds,
        verifiedSubActorPrincipalIds,
        operatorIntentContent,
      });
      for (const finding of findings) {
        await host.atoms.put(
          mkPipelineAuditFindingAtom({
            pipelineId,
            stageName: stage.name,
            principalId: options.principal,
            correlationId: options.correlationId,
            now: now(),
            severity: finding.severity,
            category: finding.category,
            message: finding.message,
            citedAtomIds: finding.cited_atom_ids,
            citedPaths: finding.cited_paths,
          }),
        );
      }
    }

    const hasCritical = findings.some((f) => f.severity === 'critical');
    if (hasCritical) {
      // Emit the exit-failure event with the persisted stage-output
      // atom id so the operator's audit walk reaches the output that
      // triggered the finding. Without this the failure event chain
      // forces a re-query of the stage-output atom by metadata
      // pipeline_id, which is two reads where one suffices.
      await emitStageEvent(
        stage.name,
        'exit-failure',
        durationMs,
        output.cost_usd,
        stageOutputAtomId,
      );
      return await failPipeline(
        host,
        pipelineId,
        options,
        now,
        stage.name,
        'critical-audit-finding',
        i,
      );
    }

    // HIL gate. Default-deny: a stage with NO auditor cannot pass an
    // 'on-critical-finding' gate, since the runner cannot prove the
    // absence of critical findings without an auditor signal.
    const hil = await readPipelineStageHilPolicy(host, stage.name);
    const auditorAbsent = stage.audit === undefined;
    const shouldPause =
      hil.pause_mode === 'always'
      || (hil.pause_mode === 'on-critical-finding'
        && (hasCritical || auditorAbsent));
    if (shouldPause) {
      await host.atoms.update(pipelineId, { pipeline_state: 'hil-paused' });
      // Carry the persisted stage-output atom id on the hil-pause
      // event so the operator's resume tooling can read the prior
      // output without re-walking the chain.
      await emitStageEvent(
        stage.name,
        'hil-pause',
        durationMs,
        output.cost_usd,
        stageOutputAtomId,
      );
      return { kind: 'hil-paused', pipelineId, stageName: stage.name };
    }

    // Auto-approval pass: for plan-stage emits, evaluate each new plan
    // atom against its seed operator-intent's trust envelope and the
    // pol-plan-autonomous-intent-approve policy. Plans whose envelope
    // matches transition proposed -> approved in place so the dispatch-
    // stage's planFilter (which requires plan_state === 'approved') can
    // pick them up. Mirrors the single-pass autonomous-intent flow.
    //
    // Runs AFTER critical-finding halt + HIL pause checks: a stage that
    // hit either gate has already returned, so reaching this point
    // means the audit + pause policy authorized advancement. The empty-
    // list short-circuit in runPipelinePlanAutoApproval makes the call
    // a no-op for non-plan stages without a separate stage-name check.
    if (persistedPlanAtomIds.length > 0) {
      // Wrap in try/catch so a host-side rejection (e.g. AtomStore
      // contention on the plan_state update) routes through the
      // runner's failure path. Without this the rejection bypasses
      // emitStageEvent + failPipeline and leaves the pipeline in
      // pipeline_state='running' with no terminal atom; the operator
      // would see the plan-stage as still mid-flight indefinitely.
      // The cause string is prefixed so an audit consumer can
      // distinguish "stage threw" from "auto-approve threw".
      try {
        await runPipelinePlanAutoApproval(host, persistedPlanAtomIds, { now });
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        await emitStageEvent(
          stage.name,
          'exit-failure',
          durationMs,
          output.cost_usd,
          stageOutputAtomId,
        );
        return await failPipeline(
          host,
          pipelineId,
          options,
          now,
          stage.name,
          `plan-auto-approve-failed: ${cause}`,
          i,
        );
      }
    }

    // Prefer the runner-minted stage-output atom id over output.atom_id
    // when emitting the exit-success event so the event chain points at
    // the canonical persisted atom. Stage adapters that legacy-set
    // output.atom_id (pre-persistence) still surface through the event,
    // but the runner-minted id is authoritative for new pipelines.
    const exitAtomId = stageOutputAtomId ?? output.atom_id;
    await emitStageEvent(
      stage.name,
      'exit-success',
      durationMs,
      output.cost_usd,
      exitAtomId,
    );

    priorOutput = output.value;
    if (stageOutputAtomId !== undefined) {
      priorOutputAtomIds.push(stageOutputAtomId);
    }
  }

  await host.atoms.update(pipelineId, {
    pipeline_state: 'completed',
    metadata: { completed_at: now(), total_cost_usd: totalCostUsd },
  });
  return { kind: 'completed', pipelineId };
}

/**
 * Per-stage output persistence.
 *
 * Routes a stage's StageOutput.value to the correct atom-mint helper
 * by the stage adapter's declared atom_type. Each branch returns the
 * canonical atom id stored in priorOutputAtomIds for the next stage's
 * derived_from chain.
 *
 * Routing table (substrate-side mechanism; adapter-declared
 * StageOutput.atom_type is the dispatch key):
 *
 *   - 'plan'              -> mkPlanOutputAtoms (one atom per plan
 *                            entry in the value's `plans` array;
 *                            the runner returns the LAST plan atom
 *                            id as the chain anchor since the plan
 *                            stage emits a payload, not a single plan).
 *   - 'brainstorm-output' -> mkBrainstormOutputAtom
 *   - 'spec-output'       -> mkSpecOutputAtom
 *   - 'review-report'     -> mkReviewReportAtom
 *   - 'dispatch-record'   -> mkDispatchRecordAtom
 *   - any other type      -> generic stage-output mint via
 *                            mkGenericStageOutputAtom; org-ceiling
 *                            deployments registering a custom stage
 *                            adapter (legal-review, security-threat-
 *                            model, perf-benchmark) land here without
 *                            a runner change. The generic path
 *                            persists under type='observation' with
 *                            metadata.stage_name as the routing key
 *                            so a custom stage's output is queryable
 *                            without polluting the typed vocabulary.
 *
 * Routing by atom_type (not stage name) preserves substrate purity:
 * the runner does not encode the canonical 5-stage names; the stage
 * adapter declares its output type via StageOutput.atom_type and the
 * runner dispatches on that. An org-ceiling adapter swapping in a
 * different brainstorm implementation declares atom_type:
 * 'brainstorm-output' to land in the typed branch, or any other type
 * string to land in the generic branch.
 *
 * Returns a record containing the chain-anchor atom id (the id used
 * for the next stage's derived_from chain) plus, for the plan-stage,
 * the full set of plan atom ids written. The auto-approval helper in
 * the runner's main loop iterates the plan atom ids per atom; for
 * non-plan stages the planAtomIds field is an empty array so callers
 * branch on stage shape without re-deriving the kind from the atom
 * type string.
 */
interface PersistStageOutputResult {
  /** Chain anchor for priorOutputAtomIds; the id used in next stage's derived_from. */
  readonly anchorId: AtomId;
  /**
   * Full set of plan atom ids written by the plan-stage; empty array
   * for every other stage shape. The runner threads this into
   * runPipelinePlanAutoApproval so the autonomous-intent envelope can
   * transition each newly-emitted plan from proposed -> approved.
   */
  readonly planAtomIds: ReadonlyArray<AtomId>;
}

async function persistStageOutput(
  host: Host,
  stageName: string,
  atomType: string,
  value: unknown,
  ctx: {
    pipelineId: AtomId;
    principalId: PrincipalId;
    correlationId: string;
    now: Time;
    derivedFrom: ReadonlyArray<AtomId>;
    extraMetadata?: Readonly<Record<string, unknown>>;
  },
): Promise<PersistStageOutputResult> {
  // Build baseInput with extraMetadata only when present so the typed
  // mint helpers (which accept extraMetadata as an optional field) do
  // not see an explicit `undefined` under exactOptionalPropertyTypes.
  // The extraMetadata bag is forwarded verbatim into
  // buildStageOutputMetadata's shallow merge; the runner-supplied
  // routing keys (pipeline_id, stage_name, stage_output) remain
  // load-bearing and win on collision.
  const baseInput = {
    pipelineId: ctx.pipelineId,
    stageName,
    principalId: ctx.principalId,
    correlationId: ctx.correlationId,
    now: ctx.now,
    derivedFrom: ctx.derivedFrom,
    value,
    ...(ctx.extraMetadata !== undefined ? { extraMetadata: ctx.extraMetadata } : {}),
  };
  switch (atomType) {
    case 'brainstorm-output': {
      const atom = mkBrainstormOutputAtom(baseInput);
      await host.atoms.put(atom);
      return { anchorId: atom.id, planAtomIds: [] };
    }
    case 'spec-output': {
      const atom = mkSpecOutputAtom(baseInput);
      await host.atoms.put(atom);
      return { anchorId: atom.id, planAtomIds: [] };
    }
    case 'plan': {
      // The plan-stage emits a payload with a `plans` array; mint
      // one plan atom per entry and return the last id as the chain
      // anchor. The dispatch-stage's planFilter walks derived_from
      // on each plan atom and matches plans whose chain includes the
      // pipeline atom id, so a multi-plan emission produces multiple
      // dispatchable plans (which is the contract the plan-stage's
      // schema declares with its plans-array).
      const planAtoms = mkPlanOutputAtoms({
        pipelineId: ctx.pipelineId,
        principalId: ctx.principalId,
        correlationId: ctx.correlationId,
        now: ctx.now,
        derivedFrom: ctx.derivedFrom,
        value,
        ...(ctx.extraMetadata !== undefined ? { extraMetadata: ctx.extraMetadata } : {}),
      });
      if (planAtoms.length === 0) {
        // Plan-stage schema rejects empty plans arrays, so reaching
        // here means the schema was loosened or the helper extracted
        // zero atoms from a non-empty list. Fail closed: persist a
        // generic stage-output atom so the operator sees the empty
        // plan-stage emission rather than a silent skip; the
        // dispatch-stage's planFilter then naturally finds zero
        // plans and the runner's gating logic surfaces the gap.
        const fallback = mkGenericStageOutputAtom(baseInput);
        await host.atoms.put(fallback);
        return { anchorId: fallback.id, planAtomIds: [] };
      }
      // Persist all plan atoms; return the LAST id as the chain
      // anchor for the next stage AND the full id list so the
      // runner's auto-approval pass evaluates every plan emit, not
      // just the chain anchor. priorOutputAtomIds keeps exactly one
      // anchor per stage so downstream chains stay bounded; the
      // remaining plan atoms are still findable via metadata.pipeline_id
      // (and now via the explicit return field).
      const planAtomIds: AtomId[] = [];
      let lastId: AtomId | undefined;
      for (const planAtom of planAtoms) {
        await host.atoms.put(planAtom);
        planAtomIds.push(planAtom.id);
        lastId = planAtom.id;
      }
      // mkPlanOutputAtoms returns ReadonlyArray<Atom> with at least
      // one entry guaranteed by the empty-check above, so lastId is
      // always defined. The non-null assertion mirrors the assertion
      // pattern used elsewhere in this file (stages[i]!).
      return { anchorId: lastId!, planAtomIds };
    }
    case 'review-report': {
      const atom = mkReviewReportAtom(baseInput);
      await host.atoms.put(atom);
      return { anchorId: atom.id, planAtomIds: [] };
    }
    case 'dispatch-record': {
      const atom = mkDispatchRecordAtom(baseInput);
      await host.atoms.put(atom);
      return { anchorId: atom.id, planAtomIds: [] };
    }
    default: {
      // Custom stages (legal-review, security-threat-model,
      // perf-benchmark, etc.) land here. The runner persists the
      // value under a generic stage-output shape so any custom
      // stage's output is queryable without an adapter-side change
      // to the runner.
      const atom = mkGenericStageOutputAtom(baseInput);
      await host.atoms.put(atom);
      return { anchorId: atom.id, planAtomIds: [] };
    }
  }
}

/**
 * Generic stage-output atom for custom stages outside the default
 * 5-stage set. The atom type is 'observation' so it routes through
 * the existing AtomType union without requiring a substrate-types
 * change for every new custom stage; the load-bearing routing key is
 * metadata.stage_name. Org-ceiling deployments that register a
 * dedicated atom type for a custom stage (e.g. 'legal-review-output')
 * can do so by extending the AtomType union AND adding a switch
 * branch above; the generic path is the default-deny fallback that
 * keeps the substrate functional without the extension.
 */
function mkGenericStageOutputAtom(input: {
  readonly pipelineId: AtomId;
  readonly stageName: string;
  readonly principalId: PrincipalId;
  readonly correlationId: string;
  readonly now: Time;
  readonly derivedFrom: ReadonlyArray<AtomId>;
  readonly value: unknown;
  readonly extraMetadata?: Readonly<Record<string, unknown>>;
}): Atom {
  // Build a minimal Atom inline to avoid threading a fifth mint
  // helper through atom-shapes.ts for the generic case. Mirrors the
  // baseAtom shape from atom-shapes.ts so audit consumers see a
  // consistent envelope; the type field is 'observation' (the catch-
  // all atom type for any read-only artifact in the substrate). The
  // load-bearing routing key is metadata.stage_name + the
  // metadata.pipeline_id pair.
  const id = `stage-output-${input.stageName}-${input.pipelineId}-${input.correlationId}` as AtomId;
  return {
    schema_version: 1,
    id,
    content: serializeStageOutput(input.value),
    type: 'observation',
    layer: 'L0',
    provenance: {
      kind: 'agent-observed',
      source: {
        tool: 'planning-pipeline',
        agent_id: String(input.principalId),
        session_id: input.correlationId,
      },
      derived_from: [...input.derivedFrom],
    },
    confidence: 1.0,
    created_at: input.now,
    last_reinforced_at: input.now,
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
    principal_id: input.principalId,
    taint: 'clean',
    metadata: {
      // extraMetadata first so the runner-supplied routing keys
      // (pipeline_id, stage_name, stage_output, generic_stage_output)
      // win on shallow-merge collision. Mirrors the precedence order
      // in buildStageOutputMetadata so the typed and generic paths
      // behave identically for downstream readers.
      ...(input.extraMetadata ?? {}),
      pipeline_id: input.pipelineId,
      stage_name: input.stageName,
      // Project the value through the same JSON-safety + size-cap
      // helper the typed mints use; embedding the raw value here
      // would bypass the cap for custom-stage atoms.
      stage_output: projectStageOutputForMetadata(input.value),
      generic_stage_output: true,
    },
  };
}

async function failPipeline(
  host: Host,
  pipelineId: AtomId,
  options: RunPipelineOptions,
  now: () => Time,
  stageName: string,
  cause: string,
  failedIndex: number,
): Promise<PipelineResult> {
  // Build the provenance chain by paginating ALL pipeline-stage-event
  // atoms and filtering on metadata.pipeline_id. A single first-page
  // query is unsafe under load: a busy store with many peer pipelines
  // could push this pipeline's events past the first page, leaving
  // the failed-atom chain partial and non-deterministic. Pagination
  // walks until nextCursor=null. MAX_CHAIN_PAGES is a runaway-loop
  // bound; if we hit it WITH a non-null cursor still in hand, the
  // chain is incomplete and we throw rather than silently emit a
  // truncated provenance record. Honours the substrate-level
  // "every atom must carry provenance with a source chain" contract.
  const PAGE_SIZE = 200;
  const MAX_CHAIN_PAGES = 64;
  const chain: AtomId[] = [];
  let cursor: string | undefined = undefined;
  let exhausted = false;
  for (let page = 0; page < MAX_CHAIN_PAGES; page++) {
    const result = await host.atoms.query(
      { type: ['pipeline-stage-event'] },
      PAGE_SIZE,
      cursor,
    );
    for (const atom of result.atoms) {
      const meta = atom.metadata as Record<string, unknown> | undefined;
      if (meta?.pipeline_id === pipelineId) {
        chain.push(atom.id);
      }
    }
    if (result.nextCursor === null) {
      exhausted = true;
      break;
    }
    cursor = result.nextCursor;
  }
  if (!exhausted) {
    throw new Error(
      `runPipeline: provenance-chain pagination exhausted MAX_CHAIN_PAGES=`
      + `${MAX_CHAIN_PAGES} for pipeline ${pipelineId} but nextCursor was `
      + `still non-null. A pipeline-failed atom with a partial chain would `
      + `violate the substrate provenance contract; raise MAX_CHAIN_PAGES `
      + `or wire a pipeline-scoped query before retrying.`,
    );
  }
  // Reuse a single timestamp for both writes so the failure atom and
  // the pipeline atom's terminal stamp agree to the millisecond. A
  // separate now() call between the two would emit drift the audit
  // chain has to reconcile.
  const terminalNow = now();
  await host.atoms.put(
    mkPipelineFailedAtom({
      pipelineId,
      principalId: options.principal,
      correlationId: options.correlationId,
      now: terminalNow,
      failedStageName: stageName,
      failedStageIndex: failedIndex,
      cause,
      chain,
      recoveryHint: `re-run from stage '${stageName}' after addressing the failure cause`,
    }),
  );
  // Mirror the completed-path metadata write: stamp completed_at on
  // every terminal transition so audit consumers can read pipeline
  // duration from the atom alone (no walk through pipeline-stage-event
  // chain required). The metadata patch is shallow-merged by the
  // AtomStore implementations, preserving started_at, mode,
  // stage_policy_atom_id, and total_cost_usd from mkPipelineAtom.
  await host.atoms.update(pipelineId, {
    pipeline_state: 'failed',
    metadata: { completed_at: terminalNow },
  });
  return {
    kind: 'failed',
    pipelineId,
    failedStageName: stageName,
    cause,
  };
}
