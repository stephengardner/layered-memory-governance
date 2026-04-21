/**
 * Voice message ingestion tests (Phase 48a).
 *
 * StubTranscriber: deterministic unit tests for the adapter shape.
 * Daemon: mock Telegram + mock transcriber prove a voice update flows
 * through handleMessage as if it were text.
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { Daemon, StubTranscriber } from '../../src/runtime/daemon/index.js';
import type { PrincipalId } from '../../src/substrate/types.js';

const PRINCIPAL = 'stephen-human' as PrincipalId;
const CHAT_ID = 12345;

async function emptyCanonPath(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'lag-voice-'));
  const p = join(d, 'CLAUDE.md');
  await writeFile(p, '');
  return p;
}

interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

function buildVoiceFetch(
  updates: Array<Record<string, unknown>>,
  fakeFilePath = 'voice/file_1.oga',
  fakeBytes = Buffer.from('fake-opus'),
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let getUpdatesCalls = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const u = String(url);
    const methodMatch = /\/bot[^/]+\/([a-zA-Z]+)$/.exec(u);
    const method = methodMatch ? methodMatch[1]! : (u.includes('/file/bot') ? 'download' : 'unknown');
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, url: u, body });

    if (method === 'getUpdates') {
      const result = getUpdatesCalls === 0 ? updates : [];
      getUpdatesCalls += 1;
      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (method === 'getFile') {
      return new Response(JSON.stringify({ ok: true, result: { file_path: fakeFilePath } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (method === 'download') {
      return new Response(fakeBytes, {
        status: 200,
        headers: { 'content-type': 'audio/ogg' },
      });
    }
    if (method === 'sendMessage') {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

describe('StubTranscriber', () => {
  it('returns canned response when provided', async () => {
    const t = new StubTranscriber('hello world');
    expect(await t.transcribe(Buffer.from([1, 2, 3]), 'audio/ogg')).toBe('hello world');
  });

  it('returns size-aware stub when no canned response', async () => {
    const t = new StubTranscriber();
    const r = await t.transcribe(Buffer.from('abc'), 'audio/ogg');
    expect(r).toContain('3 bytes');
    expect(r).toContain('audio/ogg');
  });
});

describe('Daemon: voice message path', () => {
  it('downloads + transcribes + routes through handleMessage', async () => {
    const canonPath = await emptyCanonPath();
    const host = createMemoryHost();

    const { fetchImpl, calls } = buildVoiceFetch([
      {
        update_id: 700,
        message: {
          message_id: 1,
          from: { id: 1, username: 'stephen' },
          chat: { id: CHAT_ID },
          voice: {
            file_id: 'voice-abc',
            duration: 3,
            mime_type: 'audio/ogg',
            file_size: 9,
          },
        },
      },
    ]);

    const invoke = vi.fn().mockResolvedValue({
      text: 'Got your voice message.',
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
    });
    const transcriber = new StubTranscriber('transcribed: hello claude');

    const daemon = new Daemon({
      host,
      botToken: 'FAKE',
      chatId: CHAT_ID,
      canonFilePath: canonPath,
      principalResolver: () => PRINCIPAL,
      fetchImpl,
      invokeImpl: invoke as never,
      voiceTranscriber: transcriber,
    });

    const processed = await daemon.tick();
    expect(processed).toBe(1);

    // Call sequence: getUpdates, getFile, download, sendMessage.
    const methods = calls.map(c => c.method);
    expect(methods).toContain('getUpdates');
    expect(methods).toContain('getFile');
    expect(methods).toContain('download');
    expect(methods).toContain('sendMessage');

    // Invoke saw the transcribed text as userMessage.
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]![0].userMessage).toBe('transcribed: hello claude');

    // Two atoms written: user (transcribed) + assistant.
    const all = await host.atoms.query({}, 10);
    expect(all.atoms.map(a => a.content).sort()).toEqual(
      ['Got your voice message.', 'transcribed: hello claude'].sort(),
    );
  });

  it('ignores voice messages when no transcriber is configured', async () => {
    const canonPath = await emptyCanonPath();
    const host = createMemoryHost();

    const { fetchImpl, calls } = buildVoiceFetch([
      {
        update_id: 800,
        message: {
          message_id: 1,
          from: { id: 1 },
          chat: { id: CHAT_ID },
          voice: { file_id: 'voice-ignored', duration: 2 },
        },
      },
    ]);

    const invoke = vi.fn();
    const daemon = new Daemon({
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
    const atoms = await host.atoms.query({}, 10);
    expect(atoms.atoms).toHaveLength(0);
    // No download attempt either.
    expect(calls.map(c => c.method)).not.toContain('download');
  });

  it('apologizes to the user when the transcriber throws', async () => {
    const canonPath = await emptyCanonPath();
    const host = createMemoryHost();

    const { fetchImpl, calls } = buildVoiceFetch([
      {
        update_id: 900,
        message: {
          message_id: 1,
          from: { id: 1 },
          chat: { id: CHAT_ID },
          voice: { file_id: 'voice-bad', duration: 1 },
        },
      },
    ]);

    const errors: string[] = [];
    const transcriber: { id: string; transcribe: () => Promise<string> } = {
      id: 'fail',
      transcribe: async () => { throw new Error('stt broke'); },
    };
    const daemon = new Daemon({
      host,
      botToken: 'FAKE',
      chatId: CHAT_ID,
      canonFilePath: canonPath,
      principalResolver: () => PRINCIPAL,
      fetchImpl,
      invokeImpl: (async () => ({ text: 'unused', costUsd: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 })) as never,
      voiceTranscriber: transcriber,
      onError: (_err, ctx) => { errors.push(ctx); },
    });

    await daemon.tick();

    const sends = calls.filter(c => c.method === 'sendMessage');
    expect(sends).toHaveLength(1);
    expect(String((sends[0]!.body as { text: string }).text)).toContain('could not transcribe');
    expect(errors.some(e => e.includes('transcribeVoice'))).toBe(true);
  });
});
