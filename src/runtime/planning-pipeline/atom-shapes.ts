/**
 * Atom-shape builders for the deep planning pipeline.
 *
 * Each builder produces an Atom matching the canon "every atom must
 * carry provenance with a source chain" directive. Schema validation
 * via zod runs at construction time, NOT at host.atoms.put time, so
 * a malformed shape is caught at the call site (in the runner or a
 * stage adapter) rather than after the write attempt.
 *
 * Mechanism-only: this module declares NO concrete prompt, schema text,
 * or stage ordering. Stage adapters that author the prose live outside
 * src/; this module just stamps atoms.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Atom, AtomId, PrincipalId, Time } from '../../substrate/types.js';

/**
 * Short deterministic hash of an arbitrary string. Used to keep atom
 * ids unique when the same {severity, category} recurs across distinct
 * findings in the same stage (e.g. two cite-fail findings on the same
 * spec). 8 hex chars = 32 bits = collision probability < 2^-16 across
 * 256 findings per pipeline; the bound on findings per stage is below
 * that threshold by an order of magnitude in practice.
 */
function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8);
}

export const PIPELINE_STATE_VALUES = [
  'pending',
  'running',
  'hil-paused',
  'failed',
  'completed',
] as const;
export type PipelineStateLabel = typeof PIPELINE_STATE_VALUES[number];

const SEVERITY = z.enum(['critical', 'major', 'minor']);
const TRANSITION = z.enum(['enter', 'exit-success', 'exit-failure', 'hil-pause', 'hil-resume']);
const AUDIT_STATUS = z.enum(['unchecked', 'clean', 'findings']);
const MODE = z.enum(['single-pass', 'substrate-deep']);

const MAX_CITED_LIST = 256;

const auditFindingSchema = z.object({
  pipelineId: z.string(),
  stageName: z.string().min(1),
  principalId: z.string().min(1),
  correlationId: z.string().min(1),
  now: z.string().min(1),
  severity: SEVERITY,
  category: z.string().min(1),
  message: z.string().min(1),
  citedAtomIds: z.array(z.string()).max(MAX_CITED_LIST, `cited_atom_ids capped at ${MAX_CITED_LIST}`),
  citedPaths: z.array(z.string()).max(MAX_CITED_LIST, `cited_paths capped at ${MAX_CITED_LIST}`),
});

// Helper: stamp a baseline Atom shape with the fields the AtomStore
// requires. Builders override `id`, `type`, `content`, `metadata`,
// `provenance`, and (where applicable) `pipeline_state`.
function baseAtom(input: {
  id: AtomId;
  type: Atom['type'];
  content: string;
  principalId: PrincipalId;
  correlationId: string;
  now: Time;
  derivedFrom: ReadonlyArray<AtomId>;
  metadata: Record<string, unknown>;
}): Atom {
  return {
    schema_version: 1,
    id: input.id,
    content: input.content,
    type: input.type,
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
    metadata: input.metadata,
  };
}

// ---------------------------------------------------------------------------
// pipeline atom (root for a run; pipeline_state is top-level)
// ---------------------------------------------------------------------------

export interface MkPipelineAtomInput {
  readonly pipelineId: AtomId;
  readonly principalId: PrincipalId;
  readonly correlationId: string;
  readonly now: Time;
  readonly seedAtomIds: ReadonlyArray<AtomId>;
  readonly stagePolicyAtomId: string;
  readonly mode: 'single-pass' | 'substrate-deep';
}

export function mkPipelineAtom(input: MkPipelineAtomInput): Atom {
  if (input.seedAtomIds.length === 0) {
    throw new Error('mkPipelineAtom: seedAtomIds must be non-empty (provenance directive)');
  }
  MODE.parse(input.mode);
  return {
    ...baseAtom({
      id: input.pipelineId,
      type: 'pipeline',
      content: `pipeline:${input.correlationId}`,
      principalId: input.principalId,
      correlationId: input.correlationId,
      now: input.now,
      derivedFrom: input.seedAtomIds,
      metadata: {
        stage_policy_atom_id: input.stagePolicyAtomId,
        mode: input.mode,
        started_at: input.now,
        completed_at: null,
        total_cost_usd: 0,
      },
    }),
    pipeline_state: 'pending',
  };
}

