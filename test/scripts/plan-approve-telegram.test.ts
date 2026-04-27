/**
 * Plan-approve-telegram helper tests.
 *
 * Covers the pure helpers in scripts/lib/plan-approve-telegram.mjs.
 * The Telegram I/O + transitionPlanState integration in the driver
 * are exercised by the existing TelegramNotifier tests + the plan
 * state-machine tests; this file pins the parsing + summary contract
 * specifically.
 */

import { describe, expect, it } from 'vitest';

import {
  parseArgs,
  validateArgs,
  formatPlanSummary,
  DEFAULT_TIMEOUT_MS,
  PLAN_SUMMARY_BODY_MAX,
} from '../../scripts/lib/plan-approve-telegram.mjs';

describe('parseArgs', () => {
  it('parses bare plan-id', () => {
    const a = parseArgs(['plan-foo']);
    expect(a.planId).toBe('plan-foo');
    expect(a.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(a.help).toBe(false);
  });

  it('parses --timeout', () => {
    const a = parseArgs(['plan-foo', '--timeout', '30000']);
    expect(a.timeoutMs).toBe(30000);
  });

  it('flags --help / -h', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('joins multi-token plan ids (paste-with-space)', () => {
    const a = parseArgs(['plan-foo', 'bar']);
    expect(a.planId).toBe('plan-foo bar');
  });

  it('returns empty planId when only flags present', () => {
    const a = parseArgs(['--timeout', '5000']);
    expect(a.planId).toBe('');
    expect(a.timeoutMs).toBe(5000);
  });

  it('throws on unknown long-form flag', () => {
    expect(() => parseArgs(['plan-foo', '--timout', '5000'])).toThrow(/unknown option/i);
  });

  it('throws on --timeout without value', () => {
    expect(() => parseArgs(['plan-foo', '--timeout'])).toThrow(/missing value/i);
  });

  it('throws on non-numeric --timeout value', () => {
    expect(() => parseArgs(['plan-foo', '--timeout', 'soon'])).toThrow(/invalid value/i);
  });

  it('parses --principal', () => {
    const a = parseArgs(['plan-foo', '--principal', 'apex-agent']);
    expect(a.principal).toBe('apex-agent');
  });

  it('throws on --principal without value', () => {
    expect(() => parseArgs(['plan-foo', '--principal'])).toThrow(/missing value/i);
  });
});

describe('validateArgs', () => {
  it('approves a well-formed args object', () => {
    expect(validateArgs({ planId: 'plan-x', timeoutMs: 60000, help: false }))
      .toEqual({ ok: true });
  });

  it('rejects empty planId', () => {
    const r = validateArgs({ planId: '', timeoutMs: 60000, help: false });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing plan-id/i);
  });

  it('rejects non-positive timeoutMs', () => {
    expect(validateArgs({ planId: 'plan-x', timeoutMs: 0, help: false }).ok).toBe(false);
    expect(validateArgs({ planId: 'plan-x', timeoutMs: -100, help: false }).ok).toBe(false);
  });

  it('rejects fractional / non-integer timeoutMs', () => {
    expect(validateArgs({ planId: 'plan-x', timeoutMs: 12.5, help: false }).ok).toBe(false);
    expect(validateArgs({ planId: 'plan-x', timeoutMs: NaN, help: false }).ok).toBe(false);
  });
});

describe('formatPlanSummary', () => {
  it('extracts the first markdown heading + body', () => {
    const plan = {
      id: 'plan-x',
      content: '# My Plan Title\n\nFirst body paragraph.\n\nSecond paragraph.',
    };
    const r = formatPlanSummary(plan);
    expect(r.title).toBe('My Plan Title');
    expect(r.body).toContain('First body paragraph.');
    expect(r.body).toContain('Second paragraph.');
  });

  it('truncates long body with the (truncated) marker', () => {
    const plan = {
      id: 'plan-x',
      content: '# Title\n\n' + 'x'.repeat(PLAN_SUMMARY_BODY_MAX + 200),
    };
    const r = formatPlanSummary(plan);
    expect(r.body.length).toBeLessThanOrEqual(PLAN_SUMMARY_BODY_MAX + 20);
    expect(r.body).toMatch(/\(truncated\)$/);
  });

  it('falls back to id-aware no-title placeholder when no heading', () => {
    const plan = { id: 'plan-x', content: 'No heading here.\nJust body lines.' };
    const r = formatPlanSummary(plan);
    expect(r.title).toBe('(no title - id plan-x)');
    expect(r.body).toContain('No heading here.');
  });

  it('falls back to bare placeholder when plan has no id', () => {
    const r = formatPlanSummary({ content: 'body only' });
    expect(r.title).toBe('(no title)');
  });

  it('handles missing/null content without throwing', () => {
    expect(() => formatPlanSummary({ id: 'plan-x' })).not.toThrow();
    expect(() => formatPlanSummary({ id: 'plan-x', content: null })).not.toThrow();
    expect(() => formatPlanSummary(null)).not.toThrow();
  });

  it('first heading wins regardless of #-level (1-3 hashes)', () => {
    const plan = {
      id: 'plan-x',
      content: '### Subhead\n\n# Real Title\n\nbody',
    };
    const r = formatPlanSummary(plan);
    // The regex matches /^#{1,3}\s+(.+)$/ so the first matching line --
    // even one prefixed with ###/##  --  is the title. Test pins this
    // contract so a future caller knows which heading drives the
    // Telegram preview.
    expect(r.title).toBe('Subhead');
  });
});
