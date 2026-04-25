/**
 * Deprecated back-compat shim for the diff-based executor.
 *
 * @deprecated Import from `layered-autonomous-governance/actor-message`
 *   instead, where `buildDiffBasedCodeAuthorExecutor` and
 *   `DiffBasedExecutorConfig` are the new public names. The deprecated
 *   `buildDefaultCodeAuthorExecutor` / `DefaultExecutorConfig` aliases
 *   are preserved for one minor release and removed in the release
 *   after; this file is the migration shim. Editors that surface this
 *   note will recommend the public package path consumers can resolve.
 */

// Re-export ONLY the deprecated aliases. New utilities exported from
// `diff-based-code-author-executor.js` (e.g. `buildSelfCorrectingPrompt`)
// are not surfaced here: the shim is migration-only, and exposing
// new symbols through it would let consumers reach for them via the
// deprecated path and resist migration.
export {
  buildDiffBasedCodeAuthorExecutor as buildDefaultCodeAuthorExecutor,
  type DiffBasedExecutorConfig as DefaultExecutorConfig,
} from './diff-based-code-author-executor.js';
