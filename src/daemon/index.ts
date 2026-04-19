/**
 * LAG daemon (Phase 41a, minimal).
 *
 * An ambient runtime that:
 *   1. Long-polls Telegram getUpdates.
 *   2. For each incoming text message:
 *      a. Resolves the sender's PrincipalId.
 *      b. Writes the user's message as an L0 atom.
 *      c. Assembles a system prompt from CANON + top-K relevant atoms.
 *      d. Invokes `claude -p` via the InvokeClaude helper.
 *      e. Splits the response for Telegram's 4096-char cap and sends.
 *      f. Writes the assistant's response as an L0 atom.
 *   3. Forwards any callback_query updates to the TelegramNotifier's
 *      response handler (so governance escalations fired into Telegram
 *      from elsewhere get resolved by the daemon's poll loop; single
 *      offset, no double-polling).
 *
 * Shape is intentionally one-user-one-surface. Phase 41b will wire the
 * notifier + arbitration stack so disagreements fire from the daemon's
 * LLM output back into the governance loop. Phase 41c will enable
 * tools behind an authz gate.
 *
 * Reliability goals at this scope:
 *   - Never crash on a malformed update.
 *   - Always reply to the user (even on errors, send a short apology).
 *   - Log every exchange as atoms so the session is resumable.
 */

import type { Host } from '../interface.js';
import type {
  Atom,
  AtomId,
  Disposition,
  PrincipalId,
  Time,
} from '../types.js';
import { ConflictError } from '../errors.js';
import {
  parseCallbackData,
  type TelegramNotifierOptions,
} from '../adapters/notifier/telegram.js';
import { assembleContext, type AssembleContextOptions } from './context.js';
import { markdownToTelegramHtml, splitMarkdownForTelegram } from './format.js';
import { invokeClaude, type InvokeClaudeOptions } from './invoke-claude.js';

export interface LAGDaemonOptions {
  readonly host: Host;
  readonly botToken: string;
  readonly chatId: string | number;
  readonly canonFilePath: string;
  /**
   * Directory to run `claude -p` from. IMPORTANT: without this, Claude
   * CLI falls back to workspace history in ~/.claude.json and leaks
   * unrelated project context. Set to the LAG repo root for clean
   * isolation.
   */
  readonly repoRoot?: string;
  /**
   * Map a Telegram user id to a LAG principal. For V1 you can hardcode
   * one principal; future multi-user daemons will dispatch here.
   */
  readonly principalResolver: (fromId: number, username?: string) => PrincipalId;
  /**
   * Optional responder for callback_query updates. Passed a disposition
   * to apply to the identified notification handle. Most callers pass
   * `host.notifier.respond`.
   */
  readonly onCallback?: (handle: string, disposition: Disposition, responder: PrincipalId) => Promise<void>;
  /** Poll interval in ms. Default 2000. */
  readonly pollIntervalMs?: number;
  /** Max chars per outgoing Telegram message. Default 4000 (Telegram cap is 4096). */
  readonly maxReplyChars?: number;
  /** Context assembler options. Default: k=10, maxChars=16_000. */
  readonly contextOptions?: Omit<AssembleContextOptions, 'canonFilePath'>;
  /** Invoke-claude options. Default: haiku, $1 budget, 180s timeout. */
  readonly invokeOptions?: Partial<Omit<InvokeClaudeOptions, 'userMessage' | 'systemPrompt'>>;
  /** Fetch impl. Default globalThis.fetch. Tests inject a mock. */
  readonly fetchImpl?: typeof fetch;
  /** Invoke-claude impl. Default: invokeClaude. Tests inject a mock. */
  readonly invokeImpl?: typeof invokeClaude;
  /** Error sink. Default: console.error. */
  readonly onError?: (err: unknown, context: string) => void;
}

interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: {
    readonly message_id: number;
    readonly from?: { readonly id: number; readonly username?: string };
    readonly chat: { readonly id: number };
    readonly text?: string;
  };
  readonly callback_query?: {
    readonly id: string;
    readonly from: { readonly id: number; readonly username?: string };
    readonly data?: string;
    readonly message?: { readonly message_id: number; readonly chat: { readonly id: number } };
  };
}

