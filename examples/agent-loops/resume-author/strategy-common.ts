/**
 * Shared assembly helpers for per-actor resume-strategy descriptors.
 *
 * Phase 2 (PR #305 Phase 1 + this PR) ships per-actor walk-fns for
 * cto-actor and code-author. Both walks share the same shape:
 *
 *   1. Filter the supplied atom list to `type === 'agent-session'`
 *      with a matching `principal_id` (the trust boundary at the walk
 *      level per spec section 8.3).
 *   2. Read a per-actor work-item key from each session atom and keep
 *      only sessions whose key matches the input work-item key.
 *   3. Convert each surviving atom into a `CandidateSession`,
 *      skipping legacy sessions whose
 *      `metadata.agent_session.extra.resumable_session_id` is absent
 *      or empty (mirrors `walk-author-sessions.ts` behavior so a
 *      pre-resume-hook session does not surface as a defective
 *      candidate).
 *   4. Sort newest-first by `started_at` (ISO-8601 sorts
 *      lexicographically the same as chronologically).
 *
 * Steps 1, 3, 4 are identical across actors; step 2 is the per-actor
 * variation expressed via `extractWorkItemKey`. Extracting the shared
 * shape now (N=2: cto-actor + code-author) follows
 * `dev-extract-helpers-at-n-2`. A third actor (e.g. auditor-actor) can
 * register a third descriptor by supplying its own
 * `extractWorkItemKey` without copy-pasting the surrounding loop.
 *
 * The walk is intentionally synchronous and operates on a pre-fetched
 * atom list. The registry caller is responsible for fetching atoms
 * from the host (e.g. via `host.atoms.list`) before invoking the
 * descriptor; the descriptor's role is filter + sort + project.
 * Keeping the walk synchronous matches Phase 1's
 * `assembleCandidates: (walk: TWalk) => ReadonlyArray<TCandidate>`
 * shape (no Promise) and makes the strategies trivially unit-testable.
 */

import type { Atom, PrincipalId } from '../../../src/substrate/types.js';
import type { CandidateSession } from './types.js';

/**
 * Walk input passed to a per-actor `assembleCandidates` callback.
 *
 * `atoms` is the candidate pool to filter; the registry caller
 * fetches it from the host before invoking the descriptor.
 * `workItemKey` is the per-invocation key derived by
 * `identifyWorkItem(input)`; the walk filters sessions to the same key
 * so cross-work-item leakage is impossible at the walk level.
 */
export interface ActorWalkInput {
  readonly atoms: ReadonlyArray<Atom>;
  readonly workItemKey: string;
}

/**
 * Extract a `CandidateSession` from an agent-session atom, or return
 * `undefined` if the atom lacks a non-empty
 * `metadata.agent_session.extra.resumable_session_id`. Legacy sessions
 * predating the resume capture hook lack this field; they are
 * SKIPPED (not surfaced as a defective candidate) per the same
 * fail-soft posture as `walk-author-sessions.ts`.
 */
export function asCandidate(atom: Atom): CandidateSession | undefined {
  const meta = atom.metadata as Record<string, unknown>;
  const agentSession = meta['agent_session'] as Record<string, unknown> | undefined;
  if (agentSession === undefined) return undefined;
  const extra = (agentSession['extra'] as Record<string, unknown> | undefined) ?? {};
  const resumableSessionId = extra['resumable_session_id'];
  if (typeof resumableSessionId !== 'string' || resumableSessionId.length === 0) {
    return undefined;
  }
  const adapterId = typeof agentSession['adapter_id'] === 'string'
    ? (agentSession['adapter_id'] as string)
    : '';
  const startedAt = typeof agentSession['started_at'] === 'string'
    ? (agentSession['started_at'] as string)
    : '';
  return {
    sessionAtomId: atom.id,
    resumableSessionId,
    startedAt,
    extra: extra as Readonly<Record<string, unknown>>,
    adapterId,
  };
}

/**
 * Filter a list of atoms to agent-session atoms matching the given
 * `principal_id` and per-actor work-item key, project each surviving
 * atom into a `CandidateSession`, and sort newest-first by
 * `started_at`.
 *
 * Per spec section 8.3 the walk enforces a TWO-AXIS filter:
 *   1. `principal_id === expectedPrincipalId`     (actor scope)
 *   2. `extractWorkItemKey(atom) === workItemKey` (work-item scope)
 *
 * Both axes MUST pass; relying on work-item key uniqueness alone is
 * fragile because keys are conceptually scoped to actors but
 * implemented as plain strings that could collide across actors.
 *
 * `extractWorkItemKey` returns `undefined` when the atom lacks the
 * fields required to compute the per-actor key (legacy sessions, or
 * sessions written by an earlier substrate version). Such atoms are
 * skipped without throwing.
 */
export function assembleActorCandidates(
  walk: ActorWalkInput,
  expectedPrincipalId: PrincipalId,
  extractWorkItemKey: (atom: Atom) => string | undefined,
): ReadonlyArray<CandidateSession> {
  const matched: CandidateSession[] = [];
  for (const atom of walk.atoms) {
    if (atom.type !== 'agent-session') continue;
    if (atom.principal_id !== expectedPrincipalId) continue;
    const key = extractWorkItemKey(atom);
    if (key === undefined || key !== walk.workItemKey) continue;
    const candidate = asCandidate(atom);
    if (candidate === undefined) continue;
    matched.push(candidate);
  }
  return matched.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * Read a string field at a dotted path under `atom.metadata`. Returns
 * `undefined` when any segment is missing or non-string. Used by the
 * per-actor `extractWorkItemKey` callbacks to read namespaced fields
 * without each caller re-implementing the type-guarded traversal.
 */
export function readMetaString(
  atom: Atom,
  path: ReadonlyArray<string>,
): string | undefined {
  let cursor: unknown = atom.metadata;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === 'string' ? cursor : undefined;
}

/**
 * Read a number field at a dotted path under `atom.metadata`. Returns
 * `undefined` when any segment is missing or non-number. Mirrors
 * `readMetaString` for callbacks that need numeric work-item key
 * components (e.g. `iteration_n`).
 */
export function readMetaNumber(
  atom: Atom,
  path: ReadonlyArray<string>,
): number | undefined {
  let cursor: unknown = atom.metadata;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : undefined;
}
