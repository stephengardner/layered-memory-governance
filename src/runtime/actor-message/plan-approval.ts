/**
 * Multi-reviewer plan approval pass.
 *
 * Parallel to auto-approve.ts but widens the approval path: a plan
 * transitions from 'proposed' to 'approved' when a policy-defined
 * number of distinct principals have written fresh
 * `plan-approval-vote` atoms above a confidence floor, with optional
 * role-based quorum and a single-reject hard-block.
 *
 * Scope:
 *   - This pass handles the multi-reviewer authority grant: "N
 *     distinct principals signed off, so the plan can execute".
 *   - It does NOT handle epistemic consensus (that's PromotionEngine)
 *     and does NOT handle the single-principal low-stakes allowlist
 *     (that's runAutoApprovePass in auto-approve.ts). A deployment
 *     composes these; the passes are independent and order-agnostic.
 *   - Fail-closed at every branch: missing/tainted/superseded policy,
 *     empty allowlist, target not in allowlist, plan below the
 *     confidence floor, plan tainted, plan already approved, or a
 *     single fresh reject vote all produce zero transitions on the
 *     approve path.
 *
 * Guards (applied in-code, not just via AtomFilter predicates):
 *   - Plan: taint === 'clean' && superseded_by.length === 0.
 *   - Vote: taint === 'clean' && superseded_by.length === 0 AND
 *     voted_at within max_age_ms of `now`.
 *
 * Every transition logs via host.auditor; compromised principals have
 * their votes invalidated transitively via the existing taint cascade
 * without any change here.
 */

import type { Host } from '../../interface.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../types.js';

/**
 * Multi-reviewer auto-approval policy config, read from a directive
 * atom with metadata.policy.subject === 'plan-multi-reviewer-approval'.
 */
export interface PlanApprovalPolicyConfig {
  /**
   * Sub-actor principal ids whose plans may transition via this pass.
   * Empty (default) means the pass is off: nothing approves.
   */
  readonly allowed_sub_actors: ReadonlyArray<string>;
  /** Distinct-principal approve votes required to trigger transition. */
  readonly min_votes: number;
  /** Per-vote confidence floor; votes below this don't count. */
  readonly min_vote_confidence: number;
  /** Plan's own confidence floor (set by the planning actor). */
  readonly min_plan_confidence: number;
  /**
   * Optional role whitelist. When non-empty, each listed role must
   * have at least one fresh approve vote from a principal whose vote
   * metadata carries that role. Empty means no role constraint.
   */
  readonly required_roles: ReadonlyArray<string>;
  /** One fresh reject vote abandons the plan when true. */
  readonly hard_reject_on_any_reject: boolean;
  /** Votes older than this (ms) don't count toward threshold. */
  readonly max_age_ms: number;
}

/**
 * Fail-closed default: empty allowlist so the pass is off by default.
 * Operator widens via pol-plan-multi-reviewer-approval in canon.
 */
export const FALLBACK_PLAN_APPROVAL: PlanApprovalPolicyConfig = Object.freeze({
  allowed_sub_actors: [],
  min_votes: 2,
  min_vote_confidence: 0.8,
  min_plan_confidence: 0.85,
  required_roles: [],
  hard_reject_on_any_reject: true,
  max_age_ms: 86_400_000, // 24 hours
});

export interface PlanApprovalTickResult {
  /**
   * Plans inspected by the pass (pre-filter). Useful for tuning
   * `maxScan`: if this is consistently at the cap, the operator is
   * scanning more plans than a single tick can fit and should either
   * raise the cap or widen the `allowed_sub_actors` exclusion.
   */
  readonly scanned: number;
  /**
   * Plans that passed every plan-level guard (taint, superseded,
   * plan_state='proposed', confidence floor, planning_actor_version,
   * delegation target in allowlist) and became vote-count candidates.
   * The delta between `scanned` and `eligible` surfaces how much of
   * the scan surface is getting dropped by policy filters vs. hitting
   * real candidates.
   */
  readonly eligible: number;
  /** Plans transitioned to 'approved'. */
  readonly approved: number;
  /** Plans transitioned to 'abandoned' via hard reject. */
  readonly rejected: number;
  /** Approve votes dropped as stale (exceeded max_age_ms). */
  readonly stale: number;
}

export interface PlanApprovalTickOptions {
  /** Clock for freshness + audit timestamps. Defaults to Date.now(). */
  readonly now?: () => string | Time | number;
  /** Upper bound on plans scanned per tick; defaults to 5000. */
  readonly maxScan?: number;
}

/**
 * One sweep over proposed plans. Each passing plan transitions via
 * host.atoms.update; each hard-rejected plan transitions to
 * 'abandoned'. Returns counts for observability. Callers typically
 * wrap this in a loop runner (see scripts/run-approval-cycle.mjs).
 */
