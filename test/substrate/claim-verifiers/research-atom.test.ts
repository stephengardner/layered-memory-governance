import { describe, expect, it, vi, beforeEach } from 'vitest';
// Runtime import forces the module to resolve so a missing file fails the run.
import * as researchAtomVerifier from '../../../src/substrate/claim-verifiers/research-atom.js';
import { verifyResearchAtomTerminal } from '../../../src/substrate/claim-verifiers/research-atom.js';
import type { Host } from '../../../src/substrate/interface.js';

/**
 * Build a minimal Host-shaped stub whose only meaningful surface is
 * `atoms.get`. The verifier never touches anything else, so we route the
 * cast through `unknown` to keep the no-explicit-any guard happy without
 * standing up a full Host mock.
 */
function makeHost(getImpl: (id: string) => Promise<unknown>): Host {
  return {
    atoms: { get: vi.fn(getImpl) },
  } as unknown as Host;
}

describe('verifyResearchAtomTerminal', () => {
  beforeEach(() => vi.resetAllMocks());

  it('module loads (proves src/substrate/claim-verifiers/research-atom.ts exists)', () => {
    expect(researchAtomVerifier).toBeDefined();
  });

  it('returns ok=true when atom.metadata.research.status matches one of expected', async () => {
    const host = makeHost(async () => ({
      id: 'atom-1',
      metadata: { research: { status: 'published' } },
    }));
    const result = await verifyResearchAtomTerminal('atom-1', ['published'], {
      host,
    });
    expect(result).toEqual({ ok: true, observed_state: 'published' });
  });

  it('does NOT fall back to atom.metadata.status (canonical path is the contract)', async () => {
    // A flat metadata.status field is NOT honored. Widening to a
    // generic fallback would false-accept any atom carrying a
    // status-like field; the verifier kind is pinned to the
    // research-atom schema. Deployments using a different layout
    // register a different verifier kind.
    const host = makeHost(async () => ({
      id: 'atom-2',
      metadata: { status: 'published' },
    }));
    const result = await verifyResearchAtomTerminal('atom-2', ['published'], {
      host,
    });
    expect(result).toEqual({ ok: false, observed_state: 'NOT_FOUND' });
  });

  it('returns ok=false with observed_state when status is not in expected', async () => {
    const host = makeHost(async () => ({
      id: 'atom-3',
      metadata: { research: { status: 'drafting' } },
    }));
    const result = await verifyResearchAtomTerminal('atom-3', ['published'], {
      host,
    });
    expect(result).toEqual({ ok: false, observed_state: 'drafting' });
  });

  it('comparison is case-sensitive (Published != published is a mismatch)', async () => {
    const host = makeHost(async () => ({
      id: 'atom-4',
      metadata: { research: { status: 'Published' } },
    }));
    const result = await verifyResearchAtomTerminal('atom-4', ['published'], {
      host,
    });
    expect(result).toEqual({ ok: false, observed_state: 'Published' });
  });

  it('returns ok=false NOT_FOUND when atom is null', async () => {
    const host = makeHost(async () => null);
    const result = await verifyResearchAtomTerminal('missing', ['published'], {
      host,
    });
    expect(result).toEqual({ ok: false, observed_state: 'NOT_FOUND' });
  });

  it('returns ok=false NOT_FOUND when status is missing on both paths', async () => {
    const host = makeHost(async () => ({
      id: 'atom-5',
      metadata: { research: {} },
    }));
    const result = await verifyResearchAtomTerminal('atom-5', ['published'], {
      host,
    });
    expect(result).toEqual({ ok: false, observed_state: 'NOT_FOUND' });
  });

  it('returns ok=false NOT_FOUND when atom has no metadata at all', async () => {
    const host = makeHost(async () => ({ id: 'atom-6' }));
    const result = await verifyResearchAtomTerminal('atom-6', ['published'], {
      host,
    });
    expect(result).toEqual({ ok: false, observed_state: 'NOT_FOUND' });
  });

  it('throws when atomStore.get throws', async () => {
    const host = makeHost(async () => {
      throw new Error('store offline');
    });
    await expect(
      verifyResearchAtomTerminal('atom-7', ['published'], {
        host,
      }),
    ).rejects.toThrow(/store offline/);
  });
});
