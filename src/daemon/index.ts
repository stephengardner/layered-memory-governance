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

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
   * Session id to resume. When set, every daemon invocation runs
   * `claude -p --resume <id>`, loading the full prior conversation
   * context from the session's jsonl. Replies append to that session
   * so a terminal Claude Code instance reading the same jsonl sees
   * them on its next turn. Opt-in for solo-dev continuity.
   */
  readonly resumeSessionId?: string;
  /**
   * Queue-only mode (Phase 42, terminal-attached).
   *
   * When true, the daemon does NOT spawn claude-cli. Incoming
   * Telegram messages are written to `<queueDir>/inbox/<ts>.json`,
   * where a Stop hook on an attached Claude Code terminal session
   * picks them up, injects them via systemMessage, and the running
   * instance responds. That instance writes the reply to
   * `<queueDir>/outbox/<ts>.json`, which the daemon drains on its
   * next tick by sending to Telegram.
   *
   * Use this when you want the terminal session to be the brain and
   * Telegram to be its remote mouth. Fall back to plain daemon mode
   * (this flag unset) when the terminal is closed.
   */
  readonly queueMode?: boolean;
  /** Directory for the TG queue. Default: <host rootDir>/tg-queue. */
  readonly queueDir?: string;
  /**
   * Ambient governance (Phase 47): interval (ms) at which the daemon
   * runs a LoopRunner tick (decay, TTL, L2/L3 promotion, canon
   * re-render). Undefined or 0 = disabled. Typical value 300_000 (5 min).
   */
  readonly runLoopIntervalMs?: number;
  /**
   * Ambient extraction (Phase 47): interval (ms) at which the daemon
   * runs a claim-extraction pass over unprocessed L0 atoms (calls the
   * LLM judge for each new L0 atom). Undefined or 0 = disabled.
   * Typical value 600_000 (10 min).
   */
  readonly runExtractionIntervalMs?: number;
  /**
   * Ambient loop principal (used for LoopRunner tick + extraction pass
   * attribution). Defaults to the daemon's principalResolver(0) result.
   */
  readonly ambientPrincipalId?: PrincipalId;
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
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private extractionTimer: ReturnType<typeof setTimeout> | null = null;
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

    // Ambient loop: promotions, decay, TTL, canon re-render.
    if (this.options.runLoopIntervalMs && this.options.runLoopIntervalMs > 0) {
      const runLoop = async (): Promise<void> => {
        if (!this.polling) return;
        try {
          await this.ambientLoopTick();
        } catch (err) {
          this.onError(err, 'ambientLoopTick');
        }
        if (!this.polling) return;
        this.loopTimer = setTimeout(() => { void runLoop(); }, this.options.runLoopIntervalMs);
      };
      // Stagger initial fire by a few seconds so boot is quiet.
      this.loopTimer = setTimeout(() => { void runLoop(); }, 5_000);
    }

    // Ambient extraction: L0 to L1 pass.
    if (this.options.runExtractionIntervalMs && this.options.runExtractionIntervalMs > 0) {
      const runExtr = async (): Promise<void> => {
        if (!this.polling) return;
        try {
          await this.ambientExtractionTick();
        } catch (err) {
          this.onError(err, 'ambientExtractionTick');
        }
        if (!this.polling) return;
        this.extractionTimer = setTimeout(() => { void runExtr(); }, this.options.runExtractionIntervalMs);
      };
      this.extractionTimer = setTimeout(() => { void runExtr(); }, 10_000);
    }
  }

  stop(): void {
    this.polling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    if (this.extractionTimer) {
      clearTimeout(this.extractionTimer);
      this.extractionTimer = null;
    }
  }

  /**
   * Run one LoopRunner tick (decay, TTL, L2/L3 promotion, canon). Public
   * for tests to drive deterministically.
   */
  async ambientLoopTick(): Promise<void> {
    const { LoopRunner } = await import('../loop/index.js');
    const principalId = this.resolveAmbientPrincipal();
    const runner = new LoopRunner(this.options.host, {
      principalId,
      ...(this.options.canonFilePath
        ? { canonTargetPath: this.options.canonFilePath }
        : {}),
    });
    await runner.tick();
  }

  /**
   * Run one claim-extraction pass over unprocessed L0 atoms. Public for
   * tests.
   */
  async ambientExtractionTick(): Promise<void> {
    const { runExtractionPass } = await import('../extraction/index.js');
    const principalId = this.resolveAmbientPrincipal();
    await runExtractionPass(this.options.host, {
      principalId,
      maxAtoms: 20, // cap LLM calls per tick
    });
  }

  private resolveAmbientPrincipal(): PrincipalId {
    if (this.options.ambientPrincipalId) return this.options.ambientPrincipalId;
    try {
      return this.options.principalResolver(0);
    } catch {
      return 'lag-self' as PrincipalId;
    }
  }

  /**
   * Drain the outbox queue: read any reply files written by the Stop
   * hook and push them to Telegram. Files are deleted on success so a
   * second drain does not re-send. Called from tick() automatically.
   */
  private async drainOutbox(): Promise<number> {
    if (!this.options.queueMode) return 0;
    const outboxDir = join(this.resolveQueueDir(), 'outbox');
    let entries: string[];
    try {
      entries = await readdir(outboxDir);
    } catch {
      return 0; // dir may not exist yet; nothing to drain
    }
    let sent = 0;
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const full = join(outboxDir, name);
      let payload: { chatId?: number; text?: string };
      try {
        payload = JSON.parse(await readFile(full, 'utf8')) as typeof payload;
      } catch (err) {
        this.onError(err, `drainOutbox(${name})`);
        continue;
      }
      if (typeof payload.text !== 'string' || payload.text.length === 0) {
        await rm(full, { force: true });
        continue;
      }
      const chat = Number.isFinite(payload.chatId)
        ? payload.chatId!
        : Number(this.chatIdString);
      const maxChars = this.options.maxReplyChars ?? 4000;
      try {
        for (const chunk of splitMarkdownForTelegram(payload.text, maxChars)) {
          const html = markdownToTelegramHtml(chunk);
          await this.sendMessage(chat, html, 'HTML');
        }
        await rm(full, { force: true });
        sent += 1;
      } catch (err) {
        this.onError(err, `drainOutbox(send ${name})`);
        // Leave file in place for retry on next tick.
      }
    }
    return sent;
  }

  private resolveQueueDir(): string {
    return this.options.queueDir
      ?? join((this.options.host as unknown as { rootDir?: string }).rootDir ?? '.', 'tg-queue');
  }

  private async enqueueInbound(payload: {
    chatId: number;
    text: string;
    fromId: number;
    username?: string;
    principalId: PrincipalId;
    receivedAt: string;
  }): Promise<void> {
    const inboxDir = join(this.resolveQueueDir(), 'inbox');
    await mkdir(inboxDir, { recursive: true });
    // Timestamp + random so concurrent messages in the same ms collide rarely.
    const ts = payload.receivedAt.replace(/[:.]/g, '-');
    const rand = Math.random().toString(36).slice(2, 8);
    const tmp = join(inboxDir, `.pending-${ts}-${rand}.json.tmp`);
    const finalPath = join(inboxDir, `${ts}-${rand}.json`);
    await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    await rename(tmp, finalPath); // atomic on same filesystem
  }

  /** One poll cycle; public for tests to drive deterministically. */
  async tick(): Promise<number> {
    // Drain any replies the Stop hook queued since last tick.
    try {
      await this.drainOutbox();
    } catch (err) {
      this.onError(err, 'drainOutbox');
    }

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

    // Queue mode: write to inbox and stop. The attached terminal
    // session's Stop hook picks it up and the running Claude Code
    // instance responds; the reply flows back through the outbox on
    // a later tick.
    if (this.options.queueMode) {
      await this.enqueueInbound({
        chatId,
        text,
        fromId,
        ...(username !== undefined ? { username } : {}),
        principalId: principal,
        receivedAt: this.options.host.clock.now(),
      });
      // Still record the user message as an L0 atom so the substrate
      // accumulates history even in queue mode.
      await this.writeConversationAtom(text, 'user-directive', principal);
      return;
    }

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
        ...(this.options.resumeSessionId !== undefined ? { resumeSessionId: this.options.resumeSessionId } : {}),
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
