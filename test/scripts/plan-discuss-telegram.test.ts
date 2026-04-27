/**
 * Plan-discuss-telegram helper tests.
 *
 * Covers the pure helpers in scripts/lib/plan-discuss-telegram.mjs.
 * The Telegram I/O + LLM call path are exercised manually + by the
 * driver script's runtime; this file pins parsing, keyboard build,
 * callback parsing, and atom-shape contracts.
 */

import { describe, expect, it } from 'vitest';

import {
  parseArgs,
  validateArgs,
  buildKeyboard,
  parseCallback,
  encodeTag,
  formatInitialMessage,
  formatDiscussReply,
  formatCtoPrompt,
  buildDiscussionAtom,
  DEFAULT_TIMEOUT_MS,
  DISCUSSION_BODY_MAX,
} from '../../scripts/lib/plan-discuss-telegram.mjs';

describe('parseArgs', () => {
  it('parses bare plan-id', () => {
    const a = parseArgs(['plan-foo']);
    expect(a.planId).toBe('plan-foo');
    expect(a.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(a.principal).toBe(null);
    expect(a.noLlm).toBe(false);
  });

  it('parses --timeout, --principal, --no-llm', () => {
    const a = parseArgs(['plan-foo', '--timeout', '30000', '--principal', 'apex', '--no-llm']);
    expect(a.timeoutMs).toBe(30000);
    expect(a.principal).toBe('apex');
    expect(a.noLlm).toBe(true);
  });

  it('throws on unknown long-form flag', () => {
    expect(() => parseArgs(['plan-foo', '--timout', '5000'])).toThrow(/unknown option/i);
  });

  it('throws on --timeout without value', () => {
    expect(() => parseArgs(['plan-foo', '--timeout'])).toThrow(/missing value/i);
  });

  it('throws on non-numeric --timeout', () => {
    expect(() => parseArgs(['plan-foo', '--timeout', 'soon'])).toThrow(/invalid value/i);
  });

  it('throws on --principal without value', () => {
    expect(() => parseArgs(['plan-foo', '--principal'])).toThrow(/missing value/i);
  });

  it('flags --help / -h', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });
});

describe('validateArgs', () => {
  it('approves a well-formed args object', () => {
    expect(validateArgs({ planId: 'plan-x', timeoutMs: 60000, principal: 'apex', noLlm: false, help: false }))
      .toEqual({ ok: true });
  });

  it('rejects empty planId', () => {
    const r = validateArgs({ planId: '', timeoutMs: 60000, principal: null, noLlm: false, help: false });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing plan-id/i);
  });

  it('rejects non-positive timeoutMs', () => {
    expect(validateArgs({ planId: 'plan-x', timeoutMs: 0, principal: null, noLlm: false, help: false }).ok).toBe(false);
    expect(validateArgs({ planId: 'plan-x', timeoutMs: -100, principal: null, noLlm: false, help: false }).ok).toBe(false);
  });
});

describe('buildKeyboard', () => {
  it('produces a 3-button inline keyboard with the given tag', () => {
    const kb = buildKeyboard('plan-x');
    expect(kb.inline_keyboard.length).toBe(2);
    expect(kb.inline_keyboard[0].length).toBe(2);
    expect(kb.inline_keyboard[1].length).toBe(1);
    expect(kb.inline_keyboard[0][0]).toEqual({ text: 'Approve', callback_data: 'discuss:plan-x:approve' });
    expect(kb.inline_keyboard[0][1]).toEqual({ text: 'Reject', callback_data: 'discuss:plan-x:reject' });
    expect(kb.inline_keyboard[1][0]).toEqual({ text: 'Discuss', callback_data: 'discuss:plan-x:discuss' });
  });
});

describe('encodeTag', () => {
  it('returns short tags unchanged', () => {
    expect(encodeTag('plan-x')).toBe('plan-x');
    expect(encodeTag('plan-' + 'a'.repeat(35))).toBe('plan-' + 'a'.repeat(35));
  });

  it('hashes long tags to a fixed-shape token under 40 chars', () => {
    const long = 'plan-' + 'a'.repeat(80);
    const enc = encodeTag(long);
    expect(enc.length).toBeLessThanOrEqual(40);
    expect(enc.startsWith('h.')).toBe(true);
    // Deterministic: same input -> same output.
    expect(encodeTag(long)).toBe(enc);
  });

  it('callback_data fits Telegram 64-byte limit even for long ids', () => {
    const long = 'plan-' + 'a'.repeat(200);
    const kb = buildKeyboard(long);
    for (const row of kb.inline_keyboard) {
      for (const btn of row) {
        // 64 byte limit applies to UTF-8 byte length; our chars are ASCII.
        expect(Buffer.byteLength(btn.callback_data, 'utf8')).toBeLessThanOrEqual(64);
      }
    }
  });
});

describe('parseCallback', () => {
  it('parses approve / reject / discuss for the matching tag', () => {
    expect(parseCallback('discuss:plan-x:approve', 'plan-x')).toBe('approve');
    expect(parseCallback('discuss:plan-x:reject', 'plan-x')).toBe('reject');
    expect(parseCallback('discuss:plan-x:discuss', 'plan-x')).toBe('discuss');
  });

  it('returns null for non-matching tag', () => {
    expect(parseCallback('discuss:plan-y:approve', 'plan-x')).toBe(null);
  });

  it('returns null for non-LAG callback prefix', () => {
    expect(parseCallback('other:plan-x:approve', 'plan-x')).toBe(null);
  });

  it('returns null for unknown action', () => {
    expect(parseCallback('discuss:plan-x:dance', 'plan-x')).toBe(null);
  });

  it('returns null for malformed strings', () => {
    expect(parseCallback('', 'plan-x')).toBe(null);
    expect(parseCallback('discuss:plan-x', 'plan-x')).toBe(null);
    expect(parseCallback('discuss:plan-x:approve:extra', 'plan-x')).toBe(null);
    expect(parseCallback(undefined as unknown as string, 'plan-x')).toBe(null);
    expect(parseCallback(null as unknown as string, 'plan-x')).toBe(null);
  });
});

