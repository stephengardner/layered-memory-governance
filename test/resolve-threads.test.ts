import { describe, it, expect } from 'vitest';
import { classifyReviewThreads } from '../scripts/lib/resolve-threads.mjs';

describe('classifyReviewThreads', () => {
  it('returns three empty buckets for an empty input', () => {
    const r = classifyReviewThreads([]);
    expect(r.resolveTargets).toEqual([]);
    expect(r.stillCurrent).toEqual([]);
    expect(r.alreadyResolved).toEqual([]);
  });

  it('routes unresolved-outdated threads to resolveTargets', () => {
    const t = { id: 't1', isResolved: false, isOutdated: true, path: 'a.ts' };
    const r = classifyReviewThreads([t]);
    expect(r.resolveTargets).toEqual([t]);
    expect(r.stillCurrent).toEqual([]);
    expect(r.alreadyResolved).toEqual([]);
  });

  it('routes unresolved-current threads to stillCurrent', () => {
    const t = { id: 't2', isResolved: false, isOutdated: false, path: 'b.ts' };
    const r = classifyReviewThreads([t]);
    expect(r.resolveTargets).toEqual([]);
    expect(r.stillCurrent).toEqual([t]);
    expect(r.alreadyResolved).toEqual([]);
  });

  it('routes already-resolved threads to alreadyResolved regardless of outdated state', () => {
    const a = { id: 'a', isResolved: true, isOutdated: true, path: 'c.ts' };
    const b = { id: 'b', isResolved: true, isOutdated: false, path: 'c.ts' };
    const r = classifyReviewThreads([a, b]);
    expect(r.resolveTargets).toEqual([]);
    expect(r.stillCurrent).toEqual([]);
    expect(r.alreadyResolved).toEqual([a, b]);
  });

  it('handles a mixed bucket with stable order', () => {
    /*
     * The classifier must preserve insertion order within each
     * bucket so callers can correlate the resolve sequence with the
     * thread list returned by GraphQL (which orders by created_at).
     */
    const threads = [
      { id: '1', isResolved: false, isOutdated: true },
      { id: '2', isResolved: true, isOutdated: false },
      { id: '3', isResolved: false, isOutdated: false },
      { id: '4', isResolved: false, isOutdated: true },
      { id: '5', isResolved: true, isOutdated: true },
    ];
    const r = classifyReviewThreads(threads);
    expect(r.resolveTargets.map((t) => t.id)).toEqual(['1', '4']);
    expect(r.stillCurrent.map((t) => t.id)).toEqual(['3']);
    expect(r.alreadyResolved.map((t) => t.id)).toEqual(['2', '5']);
  });

  it('treats absent path as undefined without crashing', () => {
    /*
     * `path` is optional in GitHub's response; the classifier should
     * not depend on it.
     */
    const t = { id: 'no-path', isResolved: false, isOutdated: true };
    const r = classifyReviewThreads([t]);
    expect(r.resolveTargets).toEqual([t]);
  });
});
