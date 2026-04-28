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
