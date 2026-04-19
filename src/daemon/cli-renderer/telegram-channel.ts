/**
 * TelegramChannel: a CliRendererChannel wired to the Telegram Bot API.
 *
 * Posts a message via sendMessage, edits via editMessageText. Both calls
 * go to api.telegram.org directly; no Telegram library dependency. We
 * already use this pattern elsewhere in the daemon.
 *
 * The caller supplies botToken + chatId. parse_mode defaults to 'HTML'
 * since the renderer emits HTML. disable_notification is honored.
 */

import type {
  CliRendererChannel,
  MessageOptions,
  PostedMessage,
} from './types.js';

export interface TelegramChannelOptions {
  readonly botToken: string;
  readonly chatId: string | number;
  readonly apiBase?: string;
  readonly fetchImpl?: typeof fetch;
  /**
   * Optional reply-to message id, applied to the initial post so the
   * throbber threads beneath the operator's inbound message.
   */
  readonly replyToMessageId?: number;
}

export function createTelegramChannel(opts: TelegramChannelOptions): CliRendererChannel {
  const apiBase = opts.apiBase ?? 'https://api.telegram.org';
  const fetchImpl = opts.fetchImpl ?? fetch;
  const chatId = opts.chatId;
  const base = `${apiBase}/bot${opts.botToken}`;

  async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetchImpl(`${base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`telegram ${method} ${res.status}: ${text.slice(0, 200)}`);
    }
    const parsed = await res.json() as { ok: boolean; result?: T; description?: string };
    if (!parsed.ok) {
      throw new Error(`telegram ${method} not-ok: ${parsed.description ?? 'unknown'}`);
    }
    return parsed.result as T;
  }

  return {
    async post(message: MessageOptions): Promise<PostedMessage> {
      const body: Record<string, unknown> = {
        chat_id: chatId,
        text: message.text,
      };
      if (message.parseMode) body.parse_mode = message.parseMode;
      if (message.disableNotification) body.disable_notification = true;
      if (opts.replyToMessageId !== undefined) {
        body.reply_to_message_id = opts.replyToMessageId;
      }
      if (message.actions && message.actions.length > 0) {
        body.reply_markup = toInlineKeyboard(message.actions);
      }
      const result = await call<{ message_id: number }>('sendMessage', body);
      return { messageId: String(result.message_id) };
    },
    async edit(messageId: string, message: MessageOptions): Promise<void> {
      const body: Record<string, unknown> = {
        chat_id: chatId,
        message_id: Number(messageId),
        text: message.text,
      };
      if (message.parseMode) body.parse_mode = message.parseMode;
      // Telegram keeps the prior reply_markup unless we send one explicitly,
      // so the absence of `actions` here leaves the button attached; pass
      // actions: [] to clear it on a terminal edit.
      if (message.actions !== undefined) {
        body.reply_markup = toInlineKeyboard(message.actions);
      }
      // edit doesn't take disable_notification; Telegram already
      // silences edits by default.
      await call<{ message_id: number }>('editMessageText', body);
    },
  };
}

function toInlineKeyboard(
  actions: ReadonlyArray<{ label: string; callbackData: string }>,
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  if (actions.length === 0) return { inline_keyboard: [] };
  return {
    inline_keyboard: [
      actions.map((a) => ({ text: a.label, callback_data: a.callbackData })),
    ],
  };
}
