/**
 * Unit tests for scripts/lib/intent-approve-log.mjs.
 *
 * Pure helpers used by both scripts/run-cto-actor.mjs and
 * scripts/run-approval-cycle.mjs to render runIntentAutoApprovePass
 * result lines. The extraction is at n=2 per
 * dev-code-duplication-extract-at-n2; pinning the format here is the
 * canonical test surface so future call sites (a cpo-actor runner, an
 * org-ceiling deployment's custom driver) inherit the exact same shape.
 */

import { describe, expect, it } from 'vitest';
import {
  formatIntentApproveResult,
  formatRejectedFragment,
  formatSkippedFragment,
} from '../../scripts/lib/intent-approve-log.mjs';

describe('formatRejectedFragment', () => {
  it('returns " rejected=0" when no rejections', () => {
    expect(formatRejectedFragment(0, {})).toBe(' rejected=0');
  });

  it('returns " rejected=N" without breakdown when rejectedByReason is empty', () => {
    expect(formatRejectedFragment(3, {})).toBe(' rejected=3');
  });

  it('renders per-reason breakdown when rejections > 0 AND breakdown non-empty', () => {
    expect(formatRejectedFragment(2, { expired_intent: 2 })).toBe(
      ' rejected=2 (expired_intent=2)',
    );
  });

  it('omits zero-count entries from breakdown', () => {
    expect(
      formatRejectedFragment(1, { expired_intent: 1, tainted_intent: 0, principal_not_whitelisted: 0 }),
    ).toBe(' rejected=1 (expired_intent=1)');
  });

  it('renders multiple reasons space-separated in insertion order', () => {
    expect(
      formatRejectedFragment(3, { expired_intent: 1, tainted_intent: 2 }),
    ).toBe(' rejected=3 (expired_intent=1 tainted_intent=2)');
  });

  it('handles missing rejectedByReason (null/undefined) -> no breakdown', () => {
    expect(formatRejectedFragment(2, null)).toBe(' rejected=2');
    expect(formatRejectedFragment(2, undefined)).toBe(' rejected=2');
  });
});

describe('formatSkippedFragment', () => {
  it('returns empty string when skipped=0 (clean ticks stay terse)', () => {
    expect(formatSkippedFragment(0, {})).toBe('');
  });

  it('returns " skipped=N" without breakdown when skippedByReason is empty', () => {
    expect(formatSkippedFragment(1, {})).toBe(' skipped=1');
  });

  it('renders per-reason breakdown when skips > 0 AND breakdown non-empty', () => {
    expect(
      formatSkippedFragment(1, { delegation_radius_exceeds_envelope: 1 }),
    ).toBe(' skipped=1 (delegation_radius_exceeds_envelope=1)');
  });

  it('omits zero-count entries from breakdown', () => {
    expect(
      formatSkippedFragment(2, {
        delegation_radius_exceeds_envelope: 1,
        below_min_confidence: 1,
        sub_actor_not_allowed: 0,
      }),
    ).toBe(' skipped=2 (delegation_radius_exceeds_envelope=1 below_min_confidence=1)');
  });

  it('handles missing skippedByReason -> no breakdown', () => {
    expect(formatSkippedFragment(2, null)).toBe(' skipped=2');
    expect(formatSkippedFragment(2, undefined)).toBe(' skipped=2');
  });
});

describe('formatIntentApproveResult', () => {
  it('renders a clean approve-only line', () => {
    expect(
      formatIntentApproveResult({
        scanned: 5,
        approved: 5,
        rejected: 0,
        rejectedByReason: {},
        skipped: 0,
        skippedByReason: {},
      }),
    ).toBe('scanned=5 approved=5 rejected=0');
  });

  it('renders both rejected and skipped breakdowns when present', () => {
    expect(
      formatIntentApproveResult({
        scanned: 4,
        approved: 1,
        rejected: 2,
        rejectedByReason: { expired_intent: 2 },
        skipped: 1,
        skippedByReason: { below_min_confidence: 1 },
      }),
    ).toBe('scanned=4 approved=1 rejected=2 (expired_intent=2) skipped=1 (below_min_confidence=1)');
  });

  it('handles missing fields gracefully (defaults to zeros)', () => {
    expect(formatIntentApproveResult({})).toBe('scanned=0 approved=0 rejected=0');
  });

  it('handles null result -> all zeros', () => {
    expect(formatIntentApproveResult(null)).toBe('scanned=0 approved=0 rejected=0');
  });

  it('regression: 2026-05-12 bug shape -- bare rejected=N when intents are expired', () => {
    // Mirrors the actual run-approval-cycle output observed on
    // 2026-05-12 with 2 expired intents in the atom store: the bug
    // spec reported scanned=2 approved=0 rejected=2 without surfaced
    // reasons. This formatter must surface the per-reason breakdown
    // when rejectedByReason carries counts.
    expect(
      formatIntentApproveResult({
        scanned: 2,
        approved: 0,
        rejected: 2,
        rejectedByReason: { expired_intent: 2 },
        skipped: 0,
        skippedByReason: {},
      }),
    ).toBe('scanned=2 approved=0 rejected=2 (expired_intent=2)');
  });
});
