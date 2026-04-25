/**
 * Back-compat alias resolves at module-load time.
 *
 * Pins the deprecation contract: code that imports the old
 * `code-author-executor-default` module path must continue to receive
 * working symbols (delegating to the renamed
 * `diff-based-code-author-executor` module). The shim is preserved
 * for one minor release and will be removed in the release after.
 */

import { describe, it, expect } from 'vitest';
import * as oldPath from '../../../src/runtime/actor-message/code-author-executor-default.js';
import * as newPath from '../../../src/runtime/actor-message/diff-based-code-author-executor.js';

describe('code-author-executor-default back-compat shim', () => {
  it('exposes buildDefaultCodeAuthorExecutor', () => {
    expect(typeof oldPath.buildDefaultCodeAuthorExecutor).toBe('function');
  });

  it('aliases to the same factory implementation as buildDiffBasedCodeAuthorExecutor', () => {
    // The shim re-exports the renamed symbol under the old name; both
    // module paths must reference the same function so consumers see no
    // behavioural divergence.
    expect(oldPath.buildDefaultCodeAuthorExecutor).toBe(newPath.buildDiffBasedCodeAuthorExecutor);
  });
});
