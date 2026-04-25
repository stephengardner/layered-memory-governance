/**
 * pol-blob-threshold: per-principal or per-actor-type blob-threshold policy.
 *
 * Drives the inline-vs-blob cutoff for agent-turn payloads (LLM
 * input/output, tool args/results). Clamped on read to
 * `[BLOB_THRESHOLD_MIN, BLOB_THRESHOLD_MAX]`; falls back to
 * `BLOB_THRESHOLD_DEFAULT` (4 KB) when no policy applies, when the
 * atom is tainted or superseded, or when the policy is missing.
 *
 * Fail-closed discipline mirrors pol-replay-tier:
 *   - Missing atom    -> default.
 *   - Tainted atom    -> default. (a compromised policy must not
 *                                  silently widen DoS surface area.)
 *   - Superseded atom -> default.
 *   - Malformed       -> throw, so canon edits that produce
 *                        unparsable atoms fail loud.
 *
 * Resolution order: target_principal -> target_actor_type -> default.
 *
 * Why clamp on read instead of validate on write
 * ----------------------------------------------
 * Validation-on-write would also work, but the clamp is the load-
 * bearing safety: a tainted-clean policy whose threshold is out of
 * bounds gets the clamped value rather than the raw value, so
 * consumers ALWAYS receive a sane number even under unforeseen
 * write paths (e.g. raw atom-store mutation by a future runtime
 * primitive that bypasses validators). The function is idempotent
 * over the clamp.
 */

import type { AtomStore } from '../interface.js';
import type { Atom, AtomId, PrincipalId } from '../types.js';
import {
  BLOB_THRESHOLD_DEFAULT,
  clampBlobThreshold,
} from '../agent-budget.js';

export class BlobThresholdPolicyError extends Error {
  constructor(message: string, public readonly atomId?: AtomId) {
    super(`pol-blob-threshold: ${message}`);
    this.name = 'BlobThresholdPolicyError';
  }
}

export interface BlobThresholdTarget {
  readonly target_principal?: PrincipalId;
  readonly target_actor_type?: string;
}

/**
 * Compute the canonical atom id for a blob-threshold policy atom.
 * Throws if neither principal nor actor-type is provided.
 */
export function blobThresholdAtomId(target: BlobThresholdTarget): AtomId {
  if (target.target_principal !== undefined) {
    return `pol-blob-threshold-principal-${String(target.target_principal)}` as AtomId;
  }
  if (target.target_actor_type !== undefined) {
    return `pol-blob-threshold-actor-${target.target_actor_type}` as AtomId;
  }
  throw new BlobThresholdPolicyError('blobThresholdAtomId requires target_principal or target_actor_type');
}

/**
 * Resolve the effective blob threshold (in bytes) for a (principal,
 * actor_type) pair. Returns BLOB_THRESHOLD_DEFAULT when no policy
 * applies. Out-of-bounds values are clamped, never silently dropped.
 */
export async function loadBlobThreshold(
  atoms: AtomStore,
  principal: PrincipalId,
  actorType: string,
): Promise<number> {
  const principalRef = await atoms.get(blobThresholdAtomId({ target_principal: principal }));
  if (principalRef !== null) {
    const v = parseBlobThresholdAtom(principalRef);
    if (v !== null) return clampBlobThreshold(v);
  }
  const actorRef = await atoms.get(blobThresholdAtomId({ target_actor_type: actorType }));
  if (actorRef !== null) {
    const v = parseBlobThresholdAtom(actorRef);
    if (v !== null) return clampBlobThreshold(v);
  }
  return BLOB_THRESHOLD_DEFAULT;
}

function parseBlobThresholdAtom(atom: Atom): number | null {
  if (atom.taint !== 'clean') return null;
  if (atom.superseded_by.length > 0) return null;
  const md = atom.metadata as Record<string, unknown>;
  if (md['kind'] !== 'pol-blob-threshold') {
    throw new BlobThresholdPolicyError(`atom metadata.kind != 'pol-blob-threshold'`, atom.id);
  }
  const t = md['threshold_bytes'];
  if (typeof t !== 'number' || Number.isNaN(t)) {
    throw new BlobThresholdPolicyError(`threshold_bytes must be a number, got ${typeof t}`, atom.id);
  }
  return t;
}
