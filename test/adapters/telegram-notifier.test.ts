/**
 * TelegramNotifier unit tests.
 *
 * All tests use a mock fetch so no real Telegram calls leave the
 * machine. A separate LAG_TELEGRAM_LIVE=1 gated test (in
 * test/integration/telegram-live.test.ts) exercises the real wire.
 *
 * What these tests prove:
 *   1. telegraph() forwards to base + issues a sendMessage call with
 *      the expected chat id and inline-keyboard payload.
 *   2. The base holds disposition state; the wrapper delegates.
 *   3. pollOnce() translates callback_query responses into
 *      base.respond() calls and acknowledges them.
 *   4. The offset advances so the same update is never processed twice.
 *   5. Malformed callback_data is ignored safely.
 *   6. A failure to reach Telegram during telegraph does NOT stall the
 *      base notifier (governance must degrade gracefully when the
 *      messaging channel is down).
 *   7. parseCallbackData correctly decodes known shapes and rejects
 *      unknown ones.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import {
  TelegramNotifier,
  parseCallbackData,
} from '../../src/adapters/notifier/telegram.js';
import type {
  Event,
  NotificationHandle,
  PrincipalId,
  Time,
} from '../../src/substrate/types.js';

const principal = 'telegram-test' as PrincipalId;

interface RecordedCall {
  readonly method: string;
  readonly body: Record<string, unknown>;
}

/**
 * Build a mock fetch that records every call and returns canned
 * Telegram responses keyed by method name.
 */
function buildMockFetch(responses: Record<string, unknown>): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const u = String(url);
    const methodMatch = /\/bot[^/]+\/([a-zA-Z]+)$/.exec(u);
    const method = methodMatch ? methodMatch[1]! : 'unknown';
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ method, body });
    const result = responses[method];
    const payload = {
      ok: true,
      result: result !== undefined ? result : true,
    };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

function sampleEvent(overrides: Partial<Event> = {}): Event {
  return {
    kind: 'proposal',
    severity: 'info',
    summary: 'Test escalation',
    body: 'Details body.',
    atom_refs: [],
    principal_id: principal,
    created_at: '2026-04-19T00:00:00.000Z' as Time,
    ...overrides,
  };
}

