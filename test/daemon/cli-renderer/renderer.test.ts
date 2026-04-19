/**
 * CliRenderer tests (Phase 56a).
 *
 * Tests use a StubChannel + injected clock so every timing claim is
 * deterministic. No real setTimeout/setInterval behaviour is relied on;
 * the renderer's internal timers are exercised by advancing the clock
 * via fake-timer style control.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliRenderer } from '../../../src/daemon/cli-renderer/renderer.js';
import type {
  CliRendererChannel,
  MessageOptions,
  PostedMessage,
} from '../../../src/daemon/cli-renderer/types.js';

interface Call {
  readonly kind: 'post' | 'edit';
  readonly messageId?: string;
  readonly text: string;
  readonly parseMode?: string;
  readonly disableNotification?: boolean;
}

function mkStubChannel(): { channel: CliRendererChannel; calls: Call[] } {
  const calls: Call[] = [];
  let nextId = 100;
  return {
    calls,
    channel: {
      async post(message: MessageOptions): Promise<PostedMessage> {
        calls.push({
          kind: 'post',
          text: message.text,
          ...(message.parseMode === undefined ? {} : { parseMode: message.parseMode }),
          ...(message.disableNotification === undefined ? {} : { disableNotification: message.disableNotification }),
        });
        return { messageId: String(nextId++) };
      },
      async edit(messageId: string, message: MessageOptions): Promise<void> {
        calls.push({
          kind: 'edit',
          messageId,
          text: message.text,
          ...(message.parseMode === undefined ? {} : { parseMode: message.parseMode }),
          ...(message.disableNotification === undefined ? {} : { disableNotification: message.disableNotification }),
        });
      },
    },
  };
}

describe('CliRenderer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('start posts an initial message with the throbber + label', async () => {
    const { channel, calls } = mkStubChannel();
    const renderer = new CliRenderer({ channel, now: () => 1_000_000 });
    await renderer.emit({ type: 'start', label: 'Claude is working' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.kind).toBe('post');
    expect(calls[0]!.text).toContain('Claude is working');
    expect(calls[0]!.text).toContain('(0s)');
    expect(calls[0]!.parseMode).toBe('HTML');
    expect(calls[0]!.disableNotification).toBe(true);
    await renderer.dispose();
  });

  it('tool-call adds an activity line and schedules an edit (rate-limited)', async () => {
    let t = 1_000_000;
    const { channel, calls } = mkStubChannel();
    const renderer = new CliRenderer({ channel, now: () => t, editRateLimitMs: 500 });
    await renderer.emit({ type: 'start' });
    // Advance past rate limit to allow immediate edit.
    t += 600;
    await renderer.emit({ type: 'tool-call', tool: 'Read', summary: 'src/foo.ts' });

    const edits = calls.filter((c) => c.kind === 'edit');
    expect(edits).toHaveLength(1);
    expect(edits[0]!.text).toContain('🔧 Read: src/foo.ts');
    await renderer.dispose();
  });

  it('coalesces rapid events inside the rate-limit window', async () => {
    let t = 1_000_000;
    const { channel, calls } = mkStubChannel();
    const renderer = new CliRenderer({
      channel,
      now: () => t,
      editRateLimitMs: 1500,
      heartbeatIntervalMs: 10_000,
    });
    await renderer.emit({ type: 'start' });
    // Immediately after start (0ms), emit three events.
    await renderer.emit({ type: 'tool-call', tool: 'Read', summary: 'a' });
    await renderer.emit({ type: 'tool-call', tool: 'Read', summary: 'b' });
    await renderer.emit({ type: 'tool-call', tool: 'Read', summary: 'c' });

    // No edit yet (rate-limited; pending timer scheduled).
    expect(calls.filter((c) => c.kind === 'edit')).toHaveLength(0);

    // Advance past the rate limit; the pending timer fires.
    t += 1600;
    await vi.advanceTimersByTimeAsync(1600);

    const edits = calls.filter((c) => c.kind === 'edit');
    expect(edits).toHaveLength(1);
    // All three activity lines should appear in the single coalesced edit.
    expect(edits[0]!.text).toContain('🔧 Read: a');
    expect(edits[0]!.text).toContain('🔧 Read: b');
    expect(edits[0]!.text).toContain('🔧 Read: c');
    const countLines = (edits[0]!.text.match(/🔧/g) ?? []).length;
    expect(countLines).toBe(3);
    await renderer.dispose();
  });

  it('complete stops the heartbeat and edits the message to the final text', async () => {
    let t = 1_000_000;
    const { channel, calls } = mkStubChannel();
    const renderer = new CliRenderer({ channel, now: () => t, editRateLimitMs: 0 });
    await renderer.emit({ type: 'start' });
    t += 10;
    await renderer.emit({ type: 'complete', finalText: 'Done.', meta: { tokens: 120 } });

    const edits = calls.filter((c) => c.kind === 'edit');
    expect(edits.length).toBeGreaterThanOrEqual(1);
    const finalEdit = edits[edits.length - 1]!;
    expect(finalEdit.text).toContain('Done.');
    expect(finalEdit.text).toContain('tokens=120');
    await renderer.dispose();
  });

  it('complete folds thinking into a <details> block', async () => {
    let t = 1_000_000;
    const { channel, calls } = mkStubChannel();
    const renderer = new CliRenderer({ channel, now: () => t, editRateLimitMs: 0 });
    await renderer.emit({ type: 'start' });
    await renderer.emit({ type: 'thinking', text: 'considering approaches' });
    await renderer.emit({ type: 'complete', finalText: 'Answer.' });

    const final = calls[calls.length - 1]!;
    expect(final.text).toContain('Answer.');
    expect(final.text).toContain('considering approaches');
    expect(final.text).toContain('thinking');
    await renderer.dispose();
  });

  it('complete splits long finals into multiple messages', async () => {
    let t = 1_000_000;
    const { channel, calls } = mkStubChannel();
    const big = 'x'.repeat(9000); // > 4000 chars default split
    const renderer = new CliRenderer({ channel, now: () => t, editRateLimitMs: 0 });
    await renderer.emit({ type: 'start' });
    await renderer.emit({ type: 'complete', finalText: big });

    const edits = calls.filter((c) => c.kind === 'edit');
    const posts = calls.filter((c) => c.kind === 'post');
    expect(edits).toHaveLength(1); // first chunk replaces the throbber
    // remaining chunks posted fresh; with 9000 chars / 4000 default, expect 2 additional posts
    // (the initial start also counts as a post, so total posts >= 2).
    expect(posts.length).toBeGreaterThanOrEqual(2);
    await renderer.dispose();
  });

  it('error edits the message to an error banner and stops heartbeat', async () => {
    let t = 1_000_000;
    const { channel, calls } = mkStubChannel();
    const renderer = new CliRenderer({ channel, now: () => t, editRateLimitMs: 0 });
    await renderer.emit({ type: 'start' });
    await renderer.emit({ type: 'error', message: 'budget exceeded' });

    const final = calls[calls.length - 1]!;
    expect(final.text).toContain('Error');
    expect(final.text).toContain('budget exceeded');
    await renderer.dispose();
  });

  it('dispose is idempotent', async () => {
    const { channel } = mkStubChannel();
    const renderer = new CliRenderer({ channel, now: () => 1_000_000 });
    await renderer.emit({ type: 'start' });
    await renderer.dispose();
    await renderer.dispose(); // second call must not throw
    expect(true).toBe(true);
  });

  it('swallows channel post failures and keeps running', async () => {
    const calls: Call[] = [];
    let postAttempts = 0;
    const channel: CliRendererChannel = {
      async post() {
        postAttempts++;
        throw new Error('telegram 500');
      },
      async edit(id, m) {
        calls.push({ kind: 'edit', messageId: id, text: m.text });
      },
    };
    const renderer = new CliRenderer({ channel, now: () => 1_000_000 });
    await renderer.emit({ type: 'start' });
    // Despite the post failure, subsequent emits must not throw.
    await renderer.emit({ type: 'tool-call', tool: 'Read', summary: 'x' });
    await renderer.emit({ type: 'complete', finalText: 'done' });
    expect(postAttempts).toBeGreaterThan(0);
    await renderer.dispose();
  });

  it('activity window bounds the number of lines kept', async () => {
    let t = 1_000_000;
    const { channel, calls } = mkStubChannel();
    const renderer = new CliRenderer({
      channel,
      now: () => t,
      editRateLimitMs: 0,
      activityWindow: 3,
    });
    await renderer.emit({ type: 'start' });
    for (let i = 0; i < 6; i++) {
      t += 1;
      await renderer.emit({ type: 'tool-call', tool: 'X', summary: `step-${i}` });
    }
    t += 10;
    await renderer.emit({ type: 'complete', finalText: 'done' });
    // The final message no longer shows activity (it's the final render).
    // But an intermediate edit should have at most `activityWindow` lines.
    const intermediateEdits = calls.filter((c) => c.kind === 'edit' && !c.text.includes('done'));
    const last = intermediateEdits[intermediateEdits.length - 1];
    if (last) {
      const toolLines = (last.text.match(/🔧/g) ?? []).length;
      expect(toolLines).toBeLessThanOrEqual(3);
    }
    await renderer.dispose();
  });
});
