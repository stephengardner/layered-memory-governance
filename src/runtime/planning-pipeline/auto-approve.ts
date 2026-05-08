/**
 * Pipeline-stage plan auto-approval.
 *
 * Wires the autonomous-intent trust-envelope check into the deep
 * planning pipeline. After the plan-stage persists its emitted plan
 * atoms (one per entry in the StageOutput.value plans array), the
 * runner calls evaluatePipelinePlanAutoApproval per atom; for every
 * plan whose seed operator-intent's trust envelope authorizes the
 * delegation shape, the runner transitions plan_state proposed ->
 * approved in place. Without this glue, plan atoms sit in 'proposed'
 * forever and the dispatch-stage (which filters plan_state ===
 * 'approved') reports scanned: 0 even though a plan exists.
 *
 * Mirrors the single-pass autonomous-intent flow in
 * src/runtime/actor-message/intent-approve.ts:
 *   - same envelope checks (min_plan_confidence, max_blast_radius,
 *     allowed_sub_actors)
 *   - same intent-side guards (taint clean, not expired, principal in
 *     pol-operator-intent-creation allowlist)
 *   - same gating policy lookup (pol-plan-autonomous-intent-approve)
 *   - same RADIUS_RANK ordinals so org-wide policy edits land in one
 *     module rather than two
 *   - same metadata stamping shape (approved_via, approved_at,
 *     approved_intent_id) so console plan-detail and audit consumers
 *     do not branch on pipeline vs single-pass origin
 *
 * The pure evaluator is exported so callers (tests, dashboards, future
 * dry-run tooling) can predict outcomes without driving a full atom
 * write. The runner-facing helper combines the evaluator with the
 * claim-before-mutate update + auditor log entry so the approval is
 * observable through the same audit-event channel as the single-pass
 * tick.
 *
 * Substrate purity: every dial (which sub-actors qualify, what
 * envelope shape, what blast-radius labels exist) lives in canon
 * policy atoms or is read off the seed intent. The runner consumes
 * the evaluator's verdict; it does not encode role names or org
 * shape. Indie deployments inherit the pol-plan-autonomous-intent-
 * approve default; org-ceiling deployments override per scope without
 * a code change.
 */

import {
  RADIUS_RANK,
  SkipReason,
  findIntentInProvenance,
  type BlastRadius,
} from '../actor-message/intent-approve.js';
import { mkPipelineAuditFindingAtom } from './atom-shapes.js';
import type { Host } from '../../substrate/interface.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../substrate/types.js';

// ---------------------------------------------------------------------------
// Pure evaluator: outcome shapes
// ---------------------------------------------------------------------------

/**
 * Result of evaluating a single plan atom against its seed operator-
 * intent's trust envelope plus the intent-approve policies.
 *
 * Four kinds:
 *   - 'approved': every envelope check passed; the runner SHOULD call
 *     host.atoms.update to transition plan_state proposed -> approved.
 *   - 'skipped': the plan matched an intent but failed an envelope check
 *     (mirror of intent-approve.ts SkipReason taxonomy). Plan stays
 *     proposed; the operator inspects via the audit log.
 *   - 'rejected': intent-side guard failed (taint, expiry, principal
 *     allowlist). Plan stays proposed; the audit log carries the reason.
 *   - 'not-eligible': plan has no operator-intent in
 *     provenance.derived_from. NOT a skip per intent-approve.ts (a non-
 *     intent plan emits one event per tick which is noise rather than
 *     signal); the runner ignores not-eligible verdicts silently.
 *
 * Each kind carries enough context for the runner to log the verdict
 * without a second policy read.
 */
export type PlanAutoApprovalEvaluation =
  | { readonly kind: 'approved'; readonly intentId: AtomId; readonly policyAtomId: string }
  | {
      readonly kind: 'skipped';
      readonly reason: SkipReason;
      readonly intentId: AtomId;
      readonly details: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'tainted-intent'
        | 'expired-intent'
        | 'intent-missing-or-wrong-type'
        | 'principal-not-whitelisted';
      readonly intentId: AtomId;
    }
  | { readonly kind: 'not-eligible' };

