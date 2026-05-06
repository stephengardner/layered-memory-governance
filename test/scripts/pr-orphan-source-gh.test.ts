/**
 * Tests for the open-PR source helper. Pure logic: only the
 * `computeLastActivityAt` merge function is unit-tested; the
 * GraphQL spawn path is integration-tested at the deployment
 * boundary (no good unit-level seam without mocking child_process).
 */
import { describe, expect, it } from 'vitest';

// @ts-expect-error - .mjs helper imported from .ts test (vitest+esbuild
//   handle this on Windows-CI per the shebang-free-import pattern in
//   feedback_shebang_import_from_tests; the helper has no shebang).
import { computeLastActivityAt } from '../../scripts/lib/pr-orphan-source-gh.mjs';

describe('computeLastActivityAt', () => {
  it('returns null for malformed input', () => {
    expect(computeLastActivityAt(null)).toBeNull();
    expect(computeLastActivityAt(undefined)).toBeNull();
    expect(computeLastActivityAt({})).toBeNull();
  });

  it('returns updatedAt when only updatedAt is set', () => {
    const node = { updatedAt: '2026-05-06T00:30:00.000Z' };
    expect(computeLastActivityAt(node)).toBe('2026-05-06T00:30:00.000Z');
  });

  it('picks the most recent across all sources', () => {
    const node = {
      updatedAt: '2026-05-06T00:00:00.000Z',
      commits: { nodes: [{ commit: { committedDate: '2026-05-06T00:30:00.000Z' } }] },
      latestReviews: { nodes: [{ submittedAt: '2026-05-06T00:15:00.000Z' }] },
      comments: { nodes: [{ updatedAt: '2026-05-06T00:45:00.000Z' }] },
    };
    expect(computeLastActivityAt(node)).toBe('2026-05-06T00:45:00.000Z');
  });

  it('falls back to authoredDate when committedDate absent', () => {
    const node = {
      updatedAt: '2026-05-06T00:00:00.000Z',
      commits: { nodes: [{ commit: { authoredDate: '2026-05-06T00:30:00.000Z' } }] },
    };
    expect(computeLastActivityAt(node)).toBe('2026-05-06T00:30:00.000Z');
  });

  it('skips fields whose value is malformed', () => {
    const node = {
      updatedAt: '2026-05-06T00:00:00.000Z',
      commits: { nodes: [{ commit: { committedDate: 'not-a-date' } }] },
      latestReviews: { nodes: [{ submittedAt: 12345 }] },
    };
    expect(computeLastActivityAt(node)).toBe('2026-05-06T00:00:00.000Z');
  });

  it('returns null when every candidate is malformed', () => {
    const node = {
      updatedAt: 'not-a-date',
      commits: { nodes: [{ commit: { committedDate: 'also-not-a-date' } }] },
    };
    expect(computeLastActivityAt(node)).toBeNull();
  });
});
