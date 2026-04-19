/**
 * CliRenderer: turns a stream of CliRendererEvents into a coherent,
 * rate-limited, CLI-style message flow on any post/edit-capable
 * channel (Telegram bot API being the first consumer).
 *
 * UX shape per run:
 *   1. On `start`: post ONE message.
 *        [🟡] Claude is working... (0s)
 *        <small hint if provided>
 *   2. Heartbeat (every heartbeatIntervalMs, cycling spinner frame,
 *      updating elapsed seconds, rate-limited by editRateLimitMs):
 *        [🟠] Claude is working... (12s)
 *        🔧 Read src/foo.ts
 *        🔧 Edit src/foo.ts (+3/-1)
 *        ...
 *   3. On `tool-call` / `tool-result` / `thinking` / `text-delta`:
 *      append to the activity buffer (bounded window) and schedule
 *      an edit. Rate limiter coalesces rapid events.
 *   4. On `complete`: stop heartbeat, edit the message to the final
 *      rendered text (via options.renderFinal). If the final exceeds
 *      channel limits, split and post additional messages.
 *   5. On `error`: stop heartbeat, edit the message to an error
 *      indicator with the error text.
 *
 * Properties guaranteed:
 *   - Never exceeds editRateLimitMs rate (coalesces queued updates).
 *   - Heartbeat fires only while a message is posted AND not completed.
 *   - dispose() is idempotent; safe to call in a finally block.
 *   - Errors in channel.post / channel.edit are caught and logged; the
 *     renderer continues (best-effort rendering is better than crashing
 *     the caller on a transient Telegram outage).
 */

import type {
  CliRendererChannel,
  CliRendererEvent,
  CliRendererOptions,
} from './types.js';

const DEFAULT_SPINNER = ['🟡', '🟠', '🔴', '🟣', '🔵', '🟢'] as const;
const DEFAULT_EDIT_RATE_MS = 1500;
const DEFAULT_HEARTBEAT_MS = 3000;
const DEFAULT_ACTIVITY_WINDOW = 8;
const DEFAULT_MAX_CHARS = 4000;

interface ActivityLine {
  readonly icon: string;
  readonly text: string;
}

export class CliRenderer {
  private readonly channel: CliRendererChannel;
  private readonly now: () => number;
  private readonly editRateLimitMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly spinnerFrames: ReadonlyArray<string>;
  private readonly activityWindow: number;
  private readonly renderFinal: (markdown: string) => string;
  private readonly splitFinal: (text: string) => ReadonlyArray<string>;

  private messageId: string | null = null;
  private startedAtMs = 0;
  private lastEditMs = 0;
  private spinnerIdx = 0;
  private label = 'Claude is working';
  private hint?: string;
  private activity: ActivityLine[] = [];
  private accumulatedText = '';
  private thinkingBuffer = '';
  private heartbeatHandle: ReturnType<typeof setInterval> | null = null;
  private pendingEditTimer: ReturnType<typeof setTimeout> | null = null;
  private completed = false;
  private disposed = false;

  constructor(options: CliRendererOptions) {
    this.channel = options.channel;
    this.now = options.now ?? (() => Date.now());
    this.editRateLimitMs = options.editRateLimitMs ?? DEFAULT_EDIT_RATE_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
    this.spinnerFrames = options.spinnerFrames ?? DEFAULT_SPINNER;
    this.activityWindow = options.activityWindow ?? DEFAULT_ACTIVITY_WINDOW;
    this.renderFinal = options.renderFinal ?? ((s) => s);
    this.splitFinal = options.splitFinal ?? defaultSplit;
  }

  /**
   * Feed an event. Returns after any immediate edit (rate-limiter
   * permitting) so callers can sequence events without awaiting internal
   * timers. Returns even if the channel call fails (errors are logged).
   */
  async emit(event: CliRendererEvent): Promise<void> {
    if (this.disposed) return;

    switch (event.type) {
      case 'start':
        await this.handleStart(event.label, event.hint);
        return;
      case 'tool-call':
        this.appendActivity('🔧', `${event.tool}: ${truncate(event.summary, 60)}`);
        this.scheduleEdit();
        return;
      case 'tool-result':
        this.appendActivity(
          event.ok ? '✓' : '✗',
          event.summary ? `${event.tool}: ${truncate(event.summary, 60)}` : event.tool,
        );
        this.scheduleEdit();
        return;
      case 'thinking':
        this.thinkingBuffer = this.thinkingBuffer
          ? this.thinkingBuffer + '\n' + event.text
          : event.text;
        // Thinking doesn't appear in the progress view (too noisy).
        // It's folded into the final message as a spoiler.
        return;
      case 'text-delta':
        this.accumulatedText += event.text;
        return;
      case 'complete':
        await this.handleComplete(event.finalText, event.meta);
        return;
      case 'error':
        await this.handleError(event.message);
        return;
    }
  }

