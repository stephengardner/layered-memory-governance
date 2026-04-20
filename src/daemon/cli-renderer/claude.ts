/**
 * Claude-specific barrel for the CLI renderer.
 *
 * Kept separate from `./index.js` so the generic CliRenderer primitive
 * stays runtime-neutral: consumers who only want the renderer + base
 * types do not pull node:child_process / node:stream into their
 * dependency graph via re-exports. Callers who need the Claude CLI
 * stream-json parser or the streaming invoker import from here:
 *
 *   import { invokeClaudeStreaming } from '.../cli-renderer/claude.js';
 *
 * This preserves substrate discipline (framework code stays mechanism-
 * focused and pluggable) while keeping Claude-specific bits
 * discoverable on a predictable subpath.
 */

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

// JsonlMirror reads Claude Code session jsonl files (Claude-specific
// input format), so it belongs on the Claude barrel rather than the
// runtime-neutral renderer index.
export { startJsonlMirror } from './jsonl-mirror.js';
export type {
  JsonlMirrorController,
  JsonlMirrorOptions,
} from './jsonl-mirror.js';
