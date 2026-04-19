/**
 * Event types the CliRenderer consumes.
 *
 * Keeping this vendor-neutral: renderer knows nothing about Claude
 * CLI, stream-json, or any specific streaming protocol. A streaming
 * parser (Phase 56b) translates Claude CLI's stream-json into these
 * events; a deploy-actor later could translate its own event stream
 * into the same shape. The renderer is a reusable primitive.
 */

export type CliRendererEvent =
  | {
      readonly type: 'start';
      /** Short prefix shown above the throbber (e.g. 'Claude is working'). */
      readonly label?: string;
      /** Human-readable hint shown on the start message. */
      readonly hint?: string;
    }
  | {
      readonly type: 'tool-call';
      readonly tool: string;
      /** Compact description; ~60 char cap. Renderer truncates if longer. */
      readonly summary: string;
    }
  | {
      readonly type: 'tool-result';
      readonly tool: string;
      readonly ok: boolean;
      readonly summary?: string;
    }
  | {
      readonly type: 'thinking';
      /** Thinking text; rendered inside a <tg-spoiler> on final messages. */
      readonly text: string;
    }
  | {
      readonly type: 'text-delta';
      /** Partial assistant text; accumulated internally until complete. */
      readonly text: string;
    }
  | {
      readonly type: 'complete';
      /** Final assistant text (markdown). */
      readonly finalText: string;
      /** Optional metadata to surface in a compact footer. */
      readonly meta?: Readonly<Record<string, string | number>>;
    }
  | {
      readonly type: 'error';
      readonly message: string;
    };

/** Result of posting a message to the underlying channel. */
export interface PostedMessage {
  readonly messageId: string;
}

/**
 * An inline action button shown under a posted message. On Telegram
 * this becomes one cell of an inline_keyboard; on a hypothetical Slack
 * channel, a button block. Channel implementations serialize as needed.
 */
export interface InlineAction {
  /** Human-readable label shown on the button. */
  readonly label: string;
  /**
   * Opaque token the channel includes in the callback event when the
   * button is pressed. Callers use this to route the press back to the
   * right run. Keep under 64 bytes; Telegram's limit is 64.
   */
  readonly callbackData: string;
}

/** Options accepted when posting / editing a message. */
export interface MessageOptions {
  readonly text: string;
  /** Parse mode, if the channel supports it (e.g. 'HTML' on Telegram). */
  readonly parseMode?: string;
  /** Suppress user-facing notification; used for intermediate updates. */
  readonly disableNotification?: boolean;
  /**
   * Optional inline action buttons. Single row per call; pass an empty
   * array on a final edit to remove buttons from a previously-posted
   * message.
   */
  readonly actions?: ReadonlyArray<InlineAction>;
}

/**
 * Abstract surface the renderer drives. A Telegram implementation
 * wires post/edit to the Bot API; a console implementation can log;
 * a stub implementation records calls for tests.
 */
export interface CliRendererChannel {
  post(options: MessageOptions): Promise<PostedMessage>;
  edit(messageId: string, options: MessageOptions): Promise<void>;
}

export interface CliRendererOptions {
  readonly channel: CliRendererChannel;
  /** Current-time source (ms). Defaults to Date.now; injectable for tests. */
  readonly now?: () => number;
  /** Minimum ms between successive edit calls. Default 1500. */
  readonly editRateLimitMs?: number;
  /** Heartbeat tick interval (ms) for elapsed-time updates. Default 3000. */
  readonly heartbeatIntervalMs?: number;
  /** Spinner frames cycled on heartbeat. Default ['🟡','🟠','🔴','🟣','🔵','🟢']. */
  readonly spinnerFrames?: ReadonlyArray<string>;
  /** Max activity lines kept visible during run (older lines fall off). Default 8. */
  readonly activityWindow?: number;
  /** Markdown-to-channel-format translator used on completion. Identity by default. */
  readonly renderFinal?: (markdown: string) => string;
  /**
   * Called after `complete` when the final text exceeds channel's max
   * and needs to be split into multiple messages. First chunk replaces
   * the throbber; subsequent chunks are posted fresh. Default splits at
   * 4000 chars on paragraph boundaries.
   */
  readonly splitFinal?: (text: string) => ReadonlyArray<string>;
  /**
   * Optional action button attached to the throbber message. When
   * supplied, the channel displays it beneath the progress text; the
   * caller is responsible for receiving the callback and acting on it
   * (typically by aborting the underlying run). Removed automatically
   * when the run reaches a terminal state (complete or error).
   */
  readonly action?: InlineAction;
  /**
   * Max characters of live assistant text shown inside the throbber
   * view. Default 220. Set to 0 to suppress the live preview entirely.
   */
  readonly livePreviewMaxChars?: number;
  /**
   * Number of trailing lines from the live assistant text to display in
   * the throbber view. Default 4. The last `livePreviewMaxChars`
   * characters are used as a secondary cap.
   */
  readonly livePreviewLines?: number;
}
