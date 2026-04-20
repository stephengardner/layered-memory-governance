/**
 * Auto-approve low-stakes proposed plans.
 *
 * Scans `plan` atoms in state `proposed` and transitions qualifying
 * ones to `approved` in-place, so the plan-dispatch loop (PR E) can
 * pick them up. The qualifying filter is read from a policy atom
 * (pol-plan-auto-approve-low-stakes) so tuning is a canon edit,
 * never a framework release.
 *
 * Default qualification rules:
 * - Plan's metadata.planning_actor_version is present (sanity: only
 *   plans produced by a recognized planner are auto-approved).
 * - Plan's metadata.delegation.sub_actor_principal_id is in the
 *   allowlist (default: ['auditor-actor']; read-only actors only).
 * - Plan's confidence >= min_confidence (default 0.55).
 * - Plan is not tainted, not superseded.
 *
 * Fails closed: if the policy atom is missing, tainted, or
 * superseded, NO auto-approvals happen. Everything stays in
 * 'proposed' awaiting manual operator approval. Same discipline as
 * the other policy reads in this module.
 */

import type { Host } from '../interface.js';
import type { Atom, Time } from '../types.js';

export interface AutoApprovePolicyConfig {
  /**
   * Sub-actor principal ids allowed to auto-approve when the plan's
   * delegation targets them. The v0 default is 'auditor-actor' only
   * (read-only, no mutation). Other read-only actors can be added
   * via canon edit.
   */
  readonly allowed_sub_actors: ReadonlyArray<string>;
  /** Minimum plan confidence for auto-approval. */
  readonly min_confidence: number;
}

/**
 * Fail-closed default: empty allowlist + high confidence threshold.
 * Deployments that do not seed pol-plan-auto-approve-low-stakes get
 * zero auto-approvals by default; every plan waits for manual
 * operator approval.
 */
export const FALLBACK_AUTO_APPROVE: AutoApprovePolicyConfig = Object.freeze({
  allowed_sub_actors: [],
  min_confidence: 0.55,
});

export interface AutoApproveTickResult {
  readonly scanned: number;
  readonly approved: number;
}

/**
 * One sweep over proposed plans. Each plan that passes the filter
 * is transitioned to 'approved'. Returns counts for observability.
 *
 * Not idempotent on a per-plan basis (a plan already 'approved'
 * doesn't re-approve), but idempotent on re-run (the filter drops
 * non-proposed plans).
 */
export async function runAutoApprovePass(
  host: Host,
  options: { readonly now?: () => number } = {},
): Promise<AutoApproveTickResult> {
  const resolution = await readAutoApprovePolicy(host);
  const policy = resolution.config;
  // Fail-closed short-circuit: if no sub-actors are allowed, no plan
  // can qualify. Skip the scan.
  if (policy.allowed_sub_actors.length === 0) {
    return { scanned: 0, approved: 0 };
  }

  const now = options.now ?? (() => Date.now());
  // Paginate: a first-page-only scan could starve eligible plans on
  // later pages if an adapter orders them deterministically. Walk to
  // exhaustion with a hard cap to bound the worst case.
  const MAX_PLAN_SCAN = 5_000;
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
      if (atom.taint !== 'clean') continue;
      if (atom.superseded_by.length > 0) continue;
      if (atom.plan_state !== 'proposed') continue;
      if (atom.confidence < policy.min_confidence) continue;
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
  for (const plan of candidates) {
    // Re-read before approving. A concurrent path may have moved the
    // plan out of 'proposed' (operator rejected, revocation, another
    // auto-approve pass already ran). Without this check the update
    // below would force an 'approved' state back onto a plan that
    // was deliberately moved away. Same claim-before-mutate pattern
    // as runDispatchTick.
    const latest = await host.atoms.get(plan.id);
    if (latest === null) continue;
    if (latest.plan_state !== 'proposed') continue;
    if (latest.taint !== 'clean') continue;
    if (latest.superseded_by.length > 0) continue;

    await host.atoms.update(plan.id, {
      plan_state: 'approved',
      metadata: {
        auto_approved: {
          at: new Date(now()).toISOString() as Time,
          // The matched policy atom id, not a hardcoded string. A
          // deployment that supersedes pol-plan-auto-approve-low-
          // stakes with a different id (pol-plan-auto-approve-v2,
          // etc.) will have the ACTUAL governing atom's id stamped
          // on each auto-approval - a real audit trail.
          via: String(resolution.atomId),
        },
      },
    });
    approved += 1;
  }

  return { scanned: candidates.length, approved };
}

interface PolicyResolution {
  readonly config: AutoApprovePolicyConfig;
  /** Id of the atom the config came from, or null when falling back. */
  readonly atomId: string | null;
}

async function readAutoApprovePolicy(host: Host): Promise<PolicyResolution> {
  // Paginate the directive scan too: a first-page-only read could
  // silently fall back to the deny-default if the governing atom
  // happens to land on page 2. Fail-closed fallback only after
  // every page has been considered.
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
      if (policy?.subject !== 'plan-auto-approve-low-stakes') continue;

      const allowedRaw = policy.allowed_sub_actors;
      const minConfRaw = Number(policy.min_confidence);
      const allowed = Array.isArray(allowedRaw)
        ? allowedRaw.filter((v): v is string => typeof v === 'string')
        : [];
      const minConfidence = Number.isFinite(minConfRaw) && minConfRaw >= 0 && minConfRaw <= 1
        ? minConfRaw
        : FALLBACK_AUTO_APPROVE.min_confidence;

      return {
        config: {
          allowed_sub_actors: allowed,
          min_confidence: minConfidence,
        },
        atomId: String(atom.id),
      };
    }
    totalSeen += page.atoms.length;
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);
  return { config: FALLBACK_AUTO_APPROVE, atomId: null };
}
