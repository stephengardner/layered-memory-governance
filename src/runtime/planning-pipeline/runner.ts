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
import type { AtomId, PrincipalId, Time } from '../../substrate/types.js';
import type {
  AuditFinding,
  PlanningStage,
  StageInput,
  StageOutput,
} from './types.js';
import {
  mkPipelineAtom,
  mkPipelineAuditFindingAtom,
  mkPipelineFailedAtom,
  mkPipelineStageEventAtom,
} from './atom-shapes.js';
import {
  readPipelineStageCostCapPolicy,
  readPipelineStageHilPolicy,
} from './policy.js';

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

  const pipelineId = `pipeline-${options.correlationId}` as AtomId;
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

  let priorOutput: unknown = null;
  let totalCostUsd = 0;

  for (let i = startIdx; i < stages.length; i++) {
    const stage = stages[i]!;

    // Kill-switch poll before each stage transition.
    if (host.scheduler.killswitchCheck()) {
      await host.atoms.put(
        mkPipelineStageEventAtom({
          pipelineId,
          stageName: stage.name,
          principalId: options.principal,
          correlationId: options.correlationId,
          now: now(),
          transition: 'exit-failure',
          durationMs: 0,
          costUsd: 0,
        }),
      );
      return { kind: 'halted', pipelineId };
    }

    // Claim-before-mutate: re-read pipeline atom to prevent double-advance
    // under concurrent ticks. Halt if the atom is missing or tainted.
    const fresh = await host.atoms.get(pipelineId);
    if (fresh === null) return { kind: 'halted', pipelineId };
    if (fresh.taint !== 'clean') return { kind: 'halted', pipelineId };

    await host.atoms.update(pipelineId, { pipeline_state: 'running' });
    await host.atoms.put(
      mkPipelineStageEventAtom({
        pipelineId,
        stageName: stage.name,
        principalId: options.principal,
        correlationId: options.correlationId,
        now: now(),
        transition: 'enter',
        durationMs: 0,
        costUsd: 0,
      }),
    );

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
      };
      output = await stage.run(stageInput);
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      await host.atoms.put(
        mkPipelineStageEventAtom({
          pipelineId,
          stageName: stage.name,
          principalId: options.principal,
          correlationId: options.correlationId,
          now: now(),
          transition: 'exit-failure',
          durationMs: Date.now() - t0,
          costUsd: 0,
        }),
      );
      return await failPipeline(host, pipelineId, options, now, stage.name, cause, i);
    }
    const durationMs = Date.now() - t0;

    // Schema validation. Run before persistence so an LLM-emitted
    // payload outside the schema NEVER becomes the priorOutput of a
    // downstream stage.
    if (stage.outputSchema !== undefined) {
      const parsed = stage.outputSchema.safeParse(output.value);
      if (!parsed.success) {
        await host.atoms.put(
          mkPipelineStageEventAtom({
            pipelineId,
            stageName: stage.name,
            principalId: options.principal,
            correlationId: options.correlationId,
            now: now(),
            transition: 'exit-failure',
            durationMs,
            costUsd: output.cost_usd,
          }),
        );
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
      await host.atoms.put(
        mkPipelineStageEventAtom({
          pipelineId,
          stageName: stage.name,
          principalId: options.principal,
          correlationId: options.correlationId,
          now: now(),
          transition: 'exit-failure',
          durationMs,
          costUsd: output.cost_usd,
        }),
      );
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
      await host.atoms.put(
        mkPipelineStageEventAtom({
          pipelineId,
          stageName: stage.name,
          principalId: options.principal,
          correlationId: options.correlationId,
          now: now(),
          transition: 'exit-failure',
          durationMs,
          costUsd: output.cost_usd,
        }),
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
      await host.atoms.put(
        mkPipelineStageEventAtom({
          pipelineId,
          stageName: stage.name,
          principalId: options.principal,
          correlationId: options.correlationId,
          now: now(),
          transition: 'hil-pause',
          durationMs,
          costUsd: output.cost_usd,
        }),
      );
      return { kind: 'hil-paused', pipelineId, stageName: stage.name };
    }

    await host.atoms.put(
      mkPipelineStageEventAtom({
        pipelineId,
        stageName: stage.name,
        principalId: options.principal,
        correlationId: options.correlationId,
        now: now(),
        transition: 'exit-success',
        durationMs,
        costUsd: output.cost_usd,
        ...(output.atom_id !== undefined ? { outputAtomId: output.atom_id } : {}),
      }),
    );

    priorOutput = output.value;
  }

  await host.atoms.update(pipelineId, {
    pipeline_state: 'completed',
    metadata: { completed_at: now(), total_cost_usd: totalCostUsd },
  });
  return { kind: 'completed', pipelineId };
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
  const chainPage = await host.atoms.query(
    { type: ['pipeline-stage-event'] },
    200,
  );
  const chain: AtomId[] = [];
  for (const atom of chainPage.atoms) {
    const meta = atom.metadata as Record<string, unknown> | undefined;
    if (meta?.pipeline_id === pipelineId) {
      chain.push(atom.id);
    }
  }
  await host.atoms.put(
    mkPipelineFailedAtom({
      pipelineId,
      principalId: options.principal,
      correlationId: options.correlationId,
      now: now(),
      failedStageName: stageName,
      failedStageIndex: failedIndex,
      cause,
      chain,
      recoveryHint: `re-run from stage '${stageName}' after addressing the failure cause`,
    }),
  );
  await host.atoms.update(pipelineId, { pipeline_state: 'failed' });
  return {
    kind: 'failed',
    pipelineId,
    failedStageName: stageName,
    cause,
  };
}
