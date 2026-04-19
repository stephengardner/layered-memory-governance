/**
 * LAGDaemon unit tests.
 *
 * All tests use mocked fetch (Telegram wire) and mocked invokeClaude
 * (no actual subprocess spawn). Proves:
 *   1. User message -> atoms written (user + assistant), reply sent.
 *   2. Chat-id authz ignores foreign chat ids.
 *   3. Callback query forwards disposition + acknowledges.
 *   4. Long reply splits into multiple Telegram messages.
 *   5. Invoker failure -> apology sent, no crash.
 *   6. Poll offset advances so updates are not reprocessed.
 *   7. Tick returns the number of handled updates.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { LAGDaemon, splitForTelegram } from '../../src/daemon/index.js';
import type { Disposition, PrincipalId } from '../../src/types.js';

const PRINCIPAL = 'daemon-test-principal' as PrincipalId;
const CHAT_ID = 12345;
const OTHER_CHAT = 99999;

interface RecordedCall {
  readonly method: string;
  readonly body: Record<string, unknown>;
}

function buildMockFetch(
  updatesPerCall: Array<Array<Record<string, unknown>>>,
  sendMessageResponse: unknown = { message_id: 1 },
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let getUpdatesCallCount = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const u = String(url);
    const methodMatch = /\/bot[^/]+\/([a-zA-Z]+)$/.exec(u);
    const method = methodMatch ? methodMatch[1]! : 'unknown';
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ method, body });
    let result: unknown;
    if (method === 'getUpdates') {
      result = updatesPerCall[getUpdatesCallCount] ?? [];
      getUpdatesCallCount += 1;
    } else if (method === 'sendMessage') {
      result = sendMessageResponse;
    } else if (method === 'answerCallbackQuery') {
      result = true;
    } else {
      result = true;
    }
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

let canonPath: string;
beforeEach(async () => {
  canonPath = join(await mkdtemp(join(tmpdir(), 'lag-daemon-canon-')), 'CLAUDE.md');
  await writeFile(canonPath, '# LAG Canon\n\nTest canon body.\n');
});
afterEach(async () => {
  try { await rm(canonPath.replace(/CLAUDE\.md$/, ''), { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('LAGDaemon.tick', () => {
  it('handles a text message: writes 2 atoms, replies, advances offset', async () => {
    const host = createMemoryHost();
    const invoke = vi.fn().mockResolvedValue({
      text: 'Hi Stephen, LAG here.',
      costUsd: 0.001,
      inputTokens: 100,
      outputTokens: 20,
      latencyMs: 500,
    });
    const { fetchImpl, calls } = buildMockFetch([[
      {
        update_id: 100,
        message: {
          message_id: 1,
          from: { id: 1, username: 'stephen' },
          chat: { id: CHAT_ID },
          text: 'Hello daemon',
        },
      },
    ]]);

    const daemon = new LAGDaemon({
      host,
      botToken: 'FAKE:token',
      chatId: CHAT_ID,
      canonFilePath: canonPath,
      principalResolver: () => PRINCIPAL,
      fetchImpl,
      invokeImpl: invoke as unknown as typeof import('../../src/daemon/invoke-claude.js').invokeClaude,
    });

    const processed = await daemon.tick();
    expect(processed).toBe(1);

    // Invoker called once with the user's text.
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]![0].userMessage).toBe('Hello daemon');
    // System prompt should contain the canon text.
    expect(invoke.mock.calls[0]![0].systemPrompt).toContain('Test canon body.');

    // sendMessage called with the invoker's reply.
    const sends = calls.filter(c => c.method === 'sendMessage');
    expect(sends).toHaveLength(1);
    expect(String(sends[0]!.body.text)).toContain('LAG here');

    // Two atoms written: user + assistant.
    const all = await host.atoms.query({}, 10);
    expect(all.atoms.map(a => a.content).sort()).toEqual(
      ['Hello daemon', 'Hi Stephen, LAG here.'].sort(),
    );
  });

  it('ignores messages from chat ids other than the configured one', async () => {
    const host = createMemoryHost();
    const invoke = vi.fn();
    const { fetchImpl, calls } = buildMockFetch([[
      {
        update_id: 200,
        message: {
          message_id: 1,
          from: { id: 2 },
          chat: { id: OTHER_CHAT },
          text: 'intruder',
        },
      },
    ]]);
    const daemon = new LAGDaemon({
      host,
      botToken: 'FAKE',
      chatId: CHAT_ID,
      canonFilePath: canonPath,
      principalResolver: () => PRINCIPAL,
      fetchImpl,
      invokeImpl: invoke as never,
    });

    await daemon.tick();
    expect(invoke).not.toHaveBeenCalled();
    expect(calls.filter(c => c.method === 'sendMessage')).toHaveLength(0);
    const all = await host.atoms.query({}, 10);
    expect(all.atoms).toHaveLength(0);
  });

  it('forwards a callback_query to onCallback and acknowledges', async () => {
    const host = createMemoryHost();
    const onCallback = vi.fn().mockResolvedValue(undefined);
    const invoke = vi.fn();
    const { fetchImpl, calls } = buildMockFetch([[
      {
        update_id: 300,
        callback_query: {
          id: 'cb-1',
          from: { id: 1 },
          data: 'handleABC:approve',
          message: { message_id: 1, chat: { id: CHAT_ID } },
        },
      },
    ]]);
    const daemon = new LAGDaemon({
      host,
      botToken: 'FAKE',
      chatId: CHAT_ID,
      canonFilePath: canonPath,
      principalResolver: () => PRINCIPAL,
      onCallback,
      fetchImpl,
      invokeImpl: invoke as never,
    });

    const processed = await daemon.tick();
    expect(processed).toBe(1);
    expect(onCallback).toHaveBeenCalledWith('handleABC', 'approve' satisfies Disposition, PRINCIPAL);
    expect(calls.map(c => c.method)).toContain('answerCallbackQuery');
  });

  it('splits long replies across multiple sendMessage calls', async () => {
    const host = createMemoryHost();
    const longReply = 'A'.repeat(5000);
    const invoke = vi.fn().mockResolvedValue({
      text: longReply,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
    });
    const { fetchImpl, calls } = buildMockFetch([[
      {
        update_id: 400,
        message: { message_id: 1, from: { id: 1 }, chat: { id: CHAT_ID }, text: 'give me a wall' },
      },
    ]]);
    const daemon = new LAGDaemon({
      host,
      botToken: 'FAKE',
      chatId: CHAT_ID,
      canonFilePath: canonPath,
      principalResolver: () => PRINCIPAL,
      maxReplyChars: 2000,
      fetchImpl,
      invokeImpl: invoke as never,
    });

    await daemon.tick();
    const sends = calls.filter(c => c.method === 'sendMessage');
    expect(sends.length).toBeGreaterThan(1);
  });

  it('on invoker failure sends an apology and does not crash', async () => {
    const host = createMemoryHost();
    const invoke = vi.fn().mockRejectedValue(new Error('network down'));
    const errors: string[] = [];
    const { fetchImpl, calls } = buildMockFetch([[
      {
        update_id: 500,
        message: { message_id: 1, from: { id: 1 }, chat: { id: CHAT_ID }, text: 'ping' },
      },
    ]]);
    const daemon = new LAGDaemon({
      host,
      botToken: 'FAKE',
      chatId: CHAT_ID,
      canonFilePath: canonPath,
      principalResolver: () => PRINCIPAL,
      fetchImpl,
      invokeImpl: invoke as never,
      onError: (_err, ctx) => { errors.push(ctx); },
    });

    await daemon.tick();
    const sends = calls.filter(c => c.method === 'sendMessage');
    expect(sends).toHaveLength(1);
    expect(String(sends[0]!.body.text)).toContain('could not generate');
    expect(errors.some(e => e.includes('invokeClaude'))).toBe(true);
  });

  it('subsequent tick does not reprocess already-seen updates', async () => {
    const host = createMemoryHost();
    const invoke = vi.fn().mockResolvedValue({
      text: 'ok',
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
    });
    const { fetchImpl } = buildMockFetch([
      [{
        update_id: 600,
        message: { message_id: 1, from: { id: 1 }, chat: { id: CHAT_ID }, text: 'first' },
      }],
      [], // second poll returns empty
    ]);
    const daemon = new LAGDaemon({
      host,
      botToken: 'FAKE',
      chatId: CHAT_ID,
      canonFilePath: canonPath,
      principalResolver: () => PRINCIPAL,
      fetchImpl,
      invokeImpl: invoke as never,
    });

    expect(await daemon.tick()).toBe(1);
    expect(await daemon.tick()).toBe(0);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe('splitForTelegram', () => {
  it('returns a single chunk when under limit', () => {
    expect(splitForTelegram('short', 1000)).toEqual(['short']);
  });

  it('splits at newlines when possible', () => {
    const text = 'a'.repeat(100) + '\n' + 'b'.repeat(100);
    const chunks = splitForTelegram(text, 150);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toBe('a'.repeat(100));
  });

  it('splits at spaces when no newline near the cut', () => {
    const text = 'word '.repeat(200);
    const chunks = splitForTelegram(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    // All chunks fit within the limit.
    expect(chunks.every(c => c.length <= 100)).toBe(true);
    // Reassembled roughly equals the original (modulo whitespace).
    expect(chunks.join(' ').replace(/\s+/g, ' ').trim()).toBe(text.trim());
  });

  it('hard-splits when no whitespace is available', () => {
    const text = 'x'.repeat(1000);
    const chunks = splitForTelegram(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(c => c.length <= 100)).toBe(true);
  });
});
