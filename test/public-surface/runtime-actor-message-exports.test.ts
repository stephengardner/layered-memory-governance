/**
 * Public-surface test for the runtime/actor-message barrel.
 *
 * Pins which CodeAuthorExecutor factories the barrel exposes:
 *   - buildAgenticCodeAuthorExecutor (PR2 of agentic-actor-loop)
 *   - buildDiffBasedCodeAuthorExecutor (renamed from buildDefault)
 *   - buildDefaultCodeAuthorExecutor (deprecated alias; one-release
 *     deprecation window)
 *
 * The deprecated alias must reference the same function as the
 * renamed symbol so consumers see no behavioural divergence.
 */

import { describe, it, expect } from 'vitest';
import * as actorMessage from '../../src/runtime/actor-message/index.js';

describe('public surface: runtime/actor-message barrel', () => {
  it('exposes buildAgenticCodeAuthorExecutor', () => {
    expect(typeof actorMessage.buildAgenticCodeAuthorExecutor).toBe('function');
  });

  it('exposes buildDiffBasedCodeAuthorExecutor', () => {
    expect(typeof actorMessage.buildDiffBasedCodeAuthorExecutor).toBe('function');
  });

  it('exposes buildDefaultCodeAuthorExecutor as a deprecated alias', () => {
    expect(typeof actorMessage.buildDefaultCodeAuthorExecutor).toBe('function');
    // Both symbols MUST reference the same factory implementation so
    // the deprecation window does not introduce a behavioural fork.
    expect(actorMessage.buildDefaultCodeAuthorExecutor).toBe(actorMessage.buildDiffBasedCodeAuthorExecutor);
  });
});
