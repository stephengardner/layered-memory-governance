/**
 * Claude CLI adapter entry point.
 *
 * Currently exposes only the LLM adapter. Later phases may add a full Host
 * composition factory that pairs this LLM with real external atom storage,
 * git-backed canon, etc. For now: `createMemoryHost()` for everything else
 * plus this LLM for the `llm` slot.
 */

export { ClaudeCliLLM, type ClaudeCliOptions } from './llm.js';