/**
 * Inputs to the pure envelope evaluator. The caller resolves canon
 * policy atoms once (in the runner's pre-stage path) and passes the
 * configs in so per-plan evaluation does no I/O. nowMs is injected
 * so tests pin the wall clock without reaching around the host.
 */
export interface PlanAutoApprovalEvaluatorInput {
  readonly plan: Atom;
  readonly intent: Atom | null;
  /**
   * The pol-plan-autonomous-intent-approve policy result. atomId is
   * null when no policy atom matched; in that case the evaluator
   * fail-closes to 'rejected' with reason 'intent-missing-or-wrong-
   * type' because an intent flow with no gating policy is the same
   * shape as no flow at all.
   */
  readonly intentApprovePolicy: {
    readonly allowed_sub_actors: ReadonlyArray<string>;
    readonly atomId: string | null;
  };
  /**
   * The pol-operator-intent-creation policy result. allowed_principal_
   * ids gates which intents the autonomous tick honours; an intent
   * authored by a non-whitelisted principal is logged but not
   * authorizing.
   */
  readonly intentCreationPolicy: {
    readonly allowed_principal_ids: ReadonlyArray<string>;
  };
  readonly nowMs: number;
}

/**
 * Pure function: evaluate a plan against its seed intent and the two
 * gating policies. Returns a verdict; never writes. Callers persist
 * the verdict via the host.
 *
 * Mirrors the per-plan branch of runIntentAutoApprovePass in
 * src/runtime/actor-message/intent-approve.ts. The two functions stay
 * in lock-step on every envelope check; if an org-wide policy adds a
 * new check (e.g. a recency requirement on the seed intent), both
 * paths inherit it via the shared imports (RADIUS_RANK, SkipReason).
 *
 * Threat-model posture:
 *   - Fail-closed at every branch. Missing intent, malformed envelope,
 *     unknown radius label, and principal-not-whitelisted all produce
 *     a non-'approved' verdict.
 *   - Object.hasOwn used for radius rank guards so prototype-chain
 *     keys (toString, valueOf, constructor) cannot pass the check; a
 *     plan with `implied_blast_radius: 'toString'` would fail the
 *     RADIUS_UNKNOWN guard rather than silently fall through to a
 *     `undefined > N` (false) comparison.
 *   - No side effects: the runner's claim-before-mutate update is the
 *     only authorized state-transition path.
 */
