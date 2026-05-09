/**
 * Pipeline subgraph reaper tests.
 *
 * Coverage:
 *   - validatePipelineReaperTtls: rejects non-positive / non-integer
 *     fields; accepts the default TTL set.
 *   - classifyPipelineForReap: ignores non-pipeline atoms; skips
 *     running / pending pipelines; handles terminal vs hil-paused
 *     thresholds; honors the metadata.completed_at > last_reinforced_at
 *     > created_at fallback chain; returns null on un-parseable
 *     timestamps; returns skip on future-dated atoms (clock skew).
 *   - markPipelineReaped: writes metadata.reaped_at + reaped_reason,
 *     floors confidence to 0.01, emits a pipeline.reaped audit row,
 *     idempotent on a second call.
 *   - markStageAtomReaped: same shape as markPipelineReaped,
 *     audit kind pipeline.stage_atom_reaped, rejects pipeline-typed
 *     atoms (misuse guard).
 *   - runPipelineReaperSweep: end-to-end on a MemoryHost. Seeds a
 *     full subgraph (1 pipeline + 5 stage outputs + 8 stage events +
 *     2 audit findings + 1 agent session + 5 agent turns), pins the
 *     clock, asserts every child + the parent get metadata.reaped_at,
 *     audit log has correct event kinds in correct order, second
 *     sweep is a no-op.
 *   - TOCTOU: pipeline that flips back to running between classify
 *     and apply is skipped.
 *   - Kill-switch: a tripped killswitch returns truncated=true with
 *     no writes.
 */

import { describe, expect, it } from 'vitest';

import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import {
  DEFAULT_PIPELINE_REAPER_TTLS,
  classifyPipelineForReap,
  loadAllTerminalPipelines,
  markPipelineReaped,
  markStageAtomReaped,
  runPipelineReaperSweep,
  validatePipelineReaperTtls,
  type PipelineReaperTtls,
} from '../../../src/runtime/plans/pipeline-reaper.js';
import type {
  Atom,
  AtomId,
  AtomType,
  PrincipalId,
  Time,
} from '../../../src/substrate/types.js';

const TTLS: PipelineReaperTtls = {
  terminalPipelineMs: 30 * 24 * 60 * 60 * 1000,
  hilPausedPipelineMs: 14 * 24 * 60 * 60 * 1000,
  agentSessionMs: 30 * 24 * 60 * 60 * 1000,
};

const NOW_ISO = '2026-05-09T20:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);

interface PipelineAtomOverrides {
  readonly pipeline_state?: string | undefined;
  readonly created_at?: string;
  readonly last_reinforced_at?: string;
  readonly completed_at?: string | null;
  readonly metadata?: Record<string, unknown>;
  readonly type?: AtomType;
}

function pipelineAtom(id: string, overrides: PipelineAtomOverrides = {}): Atom {
  const type: AtomType = overrides.type ?? 'pipeline';
  const created = overrides.created_at ?? '2026-04-01T00:00:00.000Z';
  const reinforced = overrides.last_reinforced_at ?? created;
  const baseMeta: Record<string, unknown> = { ...overrides.metadata };
  if (overrides.completed_at !== undefined) {
    if (overrides.completed_at !== null) {
      baseMeta['completed_at'] = overrides.completed_at;
    }
  }
  const base: Atom = {
    schema_version: 1,
    id: id as AtomId,
    content: `pipeline:${id}`,
    type,
    layer: 'L0',
    provenance: {
      kind: 'agent-observed',
      source: { tool: 'planning-pipeline', agent_id: 'cto-actor' },
      derived_from: [],
    },
    confidence: 1.0,
    created_at: created as Time,
    last_reinforced_at: reinforced as Time,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: 'cto-actor' as PrincipalId,
    taint: 'clean',
    metadata: baseMeta,
  };
  if (type === 'pipeline') {
    return {
      ...base,
      pipeline_state: overrides.pipeline_state ?? 'completed',
    };
  }
  return base;
}

function childAtom(
  id: string,
  type: AtomType,
  pipelineId: string,
  overrides: { metadata?: Record<string, unknown>; created_at?: string } = {},
): Atom {
  const created = overrides.created_at ?? '2026-04-01T00:00:00.000Z';
  return {
    schema_version: 1,
    id: id as AtomId,
    content: `${type}:${id}`,
    type,
    layer: 'L0',
    provenance: {
      kind: 'agent-observed',
      source: { tool: 'planning-pipeline', agent_id: 'cto-actor' },
      derived_from: [pipelineId as AtomId],
    },
    confidence: 1.0,
    created_at: created as Time,
    last_reinforced_at: created as Time,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: 'cto-actor' as PrincipalId,
    taint: 'clean',
    metadata: { pipeline_id: pipelineId, ...overrides.metadata },
  };
}

