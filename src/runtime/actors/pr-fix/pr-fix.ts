/**
 * PrFixActor: an outward Actor that drives a PR through review-feedback
 * fix iterations via the agent-loop substrate seam.
 *
 * Loop (this task ships only `observe`; the rest land in subsequent tasks):
 *   observe  -> read PR review status (line comments + body nits + checks +
 *               legacy statuses + mergeable flag) and the PR head ref/SHA;
 *               write a `pr-fix-observation` atom that captures the snapshot
 *               and chains via `provenance.derived_from` to the prior
 *               observation for the same PR.
 *   classify -> partition findings, detect convergence, propagate `partial`.
 *   propose  -> delegate fixes to an agent-loop run, or escalate.
 *   apply    -> dispatch the agent-loop run and verify the resulting commit.
 *   reflect  -> halt when the PR is clean or escalation has happened.
 *
 * This module stays mechanism-only: it does not name specific actor
 * instances or canon ids. The atom shape lives in `../../../substrate/types.js`
 * and the atom builder in `./pr-fix-observation.js`; this actor only
 * orchestrates them.
 */

import type { Actor, ActorContext } from '../actor.js';
import type { Classified, ProposedAction, Reflection } from '../types.js';
import type { AtomId, PrFixObservationMeta } from '../../../substrate/types.js';
import type { PrIdentifier } from '../pr-review/adapter.js';
import type {
  PrFixObservation,
  PrFixAction,
  PrFixOutcome,
  PrFixAdapters,
} from './types.js';
import { mkPrFixObservationAtom, mkPrFixObservationAtomId } from './pr-fix-observation.js';

export interface PrFixOptions {
  readonly pr: PrIdentifier;
  /**
   * Optional clock injection point for deterministic tests. Defaults to
   * `() => new Date().toISOString()`.
   */
  readonly now?: () => string;
}

const defaultNow = (): string => new Date().toISOString();

export class PrFixActor implements Actor<
  PrFixObservation,
  PrFixAction,
  PrFixOutcome,
  PrFixAdapters
> {
  readonly name = 'pr-fix-actor';
  readonly version = '1';

  private lastObservationId: AtomId | undefined;

  constructor(private readonly options: PrFixOptions) {}

  async observe(ctx: ActorContext<PrFixAdapters>): Promise<PrFixObservation> {
    const { review, ghClient } = ctx.adapters;
    const status = await review.getPrReviewStatus(this.options.pr);

    const prDetails = await ghClient.rest<{
      head: { ref: string; sha: string };
      base: { ref: string };
    }>({
      path: `repos/${this.options.pr.owner}/${this.options.pr.repo}/pulls/${this.options.pr.number}`,
      signal: ctx.abortSignal,
    });
    if (prDetails === undefined) {
      throw new Error(
        `pulls.get returned no body for ${this.options.pr.owner}/${this.options.pr.repo}#${this.options.pr.number}`,
      );
    }

    const obsId = mkPrFixObservationAtomId();
    const meta: PrFixObservationMeta = {
      pr_owner: this.options.pr.owner,
      pr_repo: this.options.pr.repo,
      pr_number: this.options.pr.number,
      head_branch: prDetails.head.ref,
      head_sha: prDetails.head.sha,
      cr_review_states: status.submittedReviews.map((r) => ({
        author: r.author,
        state: r.state,
        submitted_at: r.submittedAt,
      })),
      merge_state_status: status.mergeStateStatus,
      mergeable: status.mergeable,
      line_comment_count: status.lineComments.length,
      body_nit_count: status.bodyNits.length,
      check_run_failure_count: status.checkRuns.filter(
        (c) => c.status === 'completed' && c.conclusion === 'failure',
      ).length,
      legacy_status_failure_count: status.legacyStatuses.filter(
        (s) => s.state === 'failure' || s.state === 'error',
      ).length,
      partial: status.partial,
      // Placeholder; classify() patches this in metadata after observe runs.
      classification: 'has-findings',
    };

    const now = (this.options.now ?? defaultNow)();
    const atom = mkPrFixObservationAtom({
      principal: ctx.principal.id,
      observationId: obsId,
      meta,
      priorObservationAtomId: this.lastObservationId,
      dispatchedSessionAtomId: undefined,
      now,
    });
    await ctx.host.atoms.put(atom);
    this.lastObservationId = obsId;

    return {
      pr: this.options.pr,
      headBranch: prDetails.head.ref,
      headSha: prDetails.head.sha,
      baseRef: prDetails.base.ref,
      lineComments: status.lineComments,
      bodyNits: status.bodyNits,
      submittedReviews: status.submittedReviews,
      checkRuns: status.checkRuns,
      legacyStatuses: status.legacyStatuses,
      mergeStateStatus: status.mergeStateStatus,
      mergeable: status.mergeable,
      partial: status.partial,
      observationAtomId: obsId,
    };
  }

  // The remaining lifecycle methods are filled in by subsequent tasks.

  async classify(
    _obs: PrFixObservation,
    _ctx: ActorContext<PrFixAdapters>,
  ): Promise<Classified<PrFixObservation>> {
    throw new Error('PrFixActor.classify: not implemented (Task 7)');
  }

  async propose(
    _classified: Classified<PrFixObservation>,
    _ctx: ActorContext<PrFixAdapters>,
  ): Promise<ReadonlyArray<ProposedAction<PrFixAction>>> {
    throw new Error('PrFixActor.propose: not implemented (Task 8)');
  }

  async apply(
    _action: ProposedAction<PrFixAction>,
    _ctx: ActorContext<PrFixAdapters>,
  ): Promise<PrFixOutcome> {
    throw new Error('PrFixActor.apply: not implemented (Tasks 9-10)');
  }

  async reflect(
    _outcomes: ReadonlyArray<PrFixOutcome>,
    _classified: Classified<PrFixObservation>,
    _ctx: ActorContext<PrFixAdapters>,
  ): Promise<Reflection> {
    throw new Error('PrFixActor.reflect: not implemented (Task 11)');
  }
}