export function evaluatePipelinePlanAutoApproval(
  input: PlanAutoApprovalEvaluatorInput,
): PlanAutoApprovalEvaluation {
  const { plan, intent, intentApprovePolicy, intentCreationPolicy, nowMs } = input;

  // Caller has already located the intent via findIntentInProvenance;
  // a null intent means the plan does not cite an operator-intent in
  // provenance.derived_from (not eligible for the autonomous flow).
  if (intent === null) {
    return { kind: 'not-eligible' };
  }

  // Intent-side guards (rejected, not skipped: a malformed intent or
  // expired intent is not an envelope-mismatch but an authorization
  // failure).
  if (intent.type !== 'operator-intent') {
    return { kind: 'rejected', reason: 'intent-missing-or-wrong-type', intentId: intent.id };
  }
  if (intent.taint !== 'clean') {
    return { kind: 'rejected', reason: 'tainted-intent', intentId: intent.id };
  }
  // Permissive expiry check: only reject when metadata.expires_at is a
  // string that parses to a past timestamp. A missing or non-string
  // expires_at is treated as fresh, matching intent-approve.ts byte-
  // for-byte (search "Expired intent -> reject" in
  // src/runtime/actor-message/intent-approve.ts). The autonomous-intent
  // contract is "fresh non-expired intent authorizes approval"; an
  // intent without an explicit expiry is fresh by default in the
  // single-pass tick, and the pipeline path must agree or operator-
  // intent atoms shippable through one tick get rejected by the other
  // (substrate divergence; surfaced by dogfeed-5 2026-04-30). A
  // malformed expires_at string (Date.parse -> NaN) also falls through
  // as fresh because NaN < nowMs is false; the strict "must be
  // parseable" gate is intentionally not enforced here for parity with
  // the canonical check.
  const expiresRaw = (intent.metadata as Record<string, unknown>)?.expires_at;
  if (typeof expiresRaw === 'string' && Date.parse(expiresRaw) < nowMs) {
    return { kind: 'rejected', reason: 'expired-intent', intentId: intent.id };
  }
  if (!intentCreationPolicy.allowed_principal_ids.includes(String(intent.principal_id))) {
    return { kind: 'rejected', reason: 'principal-not-whitelisted', intentId: intent.id };
  }

  // Envelope checks: confidence, sub-actor, blast-radius. Each mismatch
  // is observable but NOT a rejection; mirrors intent-approve.ts.
  const envelope = (intent.metadata as Record<string, unknown>)?.trust_envelope as
    | Record<string, unknown>
    | undefined;
  if (!envelope) {
    return {
      kind: 'skipped',
      reason: SkipReason.MISSING_TRUST_ENVELOPE,
      intentId: intent.id,
      details: {},
    };
  }

  const minPlanConf =
    typeof envelope.min_plan_confidence === 'number' ? envelope.min_plan_confidence : 0.75;
  if (plan.confidence < minPlanConf) {
    return {
      kind: 'skipped',
      reason: SkipReason.BELOW_MIN_CONFIDENCE,
      intentId: intent.id,
      details: {
        plan_confidence: plan.confidence,
        envelope_min_confidence: minPlanConf,
      },
    };
  }

  const delegation = (plan.metadata as Record<string, unknown>)?.delegation as
    | Record<string, unknown>
    | undefined;
  if (!delegation) {
    return {
      kind: 'skipped',
      reason: SkipReason.NO_DELEGATION,
      intentId: intent.id,
      details: {},
    };
  }

  const subActor =
    typeof delegation.sub_actor_principal_id === 'string'
      ? delegation.sub_actor_principal_id
      : '';
  const envAllowedSubActors = Array.isArray(envelope.allowed_sub_actors)
    ? (envelope.allowed_sub_actors as unknown[]).filter(
        (v): v is string => typeof v === 'string',
      )
    : [];
  if (!envAllowedSubActors.includes(subActor)) {
    return {
      kind: 'skipped',
      reason: SkipReason.SUB_ACTOR_NOT_ALLOWED,
      intentId: intent.id,
      details: {
        plan_sub_actor: subActor,
        envelope_allowed_sub_actors: envAllowedSubActors,
      },
    };
  }

  // Object.hasOwn so prototype-chain keys do not pass the guard; matches
  // intent-approve.ts. Without it a delegation whose implied_blast_radius
  // is the string 'toString' would silently RADIUS_RANK[planRadius] ->
  // function-not-number and the rank comparison would fail-open.
  const planRadius = delegation.implied_blast_radius;
  const envelopeMax = envelope.max_blast_radius;
  if (typeof planRadius !== 'string' || !Object.hasOwn(RADIUS_RANK, planRadius)) {
    return {
      kind: 'skipped',
      reason: SkipReason.RADIUS_UNKNOWN,
      intentId: intent.id,
      details: { plan_radius: typeof planRadius === 'string' ? planRadius : null },
    };
  }
  if (typeof envelopeMax !== 'string' || !Object.hasOwn(RADIUS_RANK, envelopeMax)) {
    return {
      kind: 'skipped',
      reason: SkipReason.DELEGATION_RADIUS_UNKNOWN,
      intentId: intent.id,
      details: { envelope_max_radius: typeof envelopeMax === 'string' ? envelopeMax : null },
    };
  }
  if (RADIUS_RANK[planRadius as BlastRadius] > RADIUS_RANK[envelopeMax as BlastRadius]) {
    return {
      kind: 'skipped',
      reason: SkipReason.DELEGATION_RADIUS_EXCEEDS_ENVELOPE,
      intentId: intent.id,
      details: { plan_radius: planRadius, envelope_max_radius: envelopeMax },
    };
  }

  // Intent-approve policy gating: the global allowlist of sub-actors
  // that this autonomous flow honours at all. The intent envelope's
  // allowed_sub_actors is the per-intent narrowing; this policy is the
  // org-wide ceiling. Empty allowlist disables the autonomous flow
  // entirely (default-deny posture).
  if (intentApprovePolicy.atomId === null) {
    return { kind: 'rejected', reason: 'intent-missing-or-wrong-type', intentId: intent.id };
  }
  if (!intentApprovePolicy.allowed_sub_actors.includes(subActor)) {
    return {
      kind: 'skipped',
      reason: SkipReason.SUB_ACTOR_NOT_ALLOWED,
      intentId: intent.id,
      details: {
        plan_sub_actor: subActor,
        // Surfaces the policy-side allowlist (distinct from the
        // envelope allowlist) so an audit consumer sees which gate
        // tripped without re-reading the policy atom.
        policy_allowed_sub_actors: intentApprovePolicy.allowed_sub_actors,
      },
    };
  }

  return {
    kind: 'approved',
    intentId: intent.id,
    policyAtomId: intentApprovePolicy.atomId,
  };
}

