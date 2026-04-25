/**
 * Deprecated back-compat shim for the diff-based executor.
 *
 * @deprecated Import from `./diff-based-code-author-executor.js` instead.
 *   `buildDefaultCodeAuthorExecutor` -> `buildDiffBasedCodeAuthorExecutor`,
 *   `DefaultExecutorConfig` -> `DiffBasedExecutorConfig`.
 *   This shim is preserved for one minor release and will be removed in
 *   the release after.
 */

export {
  buildDiffBasedCodeAuthorExecutor as buildDefaultCodeAuthorExecutor,
  buildSelfCorrectingPrompt,
  type DiffBasedExecutorConfig as DefaultExecutorConfig,
} from './diff-based-code-author-executor.js';
