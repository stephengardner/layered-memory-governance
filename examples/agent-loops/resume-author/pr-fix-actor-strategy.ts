/**
 * Per-actor `ResumeStrategyDescriptor` for the `pr-fix-actor` principal.
 *
 * Phase 3 (this PR) supplies the registry-side descriptor that mirrors
 * the existing PR #171 wiring in `scripts/run-pr-fix.mjs`. The wrapper
 * that orchestrates the resume-or-fresh-spawn decision lives at
 * `loop.ts` (PR #171, unchanged); the registry primitive that selects
 * per-principal descriptors lives at `registry.ts` (PR #305, augmented
 * with adapter-bridge in this PR); the per-actor walks for cto-actor
 * and code-author live at their sibling `*-strategy.ts` files (PR #307,
 * unchanged).
 *
 * Work-item key shape
 * -------------------
 * The work-item key is `pr-fix:<owner>/<repo>#<number>` per spec
 * section 4.1. PR identity is the load-bearing scoping axis: a single
 * `.lag/` may contain agent-session atoms for many PRs, and resume
 * MUST scope to "this PR's prior session," never "any pr-fix-actor
 * session in the store."
 *
 * Read paths used here:
 *   - On `AgentLoopInput` extension `PrFixActorResumeInput`: optional
 *     `prOwner`, `prRepo`, `prNumber` fields. Forward-looking: today's
 *     `AgentLoopInput` shape (`src/substrate/agent-loop.ts`) does not
 *     carry PR identity; `PrFixActor` pins it via observation atoms,
 *     not via the loop input. The descriptor's `identifyWorkItem`
 *     reads the optional fields when present and falls back to
 *     `correlationId` so the descriptor remains deterministic on
 *     today's substrate. A future substrate PR that surfaces the
 *     fields snaps in without touching this file.
 *   - On observation atoms: PR identity lives at
 *     `metadata.pr_fix_observation.{pr_owner, pr_repo, pr_number}`
 *     (see `src/runtime/actors/pr-fix/types.ts`). The synchronous
 *     walker in `walk-author-sessions.ts` reads it.
 *
 * Two-axis filter
 * ---------------
 * Per spec section 8.3 the walk enforces two axes:
 *   1. `principal_id === 'pr-fix-actor'` (actor scope)
 *   2. PR identity matches the input work-item key (work-item scope)
 *
 * Both axes MUST pass; relying on work-item key uniqueness alone is
 * fragile. The walker enforces both before projecting an atom into
 * a candidate.
 *
 * Fresh-spawn fallback
 * --------------------
 * Per spec section 6.4, fresh-spawn fallback shapes are: empty
 * candidate list -> wrapper delegates directly to fallback adapter;
 * `identifyWorkItem` returning a deterministic key (the
 * `pr-fix:<owner>/<repo>#<number>` string, never null) so the wrapper
 * still runs the walk and lands in fresh-spawn cleanly when no prior
 * session matches.
 */

import type { AgentLoopInput } from '../../../src/substrate/agent-loop.js';
import type { PrincipalId } from '../../../src/substrate/types.js';
import type { CandidateSession } from './types.js';
import type { ResumeStrategyDescriptor } from './registry.js';
import {
  type PrFixWalkInput,
  walkAuthorSessionsForPrFix,
} from './walk-author-sessions.js';

export const PR_FIX_ACTOR_PRINCIPAL_ID = 'pr-fix-actor' as PrincipalId;

/**
 * Forward-looking input shape: a pr-fix dispatch carries the
 * `prOwner`, `prRepo`, `prNumber` so the registry can route resume
 * traffic to the correct PR. The fields are optional today; a future
 * substrate PR makes them required and threads them through the loop
 * runner.
 *
 * Keeping the fields optional (rather than required) lets the
 * descriptor stay backward-compatible with today's `AgentLoopInput`
 * (`src/substrate/agent-loop.ts`) which does not yet carry PR
 * identity. The optional fields document the intended read path so a
 * future substrate edit that adds PR identity to AgentLoopInput
 * (or threads it via a typed extension) snaps in without touching
 * this file.
 */
