import { describe, expect, it, vi, beforeEach } from 'vitest';
// Runtime import forces the module to resolve so a missing file fails the run.
import * as researchAtomVerifier from '../../../src/substrate/claim-verifiers/research-atom.js';
import { verifyResearchAtomTerminal } from '../../../src/substrate/claim-verifiers/research-atom.js';

/**
 * Build a minimal Host-shaped stub whose only meaningful surface is
 * `atoms.get`. The verifier never touches anything else, so the rest of
 * the Host can stay an obvious unknown; a real Host stand-in would
 * over-couple the test to the substrate interface shape.
 */
function makeHost(getImpl: (id: string) => Promise<unknown>) {
  return {
    atoms: { get: vi.fn(getImpl) },
  };
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
    });
    expect(result).toEqual({ ok: true, observed_state: 'published' });
  });

  it('falls back to atom.metadata.status when research block is absent', async () => {
    // Some research-shaped atoms keep the status at metadata.status rather
    // than nesting under metadata.research; the verifier accepts either
    // shape so a deployment can pick the convention that fits its atom
    // schema without forking the verifier.
    const host = makeHost(async () => ({
      id: 'atom-2',
      metadata: { status: 'published' },
    }));
    const result = await verifyResearchAtomTerminal('atom-2', ['published'], {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
    });
    expect(result).toEqual({ ok: true, observed_state: 'published' });
  });

  it('returns ok=false with observed_state when status is not in expected', async () => {
    const host = makeHost(async () => ({
      id: 'atom-3',
      metadata: { research: { status: 'drafting' } },
    }));
    const result = await verifyResearchAtomTerminal('atom-3', ['published'], {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
    });
    expect(result).toEqual({ ok: false, observed_state: 'drafting' });
  });

  it('comparison is case-sensitive (Published != published is a mismatch)', async () => {
    const host = makeHost(async () => ({
      id: 'atom-4',
      metadata: { research: { status: 'Published' } },
    }));
    const result = await verifyResearchAtomTerminal('atom-4', ['published'], {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
    });
    expect(result).toEqual({ ok: false, observed_state: 'Published' });
  });

  it('returns ok=false NOT_FOUND when atom is null', async () => {
    const host = makeHost(async () => null);
    const result = await verifyResearchAtomTerminal('missing', ['published'], {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
    });
    expect(result).toEqual({ ok: false, observed_state: 'NOT_FOUND' });
  });

  it('returns ok=false NOT_FOUND when status is missing on both paths', async () => {
    const host = makeHost(async () => ({
      id: 'atom-5',
      metadata: { research: {} },
    }));
    const result = await verifyResearchAtomTerminal('atom-5', ['published'], {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
    });
    expect(result).toEqual({ ok: false, observed_state: 'NOT_FOUND' });
  });

  it('returns ok=false NOT_FOUND when atom has no metadata at all', async () => {
    const host = makeHost(async () => ({ id: 'atom-6' }));
    const result = await verifyResearchAtomTerminal('atom-6', ['published'], {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      host: host as any,
    });
    expect(result).toEqual({ ok: false, observed_state: 'NOT_FOUND' });
  });

  it('throws when atomStore.get throws', async () => {
    const host = makeHost(async () => {
      throw new Error('store offline');
    });
    await expect(
      verifyResearchAtomTerminal('atom-7', ['published'], {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        host: host as any,
      }),
    ).rejects.toThrow(/store offline/);
  });
});
