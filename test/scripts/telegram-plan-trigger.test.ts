/**
 * Telegram plan-proposal notifier adapter tests.
 *
 * Pins:
 *   - validateNotifyArgs guard contract
 *   - formatTelegramMessage stable shape + truncation
 *   - createTelegramPlanProposalNotifier env-handling (silent-skip
 *     when env is missing, builds adapter when present)
 *   - notify() POSTs to the right URL with the right payload via
 *     an injected fetchImpl
 *   - Telegram ok:false response surfaces as a thrown Error
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  validateNotifyArgs,
  createTelegramPlanProposalNotifier,
  formatTelegramMessage,
} from '../../scripts/lib/telegram-plan-trigger.mjs';

describe('validateNotifyArgs', () => {
  it('accepts a valid plan', () => {
    expect(validateNotifyArgs({ plan: { id: 'p1', content: '...' } })).toBe(true);
  });
  it('throws on missing plan', () => {
    expect(() => validateNotifyArgs({})).toThrow(/plan/);
  });
  it('throws on plan without id', () => {
    expect(() => validateNotifyArgs({ plan: { content: '' } })).toThrow(/id/);
  });
  it('throws on null args', () => {
    expect(() => validateNotifyArgs(null)).toThrow(/object/);
  });
  it('throws on plan with empty id', () => {
    expect(() => validateNotifyArgs({ plan: { id: '' } })).toThrow(/id/);
  });
});

describe('formatTelegramMessage', () => {
  it('formats with plan id, title, body, and run-discuss command', () => {
    const msg = formatTelegramMessage({
      plan: { id: 'plan-foo', content: '# Foo plan\n\nBody content here.' },
    });
    expect(msg).toContain('Foo plan');
    expect(msg).toContain('Body content here.');
    expect(msg).toContain('plan-foo');
    expect(msg).toContain('plan-discuss-telegram.mjs plan-foo');
  });
  it('truncates very long bodies to keep the Telegram message digestible', () => {
    const longBody = 'x'.repeat(4500);
    const msg = formatTelegramMessage({
      plan: { id: 'p1', content: `# T\n\n${longBody}` },
    });
    // Telegram messages have a 4096 char limit; we cap below that to
    // leave room for title + cmd + footer.
    expect(msg.length).toBeLessThan(4096);
    expect(msg).toContain('[truncated]');
  });
  it('uses fallback title when no markdown heading', () => {
    const msg = formatTelegramMessage({
      plan: { id: 'p2', content: 'No heading. Just body.' },
    });
    expect(msg).toContain('(no title - id p2)');
    expect(msg).toContain('No heading. Just body.');
  });
  it('handles empty content gracefully', () => {
    const msg = formatTelegramMessage({ plan: { id: 'p3', content: '' } });
    expect(msg).toContain('p3');
    expect(msg).not.toContain('undefined');
  });
});

describe('createTelegramPlanProposalNotifier', () => {
  const SAVED_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const SAVED_CHAT = process.env.TELEGRAM_CHAT_ID;
  beforeEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
  });
  afterEach(() => {
    if (SAVED_TOKEN === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = SAVED_TOKEN;
    if (SAVED_CHAT === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = SAVED_CHAT;
  });
  it('returns null when TELEGRAM_BOT_TOKEN is missing', () => {
    process.env.TELEGRAM_CHAT_ID = '12345';
    expect(createTelegramPlanProposalNotifier()).toBeNull();
  });
  it('returns null when TELEGRAM_CHAT_ID is missing', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'abc';
    expect(createTelegramPlanProposalNotifier()).toBeNull();
  });
  it('returns null when both env vars are missing (silent-skip path)', () => {
    expect(createTelegramPlanProposalNotifier()).toBeNull();
  });
  it('builds an adapter when env is present (without sending)', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'abc';
    process.env.TELEGRAM_CHAT_ID = '12345';
    const adapter = createTelegramPlanProposalNotifier();
    expect(adapter).not.toBeNull();
    expect(typeof adapter?.notify).toBe('function');
  });
  it('sends via the injected fetchImpl when notify is called', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'abc';
    process.env.TELEGRAM_CHAT_ID = '12345';
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const adapter = createTelegramPlanProposalNotifier({ fetchImpl });
    expect(adapter).not.toBeNull();
    await adapter!.notify({
      plan: { id: 'p1', content: '# T\n\nB' },
    });
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toContain('https://api.telegram.org/botabc/sendMessage');
    expect((calls[0]?.body as { chat_id: string }).chat_id).toBe('12345');
    expect((calls[0]?.body as { text: string }).text).toContain('p1');
  });
  it('throws when Telegram returns ok:false (counted as notify-failed by tick)', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'abc';
    process.env.TELEGRAM_CHAT_ID = '12345';
    const fetchImpl: typeof fetch = async () => {
      return new Response(
        JSON.stringify({ ok: false, error_code: 401, description: 'unauthorized' }),
        { headers: { 'content-type': 'application/json' } },
      );
    };
    const adapter = createTelegramPlanProposalNotifier({ fetchImpl });
    expect(adapter).not.toBeNull();
    await expect(
      adapter!.notify({ plan: { id: 'p1', content: '# T\n\nB' } }),
    ).rejects.toThrow(/Telegram/);
  });
  it('throws when Telegram response is not JSON', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'abc';
    process.env.TELEGRAM_CHAT_ID = '12345';
    const fetchImpl: typeof fetch = async () => {
      // Manually construct a Response that returns invalid JSON.
      return new Response('<!DOCTYPE html>NotJSON', {
        headers: { 'content-type': 'text/html' },
        status: 502,
      });
    };
    const adapter = createTelegramPlanProposalNotifier({ fetchImpl });
    expect(adapter).not.toBeNull();
    await expect(
      adapter!.notify({ plan: { id: 'p1', content: '# T\n\nB' } }),
    ).rejects.toThrow();
  });
});
