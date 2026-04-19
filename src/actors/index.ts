/**
 * Actor primitive (Phase 53a).
 *
 * See design/actors-and-adapters.md and DECISIONS.md D16/D17 for the
 * rationale behind Actor as a framework primitive and ActorAdapter as a
 * deliberate second boundary (alongside Host for governance).
 *
 * Subpath import on purpose:
 *
 *   import { runActor } from 'layered-autonomous-governance/actors';
 *
 * The top-level 'layered-autonomous-governance' package deliberately
 * does NOT re-export these. Keep the surface simple; opt in to actors.
 *
 * Reference implementations (e.g., PrLandingActor) live on further
 * subpaths like '/actors/pr-landing'.
 */

export type { Actor, ActorContext } from './actor.js';
export { runActor } from './run-actor.js';
export type { RunActorOptions } from './run-actor.js';
export type {
  ActorAdapter,
  ActorAdapters,
  ActorAuditEvent,
  ActorAuditEventKind,
  ActorBudget,
  ActorHaltReason,
  ActorReport,
  Classified,
  ProposedAction,
  Reflection,
} from './types.js';
