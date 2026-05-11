import { describe, expect, it, vi } from 'vitest';
// Runtime import forces the module to resolve so a missing file fails the run.
import * as taskVerifier from '../../../src/substrate/claim-verifiers/task.js';
import { verifyTaskTerminal } from '../../../src/substrate/claim-verifiers/task.js';
import type { Atom } from '../../../src/substrate/types.js';
import type { Host, AtomStore } from '../../../src/substrate/interface.js';

/**
 * Build a minimal stub Host whose only working sub-interface is
 * `atoms.get`. The verifier under test reads ONLY this surface, so the
 * other Host fields stay unimplemented. Casts go through `unknown` to
 * satisfy the no-explicit-any architectural guard while keeping the stub
 * narrow to the contract the verifier consumes.
 */
function buildHost(getImpl: (id: string) => Promise<Atom | null>): Host {
  const atomStore = { get: getImpl } as unknown as AtomStore;
  return { atoms: atomStore } as unknown as Host;
}

/**
 * Build a minimal Atom carrying `metadata.task.status`. Only the fields
 * the verifier actually reads are populated; the rest are placeholders
 * the type checker is happy with. The final cast goes through `unknown`
 * because the Atom shape narrows `metadata` more strictly than the test
 * needs (research-atom payload schema is open by design).
 */
function taskAtom(status: string): Atom {
  return {
    schema_version: 1,
    id: 'task-001',
    content: '',
    type: 'task',
    layer: 'L0',
    provenance: {
      principal_id: 'p',
      created_by_principal_id: 'p',
      source_kind: 'host-runtime',
      created_at: 0,
      derived_from: [],
    },
    confidence: 1,
    created_at: 0,
    last_reinforced_at: 0,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'global',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'verified',
      last_validated_at: null,
    },
    principal_id: 'p',
    taint: 'clean',
    metadata: { task: { status } },
  } as unknown as Atom;
}

describe('verifyTaskTerminal', () => {
  it('module loads (proves src/substrate/claim-verifiers/task.ts exists)', () => {
    expect(taskVerifier).toBeDefined();
  });

  it('returns ok=true when atom metadata.task.status matches one of expected', async () => {
    const get = vi.fn().mockResolvedValueOnce(taskAtom('completed'));
    const result = await verifyTaskTerminal('001', ['completed'], {
      host: buildHost(get),
    });
    expect(result).toEqual({ ok: true, observed_state: 'completed' });
    expect(get).toHaveBeenCalledWith('task-001');
  });

  it('returns ok=false with observed_state when status does NOT match expected', async () => {
    const get = vi.fn().mockResolvedValueOnce(taskAtom('in-progress'));
    const result = await verifyTaskTerminal('001', ['completed'], {
      host: buildHost(get),
    });
    expect(result).toEqual({ ok: false, observed_state: 'in-progress' });
  });

  it('returns ok=false NOT_FOUND when atom lookup returns null', async () => {
    const get = vi.fn().mockResolvedValueOnce(null);
    const result = await verifyTaskTerminal('missing', ['completed'], {
      host: buildHost(get),
    });
    expect(result).toEqual({ ok: false, observed_state: 'NOT_FOUND' });
  });

  it('returns ok=false NOT_FOUND when atom is present but lacks metadata.task.status', async () => {
    // An atom prefixed task- but missing the canonical status field is
    // not "task in unknown terminal state"; we cannot make a claim about
    // its lifecycle. Surfacing NOT_FOUND keeps the verifier honest.
    const malformed = taskAtom('completed');
    const get = vi.fn().mockResolvedValueOnce({
      ...malformed,
      metadata: { task: {} },
    });
    const result = await verifyTaskTerminal('001', ['completed'], {
      host: buildHost(get),
    });
    expect(result).toEqual({ ok: false, observed_state: 'NOT_FOUND' });
  });

  it('case-sensitive match: lowercase expected vs uppercase observed is a mismatch', async () => {
    const get = vi.fn().mockResolvedValueOnce(taskAtom('COMPLETED'));
    const result = await verifyTaskTerminal('001', ['completed'], {
      host: buildHost(get),
    });
    expect(result).toEqual({ ok: false, observed_state: 'COMPLETED' });
  });

  it('throws on AtomStore.get error', async () => {
    const get = vi.fn().mockRejectedValueOnce(new Error('disk failure'));
    await expect(
      verifyTaskTerminal('001', ['completed'], { host: buildHost(get) }),
    ).rejects.toThrow();
  });
});
