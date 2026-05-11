/**
 * Claim-verifier registry + dispatcher.
 *
 * Maps a work-claim's `terminal_kind` string to a `ClaimVerifier`
 * handler so the contract layer can verify completion without a
 * switch statement at the call site. Adding a new kind is one line
 * in the registry plus a new handler file; the dispatcher stays
 * untouched.
 *
 * Registry shape: the live map is module-private. The public surface
 * is a `ReadonlyMap` view (for read-only inspection, e.g. tests that
 * enumerate registered kinds) and the `dispatchVerifier` function
 * that performs the lookup. Callers cannot mutate the registry from
 * outside this module; adding a kind requires editing this file.
 *
 * Failure mode: an unregistered kind throws `unknown-terminal-kind`
 * rather than returning a mismatch. A missing handler means the
 * substrate cannot attest completion at all, so a silent `ok:false`
 * would falsify a non-result as a non-match. Throws map to
 * `verifier-error` at the caller (markClaimComplete), keeping the
 * claim pending and surfacing the misconfiguration loudly.
 */

import { verifyPlanTerminal } from './plan.js';
import { verifyPrTerminal } from './pr.js';
import { verifyResearchAtomTerminal } from './research-atom.js';
import { verifyTaskTerminal } from './task.js';
import type {
  ClaimVerifier,
  VerifierContext,
  VerifierResult,
} from './types.js';

/**
 * Module-private mutable registry. External callers cannot reach this
 * symbol; the public surface is the `ReadonlyMap` view below + the
 * `dispatchVerifier` function. Mutating this from inside the module
 * is a substrate decision (adding a kind is a code edit, not a
 * runtime patch).
 *
 * The PR verifier cast: its extended `PrVerifierContext` is structurally
 * assignable to the base `VerifierContext` because the extra fields
 * are optional. The cast tells TS to accept the extended handler at
 * the base position; callers that want to inject a fetch stub pass
 * the extended context through `dispatchVerifier`'s `ctx` argument.
 */
const _registry = new Map<string, ClaimVerifier>([
  ['pr', verifyPrTerminal as ClaimVerifier],
  ['plan', verifyPlanTerminal],
  ['task', verifyTaskTerminal],
  ['research-atom', verifyResearchAtomTerminal],
]);

/**
 * Read-only view of the registered verifier kinds. Callers that need
 * to enumerate or check membership (tests, audit tooling) use this;
 * the type prevents `.set()` / `.delete()` at compile time so external
 * mutation is structurally forbidden.
 */
export const verifierRegistry: ReadonlyMap<string, ClaimVerifier> = _registry;

/**
 * Resolve `kind` to a verifier handler and invoke it with the supplied
 * identifier + expected terminal states + context. Throws
 * `unknown-terminal-kind` (a substring of the error message) when the
 * kind is not registered so the caller's verifier-error path engages
 * instead of a silent mismatch.
 *
 * The handler is invoked directly (no `Promise.race` timeout wrapper);
 * the timeout policy lives at the contract layer where it composes
 * with the claim's staleness window. Putting it here would smear the
 * timeout across every verifier in the substrate.
 */
export async function dispatchVerifier(
  kind: string,
  identifier: string,
  expectedStates: string[],
  ctx: VerifierContext,
): Promise<VerifierResult> {
  const handler = _registry.get(kind);
  if (handler === undefined) {
    // The error message includes both the literal token
    // `unknown-terminal-kind` (matchable by callers + tests) and the
    // offending kind (operator-debuggable). Keeping the error a
    // plain `Error` rather than a custom subclass matches the
    // existing verifier-throw convention in this module's siblings.
    throw new Error(`unknown-terminal-kind: ${kind}`);
  }
  return handler(identifier, expectedStates, ctx);
}
