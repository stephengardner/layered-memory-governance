/**
 * Per-actor `ResumeStrategyDescriptor` for the `code-author` principal.
 *
 * Phase 2 (this PR) supplies the walk + work-item identifier the
 * Phase 1 registry consumes. The wrapper that orchestrates the
 * resume-or-fresh-spawn decision lives at `loop.ts` (PR #171,
 * unchanged); the registry primitive that selects per-principal
 * descriptors lives at `registry.ts` (PR #305, unchanged).
 *
 * Work-item key shape
 * -------------------
 * The user-task pins the code-author work-item key to `plan_id`
 * (the approved plan atom that authorizes this draft). The registry
 * descriptor therefore returns `task.planAtomId` directly from
 * `identifyWorkItem`. Per spec section 4.1, `AgentTask.planAtomId`
 * is already populated by the substrate today; no forward-looking
 * field is needed.
 *
 * Read paths used here:
 *   - On `AgentLoopInput`: reads `input.task.planAtomId` directly.
 *   - On agent-session atoms: reads
 *     `metadata.agent_session.code_author.plan_atom_id`. Atoms
 *     lacking this field are skipped (legacy sessions written before
 *     the substrate stamped the namespaced field). A future
 *     substrate PR may collapse this into `task_plan_atom_id` at
 *     the top of `metadata.agent_session`; until then, the
 *     namespaced read keeps cto-actor's and code-author's
 *     work-item keys in disjoint metadata slots so a buggy walk
 *     cannot cross-contaminate per spec section 8.3.
 *
 * Fresh-spawn fallback
 * --------------------
 * Per spec section 6.4, fresh-spawn fallback shapes are: empty
 * candidate list -> wrapper delegates directly to fallback adapter;
 * `identifyWorkItem` returning a deterministic key (the `planAtomId`
 * itself, never null) so the wrapper still runs the walk and lands
 * in fresh-spawn cleanly when no prior session matches.
 */

import type { AgentLoopInput } from '../../../src/substrate/agent-loop.js';
import type { Atom, PrincipalId } from '../../../src/substrate/types.js';
import type { CandidateSession } from './types.js';
import type { ResumeStrategyDescriptor } from './registry.js';
import {
  type ActorWalkInput,
  assembleActorCandidates,
  readMetaString,
} from './strategy-common.js';

export const CODE_AUTHOR_PRINCIPAL_ID = 'code-author' as PrincipalId;

/**
 * Read the code-author work-item key from an agent-session atom.
 * Returns `undefined` when the namespaced `plan_atom_id` field is
 * absent so the surrounding walk skips the atom rather than
 * fabricating a key.
 */
function extractCodeAuthorWorkItemKey(atom: Atom): string | undefined {
  return readMetaString(atom, ['agent_session', 'code_author', 'plan_atom_id']);
}

/**
 * Derive the code-author work-item key directly from
 * `task.planAtomId`. The substrate already populates this field on
 * every dispatched code-author run (verified via
 * `src/substrate/agent-loop.ts` `AgentTask.planAtomId` declaration);
 * no fallback is needed.
 */
function identifyCodeAuthorWorkItem(input: AgentLoopInput): string {
  return String(input.task.planAtomId);
}

/**
 * Walk the supplied atom list to find resumable code-author sessions
 * scoped to the input plan id. The two-axis filter
 * (`principal_id === 'code-author'` AND `plan_atom_id` matches) is
 * enforced by `assembleActorCandidates` per spec section 8.3.
 */
function assembleCodeAuthorCandidates(walk: ActorWalkInput): ReadonlyArray<CandidateSession> {
  return assembleActorCandidates(walk, CODE_AUTHOR_PRINCIPAL_ID, extractCodeAuthorWorkItemKey);
}

/**
 * The descriptor the registry consumes. Conforms to Phase 1's
 * `ResumeStrategyDescriptor<TWalk, TCandidate, TInput>` shape
 * verbatim; `ladder` is empty in Phase 2 because strategy ladders
 * land in a later phase (per spec section 11.3 the policy atom
 * carries the ladder and is consumed by the runner).
 */
export const codeAuthorResumeStrategyDescriptor: ResumeStrategyDescriptor<
  ActorWalkInput,
  CandidateSession,
  AgentLoopInput
> = {
  assembleCandidates: assembleCodeAuthorCandidates,
  identifyWorkItem: identifyCodeAuthorWorkItem,
  ladder: [],
};

/**
 * Stable list of work-item key prefixes this descriptor claims when
 * registered, used by `addDescriptor`'s collision ledger to keep the
 * code-author key namespace from being shadowed by another principal.
 *
 * The code-author key is the literal plan atom id (already a
 * substrate-unique string). We register a synthetic prefix so a
 * future descriptor that tries to claim the same prefix throws at
 * registration time instead of silently routing.
 */
export const CODE_AUTHOR_WORK_ITEM_KEY_PREFIXES: ReadonlyArray<string> = ['code-author:plan-atom-id'];