// ---------------------------------------------------------------------------
// Helpers for surfacing skipped verdicts as pipeline-audit-finding atoms
// ---------------------------------------------------------------------------

/**
 * Convert a SkipReason snake_case value (e.g.
 * 'delegation_radius_exceeds_envelope') to a kebab-cased category
 * suitable for a pipeline-audit-finding atom (e.g.
 * 'delegation-radius-exceeds-envelope'). The audit-finding shape's
 * `category` field is freeform string but reads cleaner in console
 * projections when it matches the kebab convention used by every
 * other category seeded by stage adapters (e.g. 'fabricated-cited-
 * atom', 'non-verified-cited-atom').
 */
function skipReasonToCategory(reason: SkipReason): string {
  return String(reason).replace(/_/g, '-');
}

/**
 * Walk a plan's `provenance.derived_from` for the first id starting
 * with `pipeline-`. The deep planning pipeline runner stamps the
 * pipeline atom id at index 0 of every plan-stage emit's derived_from
 * (see mkPlanOutputAtoms in atom-shapes.ts), so when a plan was
 * authored inside a pipeline, this helper returns its pipeline atom
 * id. When the plan was authored outside a pipeline (single-pass
 * cto-actor flow), no pipeline ancestor exists and the helper returns
 * null; the caller skips the audit-finding write in that case
 * because the existing 'plan.skipped-by-intent' audit-log entry is
 * already the operator-facing signal there.
 */
function findPipelineAncestor(plan: Atom): AtomId | null {
  const derivedFrom = plan.provenance?.derived_from ?? [];
  for (const id of derivedFrom) {
    if (typeof id === 'string' && id.startsWith('pipeline-')) {
      return id as AtomId;
    }
  }
  return null;
}

/**
 * Build the human-readable message for an envelope-mismatch finding.
 * Captures the field-level cause + the operator-actionable guidance
 * the console renders without re-reading the verdict.details bag.
 *
 * The message names the specific failure mode so an operator skimming
 * the /pipelines/<id> view sees the cause inline:
 *   - radius mismatch: which radius was claimed and what the intent
 *     allows
 *   - confidence mismatch: which threshold the plan missed
 *   - sub-actor mismatch: which actor was named and which the
 *     envelope or policy permits
 *   - missing envelope / no delegation: structural guidance
 */
