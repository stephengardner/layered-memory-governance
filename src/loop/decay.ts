/**
 * Confidence decay.
 *
 * Pure function: given an atom's current confidence, its type, its
 * last_reinforced_at, and the current time, compute the decayed confidence.
 *
 * Model: exponential decay with type-specific half-life.
 *   confidence(t) = confidence_0 * 2^(-Δt / halfLife)
 *
 * A floor (minConfidence) prevents full zero, which would make atoms
 * unrecoverable. Superseded atoms are skipped (confidence does not matter).
 */

import type { Atom, AtomType } from '../substrate/types.js';
import { DEFAULT_HALF_LIVES } from './types.js';

export function decayedConfidence(
  atom: Atom,
  nowMs: number,
  halfLives: Readonly<Record<AtomType, number>> = DEFAULT_HALF_LIVES,
  minConfidence: number = 0.01,
): number {
  if (atom.superseded_by.length > 0) return atom.confidence;
  // Quarantined and tainted atoms are frozen at their current confidence;
  // decay must not lift a TTL-expired or compromise-tainted atom off the
  // floor on subsequent ticks.
  if (atom.taint !== 'clean') return atom.confidence;
  const lastMs = Date.parse(atom.last_reinforced_at);
  if (!Number.isFinite(lastMs)) return atom.confidence;
  const deltaMs = nowMs - lastMs;
  if (deltaMs <= 0) return atom.confidence;
  const halfLife = halfLives[atom.type] ?? DEFAULT_HALF_LIVES[atom.type];
  if (!halfLife || halfLife <= 0) return atom.confidence;
  const ratio = deltaMs / halfLife;
  const decayed = atom.confidence * Math.pow(2, -ratio);
  return Math.max(decayed, minConfidence);
}

/** Whether the decayed value meaningfully differs from the current one. */
export function shouldUpdateConfidence(
  current: number,
  decayed: number,
  epsilon: number = 1e-4,
): boolean {
  return Math.abs(current - decayed) > epsilon;
}
