import { describe, expect, it, vi, beforeEach } from 'vitest';
// Runtime import forces the module to resolve so a missing file fails the run.
import * as prVerifier from '../../../src/substrate/claim-verifiers/pr.js';
import { verifyPrTerminal } from '../../../src/substrate/claim-verifiers/pr.js';
import type { Host } from '../../../src/substrate/interface.js';

/**
 * Build a minimal Host-shaped stub. `verifyPrTerminal` never touches the
 * Host directly (the verifier is HTTP-bound), so the stub stays empty and
 * the cast goes through `unknown` to satisfy the no-explicit-any guard.
 */
const STUB_HOST = {} as unknown as Host;

/**
 * Test-fixture repo coordinates. The verifier now throws when neither
 * ctx.repo nor GITHUB_REPOSITORY is set; passing ctx.repo explicitly
 * keeps the tests independent of the runner's environment.
 */
const FIXTURE_REPO = { owner: 'fixture-owner', repo: 'fixture-repo' } as const;

/**
 * Cast a `vi.fn()` to the `fetch` type without using `any`. Tests do not
 * care about the full Response surface; the verifier reads only `status`,
 * `ok`, and calls `json()`, so we go through `unknown` rather than try to
 * model the Response constructor signature.
 */
function asFetchImpl(fn: ReturnType<typeof vi.fn>): typeof fetch {
  return fn as unknown as typeof fetch;
}

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
      host: STUB_HOST,
      fetchImpl: asFetchImpl(mockFetch),
      repo: FIXTURE_REPO,
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
      host: STUB_HOST,
      fetchImpl: asFetchImpl(mockFetch),
      repo: FIXTURE_REPO,
    });
    expect(result).toEqual({ ok: false, observed_state: 'OPEN' });
  });

  it('returns ok=false NOT_FOUND on 404', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 404 });
    const result = await verifyPrTerminal('999', ['MERGED'], {
      host: STUB_HOST,
      fetchImpl: asFetchImpl(mockFetch),
      repo: FIXTURE_REPO,
    });
    expect(result).toEqual({ ok: false, observed_state: 'NOT_FOUND' });
  });

  it('throws on 5xx', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 });
    await expect(
      verifyPrTerminal('999', ['MERGED'], {
        host: STUB_HOST,
        fetchImpl: asFetchImpl(mockFetch),
        repo: FIXTURE_REPO,
      }),
    ).rejects.toThrow();
  });

  it('throws when neither ctx.repo nor GITHUB_REPOSITORY is set', async () => {
    const originalEnv = process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPOSITORY;
    try {
      const mockFetch = vi.fn();
      await expect(
        verifyPrTerminal('999', ['MERGED'], {
          host: STUB_HOST,
          fetchImpl: asFetchImpl(mockFetch),
        }),
      ).rejects.toThrow(/missing repo coordinates/);
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      if (originalEnv !== undefined) {
        process.env.GITHUB_REPOSITORY = originalEnv;
      }
    }
  });
});
