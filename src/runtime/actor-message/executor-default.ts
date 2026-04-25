/**
 * Deprecated subpath shim for the diff-based CodeAuthorExecutor.
 *
 * @deprecated Import from `layered-autonomous-governance/actor-message`
 *   for the new public names (`buildDiffBasedCodeAuthorExecutor`,
 *   `DiffBasedExecutorConfig`). This subpath only re-exports the
 *   legacy aliases (`buildDefaultCodeAuthorExecutor`,
 *   `DefaultExecutorConfig`) so existing consumers keep compiling
 *   while migrating; new code should not use this path. The deprecated
 *   surface is preserved for one minor release and removed in the
 *   release after.
 *
 * The subpath is deliberately NOT a superset of the new public path:
 * exposing the new symbols here would let consumers adopt them
 * through the deprecated entrypoint, blunting the deprecation. New
 * names live only at `actor-message`; this file is migration-only.
 */
export {
  buildDiffBasedCodeAuthorExecutor as buildDefaultCodeAuthorExecutor,
} from './diff-based-code-author-executor.js';
export type {
  DiffBasedExecutorConfig as DefaultExecutorConfig,
} from './diff-based-code-author-executor.js';
