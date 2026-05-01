/**
 * Renderer dispatch table.
 *
 * Pure lookup: `pickRenderer(type, metadata)` returns the right
 * AtomRenderer for that atom-type, with a best-effort metadata read
 * for `observation`-typed atoms (metadata.kind disambiguates between
 * pr-observation, auditor-plan-check, etc).
 *
 * The function is pure (a side-effect-free table lookup) so the unit
 * tests cover the full dispatch matrix without standing up React.
 *
 * Per canon `dev-substrate-not-prescription` adding a new renderer is
 * a one-line table edit; renderer modules are independent.
 */

import { GenericRenderer } from './generic';
import { PlanRenderer } from './plan';
import { PipelineRenderer } from './pipeline';
import { PipelineStageEventRenderer } from './pipeline-stage-event';
import { PipelineAuditFindingRenderer } from './pipeline-audit-finding';
import {
  BrainstormOutputRenderer,
  SpecOutputRenderer,
  ReviewReportRenderer,
  DispatchRecordRenderer,
} from './brainstorm-output';
import { OperatorIntentRenderer } from './operator-intent';
import { ActorMessageRenderer } from './actor-message';
import { AuditorPlanCheckRenderer } from './auditor-plan-check';
import { AgentSessionRenderer, AgentTurnRenderer } from './agent-session';
import { PrFixObservationRenderer } from './pr-fix-observation';
import type { AtomRenderer } from './types';

/**
 * The primary type-name -> renderer mapping. Order doesn't matter
 * (it's a hashmap) but adjacent entries are grouped by domain for
 * readability.
 */
const TYPE_RENDERERS: Readonly<Record<string, AtomRenderer>> = Object.freeze({
  // Plan documents
  plan: PlanRenderer,

  // Pipeline root + descendants
  pipeline: PipelineRenderer,
  'pipeline-stage-event': PipelineStageEventRenderer,
  'pipeline-audit-finding': PipelineAuditFindingRenderer,
  'pipeline-resume': PipelineStageEventRenderer,
  'pipeline-failed': PipelineStageEventRenderer,

  // Stage outputs
  'brainstorm-output': BrainstormOutputRenderer,
  'spec-output': SpecOutputRenderer,
  'review-report': ReviewReportRenderer,
  'dispatch-record': DispatchRecordRenderer,

  // Operator + messaging
  'operator-intent': OperatorIntentRenderer,
  'actor-message': ActorMessageRenderer,
  'actor-message-ack': ActorMessageRenderer,

  // Agent loop
  'agent-session': AgentSessionRenderer,
  'agent-turn': AgentTurnRenderer,

  // PR-fix specific atom type
  'pr-fix-observation': PrFixObservationRenderer,
});

/**
 * `observation` is a generic type used by several emitters; the
 * `metadata.kind` field disambiguates. Map each known kind to the
 * right renderer.
 */
const OBSERVATION_KIND_RENDERERS: Readonly<Record<string, AtomRenderer>> = Object.freeze({
  'auditor-plan-check': AuditorPlanCheckRenderer,
  'pr-observation': PrFixObservationRenderer,
  'pr-fix-observation': PrFixObservationRenderer,
});

export function pickRenderer(
  type: string | undefined,
  metadata?: Readonly<Record<string, unknown>> | undefined,
): AtomRenderer {
  if (typeof type !== 'string' || type.length === 0) {
    return GenericRenderer;
  }
  // observation requires a metadata.kind read for proper dispatch.
  if (type === 'observation' && metadata) {
    const kind = metadata['kind'];
    if (typeof kind === 'string' && kind in OBSERVATION_KIND_RENDERERS) {
      return OBSERVATION_KIND_RENDERERS[kind]!;
    }
  }
  return TYPE_RENDERERS[type] ?? GenericRenderer;
}

/**
 * Test-only: expose the table so the unit test can assert coverage
 * for every required type without re-executing pickRenderer N times.
 */
export const _internal = Object.freeze({
  TYPE_RENDERERS,
  OBSERVATION_KIND_RENDERERS,
});
