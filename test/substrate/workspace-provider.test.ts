import { describe, it, expect } from 'vitest';
import type { AcquireInput } from '../../src/substrate/workspace-provider.js';
import type { PrincipalId } from '../../src/substrate/types.js';

describe('AcquireInput.checkoutBranch', () => {
  it('accepts optional checkoutBranch', () => {
    const input: AcquireInput = {
      principal: 'p' as PrincipalId,
      baseRef: 'main',
      correlationId: 'corr-1',
      checkoutBranch: 'feat/x',
    };
    expect(input.checkoutBranch).toBe('feat/x');
  });

  it('checkoutBranch is optional (omitted)', () => {
    const input: AcquireInput = {
      principal: 'p' as PrincipalId,
      baseRef: 'main',
      correlationId: 'corr-1',
    };
    expect(input.checkoutBranch).toBeUndefined();
  });
});
