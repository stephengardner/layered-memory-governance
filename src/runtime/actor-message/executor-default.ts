/**
 * Subpath export for the diff-based CodeAuthorExecutor.
 *
 *   import { buildDefaultCodeAuthorExecutor }
 *     from 'layered-autonomous-governance/actor-message/executor-default';
 *
 * Keeps the GitHub/git-backed concrete chain OUT of the primitive
 * `actor-message` barrel. Consumers who want the diff-based wiring
 * opt in at this subpath; consumers who want a different backend
 * implement `CodeAuthorExecutor` against the seam exported from
 * `actor-message` without pulling this concrete implementation.
 *
 * Re-exports both the new `buildDiffBasedCodeAuthorExecutor` symbol
 * and the deprecated `buildDefaultCodeAuthorExecutor` alias so
 * downstream consumers that imported via the old name continue to
 * compile while migrating.
 */
export {
  buildDiffBasedCodeAuthorExecutor,
  buildDiffBasedCodeAuthorExecutor as buildDefaultCodeAuthorExecutor,
} from './diff-based-code-author-executor.js';
export type {
  DiffBasedExecutorConfig,
  DiffBasedExecutorConfig as DefaultExecutorConfig,
} from './diff-based-code-author-executor.js';
