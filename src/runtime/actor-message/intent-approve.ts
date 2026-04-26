/**
 * Intent-based auto-approval tick.
 *
 * Scans proposed plan atoms whose provenance.derived_from contains a
 * fresh, clean operator-intent atom. For each such plan, validates the
 * intent's trust envelope against the plan's delegation metadata and,
 * when all checks pass, transitions the plan from 'proposed' to
 * 'approved'.
 *
 * Behaviour contract:
 * - Kill-switch takes absolute priority: checked at the top before any reads.
 * - The intent-approve policy drives the global sub-actor allowlist;
 *   an empty allowlist short-circuits the tick (scanned: 0).
 * - The intent-creation policy drives the principal whitelist for
 *   intent authorship.
 * - Envelope checks (confidence, sub-actor, blast-radius) are observable
 *   skips (not rejections) when the plan fails to match: each skip
 *   emits a 'plan.skipped-by-intent' audit event with a typed reason
 *   and is counted in the result's `skipped` total + `skippedByReason`
 *   breakdown. No skip-atom is written; the audit log is the single
 *   source of skip evidence so atom-store growth stays bounded.
 * - Principal / taint / expiry failures are counted as rejections.
 * - Claim-before-mutate: each plan is re-read immediately before
 *   host.atoms.update to prevent double-approve under concurrent ticks.
 */

import type { Atom, AtomId, PrincipalId, Time } from '../../types.js';
import type { Host } from '../../interface.js';

// ---------------------------------------------------------------------------
// Blast-radius ordinal map (mechanism, not org shape; matches label semantics)
// ---------------------------------------------------------------------------

export const RADIUS_RANK = {
  none: 0,
  docs: 1,
  tooling: 2,
  framework: 3,
  'l3-canon-proposal': 4,
} as const;

export type BlastRadius = keyof typeof RADIUS_RANK;

export function isBlastRadiusWithin(planRadius: BlastRadius, envelopeMax: BlastRadius): boolean {
  return RADIUS_RANK[planRadius] <= RADIUS_RANK[envelopeMax];
}

// ---------------------------------------------------------------------------
// findIntentInProvenance: direct-only walk (v1 constraint)
// ---------------------------------------------------------------------------

