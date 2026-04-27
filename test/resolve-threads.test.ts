import { describe, it, expect } from 'vitest';
import { classifyReviewThreads, parseResolveArgs } from '../scripts/lib/resolve-threads.mjs';

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

describe('parseResolveArgs', () => {
  it('parses a single pr number', () => {
    expect(parseResolveArgs(['229'])).toEqual({ pr: 229, dryRun: false, help: false, error: null });
  });

  it('parses --dry-run flag', () => {
    expect(parseResolveArgs(['229', '--dry-run'])).toEqual({ pr: 229, dryRun: true, help: false, error: null });
  });

  it('parses --help flag', () => {
    expect(parseResolveArgs(['--help'])).toEqual({ pr: null, dryRun: false, help: true, error: null });
  });

  it('parses -h alias as help', () => {
    expect(parseResolveArgs(['-h'])).toEqual({ pr: null, dryRun: false, help: true, error: null });
  });

  it('rejects multiple pr numbers loud rather than overwriting silently', () => {
    /*
     * Regression: `node scripts/resolve-outdated-threads.mjs 229 234`
     * would silently target 234. Once this script gets wired into
     * run-pr-fix.mjs / run-pr-landing.mjs, blind argv-forwarding by a
     * caller would cause the wrong PR's threads to get resolved.
     */
    const r = parseResolveArgs(['229', '234']);
    expect(r.error).toMatch(/multiple pr numbers/);
    expect(r.pr).toBe(229);
  });

  it('rejects unknown args', () => {
    const r = parseResolveArgs(['--bogus']);
    expect(r.error).toMatch(/unknown arg/);
  });

  it('handles empty argv (caller surfaces missing-pr error itself)', () => {
    expect(parseResolveArgs([])).toEqual({ pr: null, dryRun: false, help: false, error: null });
  });

  it('rejects repeated --dry-run loud rather than silently accepting', () => {
    /*
     * Symmetric with the duplicate-PR guard: blind argv-forwarding by a
     * caller (run-pr-fix.mjs / run-pr-landing.mjs / future actors)
     * should not mask a programming bug as silently-idempotent. Pin
     * that prior valid state survives the late error so callers that
     * inspect parsed fields after the error path do not see clobbered
     * state.
     */
    const r = parseResolveArgs(['229', '--dry-run', '--dry-run']);
    expect(r.error).toMatch(/multiple --dry-run/);
    expect(r.pr).toBe(229);
    expect(r.dryRun).toBe(true);
  });

  it('rejects repeated --help loud rather than silently accepting', () => {
    const r = parseResolveArgs(['--help', '--help']);
    expect(r.error).toMatch(/multiple --help/);
    expect(r.help).toBe(true);
  });
});