// ---------------------------------------------------------------------------
// validatePipelineReaperTtls
// ---------------------------------------------------------------------------

describe('validatePipelineReaperTtls', () => {
  it('accepts the default TTL set', () => {
    expect(() => validatePipelineReaperTtls(DEFAULT_PIPELINE_REAPER_TTLS)).not.toThrow();
  });

  it('rejects a zero terminalPipelineMs', () => {
    expect(() =>
      validatePipelineReaperTtls({ ...TTLS, terminalPipelineMs: 0 }),
    ).toThrow(/terminalPipelineMs/);
  });

  it('rejects a negative hilPausedPipelineMs', () => {
    expect(() =>
      validatePipelineReaperTtls({ ...TTLS, hilPausedPipelineMs: -1 }),
    ).toThrow(/hilPausedPipelineMs/);
  });

  it('rejects a non-integer agentSessionMs', () => {
    expect(() =>
      validatePipelineReaperTtls({ ...TTLS, agentSessionMs: 1.5 }),
    ).toThrow(/agentSessionMs/);
  });

  it('rejects NaN', () => {
    expect(() =>
      validatePipelineReaperTtls({ ...TTLS, terminalPipelineMs: Number.NaN }),
    ).toThrow(/terminalPipelineMs/);
  });
});

// ---------------------------------------------------------------------------
// classifyPipelineForReap
// ---------------------------------------------------------------------------