  /**
   * Stop the heartbeat and release any pending edit timer. Safe to
   * call multiple times. Does NOT edit the message; call this from
   * finally after emitting a terminal event.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stopHeartbeat();
    if (this.pendingEditTimer) {
      clearTimeout(this.pendingEditTimer);
      this.pendingEditTimer = null;
    }
  }

  private async handleStart(label?: string, hint?: string): Promise<void> {
    if (this.messageId !== null) return;
    if (label) this.label = label;
    if (hint !== undefined) this.hint = hint;
    this.startedAtMs = this.now();
    const body = this.renderProgress();
    try {
      const posted = await this.channel.post({
        text: body,
        parseMode: 'HTML',
        disableNotification: true,
      });
      this.messageId = posted.messageId;
      this.lastEditMs = this.now();
      this.startHeartbeat();
    } catch (err) {
      logChannelError('post', err);
    }
  }

  private async handleComplete(
    finalText: string,
    meta?: Readonly<Record<string, string | number>>,
  ): Promise<void> {
    this.completed = true;
    this.stopHeartbeat();
    if (this.pendingEditTimer) {
      clearTimeout(this.pendingEditTimer);
      this.pendingEditTimer = null;
    }
    const withThinking = this.thinkingBuffer
      ? `${finalText}\n\n<details>\n<summary>thinking</summary>\n${this.thinkingBuffer}\n</details>`
      : finalText;
    const footer = this.renderFooter(meta);
    const composed = footer ? `${withThinking}\n\n${footer}` : withThinking;
    const rendered = this.renderFinal(composed);
    const chunks = this.splitFinal(rendered);
    if (chunks.length === 0) return;
    if (this.messageId === null) {
      // start never got called or failed; post the final directly.
      try {
        const posted = await this.channel.post({ text: chunks[0]!, parseMode: 'HTML' });
        this.messageId = posted.messageId;
      } catch (err) {
        logChannelError('post', err);
        return;
      }
    } else {
      try {
        await this.channel.edit(this.messageId, { text: chunks[0]!, parseMode: 'HTML' });
      } catch (err) {
        logChannelError('edit', err);
      }
    }
    for (let i = 1; i < chunks.length; i++) {
      try {
        await this.channel.post({ text: chunks[i]!, parseMode: 'HTML' });
      } catch (err) {
        logChannelError('post', err);
      }
    }
  }

  private async handleError(message: string): Promise<void> {
    this.stopHeartbeat();
    const text = `<b>⚠️ Error</b>\n\n${escapeHtml(message)}`;
    if (this.messageId === null) {
      try {
        await this.channel.post({ text, parseMode: 'HTML' });
      } catch (err) {
        logChannelError('post', err);
      }
      return;
    }
    try {
      await this.channel.edit(this.messageId, { text, parseMode: 'HTML' });
    } catch (err) {
      logChannelError('edit', err);
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatHandle !== null) return;
    this.heartbeatHandle = setInterval(() => {
      if (this.completed || this.disposed) {
        this.stopHeartbeat();
        return;
      }
      this.spinnerIdx = (this.spinnerIdx + 1) % this.spinnerFrames.length;
      this.scheduleEdit();
    }, this.heartbeatIntervalMs);
    // Don't hold the event loop open on heartbeats alone.
    if (typeof this.heartbeatHandle.unref === 'function') {
      this.heartbeatHandle.unref();
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatHandle === null) return;
    clearInterval(this.heartbeatHandle);
    this.heartbeatHandle = null;
  }

  private scheduleEdit(): void {
    if (this.messageId === null || this.completed || this.disposed) return;
    const elapsed = this.now() - this.lastEditMs;
    if (elapsed >= this.editRateLimitMs) {
      void this.flushEdit();
      return;
    }
    if (this.pendingEditTimer !== null) return;
    this.pendingEditTimer = setTimeout(() => {
      this.pendingEditTimer = null;
      void this.flushEdit();
    }, this.editRateLimitMs - elapsed);
    if (typeof this.pendingEditTimer.unref === 'function') {
      this.pendingEditTimer.unref();
    }
  }

  private async flushEdit(): Promise<void> {
    if (this.messageId === null || this.completed || this.disposed) return;
    const body = this.renderProgress();
    this.lastEditMs = this.now();
    try {
      await this.channel.edit(this.messageId, {
        text: body,
        parseMode: 'HTML',
        disableNotification: true,
      });
    } catch (err) {
      logChannelError('edit', err);
    }
  }

  private appendActivity(icon: string, text: string): void {
    this.activity.push({ icon, text });
    if (this.activity.length > this.activityWindow) {
      this.activity.splice(0, this.activity.length - this.activityWindow);
    }
  }

  private renderProgress(): string {
    const frame = this.spinnerFrames[this.spinnerIdx]!;
    const elapsedSec = Math.max(0, Math.floor((this.now() - this.startedAtMs) / 1000));
    const head = `${frame} ${escapeHtml(this.label)}... (${elapsedSec}s)`;
    const hintLine = this.hint ? `\n<i>${escapeHtml(this.hint)}</i>` : '';
    const activityLines = this.activity.length === 0
      ? ''
      : '\n\n' + this.activity.map((a) => `${a.icon} ${escapeHtml(a.text)}`).join('\n');
    return head + hintLine + activityLines;
  }

  private renderFooter(meta: Readonly<Record<string, string | number>> | undefined): string {
    if (!meta || Object.keys(meta).length === 0) return '';
    const parts = Object.entries(meta).map(([k, v]) => `${k}=${String(v)}`);
    return `<i>${escapeHtml(parts.join(' · '))}</i>`;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function defaultSplit(text: string): ReadonlyArray<string> {
  if (text.length <= DEFAULT_MAX_CHARS) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > DEFAULT_MAX_CHARS) {
    // Prefer breaking at the last newline before the limit.
    const slice = remaining.slice(0, DEFAULT_MAX_CHARS);
    const lastBreak = slice.lastIndexOf('\n\n');
    const cut = lastBreak > DEFAULT_MAX_CHARS * 0.5 ? lastBreak : DEFAULT_MAX_CHARS;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, '');
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function logChannelError(op: 'post' | 'edit', err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(`[cli-renderer] channel.${op} failed: ${msg}`);
}