export async function runPlanApprovalTick(
  host: Host,
  options: PlanApprovalTickOptions = {},
): Promise<PlanApprovalTickResult> {
  const resolution = await readPlanApprovalPolicy(host);
  const policy = resolution.config;
  // Fail-closed: empty allowlist means the pass does nothing. This
  // mirrors the runAutoApprovePass short-circuit and keeps the pass
  // safe by default even if mis-deployed without a canon seed.
  if (policy.allowed_sub_actors.length === 0) {
    return { scanned: 0, eligible: 0, approved: 0, rejected: 0, stale: 0 };
  }

  const nowFn = options.now ?? (() => new Date().toISOString());
  const nowIso = toIso(nowFn());
  const nowMs = Date.parse(nowIso);
  const freshnessCutoffMs = nowMs - policy.max_age_ms;

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
      // Plan-level in-code guards. Query predicates are advisory;
      // these are the invariants consumers rely on.
      if (atom.taint !== 'clean') continue;
      if (atom.superseded_by.length > 0) continue;
      if (atom.plan_state !== 'proposed') continue;
      if (atom.confidence < policy.min_plan_confidence) continue;
      const version = (atom.metadata as Record<string, unknown>)?.planning_actor_version;
      if (typeof version !== 'string' || version.length === 0) continue;
      const delegation = (atom.metadata as Record<string, unknown>)?.delegation as
        | Record<string, unknown>
        | undefined;
      if (!delegation) continue;
      const targetRaw = delegation.sub_actor_principal_id;
      if (typeof targetRaw !== 'string') continue;
      if (!policy.allowed_sub_actors.includes(targetRaw)) continue;
      candidates.push(atom);
    }
    totalSeen += page.atoms.length;
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);

  let approved = 0;
  let rejected = 0;
  let stale = 0;
  for (const plan of candidates) {
    const votes = await queryVotesForPlan(host, plan.id);
    const voteOutcome = evaluateVotes(votes, policy, freshnessCutoffMs);
    stale += voteOutcome.staleCount;

    if (voteOutcome.rejector !== null) {
      // Hard reject path. Re-read before mutate to match the
      // claim-before-mutate discipline used by runDispatchTick /
      // runAutoApprovePass. A concurrent path may have moved the
      // plan already.
      const latest = await host.atoms.get(plan.id);
      if (latest === null) continue;
      if (latest.plan_state !== 'proposed') continue;
      if (latest.taint !== 'clean') continue;
      if (latest.superseded_by.length > 0) continue;

      await host.atoms.update(plan.id, {
        plan_state: 'abandoned',
        metadata: {
          abandoned_reason: `hard-reject-by-${voteOutcome.rejector}`,
          abandoned_at: nowIso,
          abandoned_via: String(resolution.atomId),
        },
      });
      await host.auditor.log({
        kind: 'plan.abandoned-by-reject',
        principal_id: voteOutcome.rejector as PrincipalId,
        timestamp: nowIso as Time,
        refs: { atom_ids: [plan.id] },
        details: {
          plan_id: String(plan.id),
          policy_atom_id: String(resolution.atomId),
        },
      });
      rejected += 1;
      continue;
    }

    if (!voteOutcome.meetsThreshold) continue;

    // Approve path. Same re-read guard.
    const latest = await host.atoms.get(plan.id);
    if (latest === null) continue;
    if (latest.plan_state !== 'proposed') continue;
    if (latest.taint !== 'clean') continue;
    if (latest.superseded_by.length > 0) continue;

    await host.atoms.update(plan.id, {
      plan_state: 'approved',
      metadata: {
        multi_reviewer_approved: {
          at: nowIso,
          via: String(resolution.atomId),
          voters: voteOutcome.voters,
        },
      },
    });
    await host.auditor.log({
      kind: 'plan.approved-by-consensus',
      principal_id: plan.principal_id,
      timestamp: nowIso as Time,
      refs: { atom_ids: [plan.id, ...voteOutcome.voteAtomIds] },
      details: {
        plan_id: String(plan.id),
        policy_atom_id: String(resolution.atomId),
        voter_count: voteOutcome.voters.length,
      },
    });
    approved += 1;
  }

  return { scanned: totalSeen, eligible: candidates.length, approved, rejected, stale };
}

interface VoteEvaluation {
  readonly voters: ReadonlyArray<string>;
  readonly voteAtomIds: ReadonlyArray<AtomId>;
  readonly meetsThreshold: boolean;
  readonly rejector: string | null;
  readonly staleCount: number;
}

/**
 * Pure function: given a vote-atom list and policy, compute whether
 * the plan is approved/rejected/insufficient. Isolates decision logic
 * from the host-I/O-heavy caller; exported via the module seam for
 * direct unit coverage if future tests need finer branch assertions.
 */
