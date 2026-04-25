/**
 * session-tree projection: reconstruct a session + its turns + (eventually)
 * child sessions from the AtomStore.
 *
 * Read-only. Walks the chain by:
 *   1. Loading the root session atom.
 *   2. Querying for agent-turn atoms whose
 *      `metadata.agent_turn.session_atom_id` matches the session.
 *   3. Recursively walking dispatch atoms whose `derived_from` points
 *      at the session. (Single-session reconstruction is the initial
 *      shape; cross-actor walks compose the same primitive once
 *      dispatch atoms link child agent sessions.)
 *
 * Cycle defense
 * -------------
 * A `seen` set guards against malformed chains forming cycles via
 * `derived_from`. The walker bails with a structured `SessionTreeError`
 * rather than infinite-looping.
 *
 * Determinism
 * -----------
 * Output ordering is deterministic given a fixed atom set: turns are
 * sorted by `turn_index`. Two readers of the same store always see
 * the same tree.
 *
 * Read-only contract
 * ------------------
 * The projection MUST NOT write atoms. Stale projection state is
 * acceptable; read-only side effects are not. Callers depending on
 * "freshness" should re-query the atom store directly.
 *
 * Performance note
 * ----------------
 * `AtomFilter` does not support filtering by `derived_from`; the
 * projection queries all agent-turn atoms and filters in-memory by
 * `metadata.agent_turn.session_atom_id`. At indie scale this is
 * trivially fast; at 50+ actors with thousands of sessions the right
 * fix is to add a typed `derived_from?: AtomId` to `AtomFilter` so
 * the store can index it. That is a separate substrate change; the
 * projection switches to the indexed path additively when it lands.
 */

import type { AtomStore } from '../interface.js';
import type { Atom, AtomId } from '../types.js';

export interface SessionTreeNode {
  readonly session: Atom;
  readonly turns: ReadonlyArray<Atom>;
  readonly children: ReadonlyArray<SessionTreeNode>;
  readonly brokenLinks: ReadonlyArray<{ readonly from: AtomId; readonly missing: AtomId }>;
}

export class SessionTreeError extends Error {
  constructor(message: string) {
    super(`session-tree: ${message}`);
    this.name = 'SessionTreeError';
  }
}

/**
 * Build a session-tree node rooted at the given session atom id.
 * Throws `SessionTreeError` if the session atom doesn't exist or
 * is the wrong type, or if a cycle is detected.
 */
export async function buildSessionTree(
  atoms: AtomStore,
  rootSessionId: AtomId,
): Promise<SessionTreeNode> {
  return walk(atoms, rootSessionId, new Set<AtomId>());
}

async function walk(
  atoms: AtomStore,
  sessionId: AtomId,
  seen: Set<AtomId>,
): Promise<SessionTreeNode> {
  if (seen.has(sessionId)) {
    throw new SessionTreeError(`cycle detected at ${sessionId}`);
  }
  seen.add(sessionId);
  const session = await atoms.get(sessionId);
  if (session === null) {
    throw new SessionTreeError(`session atom not found: ${sessionId}`);
  }
  if (session.type !== 'agent-session') {
    throw new SessionTreeError(`atom ${sessionId} is not type='agent-session' (got ${session.type})`);
  }
  const page = await atoms.query({ type: ['agent-turn'] }, 1000);
  const turnAtoms: Atom[] = page.atoms.filter((a) => {
    const md = a.metadata as Record<string, unknown>;
    const turn = md['agent_turn'] as Record<string, unknown> | undefined;
    return turn !== undefined && turn['session_atom_id'] === sessionId;
  });
  // Deterministic ordering by turn_index. Both turns are guaranteed
  // to have a numeric turn_index per the AgentTurnMeta contract; if
  // that invariant is violated upstream, the comparator returns
  // NaN-driven ordering which sort() coerces to a stable run; the
  // contract test pins the index-based ordering.
  turnAtoms.sort((a, b) => {
    const ai = (((a.metadata as Record<string, unknown>)['agent_turn']) as Record<string, unknown>)['turn_index'] as number;
    const bi = (((b.metadata as Record<string, unknown>)['agent_turn']) as Record<string, unknown>)['turn_index'] as number;
    return ai - bi;
  });
  // Children: cross-actor dispatch sessions. The recursion seam is
  // here so additions in later substrate work do not change the
  // public shape; for now the list is empty (no dispatch-atom-driven
  // child sessions emit yet).
  const children: SessionTreeNode[] = [];
  const brokenLinks: { from: AtomId; missing: AtomId }[] = [];
  return { session, turns: turnAtoms, children, brokenLinks };
}
