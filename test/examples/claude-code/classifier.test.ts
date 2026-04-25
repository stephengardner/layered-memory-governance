import { describe, it, expect } from 'vitest';
import { classifyClaudeCliFailure } from '../../../examples/agent-loops/claude-code/classifier.js';

describe('classifyClaudeCliFailure', () => {
  it('AbortError is catastrophic regardless of exit/stderr', () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(classifyClaudeCliFailure(err, null, '')).toBe('catastrophic');
  });

  it('ENOENT (claude not installed) is catastrophic', () => {
    expect(classifyClaudeCliFailure(null, 127, 'claude: command not found')).toBe('catastrophic');
  });

  it('auth error is catastrophic (precedence over rate-limit)', () => {
    expect(classifyClaudeCliFailure(null, 1, 'Error 401: please re-authenticate (rate limit may apply)')).toBe('catastrophic');
  });

  it('budget marker is structural at classifier level (adapter remaps to budget-exhausted)', () => {
    expect(classifyClaudeCliFailure(null, 1, 'budget exhausted')).toBe('structural');
  });

  it('rate limit is transient', () => {
    expect(classifyClaudeCliFailure(null, 1, 'Error 429: rate limit hit')).toBe('transient');
  });

  it('5xx upstream markers in stderr classify as transient', () => {
    expect(classifyClaudeCliFailure(null, 1, 'Error 503: upstream unavailable')).toBe('transient');
    expect(classifyClaudeCliFailure(null, 1, 'Bad Gateway')).toBe('transient');
    expect(classifyClaudeCliFailure(null, 1, 'Gateway Timeout')).toBe('transient');
  });

  it('generic non-zero exit is structural', () => {
    expect(classifyClaudeCliFailure(null, 1, 'Some unrelated error')).toBe('structural');
  });

  it('falls through to default for unknown error shape', () => {
    expect(classifyClaudeCliFailure({ statusCode: 502 }, null, '')).toBe('transient');
  });

  it('falls through to default for plain Error', () => {
    expect(classifyClaudeCliFailure(new Error('weird'), null, '')).toBe('structural');
  });
});