function evaluateVotes(
  votes: ReadonlyArray<Atom>,
  policy: PlanApprovalPolicyConfig,
  freshnessCutoffMs: number,
): VoteEvaluation {
  let staleCount = 0;
  let rejector: string | null = null;
  const approvers = new Map<string, { atomId: AtomId; role: string | undefined }>();
  for (const v of votes) {
    // In-code guards: adapter query predicates don't guarantee these.
    if (v.taint !== 'clean') continue;
    if (v.superseded_by.length > 0) continue;
    const meta = v.metadata as Record<string, unknown>;
    const vote = meta['vote'];
    const votedAtRaw = meta['voted_at'];
    const role = typeof meta['role'] === 'string' ? (meta['role'] as string) : undefined;
    if (typeof vote !== 'string') continue;
    const votedIso = typeof votedAtRaw === 'string' ? votedAtRaw : v.created_at;
    const votedAtMs = Date.parse(votedIso);
    if (!Number.isFinite(votedAtMs)) continue;
    if (votedAtMs < freshnessCutoffMs) {
      staleCount += 1;
      continue;
    }
    if (vote === 'reject') {
      // Rejects bypass the confidence filter: any fresh reject counts.
      // Policy's hard_reject_on_any_reject gates whether the caller
      // acts on it; the evaluator just surfaces the rejector's id.
      if (policy.hard_reject_on_any_reject && rejector === null) {
        rejector = String(v.principal_id);
      }
      continue;
    }
    if (vote !== 'approve') continue;
    if (v.confidence < policy.min_vote_confidence) continue;
    const voter = String(v.principal_id);
    // First approve per principal wins; later approves are no-ops.
    if (!approvers.has(voter)) {
      approvers.set(voter, { atomId: v.id, role });
    }
  }

  const voters = [...approvers.keys()];
  const voteAtomIds = [...approvers.values()].map((a) => a.atomId);

  if (rejector !== null) {
    return { voters, voteAtomIds, meetsThreshold: false, rejector, staleCount };
  }

  if (voters.length < policy.min_votes) {
    return { voters, voteAtomIds, meetsThreshold: false, rejector: null, staleCount };
  }

  if (policy.required_roles.length > 0) {
    const rolesPresent = new Set(
      [...approvers.values()]
        .map((a) => a.role)
        .filter((r): r is string => typeof r === 'string' && r.length > 0),
    );
    for (const required of policy.required_roles) {
      if (!rolesPresent.has(required)) {
        return { voters, voteAtomIds, meetsThreshold: false, rejector: null, staleCount };
      }
    }
  }

  return { voters, voteAtomIds, meetsThreshold: true, rejector: null, staleCount };
}

async function queryVotesForPlan(host: Host, planId: AtomId): Promise<ReadonlyArray<Atom>> {
  // AtomFilter does not have a derived_from predicate today, so query
  // by type narrow and filter by provenance.derived_from in-code. This
  // is the pattern the promotion + arbitration layers already use for
  // the same reason; adding a derived_from predicate to AtomFilter is
  // a separate substrate change.
  const MAX_VOTES = 10_000;
  const PAGE_SIZE = 500;
  const collected: Atom[] = [];
  let cursor: string | undefined;
  do {
    const remaining = MAX_VOTES - collected.length;
    if (remaining <= 0) break;
    const page = await host.atoms.query(
      { type: ['plan-approval-vote'] },
      Math.min(PAGE_SIZE, remaining),
      cursor,
    );
    for (const v of page.atoms) {
      if (!v.provenance.derived_from.includes(planId)) continue;
      collected.push(v);
    }
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);
  return collected;
}

interface PolicyResolution {
  readonly config: PlanApprovalPolicyConfig;
  readonly atomId: string | null;
}

async function readPlanApprovalPolicy(host: Host): Promise<PolicyResolution> {
  const MAX_DIRECTIVE_SCAN = 5_000;
  const PAGE_SIZE = 200;
  let totalSeen = 0;
  let cursor: string | undefined;
  do {
    const remaining = MAX_DIRECTIVE_SCAN - totalSeen;
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
      if (policy?.subject !== 'plan-multi-reviewer-approval') continue;

      const allowedRaw = policy.allowed_sub_actors;
      const allowed = Array.isArray(allowedRaw)
        ? allowedRaw.filter((v): v is string => typeof v === 'string')
        : [];
      const required = Array.isArray(policy.required_roles)
        ? policy.required_roles.filter((v): v is string => typeof v === 'string')
        : [];

      return {
        config: {
          allowed_sub_actors: allowed,
          min_votes: normalizeNonNegInt(policy.min_votes, FALLBACK_PLAN_APPROVAL.min_votes),
          min_vote_confidence: normalizeUnit(
            policy.min_vote_confidence,
            FALLBACK_PLAN_APPROVAL.min_vote_confidence,
          ),
          min_plan_confidence: normalizeUnit(
            policy.min_plan_confidence,
            FALLBACK_PLAN_APPROVAL.min_plan_confidence,
          ),
          required_roles: required,
          hard_reject_on_any_reject:
            typeof policy.hard_reject_on_any_reject === 'boolean'
              ? policy.hard_reject_on_any_reject
              : FALLBACK_PLAN_APPROVAL.hard_reject_on_any_reject,
          max_age_ms: normalizeNonNegInt(policy.max_age_ms, FALLBACK_PLAN_APPROVAL.max_age_ms),
        },
        atomId: String(atom.id),
      };
    }
    totalSeen += page.atoms.length;
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);
  return { config: FALLBACK_PLAN_APPROVAL, atomId: null };
}

function normalizeUnit(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return fallback;
  return n;
}

function normalizeNonNegInt(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return fallback;
  return n;
}

function toIso(value: string | Time | number): string {
  if (typeof value === 'string') return value;
  return new Date(value).toISOString();
}