function envelopeMismatchMessage(
  reason: SkipReason,
  details: Readonly<Record<string, unknown>>,
): string {
  switch (reason) {
    case SkipReason.DELEGATION_RADIUS_EXCEEDS_ENVELOPE: {
      const planRadius = String(details['plan_radius'] ?? '<unknown>');
      const envelopeMax = String(details['envelope_max_radius'] ?? '<unknown>');
      return (
        `Plan rejected by autonomous-intent envelope: implied_blast_radius="${planRadius}" `
        + `exceeds intent.max_blast_radius="${envelopeMax}". Tighten the plan-author `
        + 'classification or widen the intent envelope.'
      );
    }
    case SkipReason.RADIUS_UNKNOWN: {
      const planRadius =
        details['plan_radius'] === null ? '<missing>' : String(details['plan_radius']);
      return (
        `Plan rejected by autonomous-intent envelope: implied_blast_radius="${planRadius}" `
        + 'is not a known radius label (none, docs, tooling, framework, l3-canon-proposal). '
        + 'Fix the plan-author classification.'
      );
    }
    case SkipReason.DELEGATION_RADIUS_UNKNOWN: {
      const envelopeMax =
        details['envelope_max_radius'] === null
          ? '<missing>'
          : String(details['envelope_max_radius']);
      return (
        `Plan rejected by autonomous-intent envelope: intent.max_blast_radius="${envelopeMax}" `
        + 'is not a known radius label. Fix the operator-intent envelope.'
      );
    }
    case SkipReason.BELOW_MIN_CONFIDENCE: {
      const planConf = String(details['plan_confidence'] ?? '<unknown>');
      const minConf = String(details['envelope_min_confidence'] ?? '<unknown>');
      return (
        `Plan rejected by autonomous-intent envelope: plan.confidence=${planConf} is below `
        + `intent.min_plan_confidence=${minConf}. Raise the plan-author confidence or lower `
        + 'the envelope threshold.'
      );
    }
    case SkipReason.SUB_ACTOR_NOT_ALLOWED: {
      const planSubActor = String(details['plan_sub_actor'] ?? '<unknown>');
      const envAllowed = Array.isArray(details['envelope_allowed_sub_actors'])
        ? (details['envelope_allowed_sub_actors'] as ReadonlyArray<unknown>)
            .map((v) => String(v))
            .join(', ')
        : null;
      const policyAllowed = Array.isArray(details['policy_allowed_sub_actors'])
        ? (details['policy_allowed_sub_actors'] as ReadonlyArray<unknown>)
            .map((v) => String(v))
            .join(', ')
        : null;
      const allowedSummary =
        envAllowed !== null
          ? `intent.trust_envelope.allowed_sub_actors=[${envAllowed}]`
          : policyAllowed !== null
            ? `pol-plan-autonomous-intent-approve.allowed_sub_actors=[${policyAllowed}]`
            : 'the autonomous-intent allowlist';
      return (
        `Plan rejected by autonomous-intent envelope: delegation.sub_actor_principal_id `
        + `"${planSubActor}" is not in ${allowedSummary}. Pick an allowed sub-actor or widen `
        + 'the allowlist.'
      );
    }
    case SkipReason.MISSING_TRUST_ENVELOPE:
      return (
        'Plan rejected by autonomous-intent envelope: the seed operator-intent has no '
        + 'trust_envelope block. Re-author the intent with min_plan_confidence, '
        + 'max_blast_radius, and allowed_sub_actors.'
      );
    case SkipReason.NO_DELEGATION:
      return (
        'Plan rejected by autonomous-intent envelope: the plan has no metadata.delegation '
        + 'block. The plan-author must emit delegation.sub_actor_principal_id, reason, and '
        + 'implied_blast_radius.'
      );
    default:
      return `Plan rejected by autonomous-intent envelope: ${String(reason)}.`;
  }
}

// ---------------------------------------------------------------------------
// Runner-facing wrapper: reads policies, evaluates, persists, audits.
// ---------------------------------------------------------------------------

