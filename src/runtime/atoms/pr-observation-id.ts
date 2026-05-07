/**
 * Forge-agnostic id generator for pr-observation atoms.
 *
 * Mechanism: id is keyed on (owner, repo, number, headSha-prefix-12,
 * observedAt-minute) so multiple paths writing for the same logical
 * observation collapse to a single id (idempotent re-observe), while
 * distinct head SHAs or distinct minutes yield distinct ids (so a
 * state transition produces a fresh atom that can supersede the
 * prior one cleanly via standard atom-store put semantics).
 *
 * This module deliberately knows nothing about which actor wrote the
 * atom. Both the seed builder (synthesized at dispatch time) and the
 * landing builder (hydrated via observe-only run) call this function.
 *
 * UTC-only minute slug: observedAt is an ISO-8601 string; truncate to
 * minute (16 chars: YYYY-MM-DDTHH:MM) and strip non-digits to keep the
 * id filesystem-safe.
 */

import type { AtomId, Time } from '../../types.js';

/**
 * Build a deterministic pr-observation atom id.
 *
 * Two observations within the same minute for the same PR + head SHA
 * produce the same id (idempotent). Distinct minutes or distinct head
 * SHAs produce distinct ids.
 */
export function mkPrObservationAtomId(
  owner: string,
  repo: string,
  number: number,
  headSha: string,
  observedAt: Time,
): AtomId {
  const shaSuffix = String(headSha).slice(0, 12);
  const minute = String(observedAt).slice(0, 16);
  const minuteSlug = minute.replace(/[^0-9]/g, '');
  return `pr-observation-${owner}-${repo}-${number}-${shaSuffix}-${minuteSlug}` as AtomId;
}
