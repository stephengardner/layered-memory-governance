/**
 * Claim-verifier registry + dispatcher.
 *
 * Resolves a work-claim's `terminal_kind` (a substrate-opaque string
 * carried on the claim atom) to a `ClaimVerifier` handler so the
 * work-claim contract layer can verify completion without a switch
 * statement at the call site. Adding a new kind is a one-line registry
 * edit (per the plan's Section 5, "Adding a new terminal kind"); the
 * core contract code never grows a branch per kind.
 *
 * Substrate posture: this module is the single resolution point for
 * verifier dispatch. The four shipping verifiers (PR, plan, task,
 * research-atom) cover the indie-floor use cases per `dev-indie-floor-org-ceiling`;
 * an org-ceiling deployment that wants to register a `terraform-apply`
 * or `slack-emoji-reaction` kind appends a registry entry alongside a
 * canon policy atom describing which principals may claim that kind.
 *
 * Failure mode: an unregistered kind throws `unknown-terminal-kind`
 * rather than returning `{ ok: false }`, because a missing handler
 * means the substrate has no way to attest completion at all -- a
 * silent ok:false would let a falsified attestation slip through the
 * caller's "verify before mark complete" gate. Throws map to
 * `verifier-error` at the caller (Task 11 contract layer), keeping
 * the claim pending and surfacing the misconfiguration loudly.
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
 * Registry of `terminal_kind` -> `ClaimVerifier` handler. The map is
 * frozen-by-convention (we hand it back as a plain `Map` so existing
 * tests can call `.has(...)` / `.keys()`; callers SHOULD treat it as
 * read-only at runtime). Mutating the registry after module load is
 * a substrate violation -- adding a kind is a code edit, not a runtime
 * patch.
 */
export const verifierRegistry: Map<string, ClaimVerifier> = new Map<
  string,
  ClaimVerifier
>([
  // PR verifier uses an extended `PrVerifierContext` (adds optional
  // fetchImpl/apiBase/repo). The extension is structural; the handler
  // is still assignable to the base `ClaimVerifier` signature because
  // the extra fields are optional. Callers that need to inject a
  // fetch stub pass the extended context through `dispatchVerifier`'s
  // `ctx` param; the dispatcher does not narrow the type so any extra
  // fields ride through to the handler.
  ['pr', verifyPrTerminal as ClaimVerifier],
  ['plan', verifyPlanTerminal],
  ['task', verifyTaskTerminal],
  ['research-atom', verifyResearchAtomTerminal],
]);

/**
 * Resolve `kind` to a verifier handler and invoke it with the supplied
 * identifier + expected terminal states + context. Throws
 * `unknown-terminal-kind` (a substring of the error message) when the
 * kind is not registered so the caller's verifier-error path engages
 * instead of a silent mismatch.
 *
 * The handler is invoked directly (no `Promise.race` timeout wrapper);
 * the timeout policy lives at the contract layer in Task 11, where it
 * composes with the claim's staleness window. Putting it here would
 * smear the timeout across every verifier in the substrate and break
 * the load-bearing "retry budget belongs to the claim reaper"
 * distinction the verifier docstrings already encode.
 */
export async function dispatchVerifier(
  kind: string,
  identifier: string,
  expectedStates: string[],
  ctx: VerifierContext,
): Promise<VerifierResult> {
  const handler = verifierRegistry.get(kind);
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