export interface RunPipelinePlanAutoApprovalOptions {
  /** ISO clock; defaults to wall time. Tests pin via this option. */
  readonly now?: () => string;
}

export interface RunPipelinePlanAutoApprovalResult {
  readonly considered: number;
  readonly approved: number;
  readonly skipped: number;
  readonly rejected: number;
  readonly notEligible: number;
}

/**
 * Auto-approve a set of just-emitted plan atoms.
 *
 * Called by the planning-pipeline runner immediately after plan-stage
 * persistence. For each plan id:
 *   1. Re-read the atom (the plan-stage's persisted shape).
 *   2. Walk provenance.derived_from for the seed operator-intent.
 *   3. Evaluate the envelope via evaluatePipelinePlanAutoApproval.
 *   4. On 'approved': claim-before-mutate update transitioning
 *      plan_state proposed -> approved + metadata.approved_via /
 *      approved_at / approved_intent_id stamps. Logs a
 *      'plan.approved-by-intent' audit event.
 *   5. On 'skipped' / 'rejected': logs the corresponding audit event;
 *      plan stays proposed.
 *   6. On 'not-eligible': silent (matches intent-approve.ts policy).
 *
 * Returns counts so the runner can include the verdict in stage-event
 * metadata for observability without re-querying the auditor.
 *
 * Idempotent on re-run: a plan already in plan_state !== 'proposed'
 * (e.g. already approved by a peer pass) is treated as 'not-eligible'
 * after the claim-before-mutate re-read.
 */
