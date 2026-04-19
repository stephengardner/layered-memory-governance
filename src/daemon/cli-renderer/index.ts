/**
 * CLI-style Telegram renderer (Phase 56a).
 *
 * Turns a stream of CliRendererEvents into a coherent, rate-limited,
 * CLI-style message flow on any post/edit-capable channel. The event
 * shape is vendor-neutral so a future DeployActor, PrLandingActor, or
 * anything-Actor can reuse the same renderer.
 *
 * Consumers:
 *   - Phase 56b will add a Claude CLI stream-json parser that emits
 *     these events.
 *   - The daemon will wire stream-parser -> renderer -> TelegramChannel
 *     so Telegram messages become CLI-session-like (throbber, compact
 *     tool lines, rate-limited updates, final formatted output).
 */

export { CliRenderer } from './renderer.js';
export { createTelegramChannel } from './telegram-channel.js';
export {
  emptyAccumulator,
  parseClaudeStreamLine,
  summarizeToolUse,
} from './claude-stream-parser.js';
export type { ParseAccumulator } from './claude-stream-parser.js';
export {
  defaultClaudeStreamingExecutor,
  invokeClaudeStreaming,
  makeStubStreamingExecutor,
  runSpawnedJsonl,
} from './claude-streaming.js';
export type {
  InvokeClaudeStreamingOptions,
  InvokeClaudeStreamingResult,
  StreamingExecResult,
  StreamingExecutor,
} from './claude-streaming.js';
export type {
  CliRendererChannel,
  CliRendererEvent,
  CliRendererOptions,
  MessageOptions,
  PostedMessage,
} from './types.js';
export type { TelegramChannelOptions } from './telegram-channel.js';
