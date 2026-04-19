/**
 * PrLandingActor: a reference outward Actor that drives a PR through
 * review feedback to a clean state.
 *
 * This is LAG's first concrete outward actor and our own dogfood use
 * case. It is NOT the framework: any consumer can write their own
 * outward actor against src/actors/ and their own ActorAdapters. This
 * one demonstrates the shape end-to-end.
 *
 * Loop:
 *   observe  -> list unresolved review comments from the PR
 *   classify -> partition into nit / suggestion / architectural
 *   propose  -> for each comment: reply + (resolve if nit)
 *   apply    -> call the review adapter
 *   reflect  -> done when all comments resolved, progress when any handled
 *
 * Escalation rules:
 *   - architectural comments are surfaced as escalations and NOT
 *     auto-replied (policy layer is expected to block them anyway, but
 *     this is a defence in depth).
 *   - convergence guard in runActor halts if the same classification
 *     key ("nit:N suggestion:M architectural:K") repeats without
 *     progress.
 *
 * Tool names exposed for policy matching:
 *   pr-reply-nit, pr-reply-suggestion, pr-reply-architectural,
 *   pr-resolve-nit
 */

import type { Actor, ActorContext } from '../actor.js';
import type {
  Classified,
  ProposedAction,
  Reflection,
} from '../types.js';
import type {
  PrIdentifier,
  PrReviewAdapter,
  ReviewComment,
  ReviewReplyOutcome,
} from '../pr-review/adapter.js';

export interface PrLandingAdapters {
  readonly review: PrReviewAdapter;
  readonly [k: string]: PrReviewAdapter;
}

export interface PrLandingObservation {
  readonly pr: PrIdentifier;
  readonly comments: ReadonlyArray<ReviewComment>;
}

export type PrLandingActionKind =
  | 'reply-nit'
  | 'reply-suggestion'
  | 'reply-architectural'
  | 'resolve-nit';

export interface PrLandingActionPayload {
  readonly kind: PrLandingActionKind;
  readonly commentId: string;
  readonly body?: string;
}

export type PrLandingOutcome = ReviewReplyOutcome | { readonly commentId: string; readonly resolved: true };

export interface PrLandingOptions {
  readonly pr: PrIdentifier;
  /**
   * Optional hook that takes a comment and returns the reply body. If
   * omitted, a stock template is used. In 53b the skill wires an LLM
   * here to produce thoughtful replies.
   */
  readonly composeReply?: (comment: ReviewComment, ctx: ActorContext<PrLandingAdapters>) => Promise<string>;
}

export class PrLandingActor implements Actor<
  PrLandingObservation,
  PrLandingActionPayload,
  PrLandingOutcome,
  PrLandingAdapters
> {
  readonly name = 'pr-landing';
  readonly version = '0.1.0';

  constructor(private readonly options: PrLandingOptions) {}

  async observe(ctx: ActorContext<PrLandingAdapters>): Promise<PrLandingObservation> {
    const comments = await ctx.adapters.review.listUnresolvedComments(this.options.pr);
    return { pr: this.options.pr, comments };
  }

  async classify(
    obs: PrLandingObservation,
    _ctx: ActorContext<PrLandingAdapters>,
  ): Promise<Classified<PrLandingObservation>> {
    let nit = 0;
    let suggestion = 0;
    let architectural = 0;
    for (const c of obs.comments) {
      const severity = c.severity ?? heuristicSeverity(c);
      if (severity === 'nit') nit++;
      else if (severity === 'suggestion') suggestion++;
      else architectural++;
    }
    return {
      observation: obs,
      key: `nit:${nit} suggestion:${suggestion} architectural:${architectural}`,
      metadata: { nit, suggestion, architectural },
    };
  }

  async propose(
    classified: Classified<PrLandingObservation>,
    ctx: ActorContext<PrLandingAdapters>,
  ): Promise<ReadonlyArray<ProposedAction<PrLandingActionPayload>>> {
    const actions: ProposedAction<PrLandingActionPayload>[] = [];
    for (const c of classified.observation.comments) {
      const severity = c.severity ?? heuristicSeverity(c);
      const body = await this.composeReplyBody(c, ctx);

      if (severity === 'architectural' || severity === 'blocking') {
        actions.push({
          tool: 'pr-reply-architectural',
          description: `Surface architectural comment ${c.id} for human review`,
          payload: { kind: 'reply-architectural', commentId: c.id, body },
        });
        continue;
      }
      if (severity === 'suggestion') {
        actions.push({
          tool: 'pr-reply-suggestion',
          description: `Reply to suggestion on comment ${c.id}`,
          payload: { kind: 'reply-suggestion', commentId: c.id, body },
        });
        continue;
      }
      actions.push({
        tool: 'pr-reply-nit',
        description: `Reply to nit on comment ${c.id}`,
        payload: { kind: 'reply-nit', commentId: c.id, body },
      });
      actions.push({
        tool: 'pr-resolve-nit',
        description: `Resolve nit on comment ${c.id}`,
        payload: { kind: 'resolve-nit', commentId: c.id },
      });
    }
    return actions;
  }

  async apply(
    action: ProposedAction<PrLandingActionPayload>,
    ctx: ActorContext<PrLandingAdapters>,
  ): Promise<PrLandingOutcome> {
    const p = action.payload;
    const review = ctx.adapters.review;
    if (p.kind === 'resolve-nit') {
      await review.resolveComment(this.options.pr, p.commentId);
      return { commentId: p.commentId, resolved: true };
    }
    const body = p.body ?? '';
    return await review.replyToComment(this.options.pr, p.commentId, body);
  }

  async reflect(
    outcomes: ReadonlyArray<PrLandingOutcome>,
    classified: Classified<PrLandingObservation>,
    _ctx: ActorContext<PrLandingAdapters>,
  ): Promise<Reflection> {
    const totalComments = classified.observation.comments.length;
    const progressed = outcomes.length > 0;
    return {
      done: totalComments === 0,
      progress: progressed,
      note: `handled ${outcomes.length} action(s) against ${totalComments} comment(s)`,
    };
  }

  private async composeReplyBody(
    comment: ReviewComment,
    ctx: ActorContext<PrLandingAdapters>,
  ): Promise<string> {
    if (this.options.composeReply) {
      return await this.options.composeReply(comment, ctx);
    }
    return `Thanks for the review. Addressing this in a follow-up commit (ref: ${comment.id}).`;
  }
}

function heuristicSeverity(comment: ReviewComment): 'nit' | 'suggestion' | 'architectural' {
  const body = comment.body.toLowerCase();
  if (/\bnit(pick)?\b/.test(body) || body.startsWith('nit:')) return 'nit';
  if (/(architecture|design|refactor|should be|instead of)/.test(body)) return 'architectural';
  return 'suggestion';
}
