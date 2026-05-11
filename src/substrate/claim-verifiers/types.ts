import type { Host } from '../interface.js';

/**
 * Result of a verifier handler invocation.
 *
 * `ok=true` means the verifier observed the work-item in one of the
 * expected terminal states; this is the load-bearing claim that flips
 * a work-claim to `complete`. A wrong implementation risks a false-accept
 * (substrate honors a false attestation), so verifier handlers MUST query
 * authoritative external state, NOT the substrate's own AtomStore.
 */
export interface VerifierResult {
  ok: boolean;
  observed_state: string;
}

/**
 * Context passed to every verifier invocation. Carries the Host so a
 * verifier can reach the principal store, clock, or logger as needed,
 * while keeping the verifier signature small.
 */
export interface VerifierContext {
  host: Host;
}

/**
 * Pluggable verifier handler. Given an external identifier (e.g. PR number,
 * commit SHA, issue id) and the set of expected terminal states, returns
 * whether the work-item is currently in one of those states.
 */
export type ClaimVerifier = (
  identifier: string,
  expectedStates: string[],
  ctx: VerifierContext,
) => Promise<VerifierResult>;
