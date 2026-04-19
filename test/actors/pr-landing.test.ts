/**
 * PrLandingActor tests (Phase 53a).
 *
 * Covers:
 *   - observe lists unresolved comments from the adapter
 *   - classify partitions nit / suggestion / architectural
 *   - propose emits reply action + resolve action for nits,
 *     reply-only for suggestions and architectural
 *   - apply dispatches to adapter methods correctly
 *   - reflect reports done when the PR has zero comments
 *   - end-to-end composition via runActor: a PR with one nit converges
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { runActor } from '../../src/actors/run-actor.js';
import { PrLandingActor } from '../../src/actors/pr-landing/pr-landing.js';
import type {
  PrIdentifier,
  PrReviewAdapter,
  ReviewComment,
  ReviewReplyOutcome,
} from '../../src/actors/pr-review/adapter.js';
import { samplePrincipal } from '../fixtures.js';

const PR: PrIdentifier = { owner: 'o', repo: 'r', number: 1 };

function mkComment(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: `c${Math.random().toString(36).slice(2, 8)}`,
    author: 'coderabbit',
    body: 'nit: use const instead of let',
    createdAt: '2026-04-19T00:00:00.000Z',
    resolved: false,
    ...over,
  };
}

class StubReviewAdapter implements PrReviewAdapter {
  readonly name = 'stub-review';
  readonly version = '0';
  replies: Array<{ commentId: string; body: string }> = [];
  resolvedIds: string[] = [];

  constructor(private commentsByIteration: ReviewComment[][]) {}

  private iter = 0;
  async listUnresolvedComments(): Promise<ReadonlyArray<ReviewComment>> {
    const list = this.commentsByIteration[this.iter] ?? [];
    this.iter++;
    return list;
  }
  async replyToComment(_pr: PrIdentifier, commentId: string, body: string): Promise<ReviewReplyOutcome> {
    this.replies.push({ commentId, body });
    return { commentId, replyId: `r${this.replies.length}`, posted: true };
  }
  async resolveComment(_pr: PrIdentifier, commentId: string): Promise<void> {
    this.resolvedIds.push(commentId);
  }
}

describe('PrLandingActor', () => {
  it('produces reply + resolve for a nit comment on a first pass', async () => {
    const host = createMemoryHost();
    const comment = mkComment({ id: 'nit1', body: 'nit: small typo', severity: 'nit' });
    const review = new StubReviewAdapter([[comment], []]);
    const actor = new PrLandingActor({ pr: PR });

    const report = await runActor(actor, {
      host,
      principal: samplePrincipal(),
      adapters: { review },
      budget: { maxIterations: 3 },
      origin: 'scheduled',
    });

    expect(report.haltReason).toBe('converged');
    expect(review.replies).toHaveLength(1);
    expect(review.replies[0]!.commentId).toBe('nit1');
    expect(review.resolvedIds).toEqual(['nit1']);
  });

  it('surfaces architectural comments as a separate tool class', async () => {
    const host = createMemoryHost();
    const comment = mkComment({
      id: 'arch1',
      body: 'Consider refactoring this architecture to avoid the central registry',
      severity: 'architectural',
    });
    const review = new StubReviewAdapter([[comment], []]);
    const actor = new PrLandingActor({ pr: PR });

    const report = await runActor(actor, {
      host,
      principal: samplePrincipal(),
      adapters: { review },
      budget: { maxIterations: 3 },
      origin: 'scheduled',
    });

    // With no policy atoms, architectural reply is default-allowed.
    // Result: one reply, NO resolve (architectural is not auto-resolved).
    expect(report.haltReason).toBe('converged');
    expect(review.replies).toHaveLength(1);
    expect(review.resolvedIds).toEqual([]);
  });

  it('converges immediately when there are no unresolved comments', async () => {
    const host = createMemoryHost();
    const review = new StubReviewAdapter([[]]);
    const actor = new PrLandingActor({ pr: PR });

    const report = await runActor(actor, {
      host,
      principal: samplePrincipal(),
      adapters: { review },
      budget: { maxIterations: 5 },
      origin: 'scheduled',
    });

    expect(report.haltReason).toBe('converged');
    expect(report.iterations).toBe(1);
    expect(review.replies).toHaveLength(0);
  });

  it('classify key changes when comment counts change across iterations', async () => {
    const host = createMemoryHost();
    const c1 = mkComment({ id: 'n1', severity: 'nit' });
    const c2 = mkComment({ id: 'n2', severity: 'nit' });
    const review = new StubReviewAdapter([[c1, c2], [c1], []]);
    const actor = new PrLandingActor({ pr: PR });

    const report = await runActor(actor, {
      host,
      principal: samplePrincipal(),
      adapters: { review },
      budget: { maxIterations: 5 },
      origin: 'scheduled',
    });

    // Iteration 1: 2 nits -> 2 replies + 2 resolves
    // Iteration 2: 1 nit  -> 1 reply  + 1 resolve
    // Iteration 3: 0 nits -> converged immediately
    expect(report.haltReason).toBe('converged');
    expect(review.replies.length).toBe(3);
    expect(review.resolvedIds.length).toBe(3);
  });
});
