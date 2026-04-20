/**
 * Write-time validator for circuit-breaker-reset atoms.
 *
 * A `circuit-breaker-reset` atom clears a specific open trip. Writing
 * one requires:
 *
 *   1. Signer authority: `atom.principal_id` must appear in
 *      `pol-circuit-breaker-reset-authority.authorized_principals`,
 *      OR principal hierarchy depth must satisfy `max_signer_depth`
 *      (0 = root-only, 1 = root + direct children, ...).
 *   2. Trip target match: the referenced trip's `target_principal`
 *      must equal the reset's `target_principal`.
 *   3. Trip exists: the `trip_atom_id` must resolve to an existing,
 *      unsuperseded `circuit-breaker-trip` atom.
 *   4. One-shot: no prior reset atom may already reference the same
 *      trip.
 *   5. Non-empty reason: `reset_reason` must be a non-empty string.
 *
 * The caller is expected to invoke `validateResetWrite` BEFORE
 * `host.atoms.put(resetAtom)`. On pass, the validator ALSO updates the
 * trip atom's `superseded_by` to point at the reset atom id, marking
 * the trip closed. This keeps the governance surface durable and
 * visible to the rate limiter's open-trip scan.
 */

import { PermissionError, ValidationError } from '../errors.js';
import type { Host } from '../interface.js';
import type { Atom, AtomId, PrincipalId } from '../types.js';
import type { CircuitBreakerResetV1 } from './types.js';

/**
 * Thrown when the signer does not have authority to sign the reset
 * atom. Permission-class because the writer is known but not
 * authorized.
 */
export class ResetAuthorityError extends PermissionError {
  override readonly name = 'ResetAuthorityError';
  constructor(
    readonly signerPrincipal: PrincipalId,
    reason: string,
  ) {
    super(`circuit-breaker-reset rejected: signer ${String(signerPrincipal)} lacks authority (${reason})`);
  }
}

/**
 * Thrown for structural issues with the reset atom (trip not found,
 * reason empty, one-shot violation, target mismatch).
 */
export class ResetShapeError extends ValidationError {
  override readonly name = 'ResetShapeError';
  constructor(reason: string) {
    super(`circuit-breaker-reset rejected: ${reason}`);
  }
}

/**
 * Validate and apply side effects for a circuit-breaker-reset atom.
 * Call this immediately before `host.atoms.put(resetAtom)`.
 *
 * On success, the trip atom referenced by `envelope.trip_atom_id` has
 * its `superseded_by` updated to include the reset atom id. On
 * failure, throws one of:
 *   - ResetAuthorityError: signer not authorized
 *   - ResetShapeError: structural problem
 *
 * The reset atom itself is NOT written by this function; the caller
 * does that after a successful validation. Separation keeps the
 * function pure with respect to the reset atom (the caller controls
 * atom id generation, timestamps, etc.) while centralizing the
 * governance decision.
 */
export async function validateResetWrite(
  host: Host,
  resetAtom: Atom,
): Promise<void> {
  // Shape: the atom must be the right type and carry an envelope
  // with the expected fields. The validator is conservative: any
  // divergence from the declared shape is a ShapeError, not a silent
  // fallthrough.
  if (resetAtom.type !== 'circuit-breaker-reset') {
    throw new ResetShapeError(`atom type is ${resetAtom.type}, expected 'circuit-breaker-reset'`);
  }
  const envelope = extractResetEnvelope(resetAtom);
  if (envelope === null) {
    throw new ResetShapeError('metadata.reset envelope is missing or malformed');
  }
  if (envelope.reset_reason.trim().length < 4) {
    // 4 chars is deliberately tiny but forces the operator to type
    // *something*. Deployments that want stricter rationale gates set
    // their own policy atom and wrap this validator.
    throw new ResetShapeError(
      'reset_reason must be a non-empty string of at least 4 characters; '
      + 'governance-without-enforcement is decorative',
    );
  }

  // Trip existence + target-match.
  const tripAtom = await host.atoms.get(envelope.trip_atom_id);
  if (tripAtom === null) {
    throw new ResetShapeError(
      `trip atom ${String(envelope.trip_atom_id)} does not exist`,
    );
  }
  if (tripAtom.type !== 'circuit-breaker-trip') {
    throw new ResetShapeError(
      `trip_atom_id ${String(envelope.trip_atom_id)} is not a circuit-breaker-trip atom`,
    );
  }
  const tripTarget = extractTripTarget(tripAtom);
  if (tripTarget === null || String(tripTarget) !== String(envelope.target_principal)) {
    throw new ResetShapeError(
      `reset target ${String(envelope.target_principal)} does not match trip target `
      + `${String(tripTarget ?? 'unknown')}`,
    );
  }
  if (tripAtom.superseded_by.length > 0) {
    throw new ResetShapeError(
      `trip atom ${String(envelope.trip_atom_id)} is already superseded; one-shot reset violated`,
    );
  }

  // Authority: the atom's principal_id is the load-bearing signer.
  // envelope.authorizing_principal is an audit-readability echo and
  // MUST equal principal_id; otherwise the reset is misattributed.
  if (String(resetAtom.principal_id) !== String(envelope.authorizing_principal)) {
    throw new ResetShapeError(
      `envelope.authorizing_principal (${String(envelope.authorizing_principal)}) `
      + `must equal atom.principal_id (${String(resetAtom.principal_id)})`,
    );
  }

  const authorized = await isAuthorizedSigner(host, resetAtom.principal_id);
  if (!authorized) {
    throw new ResetAuthorityError(
      resetAtom.principal_id,
      'principal not in pol-circuit-breaker-reset-authority.authorized_principals '
      + 'and hierarchy depth exceeds max_signer_depth',
    );
  }

  // Mark the trip superseded. This runs before the reset atom itself
  // is written; if the trip-update fails for any reason, the reset
  // is not written either (caller should await validator then put).
  await host.atoms.update(tripAtom.id, {
    superseded_by: [...tripAtom.superseded_by, resetAtom.id],
  });
}