describe('formatInitialMessage', () => {
  it('renders title + body + id + tap-prompt', () => {
    const msg = formatInitialMessage('plan-x', { title: 'Hello', body: 'World' });
    expect(msg).toContain('Plan: Hello');
    expect(msg).toContain('World');
    expect(msg).toContain('ID: plan-x');
    expect(msg).toContain('Discuss');
  });

  it('truncates a long body', () => {
    const longBody = 'x'.repeat(DISCUSSION_BODY_MAX + 200);
    const msg = formatInitialMessage('plan-x', { title: 'T', body: longBody });
    expect(msg).toMatch(/\(truncated\)/);
  });

  it('handles missing title/body without throwing', () => {
    expect(() => formatInitialMessage('plan-x', {})).not.toThrow();
    expect(() => formatInitialMessage('plan-x', null as never)).not.toThrow();
  });
});

describe('formatDiscussReply', () => {
  it('renders Q + CTO response + tap-prompt', () => {
    const r = formatDiscussReply('What about X?', 'X is fine.');
    expect(r).toContain('Q: What about X?');
    expect(r).toContain('CTO:');
    expect(r).toContain('X is fine.');
    expect(r).toContain('Approve');
  });
});

describe('formatCtoPrompt', () => {
  it('includes plan id + body + question', () => {
    const p = formatCtoPrompt({ id: 'plan-x', content: 'Plan body here.' }, 'Why?');
    expect(p).toContain('plan-x');
    expect(p).toContain('Plan body here.');
    expect(p).toContain('Why?');
  });

  it('truncates over-long plan body', () => {
    /*
     * Use a marker char that doesn't appear in the framing prose so
     * the count test is precise: '@' is in neither the system prompt
     * nor the question; planBody slice bound is 2000 chars exact.
     */
    const p = formatCtoPrompt({ id: 'p', content: '@'.repeat(3000) }, 'q');
    const planBodyMatches = p.match(/@/g);
    expect(planBodyMatches?.length ?? 0).toBe(2000);
  });
});

describe('buildDiscussionAtom', () => {
  it('produces a well-formed plan-discussion atom', () => {
    const a = buildDiscussionAtom({
      planId: 'plan-x',
      question: 'Why?',
      response: 'Because.',
      principalId: 'apex-agent',
      createdAt: '2026-04-27T03:00:00.000Z',
    });
    expect(a.type).toBe('observation');
    expect(a.metadata.kind).toBe('plan-discussion');
    expect(a.layer).toBe('L0');
    expect(a.principal_id).toBe('apex-agent');
    expect(a.content).toContain('Why?');
    expect(a.content).toContain('Because.');
    expect(a.provenance.derived_from).toEqual(['plan-x']);
    expect(a.metadata.via).toBe('telegram');
    expect(a.metadata.llm_used).toBe(true);
    /*
     * id format: plan-discussion-<plan-id>-<unix-ms>-<6-hex-nonce>.
     * Match by regex since the nonce is non-deterministic; this test
     * pins the timestamp + structure but lets the nonce vary.
     */
    const ts = Date.parse('2026-04-27T03:00:00.000Z');
    expect(a.id).toMatch(new RegExp(`^plan-discussion-plan-x-${ts}-[0-9a-f]{6}$`));
  });

  it('marks llm_used=false when noLlm=true', () => {
    const a = buildDiscussionAtom({
      planId: 'plan-x',
      question: 'Q',
      response: 'placeholder',
      principalId: 'apex-agent',
      createdAt: '2026-04-27T03:00:00.000Z',
      noLlm: true,
    });
    expect(a.metadata.llm_used).toBe(false);
  });

  it('throws on missing required fields', () => {
    expect(() => buildDiscussionAtom({} as never)).toThrow(/planId required/);
    expect(() => buildDiscussionAtom({ planId: 'p' } as never)).toThrow(/principalId required/);
    expect(() => buildDiscussionAtom({ planId: 'p', principalId: 'apex' } as never)).toThrow(/createdAt required/);
  });

  it('throws on unparseable createdAt timestamp', () => {
    expect(() => buildDiscussionAtom({
      planId: 'p',
      question: 'q',
      response: 'r',
      principalId: 'apex',
      createdAt: 'not-a-date',
    } as never)).toThrow(/valid ISO timestamp/i);
  });

  it('uses a valid ProvenanceKind', () => {
    const a = buildDiscussionAtom({
      planId: 'plan-x',
      question: 'q',
      response: 'r',
      principalId: 'apex',
      createdAt: '2026-04-27T03:00:00.000Z',
    });
    // src/substrate/types.ts defines ProvenanceKind:
    // 'user-directive' | 'agent-observed' | 'agent-inferred' | 'llm-refined' | 'canon-promoted' | 'operator-seeded'
    expect([
      'user-directive',
      'agent-observed',
      'agent-inferred',
      'llm-refined',
      'canon-promoted',
      'operator-seeded',
    ]).toContain(a.provenance.kind);
  });
});
