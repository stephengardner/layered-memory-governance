import { describe, it, expect } from 'vitest';
import {
  defaultClassifyFailure,
} from '../../src/substrate/agent-loop.js';
import type {
  AgentLoopAdapter,
} from '../../src/substrate/agent-loop.js';

describe('defaultClassifyFailure', () => {
  it('classifies HTTP 429 as transient', () => {
    const err = Object.assign(new Error('Too Many Requests'), { statusCode: 429 });
    expect(defaultClassifyFailure(err)).toBe('transient');
  });

  it('classifies HTTP 503 as transient', () => {
    const err = Object.assign(new Error('Service Unavailable'), { statusCode: 503 });
    expect(defaultClassifyFailure(err)).toBe('transient');
  });

  it('classifies HTTP 502 + 504 as transient', () => {
    expect(defaultClassifyFailure(Object.assign(new Error('bad gateway'), { statusCode: 502 }))).toBe('transient');
    expect(defaultClassifyFailure(Object.assign(new Error('gateway timeout'), { statusCode: 504 }))).toBe('transient');
  });

  it('classifies ECONNRESET as transient', () => {
    const err = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    expect(defaultClassifyFailure(err)).toBe('transient');
  });

  it('classifies EBUSY (Windows transient) as transient', () => {
    const err = Object.assign(new Error('resource busy'), { code: 'EBUSY' });
    expect(defaultClassifyFailure(err)).toBe('transient');
  });

  it('classifies AbortError as catastrophic (signal-aborted, do not retry)', () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(defaultClassifyFailure(err)).toBe('catastrophic');
  });

  it('classifies generic Error as structural', () => {
    expect(defaultClassifyFailure(new Error('something else'))).toBe('structural');
  });

  it('classifies non-Error as structural', () => {
    expect(defaultClassifyFailure('a string')).toBe('structural');
    expect(defaultClassifyFailure(undefined)).toBe('structural');
    expect(defaultClassifyFailure(null)).toBe('structural');
    expect(defaultClassifyFailure(42)).toBe('structural');
  });

  it('respects status field aliasing (HTTP libs use either statusCode or status)', () => {
    expect(defaultClassifyFailure({ status: 429 })).toBe('transient');
    expect(defaultClassifyFailure({ status: 500 })).toBe('structural');
  });
});

/**
 * Contract test runner. Consumers of `AgentLoopAdapter` use this to
 * verify their reference adapter satisfies the interface.
 */
export function runAgentLoopContract(name: string, build: () => AgentLoopAdapter) {
  describe(`AgentLoopAdapter contract: ${name}`, () => {
    it('exposes capabilities', () => {
      const a = build();
      expect(a.capabilities).toBeDefined();
      expect(typeof a.capabilities.tracks_cost).toBe('boolean');
      expect(typeof a.capabilities.supports_signal).toBe('boolean');
      expect(typeof a.capabilities.classify_failure).toBe('function');
    });

    // Behavioral tests run in the reference-adapter test files.
  });
}
