/**
 * Intent-based auto-approval tick.
 *
 * Scans proposed plan atoms whose provenance.derived_from contains a
 * fresh, clean operator-intent atom. For each such plan, validates the
 * intent's trust envelope against the plan's delegation metadata and,
 * when all checks pass, transitions the plan from 'proposed' to
 * 'approved'.
 *
 * Design contract (see spec section 4):
 * - Kill-switch takes absolute priority: checked at the top before any reads.
 * - pol-plan-autonomous-intent-approve drives the global allowlist.
 *   Empty allowlist -> short-circuit, scanned: 0.
 * - pol-operator-intent-creation drives the principal whitelist.
 * - Envelope checks (confidence, sub-actor, blast-radius) are silent
 *   skips (not rejections) when the plan fails to match.
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
// Result shape
// ---------------------------------------------------------------------------

export interface IntentAutoApproveResult {
  readonly scanned: number;
  readonly approved: number;
  readonly rejected: number;
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
    return { scanned: 0, approved: 0, rejected: 0, stale: 0, halted: true };
  }

  const approvePolicy = await readIntentApprovePolicy(host);
  // Fail-closed short-circuit: empty allowlist means the tick is off.
  if (approvePolicy.allowed_sub_actors.length === 0) {
    return { scanned: 0, approved: 0, rejected: 0, stale: 0 };
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

  for (const plan of candidates) {
    // Walk provenance.derived_from for a direct operator-intent citation.
    const intentId = await findIntentInProvenance(host, plan);
    // No intent citation: not eligible for this tick; skip silently.
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
    // Principal not in pol-operator-intent-creation allowlist -> reject.
    if (!creationPolicy.allowed_principal_ids.includes(String(intent.principal_id))) {
      rejected++;
      continue;
    }

    // Envelope checks: confidence, sub-actor, blast-radius.
    // These are silent skips (no rejection count) per spec.
    const envelope = (intent.metadata as Record<string, unknown>)?.trust_envelope as
      | Record<string, unknown>
      | undefined;
    if (!envelope) continue;

    const minPlanConf = typeof envelope.min_plan_confidence === 'number'
      ? envelope.min_plan_confidence
      : 0.75;
    if (plan.confidence < minPlanConf) continue;

    const delegation = (plan.metadata as Record<string, unknown>)?.delegation as
      | Record<string, unknown>
      | undefined;
    if (!delegation) continue;

    const subActor = typeof delegation.sub_actor_principal_id === 'string'
      ? delegation.sub_actor_principal_id
      : '';
    const envAllowedSubActors = Array.isArray(envelope.allowed_sub_actors)
      ? (envelope.allowed_sub_actors as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];
    if (!envAllowedSubActors.includes(subActor)) continue;

    const planRadius = delegation.implied_blast_radius;
    const envelopeMax = envelope.max_blast_radius;
    if (typeof planRadius !== 'string' || !(planRadius in RADIUS_RANK)) continue;
    if (typeof envelopeMax !== 'string' || !(envelopeMax in RADIUS_RANK)) continue;
    if (RADIUS_RANK[planRadius as BlastRadius] > RADIUS_RANK[envelopeMax as BlastRadius]) continue;

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

  return { scanned: candidates.length, approved, rejected, stale: 0 };
}
