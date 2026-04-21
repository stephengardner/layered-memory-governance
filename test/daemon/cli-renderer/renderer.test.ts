/**
 * CliRenderer tests (Phase 56a).
 *
 * Tests use a StubChannel + injected clock so every timing claim is
 * deterministic. No real setTimeout/setInterval behaviour is relied on;
 * the renderer's internal timers are exercised by advancing the clock
 * via fake-timer style control.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliRenderer } from '../../../src/runtime/daemon/cli-renderer/renderer.js';
import type {
  CliRendererChannel,
  MessageOptions,
  PostedMessage,
} from '../../../src/runtime/daemon/cli-renderer/types.js';

interface Call {
  readonly kind: 'post' | 'edit';
  readonly messageId?: string;
  readonly text: string;
  readonly parseMode?: string;
  readonly disableNotification?: boolean;
  readonly actions?: ReadonlyArray<{ label: string; callbackData: string }>;
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
          ...(message.actions === undefined ? {} : { actions: message.actions }),
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
          ...(message.actions === undefined ? {} : { actions: message.actions }),
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

  it('thinking shows live in the throbber but is stripped from the final message', async () => {
    let t = 1_000_000;
    const { channel, calls } = mkStubChannel();
    const renderer = new CliRenderer({ channel, now: () => t, editRateLimitMs: 0 });
    await renderer.emit({ type: 'start' });
    t += 1;
    await renderer.emit({ type: 'thinking', text: 'considering approaches' });

    // Intermediate edit must surface the thinking indicator.
    const intermediate = calls.filter((c) => c.kind === 'edit');
    expect(intermediate.length).toBeGreaterThanOrEqual(1);
    const lastMid = intermediate[intermediate.length - 1]!;
    expect(lastMid.text).toContain('💭');
    expect(lastMid.text).toContain('considering approaches');

    t += 1;
    await renderer.emit({ type: 'complete', finalText: 'Answer.' });

    const final = calls[calls.length - 1]!;
    expect(final.text).toContain('Answer.');
    // Thinking must NOT be embedded in the final message; it lives in
    // the live throbber only.
    expect(final.text).not.toContain('considering approaches');
    expect(final.text).not.toContain('<tg-spoiler>');
    expect(final.text).not.toContain('<details>');
    await renderer.dispose();
  });

  it('serialization: completion always lands LAST, even when a progress edit is in-flight', async () => {
    // Regression guard for the race where scheduleEdit fires a
    // fire-and-forget flushEdit whose channel.edit resolves AFTER a
    // concurrent complete. With the serialized edit chain + post-chain
    // terminal-state recheck, the completion must be the last edit.
    vi.useRealTimers(); // this test needs real microtask sequencing
    let t = 1_000_000;
    const calls: Call[] = [];
    let nextId = 100;
    let gate: (() => void) | null = null;
    const gateReady = new Promise<void>((resolvePromise) => {
      gate = resolvePromise;
    });
    let firstEditStarted: (() => void) | null = null;
    const firstEditHasStarted = new Promise<void>((resolvePromise) => {
      firstEditStarted = resolvePromise;
    });
    const channel: CliRendererChannel = {
      async post(message: MessageOptions): Promise<PostedMessage> {
        calls.push({
          kind: 'post',
          text: message.text,
          ...(message.parseMode === undefined ? {} : { parseMode: message.parseMode }),
        });
        return { messageId: String(nextId++) };
      },
      async edit(messageId: string, message: MessageOptions): Promise<void> {
        const isFirst = calls.filter((c) => c.kind === 'edit').length === 0;
        if (isFirst) {
          firstEditStarted!();
          await gateReady; // hold the first edit open
        }
        calls.push({ kind: 'edit', messageId, text: message.text });
      },
    };

    const renderer = new CliRenderer({
      channel,
      now: () => t,
      editRateLimitMs: 0,
    });

    await renderer.emit({ type: 'start' });
    t += 10;
    // Kick off the first edit (held by gate), wait until it actually
    // enters channel.edit, then queue a complete behind it.
    const firstP = renderer.emit({ type: 'tool-call', tool: 'Read', summary: 'a' });
    await firstEditHasStarted;
    const completeP = renderer.emit({ type: 'complete', finalText: 'Final.' });
    gate!(); // release the held first edit
    await firstP;
    await completeP;

    const editTexts = calls.filter((c) => c.kind === 'edit').map((c) => c.text);
    // The very last edit must be the completion, not a stale progress.
    expect(editTexts[editTexts.length - 1]).toContain('Final.');
    await renderer.dispose();
  });

  it('error is terminal: no progress edits land after it', async () => {
    let t = 1_000_000;
    const { channel, calls } = mkStubChannel();
    const renderer = new CliRenderer({ channel, now: () => t, editRateLimitMs: 0 });
    await renderer.emit({ type: 'start' });
    await renderer.emit({ type: 'error', message: 'died' });
    // A later tool-call must NOT produce another edit; error is terminal.
    await renderer.emit({ type: 'tool-call', tool: 'Read', summary: 'after-error' });
    const editTexts = calls.filter((c) => c.kind === 'edit').map((c) => c.text);
    const last = editTexts[editTexts.length - 1]!;
    expect(last).toContain('Error');
    expect(last).not.toContain('after-error');
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

  it('attaches action button on start and clears it on complete', async () => {
    let t = 1_000_000;
    const { channel, calls } = mkStubChannel();
    const renderer = new CliRenderer({
      channel,
      now: () => t,
      editRateLimitMs: 0,
      action: { label: 'Stop', callbackData: 'run-1' },
    });
    await renderer.emit({ type: 'start' });
    const start = calls.find((c) => c.kind === 'post')!;
    expect(start.actions).toEqual([{ label: 'Stop', callbackData: 'run-1' }]);

    t += 10;
    await renderer.emit({ type: 'complete', finalText: 'done' });
    const final = calls[calls.length - 1]!;
    expect(final.kind).toBe('edit');
    // Terminal edit must clear the button.
    expect(final.actions).toEqual([]);
    await renderer.dispose();
  });

  it('every intermediate edit re-sends the action (Telegram strips reply_markup on omit)', async () => {
    let t = 1_000_000;
    const { channel, calls } = mkStubChannel();
    const renderer = new CliRenderer({
      channel,
      now: () => t,
      editRateLimitMs: 0,
      action: { label: 'Stop', callbackData: 'run-9' },
    });
    await renderer.emit({ type: 'start' });
    t += 1;
    await renderer.emit({ type: 'tool-call', tool: 'Read', summary: 'a' });
    t += 1;
    await renderer.emit({ type: 'tool-call', tool: 'Read', summary: 'b' });
    t += 1;
    await renderer.emit({ type: 'text-delta', text: 'hello world' });
    // Intermediate edits are fired through the serialized edit chain;
    // drain it so the test sees all of them before asserting.
    await renderer.waitForIdle();

    const intermediateEdits = calls.filter((c) => c.kind === 'edit');
    expect(intermediateEdits.length).toBeGreaterThanOrEqual(2);
    for (const e of intermediateEdits) {
      expect(e.actions).toEqual([{ label: 'Stop', callbackData: 'run-9' }]);
    }
    await renderer.dispose();
  });

  it('clears action button on error', async () => {
    let t = 1_000_000;
    const { channel, calls } = mkStubChannel();
    const renderer = new CliRenderer({
      channel,
      now: () => t,
      editRateLimitMs: 0,
      action: { label: 'Stop', callbackData: 'run-2' },
    });
    await renderer.emit({ type: 'start' });
    t += 5;
    await renderer.emit({ type: 'error', message: 'nope' });
    const final = calls[calls.length - 1]!;
    expect(final.kind).toBe('edit');
    expect(final.actions).toEqual([]);
    await renderer.dispose();
  });

  it('text-delta surfaces a live preview blockquote in the throbber', async () => {
    let t = 1_000_000;
    const { channel, calls } = mkStubChannel();
    const renderer = new CliRenderer({
      channel,
      now: () => t,
      editRateLimitMs: 0,
      livePreviewLines: 2,
      livePreviewMaxChars: 100,
    });
    await renderer.emit({ type: 'start' });
    t += 1;
    await renderer.emit({ type: 'text-delta', text: 'line one\nline two\nline three' });
    const edits = calls.filter((c) => c.kind === 'edit');
    expect(edits.length).toBeGreaterThanOrEqual(1);
    const latest = edits[edits.length - 1]!;
    expect(latest.text).toContain('<blockquote>');
    expect(latest.text).toContain('line two');
    expect(latest.text).toContain('line three');
    // Only the last two lines are previewed.
    expect(latest.text).not.toContain('line one');
    await renderer.dispose();
  });

  it('livePreviewMaxChars=0 suppresses the preview block entirely', async () => {
    let t = 1_000_000;
    const { channel, calls } = mkStubChannel();
    const renderer = new CliRenderer({
      channel,
      now: () => t,
      editRateLimitMs: 0,
      livePreviewMaxChars: 0,
    });
    await renderer.emit({ type: 'start' });
    t += 1;
    await renderer.emit({ type: 'text-delta', text: 'anything' });
    const edits = calls.filter((c) => c.kind === 'edit');
    for (const e of edits) {
      expect(e.text).not.toContain('<blockquote>');
    }
    await renderer.dispose();
  });

  it('footer meta uses markdown italic so a markdown->HTML renderFinal does not escape it', async () => {
    let t = 1_000_000;
    const { channel, calls } = mkStubChannel();
    // renderFinal stub: simulate the real markdown->HTML converter by
    // escaping ANY remaining <...> in free text. A footer that already
    // contains raw <i> would get escaped to &lt;i&gt;.
    const renderFinal = (md: string): string => md.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const renderer = new CliRenderer({
      channel,
      now: () => t,
      editRateLimitMs: 0,
      renderFinal,
    });
    await renderer.emit({ type: 'start' });
    await renderer.emit({
      type: 'complete',
      finalText: 'Done.',
      meta: { elapsed: '2s', cost: '$0.0001' },
    });
    const final = calls[calls.length - 1]!;
    // Must NOT contain an escaped literal tag like `&lt;i&gt;`.
    expect(final.text).not.toContain('&lt;i&gt;');
    // Meta content still present.
    expect(final.text).toContain('elapsed=2s');
    expect(final.text).toContain('cost=$0.0001');
    await renderer.dispose();
  });

  it('second complete is a no-op (parser + daemon dedupe)', async () => {
    let t = 1_000_000;
    const { channel, calls } = mkStubChannel();
    const renderer = new CliRenderer({
      channel,
      now: () => t,
      editRateLimitMs: 0,
    });
    await renderer.emit({ type: 'start' });
    await renderer.emit({ type: 'complete', finalText: 'first' });
    const editCountAfterFirst = calls.filter((c) => c.kind === 'edit').length;
    await renderer.emit({ type: 'complete', finalText: 'second' });
    const editCountAfterSecond = calls.filter((c) => c.kind === 'edit').length;
    expect(editCountAfterSecond).toBe(editCountAfterFirst);
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
