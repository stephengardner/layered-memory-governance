/**
 * Writer-side primitive for multi-reviewer plan approval.
 *
 * `runPlanApprovalTick` is the reader: it counts `plan-approval-vote`
 * atoms, applies policy, and transitions Plan state. This module is
 * the writer: it builds and persists a single reviewer's vote. The
 * read and write sides live in separate files because they have very
 * different callers (tick runners vs. interactive CLIs / inbox actors)
 * and keeping them split avoids forcing the CLI to pull in the whole
 * policy-reader dependency graph.
 *
 * Shape contract (must stay in sync with runPlanApprovalTick):
 *   - type: 'plan-approval-vote'
 *   - layer: 'L1' (a vote is a process signal; promoted never)
 *   - provenance.derived_from: [planId] (the query seam
 *     `queryVotesForPlan` filters on this)
 *   - metadata.vote: 'approve' | 'reject'
 *   - metadata.voted_at: ISO timestamp (freshness check uses this
 *     when present; created_at otherwise)
 *   - metadata.role?: optional free-string role for role-quorum
 *     policies (required_roles)
 *   - metadata.rationale: required >= 10 chars, surfaced in audit
 *
 * Deterministic id: `sha256(planId|voterId|vote|nowIso)` truncated so
 * re-issuing an identical vote in the same ISO ms is a no-op rather
 * than writing a duplicate. A reviewer changing their mind between
 * timestamps creates a new atom (the later atom wins semantically
 * because `evaluateVotes` takes first-approve-per-principal but a
 * fresh reject from the same principal still hard-rejects).
 */

import { createHash } from 'node:crypto';

import type { Host } from '../../interface.js';
import type {
  Atom,
  AtomId,
  PrincipalId,
  Scope,
  Time,
} from '../../types.js';
import { ConflictError } from '../../substrate/errors.js';

/** A single reviewer's vote on one plan. */
export interface PlanApprovalVoteInput {
  readonly planId: AtomId;
  readonly voterId: PrincipalId;
  readonly vote: 'approve' | 'reject';
  /** Why the reviewer voted this way. Required, >= 10 chars. */
  readonly rationale: string;
  /**
   * Optional reviewer role. Matched case-sensitively against
   * `required_roles` on `pol-plan-multi-reviewer-approval`. Leave
   * undefined when the role-quorum feature is not in use.
   */
  readonly role?: string;
  /** Voter confidence, [0, 1]. The policy config has a floor. */
  readonly confidence: number;
  /** Scope the vote is authoritative within. */
  readonly scope: Scope;
  /**
   * Timestamp this vote was cast. Also used for freshness (reader
   * compares against policy.max_age_ms) and for the deterministic id.
   */
  readonly nowIso: Time;
}

const MIN_RATIONALE_LENGTH = 10;

/**
 * Pure atom builder. No I/O. Callers should prefer `writePlanApprovalVote`
 * which also persists; this exists for tests and advanced callers that
 * want to mutate the atom before writing.
 */
export function buildPlanApprovalVoteAtom(input: PlanApprovalVoteInput): Atom {
  const rationale = input.rationale.trim();
  if (rationale.length < MIN_RATIONALE_LENGTH) {
    throw new Error(
      `plan-approval-vote rationale must be >= ${MIN_RATIONALE_LENGTH} characters (got ${rationale.length})`,
    );
  }
  const id = makeVoteId(input.planId, input.voterId, input.vote, input.nowIso);

  const metadata: Record<string, unknown> = {
    vote: input.vote,
    voted_at: String(input.nowIso),
    rationale,
    plan_id: String(input.planId),
  };
  if (typeof input.role === 'string' && input.role.length > 0) {
    metadata['role'] = input.role;
  }

  return {
    schema_version: 1,
    id,
    content: `${input.voterId} voted ${input.vote} on ${input.planId}: ${rationale}`,
    type: 'plan-approval-vote',
    layer: 'L1',
    provenance: {
      kind: 'user-directive',
      source: { agent_id: String(input.voterId), tool: 'lag-respond' },
      derived_from: [input.planId],
    },
    confidence: input.confidence,
    created_at: input.nowIso,
    last_reinforced_at: input.nowIso,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: input.scope,
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: input.voterId,
    taint: 'clean',
    metadata,
  };
}

/**
 * Build + persist the vote atom. Returns the atom id.
 *
 * Idempotency: the deterministic id means `writePlanApprovalVote`
 * called twice with identical inputs is a no-op on the second call
 * (the store returns ConflictError, which we swallow and return the
 * same id). A vote that differs on any id-contributing field (vote,
 * voter, plan, timestamp) creates a new atom.
 */
export async function writePlanApprovalVote(
  host: Host,
  input: PlanApprovalVoteInput,
): Promise<AtomId> {
  const atom = buildPlanApprovalVoteAtom(input);
  try {
    await host.atoms.put(atom);
  } catch (err) {
    if (!(err instanceof ConflictError)) throw err;
    // Swallow duplicate-id: same vote already exists. The id is still
    // the right return value; the caller can proceed as if it wrote.
  }
  return atom.id;
}

function makeVoteId(
  planId: AtomId,
  voterId: PrincipalId,
  vote: string,
  nowIso: Time,
): AtomId {
  const digest = createHash('sha256')
    .update(String(planId))
    .update('|')
    .update(String(voterId))
    .update('|')
    .update(vote)
    .update('|')
    .update(String(nowIso))
    .digest('hex')
    .slice(0, 16);
  return `plan-approval-vote-${digest}` as AtomId;
}
