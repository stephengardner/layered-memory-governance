/**
 * CLI-style renderer primitive (Phase 56a).
 *
 * Turns a stream of CliRendererEvents into a coherent, rate-limited,
 * CLI-session-like message flow on any post/edit-capable channel.
 *
 * This barrel is intentionally runtime-neutral: it exports only the
 * renderer and its base types. Claude-specific stream parsing and
 * invocation live on `./claude.js` so consumers of the generic
 * renderer do not pull node:child_process / node:stream into their
 * dependency graph just to construct a CliRenderer.
 *
 * Import telegram channel directly from `./telegram-channel.js` if
 * you want that specific transport; keeping vendor channels out of
 * this barrel preserves substrate discipline.
 */

export { CliRenderer } from './renderer.js';
export type {
  CliRendererChannel,
  CliRendererEvent,
  CliRendererOptions,
  MessageOptions,
  PostedMessage,
} from './types.js';
