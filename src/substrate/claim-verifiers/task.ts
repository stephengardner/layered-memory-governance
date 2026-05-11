/**
 * Task terminal-state verifier.
 *
 * Queries the substrate's task surface as the authoritative source of
 * truth for whether a work-claim against a task has reached one of its
 * declared terminal states (typically `completed`). Substrate must NOT
 * trust a sub-agent's attestation that "I completed task #999"; the
 * agent could be lying, broken, or compromised. The verifier resolves
 * the question against the task surface itself so a falsified
 * attestation cannot flip a claim to `complete`.
 *
 * Host seam posture: the implementation plan calls for a
 * `host.taskList.get(id)` lookup against a dedicated TaskList Host
 * sub-interface. As of the PR1 substrate landing, no `TaskList` field
 * is declared on the Host bundle (see `src/substrate/interface.ts`
 * `interface Host`). Per the plan's risk register, the fallback is the
 * existing AtomStore: tasks land as atoms at id `task-<identifier>`
 * with `metadata.task.status` carrying the lifecycle field. This
 * keeps the verifier substrate-agnostic and unblocks the work-claim
 * core without forcing a parallel Host-interface change. When a
 * dedicated TaskList seam ships, this module gains a thin preference
 * for `host.taskList?.get(...)` before falling through to the atom
 * lookup; the change is additive and does not break existing callers.
 *
 * The handler is shape-compatible with `ClaimVerifier` from `./types.ts`.
 */

import type { Atom, AtomId } from '../types.js';
import type { VerifierContext, VerifierResult } from './types.js';

/**
 * Atom id prefix for task atoms. Centralised so a future rename
 * (e.g. `tsk-` if a substrate-deep id scheme lands) touches one
 * location.
 */
const TASK_ATOM_PREFIX = 'task-';

/**
 * Sentinel returned when the task does not exist or its status field
 * cannot be located. Mirrors the PR verifier's NOT_FOUND outcome so
 * the caller's `markClaimComplete` flow handles the two surfaces
 * symmetrically.
 */
const NOT_FOUND = 'NOT_FOUND';

/**
 * Narrow type for the `metadata.task` shape we read. Tasks store
 * lifecycle state in `metadata.task.status` per the substrate's
 * task-atom convention. The verifier is permissive about shape
 * (anything that has a string-typed `status` is accepted) so a
 * deployment with extra task fields stays compatible without code
 * changes here.
 */
interface TaskMetadataShape {
  readonly status?: unknown;
}

/**
 * Extract the lifecycle status from an atom's metadata. Returns null
 * when the metadata does not carry a string-typed `task.status` --
 * either the atom is not actually a task, or its shape predates the
 * status convention. Either way, the caller treats null as NOT_FOUND.
 */
function readTaskStatus(atom: Atom): string | null {
  const taskMeta = (atom.metadata as { task?: TaskMetadataShape } | undefined)?.task;
  if (taskMeta === undefined || taskMeta === null) {
    return null;
  }
  const status = taskMeta.status;
  if (typeof status !== 'string' || status.length === 0) {
    return null;
  }
  return status;
}

/**
 * Query the substrate task surface for a task's lifecycle state and
 * report whether it matches one of the expected terminal states.
 *
 * Return semantics:
 *   - `{ ok: true, observed_state }`  -- task surface returned a status
 *     that matches one of `expectedStates`. Case-sensitive comparison
 *     (mirrors `verifyPrTerminal`): substrate vocabulary is typically
 *     lowercase for task states (`completed`, `cancelled`); a caller
 *     that passes a mismatched case gets a loud mismatch rather than
 *     a silent coercion.
 *   - `{ ok: false, observed_state }` -- task surface returned a status
 *     that does NOT match any expected state. The caller's
 *     `markClaimComplete` treats this as the sub-agent attesting a
 *     premature terminal state.
 *   - `{ ok: false, observed_state: 'NOT_FOUND' }` -- task surface
 *     reports the task does not exist, OR the atom is present but
 *     lacks `metadata.task.status`. Either way the claim cannot
 *     complete; the substrate refuses to ratify a claim against a
 *     missing/malformed task.
 *
 * Throws on AtomStore read errors. The caller's
 * `markClaimComplete` maps throw to `verifier-error` so the claim
 * stays pending and an operator-escalation surfaces; this matches
 * `verifyPrTerminal`'s posture for 5xx / network failures.
 *
 * The handler is intentionally narrow: one lookup, one comparison,
 * no retries. Retries belong to the caller (the work-claim reaper)
 * so the retry budget composes with the per-claim staleness window
 * rather than being smeared across every verifier in the substrate.
 */
export async function verifyTaskTerminal(
  identifier: string,
  expectedStates: readonly string[],
  ctx: VerifierContext,
): Promise<VerifierResult> {
  // Atom-id derivation. Centralised in TASK_ATOM_PREFIX so a future
  // id-scheme migration touches one location, not the call sites
  // (mirrors the README convention for plan- / pipeline- / etc.).
  // The cast to AtomId is the standard pattern for the branded id
  // type (see `src/substrate/types.ts` -- "Construct via cast").
  const atomId = `${TASK_ATOM_PREFIX}${identifier}` as AtomId;
  // AtomStore.get throws on storage errors; the verifier propagates
  // the throw so the caller treats this as a verifier-error rather
  // than a silent ok:false (which would imply we observed a
  // non-terminal state -- a load-bearing distinction).
  const atom = await ctx.host.atoms.get(atomId);
  if (atom === null) {
    return { ok: false, observed_state: NOT_FOUND };
  }
  const status = readTaskStatus(atom);
  if (status === null) {
    // Atom exists but lacks the canonical status field. We cannot
    // claim a lifecycle state; surface as NOT_FOUND rather than
    // fabricating a default ("unknown") that a caller might
    // legitimately list as terminal.
    return { ok: false, observed_state: NOT_FOUND };
  }
  // Case-sensitive comparison matches the plan directive
  // ("Compare ... case-sensitive"). A caller that passes
  // mismatched-case `expectedStates` gets a loud mismatch rather
  // than a silent coercion.
  const matches = expectedStates.includes(status);
  return { ok: matches, observed_state: status };
}
