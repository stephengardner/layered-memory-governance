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
import type { Host } from '../../substrate/interface.js';
import type {
  Atom,
  AtomId,
  Disposition,
  PrincipalId,
  Time,
} from '../../substrate/types.js';
import { ConflictError } from '../../substrate/errors.js';
import {
  parseCallbackData,
  type TelegramNotifierOptions,
} from '../../adapters/notifier/telegram/notifier.js';
import { assembleContext, type AssembleContextOptions } from './context.js';
import { markdownToTelegramHtml, splitMarkdownForTelegram } from '../../adapters/notifier/telegram/format.js';
import { invokeClaude, type InvokeClaudeOptions } from '../../adapters/llm/claude-cli/invoke.js';
import { CliRenderer } from './cli-renderer/index.js';
import type { CliRendererChannel, InlineAction } from './cli-renderer/index.js';
import { createTelegramChannel } from '../../adapters/notifier/telegram/channel.js';
import {
  invokeClaudeStreaming,
  type InvokeClaudeStreamingOptions,
} from './cli-renderer/claude.js';
import {
  downloadTelegramFile,
  type TelegramVoice,
  type VoiceTranscriber,
} from '../../adapters/transcriber/whisper/whisper.js';
import { bindAnswer } from '../questions/index.js';

/**
 * Transport adapter for the CLI-style streaming response path. The
 * three methods together hide transport-specific details from
 * Daemon (channel construction, the Stop button action payload,
 * and the callback-data protocol used to route a Stop press back to
 * the active run). Default implementation wires Telegram; any other
 * transport supplies its own.
 */
export interface CliRendererTransport {
  /** Build a CliRendererChannel bound to the target run. */
  readonly channel: (args: {
    readonly chatId: number;
    readonly replyToMessageId: number;
  }) => CliRendererChannel;
  /** InlineAction to attach to the throbber so the operator can Stop. */
  readonly stopAction: (runToken: string) => InlineAction;
  /**
   * Extract a runToken from a raw callback_data string, or null if
   * this data does not belong to this transport's Stop protocol.
   * Used by the daemon's callback handler to decide whether to
   * abort an active run.
   */
  readonly matchStopCallback: (callbackData: string) => string | null;
}

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
   * Optional voice message transcriber (Phase 48). When set, incoming
   * Telegram messages with a `voice` field are downloaded, transcribed
   * to text, and routed through the same handler as text messages.
   * When undefined, voice messages are ignored.
   */
  readonly voiceTranscriber?: VoiceTranscriber;
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
  /**
   * Label shown on the CLI-style throbber header (e.g. "Claude is
   * working"). Instance/vendor-specific by design. Framework code
   * stays mechanism-focused, so the label comes from the caller.
   * Default: 'Working' (vendor-neutral).
   */
  readonly cliStyleLabel?: string;
  /**
   * Transport adapter for the CLI-style response path. Injects three
   * things the renderer needs but that are transport-specific:
   *   - channel: build a CliRendererChannel for the run's target
   *   - stopAction: build the InlineAction attached to the throbber
   *   - matchStopCallback: given raw callback data, return the
   *     runToken if it is a stop callback for us, otherwise null
   *
   * Defaults to a Telegram-specific implementation (createTelegramChannel
   * + `lag-stop:<token>` callback protocol). Passing a custom
   * implementation keeps Daemon framework-neutral: the notifier
   * seam already exists in Host.notifier for escalations, and this
   * option plays the same role for the streaming cli-render path.
   */
  readonly cliTransport?: CliRendererTransport;
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
  /**
   * When true, the daemon uses the CLI-style streaming renderer for
   * Telegram replies: a single message is posted as a throbber, then
   * edited with compact tool-call lines as Claude progresses, and
   * finally replaced with the full response. Default: false (preserve
   * existing behaviour). Requires Claude CLI to support
   * `--output-format stream-json --verbose` (which is the default for
   * modern Claude Code builds).
   */
  readonly cliStyle?: boolean;
  /**
   * Streaming-invoke impl. Default: invokeClaudeStreaming. Tests
   * inject a stub that feeds canned events via options.executor.
   */
  readonly streamingInvokeImpl?: typeof invokeClaudeStreaming;
  /** Error sink. Default: console.error. */
  readonly onError?: (err: unknown, context: string) => void;
}

interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: {
    readonly message_id: number;
    readonly date?: number; // Unix seconds
    readonly from?: { readonly id: number; readonly username?: string };
    readonly chat: { readonly id: number };
    readonly text?: string;
    readonly voice?: TelegramVoice;
    readonly reply_to_message?: {
      readonly message_id: number;
      readonly text?: string;
      readonly from?: { readonly id: number; readonly is_bot?: boolean };
    };
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

export class Daemon {
  private readonly options: LAGDaemonOptions;
  private readonly fetch: typeof fetch;
  private readonly invoke: typeof invokeClaude;
  private readonly invokeStreaming: typeof invokeClaudeStreaming;
  private readonly onError: (err: unknown, ctx: string) => void;

  private updateOffset: number = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private polling: boolean = false;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private extractionTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly chatIdString: string;
  /**
   * Active cli-style runs keyed by a short opaque token. The token is
   * embedded in the Stop button's callback_data; when Telegram posts
   * the callback back we look up the AbortController here and abort.
   */
  private readonly activeRuns = new Map<string, AbortController>();
  private runCounter = 0;

  constructor(options: LAGDaemonOptions) {
    this.options = options;
    this.fetch = options.fetchImpl ?? globalThis.fetch;
    this.invoke = options.invokeImpl ?? invokeClaude;
    this.invokeStreaming = options.streamingInvokeImpl ?? invokeClaudeStreaming;
    this.onError = options.onError ?? ((err, ctx) => {
      // eslint-disable-next-line no-console
      console.error(`[Daemon] ${ctx}:`, err);
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
    // Abort any in-flight cli-style reply streams. Without this, a
    // shutdown (SIGTERM, lifecycle stopService, terminal takeover)
    // would leave the underlying invokeClaudeStreaming child running
    // AND continuing to edit Telegram messages after the daemon
    // process no longer considers itself active. Aborting propagates
    // through runSpawnedJsonl's signal handler and kills the child.
    for (const [token, controller] of this.activeRuns) {
      try { controller.abort(); } catch { /* already aborted */ }
      this.activeRuns.delete(token);
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
    const { runExtractionPass } = await import('../claims-extraction/index.js');
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
      let payload: { chatId?: number; text?: string; questionId?: string };
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
        // Capture the first sent chunk's message_id for question linkage.
        let firstMessageId: number | null = null;
        for (const chunk of splitMarkdownForTelegram(payload.text, maxChars)) {
          const html = markdownToTelegramHtml(chunk);
          const sentId = await this.sendMessageAndReturnId(chat, html, 'HTML', payload.questionId);
          if (firstMessageId === null && sentId !== null) firstMessageId = sentId;
        }
        // If the outbox payload had a questionId, update the question
        // atom's metadata with the Telegram message_id so subsequent
        // reply-to inbounds can auto-bind to it.
        if (payload.questionId && firstMessageId !== null) {
          try {
            const qAtom = await this.options.host.atoms.get(payload.questionId as AtomId);
            if (qAtom && qAtom.type === 'question') {
              await this.options.host.atoms.update(qAtom.id, {
                metadata: {
                  ...qAtom.metadata,
                  tg_message_id: firstMessageId,
                  asked_via: 'telegram',
                },
              });
            }
          } catch (err) {
            this.onError(err, `drainOutbox question-linkage(${payload.questionId})`);
          }
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

  private async sendMessageAndReturnId(
    chatId: number,
    text: string,
    parseMode: 'HTML' | 'MarkdownV2' | 'Markdown',
    questionIdForLog?: string,
  ): Promise<number | null> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      parse_mode: parseMode,
    };
    const result = await this.callTelegram<{ message_id?: number; date?: number }>('sendMessage', body);
    const mid = typeof result?.message_id === 'number' ? result.message_id : null;
    if (this.options.queueMode && mid !== null) {
      try {
        await this.appendSentLog({
          messageId: mid,
          chatId,
          sentAt: new Date().toISOString(),
          ...(typeof result.date === 'number'
            ? { tgSentAt: new Date(result.date * 1000).toISOString() }
            : {}),
          textPreview: text.replace(/<[^>]+>/g, '').slice(0, 200),
          ...(questionIdForLog ? { questionId: questionIdForLog } : {}),
        });
      } catch (err) {
        this.onError(err, 'appendSentLog(sendMessageAndReturnId)');
      }
    }
    return mid;
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
    tgMessageId: number;
    tgDate?: string;
    replyToMessageId?: number;
    boundQuestionId?: AtomId;
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
      if (update.message) {
        const m = update.message;
        // Voice message path: transcribe first, then reuse the text flow.
        if (m.voice && this.options.voiceTranscriber) {
          try {
            const text = await this.transcribeVoice(m.voice);
            if (text && text.trim().length > 0) {
              const virtualMessage = {
                ...m,
                text,
                voice: m.voice, // keep reference for metadata
              } as NonNullable<TelegramUpdate['message']>;
              await this.handleMessage(virtualMessage);
              processed += 1;
            }
          } catch (err) {
            this.onError(err, `transcribeVoice(${update.update_id})`);
            try {
              await this.sendMessage(m.chat.id, 'Sorry, I could not transcribe that voice message.');
            } catch (sendErr) {
              this.onError(sendErr, 'sendMessage(voice-apology)');
            }
          }
        } else if (typeof m.text === 'string') {
          try {
            await this.handleMessage(m);
            processed += 1;
          } catch (err) {
            this.onError(err, `handleMessage(${update.update_id})`);
            try {
              await this.sendMessage(m.chat.id, 'Sorry, I hit an error processing that message.');
            } catch (sendErr) {
              this.onError(sendErr, 'sendMessage(apology)');
            }
          }
        }
      }

      if (update.callback_query && typeof update.callback_query.data === 'string') {
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

  /**
   * Download + transcribe a Telegram voice message via the configured
   * transcriber. Returns the text or empty string.
   */
  private async transcribeVoice(voice: TelegramVoice): Promise<string> {
    if (!this.options.voiceTranscriber) return '';
    const { audio, mime } = await downloadTelegramFile(
      this.options.botToken,
      voice.file_id,
      this.fetch,
    );
    return this.options.voiceTranscriber.transcribe(audio, mime);
  }

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
      const tgDateIso = typeof message.date === 'number'
        ? new Date(message.date * 1000).toISOString()
        : null;

      // Phase 50b-live: if the inbound explicitly replies-to a prior
      // outbound that carried a questionId, auto-bind the answer now.
      let autoBoundQuestionId: AtomId | null = null;
      if (message.reply_to_message?.message_id) {
        autoBoundQuestionId = await this.autoBindAnswerIfQuestion(
          message.reply_to_message.message_id,
          text,
          principal,
        );
      }

      await this.enqueueInbound({
        chatId,
        text,
        fromId,
        ...(username !== undefined ? { username } : {}),
        principalId: principal,
        receivedAt: this.options.host.clock.now(),
        tgMessageId: message.message_id,
        ...(tgDateIso !== null ? { tgDate: tgDateIso } : {}),
        ...(message.reply_to_message
          ? { replyToMessageId: message.reply_to_message.message_id }
          : {}),
        ...(autoBoundQuestionId ? { boundQuestionId: autoBoundQuestionId } : {}),
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

    // 3-4. Invoke claude and deliver the response. Two paths:
    //  - cliStyle=true: stream events through CliRenderer for a
    //    CLI-session-like Telegram experience (throbber -> tool
    //    lines -> final).
    //  - cliStyle=false (default): preserve the original batch path.
    let replyText: string;
    if (this.options.cliStyle) {
      replyText = await this.replyCliStyle({
        chatId,
        replyToMessageId: message.message_id,
        text,
        systemPrompt: context.prompt,
      });
    } else {
      replyText = await this.replyBatch({
        chatId,
        text,
        systemPrompt: context.prompt,
      });
    }

    // 5. Record the assistant response as an L0 atom.
    await this.writeConversationAtom(replyText, 'agent-observed', principal);
  }

  /**
   * Batch response path (original behaviour): invoke, wait for full
   * response, split + HTML-render + send. Returns the raw markdown
   * reply for the L0 atom write.
   */
  private async replyBatch(args: {
    readonly chatId: number;
    readonly text: string;
    readonly systemPrompt: string;
  }): Promise<string> {
    let replyText: string;
    try {
      const result = await this.invoke({
        userMessage: args.text,
        systemPrompt: args.systemPrompt,
        ...(this.options.repoRoot !== undefined ? { cwd: this.options.repoRoot } : {}),
        ...(this.options.resumeSessionId !== undefined ? { resumeSessionId: this.options.resumeSessionId } : {}),
        ...(this.options.invokeOptions ?? {}),
      });
      replyText = result.text.trim() || '(empty response from model)';
    } catch (err) {
      this.onError(err, 'invokeClaude');
      replyText = 'I could not generate a response right now. Please try again.';
    }
    const maxChars = this.options.maxReplyChars ?? 4000;
    for (const chunk of splitMarkdownForTelegram(replyText, maxChars)) {
      const html = markdownToTelegramHtml(chunk);
      await this.sendMessage(args.chatId, html, 'HTML');
    }
    return replyText;
  }

  /**
   * CLI-style response path: stream Claude events through a
   * CliRenderer bound to a Telegram channel. One message is posted
   * with a throbber, then edited with compact tool-call lines as
   * Claude works, then edited to the final formatted response.
   *
   * A Stop button is attached to the throbber; pressing it aborts the
   * spawned claude process. Whatever text accumulated before abort
   * becomes the reply, tagged as stopped by the operator.
   */
  private async replyCliStyle(args: {
    readonly chatId: number;
    readonly replyToMessageId: number;
    readonly text: string;
    readonly systemPrompt: string;
  }): Promise<string> {
    const transport = this.resolveCliTransport();
    const channel = transport.channel({
      chatId: args.chatId,
      replyToMessageId: args.replyToMessageId,
    });
    const maxChars = this.options.maxReplyChars ?? 4000;
    const runToken = this.registerRun();
    const renderer = new CliRenderer({
      channel,
      renderFinal: (md) => markdownToTelegramHtml(md),
      splitFinal: (text) => splitMarkdownForTelegram(text, maxChars),
      action: transport.stopAction(runToken),
    });

    await renderer.emit({ type: 'start', label: this.options.cliStyleLabel ?? 'Working' });
    let replyText = '';
    const controller = this.activeRuns.get(runToken)!;
    try {
      // Pick up operator-configured invoke options (model, verbose,
      // timeoutMs, maxBudgetUsd) so CLI-style replies honor the same
      // runtime knobs as batch replies. Without this, toggling
      // cliStyle silently dropped invokeOptions on the floor.
      // InvokeClaudeOptions is a superset that includes fields the
      // streaming path does not consume (e.g. output-format flags);
      // we cherry-pick the fields that apply to both.
      const cfg = this.options.invokeOptions ?? {};
      const streamingOpts: InvokeClaudeStreamingOptions = {
        userMessage: args.text,
        systemPrompt: args.systemPrompt,
        onEvent: (ev) => renderer.emit(ev),
        signal: controller.signal,
        ...(cfg.model !== undefined ? { model: cfg.model } : {}),
        ...(cfg.maxBudgetUsd !== undefined ? { maxBudgetUsd: cfg.maxBudgetUsd } : {}),
        ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
        ...(cfg.verbose !== undefined ? { verbose: cfg.verbose } : {}),
        ...(this.options.repoRoot !== undefined ? { cwd: this.options.repoRoot } : {}),
        ...(this.options.resumeSessionId !== undefined ? { resumeSessionId: this.options.resumeSessionId } : {}),
      };
      const result = await this.invokeStreaming(streamingOpts);
      const partial = result.text.trim();
      if (controller.signal.aborted) {
        // Operator stopped the run; surface what Claude produced up to
        // that point, tagged so the operator knows it was truncated.
        replyText = partial
          ? `${partial}\n\n*(stopped by operator)*`
          : '_Stopped by operator before Claude produced any text._';
      } else {
        replyText = partial || '(empty response from model)';
      }
      await renderer.emit({ type: 'complete', finalText: replyText, meta: result.meta });
    } catch (err) {
      this.onError(err, 'invokeClaudeStreaming');
      replyText = 'I could not generate a response right now. Please try again.';
      await renderer.emit({ type: 'error', message: replyText });
    } finally {
      this.activeRuns.delete(runToken);
      await renderer.dispose();
    }
    return replyText;
  }

  /**
   * Allocate a short opaque token for a new cli-style run and register
   * an AbortController under it. Token fits inside Telegram's 64-byte
   * callback_data cap with room for the `lag-stop:` prefix.
   */
  private registerRun(): string {
    this.runCounter += 1;
    const token = `${Date.now().toString(36)}-${this.runCounter}`;
    this.activeRuns.set(token, new AbortController());
    return token;
  }

  /**
   * Return the injected CLI transport, or a Telegram default. The
   * default is lazily constructed so consumers that pass their own
   * transport (or that never take the cli-style path) pay no cost.
   * The Telegram default preserves the pre-injection behavior
   * verbatim: createTelegramChannel + `lag-stop:<token>` protocol.
   */
  private resolveCliTransport(): CliRendererTransport {
    if (this.options.cliTransport) return this.options.cliTransport;
    const botToken = this.options.botToken;
    const fetchImpl = this.fetch;
    return {
      channel: ({ chatId, replyToMessageId }) =>
        createTelegramChannel({ botToken, chatId, replyToMessageId, fetchImpl }),
      stopAction: (runToken) => ({ label: '⏹ Stop', callbackData: `lag-stop:${runToken}` }),
      matchStopCallback: (data) =>
        data.startsWith('lag-stop:') ? data.slice('lag-stop:'.length) : null,
    };
  }

  private async handleCallback(
    cq: NonNullable<TelegramUpdate['callback_query']>,
  ): Promise<void> {
    if (typeof cq.data !== 'string') return;

    // Stop button: abort the matching active run. Handled in-daemon;
    // does not go through the escalation onCallback path.
    //
    // Chat-binding: we honor lag-stop ONLY when the callback
    // originates from the configured chat. Without this, a callback
    // query from any other chat that happens to have a live token
    // could cancel a run the operator did not authorize. The token
    // itself is short + opaque so collision is unlikely, but we
    // refuse to rely on that as an authority check.
    const stopToken = this.resolveCliTransport().matchStopCallback(cq.data);
    if (stopToken !== null) {
      const cqChat = cq.message?.chat.id;
      if (cqChat === undefined || String(cqChat) !== this.chatIdString) {
        try {
          await this.callTelegram('answerCallbackQuery', {
            callback_query_id: cq.id,
            text: 'Unauthorized',
          });
        } catch (err) {
          this.onError(err, 'answerCallbackQuery(stop-unauthorized)');
        }
        return;
      }
      const controller = this.activeRuns.get(stopToken);
      const found = controller !== undefined;
      if (found) controller.abort();
      try {
        await this.callTelegram('answerCallbackQuery', {
          callback_query_id: cq.id,
          text: found ? 'Stopping…' : 'Run already finished',
        });
      } catch (err) {
        this.onError(err, 'answerCallbackQuery(stop)');
      }
      return;
    }

    if (!this.options.onCallback) return;
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
    const result = await this.callTelegram<{ message_id?: number; date?: number }>('sendMessage', body);
    // Causality tracking (Phase 50a): log outbound message_id + sent time
    // so the Stop hook can match inbound replies to the right question.
    if (this.options.queueMode && result && typeof result.message_id === 'number') {
      try {
        await this.appendSentLog({
          messageId: result.message_id,
          chatId,
          sentAt: new Date().toISOString(),
          ...(typeof result.date === 'number'
            ? { tgSentAt: new Date(result.date * 1000).toISOString() }
            : {}),
          textPreview: text.replace(/<[^>]+>/g, '').slice(0, 200),
        });
      } catch (err) {
        this.onError(err, 'appendSentLog');
      }
    }
  }

  private async appendSentLog(entry: {
    messageId: number;
    chatId: number;
    sentAt: string;
    tgSentAt?: string;
    textPreview: string;
    questionId?: string;
  }): Promise<void> {
    const queueDir = this.resolveQueueDir();
    const logPath = join(queueDir, 'sent-log.jsonl');
    const { appendFile, mkdir: mkdirP } = await import('node:fs/promises');
    await mkdirP(queueDir, { recursive: true });
    await appendFile(logPath, JSON.stringify(entry) + '\n', 'utf8');
  }

  /**
   * Phase 50b-live auto-bind. Given an incoming Telegram reply-to
   * message_id, look up the sent-log for the targeted outbound's
   * recorded questionId, then call bindAnswer() on that question.
   * Returns the question id if binding happened, null otherwise.
   */
  private async autoBindAnswerIfQuestion(
    replyToMessageId: number,
    answerContent: string,
    answerer: PrincipalId,
  ): Promise<AtomId | null> {
    const queueDir = this.resolveQueueDir();
    const logPath = join(queueDir, 'sent-log.jsonl');
    let raw: string;
    try {
      raw = await readFile(logPath, 'utf8');
    } catch {
      return null;
    }
    const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
    // Walk newest-first for the matching entry.
    let matchedQuestionId: string | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry: { messageId?: number; questionId?: string };
      try {
        entry = JSON.parse(lines[i]!) as typeof entry;
      } catch {
        continue;
      }
      if (entry.messageId === replyToMessageId && typeof entry.questionId === 'string') {
        matchedQuestionId = entry.questionId;
        break;
      }
    }
    if (!matchedQuestionId) return null;

    try {
      const result = await bindAnswer(this.options.host, {
        questionId: matchedQuestionId as AtomId,
        answerContent,
        answerer,
      });
      return result.questionId;
    } catch (err) {
      this.onError(err, `autoBindAnswer(${matchedQuestionId})`);
      return null;
    }
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
export { invokeClaude } from '../../adapters/llm/claude-cli/invoke.js';
export type { InvokeClaudeOptions, InvokeClaudeResult } from '../../adapters/llm/claude-cli/invoke.js';
export { assembleContext } from './context.js';
export type { AssembleContextOptions, AssembledContext } from './context.js';
export {
  StubTranscriber,
  WhisperLocalTranscriber,
  downloadTelegramFile,
} from '../../adapters/transcriber/whisper/whisper.js';
export type { VoiceTranscriber, TelegramVoice, WhisperLocalOptions } from '../../adapters/transcriber/whisper/whisper.js';
// Re-export TelegramNotifierOptions for parity; daemons often compose both.
export type { TelegramNotifierOptions };
