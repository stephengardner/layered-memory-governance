import { describe, it, expect } from 'vitest';
import { auditPipeline } from '../../scripts/lib/audit-pipeline-core.mjs';

interface FixtureAtom {
  readonly atom_id: string;
  readonly atom_type: string;
  readonly pipeline_id: string;
  readonly timestamp: string;
}

interface FixtureAdapter {
  query(args: { atom_type: string; pipeline_id: string }): Promise<ReadonlyArray<FixtureAtom>>;
}

function makeAdapter(atoms: ReadonlyArray<FixtureAtom>): FixtureAdapter {
  return {
    async query({ atom_type, pipeline_id }) {
      return atoms.filter(
        (a) => a.atom_type === atom_type && a.pipeline_id === pipeline_id,
      );
    },
  };
}

describe('auditPipeline', () => {
  it('reports no atoms for an empty pipeline', async () => {
    const adapter = makeAdapter([]);
    const result = await auditPipeline({ adapter, pipelineId: 'pipeline-empty' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No atoms found for pipeline-id pipeline-empty');
    expect(result.stderr).toBe('');
  });

  it('renders a tree with five (empty) stages when only operator-intent is present', async () => {
    const pipelineId = 'pipeline-single';
    const adapter = makeAdapter([
      {
        atom_id: 'intent-1',
        atom_type: 'operator-intent',
        pipeline_id: pipelineId,
        timestamp: '2026-05-08T22:00:00.000Z',
      },
    ]);
    const result = await auditPipeline({ adapter, pipelineId });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('operator-intent');
    expect(result.stdout).toContain('intent-1');
    expect(result.stdout).toContain('brainstorm-output (empty)');
    expect(result.stdout).toContain('spec-output (empty)');
    expect(result.stdout).toContain('plan-output (empty)');
    expect(result.stdout).toContain('review-output (empty)');
    expect(result.stdout).toContain('dispatch-output (empty)');
  });

  it('renders all six stages with leaves sorted by ascending timestamp', async () => {
    const pipelineId = 'pipeline-full';
    const atoms: ReadonlyArray<FixtureAtom> = [
      { atom_id: 'intent-1',     atom_type: 'operator-intent',    pipeline_id: pipelineId, timestamp: '2026-05-08T22:00:00.000Z' },
      { atom_id: 'brainstorm-1', atom_type: 'brainstorm-output',  pipeline_id: pipelineId, timestamp: '2026-05-08T22:01:00.000Z' },
      { atom_id: 'spec-1',       atom_type: 'spec-output',        pipeline_id: pipelineId, timestamp: '2026-05-08T22:02:00.000Z' },
      { atom_id: 'plan-1',       atom_type: 'plan-output',        pipeline_id: pipelineId, timestamp: '2026-05-08T22:03:00.000Z' },
      { atom_id: 'review-2',     atom_type: 'review-output',      pipeline_id: pipelineId, timestamp: '2026-05-08T22:05:00.000Z' },
      { atom_id: 'review-1',     atom_type: 'review-output',      pipeline_id: pipelineId, timestamp: '2026-05-08T22:04:00.000Z' },
      { atom_id: 'dispatch-1',   atom_type: 'dispatch-output',    pipeline_id: pipelineId, timestamp: '2026-05-08T22:06:00.000Z' },
    ];
    const result = await auditPipeline({ adapter: makeAdapter(atoms), pipelineId });
    expect(result.exitCode).toBe(0);
    for (const stage of [
      'operator-intent',
      'brainstorm-output',
      'spec-output',
      'plan-output',
      'review-output',
      'dispatch-output',
    ]) {
      expect(result.stdout).toContain(stage);
      expect(result.stdout).not.toContain(`${stage} (empty)`);
    }
    for (const a of atoms) {
      expect(result.stdout).toContain(a.atom_id);
      expect(result.stdout).toContain(a.timestamp);
    }
    const review1Idx = result.stdout.indexOf('review-1');
    const review2Idx = result.stdout.indexOf('review-2');
    expect(review1Idx).toBeGreaterThan(-1);
    expect(review2Idx).toBeGreaterThan(-1);
    expect(review1Idx).toBeLessThan(review2Idx);
  });
});
