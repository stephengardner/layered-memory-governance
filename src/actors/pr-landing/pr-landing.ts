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
  /**
   * True when at least one of the reviewers in options.ensureReviewers
   * has posted at least one comment on this PR. False means the bot
   * has not engaged and the actor should prompt it. Undefined if
   * ensureReviewers is not configured.
   */
  readonly reviewerEngaged?: boolean;
  /**
   * True when the pr-landing bot itself has ALREADY posted a top-level
   * comment on this PR. Used as an idempotency guard: don't post the
   * ensure-review prompt again if we already did. Defined only when
   * ensureReviewers is configured AND reviewerEngaged is false.
   */
  readonly selfAlreadyPrompted?: boolean;
}

export type PrLandingActionKind =
  | 'reply-nit'
  | 'reply-suggestion'
  | 'reply-architectural'
  | 'resolve-nit'
  | 'ensure-review';

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
   * omitted, a stock template is used. A follow-up phase will wire an
   * LLM here to produce thoughtful replies.
   */
  readonly composeReply?: (comment: ReviewComment, ctx: ActorContext<PrLandingAdapters>) => Promise<string>;
  /**
   * Reviewer logins to ensure have engaged on the PR. When set and the
   * adapter's hasReviewerEngaged returns false, the actor proposes an
   * `ensure-review` action that posts a prompt (e.g., for CodeRabbit,
   * a top-level `@coderabbitai review` comment). Once any of these
   * logins appears in comments, the actor moves on to handling
   * feedback. Default: no ensure-review behaviour.
   */
  readonly ensureReviewers?: ReadonlyArray<{
    /** Author logins considered equivalent (e.g. ['coderabbitai[bot]', 'coderabbitai']). */
    readonly logins: ReadonlyArray<string>;
    /** Body posted if none of the logins have engaged. */
    readonly promptBody: string;
    /** Human-readable name for audit + classification. */
    readonly label: string;
  }>;
  /**
   * Author logins whose prior top-level PR comments mean the actor has
   * already posted an ensure-review prompt and should not re-post.
   * Default: ['github-actions[bot]']. Set to [] to disable (testing).
   */
  readonly ensurePromptAuthors?: ReadonlyArray<string>;
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
    const base = { pr: this.options.pr, comments };
    if (!this.options.ensureReviewers || this.options.ensureReviewers.length === 0) {
      return base;
    }
    const allLogins = this.options.ensureReviewers.flatMap((r) => r.logins);
    const reviewerEngaged = await ctx.adapters.review.hasReviewerEngaged(
      this.options.pr,
      allLogins,
    );
    if (reviewerEngaged) {
      return { ...base, reviewerEngaged: true };
    }
    // Idempotency guard: if the pr-landing bot has already posted any
    // comment on this PR, assume we've already ensure-review'd and do
    // not post the prompt again. Without this, a slow reviewer bot
    // (CodeRabbit queued behind other repos) would cause us to re-prompt
    // every iteration, spamming the PR.
    const promptAuthors = this.options.ensurePromptAuthors ?? ['github-actions[bot]'];
    const selfAlreadyPrompted = promptAuthors.length === 0
      ? false
      : await ctx.adapters.review.hasReviewerEngaged(this.options.pr, promptAuthors);
    return { ...base, reviewerEngaged: false, selfAlreadyPrompted };
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
    const reviewerPending = obs.reviewerEngaged === false;
    const key = reviewerPending
      ? `ensure-review nit:${nit} suggestion:${suggestion} architectural:${architectural}`
      : `nit:${nit} suggestion:${suggestion} architectural:${architectural}`;
    return {
      observation: obs,
      key,
      metadata: { nit, suggestion, architectural, reviewerPending },
    };
  }

  async propose(
    classified: Classified<PrLandingObservation>,
    ctx: ActorContext<PrLandingAdapters>,
  ): Promise<ReadonlyArray<ProposedAction<PrLandingActionPayload>>> {
    const actions: ProposedAction<PrLandingActionPayload>[] = [];
    // Ensure-review actions come first: if the configured reviewer bot
    // hasn't engaged AND we haven't already posted a prompt ourselves,
    // prompt it before trying to handle its (absent) feedback. Once the
    // reviewer responds, subsequent iterations drop this class. If we
    // already prompted and the reviewer still hasn't responded, do NOT
    // re-post; let convergence-guard or deadline halt the run so the
    // operator can investigate.
    if (
      classified.observation.reviewerEngaged === false
      && !classified.observation.selfAlreadyPrompted
      && this.options.ensureReviewers
    ) {
      for (const spec of this.options.ensureReviewers) {
        actions.push({
          tool: 'pr-ensure-review',
          description: `Prompt ${spec.label} to review this PR`,
          payload: {
            kind: 'ensure-review',
            commentId: `ensure:${spec.label}`,
            body: spec.promptBody,
          },
        });
      }
    }
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
    if (p.kind === 'ensure-review') {
      const outcome = await review.postPrComment(this.options.pr, p.body ?? '');
      const base: ReviewReplyOutcome = {
        commentId: outcome.commentId ?? p.commentId,
        posted: outcome.posted,
      };
      const withReply = outcome.commentId === undefined
        ? base
        : { ...base, replyId: outcome.commentId };
      return outcome.dryRun === undefined
        ? withReply
        : { ...withReply, dryRun: outcome.dryRun };
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
    const reviewerPending = classified.observation.reviewerEngaged === false;
    const progressed = outcomes.length > 0;
    // Done = no comments AND no pending reviewer prompt. The ensure-review
    // path needs subsequent iterations to observe that the bot has now
    // engaged (or another run, if the bot is slow).
    return {
      done: totalComments === 0 && !reviewerPending,
      progress: progressed,
      note: `handled ${outcomes.length} action(s) against ${totalComments} comment(s)${reviewerPending ? '; reviewer prompt pending' : ''}`,
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