// ---------------------------------------------------------------------------
// spec atom (looser prose-shape sibling of plan)
// ---------------------------------------------------------------------------

export interface MkSpecAtomInput {
  readonly pipelineId: AtomId;
  readonly principalId: PrincipalId;
  readonly correlationId: string;
  readonly now: Time;
  readonly derivedFrom: ReadonlyArray<AtomId>;
  readonly goal: string;
  readonly body: string;
  readonly citedPaths: ReadonlyArray<string>;
  readonly citedAtomIds: ReadonlyArray<AtomId>;
  readonly alternativesRejected: ReadonlyArray<{ option: string; reason: string }>;
  readonly auditStatus: 'unchecked' | 'clean' | 'findings';
}

export function mkSpecAtom(input: MkSpecAtomInput): Atom {
  AUDIT_STATUS.parse(input.auditStatus);
  if (input.derivedFrom.length === 0) {
    throw new Error('mkSpecAtom: derivedFrom must be non-empty (provenance directive)');
  }
  if (input.citedPaths.length > MAX_CITED_LIST) {
    throw new Error(`mkSpecAtom: cited_paths capped at ${MAX_CITED_LIST}`);
  }
  if (input.citedAtomIds.length > MAX_CITED_LIST) {
    throw new Error(`mkSpecAtom: cited_atom_ids capped at ${MAX_CITED_LIST}`);
  }
  const id = `spec-${input.pipelineId}-${input.correlationId}` as AtomId;
  return baseAtom({
    id,
    type: 'spec',
    content: input.body,
    principalId: input.principalId,
    correlationId: input.correlationId,
    now: input.now,
    derivedFrom: input.derivedFrom,
    metadata: {
      goal: input.goal,
      cited_paths: [...input.citedPaths],
      cited_atom_ids: input.citedAtomIds.map(String),
      alternatives_rejected: input.alternativesRejected.map((a) => ({ ...a })),
      audit_status: input.auditStatus,
      pipeline_id: input.pipelineId,
    },
  });
}

// ---------------------------------------------------------------------------
// pipeline-stage-event atom (one per state transition)
// ---------------------------------------------------------------------------

export interface MkPipelineStageEventAtomInput {
  readonly pipelineId: AtomId;
  readonly stageName: string;
  readonly principalId: PrincipalId;
  readonly correlationId: string;
  readonly now: Time;
  readonly transition: 'enter' | 'exit-success' | 'exit-failure' | 'hil-pause' | 'hil-resume';
  readonly durationMs: number;
  readonly costUsd: number;
  readonly outputAtomId?: AtomId;
}

