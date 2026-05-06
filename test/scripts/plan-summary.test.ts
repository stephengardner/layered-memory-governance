/**
 * Pure plan-summary formatter tests.
 *
 * Pins the title-extraction + full-body contract for the shared
 * helper consumed by plan-approve-telegram, plan-discuss-telegram,
 * and the LoopRunner notify-pass adapter (telegram-plan-trigger.mjs).
 * The formatter does NOT truncate; truncation is a per-consumer
 * concern (approve uses 600-char preview, the auto-trigger uses
 * 3000-char Telegram body cap, discuss uses the full body).
 */

import { describe, expect, it } from 'vitest';

import { extractPlanTitleAndBody } from '../../scripts/lib/plan-summary.mjs';

describe('extractPlanTitleAndBody', () => {
  it('extracts title from h1 heading + returns full body', () => {
    const plan = {
      id: 'p1',
      content: '# My Plan Title\n\nFirst paragraph.\n\nSecond paragraph.',
    };
    const r = extractPlanTitleAndBody(plan);
    expect(r.title).toBe('My Plan Title');
    expect(r.body).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('extracts title from h2 heading', () => {
    expect(extractPlanTitleAndBody({ id: 'p2', content: '## H2 title\n\nbody' }).title).toBe('H2 title');
  });

  it('extracts title from h3 heading', () => {
    expect(extractPlanTitleAndBody({ id: 'p3', content: '### H3 title\n\nbody' }).title).toBe('H3 title');
  });

  it('does NOT match h4+ headings (the regex caps at #{1,3})', () => {
    const plan = { id: 'p4', content: '#### H4 not a title\n\nbody' };
    const r = extractPlanTitleAndBody(plan);
    expect(r.title).toBe('(no title - id p4)');
  });

  it('returns full body untruncated even for very long content', () => {
    const longBody = 'x'.repeat(5000);
    const plan = { id: 'p5', content: `# Title\n\n${longBody}` };
    const r = extractPlanTitleAndBody(plan);
    expect(r.body).toBe(longBody);
    expect(r.body.length).toBe(5000);
  });

  it('falls back to id-aware no-title placeholder when no heading', () => {
    const plan = { id: 'p6', content: 'No heading here.\nJust body.' };
    const r = extractPlanTitleAndBody(plan);
    expect(r.title).toBe('(no title - id p6)');
    expect(r.body).toBe('No heading here.\nJust body.');
  });

  it('falls back to bare placeholder when plan has no id', () => {
    const r = extractPlanTitleAndBody({ content: 'body only' });
    expect(r.title).toBe('(no title)');
  });

  it('handles missing/null content without throwing', () => {
    expect(() => extractPlanTitleAndBody({ id: 'p7' })).not.toThrow();
    expect(() => extractPlanTitleAndBody({ id: 'p7', content: null })).not.toThrow();
    expect(() => extractPlanTitleAndBody(null)).not.toThrow();
  });

  it('handles empty content', () => {
    const r = extractPlanTitleAndBody({ id: 'p8', content: '' });
    expect(r.title).toBe('(no title - id p8)');
    expect(r.body).toBe('');
  });

  it('first heading wins regardless of level', () => {
    // ### appears before # so it wins.
    const plan = { id: 'p9', content: '### First Subhead\n\n# Real Title\n\nbody' };
    expect(extractPlanTitleAndBody(plan).title).toBe('First Subhead');
  });

  it('trims body whitespace at start and end', () => {
    const plan = { id: 'p10', content: '# T\n\n   body padded   \n\n' };
    expect(extractPlanTitleAndBody(plan).body).toBe('body padded');
  });

  it('preserves internal whitespace and newlines in body', () => {
    const plan = { id: 'p11', content: '# T\n\nline1\n\nline2\n\nline3' };
    expect(extractPlanTitleAndBody(plan).body).toBe('line1\n\nline2\n\nline3');
  });

  it('coerces non-string content gracefully', () => {
    // Defensive: a malformed atom (number, undefined) should not crash.
    expect(() => extractPlanTitleAndBody({ id: 'p12', content: 42 as unknown as string })).not.toThrow();
  });
});
