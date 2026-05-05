/**
 * Per-actor `ResumeStrategyDescriptor` for the `cto-actor` principal.
 *
 * Phase 2 (this PR) supplies the walk + work-item identifier the
 * Phase 1 registry consumes. The wrapper that orchestrates the
 * resume-or-fresh-spawn decision lives at `loop.ts` (PR #171,
 * unchanged); the registry primitive that selects per-principal
 * descriptors lives at `registry.ts` (PR #305, unchanged).
 *
 * Work-item key shape
 * -------------------
 * The user-task pins the cto-actor work-item key to
 * `request_hash + ':' + iteration_n`. These two fields are
 * forward-looking: the substrate today does not yet write them on
 * `AgentLoopInput` or on the `agent-session` atom. The descriptor
 * encodes the intended read path so a future substrate PR that
 * surfaces the fields (under `metadata.agent_session.cto_actor.*` for
 * atoms; via input extension for the loop input) snaps in without
 * touching this file.
 *
 * Read paths used here:
 *   - On `AgentLoopInput`: an extended `CtoActorResumeInput` shape
 *     declares optional `requestHash` + `iterationN` fields. When
 *     absent, falls back to `correlationId + ':0'` so the descriptor
 *     produces a deterministic key today even before the substrate
 *     writes the explicit fields. The fallback honors the
 *     `dev-extreme-rigor-and-research` posture: rather than throwing
 *     on a missing field, the descriptor produces the key the field
 *     SHOULD encode, so a Phase-2 dispatch under today's substrate
 *     still routes consistently.
 *   - On agent-session atoms: reads
 *     `metadata.agent_session.cto_actor.request_hash` and
 *     `metadata.agent_session.cto_actor.iteration_n`. Atoms lacking
 *     either field are skipped (treated as legacy / pre-substrate-PR
 *     sessions and handled via fresh-spawn).
 *
 * Fresh-spawn fallback
 * --------------------
 * Per spec section 6.4, fresh-spawn fallback shapes are: empty
 * candidate list -> wrapper delegates directly to fallback adapter;
 * `identifyWorkItem` returning a deterministic-but-defaulted key (no
 * throw) so the wrapper still attempts the walk and lands in
 * fresh-spawn cleanly when no prior session matches.
 */

import type { AgentLoopInput } from '../../../src/substrate/agent-loop.js';
import type { Atom, PrincipalId } from '../../../src/substrate/types.js';
import type { CandidateSession } from './types.js';
import type { ResumeStrategyDescriptor } from './registry.js';
import {
  type ActorWalkInput,
  assembleActorCandidates,
  readMetaNumber,
  readMetaString,
} from './strategy-common.js';

export const CTO_ACTOR_PRINCIPAL_ID = 'cto-actor' as PrincipalId;

/**
 * Forward-looking input shape: a CTO planning dispatch carries the
 * per-iteration `requestHash` + `iterationN` so the registry can route
 * resume traffic across re-invocations on the same intent. The fields
 * are optional today; a future substrate PR makes them required and
 * threads them through the loop runner.
 */
export interface CtoActorResumeInput extends AgentLoopInput {
  readonly requestHash?: string;
  readonly iterationN?: number;
}

/**
 * Read the cto-actor work-item key from an agent-session atom's
 * namespaced metadata slot. Returns `undefined` when either component
 * is missing so the surrounding walk skips the atom rather than
 * fabricating a key from partial data.
 */
function extractCtoWorkItemKey(atom: Atom): string | undefined {
  const requestHash = readMetaString(atom, ['agent_session', 'cto_actor', 'request_hash']);
  const iterationN = readMetaNumber(atom, ['agent_session', 'cto_actor', 'iteration_n']);
  if (requestHash === undefined || iterationN === undefined) return undefined;
  return `${requestHash}:${iterationN}`;
}

/**
 * Derive the cto-actor work-item key from the loop input. Honors the
 * forward-looking `requestHash` + `iterationN` fields when present;
 * otherwise falls back to `correlationId + ':0'` so the descriptor
 * remains deterministic on today's substrate.
 */
function identifyCtoWorkItem(input: AgentLoopInput): string {
  const ctoInput = input as CtoActorResumeInput;
  const requestHash = ctoInput.requestHash ?? input.correlationId;
  const iterationN = ctoInput.iterationN ?? 0;
  return `${requestHash}:${iterationN}`;
}

/**
 * Walk the supplied atom list to find resumable cto-actor sessions
 * scoped to the input work-item key. The two-axis filter
 * (`principal_id === 'cto-actor'` AND `request_hash:iteration_n`
 * matches) is enforced by `assembleActorCandidates` per spec section
 * 8.3.
 */
function assembleCtoCandidates(walk: ActorWalkInput): ReadonlyArray<CandidateSession> {
  return assembleActorCandidates(walk, CTO_ACTOR_PRINCIPAL_ID, extractCtoWorkItemKey);
}

/**
 * The descriptor the registry consumes. Conforms to Phase 1's
 * `ResumeStrategyDescriptor<TWalk, TCandidate, TInput>` shape
 * verbatim; `ladder` is empty in Phase 2 because strategy ladders
 * land in a later phase (per spec section 11.3 the policy atom
 * carries the ladder and is consumed by the runner).
 */
export const ctoActorResumeStrategyDescriptor: ResumeStrategyDescriptor<
  ActorWalkInput,
  CandidateSession,
  AgentLoopInput
> = {
  assembleCandidates: assembleCtoCandidates,
  identifyWorkItem: identifyCtoWorkItem,
  ladder: [],
};

/**
 * Stable list of work-item key prefixes this descriptor claims when
 * registered, used by `addDescriptor`'s collision ledger to keep the
 * cto-actor key namespace from being shadowed by another principal.
 *
 * The cto-actor key is `request_hash:iteration_n`; we register the
 * `cto-actor:` synthetic prefix so a future descriptor that tries to
 * register an overlapping prefix throws at registration time instead
 * of silently routing.
 */
export const CTO_ACTOR_WORK_ITEM_KEY_PREFIXES: ReadonlyArray<string> = ['cto-actor:request-hash'];
