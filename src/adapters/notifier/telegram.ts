/**
 * Telegram Notifier channel.
 *
 * Wraps a base Notifier (typically FileNotifier or MemoryNotifier) and
 * forwards dispositions to it while ALSO:
 *   - Sending a formatted message to a Telegram chat on telegraph()
 *   - Polling getUpdates for callback_query responses and translating
 *     them into respond() calls on the base notifier
 *
 * Design choice: wrapper, not replacement. The base is the single
 * source of truth for local state (pending / responded). Telegram is
 * just a messaging + response channel layered on top. If Telegram is
 * unavailable, the base still works, so the governance loop degrades
 * gracefully rather than stalling on a network hiccup.
 *
 * Message shape on the Telegram side:
 *
 *   LAG: <event.summary>
 *
 *   <event.body>
 *
 *   Handle: <handle>
 *   Kind: <event.kind>  Severity: <event.severity>
 *   [Approve] [Reject] [Ignore]
 *
 * callback_data is encoded as `<handle>:<disposition>` (fits in Telegram's
 * 64-byte limit for 24-char handles).
 */

import type { Notifier } from '../../substrate/interface.js';
import type {
  Diff,
  Disposition,
  Event,
  NotificationHandle,
  PrincipalId,
} from '../../substrate/types.js';

export interface TelegramNotifierOptions {
  /** Bot token from @BotFather. */
  readonly botToken: string;
  /** Chat id (numeric or @username) where escalations are delivered. */
  readonly chatId: string | number;
  /** The base notifier holding local state. Wrapper delegates to it. */
  readonly base: Notifier;
  /** Principal id to record when a Telegram reply resolves a handle. */
  readonly respondAsPrincipal: PrincipalId;
  /** Polling interval for incoming callback_query updates. Default 2000ms. */
  readonly pollIntervalMs?: number;
  /**
   * Fetch implementation. Defaults to global fetch. Tests inject a mock
   * that returns pre-baked Telegram API responses.
   */
  readonly fetchImpl?: typeof fetch;
  /** Optional error sink; defaults to console.error. */
  readonly onError?: (err: unknown, context: string) => void;
}

interface TelegramUpdate {
  readonly update_id: number;
  readonly callback_query?: {
    readonly id: string;
    readonly from: { readonly id: number; readonly username?: string };
    readonly data?: string;
    readonly message?: { readonly message_id: number; readonly chat: { readonly id: number } };
  };
  readonly message?: {
    readonly message_id: number;
    readonly chat: { readonly id: number };
    readonly text?: string;
    readonly from?: { readonly id: number; readonly username?: string };
  };
}

interface TelegramResponse<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly error_code?: number;
  readonly description?: string;
}

const DISPOSITIONS: ReadonlyArray<Disposition> = ['approve', 'reject', 'ignore'];

export class TelegramNotifier implements Notifier {
  private readonly base: Notifier;
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly respondAs: PrincipalId;
  private readonly pollIntervalMs: number;
  private readonly fetch: typeof fetch;
  private readonly onError: (err: unknown, context: string) => void;

  private updateOffset: number = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private polling: boolean = false;

  constructor(options: TelegramNotifierOptions) {
    this.base = options.base;
    this.botToken = options.botToken;
    this.chatId = String(options.chatId);
    this.respondAs = options.respondAsPrincipal;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.fetch = options.fetchImpl ?? globalThis.fetch;
    this.onError = options.onError ?? ((err, ctx) => {
      // eslint-disable-next-line no-console
      console.error(`[TelegramNotifier] ${ctx}:`, err);
    });
  }

  async telegraph(
    event: Event,
    diff: Diff | null,
    defaultDisposition: Disposition,
    timeoutMs: number,
  ): Promise<NotificationHandle> {
    const handle = await this.base.telegraph(event, diff, defaultDisposition, timeoutMs);
    try {
      await this.sendEscalation(handle, event);
    } catch (err) {
      this.onError(err, `sendEscalation(${String(handle)})`);
      // Do not rethrow: the base notifier already holds the entry, and a
      // dropped Telegram message must not stall the governance loop.
    }
    return handle;
  }

  async disposition(handle: NotificationHandle): Promise<Disposition> {
    return this.base.disposition(handle);
  }

  async awaitDisposition(
    handle: NotificationHandle,
    maxWaitMs: number,
  ): Promise<Disposition> {
    return this.base.awaitDisposition(handle, maxWaitMs);
  }

  async respond(
    handle: NotificationHandle,
    disposition: Disposition,
    responderId: PrincipalId,
  ): Promise<void> {
    return this.base.respond(handle, disposition, responderId);
  }