export async function findIntentInProvenance(host: Host, plan: Atom): Promise<AtomId | null> {
  const derived = plan.provenance?.derived_from ?? [];
  for (const id of derived) {
    const atom = await host.atoms.get(id);
    if (atom?.type === 'operator-intent') return id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Skip-reason taxonomy
// ---------------------------------------------------------------------------

/**
 * Typed reasons a plan can be skipped during the intent-approve tick.
 *
 * Each value names a single envelope-mismatch condition. Skips are
 * observable (one audit event per skip plus a per-tick count) but do
 * not write atoms; the atom store stays bounded under high churn.
 *
 * Note: a plan with no operator-intent in provenance.derived_from is
 * NOT counted as skipped; it is simply not eligible for this tick and
 * is filtered before reason inspection. Counting "no intent citation"
 * as a skip would emit one event per non-intent plan on every tick,
 * which is noise rather than signal.
 */
export const SkipReason = {
  /** Intent has no `trust_envelope` block. Indicates a malformed intent. */
  MISSING_TRUST_ENVELOPE: 'missing_trust_envelope',
  /** Plan confidence is below `envelope.min_plan_confidence`. */
  BELOW_MIN_CONFIDENCE: 'below_min_confidence',
  /** Plan has no `metadata.delegation` block (defensive recheck). */
  NO_DELEGATION: 'no_delegation',
  /** Plan's `delegation.sub_actor_principal_id` not in envelope allowlist. */
  SUB_ACTOR_NOT_ALLOWED: 'sub_actor_not_allowed',
  /** Plan's `delegation.implied_blast_radius` not a known label. */
  RADIUS_UNKNOWN: 'radius_unknown',
  /** Envelope's `max_blast_radius` not a known label. */
  DELEGATION_RADIUS_UNKNOWN: 'delegation_radius_unknown',
  /** Plan radius rank exceeds envelope max-radius rank. */
  DELEGATION_RADIUS_EXCEEDS_ENVELOPE: 'delegation_radius_exceeds_envelope',
} as const;

export type SkipReason = typeof SkipReason[keyof typeof SkipReason];

/** Per-reason skip counts. Every key is always present (zero-initialized). */
export type SkippedByReason = Readonly<Record<SkipReason, number>>;

function emptySkippedByReason(): Record<SkipReason, number> {
  return {
    [SkipReason.MISSING_TRUST_ENVELOPE]: 0,
    [SkipReason.BELOW_MIN_CONFIDENCE]: 0,
    [SkipReason.NO_DELEGATION]: 0,
    [SkipReason.SUB_ACTOR_NOT_ALLOWED]: 0,
    [SkipReason.RADIUS_UNKNOWN]: 0,
    [SkipReason.DELEGATION_RADIUS_UNKNOWN]: 0,
    [SkipReason.DELEGATION_RADIUS_EXCEEDS_ENVELOPE]: 0,
  };
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface IntentAutoApproveResult {
  readonly scanned: number;
  readonly approved: number;
  readonly rejected: number;
  /** Plans that matched an intent but failed an envelope check. */
  readonly skipped: number;
  /** Per-reason breakdown of `skipped`. Sum equals `skipped`. */
  readonly skippedByReason: SkippedByReason;
  readonly stale: number;
  readonly halted?: boolean;
}

export interface IntentAutoApproveOptions {
  /**
   * Injectable clock returning an ISO-8601 string. Defaults to the
   * current wall time. Passed as a named option so tests can pin time
   * without reaching around the host boundary.
   */
  readonly now?: () => string;
  /** Upper bound on plans scanned per tick; defaults to 5000. */
  readonly maxScan?: number;
}

// ---------------------------------------------------------------------------
// Policy resolution shapes
// ---------------------------------------------------------------------------

interface IntentApprovePolicyConfig {
  readonly allowed_sub_actors: ReadonlyArray<string>;
  readonly atomId: string | null;
}

interface IntentCreationPolicyConfig {
  readonly allowed_principal_ids: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Policy readers (mirror the directive-scan pattern in auto-approve.ts)
// ---------------------------------------------------------------------------

async function readIntentApprovePolicy(host: Host): Promise<IntentApprovePolicyConfig> {
  const MAX_SCAN = 5_000;
  const PAGE_SIZE = 200;
  let totalSeen = 0;
  let cursor: string | undefined;
  do {
    const remaining = MAX_SCAN - totalSeen;
    if (remaining <= 0) break;
    const page = await host.atoms.query(
      { type: ['directive'], layer: ['L3'] },
      Math.min(PAGE_SIZE, remaining),
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
  // Fail-closed: no policy found -> empty allowlist
  return { allowed_sub_actors: [], atomId: null };
}

async function readIntentCreationPolicy(host: Host): Promise<IntentCreationPolicyConfig> {
  const MAX_SCAN = 5_000;
  const PAGE_SIZE = 200;
  let totalSeen = 0;
  let cursor: string | undefined;
  do {
    const remaining = MAX_SCAN - totalSeen;
    if (remaining <= 0) break;
    const page = await host.atoms.query(
      { type: ['directive'], layer: ['L3'] },
      Math.min(PAGE_SIZE, remaining),
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
  // Fail-closed: no principal policy -> empty allowlist
  return { allowed_principal_ids: [] };
}

// ---------------------------------------------------------------------------
// Main tick
// ---------------------------------------------------------------------------

/**
 * Tick 0 of the approval cycle: evaluate operator-intent atoms linked
 * from proposed plans and transition qualifying plans to 'approved'.
 *
 * Fail-closed at every branch: kill-switch, empty allowlist, missing
 * policy, tainted/expired/non-whitelisted intent, and envelope
 * mismatches all produce zero approvals.
 */
export async function runIntentAutoApprovePass(
  host: Host,
  options: IntentAutoApproveOptions = {},
): Promise<IntentAutoApproveResult> {
  // Kill-switch absolute priority: check before any reads.
  if (host.scheduler.killswitchCheck()) {
    return {
      scanned: 0,
      approved: 0,
      rejected: 0,
      skipped: 0,
      skippedByReason: emptySkippedByReason(),
      stale: 0,
      halted: true,
    };
  }

  const approvePolicy = await readIntentApprovePolicy(host);
  // Fail-closed short-circuit: empty allowlist means the tick is off.
  if (approvePolicy.allowed_sub_actors.length === 0) {
    return {
      scanned: 0,
      approved: 0,
      rejected: 0,
      skipped: 0,
      skippedByReason: emptySkippedByReason(),
      stale: 0,
    };
  }

  const creationPolicy = await readIntentCreationPolicy(host);

  const nowFn = options.now ?? (() => new Date().toISOString());
  const nowMs = Date.parse(nowFn());

  const MAX_PLAN_SCAN = options.maxScan ?? 5_000;
  const PLAN_PAGE_SIZE = 500;
  let totalSeen = 0;
  const candidates: Atom[] = [];
  let cursor: string | undefined;
  do {
    const remaining = MAX_PLAN_SCAN - totalSeen;
    if (remaining <= 0) break;
    const page = await host.atoms.query(
      { type: ['plan'] },
      Math.min(PLAN_PAGE_SIZE, remaining),
      cursor,
    );
    for (const atom of page.atoms) {
      // Plan-level guards (mirror auto-approve.ts pattern).
      if (atom.taint !== 'clean') continue;
      if (atom.superseded_by.length > 0) continue;
      if (atom.plan_state !== 'proposed') continue;
      // Must have a delegation envelope; without it there is nothing
      // to check blast-radius or sub-actor against.
      const delegation = (atom.metadata as Record<string, unknown>)?.delegation as
        | Record<string, unknown>
        | undefined;
      if (!delegation) continue;
      candidates.push(atom);
    }
    totalSeen += page.atoms.length;
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);

  let approved = 0;
  let rejected = 0;
  let skipped = 0;
  const skippedByReason = emptySkippedByReason();

  /**
   * Record a skip: emit one audit event, increment the per-reason
   * counter, and bump the total. Centralized here so every skip site
   * goes through the same observability path; missing a call is the
   * exact bug class this whole change closes.
   */
  const recordSkip = async (
    plan: Atom,
    intent: Atom,
    reason: SkipReason,
    extra: Readonly<Record<string, unknown>>,
  ): Promise<void> => {
    skippedByReason[reason] += 1;
    skipped += 1;
    await host.auditor.log({
      kind: 'plan.skipped-by-intent',
      principal_id: intent.principal_id as PrincipalId,
      timestamp: nowFn() as Time,
      refs: { atom_ids: [plan.id, intent.id] },
      details: {
        plan_id: String(plan.id),
        intent_id: String(intent.id),
        reason,
        ...extra,
      },
    });
  };

  for (const plan of candidates) {
    // Walk provenance.derived_from for a direct operator-intent citation.
    const intentId = await findIntentInProvenance(host, plan);
    // No intent citation: not eligible for this tick. NOT counted as
    // a skip (it would emit one event per non-intent plan every tick;
    // see SkipReason JSDoc).
    if (!intentId) continue;

    const intent = await host.atoms.get(intentId);
    // Intent atom missing or wrong type -> reject (unexpected).
    if (!intent || intent.type !== 'operator-intent') {
      rejected++;
      continue;
    }
    // Tainted intent -> reject.
    if (intent.taint !== 'clean') {
      rejected++;
      continue;
    }
    // Expired intent -> reject.
    const expiresRaw = (intent.metadata as Record<string, unknown>)?.expires_at;
    if (typeof expiresRaw === 'string' && Date.parse(expiresRaw) < nowMs) {
      rejected++;
      continue;
    }
    // Principal not in operator-intent-creation allowlist -> reject.
    if (!creationPolicy.allowed_principal_ids.includes(String(intent.principal_id))) {
      rejected++;
      continue;
    }

    // Envelope checks: confidence, sub-actor, blast-radius.
    // Each mismatch is observable (audit event + per-reason count)
    // but NOT a rejection: a fresh intent + lower-confidence plan is
    // a normal "not yet" state, not a violation.
    const envelope = (intent.metadata as Record<string, unknown>)?.trust_envelope as
      | Record<string, unknown>
      | undefined;
    if (!envelope) {
      await recordSkip(plan, intent, SkipReason.MISSING_TRUST_ENVELOPE, {});
      continue;
    }

    const minPlanConf = typeof envelope.min_plan_confidence === 'number'
      ? envelope.min_plan_confidence
      : 0.75;
    if (plan.confidence < minPlanConf) {
      await recordSkip(plan, intent, SkipReason.BELOW_MIN_CONFIDENCE, {
        plan_confidence: plan.confidence,
        envelope_min_confidence: minPlanConf,
      });
      continue;
    }

    const delegation = (plan.metadata as Record<string, unknown>)?.delegation as
      | Record<string, unknown>
      | undefined;
    // Defensive recheck: candidate-collection already filtered plans
    // without a delegation block, but a concurrent update could have
    // stripped it between phases. Counted as a skip rather than a
    // silent drop so the operator can observe the race.
    if (!delegation) {
      await recordSkip(plan, intent, SkipReason.NO_DELEGATION, {});
      continue;
    }

    const subActor = typeof delegation.sub_actor_principal_id === 'string'
      ? delegation.sub_actor_principal_id
      : '';
    const envAllowedSubActors = Array.isArray(envelope.allowed_sub_actors)
      ? (envelope.allowed_sub_actors as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];
    if (!envAllowedSubActors.includes(subActor)) {
      await recordSkip(plan, intent, SkipReason.SUB_ACTOR_NOT_ALLOWED, {
        plan_sub_actor: subActor,
        envelope_allowed_sub_actors: envAllowedSubActors,
      });
      continue;
    }

    const planRadius = delegation.implied_blast_radius;
    const envelopeMax = envelope.max_blast_radius;
    // Use Object.hasOwn so prototype-chain keys ('toString', 'valueOf',
    // 'constructor') do not pass the guard. The `in` operator walks the
    // chain and would silently fall through to `undefined > N` (false)
    // at the rank comparison, fail-opening for attacker- or LLM-supplied
    // strings.
    if (typeof planRadius !== 'string' || !Object.hasOwn(RADIUS_RANK, planRadius)) {
      await recordSkip(plan, intent, SkipReason.RADIUS_UNKNOWN, {
        plan_radius: typeof planRadius === 'string' ? planRadius : null,
      });
      continue;
    }
    if (typeof envelopeMax !== 'string' || !Object.hasOwn(RADIUS_RANK, envelopeMax)) {
      await recordSkip(plan, intent, SkipReason.DELEGATION_RADIUS_UNKNOWN, {
        envelope_max_radius: typeof envelopeMax === 'string' ? envelopeMax : null,
      });
      continue;
    }
    if (RADIUS_RANK[planRadius as BlastRadius] > RADIUS_RANK[envelopeMax as BlastRadius]) {
      await recordSkip(plan, intent, SkipReason.DELEGATION_RADIUS_EXCEEDS_ENVELOPE, {
        plan_radius: planRadius,
        envelope_max_radius: envelopeMax,
      });
      continue;
    }

    // Claim-before-mutate: re-read to prevent double-approve under
    // concurrent ticks. If the plan has moved, skip.
    const latest = await host.atoms.get(plan.id);
    if (!latest) continue;
    if (latest.plan_state !== 'proposed') continue;
    if (latest.taint !== 'clean') continue;

    const nowIso = nowFn();
    await host.atoms.update(plan.id as AtomId, {
      plan_state: 'approved',
      metadata: {
        approved_via: String(approvePolicy.atomId ?? 'pol-plan-autonomous-intent-approve'),
        approved_at: nowIso,
        approved_intent_id: String(intent.id),
      },
    });
    await host.auditor.log({
      kind: 'plan.approved-by-intent',
      principal_id: intent.principal_id as PrincipalId,
      timestamp: nowIso as Time,
      refs: { atom_ids: [plan.id, intent.id] },
      details: {
        plan_id: String(plan.id),
        intent_id: String(intent.id),
        policy_atom_id: String(approvePolicy.atomId),
      },
    });
    approved++;
  }

  return {
    scanned: candidates.length,
    approved,
    rejected,
    skipped,
    skippedByReason,
    stale: 0,
  };
}
