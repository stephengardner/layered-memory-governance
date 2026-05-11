/**
 * Plan terminal-state verifier.
 *
 * Queries the AtomStore for the plan atom referenced by a work-claim and
 * reports whether its `plan_state` is in the expected terminal set
 * (typically `succeeded` or `failed`). Plans are an internal substrate
 * concept; unlike PR state (which lives on GitHub) the authoritative
 * source IS the AtomStore. The verifier interface is shared with the
 * external-system verifiers (PR, Task, research-atom) so a single
 * dispatcher can resolve any work-claim verifier by `verifier_kind`.
 *
 * Asymmetry note: the `ClaimVerifier` doc-comment on `./types.ts` says
 * verifier handlers SHOULD query authoritative external state, NOT the
 * substrate's own AtomStore. That guidance applies to external work
 * (PR, Task, research) where a sub-agent might lie about completion.
 * Plans are governance state owned by the substrate itself, so the
 * AtomStore IS the authoritative source; querying it does not weaken
 * the false-attestation defense.
 *
 * The handler is shape-compatible with `ClaimVerifier`. A standard
 * `VerifierContext` is enough; the only host capability needed is the
 * AtomStore, which already lives at `ctx.host.atoms`. We export a
 * `PlanVerifierContext` alias for symmetry with the PR verifier so
 * callers can use a stable type name across all four verifier handlers.
 */

import type { VerifierContext, VerifierResult } from './types.js';

/**
 * Context alias for the plan verifier. No extension fields are needed
 * (the AtomStore is the only dependency, and it already lives on the
 * shared `VerifierContext.host`). The alias exists for code-call-site
 * parity with the other verifier handlers; callers that already have a
 * `VerifierContext` can pass it through unchanged.
 */
export type PlanVerifierContext = VerifierContext;

/**
 * Look up a plan atom and report whether its `plan_state` is in the
 * expected terminal set.
 *
 * Return semantics:
 *   - `{ ok: true, observed_state }` -- the AtomStore returned a plan
 *     whose `plan_state` matches one of `expectedStates`. Case-sensitive
 *     match; the substrate vocabulary for `PlanState` is lowercase (see
 *     `src/substrate/types.ts`), and a caller that passes uppercase or
 *     mixed-case states gets a loud mismatch rather than a silent
 *     coercion.
 *   - `{ ok: false, observed_state }` -- the atom exists, but its
 *     `plan_state` is NOT in the expected set. The caller's
 *     `markClaimComplete` treats this as the sub-agent attesting a
 *     premature terminal state.
 *   - `{ ok: false, observed_state: 'NOT_FOUND' }` -- the atom does
 *     not exist in the AtomStore. Either the identifier is malformed
 *     or the atom was deleted; either way the claim cannot complete.
 *   - `{ ok: false, observed_state: 'UNKNOWN' }` -- the atom exists
 *     but carries no `plan_state` field (e.g. a non-plan atom seeded
 *     under the same id). Treated as a mismatch so the caller sees a
 *     loud failure rather than a silent coincidence; throwing here
 *     would be a stronger signal but would also break the
 *     `verifier-error vs mismatch` distinction the claim reaper relies
 *     on. The right escalation path for "wrong atom type" is a future
 *     identifier-shape check at write time, not a runtime throw here.
 *
 * Throws on:
 *   - AtomStore.get rejection (e.g. disk read failure in a file-backed
 *     adapter). The caller's `markClaimComplete` maps throw ->
 *     `verifier-error`, leaving the claim pending and surfacing an
 *     operator-escalation. A silent ok:false here would let a broken
 *     AtomStore ratify falsified claims.
 *
 * The handler is intentionally narrow: one AtomStore read, one
 * comparison, no retries. Retries belong to the caller (the work-claim
 * reaper) so the retry budget composes with the per-claim staleness
 * window rather than being smeared across every verifier in the
 * substrate.
 */
export async function verifyPlanTerminal(
  identifier: string,
  expectedStates: readonly string[],
  ctx: PlanVerifierContext,
): Promise<VerifierResult> {
  // AtomId is a branded string in `src/substrate/types.ts`; the
  // substrate boundary passes opaque strings, so a cast at the entry
  // point keeps the verifier signature shared with the external
  // verifiers (PR, Task, research-atom). A malformed identifier
  // surfaces as NOT_FOUND via the AtomStore's id lookup, which is the
  // same outcome we want for "the plan does not exist."
  const atom = await ctx.host.atoms.get(identifier as never);
  if (atom === null || atom === undefined) {
    return { ok: false, observed_state: 'NOT_FOUND' };
  }
  // `plan_state` is a top-level field on Atom (see DECISIONS canon:
  // "plan_state is a top-level Atom field, not a metadata key"). A
  // non-plan atom is missing the field; we surface that as UNKNOWN so
  // the caller's mismatch path engages instead of a coerced terminal.
  const observed =
    typeof atom.plan_state === 'string' && atom.plan_state.length > 0
      ? atom.plan_state
      : 'UNKNOWN';
  const matches = expectedStates.includes(observed);
  return { ok: matches, observed_state: observed };
}
