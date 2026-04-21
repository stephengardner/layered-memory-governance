/**
 * SubActorRegistry tests.
 *
 * Covers:
 *   - happy path: register + invoke -> InvokeResult
 *   - unregistered -> ValidationError
 *   - double-register with same invoker = idempotent; with different
 *     invoker = throws (drift guard)
 *   - invoker throw -> returned as InvokeResult.error, not propagated
 *   - list() returns registered principal ids, sorted
 *   - has() is true/false correctly
 */

import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/substrate/errors.js';
import type { PrincipalId } from '../../src/substrate/types.js';
import {
  SubActorRegistry,
  type InvokeResult,
} from '../../src/actor-message/sub-actor-registry.js';

describe('SubActorRegistry', () => {
  it('registers and invokes a sub-actor', async () => {
    const reg = new SubActorRegistry();
    const invoker = async (payload: unknown, corr: string): Promise<InvokeResult> => ({
      kind: 'completed',
      producedAtomIds: [`atom-${corr}`],
      summary: `ran with ${JSON.stringify(payload)}`,
    });
    reg.register('auditor-actor' as PrincipalId, invoker);
    const result = await reg.invoke('auditor-actor' as PrincipalId, { scope: 'all' }, 'corr-1');
    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') return;
    expect(result.producedAtomIds).toEqual(['atom-corr-1']);
    expect(result.summary).toContain('scope');
  });

  it('invoking an unregistered principal throws ValidationError', async () => {
    const reg = new SubActorRegistry();
    await expect(
      reg.invoke('ghost' as PrincipalId, {}, 'corr-x'),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('double-register with same invoker is idempotent', () => {
    const reg = new SubActorRegistry();
    const invoker = async (): Promise<InvokeResult> => ({
      kind: 'completed',
      producedAtomIds: [],
      summary: '',
    });
    reg.register('a' as PrincipalId, invoker);
    expect(() => reg.register('a' as PrincipalId, invoker)).not.toThrow();
  });

  it('double-register with a different invoker throws (drift guard)', () => {
    const reg = new SubActorRegistry();
    const i1 = async (): Promise<InvokeResult> => ({ kind: 'completed', producedAtomIds: [], summary: '' });
    const i2 = async (): Promise<InvokeResult> => ({ kind: 'completed', producedAtomIds: [], summary: '' });
    reg.register('a' as PrincipalId, i1);
    expect(() => reg.register('a' as PrincipalId, i2)).toThrow(/already has a different invoker/);
  });

  it('invoker throw is wrapped as InvokeResult.error, not propagated', async () => {
    const reg = new SubActorRegistry();
    reg.register('boom' as PrincipalId, async () => {
      throw new Error('kaboom');
    });
    const result = await reg.invoke('boom' as PrincipalId, {}, 'corr-err');
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toBe('kaboom');
  });

  it('list() returns registered principal ids sorted', () => {
    const reg = new SubActorRegistry();
    const noop = async (): Promise<InvokeResult> => ({ kind: 'completed', producedAtomIds: [], summary: '' });
    reg.register('zulu' as PrincipalId, noop);
    reg.register('alpha' as PrincipalId, noop);
    reg.register('mike' as PrincipalId, noop);
    expect(reg.list()).toEqual(['alpha', 'mike', 'zulu']);
  });

  it('has() reports membership correctly', () => {
    const reg = new SubActorRegistry();
    expect(reg.has('x' as PrincipalId)).toBe(false);
    reg.register('x' as PrincipalId, async () => ({
      kind: 'completed',
      producedAtomIds: [],
      summary: '',
    }));
    expect(reg.has('x' as PrincipalId)).toBe(true);
    expect(reg.has('y' as PrincipalId)).toBe(false);
  });
});
