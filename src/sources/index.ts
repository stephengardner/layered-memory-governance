/**
 * SessionSource adapters.
 *
 * A SessionSource produces the initial corpus of atoms for a fresh
 * `.lag/` state. Multiple sources compose; dedup is content-hash.
 *
 * Shipping today:
 *   - FreshSource                      (no-op, useful for tests)
 *   - ClaudeCodeTranscriptSource       (Phase 40: read a repo's own
 *                                       transcripts at .claude/projects/*)
 *
 * Roadmap: ChromaDBSource (via existing bridge adapter), ObsidianVaultSource,
 * SlackExportSource, GitHistorySource, NotionExportSource, generic JSONLSource.
 * New sources land as new files implementing SessionSource with no changes
 * to the core.
 */

export type {
  IngestOptions,
  IngestReport,
  SessionSource,
} from './types.js';
export { FreshSource } from './fresh.js';
export {
  ClaudeCodeTranscriptSource,
  parseLine,
  type ClaudeCodeTranscriptSourceOptions,
} from './claude-code.js';
export {
  ObsidianVaultSource,
  parseNote,
  listMarkdownRecursive,
  type ObsidianVaultSourceOptions,
} from './obsidian.js';
export {
  GitLogSource,
  parseGitLog,
  type GitLogSourceOptions,
} from './git-log.js';