export function mkPipelineStageEventAtom(input: MkPipelineStageEventAtomInput): Atom {
  TRANSITION.parse(input.transition);
  const id = `pipeline-stage-event-${input.pipelineId}-${input.stageName}-${input.transition}-${input.correlationId}` as AtomId;
  return baseAtom({
    id,
    type: 'pipeline-stage-event',
    content: `${input.stageName}:${input.transition}`,
    principalId: input.principalId,
    correlationId: input.correlationId,
    now: input.now,
    derivedFrom: [input.pipelineId],
    metadata: {
      pipeline_id: input.pipelineId,
      stage_name: input.stageName,
      transition: input.transition,
      duration_ms: input.durationMs,
      cost_usd: input.costUsd,
      ...(input.outputAtomId !== undefined ? { output_atom_id: input.outputAtomId } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// pipeline-audit-finding atom (one per finding)
// ---------------------------------------------------------------------------

export interface MkPipelineAuditFindingAtomInput {
  readonly pipelineId: AtomId;
  readonly stageName: string;
  readonly principalId: PrincipalId;
  readonly correlationId: string;
  readonly now: Time;
  readonly severity: 'critical' | 'major' | 'minor';
  readonly category: string;
  readonly message: string;
  readonly citedAtomIds: ReadonlyArray<AtomId>;
  readonly citedPaths: ReadonlyArray<string>;
}

export function mkPipelineAuditFindingAtom(input: MkPipelineAuditFindingAtomInput): Atom {
  auditFindingSchema.parse({
    pipelineId: String(input.pipelineId),
    stageName: input.stageName,
    principalId: String(input.principalId),
    correlationId: input.correlationId,
    now: input.now,
    severity: input.severity,
    category: input.category,
    message: input.message,
    citedAtomIds: input.citedAtomIds.map(String),
    citedPaths: [...input.citedPaths],
  });
  // Append a short deterministic hash of the message so two findings
  // sharing severity + category in the same stage do not collide on id.
  const messageDigest = shortHash(input.message);
  const id = `pipeline-audit-finding-${input.pipelineId}-${input.stageName}-${input.correlationId}-${input.severity}-${input.category}-${messageDigest}` as AtomId;
  return baseAtom({
    id,
    type: 'pipeline-audit-finding',
    content: input.message,
    principalId: input.principalId,
    correlationId: input.correlationId,
    now: input.now,
    derivedFrom: [input.pipelineId],
    metadata: {
      pipeline_id: input.pipelineId,
      stage_name: input.stageName,
      severity: input.severity,
      category: input.category,
      message: input.message,
      cited_atom_ids: input.citedAtomIds.map(String),
      cited_paths: [...input.citedPaths],
    },
  });
}

// ---------------------------------------------------------------------------
// pipeline-failed atom (terminal on rollback)
// ---------------------------------------------------------------------------

export interface MkPipelineFailedAtomInput {
  readonly pipelineId: AtomId;
  readonly principalId: PrincipalId;
  readonly correlationId: string;
  readonly now: Time;
  readonly failedStageName: string;
  readonly failedStageIndex: number;
  readonly cause: string;
  readonly chain: ReadonlyArray<AtomId>;
  readonly recoveryHint: string;
}

export function mkPipelineFailedAtom(input: MkPipelineFailedAtomInput): Atom {
  const id = `pipeline-failed-${input.pipelineId}-${input.failedStageIndex}` as AtomId;
  return baseAtom({
    id,
    type: 'pipeline-failed',
    content: `${input.failedStageName}: ${input.cause}`,
    principalId: input.principalId,
    correlationId: input.correlationId,
    now: input.now,
    derivedFrom: [input.pipelineId, ...input.chain],
    metadata: {
      pipeline_id: input.pipelineId,
      failed_stage_name: input.failedStageName,
      failed_stage_index: input.failedStageIndex,
      cause: input.cause,
      chain: input.chain.map(String),
      recovery_hint: input.recoveryHint,
    },
  });
}

// ---------------------------------------------------------------------------
// pipeline-resume atom (lifts an HIL pause)
// ---------------------------------------------------------------------------

export interface MkPipelineResumeAtomInput {
  readonly pipelineId: AtomId;
  readonly principalId: PrincipalId;
  readonly correlationId: string;
  readonly now: Time;
  readonly stageName: string;
  readonly resumerPrincipalId: PrincipalId;
}

export function mkPipelineResumeAtom(input: MkPipelineResumeAtomInput): Atom {
  const id = `pipeline-resume-${input.pipelineId}-${input.stageName}-${input.correlationId}` as AtomId;
  return baseAtom({
    id,
    type: 'pipeline-resume',
    content: `resume:${input.stageName}`,
    principalId: input.principalId,
    correlationId: input.correlationId,
    now: input.now,
    derivedFrom: [input.pipelineId],
    metadata: {
      pipeline_id: input.pipelineId,
      stage_name: input.stageName,
      resumer_principal_id: String(input.resumerPrincipalId),
    },
  });
}
