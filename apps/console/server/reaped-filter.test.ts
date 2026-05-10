import { describe, it, expect } from 'vitest';
import { isReaped, applyReapedFilter, type ReapedFilterAtom } from './reaped-filter';

/*
 * Pure-function tests for the reaped-atom projection filter. The
 * server's HTTP route is a thin wrapper around `applyReapedFilter`;
 * once the predicate + filter are exercised here, the route handler
 * test only needs to confirm wiring (param parsing, response shape)
 * rather than re-test the predicate.
 */

describe('isReaped', () => {
  it('returns false for atoms with no metadata', () => {
    expect(isReaped({})).toBe(false);
  });

  it('returns false for atoms with metadata but no reaped_at', () => {
    expect(isReaped({ metadata: { kind: 'pipeline' } })).toBe(false);
  });

  it('returns true for atoms with metadata.reaped_at as a non-empty string', () => {
    expect(isReaped({ metadata: { reaped_at: '2026-05-09T12:00:00.000Z' } })).toBe(true);
  });

  it('returns false for empty-string reaped_at (defensive)', () => {
    /*
     * Empty string would be a malformed write. Treating it as
     * NOT-reaped fails open: the atom stays visible rather than
     * silently hiding. Substrate conformance (atoms-spec.ts) enforces
     * the ISO format; this is projection-side defense-in-depth.
     */
    expect(isReaped({ metadata: { reaped_at: '' } })).toBe(false);
  });

  it('returns false for non-string reaped_at (defensive)', () => {
    expect(isReaped({ metadata: { reaped_at: 1234567890 as unknown as string } })).toBe(false);
    expect(isReaped({ metadata: { reaped_at: null as unknown as string } })).toBe(false);
    expect(isReaped({ metadata: { reaped_at: { iso: '2026-05-09T12:00:00.000Z' } as unknown as string } })).toBe(false);
  });
});

describe('applyReapedFilter', () => {
  /*
   * Mixed input set: 2 live + 3 reaped + 1 live (interleaved so the
   * order-preservation assertion is meaningful).
   */
  const SAMPLE: ReadonlyArray<ReapedFilterAtom & { id: string }> = [
    { id: 'live-1' },
    { id: 'reaped-1', metadata: { reaped_at: '2026-05-09T11:00:00.000Z', reaped_reason: 'terminal-pipeline-ttl' } },
    { id: 'live-2' },
    { id: 'reaped-2', metadata: { reaped_at: '2026-05-09T11:05:00.000Z', reaped_reason: 'stage-event-ttl' } },
    { id: 'reaped-3', metadata: { reaped_at: '2026-05-09T11:10:00.000Z', reaped_reason: 'terminal-pipeline-ttl' } },
    { id: 'live-3' },
  ];

  it('hides reaped atoms by default (includeReaped=false)', () => {
    const r = applyReapedFilter(SAMPLE, false);
    expect(r.atoms.map((a) => a.id)).toEqual(['live-1', 'live-2', 'live-3']);
    expect(r.reaped_count).toBe(3);
  });

  it('passes through reaped atoms when includeReaped=true', () => {
    const r = applyReapedFilter(SAMPLE, true);
    expect(r.atoms.map((a) => a.id)).toEqual([
      'live-1', 'reaped-1', 'live-2', 'reaped-2', 'reaped-3', 'live-3',
    ]);
    expect(r.reaped_count).toBe(3);
  });

  it('preserves input order (no implicit sort)', () => {
    /*
     * Order preservation matters because callers (handleActivitiesList)
     * sort by created_at DESC before applying this filter. A re-sort
     * here would silently break that contract.
     */
    const reverse = [...SAMPLE].reverse();
    const r = applyReapedFilter(reverse, false);
    expect(r.atoms.map((a) => a.id)).toEqual(['live-3', 'live-2', 'live-1']);
  });

  it('handles empty input', () => {
    const r = applyReapedFilter([], false);
    expect(r.atoms).toEqual([]);
    expect(r.reaped_count).toBe(0);
  });

  it('handles all-reaped input', () => {
    const allReaped: ReadonlyArray<ReapedFilterAtom & { id: string }> = [
      { id: 'r1', metadata: { reaped_at: '2026-05-09T11:00:00.000Z' } },
      { id: 'r2', metadata: { reaped_at: '2026-05-09T11:05:00.000Z' } },
    ];
    const hidden = applyReapedFilter(allReaped, false);
    expect(hidden.atoms).toEqual([]);
    expect(hidden.reaped_count).toBe(2);

    const shown = applyReapedFilter(allReaped, true);
    expect(shown.atoms.map((a) => a.id)).toEqual(['r1', 'r2']);
    expect(shown.reaped_count).toBe(2);
  });

  it('handles all-live input', () => {
    const allLive: ReadonlyArray<ReapedFilterAtom & { id: string }> = [
      { id: 'l1' },
      { id: 'l2', metadata: { kind: 'plan' } },
    ];
    const r = applyReapedFilter(allLive, false);
    expect(r.atoms.map((a) => a.id)).toEqual(['l1', 'l2']);
    expect(r.reaped_count).toBe(0);
  });
});
