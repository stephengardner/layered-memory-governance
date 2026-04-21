/**
 * Subpath export for the default CodeAuthorExecutor.
 *
 *   import { buildDefaultCodeAuthorExecutor }
 *     from 'layered-autonomous-governance/actor-message/executor-default';
 *
 * Keeps the GitHub/git-backed concrete chain OUT of the primitive
 * `actor-message` barrel. Consumers who want the default wiring opt
 * in at this subpath; consumers who want a different backend
 * implement `CodeAuthorExecutor` against the seam exported from
 * `actor-message` without pulling this concrete implementation.
 */
export {
  buildDefaultCodeAuthorExecutor,
} from './code-author-executor-default.js';
export type {
  DefaultExecutorConfig,
} from './code-author-executor-default.js';
