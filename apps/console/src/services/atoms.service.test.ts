import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getAtomById, listReferencers } from './atoms.service';
import { transport } from './transport';

/*
 * `getAtomById` wraps transport.call('atoms.get'). The contract:
 *   - returns the AnyAtom on success
 *   - returns null when the backend reports atom-not-found (via the
 *     standard error envelope: error.code === 'atom-not-found')
 *   - rethrows any other transport error
 */

describe('getAtomById', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the atom from a successful transport call', async () => {
    const mock = vi.spyOn(transport, 'call').mockResolvedValue({
      id: 'plan-abc',
      type: 'plan',
      layer: 'L1',
      content: 'body',
      principal_id: 'cto-actor',
      confidence: 0.9,
      created_at: '2026-04-29T00:00:00Z',
    });
    const out = await getAtomById('plan-abc');
    expect(out?.id).toBe('plan-abc');
    expect(mock).toHaveBeenCalledWith(
      'atoms.get',
      { id: 'plan-abc' },
      undefined,
    );
  });

  it('passes an abort signal through to the transport when provided', async () => {
    const ctrl = new AbortController();
    const mock = vi.spyOn(transport, 'call').mockResolvedValue({
      id: 'plan-abc',
      type: 'plan',
      layer: 'L1',
      content: 'body',
      principal_id: 'cto-actor',
      confidence: 0.9,
      created_at: '2026-04-29T00:00:00Z',
    });
    await getAtomById('plan-abc', ctrl.signal);
    expect(mock).toHaveBeenCalledWith(
      'atoms.get',
      { id: 'plan-abc' },
      { signal: ctrl.signal },
    );
  });

  it('returns null when the backend reports atom-not-found (Error.name)', async () => {
    const err = new Error('atom-not-found: no atom with id mystery');
    err.name = 'atom-not-found';
    vi.spyOn(transport, 'call').mockRejectedValue(err);
    const out = await getAtomById('mystery');
    expect(out).toBeNull();
  });

  it('returns null when the message starts with atom-not-found (legacy shape)', async () => {
    const err = new Error('atom-not-found: legacy shape');
    vi.spyOn(transport, 'call').mockRejectedValue(err);
    const out = await getAtomById('mystery');
    expect(out).toBeNull();
  });

  it('rethrows other transport errors (network, 500)', async () => {
    const err = new Error('http-500: server crashed');
    err.name = 'http-500';
    vi.spyOn(transport, 'call').mockRejectedValue(err);
    await expect(getAtomById('plan-abc')).rejects.toThrow(/http-500/);
  });
});

/*
 * `listReferencers` (atoms.service variant) wraps transport.call('atoms.references').
 * Distinct from the canon-narrowed sibling in canon.service.ts: this version
 * returns AnyAtom[] so non-canon referencers (plans, pipeline outputs,
 * intents, observations, pr-fix-observations) surface in the generic
 * atom-detail viewer's "Referenced by" block.
 */
describe('listReferencers (atom-wide)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the referencers array from the transport call', async () => {
    const refs = [
      {
        id: 'plan-abc',
        type: 'plan',
        layer: 'L1' as const,
        content: 'plan body',
        principal_id: 'cto-actor',
        confidence: 0.85,
        created_at: '2026-04-29T00:00:00Z',
      },
      {
        id: 'pr-fix-observation-xyz',
        type: 'pr-fix-observation',
        layer: 'L0' as const,
        content: 'observed PR state',
        principal_id: 'pr-fix-actor',
        confidence: 0.9,
        created_at: '2026-04-29T01:00:00Z',
      },
    ];
    const mock = vi.spyOn(transport, 'call').mockResolvedValue(refs);
    const out = await listReferencers('canon-target-id');
    expect(out).toHaveLength(2);
    expect(out[0]?.type).toBe('plan');
    expect(out[1]?.type).toBe('pr-fix-observation');
    expect(mock).toHaveBeenCalledWith(
      'atoms.references',
      { id: 'canon-target-id' },
      undefined,
    );
  });

  it('passes the abort signal through to transport when provided', async () => {
    const ctrl = new AbortController();
    const mock = vi.spyOn(transport, 'call').mockResolvedValue([]);
    await listReferencers('atom-id', ctrl.signal);
    expect(mock).toHaveBeenCalledWith(
      'atoms.references',
      { id: 'atom-id' },
      { signal: ctrl.signal },
    );
  });

  it('returns an empty list when no referencers exist', async () => {
    vi.spyOn(transport, 'call').mockResolvedValue([]);
    const out = await listReferencers('orphan-atom');
    expect(out).toEqual([]);
  });
});