export async function runPipelinePlanAutoApproval(
  host: Host,
  planAtomIds: ReadonlyArray<AtomId>,
  options: RunPipelinePlanAutoApprovalOptions = {},
): Promise<RunPipelinePlanAutoApprovalResult> {
  // Kill-switch absolute priority: poll BEFORE any reads or writes.
  if (host.scheduler.killswitchCheck()) {
    return { considered: 0, approved: 0, skipped: 0, rejected: 0, notEligible: 0 };
  }

  if (planAtomIds.length === 0) {
    return { considered: 0, approved: 0, skipped: 0, rejected: 0, notEligible: 0 };
  }

  const intentApprovePolicy = await readIntentApprovePolicy(host);
  // Fail-closed short-circuit: empty allowlist means the autonomous flow
  // is off; every plan is treated as not-eligible without reading the
  // intent atom or the creation policy.
  if (intentApprovePolicy.allowed_sub_actors.length === 0) {
    return {
      considered: planAtomIds.length,
      approved: 0,
      skipped: 0,
      rejected: 0,
      notEligible: planAtomIds.length,
    };
  }

  const intentCreationPolicy = await readIntentCreationPolicy(host);
  const nowFn = options.now ?? (() => new Date().toISOString());
  const nowMs = Date.parse(nowFn());

  let approved = 0;
  let skipped = 0;
  let rejected = 0;
  let notEligible = 0;

  for (const planId of planAtomIds) {
    const plan = await host.atoms.get(planId);
    if (plan === null || plan.type !== 'plan') {
      // The runner just persisted these ids; a missing or wrong-type
      // read here means a concurrent writer raced ahead. Count as
      // not-eligible so the verdict total reconciles with the input list.
      notEligible++;
      continue;
    }
    if (plan.taint !== 'clean') {
      notEligible++;
      continue;
    }
    if (plan.superseded_by.length > 0) {
      notEligible++;
      continue;
    }
    if (plan.plan_state !== 'proposed') {
      notEligible++;
      continue;
    }

    const intentId = await findIntentInProvenance(host, plan);
    const intent = intentId === null ? null : await host.atoms.get(intentId);

    const verdict = evaluatePipelinePlanAutoApproval({
      plan,
      intent,
      intentApprovePolicy,
      intentCreationPolicy,
      nowMs,
    });

    if (verdict.kind === 'not-eligible') {
      notEligible++;
      continue;
    }

    if (verdict.kind === 'rejected') {
      rejected++;
      await host.auditor.log({
        kind: 'plan.rejected-by-intent',
        principal_id: plan.principal_id as PrincipalId,
        timestamp: nowFn() as Time,
        refs: { atom_ids: [plan.id, verdict.intentId] },
        details: {
          plan_id: String(plan.id),
          intent_id: String(verdict.intentId),
          reason: verdict.reason,
          source: 'planning-pipeline',
        },
      });
      continue;
    }

    if (verdict.kind === 'skipped') {
      skipped++;
      await host.auditor.log({
        kind: 'plan.skipped-by-intent',
        principal_id: plan.principal_id as PrincipalId,
        timestamp: nowFn() as Time,
        refs: { atom_ids: [plan.id, verdict.intentId] },
        details: {
          plan_id: String(plan.id),
          intent_id: String(verdict.intentId),
          reason: verdict.reason,
          source: 'planning-pipeline',
          ...verdict.details,
        },
      });
      // Surface the envelope-mismatch as a queryable
      // pipeline-audit-finding atom so the console pipeline-detail
      // projection renders the cause inline rather than relying on
      // the audit-log entry above (which is invisible to the
      // /pipelines/<id> view). The finding is written ONLY when the
      // plan was authored inside a pipeline (its
      // provenance.derived_from carries a pipeline ancestor); plans
      // authored outside the pipeline (single-pass cto-actor) keep
      // the audit-log-only signal because there is no pipeline
      // surface to project the finding into.
      const pipelineAncestorId = findPipelineAncestor(plan);
      if (pipelineAncestorId !== null) {
        // Read the correlationId from the plan's provenance so the
        // finding atom shares the deterministic id slug with the
        // pipeline's other stage atoms (no need to thread it through
        // RunPipelinePlanAutoApprovalOptions; the plan IS the
        // primary input here and already carries the value the
        // runner stamped at mint time).
        const correlationId =
          typeof plan.provenance?.source?.session_id === 'string'
            ? plan.provenance.source.session_id
            : 'unknown';
        await host.atoms.put(
          mkPipelineAuditFindingAtom({
            pipelineId: pipelineAncestorId,
            // The auto-approve pass runs after plan-stage exits;
            // the rejection is plan-author-actionable, so the
            // finding is anchored to plan-stage so the console
            // groups it with the plan output rather than orphaning
            // it under a separate "approval" surface.
            stageName: 'plan-stage',
            principalId: plan.principal_id as PrincipalId,
            correlationId,
            now: nowFn() as Time,
            // Major (not critical): envelope mismatch is operator-
            // actionable but not a hard failure of the pipeline run
            // itself. The pipeline still reaches dispatch-stage with
            // dispatched=0; the operator inspects the finding,
            // tightens classification or widens the envelope, and
            // re-intends.
            severity: 'major',
            category: skipReasonToCategory(verdict.reason),
            message: envelopeMismatchMessage(verdict.reason, verdict.details),
            citedAtomIds: [plan.id, verdict.intentId],
            citedPaths: [],
          }),
        );
      }
      continue;
    }

    // Claim-before-mutate: re-read to prevent double-approve under
    // concurrent ticks (a peer single-pass intent tick could approve
    // the same plan in the same moment). The interface lacks true
    // compare-and-swap so the claim is best-effort; file/memory adapters
    // serialize calls in practice. Mirrors intent-approve.ts. The
    // superseded_by check is repeated here because a peer writer can
    // revoke (supersede) the plan between candidate-collection and the
    // claim read; without this guard, an approval could revive a
    // revoked atom by stamping plan_state='approved' over the
    // supersession.
    const latest = await host.atoms.get(plan.id);
    if (
      latest === null
      || latest.plan_state !== 'proposed'
      || latest.taint !== 'clean'
      || latest.superseded_by.length > 0
    ) {
      notEligible++;
      continue;
    }

    const nowIso = nowFn();
    await host.atoms.update(plan.id, {
      plan_state: 'approved',
      metadata: {
        approved_via: verdict.policyAtomId,
        approved_at: nowIso,
        approved_intent_id: String(verdict.intentId),
      },
    });
    approved++;
    await host.auditor.log({
      kind: 'plan.approved-by-intent',
      principal_id: plan.principal_id as PrincipalId,
      timestamp: nowIso as Time,
      refs: { atom_ids: [plan.id, verdict.intentId] },
      details: {
        plan_id: String(plan.id),
        intent_id: String(verdict.intentId),
        policy_atom_id: verdict.policyAtomId,
        source: 'planning-pipeline',
      },
    });
  }

  return {
    considered: planAtomIds.length,
    approved,
    skipped,
    rejected,
    notEligible,
  };
}