interface TelegramResponse<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly error_code?: number;
  readonly description?: string;
}

export class LAGDaemon {
  private readonly options: LAGDaemonOptions;
  private readonly fetch: typeof fetch;
  private readonly invoke: typeof invokeClaude;
  private readonly onError: (err: unknown, ctx: string) => void;

  private updateOffset: number = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private polling: boolean = false;
  private readonly chatIdString: string;

  constructor(options: LAGDaemonOptions) {
    this.options = options;
    this.fetch = options.fetchImpl ?? globalThis.fetch;
    this.invoke = options.invokeImpl ?? invokeClaude;
    this.onError = options.onError ?? ((err, ctx) => {
      // eslint-disable-next-line no-console
      console.error(`[LAGDaemon] ${ctx}:`, err);
    });
    this.chatIdString = String(options.chatId);
  }

  start(): void {
    if (this.polling) return;
    this.polling = true;
    const run = async (): Promise<void> => {
      if (!this.polling) return;
      try {
        await this.tick();
      } catch (err) {
        this.onError(err, 'tick');
      }
      if (!this.polling) return;
      this.pollTimer = setTimeout(() => { void run(); }, this.options.pollIntervalMs ?? 2000);
    };
    void run();
  }

  stop(): void {
    this.polling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** One poll cycle; public for tests to drive deterministically. */
  async tick(): Promise<number> {
    const startOffset = this.updateOffset;
    const updates = await this.callTelegram<ReadonlyArray<TelegramUpdate>>(
      'getUpdates',
      { offset: startOffset, timeout: 0, limit: 100 },
    );
    let processed = 0;
    for (const update of updates) {
      if (update.update_id < startOffset) continue;
      if (update.update_id >= this.updateOffset) {
        this.updateOffset = update.update_id + 1;
      }

      // Messages first; callback_query handled separately.
      if (update.message && typeof update.message.text === 'string') {
        try {
          await this.handleMessage(update.message);
          processed += 1;
        } catch (err) {
          this.onError(err, `handleMessage(${update.update_id})`);
          // Best-effort: apologize to the user so they are not left hanging.
          try {
            await this.sendMessage(update.message.chat.id, 'Sorry, I hit an error processing that message.');
          } catch (sendErr) {
            this.onError(sendErr, 'sendMessage(apology)');
          }
        }
      }

      if (update.callback_query && this.options.onCallback && typeof update.callback_query.data === 'string') {
        try {
          await this.handleCallback(update.callback_query);
          processed += 1;
        } catch (err) {
          this.onError(err, `handleCallback(${update.callback_query.id})`);
        }
      }
    }
    return processed;
  }

  // ---- Per-update handlers ------------------------------------------------

  private async handleMessage(
    message: NonNullable<TelegramUpdate['message']>,
  ): Promise<void> {
    const chatId = message.chat.id;
    // V1 authz: ignore messages from chats other than the configured one.
    if (String(chatId) !== this.chatIdString) return;
    const text = message.text ?? '';
    if (!text.trim()) return;

    const fromId = message.from?.id ?? 0;
    const username = message.from?.username;
    const principal = this.options.principalResolver(fromId, username);

    // 1. Record the user message as an L0 atom.
    await this.writeConversationAtom(text, 'user-directive', principal);

    // 2. Assemble the context.
    const context = await assembleContext(this.options.host, text, {
      canonFilePath: this.options.canonFilePath,
      ...(this.options.contextOptions ?? {}),
    });

    // 3. Invoke claude -p. If it fails transiently, apologize; if it
    //    succeeds, relay the response.
    let replyText: string;
    try {
      const result = await this.invoke({
        userMessage: text,
        systemPrompt: context.prompt,
        ...(this.options.repoRoot !== undefined ? { cwd: this.options.repoRoot } : {}),
        ...(this.options.invokeOptions ?? {}),
      });
      replyText = result.text.trim() || '(empty response from model)';
    } catch (err) {
      this.onError(err, 'invokeClaude');
      replyText = 'I could not generate a response right now. Please try again.';
    }

    // 4. Send reply(s), splitting if needed. Split on raw markdown first
    //    so each chunk is independently valid; then format per chunk so
    //    HTML tag pairs never span a chunk boundary.
    const maxChars = this.options.maxReplyChars ?? 4000;
    for (const chunk of splitMarkdownForTelegram(replyText, maxChars)) {
      const html = markdownToTelegramHtml(chunk);
      await this.sendMessage(chatId, html, 'HTML');
    }

    // 5. Record the assistant response as an L0 atom.
    await this.writeConversationAtom(replyText, 'agent-observed', principal);
  }

  private async handleCallback(
    cq: NonNullable<TelegramUpdate['callback_query']>,
  ): Promise<void> {
    if (!this.options.onCallback) return;
    if (typeof cq.data !== 'string') return;
    const parsed = parseCallbackData(cq.data);
    if (!parsed) return;
    const responder = this.options.principalResolver(cq.from.id, cq.from.username);
    await this.options.onCallback(parsed.handle, parsed.disposition, responder);
    // Acknowledge so the Telegram UI stops spinning.
    try {
      await this.callTelegram('answerCallbackQuery', {
        callback_query_id: cq.id,
        text: `LAG: ${parsed.disposition}`,
      });
    } catch (err) {
      this.onError(err, 'answerCallbackQuery');
    }
  }

  // ---- Atom helpers -------------------------------------------------------

  private async writeConversationAtom(
    content: string,
    provenanceKind: 'user-directive' | 'agent-observed',
    principalId: PrincipalId,
  ): Promise<void> {
    const id = `daemon-${this.options.host.atoms.contentHash(content).slice(0, 16)}` as AtomId;
    const existing = await this.options.host.atoms.get(id);
    if (existing) return; // content-hash dedup
    const now = this.options.host.clock.now();
    const atom: Atom = {
      schema_version: 1,
      id,
      content,
      type: 'observation',
      layer: 'L0',
      provenance: {
        kind: provenanceKind,
        source: { tool: 'lag-daemon' },
        derived_from: [],
      },
      confidence: 0.5,
      created_at: now,
      last_reinforced_at: now,
      expires_at: null,
      supersedes: [],
      superseded_by: [],
      scope: 'session',
      signals: {
        agrees_with: [],
        conflicts_with: [],
        validation_status: 'unchecked',
        last_validated_at: null,
      },
      principal_id: principalId,
      taint: 'clean',
      metadata: { daemon: true, role: provenanceKind === 'user-directive' ? 'user' : 'assistant' },
    };
    try {
      await this.options.host.atoms.put(atom);
    } catch (err) {
      if (err instanceof ConflictError) return; // concurrent write; fine
      this.onError(err, `writeConversationAtom(${String(id)})`);
    }
  }

  // ---- Telegram wire helpers ----------------------------------------------

  private async sendMessage(
    chatId: number,
    text: string,
    parseMode?: 'HTML' | 'MarkdownV2' | 'Markdown',
  ): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    };
    if (parseMode !== undefined) body.parse_mode = parseMode;
    await this.callTelegram('sendMessage', body);
  }

  private async callTelegram<T>(
    method: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const url = `https://api.telegram.org/bot${this.options.botToken}/${method}`;
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

// ---- Pure helpers ---------------------------------------------------------

export function splitForTelegram(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    // Prefer breaking at a newline or space near the limit.
    let cut = maxChars;
    const softBreak = remaining.lastIndexOf('\n', maxChars);
    if (softBreak > maxChars * 0.6) cut = softBreak;
    else {
      const spaceBreak = remaining.lastIndexOf(' ', maxChars);
      if (spaceBreak > maxChars * 0.6) cut = spaceBreak;
    }
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

// Re-exports for callers that compose the daemon.
export { invokeClaude } from './invoke-claude.js';
export type { InvokeClaudeOptions, InvokeClaudeResult } from './invoke-claude.js';
export { assembleContext } from './context.js';
export type { AssembleContextOptions, AssembledContext } from './context.js';
// Re-export TelegramNotifierOptions for parity; daemons often compose both.
export type { TelegramNotifierOptions };
