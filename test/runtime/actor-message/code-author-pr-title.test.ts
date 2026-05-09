/**
 * Pin the Conventional-Commits PR-title contract for autonomous
 * code-author runs (canon `dev-pr-titles-conventional-commits`).
 *
 * Two call sites depend on the helper:
 *   - `agentic-code-author-executor.createPrViaGhClient`
 *   - `diff-based-code-author-executor.buildPrTitle`
 *
 * Both used to hardcode `code-author: <plan title>` which fails the
 * canon directive: PR titles MUST start with a Conventional Commits
 * type prefix. This test asserts the helper preserves an already-
 * conformant prefix and prepends `feat(autonomous):` otherwise, so a
 * future drift in either call site breaks the contract loud.
 */

import { describe, expect, it } from 'vitest';
import { buildConventionalCommitsPrTitle } from '../../../src/runtime/actor-message/code-author-pr-title.js';

describe('buildConventionalCommitsPrTitle', () => {
  describe('passes through plan titles that already conform', () => {
    it.each([
      'feat: add new authentication flow',
      'feat(console): render intent-outcome card',
      'fix: nil-pointer in pipeline reaper',
      'fix(autonomous-dispatch): handle 422 label-truncation',
      'docs: clarify substrate posture',
      'docs(framework): explain provenance chain',
      'chore(deps): bump zod to 3.22.4',
      'refactor(planning-pipeline): extract shared regex',
      'perf(atom-store): cache live-atom filter',
      'test(scripts): add bins-allowlist case',
      'build: pin tsc to 5.4.x',
      'ci: add cr-precheck workflow',
      'style: lint sweep',
      'revert: roll back PR #123',
    ])('returns "%s" unchanged', (title) => {
      expect(buildConventionalCommitsPrTitle(title)).toBe(title);
    });
  });

  describe('prepends feat(autonomous): when no conformant prefix is present', () => {
    it.each([
      ['Add new authentication flow', 'feat(autonomous): Add new authentication flow'],
      ['render intent-outcome card', 'feat(autonomous): render intent-outcome card'],
      ['plan plan-1234567890', 'feat(autonomous): plan plan-1234567890'],
      ['Update README', 'feat(autonomous): Update README'],
    ])('rewrites "%s" to "%s"', (input, expected) => {
      expect(buildConventionalCommitsPrTitle(input)).toBe(expected);
    });
  });

  describe('rejects misleading prefixes that look conventional but are not', () => {
    it.each([
      // Non-allowlist type (random word that ends with a colon).
      ['feature: add login', 'feat(autonomous): feature: add login'],
      // Type without a colon should not match (the trailing : is mandatory).
      ['feat add login', 'feat(autonomous): feat add login'],
      // Capital type should not match (Conventional Commits is lowercase).
      ['Feat: add login', 'feat(autonomous): Feat: add login'],
      // A type with empty body is not a conformant prefix.
      ['feat:', 'feat(autonomous): feat:'],
    ])('rewrites "%s" to "%s"', (input, expected) => {
      expect(buildConventionalCommitsPrTitle(input)).toBe(expected);
    });
  });

  it('returns a stable fallback when the title is empty', () => {
    expect(buildConventionalCommitsPrTitle('')).toBe('feat(autonomous): plan');
    expect(buildConventionalCommitsPrTitle('   ')).toBe('feat(autonomous): plan');
  });

  it('trims surrounding whitespace before matching the prefix', () => {
    expect(buildConventionalCommitsPrTitle('   feat: leading whitespace   '))
      .toBe('feat: leading whitespace');
  });
});
