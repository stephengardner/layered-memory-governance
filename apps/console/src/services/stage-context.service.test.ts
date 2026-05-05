import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getStageContext, type StageContext } from './stage-context.service';
import { transport } from './transport';

/*
 * `getStageContext` wraps transport.call('atoms.stage-context'). The
 * contract mirrors `getAtomById`:
 *   - returns the StageContext on success (including the empty-shape
 *     response when the atom is not a pipeline-stage output)
 *   - returns null when the backend reports atom-not-found
 *   - rethrows any other transport error
 */

const SAMPLE: StageContext = Object.freeze({
  stage: 'brainstorm-stage',
  principal_id: 'brainstorm-actor',
  skill_bundle: 'brainstorming',
  soul: '# Brainstorming skill',
  upstream_chain: [],
  canon_at_runtime: [],
});

describe('getStageContext', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the stage context from a successful transport call', async () => {
    const mock = vi.spyOn(transport, 'call').mockResolvedValue(SAMPLE);
    const out = await getStageContext('brainstorm-1');
    expect(out).toEqual(SAMPLE);
    expect(mock).toHaveBeenCalledWith(
      'atoms.stage-context',
      { atom_id: 'brainstorm-1' },
      undefined,
    );
  });

  it('passes an abort signal through to the transport when provided', async () => {
    const ctrl = new AbortController();
    const mock = vi.spyOn(transport, 'call').mockResolvedValue(SAMPLE);
    await getStageContext('brainstorm-1', ctrl.signal);
    expect(mock).toHaveBeenCalledWith(
      'atoms.stage-context',
      { atom_id: 'brainstorm-1' },
      { signal: ctrl.signal },
    );
  });

  it('returns null when the backend reports atom-not-found via Error.name', async () => {
    const err = new Error('atom-not-found: no atom with id mystery');
    err.name = 'atom-not-found';
    vi.spyOn(transport, 'call').mockRejectedValue(err);
    const out = await getStageContext('mystery');
    expect(out).toBeNull();
  });

  it('returns null when atom-not-found is encoded in the message prefix', async () => {
    const err = new Error('atom-not-found: gone');
    vi.spyOn(transport, 'call').mockRejectedValue(err);
    const out = await getStageContext('mystery');
    expect(out).toBeNull();
  });

  it('rethrows non-not-found errors so React Query surfaces them', async () => {
    const err = new Error('500 internal');
    vi.spyOn(transport, 'call').mockRejectedValue(err);
    await expect(getStageContext('boom')).rejects.toThrow('500 internal');
  });

  it('returns the empty-shape response when the atom is not a pipeline-stage output', async () => {
    const empty: StageContext = {
      stage: null,
      principal_id: null,
      skill_bundle: null,
      soul: null,
      upstream_chain: [],
      canon_at_runtime: [],
    };
    vi.spyOn(transport, 'call').mockResolvedValue(empty);
    const out = await getStageContext('observation-foo');
    expect(out).toEqual(empty);
  });
});
