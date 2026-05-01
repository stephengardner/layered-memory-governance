/**
 * PlanningStage type surface.
 *
 * Pure types: this module re-exports interfaces only, no runtime
 * code. A stage adapter (in examples/planning-stages/) imports these
 * types and exports a value implementing PlanningStage<TIn, TOut>.
 *
 * Mechanism-only: the interface declares the SHAPE of a stage;
 * concrete prompts and schemas live in stage adapters. The
 * interface is the substrate seam.
 */

import type { z } from 'zod';
import type { Host } from '../../substrate/interface.js';
import type { AtomId, PrincipalId } from '../../substrate/types.js';

export interface StageInput<T> {
  readonly host: Host;
  readonly principal: PrincipalId;
  readonly correlationId: string;
  readonly priorOutput: T;
  readonly pipelineId: AtomId;
  readonly seedAtomIds: ReadonlyArray<AtomId>;
  /**
   * Verified citation set the stage's LLM may cite from. The runner
   * forwards this from RunPipelineOptions; concrete stage adapters
   * pass it into the LLM `data` block under a stable key
   * (`verified_cited_atom_ids`) and instruct the LLM in the system
   * prompt to ground every atom-id citation in this set. Stage audit
   * functions continue to walk citations against host.atoms.get and
   * emit critical findings on fabrication; this field is the
   * positive-grounding signal the LLM needs to succeed (mirrors the
   * brainstorm-stage `verified_seed_atom_ids` pattern, generalised to
   * the full pipeline). Default empty when the runner is invoked
   * without a computed set; stage adapters that depend on a non-empty
   * grounding contract should fail closed in that case.
   */
  readonly verifiedCitedAtomIds: ReadonlyArray<AtomId>;
  /**
   * Verified set of sub-actor principal ids the stage's LLM may name
   * in `delegation.sub_actor_principal_id`. The runner forwards this
   * from RunPipelineOptions; the canonical source is the seed
   * operator-intent's `metadata.trust_envelope.allowed_sub_actors`
   * (the intent envelope IS the per-run "allowed sub-actors"
   * coordinate). Concrete stage adapters pass it into the LLM `data`
   * block under the stable key `verified_sub_actor_principal_ids` and
   * instruct the LLM in the system prompt to ground every delegation
   * choice in this set. Stage audit functions continue to walk the
   * emitted delegation against the verified set and emit critical
   * findings on out-of-set ids; this field is the positive-grounding
   * signal the LLM needs to succeed. Mirrors the
   * `verifiedCitedAtomIds` pattern. Default empty when the runner is
   * invoked without a computed set; stage adapters that depend on a
   * non-empty grounding contract should fail closed in that case.
   */
  readonly verifiedSubActorPrincipalIds: ReadonlyArray<PrincipalId>;
}

export interface StageOutput<T> {
  readonly value: T;
  readonly cost_usd: number;
  readonly duration_ms: number;
  readonly atom_type: string;
  readonly atom_id?: AtomId;
}

export interface AuditFinding {
  readonly severity: 'critical' | 'major' | 'minor';
  readonly category: string;
  readonly message: string;
  readonly cited_atom_ids: ReadonlyArray<AtomId>;
  readonly cited_paths: ReadonlyArray<string>;
}

export interface StageContext {
  readonly host: Host;
  readonly principal: PrincipalId;
  readonly correlationId: string;
  readonly pipelineId: AtomId;
  readonly stageName: string;
  /**
   * Verified citation set the stage's audit() may use to reject
   * resolvable-but-out-of-set citations. Mirrored from the
   * StageInput field of the same name; the runner threads it through
   * unchanged so an audit walks against the same set the LLM was
   * prompted with. Empty when the runner is invoked without a
   * computed set; audits that depend on a non-empty grounding
   * contract should treat the empty case the same way the prompts
   * do (a citation against an empty set is a citation against
   * nothing, so resolvability alone may be the audit's only signal).
   */
  readonly verifiedCitedAtomIds: ReadonlyArray<AtomId>;
  /**
   * Verified sub-actor principal-id set the stage's audit() may use
   * to reject out-of-set delegation choices. Mirrored from the
   * StageInput field of the same name; the runner threads it through
   * unchanged so audit walks the same set the LLM was prompted with.
   * Empty when the runner is invoked without a computed set; audits
   * that depend on a non-empty grounding contract should treat the
   * empty case as "no closure check available" (legacy callers may
   * invoke audit() without a set; resolvability alone is the only
   * signal in that path).
   */
  readonly verifiedSubActorPrincipalIds: ReadonlyArray<PrincipalId>;
}

export type RetryStrategy =
  | { readonly kind: 'no-retry' }
  | {
      readonly kind: 'with-jitter';
      readonly max_attempts: number;
      readonly base_delay_ms: number;
      readonly cheaper_model_fallback?: string;
    };

export interface PlanningStage<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly outputSchema?: z.ZodSchema<TOutput>;
  run(input: StageInput<TInput>): Promise<StageOutput<TOutput>>;
  audit?(output: TOutput, ctx: StageContext): Promise<ReadonlyArray<AuditFinding>>;
  readonly retry?: RetryStrategy;
  /** Per-stage budget cap in USD; orchestrator halts the stage on breach. */
  readonly budget_cap_usd?: number;
  /** v1: linear ordering only; depends_on reserved for a forward-compat DAG seam. */
  readonly dependsOn?: ReadonlyArray<string>;
}
