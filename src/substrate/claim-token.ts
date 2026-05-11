/**
 * Claim-secret-token helpers for the work-claim contract.
 *
 * Why this exists
 * ---------------
 * The work-claim contract binds an attestation to the originally
 * dispatched sub-agent via a shared secret token. The token is generated
 * at dispatch time, written into the work-claim atom alongside the
 * principal id, carried to the sub-agent through the prompt preamble,
 * and presented back at `markClaimComplete` time. A caller missing the
 * token (or holding a stale token from before rotation) cannot
 * fraudulently flip a claim to `complete` even if it knows the claim id.
 *
 * Threat model
 * ------------
 * - Token forgery: defeated by 256 bits of cryptographic randomness.
 *   `crypto.randomBytes(32)` yields a uniformly-distributed 32-byte
 *   value; base64url encoding produces 43 URL-safe characters with no
 *   padding. The keyspace is large enough that brute-force search is
 *   computationally infeasible across the lifetime of any claim
 *   (deadlines are measured in minutes-to-hours).
 * - Timing-attack token guessing: defeated by constant-time
 *   comparison via Node's `crypto.timingSafeEqual`. A naive
 *   string-equality check leaks per-character timing information
 *   that an attacker with repeated guesses could narrow the keyspace
 *   against. `timingSafeEqual` operates in time proportional to the
 *   buffer length regardless of where the first mismatch sits.
 * - Length-as-side-channel: `timingSafeEqual` REQUIRES equal-length
 *   buffers and throws otherwise. We pre-check length and return
 *   `false` so callers do not need a try/catch around every compare;
 *   the length itself is non-secret (every legitimate token is 43+
 *   chars of base64url) so the early-return is acceptable.
 *
 * Redaction
 * ---------
 * Tokens flow through prompt preambles and tool-call logs. The
 * substrate redactor pattern strips any appearance of a 43+ char
 * base64url string from persisted agent-turn atoms. Token strings
 * MUST NEVER be written to an unredacted log surface.
 *
 * Substrate posture
 * -----------------
 * Pure helpers: no IO, no mutable state, no host dependency. Safe to
 * call from any layer. The split between `generateClaimToken` and
 * `rotateClaimToken` is a naming distinction for call-site clarity
 * (recovery-step rotation reads more clearly than a generic
 * re-generate) -- both delegate to the same generator.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Generate a fresh claim-secret token. 256 bits of cryptographic
 * randomness encoded as URL-safe base64 without padding (43 chars).
 *
 * Use at dispatch time when minting a new work-claim atom.
 */
export function generateClaimToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Rotate a claim-secret token. Produces a fresh token using the same
 * generator as `generateClaimToken`; the separate symbol exists so
 * recovery-step rotation call sites read as the intent the code is
 * expressing, not as a generic re-generate.
 */
export function rotateClaimToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Constant-time string compare. Returns `true` only when both inputs
 * are equal-length AND byte-identical, evaluated in time proportional
 * to the buffer length (not to the position of the first mismatch).
 *
 * Length mismatch short-circuits to `false` WITHOUT throwing. Equal
 * length runs through `crypto.timingSafeEqual`. Use this for any
 * compare where the right-hand side is attacker-controlled (the
 * caller's presented token vs the stored token on the work-claim atom).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
