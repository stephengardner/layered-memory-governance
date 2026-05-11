import { describe, expect, it } from 'vitest';
// Runtime import forces the module to resolve so a missing file fails the run.
import * as claimVerifierTypes from '../../../src/substrate/claim-verifiers/types.js';
import type {
  ClaimVerifier,
  VerifierContext,
  VerifierResult,
} from '../../../src/substrate/claim-verifiers/types.js';

describe('ClaimVerifier shape', () => {
  it('module loads (proves src/substrate/claim-verifiers/types.ts exists)', () => {
    // Module is a type-only namespace at runtime, but its existence is required.
    expect(claimVerifierTypes).toBeDefined();
  });

  it('compiles as a function returning a Promise<VerifierResult>', async () => {
    const stub: ClaimVerifier = async (
      _id: string,
      _expected: string[],
      _ctx: VerifierContext,
    ): Promise<VerifierResult> => ({ ok: true, observed_state: 'MERGED' });
    const r = await stub('1', ['MERGED'], {} as VerifierContext);
    expect(r.ok).toBe(true);
    expect(r.observed_state).toBe('MERGED');
  });
});