// ---------------------------------------------------------------------------
// Policy readers (mirror src/runtime/actor-message/intent-approve.ts; kept
// duplicated here rather than exported from intent-approve.ts because the
// intent-approve.ts shapes are file-local and exporting them would widen
// that module's public surface for a single consumer. See the duplication-
// floor canon: the SAME logic is the abstraction trigger; here the readers
// share shape but evolve with their respective consumers and live behind
// a substrate seam that may diverge in future.)
// ---------------------------------------------------------------------------

interface IntentApprovePolicyConfig {
  readonly allowed_sub_actors: ReadonlyArray<string>;
  readonly atomId: string | null;
}

interface IntentCreationPolicyConfig {
  readonly allowed_principal_ids: ReadonlyArray<string>;
}

const POLICY_MAX_SCAN = 5_000;
const POLICY_PAGE_SIZE = 200;

async function readIntentApprovePolicy(host: Host): Promise<IntentApprovePolicyConfig> {
  let totalSeen = 0;
  let cursor: string | undefined;
  do {
    const remaining = POLICY_MAX_SCAN - totalSeen;
    if (remaining <= 0) break;
    const page = await host.atoms.query(
      { type: ['directive'], layer: ['L3'] },
      Math.min(POLICY_PAGE_SIZE, remaining),
      cursor,
    );
    for (const atom of page.atoms) {
      if (atom.taint !== 'clean') continue;
      if (atom.superseded_by.length > 0) continue;
      const policy = (atom.metadata as Record<string, unknown>)?.policy as
        | Record<string, unknown>
        | undefined;
      if (policy?.subject !== 'plan-autonomous-intent-approve') continue;

      const allowedRaw = policy.allowed_sub_actors;
      const allowed = Array.isArray(allowedRaw)
        ? allowedRaw.filter((v): v is string => typeof v === 'string')
        : [];
      return { allowed_sub_actors: allowed, atomId: String(atom.id) };
    }
    totalSeen += page.atoms.length;
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);
  return { allowed_sub_actors: [], atomId: null };
}

async function readIntentCreationPolicy(host: Host): Promise<IntentCreationPolicyConfig> {
  let totalSeen = 0;
  let cursor: string | undefined;
  do {
    const remaining = POLICY_MAX_SCAN - totalSeen;
    if (remaining <= 0) break;
    const page = await host.atoms.query(
      { type: ['directive'], layer: ['L3'] },
      Math.min(POLICY_PAGE_SIZE, remaining),
      cursor,
    );
    for (const atom of page.atoms) {
      if (atom.taint !== 'clean') continue;
      if (atom.superseded_by.length > 0) continue;
      const policy = (atom.metadata as Record<string, unknown>)?.policy as
        | Record<string, unknown>
        | undefined;
      if (policy?.subject !== 'operator-intent-creation') continue;

      const rawIds = policy.allowed_principal_ids;
      const ids = Array.isArray(rawIds)
        ? rawIds.filter((v): v is string => typeof v === 'string')
        : [];
      return { allowed_principal_ids: ids };
    }
    totalSeen += page.atoms.length;
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);
  return { allowed_principal_ids: [] };
}
