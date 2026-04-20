/**
 * Tests for the CodeRabbit review-body parser.
 *
 * The fixture in `fixtures/coderabbit-review-body-pr48.md` is the real
 * review body posted on stephengardner/layered-autonomous-governance#48
 * by coderabbitai[bot]. Keeping the fixture as-is (not massaged) means
 * any upstream format drift surfaces here as a test failure rather than
 * silently dropping nits in production.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseCodeRabbitReviewBody } from '../../src/actors/pr-review/coderabbit-body-parser.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return readFileSync(resolve(FIXTURES, name), 'utf8');
}

describe('parseCodeRabbitReviewBody', () => {
  it('extracts actionable count from the preamble', () => {
    const out = parseCodeRabbitReviewBody(fixture('coderabbit-review-body-pr48.md'));
    expect(out.actionableCount).toBe(2);
  });

  it('extracts nitpick count from the summary header', () => {
    const out = parseCodeRabbitReviewBody(fixture('coderabbit-review-body-pr48.md'));
    expect(out.nitpickCount).toBe(3);
  });

  it('extracts all three nitpicks from the fixture with correct paths and lines', () => {
    const out = parseCodeRabbitReviewBody(fixture('coderabbit-review-body-pr48.md'));
    expect(out.nitpicks.length).toBe(3);

    const byPath = new Map(out.nitpicks.map((n) => [n.path, n]));
    expect(byPath.has('docs/bot-identities.md')).toBe(true);
    expect(byPath.has('scripts/gh-as.mjs')).toBe(true);
    expect(byPath.has('scripts/gh-token-for.mjs')).toBe(true);

    const docsNit = byPath.get('docs/bot-identities.md')!;
    expect(docsNit.lineStart).toBe(3);
    expect(docsNit.lineEnd).toBe(3);
    expect(docsNit.title).toMatch(/intro lists "merges" as a bot-attributed action/);

    const ghAsNit = byPath.get('scripts/gh-as.mjs')!;
    expect(ghAsNit.lineStart).toBe(58);
    expect(ghAsNit.lineEnd).toBe(62);
    expect(ghAsNit.title).toMatch(/Mint failure surfaces as an unhandled rejection/);

    const ghTokenNit = byPath.get('scripts/gh-token-for.mjs')!;
    expect(ghTokenNit.lineStart).toBe(65);
    expect(ghTokenNit.lineEnd).toBe(71);
  });

  it('pulls proposed-fix diffs when present, leaves proposedFix undefined when not', () => {
    const out = parseCodeRabbitReviewBody(fixture('coderabbit-review-body-pr48.md'));
    const byPath = new Map(out.nitpicks.map((n) => [n.path, n]));

    // docs/bot-identities.md nit has NO proposed fix — it's a wording suggestion.
    expect(byPath.get('docs/bot-identities.md')!.proposedFix).toBeUndefined();

    // scripts/gh-as.mjs nit DOES have a proposed fix with the try/catch wrapper.
    const ghAs = byPath.get('scripts/gh-as.mjs')!;
    expect(ghAs.proposedFix).toBeDefined();
    expect(ghAs.proposedFix!).toMatch(/\+\s+try\s*\{/);
    expect(ghAs.proposedFix!).toMatch(/\+\s+} catch \(err\) \{/);
    expect(ghAs.proposedFix!).toMatch(/\[gh-as\] token mint failed/);

    // scripts/gh-token-for.mjs nit also has a proposed fix.
    const ghTok = byPath.get('scripts/gh-token-for.mjs')!;
    expect(ghTok.proposedFix).toBeDefined();
  });

  it('strips the AI-agents prompt block from the body text', () => {
    const out = parseCodeRabbitReviewBody(fixture('coderabbit-review-body-pr48.md'));
    for (const n of out.nitpicks) {
      expect(n.body).not.toMatch(/Prompt for AI Agents/);
      expect(n.body).not.toMatch(/Verify each finding against the current code/);
    }
  });

  it('strips the proposed-fix details block from the body text', () => {
    const out = parseCodeRabbitReviewBody(fixture('coderabbit-review-body-pr48.md'));
    for (const n of out.nitpicks) {
      expect(n.body).not.toMatch(/Proposed fix/);
      expect(n.body).not.toMatch(/```diff/);
    }
  });

  it('returns zero counts and empty nitpicks for a body with no CodeRabbit structure', () => {
    const out = parseCodeRabbitReviewBody('Plain reviewer comment with no CodeRabbit format.');
    expect(out.actionableCount).toBe(0);
    expect(out.nitpickCount).toBe(0);
    expect(out.nitpicks).toEqual([]);
  });

  it('handles a minimal single-file single-nit body', () => {
    const body = [
      '**Actionable comments posted: 0**',
      '',
      '<details>',
      '<summary>🧹 Nitpick comments (1)</summary><blockquote>',
      '',
      '<details>',
      '<summary>src/foo.ts (1)</summary><blockquote>',
      '',
      '`10-12`: **Consider renaming this variable.**',
      '',
      'The name `x` is not descriptive.',
      '',
      '</blockquote></details>',
      '',
      '</blockquote></details>',
    ].join('\n');

    const out = parseCodeRabbitReviewBody(body);
    expect(out.actionableCount).toBe(0);
    expect(out.nitpickCount).toBe(1);
    expect(out.nitpicks.length).toBe(1);
    expect(out.nitpicks[0]!.path).toBe('src/foo.ts');
    expect(out.nitpicks[0]!.lineStart).toBe(10);
    expect(out.nitpicks[0]!.lineEnd).toBe(12);
    expect(out.nitpicks[0]!.title).toBe('Consider renaming this variable.');
    expect(out.nitpicks[0]!.body).toContain('The name `x` is not descriptive.');
    expect(out.nitpicks[0]!.proposedFix).toBeUndefined();
  });

  it('handles single-line (non-range) nits', () => {
    const body = [
      '<details>',
      '<summary>🧹 Nitpick comments (1)</summary><blockquote>',
      '<details>',
      '<summary>src/bar.ts (1)</summary><blockquote>',
      '',
      '`42`: **Single-line finding.**',
      '',
      'body text',
      '',
      '</blockquote></details>',
      '</blockquote></details>',
    ].join('\n');

    const out = parseCodeRabbitReviewBody(body);
    expect(out.nitpicks[0]!.lineStart).toBe(42);
    expect(out.nitpicks[0]!.lineEnd).toBeUndefined();
  });
});