export interface PrFixActorResumeInput extends AgentLoopInput {
  readonly prOwner?: string;
  readonly prRepo?: string;
  readonly prNumber?: number;
}

/**
 * Encode a PR identity tuple as a stable work-item key string.
 * Shared between `identifyWorkItem` (input -> key) and the walker
 * (atom -> key) so a typo-mismatch produces an immediate test
 * failure instead of a silent miss.
 */
export function encodePrFixWorkItemKey(owner: string, repo: string, number: number): string {
  return `pr-fix:${owner}/${repo}#${number}`;
}

/**
 * Derive the pr-fix-actor work-item key from the loop input. Honors
 * the forward-looking `prOwner` + `prRepo` + `prNumber` fields when
 * present; otherwise falls back to a `pr-fix:<correlationId>` key so
 * the descriptor remains deterministic on today's substrate.
 *
 * The fallback key is intentionally distinct from any owner/repo/
 * number-shaped key (the literal string includes the runner's
 * `correlationId`), so a fallback key can never collide with a
 * resolved key. A pre-substrate-PR runner gets fresh-spawn behavior
 * because no prior session atom encodes a matching `pr-fix:<corr-id>`
 * key; once the substrate threads PR identity through, the descriptor
 * resolves to the canonical owner/repo/number key and resume engages.
 */
function identifyPrFixWorkItem(input: AgentLoopInput): string {
  const ext = input as PrFixActorResumeInput;
  if (
    typeof ext.prOwner === 'string'
    && typeof ext.prRepo === 'string'
    && typeof ext.prNumber === 'number'
  ) {
    return encodePrFixWorkItemKey(ext.prOwner, ext.prRepo, ext.prNumber);
  }
  return `pr-fix:${input.correlationId}`;
}

/**
 * Walk the supplied atom list to find resumable pr-fix-actor sessions
 * scoped to the input work-item key. Two-axis filter:
 *   - `principal_id === 'pr-fix-actor'`  (actor scope)
 *   - observation chain matches `(pr_owner, pr_repo, pr_number)` (work-item scope)
 *
 * Implementation delegates to `walkAuthorSessionsForPrFix` in
 * `walk-author-sessions.ts`, which performs the synchronous chain
 * traversal over a pre-fetched atom list. The runner script is
 * responsible for fetching the relevant atoms (recent observation
 * atoms keyed by PR identity + their dispatched agent-session atoms)
 * and packaging them into the `PrFixWalkInput` payload.
 */
function assemblePrFixCandidates(walk: PrFixWalkInput): ReadonlyArray<CandidateSession> {
  return walkAuthorSessionsForPrFix(walk);
}

/**
 * The descriptor the registry consumes. Conforms to Phase 1's
 * `ResumeStrategyDescriptor<TWalk, TCandidate, TInput>` shape
 * verbatim; `ladder` is empty in Phase 3 because strategy ladders
 * land in the registry-bridge wrap step (the bridge constructs
 * `SameMachineCliResumeStrategy` from the canon policy or runner
 * configuration, mirroring today's `run-pr-fix.mjs` wiring).
 */
export const prFixActorResumeStrategyDescriptor: ResumeStrategyDescriptor<
  PrFixWalkInput,
  CandidateSession,
  AgentLoopInput
> = {
  assembleCandidates: assemblePrFixCandidates,
  identifyWorkItem: identifyPrFixWorkItem,
  ladder: [],
};

/**
 * Stable list of work-item key prefixes this descriptor claims when
 * registered, used by `addDescriptor`'s collision ledger to keep the
 * pr-fix-actor key namespace from being shadowed by another principal.
 *
 * The pr-fix-actor key shape is `pr-fix:<owner>/<repo>#<number>`; we
 * register the `pr-fix:` synthetic prefix so a future descriptor that
 * tries to register the same prefix throws at registration time
 * instead of silently routing.
 */
export const PR_FIX_ACTOR_WORK_ITEM_KEY_PREFIXES: ReadonlyArray<string> = ['pr-fix:'];
