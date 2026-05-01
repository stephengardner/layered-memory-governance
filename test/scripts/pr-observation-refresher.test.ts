/**
 * Unit tests for the deployment-side pr-observation refresher.
 *
 * Helper-only tests (no spawn). The full integration that invokes
 * run-pr-landing.mjs lives in the dogfeed validation step.
 */

import { describe, expect, it } from 'vitest';

import { validateRefreshArgs } from '../../scripts/lib/pr-observation-refresher.mjs';

describe('validateRefreshArgs', () => {
  it('accepts a well-formed refresh args object', () => {
    expect(
      validateRefreshArgs({ pr: { owner: 'a', repo: 'b', number: 1 }, plan_id: 'p' }),
    ).toBe(true);
  });

  it('rejects missing args', () => {
    expect(() => validateRefreshArgs(null)).toThrow();
    expect(() => validateRefreshArgs(undefined)).toThrow();
  });

  it('rejects missing or non-object pr', () => {
    expect(() => validateRefreshArgs({ pr: null, plan_id: 'p' })).toThrow();
    expect(() => validateRefreshArgs({ pr: 'string', plan_id: 'p' })).toThrow();
  });

  it('rejects missing or empty owner', () => {
    expect(() => validateRefreshArgs({ pr: { owner: '', repo: 'b', number: 1 }, plan_id: 'p' })).toThrow();
    expect(() => validateRefreshArgs({ pr: { repo: 'b', number: 1 }, plan_id: 'p' })).toThrow();
  });

  it('rejects missing or empty repo', () => {
    expect(() => validateRefreshArgs({ pr: { owner: 'a', repo: '', number: 1 }, plan_id: 'p' })).toThrow();
    expect(() => validateRefreshArgs({ pr: { owner: 'a', number: 1 }, plan_id: 'p' })).toThrow();
  });

  it('rejects non-positive, non-finite, or fractional number', () => {
    expect(() => validateRefreshArgs({ pr: { owner: 'a', repo: 'b', number: 0 }, plan_id: 'p' })).toThrow();
    expect(() => validateRefreshArgs({ pr: { owner: 'a', repo: 'b', number: -1 }, plan_id: 'p' })).toThrow();
    expect(() => validateRefreshArgs({ pr: { owner: 'a', repo: 'b', number: NaN }, plan_id: 'p' })).toThrow();
    expect(() => validateRefreshArgs({ pr: { owner: 'a', repo: 'b', number: 'one' }, plan_id: 'p' })).toThrow();
    // Fractional PR numbers are not real GitHub IDs; reject before the
    // adapter spawns run-pr-landing. CR finding (PR #277).
    expect(() => validateRefreshArgs({ pr: { owner: 'a', repo: 'b', number: 1.5 }, plan_id: 'p' })).toThrow();
  });

  it('rejects empty or non-string plan_id', () => {
    expect(() => validateRefreshArgs({ pr: { owner: 'a', repo: 'b', number: 1 }, plan_id: '' })).toThrow();
    expect(() => validateRefreshArgs({ pr: { owner: 'a', repo: 'b', number: 1 }, plan_id: 123 })).toThrow();
    expect(() => validateRefreshArgs({ pr: { owner: 'a', repo: 'b', number: 1 } })).toThrow();
  });
});
