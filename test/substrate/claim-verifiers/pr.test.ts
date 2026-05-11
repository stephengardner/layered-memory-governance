import { describe, expect, it, vi, beforeEach } from 'vitest';
// Runtime import forces the module to resolve so a missing file fails the run.
import * as prVerifier from '../../../src/substrate/claim-verifiers/pr.js';
import { verifyPrTerminal } from '../../../src/substrate/claim-verifiers/pr.js';

describe('verifyPrTerminal', () => {
  beforeEach(() => vi.resetAllMocks());

  it('module loads (proves src/substrate/claim-verifiers/pr.ts exists)', () => {
    expect(prVerifier).toBeDefined();
  });

  it('returns ok=true when PR state matches one of expected', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ state: 'MERGED' }),
    });
    const result = await verifyPrTerminal('999', ['MERGED'], {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: mockFetch as any,
    });
    expect(result).toEqual({ ok: true, observed_state: 'MERGED' });
  });

  it('returns ok=false with observed_state when PR is not in expected states', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ state: 'OPEN' }),
    });
    const result = await verifyPrTerminal('999', ['MERGED'], {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: mockFetch as any,
    });
    expect(result).toEqual({ ok: false, observed_state: 'OPEN' });
  });

  it('returns ok=false NOT_FOUND on 404', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 404 });
    const result = await verifyPrTerminal('999', ['MERGED'], {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchImpl: mockFetch as any,
    });
    expect(result).toEqual({ ok: false, observed_state: 'NOT_FOUND' });
  });

  it('throws on 5xx', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 });
    await expect(
      verifyPrTerminal('999', ['MERGED'], {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        host: {} as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchImpl: mockFetch as any,
      }),
    ).rejects.toThrow();
  });
});
