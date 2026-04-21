import type { Atom, AtomFilter } from '../../substrate/types.js';

/**
 * Predicate: does an atom match the given filter?
 *
 * Default policy: superseded atoms are EXCLUDED unless filter.superseded is
 * explicitly true. This matches the interface contract.
 */
export function matches(atom: Atom, filter: AtomFilter): boolean {
  if (filter.ids && !filter.ids.includes(atom.id)) return false;
  if (filter.layer && !filter.layer.includes(atom.layer)) return false;
  if (filter.type && !filter.type.includes(atom.type)) return false;
  if (filter.scope && !filter.scope.includes(atom.scope)) return false;
  if (filter.principal_id && !filter.principal_id.includes(atom.principal_id)) return false;
  if (filter.taint && !filter.taint.includes(atom.taint)) return false;
  if (filter.created_before !== undefined && atom.created_at >= filter.created_before) return false;
  if (filter.created_after !== undefined && atom.created_at <= filter.created_after) return false;
  if (filter.min_confidence !== undefined && atom.confidence < filter.min_confidence) return false;
  if (filter.max_confidence !== undefined && atom.confidence > filter.max_confidence) return false;
  if (filter.plan_state) {
    if (atom.plan_state === undefined) return false;
    if (!filter.plan_state.includes(atom.plan_state)) return false;
  }
  if (filter.question_state) {
    if (atom.question_state === undefined) return false;
    if (!filter.question_state.includes(atom.question_state)) return false;
  }

  const isSuperseded = atom.superseded_by.length > 0;
  if (isSuperseded && filter.superseded !== true) return false;

  return true;
}