  /**
   * Start the background poll loop. Idempotent: second call is a no-op.
   * Callers must await stopPolling() before process exit to avoid a
   * stuck timer.
   */
  startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    const run = async (): Promise<void> => {
      if (!this.polling) return;
      try {
        await this.pollOnce();
      } catch (err) {
        this.onError(err, 'pollOnce');
      }
      if (!this.polling) return;
      this.pollTimer = setTimeout(() => { void run(); }, this.pollIntervalMs);
    };
    // Kick off without awaiting so construction does not block.
    void run();
  }

  stopPolling(): void {
    this.polling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Pull one batch of updates from Telegram and process any callback_query
   * entries that look like LAG dispositions. Advances the update offset so
   * already-seen updates are not reprocessed. Public for test drivers that
   * want to step the polling deterministically.
   */
  async pollOnce(): Promise<number> {
    const startOffset = this.updateOffset;
    const updates = await this.callTelegram<ReadonlyArray<TelegramUpdate>>(
      'getUpdates',
      { offset: startOffset, timeout: 0, limit: 100 },
    );
    let processed = 0;
    for (const update of updates) {
      // Defense in depth: even if the server hands us a stale update
      // (e.g. a test mock that ignores the offset parameter), skip
      // anything we have already advanced past.
      if (update.update_id < startOffset) continue;
      // Advance offset even for updates we ignore so we do not loop.
      if (update.update_id >= this.updateOffset) {
        this.updateOffset = update.update_id + 1;
      }
      const cq = update.callback_query;
      if (!cq || typeof cq.data !== 'string') continue;
      const parsed = parseCallbackData(cq.data);
      if (!parsed) continue;

      try {
        await this.base.respond(parsed.handle, parsed.disposition, this.respondAs);
        processed += 1;
        // Acknowledge the callback so Telegram stops showing a loading spinner.
        await this.answerCallback(cq.id, `LAG: ${parsed.disposition}`);
        // Best-effort edit of the original message body so the user sees
        // which disposition was recorded.
        if (cq.message && cq.message.chat && cq.message.message_id) {
          try {
            await this.editMessage(
              cq.message.chat.id,
              cq.message.message_id,
              `LAG: resolved as ${parsed.disposition}\nHandle: ${parsed.handle}`,
            );
          } catch (err) {
            this.onError(err, 'editMessage');
          }
        }
      } catch (err) {
        this.onError(err, `respond(${String(parsed.handle)})`);
        // Still acknowledge so the user does not get stuck.
        await this.answerCallback(cq.id, 'LAG: error (see server logs)').catch(() => {});
      }
    }
    return processed;
  }

  // ---- Private helpers -----------------------------------------------------

  private async sendEscalation(
    handle: NotificationHandle,
    event: Event,
  ): Promise<void> {
    const text = formatMessage(handle, event);
    const reply_markup = {
      inline_keyboard: [
        DISPOSITIONS.map(d => ({
          text: capitalize(d),
          callback_data: `${String(handle)}:${d}`,
        })),
      ],
    };
    await this.callTelegram('sendMessage', {
      chat_id: this.chatId,
      text,
      reply_markup,
      disable_web_page_preview: true,
    });
  }

  private async answerCallback(id: string, text: string): Promise<void> {
    await this.callTelegram('answerCallbackQuery', {
      callback_query_id: id,
      text,
      show_alert: false,
    });
  }

  private async editMessage(
    chatId: number,
    messageId: number,
    text: string,
  ): Promise<void> {
    await this.callTelegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
    });
  }

  private async callTelegram<T>(
    method: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const url = `https://api.telegram.org/bot${this.botToken}/${method}`;
    const res = await this.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as TelegramResponse<T>;
    if (!json.ok) {
      throw new Error(
        `Telegram ${method} failed: ${json.error_code ?? 'unknown'} ${json.description ?? ''}`,
      );
    }
    return json.result as T;
  }
}

// ---- Pure helpers ----------------------------------------------------------

function formatMessage(handle: NotificationHandle, event: Event): string {
  const lines: string[] = [];
  lines.push(`LAG: ${event.summary}`);
  lines.push('');
  if (event.body) {
    lines.push(event.body);
    lines.push('');
  }
  lines.push(`Handle: ${String(handle)}`);
  lines.push(`Kind: ${event.kind}   Severity: ${event.severity}`);
  return lines.join('\n');
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/**
 * Decode callback_data back into (handle, disposition). Returns null if the
 * shape does not match the LAG format (another bot's button, a stale click
 * from before this version, etc).
 */
export function parseCallbackData(
  data: string,
): { readonly handle: NotificationHandle; readonly disposition: Disposition } | null {
  const colon = data.indexOf(':');
  if (colon < 1) return null;
  const handle = data.slice(0, colon) as NotificationHandle;
  const raw = data.slice(colon + 1);
  if (!DISPOSITIONS.includes(raw as Disposition)) return null;
  return { handle, disposition: raw as Disposition };
}