describe('TelegramNotifier', () => {
  it('telegraph forwards to base and POSTs sendMessage with inline keyboard', async () => {
    const host = createMemoryHost();
    const { fetchImpl, calls } = buildMockFetch({
      sendMessage: { message_id: 42 },
    });
    const notifier = new TelegramNotifier({
      botToken: 'FAKE:token',
      chatId: 12345,
      base: host.notifier,
      respondAsPrincipal: principal,
      fetchImpl,
    });

    const handle = await notifier.telegraph(sampleEvent(), null, 'coexist', 5000);
    expect(handle).toBeTruthy();

    // Base holds the pending entry.
    expect(await host.notifier.disposition(handle)).toBe('pending');

    // Exactly one sendMessage call with shape we expect.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('sendMessage');
    const body = calls[0]!.body;
    expect(body.chat_id).toBe('12345');
    expect(String(body.text)).toContain('LAG: Test escalation');
    expect(String(body.text)).toContain(`Handle: ${String(handle)}`);
    const keyboard = (body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard;
    expect(keyboard).toHaveLength(1);
    expect(keyboard[0]!.map(b => b.text)).toEqual(['Approve', 'Reject', 'Ignore']);
    expect(keyboard[0]!.every(b => b.callback_data.startsWith(`${String(handle)}:`))).toBe(true);
  });

  it('pollOnce translates callback_query into base.respond', async () => {
    const host = createMemoryHost();
    const { fetchImpl, calls } = buildMockFetch({ sendMessage: { message_id: 1 } });
    const notifier = new TelegramNotifier({
      botToken: 'FAKE:token',
      chatId: 1,
      base: host.notifier,
      respondAsPrincipal: principal,
      fetchImpl,
    });

    const handle = await notifier.telegraph(sampleEvent(), null, 'coexist', 5000);
    const data = `${String(handle)}:approve`;

    // Now swap the mock's response shape: next getUpdates returns a
    // single callback_query carrying our handle.
    const { fetchImpl: pollFetch, calls: pollCalls } = buildMockFetch({
      getUpdates: [
        {
          update_id: 1001,
          callback_query: {
            id: 'cb-1',
            from: { id: 7, username: 'stephen' },
            data,
            message: { message_id: 1, chat: { id: 1 } },
          },
        },
      ],
      answerCallbackQuery: true,
      editMessageText: { message_id: 1 },
    });
    // Rebind fetch by constructing a fresh notifier over the same base;
    // the first notifier already delivered its outgoing sendMessage.
    const poller = new TelegramNotifier({
      botToken: 'FAKE:token',
      chatId: 1,
      base: host.notifier,
      respondAsPrincipal: principal,
      fetchImpl: pollFetch,
    });

    const processed = await poller.pollOnce();
    expect(processed).toBe(1);
    expect(await host.notifier.disposition(handle)).toBe('approve');

    // Expected side-effects: getUpdates + answerCallbackQuery + editMessageText.
    const methods = pollCalls.map(c => c.method);
    expect(methods).toContain('getUpdates');
    expect(methods).toContain('answerCallbackQuery');
    expect(methods).toContain('editMessageText');

    // Idempotence: a second pollOnce with the same update-id should not re-process.
    const processed2 = await poller.pollOnce();
    expect(processed2).toBe(0);

    // Keep calls referenced so the sendMessage path is covered above.
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it('ignores callback_data it does not recognize', async () => {
    const host = createMemoryHost();
    const { fetchImpl } = buildMockFetch({
      getUpdates: [
        {
          update_id: 200,
          callback_query: {
            id: 'cb-2',
            from: { id: 7 },
            data: 'some-other-bot:ping',
          },
        },
        {
          update_id: 201,
          callback_query: {
            id: 'cb-3',
            from: { id: 7 },
            data: 'abc:notadisposition',
          },
        },
      ],
      answerCallbackQuery: true,
    });
    const notifier = new TelegramNotifier({
      botToken: 'FAKE:token',
      chatId: 1,
      base: host.notifier,
      respondAsPrincipal: principal,
      fetchImpl,
    });
    const processed = await notifier.pollOnce();
    expect(processed).toBe(0);
  });

  it('does not throw when sendMessage fails (governance keeps working)', async () => {
    const host = createMemoryHost();
    // Build a fetch that fails by returning ok=false.
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: false, error_code: 502, description: 'Bad Gateway' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    const errors: Array<[unknown, string]> = [];
    const notifier = new TelegramNotifier({
      botToken: 'FAKE:token',
      chatId: 1,
      base: host.notifier,
      respondAsPrincipal: principal,
      fetchImpl,
      onError: (err, ctx) => { errors.push([err, ctx]); },
    });

    const handle = await notifier.telegraph(sampleEvent(), null, 'coexist', 5000);
    expect(handle).toBeTruthy(); // base still created the entry
    expect(await host.notifier.disposition(handle)).toBe('pending');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]![1]).toContain('sendEscalation');
  });
});

describe('parseCallbackData', () => {
  it('accepts valid handle:disposition shapes', () => {
    expect(parseCallbackData('abc123:approve')).toEqual({
      handle: 'abc123' as NotificationHandle,
      disposition: 'approve',
    });
    expect(parseCallbackData('xyz:reject')?.disposition).toBe('reject');
    expect(parseCallbackData('xyz:ignore')?.disposition).toBe('ignore');
  });

  it('rejects missing colon, empty handle, unknown disposition', () => {
    expect(parseCallbackData('noseparator')).toBeNull();
    expect(parseCallbackData(':approve')).toBeNull();
    expect(parseCallbackData('abc:coexist')).toBeNull();
    expect(parseCallbackData('abc:unknown')).toBeNull();
  });
});