interface ResetAuthorityPolicy {
  readonly authorized_principals: ReadonlyArray<string>;
  readonly max_signer_depth: number;
}

const FALLBACK_AUTHORITY: ResetAuthorityPolicy = Object.freeze({
  // No default principal: unset = deny. Deployments seed the policy
  // atom via bootstrap-inbox-canon.mjs.
  authorized_principals: [],
  max_signer_depth: 0,
});

async function isAuthorizedSigner(
  host: Host,
  signer: PrincipalId,
): Promise<boolean> {
  const policy = await readAuthorityPolicy(host);
  if (policy.authorized_principals.includes(String(signer))) return true;
  // Depth gate is OPT-IN: only engages when max_signer_depth > 0. V0
  // ships root-only (authorized_principals-only) because the depth
  // alternative is attackable - a compromised sub-principal at
  // allowed depth could sign its own reset. Deployments opt in
  // explicitly by setting max_signer_depth >= 1 in
  // pol-circuit-breaker-reset-authority.
  if (policy.max_signer_depth <= 0) return false;
  const depth = await principalDepth(host, signer);
  return depth >= 0 && depth <= policy.max_signer_depth;
}

async function readAuthorityPolicy(host: Host): Promise<ResetAuthorityPolicy> {
  const page = await host.atoms.query({ type: ['directive'], layer: ['L3'] }, 200);
  for (const atom of page.atoms) {
    // Reject tainted or superseded policy atoms defensively. The
    // AtomFilter may not always include these predicates in every
    // backing store implementation, so the filter happens here too.
    // A tainted or superseded authority policy must never silently
    // grant authority -- that would let a compromised atom re-enable
    // a signer the canon rejected.
    if (atom.taint !== 'clean') continue;
    if (atom.superseded_by.length > 0) continue;
    const policy = (atom.metadata as Record<string, unknown>)?.policy as
      | Record<string, unknown>
      | undefined;
    if (policy?.subject === 'circuit-breaker-reset-authority') {
      const ap = policy.authorized_principals;
      const msd = Number(policy.max_signer_depth);
      const authorized = Array.isArray(ap) ? ap.filter((v): v is string => typeof v === 'string') : [];
      return {
        authorized_principals: authorized,
        max_signer_depth: Number.isFinite(msd) && msd >= 0 ? msd : 0,
      };
    }
  }
  return FALLBACK_AUTHORITY;
}

/**
 * Compute principal depth from root.
 *   0  = root (principal exists and signed_by is null)
 *   N  = N hops from root
 *   -1 = principal not found in the store
 *
 * The `-1` sentinel is load-bearing: isAuthorizedSigner's depth check
 * (`depth <= max_signer_depth`) must REJECT a principal that doesn't
 * exist, even when max_signer_depth >= 0 would nominally admit
 * "depth 0". Returning 0 for not-found would let a non-existent
 * principal id slip past the depth gate; that's the bug the -1
 * sentinel plus the `depth >= 0` guard in the caller prevents.
 */
async function principalDepth(
  host: Host,
  principalId: PrincipalId,
): Promise<number> {
  const MAX = 32;
  let current = await host.principals.get(principalId);
  if (current === null) return -1;
  let depth = 0;
  while (current !== null && current.signed_by !== null && depth < MAX) {
    current = await host.principals.get(current.signed_by);
    depth += 1;
  }
  return depth;
}

function extractResetEnvelope(atom: Atom): CircuitBreakerResetV1 | null {
  const raw = (atom.metadata as Record<string, unknown>)?.reset;
  if (raw === undefined || raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.target_principal !== 'string') return null;
  if (typeof obj.trip_atom_id !== 'string') return null;
  if (typeof obj.reset_reason !== 'string') return null;
  if (typeof obj.authorizing_principal !== 'string') return null;
  return {
    target_principal: obj.target_principal as PrincipalId,
    trip_atom_id: obj.trip_atom_id as AtomId,
    reset_reason: obj.reset_reason,
    authorizing_principal: obj.authorizing_principal as PrincipalId,
  };
}

function extractTripTarget(atom: Atom): string | null {
  const raw = (atom.metadata as Record<string, unknown>)?.trip;
  if (raw === undefined || raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  return typeof obj.target_principal === 'string' ? obj.target_principal : null;
}
