/**
 * CodeAuthorActor: an outward actor that reifies the code-author
 * blast-radius fence.
 *
 * This is the skeleton that closes the last graduation criterion from
 * the fence ADR: with this actor plugged in, the four
 * `pol-code-author-*` atoms have a consumer that reads them, validates
 * their shape, and fails closed if any are missing, tainted, or
 * superseded. The graduation posture is "fence live + consumer live".
 *
 * Scope in this revision:
 *   - observe()   loads the fence via `loadCodeAuthorFence` and caches
 *                 it on the observation. A fence-load failure throws
 *                 out of observe and surfaces as an actor halt.
 *   - classify()  returns a fixed idle key so convergence detection
 *                 terminates the loop after one empty iteration.
 *   - propose()   returns no actions (no plan pickup yet).
 *   - apply()     never called (no allowed actions proposed).
 *   - reflect()   reports done:true so the run halts after one
 *                 iteration.
 *
 * This inert shape is intentional: the fence ADR mandates the
 * principal + fence + consumer ship together, and the actual
 * code-generation loop (plan pickup, LLM draft, PR creation, CI wait,
 * STOP revocation) is follow-up work. Each follow-up adds one axis
 * of behavior; the fence constraints it runs under are already
 * load-bearing because the loader shipped here surfaces them as
 * typed values.
 *
 * The tool names the propose phase will eventually expose for policy
 * matching are reserved in the fence atoms (`code-author-authorship`,
 * `code-author-per-pr-cost-cap`, `code-author-ci-gate`,
 * `code-author-write-revocation`) so a future revision adds
 * proposals without touching the fence.
 */

import type { Actor, ActorContext } from '../actor.js';
import type {
  ActorAdapters,
  Classified,
  ProposedAction,
  Reflection,
} from '../types.js';
import type { CodeAuthorFence } from './fence.js';
import { loadCodeAuthorFence } from './fence.js';

export interface CodeAuthorObservation {
  readonly fence: CodeAuthorFence;
}

// Uninhabitable action and outcome types: the skeleton never proposes
// an action, so `propose()` returns ReadonlyArray<never> and `apply()`
// is unreachable. Follow-up revisions widen these to real unions as
// plan-picker, LLM-draft, and PR-creation lands.
export type CodeAuthorAction = never;
export type CodeAuthorOutcome = never;

export type CodeAuthorAdapters = ActorAdapters;

/**
 * The actor. Generic over its adapter map; today no adapters are
 * required because observe / classify / propose complete without
 * external-system effects. Once a plan-picker adapter and a PR
 * adapter are plugged in (follow-up PRs), the adapter record
 * grows and the existing observe path extends to consume them.
 */
export class CodeAuthorActor implements Actor<
  CodeAuthorObservation,
  CodeAuthorAction,
  CodeAuthorOutcome,
  CodeAuthorAdapters
> {
  readonly name = 'code-author';
  readonly version = '0.1.0';

  async observe(ctx: ActorContext<CodeAuthorAdapters>): Promise<CodeAuthorObservation> {
    // Fail fast on a fence that is missing, tainted, or superseded.
    // A run that proceeds under a broken fence is exactly the class
    // of silent-fail the fence exists to close. The error bubbles
    // out of observe and halts the actor through runActor.
    const fence = await loadCodeAuthorFence(ctx.host.atoms);
    if (fence.warnings.length > 0) {
      await ctx.audit({
        kind: 'observation',
        payload: { fence_warnings: fence.warnings.slice() },
      });
    }
    return { fence };
  }

  async classify(
    observation: CodeAuthorObservation,
    _ctx: ActorContext<CodeAuthorAdapters>,
  ): Promise<Classified<CodeAuthorObservation>> {
    // One fixed key -- convergence detection halts after one empty
    // iteration. When plan pickup lands, this will partition by the
    // observed plan count so the loop progresses iteration-to-iteration.
    return {
      key: 'code-author-idle',
      observation,
    };
  }

  async propose(
    _classified: Classified<CodeAuthorObservation>,
    _ctx: ActorContext<CodeAuthorAdapters>,
  ): Promise<ReadonlyArray<ProposedAction<CodeAuthorAction>>> {
    return [];
  }

  async apply(
    _action: ProposedAction<CodeAuthorAction>,
    _ctx: ActorContext<CodeAuthorAdapters>,
  ): Promise<CodeAuthorOutcome> {
    // Unreachable: propose returns no actions, so runActor never calls
    // apply. Throwing rather than returning a stub makes the unreachable
    // branch loud if a future propose edit forgets to widen apply too.
    throw new Error('CodeAuthorActor.apply called with no proposed actions');
  }

  async reflect(
    _outcomes: ReadonlyArray<CodeAuthorOutcome>,
    _classified: Classified<CodeAuthorObservation>,
    _ctx: ActorContext<CodeAuthorAdapters>,
  ): Promise<Reflection> {
    // Skeleton halts after one iteration. A real plan-picker revision
    // will return done=false while plans remain and progress=true when
    // a plan is drafted into a PR.
    return { done: true, progress: false };
  }
}
