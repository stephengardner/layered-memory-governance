/**
 * Pure stage-name mapping helpers for the deep planning pipeline.
 *
 * Each agentic pipeline stage is a triple: a stage NAME (the canonical
 * `metadata.stage_name` value emitted on every output atom), a
 * PRINCIPAL id (the actor identity the LLM call runs under), and a
 * SKILL bundle name (the vendored superpowers markdown that becomes
 * the agent's "soul" prompt). The triple is fixed by the stage
 * adapters in examples/planning-stages/<stage>/agentic.ts; this module
 * exposes the same mapping as a pure function so consumers outside the
 * adapter (the Console's stage-context endpoint, future audit tools,
 * substrate dashboards) can derive bundle + principal from a stage
 * name without re-importing the adapter modules.
 *
 * Substrate purity: the helpers are deterministic, side-effect-free,
 * and contain no I/O. The actual bundle markdown read still goes
 * through `resolveSkillBundle` so plugin-cache + vendored-fallback
 * behavior is centralized in one place. New stages register here +
 * in their adapter; the canonical mapping is the table below.
 *
 * Per canon `dev-substrate-not-prescription`, this is a closed
 * allow-list for the indie-floor default 5-stage composition;
 * org-ceiling deployments that introduce a custom stage register it
 * by editing this table (a code change, not a runtime config knob).
 */

import type { SupportedSkillName } from './skill-bundle-resolver';

/** Canonical stage names emitted as `metadata.stage_name` on output atoms. */
export const PIPELINE_STAGE_NAMES = [
  'brainstorm-stage',
  'spec-stage',
  'plan-stage',
  'review-stage',
  'dispatch-stage',
] as const;
export type PipelineStageName = (typeof PIPELINE_STAGE_NAMES)[number];

/** A stage's full identity: its principal + skill bundle. */
export interface StageBinding {
  readonly stage: PipelineStageName;
  readonly principalId: string;
  readonly skillBundle: SupportedSkillName;
}

/*
 * The canonical 5-stage table. Each row matches the `stagePrincipal`
 * default + `resolveSkillBundle('<bundle>')` call inside the
 * corresponding adapter module:
 *
 *   - brainstorm-stage : examples/planning-stages/brainstorm/agentic.ts
 *   - spec-stage       : examples/planning-stages/spec/agentic.ts
 *   - plan-stage       : examples/planning-stages/plan/agentic.ts
 *   - review-stage     : examples/planning-stages/review/agentic.ts
 *   - dispatch-stage   : examples/planning-stages/dispatch/agentic.ts
 */
const STAGE_TABLE: Readonly<Record<PipelineStageName, StageBinding>> = Object.freeze({
  'brainstorm-stage': {
    stage: 'brainstorm-stage',
    principalId: 'brainstorm-actor',
    skillBundle: 'brainstorming',
  },
  'spec-stage': {
    stage: 'spec-stage',
    principalId: 'spec-author',
    skillBundle: 'writing-clearly',
  },
  'plan-stage': {
    stage: 'plan-stage',
    principalId: 'plan-author',
    skillBundle: 'writing-plans',
  },
  'review-stage': {
    stage: 'review-stage',
    principalId: 'pipeline-auditor',
    skillBundle: 'review-discipline',
  },
  'dispatch-stage': {
    stage: 'dispatch-stage',
    principalId: 'plan-dispatcher',
    skillBundle: 'dispatch-discipline',
  },
});

/**
 * Type-guard for the canonical stage names. Callers receiving a raw
 * string (e.g. `metadata.stage_name` from disk) should narrow with
 * this helper before consulting the table.
 */
export function isPipelineStageName(value: unknown): value is PipelineStageName {
  return typeof value === 'string'
    && (PIPELINE_STAGE_NAMES as ReadonlyArray<string>).includes(value);
}

/**
 * Look up the principal + skill-bundle for a stage. Returns `null` for
 * any unknown stage; callers (e.g. the Console's stage-context
 * endpoint) treat null as "no pipeline stage for this atom" and surface
 * the empty stage-context view rather than guessing.
 */
export function bindingForStage(stage: string): StageBinding | null {
  if (!isPipelineStageName(stage)) return null;
  return STAGE_TABLE[stage];
}

/**
 * Derive a stage name from an atom-type when the canonical
 * `metadata.stage_name` field is absent. The plan-stage in particular
 * emits a top-level `plan` atom without the metadata field set, so
 * type-based fallback is required to surface its stage context. Other
 * stages always carry `metadata.stage_name`; the type-based mapping is
 * a defensive fallback, not the primary path.
 *
 * Returns `null` for atom types that are not pipeline stage outputs
 * (canon, observation, actor-message, etc.). The plan branch returns
 * null when `metadata.pipeline_id` is absent because a manually
 * authored plan (one not emitted by the deep pipeline) has no upstream
 * stage soul to surface.
 */
export function stageFromAtomType(
  atomType: string,
  metadata: Readonly<Record<string, unknown>> | undefined,
): PipelineStageName | null {
  switch (atomType) {
    case 'brainstorm-output':
      return 'brainstorm-stage';
    case 'spec-output':
      return 'spec-stage';
    case 'review-report':
      return 'review-stage';
    case 'dispatch-record':
      return 'dispatch-stage';
    case 'plan': {
      // A `plan` atom without a pipeline_id is a manually authored
      // plan (operator or pre-pipeline CTO actor), not a pipeline-emitted
      // plan-stage output -- no soul to surface.
      const pipelineId = metadata?.['pipeline_id'];
      return typeof pipelineId === 'string' && pipelineId.length > 0
        ? 'plan-stage'
        : null;
    }
    default:
      return null;
  }
}

/**
 * Resolve the canonical stage name for an atom. Prefers the explicit
 * `metadata.stage_name` value (set by the substrate's stage runner);
 * falls back to type-based inference for atom types that omit the
 * metadata field. Returns `null` when the atom is not a pipeline-stage
 * output of any recognized shape.
 */
export function stageForAtom(
  atomType: string,
  metadata: Readonly<Record<string, unknown>> | undefined,
): PipelineStageName | null {
  const explicit = metadata?.['stage_name'];
  if (isPipelineStageName(explicit)) return explicit;
  return stageFromAtomType(atomType, metadata);
}
