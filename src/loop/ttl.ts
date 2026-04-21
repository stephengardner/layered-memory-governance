/**
 * TTL (time-to-live) expiration.
 *
 * An Atom with a non-null `expires_at` is eligible for expiration. When the
 * loop observes the current clock has passed `expires_at`, the atom is
 * transitioned to taint='quarantined' with confidence collapsed to the floor.
 *
 * Design notes:
 *   - We do NOT delete the atom. It stays in the store so that supersession
 *     graphs, audit refs, and principal queries remain intact.
 *   - The canon generator already filters taint !== 'clean', so quarantined
 *     atoms automatically drop out of any rendered CLAUDE.md section.
 *   - The decay pass also skips taint !== 'clean' atoms (see decay.ts) so an
 *     expired atom does not drift upward on subsequent ticks.
 *   - Already-superseded atoms and already-quarantined atoms are no-ops;
 *     idempotent.
 */

import type { Atom, AtomPatch } from '../substrate/types.js';

export interface TtlExpireOptions {
  /** Floor confidence for expired atoms. Default 0.01 (matches decay floor). */
  readonly floor?: number;
}

export function ttlExpirePatch(
  atom: Atom,
  nowMs: number,
  options: TtlExpireOptions = {},
): AtomPatch | null {
  if (atom.expires_at === null) return null;
  if (atom.taint === 'quarantined') return null;
  if (atom.superseded_by.length > 0) return null;
  const expiresMs = Date.parse(atom.expires_at);
  if (!Number.isFinite(expiresMs)) return null;
  if (nowMs < expiresMs) return null;
  return {
    taint: 'quarantined',
    confidence: options.floor ?? 0.01,
  };
}
