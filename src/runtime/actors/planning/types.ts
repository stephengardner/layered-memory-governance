/**
 * PlanningActor types.
 *
 * The PlanningActor is the mechanism that turns an operator request
 * into a proposed `plan` atom grounded in canon directives, prior
 * decisions, relevant atoms, and active principals. It has no
 * opinions of its own -- its "soul" comes from the atom set. Every
 * plan it proposes cites the atoms it derived from.
 *
 * This file is vendor-neutral: no provider-specific types, no
 * channel-specific coupling. The actor composes with any Host (via
 * its LLM sub-interface) and any set of ActorAdapters declared at the
 * type level.
 */

import type { Atom, AtomId, PrincipalId, Time } from '../../../types.js';
import type { BlastRadius } from '../../actor-message/intent-approve.js';

/**
 * The aggregated state the PlanningActor considers when drafting a
 * plan. Produced by aggregateRelevantContext(host, query) and handed
 * into the actor's classify/propose phases.
 */
export interface PlanningContext {
  /** The request as the operator phrased it. */
  readonly request: string;
  /**
   * L3 directive atoms currently in canon. Enforced constraints; a
   * plan that conflicts with any of these either escalates or is
   * rejected at validatePlan time.
   */
  readonly directives: ReadonlyArray<Atom>;
  /** L3 decision atoms -- prior precedent the planner must honor. */
  readonly decisions: ReadonlyArray<Atom>;
  /**
   * Top-K semantically-relevant atoms across all layers. Includes
   * observations, preferences, references, and any plans. These
   * provide the domain-specific context the planner builds on.
   */
  readonly relevantAtoms: ReadonlyArray<Atom>;
  /**
   * Open Plan atoms (plan_state in {proposed, approved, executing}).
   * The planner must not duplicate a plan already in flight without
   * acknowledging the overlap.
   */
  readonly openPlans: ReadonlyArray<Atom>;
  /** Principals relevant to the request (by role or scope). */
  readonly relevantPrincipals: ReadonlyArray<{
    readonly id: PrincipalId;
    readonly role: string;
    readonly signed_by: PrincipalId | null;
  }>;
  /**
   * The principal's own recent atoms (plans, decisions, observations
   * authored by them). Threaded into the LLM prompt so a planner can
   * see "your prior work" alongside canon and relevant context. Empty
   * when no `selfPrincipalId` is requested (back-compat default).
   *
   * This is the substrate-level seam for "principals remember
   * themselves across time" -- the cheap path on the org-ceiling
   * roadmap (atoms-as-memory, not LLM-session-resume). Sequenced
   * before the deeper agent-session continuity work.
   */
  readonly selfContext: ReadonlyArray<Atom>;
  /** Time when the context was aggregated (for determinism audit). */
  readonly gatheredAt: Time;
}

/**
 * Classification of the request kind. Drives propose's template
 * selection and the set of constraints applied.
 */
export type PlanningClassificationKind =
  | 'greenfield'
  | 'modification'
  | 'reversal'
  | 'research'
  | 'emergency'
  | 'ambiguous';

export interface PlanningClassification {
  readonly kind: PlanningClassificationKind;
  /** Short rationale for the classification (surfaced in audit). */
  readonly rationale: string;
  /**
   * Directive atom ids this classification triggers as mandatory
   * constraints for propose. Empty for `research`/`ambiguous`.
   */
  readonly applicableDirectives: ReadonlyArray<AtomId>;
}

/**
 * A proposed plan. The PlanningActor writes each proposal as a
 * type='plan' atom with plan_state='proposed' and provenance chaining
 * back to the context atoms cited. This type is the pre-write view.
 */
export interface ProposedPlan {
  /** Short, human-readable title. */
  readonly title: string;
  /** Full plan body in markdown (rationale / steps / alternatives / principles cited). */
  readonly body: string;
  /**
   * Atoms this plan derives from (canon directives, prior decisions,
   * context atoms). Becomes provenance.derived_from on the written
   * Plan atom.
   */
  readonly derivedFrom: ReadonlyArray<AtomId>;
  /**
   * Specific canon directive atom ids the plan claims to satisfy.
   * validatePlan uses this to assert alignment; a plan that cites a
   * directive it actually violates is flagged.
   */
  readonly principlesApplied: ReadonlyArray<AtomId>;
  /**
   * Alternatives considered and rejected, with short reasons. Each
   * entry lands in the plan body; tracked separately here for audit.
   */
  readonly alternativesRejected: ReadonlyArray<{
    readonly option: string;
    readonly reason: string;
  }>;
  /**
   * Short answer to "what breaks if we revisit this plan in 3
   * months". A canon directive may require this field; the framework
   * only typechecks that it's present.
   */
  readonly whatBreaksIfRevisit: string;
  /**
   * Optional confidence score in [0,1]. When low (below a
   * threshold) the actor escalates instead of proposing.
   */
  readonly confidence?: number;
  /**
   * Optional sub-actor delegation declared by the planner (LLM via
   * PLAN_DRAFT). When present, gets written to plan.metadata.delegation;
   * the approval tick (runIntentAutoApprovePass) reads this field to
   * gate auto-approval. Distinct from actor-option delegateTo which
   * is set by the orchestrator; the LLM-emitted form here takes
   * precedence when both are set.
   */
  readonly delegation?: {
    readonly sub_actor_principal_id: string;
    readonly reason: string;
    readonly implied_blast_radius: BlastRadius;
  };
}

/**
 * Hooks the PlanningActor uses for its LLM-backed judgment. Injected
 * so the actor is testable without a real LLM and so prompt templates
 * can swap without touching the actor code. A stub implementation
 * returns deterministic answers; production wires an LLM adapter that
 * reads versioned prompts from disk.
 */
export interface PlanningJudgment {
  /**
   * Classify the request against the context. Returns a
   * PlanningClassification.
   */
  classify(context: PlanningContext): Promise<PlanningClassification>;
  /**
   * Draft one or more proposed plans from the context +
   * classification. Must cite atoms from the context in derivedFrom
   * and principlesApplied.
   */
  draft(
    context: PlanningContext,
    classification: PlanningClassification,
  ): Promise<ReadonlyArray<ProposedPlan>>;
}