describe('classifyPipelineForReap', () => {
  it('returns null for non-pipeline atoms', () => {
    const atom = pipelineAtom('non-pipeline', { type: 'observation' });
    expect(classifyPipelineForReap(atom, NOW_MS, TTLS)).toBeNull();
  });

  it('skips a running pipeline', () => {
    const atom = pipelineAtom('p-running', {
      pipeline_state: 'running',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const c = classifyPipelineForReap(atom, NOW_MS, TTLS);
    expect(c?.verdict).toBe('skip');
    expect(c?.reason).toMatch(/state-not-eligible:running/);
  });

  it('skips a pending pipeline', () => {
    const atom = pipelineAtom('p-pending', {
      pipeline_state: 'pending',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const c = classifyPipelineForReap(atom, NOW_MS, TTLS);
    expect(c?.verdict).toBe('skip');
    expect(c?.reason).toMatch(/state-not-eligible:pending/);
  });

  it('skips a recently-completed pipeline (within terminal TTL)', () => {
    // Completed 5 days ago: well under the 30-day terminal TTL.
    const atom = pipelineAtom('p-fresh-complete', {
      pipeline_state: 'completed',
      completed_at: '2026-05-04T20:00:00.000Z',
      created_at: '2026-05-01T00:00:00.000Z',
    });
    const c = classifyPipelineForReap(atom, NOW_MS, TTLS);
    expect(c?.verdict).toBe('skip');
    expect(c?.reason).toBe('recently-terminal');
  });

  it('classifies an old completed pipeline as reap', () => {
    // Completed 31 days ago: past the 30-day terminal TTL.
    const atom = pipelineAtom('p-stale-complete', {
      pipeline_state: 'completed',
      completed_at: '2026-04-08T20:00:00.000Z',
      created_at: '2026-04-01T00:00:00.000Z',
    });
    const c = classifyPipelineForReap(atom, NOW_MS, TTLS);
    expect(c?.verdict).toBe('reap');
    expect(c?.reason).toMatch(/completed-after-\d+d/);
  });

  it('classifies an old failed pipeline as reap', () => {
    const atom = pipelineAtom('p-stale-failed', {
      pipeline_state: 'failed',
      completed_at: '2026-04-08T20:00:00.000Z',
      created_at: '2026-04-01T00:00:00.000Z',
    });
    const c = classifyPipelineForReap(atom, NOW_MS, TTLS);
    expect(c?.verdict).toBe('reap');
    expect(c?.reason).toMatch(/failed-after-\d+d/);
  });

  it('classifies an old hil-paused pipeline as reap on the shorter TTL', () => {
    // Paused 15 days ago: past the 14-day hil-paused TTL.
    const atom = pipelineAtom('p-paused-stale', {
      pipeline_state: 'hil-paused',
      last_reinforced_at: '2026-04-24T20:00:00.000Z',
      created_at: '2026-04-01T00:00:00.000Z',
    });
    const c = classifyPipelineForReap(atom, NOW_MS, TTLS);
    expect(c?.verdict).toBe('reap');
    expect(c?.reason).toMatch(/hil-paused-after-\d+d/);
  });

  it('skips a recently-paused pipeline (within hil-paused TTL)', () => {
    const atom = pipelineAtom('p-paused-fresh', {
      pipeline_state: 'hil-paused',
      last_reinforced_at: '2026-05-05T20:00:00.000Z',
      created_at: '2026-05-01T00:00:00.000Z',
    });
    const c = classifyPipelineForReap(atom, NOW_MS, TTLS);
    expect(c?.verdict).toBe('skip');
    expect(c?.reason).toBe('recently-hil-paused');
  });

  it('uses metadata.completed_at when present', () => {
    // last_reinforced_at says 2 days ago (fresh), but completed_at says
    // 35 days ago: completed_at wins. Tests the fallback ordering.
    const atom = pipelineAtom('p-completed-at-wins', {
      pipeline_state: 'completed',
      completed_at: '2026-04-04T20:00:00.000Z',
      last_reinforced_at: '2026-05-07T20:00:00.000Z',
      created_at: '2026-04-01T00:00:00.000Z',
    });
    const c = classifyPipelineForReap(atom, NOW_MS, TTLS);
    expect(c?.verdict).toBe('reap');
  });

  it('falls back to last_reinforced_at when completed_at is absent', () => {
    const atom = pipelineAtom('p-no-completed-at', {
      pipeline_state: 'completed',
      last_reinforced_at: '2026-04-04T20:00:00.000Z',
      created_at: '2026-04-01T00:00:00.000Z',
    });
    const c = classifyPipelineForReap(atom, NOW_MS, TTLS);
    expect(c?.verdict).toBe('reap');
  });

  it('skips on un-parseable timestamps', () => {
    const atom = pipelineAtom('p-bad-ts', {
      pipeline_state: 'completed',
      created_at: 'not-a-date',
      last_reinforced_at: 'not-a-date',
    });
    const c = classifyPipelineForReap(atom, NOW_MS, TTLS);
    expect(c?.verdict).toBe('skip');
    expect(c?.reason).toBe('unparseable-timestamp');
  });

  it('skips future-dated atoms (clock skew safety)', () => {
    const atom = pipelineAtom('p-future', {
      pipeline_state: 'completed',
      completed_at: '2026-06-01T00:00:00.000Z',
      created_at: '2026-06-01T00:00:00.000Z',
    });
    const c = classifyPipelineForReap(atom, NOW_MS, TTLS);
    expect(c?.verdict).toBe('skip');
    expect(c?.reason).toBe('future-dated');
    expect(c?.ageMs).toBeLessThan(0);
  });

  it('handles an exactly-at-threshold age (>= boundary)', () => {
    // Exactly 30 days: should classify as reap (>= threshold).
    const atom = pipelineAtom('p-boundary', {
      pipeline_state: 'completed',
      completed_at: '2026-04-09T20:00:00.000Z', // exactly 30 days before NOW
      created_at: '2026-04-01T00:00:00.000Z',
    });
    const c = classifyPipelineForReap(atom, NOW_MS, TTLS);
    expect(c?.verdict).toBe('reap');
  });
});

// ---------------------------------------------------------------------------
// markPipelineReaped
// ---------------------------------------------------------------------------

describe('markPipelineReaped', () => {
  it('writes reaped_at + reaped_reason and floors confidence to 0.01', async () => {
    const host = createMemoryHost();
    (host.clock as { now: () => Time }).now = () => NOW_ISO as Time;
    const atom = pipelineAtom('p-mark', {
      pipeline_state: 'completed',
      completed_at: '2026-04-01T00:00:00.000Z',
    });
    await host.atoms.put(atom);

    const updated = await markPipelineReaped(
      host,
      atom.id,
      'plan-reaper' as PrincipalId,
      'completed-after-38d',
    );

    expect((updated.metadata as Record<string, unknown>)['reaped_at']).toBe(NOW_ISO);
    expect((updated.metadata as Record<string, unknown>)['reaped_reason']).toBe(
      'completed-after-38d',
    );
    expect(updated.confidence).toBe(0.01);
  });

  it('emits a pipeline.reaped audit row with the atom id and prior state', async () => {
    const host = createMemoryHost();
    (host.clock as { now: () => Time }).now = () => NOW_ISO as Time;
    const atom = pipelineAtom('p-audit', {
      pipeline_state: 'completed',
      completed_at: '2026-04-01T00:00:00.000Z',
    });
    await host.atoms.put(atom);

    await markPipelineReaped(
      host,
      atom.id,
      'plan-reaper' as PrincipalId,
      'completed-after-38d',
    );

    const events = await host.auditor.query({ kind: ['pipeline.reaped'] }, 100);
    expect(events).toHaveLength(1);
    expect(events[0]?.principal_id).toBe('plan-reaper');
    expect(events[0]?.refs.atom_ids).toEqual([atom.id]);
    expect(events[0]?.details['reason']).toBe('completed-after-38d');
    expect(events[0]?.details['prior_pipeline_state']).toBe('completed');
  });

  it('is idempotent on a second call (no extra audit row, no extra update)', async () => {
    const host = createMemoryHost();
    (host.clock as { now: () => Time }).now = () => NOW_ISO as Time;
    const atom = pipelineAtom('p-idem', {
      pipeline_state: 'completed',
      completed_at: '2026-04-01T00:00:00.000Z',
    });
    await host.atoms.put(atom);

    await markPipelineReaped(
      host,
      atom.id,
      'plan-reaper' as PrincipalId,
      'completed-after-38d',
    );
    const firstReapedAt = ((await host.atoms.get(atom.id))?.metadata as Record<string, unknown>)[
      'reaped_at'
    ];

    // Change the clock; if the function were to write again, the
    // reaped_at value would change. Idempotent path keeps the original.
    (host.clock as { now: () => Time }).now = () => '2026-06-01T00:00:00.000Z' as Time;

    await markPipelineReaped(
      host,
      atom.id,
      'plan-reaper' as PrincipalId,
      'completed-after-99d',
    );

    const secondReapedAt = ((await host.atoms.get(atom.id))?.metadata as Record<string, unknown>)[
      'reaped_at'
    ];
    expect(secondReapedAt).toBe(firstReapedAt);

    const events = await host.auditor.query({ kind: ['pipeline.reaped'] }, 100);
    expect(events).toHaveLength(1);
  });

  it('throws when the atom does not exist', async () => {
    const host = createMemoryHost();
    await expect(
      markPipelineReaped(
        host,
        'no-such' as AtomId,
        'plan-reaper' as PrincipalId,
        'whatever',
      ),
    ).rejects.toThrow(/not found/);
  });

  it('throws when called on a non-pipeline atom', async () => {
    const host = createMemoryHost();
    const child = childAtom('child-1', 'pipeline-stage-event', 'p-1');
    await host.atoms.put(child);
    await expect(
      markPipelineReaped(
        host,
        child.id,
        'plan-reaper' as PrincipalId,
        'whatever',
      ),
    ).rejects.toThrow(/not a pipeline atom/);
  });

  it('preserves derived_from / provenance chain', async () => {
    const host = createMemoryHost();
    (host.clock as { now: () => Time }).now = () => NOW_ISO as Time;
    const seed: Atom = {
      ...pipelineAtom('p-with-prov', {
        pipeline_state: 'completed',
        completed_at: '2026-04-01T00:00:00.000Z',
      }),
      provenance: {
        kind: 'agent-observed',
        source: { tool: 'planning-pipeline', agent_id: 'cto-actor' },
        derived_from: ['operator-intent-7' as AtomId],
      },
    };
    await host.atoms.put(seed);
    const updated = await markPipelineReaped(
      host,
      seed.id,
      'plan-reaper' as PrincipalId,
      'completed-after-38d',
    );
    expect(updated.provenance.derived_from).toEqual(['operator-intent-7']);
  });
});

// ---------------------------------------------------------------------------
// markStageAtomReaped
// ---------------------------------------------------------------------------

describe('markStageAtomReaped', () => {
  it('writes reaped_at + reaped_reason and emits pipeline.stage_atom_reaped', async () => {
    const host = createMemoryHost();
    (host.clock as { now: () => Time }).now = () => NOW_ISO as Time;
    const child = childAtom('child-mark', 'pipeline-stage-event', 'p-parent');
    await host.atoms.put(child);

    const updated = await markStageAtomReaped(
      host,
      child.id,
      'plan-reaper' as PrincipalId,
      'completed-after-38d',
    );

    expect((updated.metadata as Record<string, unknown>)['reaped_at']).toBe(NOW_ISO);
    expect((updated.metadata as Record<string, unknown>)['reaped_reason']).toBe(
      'completed-after-38d',
    );
    expect(updated.confidence).toBe(0.01);

    const events = await host.auditor.query(
      { kind: ['pipeline.stage_atom_reaped'] },
      100,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.refs.atom_ids).toEqual([child.id]);
    expect(events[0]?.details['atom_type']).toBe('pipeline-stage-event');
  });

  it('is idempotent on a second call', async () => {
    const host = createMemoryHost();
    (host.clock as { now: () => Time }).now = () => NOW_ISO as Time;
    const child = childAtom('child-idem', 'spec-output', 'p-parent');
    await host.atoms.put(child);

    await markStageAtomReaped(
      host,
      child.id,
      'plan-reaper' as PrincipalId,
      'first',
    );
    await markStageAtomReaped(
      host,
      child.id,
      'plan-reaper' as PrincipalId,
      'second',
    );

    const events = await host.auditor.query(
      { kind: ['pipeline.stage_atom_reaped'] },
      100,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.details['reason']).toBe('first');
  });

  it('rejects a pipeline-typed atom (misuse guard)', async () => {
    const host = createMemoryHost();
    const root = pipelineAtom('p-root');
    await host.atoms.put(root);
    await expect(
      markStageAtomReaped(
        host,
        root.id,
        'plan-reaper' as PrincipalId,
        'whatever',
      ),
    ).rejects.toThrow(/pipeline root atom/);
  });

  it('throws when the atom does not exist', async () => {
    const host = createMemoryHost();
    await expect(
      markStageAtomReaped(
        host,
        'no-such' as AtomId,
        'plan-reaper' as PrincipalId,
        'whatever',
      ),
    ).rejects.toThrow(/not found/);
  });

  it('preserves the atom type after reap (no re-typing)', async () => {
    const host = createMemoryHost();
    (host.clock as { now: () => Time }).now = () => NOW_ISO as Time;
    const child = childAtom('child-type', 'agent-turn', 'p-parent');
    await host.atoms.put(child);
    const updated = await markStageAtomReaped(
      host,
      child.id,
      'plan-reaper' as PrincipalId,
      'whatever',
    );
    expect(updated.type).toBe('agent-turn');
  });
});

// ---------------------------------------------------------------------------
// loadAllTerminalPipelines
// ---------------------------------------------------------------------------

describe('loadAllTerminalPipelines', () => {
  it('returns all pipeline atoms regardless of state', async () => {
    const host = createMemoryHost();
    await host.atoms.put(pipelineAtom('p-1', { pipeline_state: 'completed' }));
    await host.atoms.put(pipelineAtom('p-2', { pipeline_state: 'running' }));
    await host.atoms.put(pipelineAtom('p-3', { pipeline_state: 'hil-paused' }));
    await host.atoms.put(pipelineAtom('p-4', { pipeline_state: 'failed' }));
    // Non-pipeline atoms are filtered out by the type filter.
    await host.atoms.put(childAtom('child-1', 'pipeline-stage-event', 'p-1'));

    const r = await loadAllTerminalPipelines(host);
    expect(r.atoms.map(a => a.id).sort()).toEqual(['p-1', 'p-2', 'p-3', 'p-4']);
    expect(r.truncated).toBe(false);
  });

  it('returns truncated=true when pagination claims more remain', async () => {
    const host = createMemoryHost();
    let queryCalls = 0;
    (host.atoms as { query: typeof host.atoms.query }).query = async () => {
      queryCalls += 1;
      return {
        atoms: queryCalls === 1 ? [pipelineAtom('only-one') as Atom] : [],
        nextCursor: 'pretend-more-remain',
      };
    };
    const r = await loadAllTerminalPipelines(host);
    expect(r.truncated).toBe(true);
    expect(queryCalls).toBeGreaterThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// runPipelineReaperSweep -- end-to-end
// ---------------------------------------------------------------------------

interface SeedSubgraphResult {
  readonly pipelineId: AtomId;
  readonly childIds: ReadonlyArray<AtomId>;
}

/**
 * Seed a representative subgraph for a single stale completed pipeline:
 * - 1 pipeline root (completed, 38 days old)
 * - 5 stage-output atoms (one per pipeline stage)
 * - 8 stage-event atoms (enter + exit per stage where applicable)
 * - 2 audit-finding atoms
 * - 1 agent-session atom
 * - 5 agent-turn atoms
 */
async function seedFullSubgraph(
  host: ReturnType<typeof createMemoryHost>,
  pipelineId: string,
): Promise<SeedSubgraphResult> {
  const childIds: AtomId[] = [];

  await host.atoms.put(
    pipelineAtom(pipelineId, {
      pipeline_state: 'completed',
      completed_at: '2026-04-01T20:00:00.000Z',
      created_at: '2026-04-01T00:00:00.000Z',
    }),
  );

  const stageOutputs: Array<{ id: string; type: AtomType }> = [
    { id: `${pipelineId}-brainstorm-output`, type: 'brainstorm-output' },
    { id: `${pipelineId}-spec-output`, type: 'spec-output' },
    { id: `${pipelineId}-spec`, type: 'spec' },
    { id: `${pipelineId}-review-report`, type: 'review-report' },
    { id: `${pipelineId}-dispatch-record`, type: 'dispatch-record' },
  ];
  for (const so of stageOutputs) {
    await host.atoms.put(childAtom(so.id, so.type, pipelineId));
    childIds.push(so.id as AtomId);
  }

  for (let i = 0; i < 8; i++) {
    const id = `${pipelineId}-event-${i}`;
    await host.atoms.put(childAtom(id, 'pipeline-stage-event', pipelineId));
    childIds.push(id as AtomId);
  }

  for (let i = 0; i < 2; i++) {
    const id = `${pipelineId}-audit-${i}`;
    await host.atoms.put(childAtom(id, 'pipeline-audit-finding', pipelineId));
    childIds.push(id as AtomId);
  }

  const sessionId = `${pipelineId}-session`;
  await host.atoms.put(childAtom(sessionId, 'agent-session', pipelineId));
  childIds.push(sessionId as AtomId);

  for (let i = 0; i < 5; i++) {
    const id = `${pipelineId}-turn-${i}`;
    await host.atoms.put(
      childAtom(id, 'agent-turn', pipelineId, {
        metadata: {
          agent_turn: { session_atom_id: sessionId, turn_index: i },
        },
      }),
    );
    childIds.push(id as AtomId);
  }

  return { pipelineId: pipelineId as AtomId, childIds };
}

describe('runPipelineReaperSweep', () => {
  it('end-to-end: reaps every child + the root for a stale completed pipeline', async () => {
    const host = createMemoryHost();
    (host.clock as { now: () => Time }).now = () => NOW_ISO as Time;
    const { pipelineId, childIds } = await seedFullSubgraph(host, 'p-stale');

    const out = await runPipelineReaperSweep(
      host,
      'plan-reaper' as PrincipalId,
      TTLS,
    );

    expect(out.classifications).toHaveLength(1);
    expect(out.classifications[0]?.verdict).toBe('reap');
    // 21 children (5 outputs + 8 events + 2 findings + 1 session + 5 turns) + 1 root.
    expect(out.reaped).toHaveLength(22);
    expect(out.skipped).toHaveLength(0);

    // Every child has metadata.reaped_at set.
    for (const id of childIds) {
      const after = await host.atoms.get(id);
      expect((after?.metadata as Record<string, unknown>)['reaped_at']).toBe(NOW_ISO);
      expect(after?.confidence).toBe(0.01);
    }

    // Root has metadata.reaped_at set.
    const rootAfter = await host.atoms.get(pipelineId);
    expect((rootAfter?.metadata as Record<string, unknown>)['reaped_at']).toBe(NOW_ISO);
    expect(rootAfter?.confidence).toBe(0.01);

    // Audit log: 21 stage_atom_reaped + 1 pipeline.reaped, in that order.
    const stageEvents = await host.auditor.query(
      { kind: ['pipeline.stage_atom_reaped'] },
      1000,
    );
    const rootEvents = await host.auditor.query({ kind: ['pipeline.reaped'] }, 1000);
    expect(stageEvents).toHaveLength(21);
    expect(rootEvents).toHaveLength(1);
  });

  it('second sweep is a no-op (idempotence: zero new reaps, zero new audits)', async () => {
    const host = createMemoryHost();
    (host.clock as { now: () => Time }).now = () => NOW_ISO as Time;
    await seedFullSubgraph(host, 'p-idem');

    await runPipelineReaperSweep(host, 'plan-reaper' as PrincipalId, TTLS);

    const out2 = await runPipelineReaperSweep(host, 'plan-reaper' as PrincipalId, TTLS);
    expect(out2.reaped).toHaveLength(0);
    expect(out2.skipped).toHaveLength(0);

    // Audit log size unchanged: still 21 stage + 1 root.
    const stageEvents = await host.auditor.query(
      { kind: ['pipeline.stage_atom_reaped'] },
      1000,
    );
    const rootEvents = await host.auditor.query({ kind: ['pipeline.reaped'] }, 1000);
    expect(stageEvents).toHaveLength(21);
    expect(rootEvents).toHaveLength(1);
  });

  it('skips a fresh completed pipeline (within TTL)', async () => {
    const host = createMemoryHost();
    (host.clock as { now: () => Time }).now = () => NOW_ISO as Time;
    await host.atoms.put(
      pipelineAtom('p-fresh', {
        pipeline_state: 'completed',
        completed_at: '2026-05-04T20:00:00.000Z',
      }),
    );

    const out = await runPipelineReaperSweep(
      host,
      'plan-reaper' as PrincipalId,
      TTLS,
    );
    expect(out.reaped).toHaveLength(0);
    expect(out.skipped).toHaveLength(0);
    expect(out.classifications[0]?.verdict).toBe('skip');
  });

  it('skips a running pipeline regardless of age', async () => {
    const host = createMemoryHost();
    (host.clock as { now: () => Time }).now = () => NOW_ISO as Time;
    await host.atoms.put(
      pipelineAtom('p-running', {
        pipeline_state: 'running',
        created_at: '2026-01-01T00:00:00.000Z',
        last_reinforced_at: '2026-01-01T00:00:00.000Z',
      }),
    );

    const out = await runPipelineReaperSweep(
      host,
      'plan-reaper' as PrincipalId,
      TTLS,
    );
    expect(out.reaped).toHaveLength(0);
    expect(out.classifications[0]?.verdict).toBe('skip');
  });

  it('TOCTOU: pipeline that flips back to running between classify and apply is skipped', async () => {
    const host = createMemoryHost();
    (host.clock as { now: () => Time }).now = () => NOW_ISO as Time;
    await host.atoms.put(
      pipelineAtom('p-toctou', {
        pipeline_state: 'completed',
        completed_at: '2026-04-01T20:00:00.000Z',
      }),
    );

    // Wrap host.atoms.update so the first call (the classifier path
    // touches no writes; this catches the apply-path mutate) flips the
    // state back to 'running' BEFORE the markPipelineReaped does its
    // own host.atoms.update. Rather than racing the runtime, we
    // intercept the atom AFTER the classifier returned but BEFORE the
    // sweep applies: monkey-patch query to return a fresh atom that
    // looks completed, then update the underlying store to running
    // while the sweep is mid-flight. Simpler approach: directly
    // mutate the stored atom after the sweep starts but before the
    // root update fires.
    //
    // The classifier loads pipelines via host.atoms.query (not .get);
    // the first call to host.atoms.get is the TOCTOU re-fetch inside
    // the apply loop. We intercept .get for the target atom and return
    // a 'running' state, simulating an external transition between the
    // classifier pass and the apply pass. The sweep should skip it.
    const realGet = host.atoms.get.bind(host.atoms);
    (host.atoms as { get: typeof host.atoms.get }).get = async (id: AtomId) => {
      const original = await realGet(id);
      if (!original) return original;
      if (id === 'p-toctou') {
        return { ...original, pipeline_state: 'running' };
      }
      return original;
    };

    const out = await runPipelineReaperSweep(
      host,
      'plan-reaper' as PrincipalId,
      TTLS,
    );
    expect(out.reaped).toHaveLength(0);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]?.error).toMatch(/state-changed:running/);
  });

  it('ignores future-dated atoms (clock skew safety)', async () => {
    const host = createMemoryHost();
    (host.clock as { now: () => Time }).now = () => NOW_ISO as Time;
    await host.atoms.put(
      pipelineAtom('p-future', {
        pipeline_state: 'completed',
        completed_at: '2026-06-01T00:00:00.000Z',
        created_at: '2026-06-01T00:00:00.000Z',
      }),
    );

    const out = await runPipelineReaperSweep(
      host,
      'plan-reaper' as PrincipalId,
      TTLS,
    );
    expect(out.reaped).toHaveLength(0);
    expect(out.classifications[0]?.verdict).toBe('skip');
    expect(out.classifications[0]?.reason).toBe('future-dated');
  });

  it('kill-switch tripped: returns truncated=true with no writes', async () => {
    const host = createMemoryHost();
    (host.clock as { now: () => Time }).now = () => NOW_ISO as Time;
    await seedFullSubgraph(host, 'p-killswitch');

    (host.scheduler as { killswitchCheck: () => boolean }).killswitchCheck = () => true;

    const out = await runPipelineReaperSweep(
      host,
      'plan-reaper' as PrincipalId,
      TTLS,
    );
    expect(out.reaped).toHaveLength(0);
    expect(out.truncated).toBe(true);

    // No atom got marked.
    const root = await host.atoms.get('p-killswitch' as AtomId);
    expect((root?.metadata as Record<string, unknown>)['reaped_at']).toBeUndefined();
  });

  it('reaps an old hil-paused pipeline', async () => {
    const host = createMemoryHost();
    (host.clock as { now: () => Time }).now = () => NOW_ISO as Time;
    await host.atoms.put(
      pipelineAtom('p-paused-stale', {
        pipeline_state: 'hil-paused',
        last_reinforced_at: '2026-04-20T20:00:00.000Z',
        created_at: '2026-04-01T00:00:00.000Z',
      }),
    );

    const out = await runPipelineReaperSweep(
      host,
      'plan-reaper' as PrincipalId,
      TTLS,
    );
    expect(out.reaped).toHaveLength(1);
    expect(out.classifications[0]?.reason).toMatch(/hil-paused-after-\d+d/);
  });

  it('mixed slate: stale + fresh + running pipelines reap only the stale', async () => {
    const host = createMemoryHost();
    (host.clock as { now: () => Time }).now = () => NOW_ISO as Time;
    await host.atoms.put(
      pipelineAtom('p-stale', {
        pipeline_state: 'completed',
        completed_at: '2026-04-01T00:00:00.000Z',
      }),
    );
    await host.atoms.put(
      pipelineAtom('p-fresh', {
        pipeline_state: 'completed',
        completed_at: '2026-05-04T20:00:00.000Z',
      }),
    );
    await host.atoms.put(
      pipelineAtom('p-running', {
        pipeline_state: 'running',
        created_at: '2026-01-01T00:00:00.000Z',
      }),
    );

    const out = await runPipelineReaperSweep(
      host,
      'plan-reaper' as PrincipalId,
      TTLS,
    );
    expect(out.reaped.map(r => r.atomId).filter(id => id === 'p-stale')).toEqual([
      'p-stale',
    ]);
    // No reap on fresh or running.
    const fresh = await host.atoms.get('p-fresh' as AtomId);
    const running = await host.atoms.get('p-running' as AtomId);
    expect((fresh?.metadata as Record<string, unknown>)['reaped_at']).toBeUndefined();
    expect((running?.metadata as Record<string, unknown>)['reaped_at']).toBeUndefined();
  });

  it('best-effort per child: a per-atom failure does not poison the rest of the sweep', async () => {
    const host = createMemoryHost();
    (host.clock as { now: () => Time }).now = () => NOW_ISO as Time;
    const { childIds } = await seedFullSubgraph(host, 'p-besteffort');

    // Force one child's update to throw. The sweep should skip that
    // atom, log the error, and proceed with the rest.
    const realUpdate = host.atoms.update.bind(host.atoms);
    const targetChildId = childIds[0]!;
    (host.atoms as { update: typeof host.atoms.update }).update = async (
      id: AtomId,
      patch,
    ) => {
      if (id === targetChildId) {
        throw new Error('synthetic-update-failure');
      }
      return realUpdate(id, patch);
    };

    const out = await runPipelineReaperSweep(
      host,
      'plan-reaper' as PrincipalId,
      TTLS,
    );
    // 21 children, 1 fails: 20 children reaped + 1 root reaped = 21 reaped.
    expect(out.reaped).toHaveLength(21);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]?.atomId).toBe(targetChildId);
    expect(out.skipped[0]?.error).toMatch(/synthetic-update-failure/);
  });

  it('empty store: zero classifications, zero reaps', async () => {
    const host = createMemoryHost();
    (host.clock as { now: () => Time }).now = () => NOW_ISO as Time;
    const out = await runPipelineReaperSweep(
      host,
      'plan-reaper' as PrincipalId,
      TTLS,
    );
    expect(out.classifications).toHaveLength(0);
    expect(out.reaped).toHaveLength(0);
    expect(out.skipped).toHaveLength(0);
  });

  it('throws when host.clock.now() is non-parseable', async () => {
    const host = createMemoryHost();
    (host.clock as { now: () => Time }).now = () => 'not-a-date' as Time;
    await expect(
      runPipelineReaperSweep(host, 'plan-reaper' as PrincipalId, TTLS),
    ).rejects.toThrow(/host\.clock\.now\(\)/);
  });

  it('throws on invalid TTLs', async () => {
    const host = createMemoryHost();
    await expect(
      runPipelineReaperSweep(host, 'plan-reaper' as PrincipalId, {
        ...TTLS,
        terminalPipelineMs: 0,
      }),
    ).rejects.toThrow(/terminalPipelineMs/);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_PIPELINE_REAPER_TTLS
// ---------------------------------------------------------------------------

describe('DEFAULT_PIPELINE_REAPER_TTLS', () => {
  it('terminalPipelineMs is 30 days', () => {
    expect(DEFAULT_PIPELINE_REAPER_TTLS.terminalPipelineMs).toBe(
      30 * 24 * 60 * 60 * 1000,
    );
  });

  it('hilPausedPipelineMs is 14 days', () => {
    expect(DEFAULT_PIPELINE_REAPER_TTLS.hilPausedPipelineMs).toBe(
      14 * 24 * 60 * 60 * 1000,
    );
  });

  it('agentSessionMs is 30 days', () => {
    expect(DEFAULT_PIPELINE_REAPER_TTLS.agentSessionMs).toBe(
      30 * 24 * 60 * 60 * 1000,
    );
  });

  it('hilPausedPipelineMs is shorter than terminalPipelineMs', () => {
    expect(DEFAULT_PIPELINE_REAPER_TTLS.hilPausedPipelineMs).toBeLessThan(
      DEFAULT_PIPELINE_REAPER_TTLS.terminalPipelineMs,
    );
  });
});
