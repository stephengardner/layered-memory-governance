/**
 * Interactive-vote primitives for `lag-respond`.
 *
 * The CLI's new `[v]ote` disposition delegates here: `castVoteInteractive`
 * drives the prompt sequence, constructs a `plan-approval-vote` atom
 * via `writePlanApprovalVote`, and returns the vote's disposition so
 * the caller can close the notifier ticket symmetrically.
 *
 * Why a separate module:
 *   - Keeps respond.ts focused on the event-scrolling loop.
 *   - Exposes `castVoteInteractive` to tests without a real TTY: the
 *     function consumes an `AsyncIterableIterator<string>` so a mock
 *     iterator can feed scripted lines in sequence.
 *   - Lets other surfaces (future: a chat-inbox actor) reuse the vote
 *     construction path without re-implementing the atom shape.
 */

import type { Host } from '../interface.js';
import type { AtomId, PrincipalId, Scope, Time } from '../types.js';
import { writePlanApprovalVote } from '../runtime/actor-message/plan-approval-vote-writer.js';

export interface CastVoteContext {
  readonly planId: AtomId;
  readonly voterId: PrincipalId;
  readonly scope: Scope;
  readonly nowIso: Time;
}

export interface CastVoteResult {
  readonly disposition: 'approve' | 'reject';
  readonly voteAtomId: AtomId;
}

/**
 * Returns the first atom id from `atomRefs` whose type in the store
 * is `'plan'`. Null if no atom_ref points at an extant plan atom.
 * Used by the CLI to decide whether `[v]ote` is a valid choice for
 * the current entry: if the event refers to no plan, the vote path
 * is gated off.
 */
export async function resolvePlanIdFromAtomRefs(
  host: Host,
  atomRefs: ReadonlyArray<AtomId>,
): Promise<AtomId | null> {
  for (const ref of atomRefs) {
    const atom = await host.atoms.get(ref);
    if (atom === null) continue;
    if (atom.type === 'plan') return atom.id;
  }
  return null;
}

async function readLine(
  iter: AsyncIterableIterator<string>,
  prompt: string,
): Promise<string | null> {
  process.stdout.write(prompt);
  const next = await iter.next();
  if (next.done) return null;
  return next.value;
}

const MIN_RATIONALE_LENGTH = 10;

/**
 * Drive the vote prompt sequence, write the vote atom, return the
 * disposition. Returns null on any bail-out path (user cancelled, bad
 * input, short rationale, out-of-range confidence, stdin closed).
 *
 * The sequence:
 *   1. `[a]pprove / [r]eject / [c]ancel`
 *   2. Rationale (>= MIN_RATIONALE_LENGTH chars)
 *   3. Role (optional; blank = none)
 *   4. Confidence (optional; blank = 0.9; else number in (0, 1])
 *
 * On any invalid input the function returns null without writing
 * anything. The caller (respond.ts main loop) treats that as "skip
 * this vote, leave the notifier pending" so the operator can retry.
 */
export async function castVoteInteractive(
  host: Host,
  iter: AsyncIterableIterator<string>,
  ctx: CastVoteContext,
): Promise<CastVoteResult | null> {
  const voteInput = await readLine(iter, 'Vote [a]pprove / [r]eject / [c]ancel: ');
  if (voteInput === null) return null;
  const voteChar = voteInput.trim().toLowerCase().charAt(0);
  let vote: 'approve' | 'reject';
  if (voteChar === 'a') vote = 'approve';
  else if (voteChar === 'r') vote = 'reject';
  else {
    // 'c', anything else, empty: bail silently.
    if (voteChar === 'c') {
      console.log('Vote cancelled.');
    } else if (voteChar.length > 0) {
      console.log(`Unrecognized vote "${voteInput}". Cancelled.`);
    }
    return null;
  }

  const rationaleInput = await readLine(iter, `Rationale (>= ${MIN_RATIONALE_LENGTH} chars): `);
  if (rationaleInput === null) return null;
  const rationale = rationaleInput.trim();
  if (rationale.length < MIN_RATIONALE_LENGTH) {
    console.log(
      `Rationale must be >= ${MIN_RATIONALE_LENGTH} characters (got ${rationale.length}). Vote not cast.`,
    );
    return null;
  }

  const roleInput = await readLine(iter, 'Role (optional, blank = none): ');
  if (roleInput === null) return null;
  const role = roleInput.trim();

  const confidenceInput = await readLine(iter, 'Confidence (0, 1] (blank = 0.9): ');
  if (confidenceInput === null) return null;
  let confidence = 0.9;
  const confidenceStr = confidenceInput.trim();
  if (confidenceStr.length > 0) {
    const parsed = Number(confidenceStr);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
      console.log(`Confidence must be a number in (0, 1] (got "${confidenceStr}"). Vote not cast.`);
      return null;
    }
    confidence = parsed;
  }

  try {
    const baseInput = {
      planId: ctx.planId,
      voterId: ctx.voterId,
      vote,
      rationale,
      confidence,
      scope: ctx.scope,
      nowIso: ctx.nowIso,
      tool: 'lag-respond',
    };
    const voteAtomId = role.length > 0
      ? await writePlanApprovalVote(host, { ...baseInput, role })
      : await writePlanApprovalVote(host, baseInput);
    return { disposition: vote, voteAtomId };
  } catch (err) {
    console.error(
      `Failed to write vote atom: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
