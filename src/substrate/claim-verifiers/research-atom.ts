/**
 * Research-atom terminal-state verifier.
 *
 * Queries the substrate's own AtomStore for an atom by id and reports
 * whether its declared status matches one of the work-claim's expected
 * terminal states (typically `['published']`). Generic enough to verify
 * any atom kind that carries a status field; the name "research-atom"
 * reflects the canonical caller, not a hard schema restriction.
 *
 * Substrate-purity note: a verifier that reads atom-store state at first
 * glance violates the "do not trust internal claims" guidance baked into
 * the PR verifier. The distinction is identity: the PR verifier checks
 * a claim that the SUB-AGENT writes against an EXTERNAL source of truth
 * (GitHub), so a lying sub-agent cannot falsify completion. For an atom
 * whose lifecycle is fully owned by the substrate (status transitions
 * are gated by the existing atom-write hooks + principal policy), the
 * atom IS the source of truth; the verifier just looks it up. If a
 * future deployment moves the status to an external system, that
 * deployment registers a different verifier kind rather than overloading
 * this one.
 *
 * Field-path policy: status lookup tries `metadata.research.status`
 * first (nested per the plan directive), then falls back to
 * `metadata.status` (flat). Either shape is accepted because no existing
 * research-atom schema is established in the codebase at task-time and
 * pinning to a single path would break the first deployment that picks
 * the other one. A future schema decision (an atom or canon directive
 * fixing the field path) can remove the fallback.
 */

import type { Atom, AtomId } from '../types.js';
import type { VerifierContext, VerifierResult } from './types.js';

/**
 * Read the status string from an atom in a research-shaped layout.
 * Returns null when the atom carries no status under either supported
 * path so the caller can return a NOT_FOUND result.
 *
 * Permissive on input shape: any non-string status (number, object,
 * undefined) is treated as missing because the substrate's claim
 * vocabulary is string-typed. A misshapen atom surfaces as NOT_FOUND
 * rather than silently coercing.
 */
function readStatus(atom: Atom): string | null {
  // The Atom interface narrows `metadata` to a known set of keys but
  // research-atom shapes carry arbitrary metadata at the kind layer; we
  // index defensively rather than asserting a schema the verifier does
  // not own.
  const meta = (atom as { metadata?: Record<string, unknown> }).metadata;
  if (meta === undefined || meta === null) {
    return null;
  }
  const researchBlock = meta['research'];
  if (researchBlock !== null && typeof researchBlock === 'object') {
    const nested = (researchBlock as Record<string, unknown>)['status'];
    if (typeof nested === 'string') {
      return nested;
    }
  }
  const flat = meta['status'];
  if (typeof flat === 'string') {
    return flat;
  }
  return null;
}

/**
 * Verify that a research-shaped atom has reached one of the declared
 * terminal states.
 *
 * Return semantics:
 *   - `{ ok: true, observed_state }`  -- atom exists and its status
 *     matches one of `expectedStates`. Case-sensitive (the substrate's
 *     claim vocabulary uses literal strings; a `Published` vs
 *     `published` mismatch should surface loud, not be silently
 *     normalized).
 *   - `{ ok: false, observed_state }` -- atom exists and its status
 *     does NOT match. The caller treats this as a premature attestation.
 *   - `{ ok: false, observed_state: 'NOT_FOUND' }` -- atom does not
 *     exist, has no metadata, or carries no status under either
 *     supported path.
 *
 * Throws on:
 *   - AtomStore.get throws (storage layer broken; the caller maps
 *     throw -> verifier-error so the claim stays pending and an
 *     operator escalation surfaces).
 *
 * No retries here; retry budget belongs to the caller (claim reaper).
 */
export async function verifyResearchAtomTerminal(
  identifier: string,
  expectedStates: readonly string[],
  ctx: VerifierContext,
): Promise<VerifierResult> {
  // `identifier` is a substrate-opaque string at the claim boundary;
  // AtomId is a branded string in the type system, so the cast carries
  // the same runtime value with the contract-required type.
  const atom = await ctx.host.atoms.get(identifier as AtomId);
  if (atom === null) {
    return { ok: false, observed_state: 'NOT_FOUND' };
  }
  const status = readStatus(atom);
  if (status === null) {
    return { ok: false, observed_state: 'NOT_FOUND' };
  }
  const matches = expectedStates.includes(status);
  return { ok: matches, observed_state: status };
}
