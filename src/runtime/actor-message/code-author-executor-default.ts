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

export {
  buildDiffBasedCodeAuthorExecutor as buildDefaultCodeAuthorExecutor,
  buildSelfCorrectingPrompt,
  type DiffBasedExecutorConfig as DefaultExecutorConfig,
} from './diff-based-code-author-executor.js';
