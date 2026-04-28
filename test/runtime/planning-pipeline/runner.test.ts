import { describe, expect, it, vi } from 'vitest';
import { runPipeline } from '../../../src/runtime/planning-pipeline/runner.js';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import type { PlanningStage } from '../../../src/runtime/planning-pipeline/types.js';
import type { AtomId, PrincipalId, Time } from '../../../src/types.js';

const NOW = '2026-04-28T12:00:00.000Z' as Time;

function mkStage<TIn, TOut>(
  name: string,
  runFn: (i: TIn) => TOut,
  atomType = 'spec',
): PlanningStage<TIn, TOut> {
  return {
    name,
    async run(input) {
      return {
        value: runFn(input.priorOutput),
        cost_usd: 0,
        duration_ms: 0,
        atom_type: atomType,
      };
    },
  };
}

describe('runPipeline', () => {
  it('advances pending -> running -> completed through linear stages', async () => {
    const host = createMemoryHost();
    const stages = [
      mkStage<unknown, { a: number }>('stage-a', () => ({ a: 1 })),
      mkStage<{ a: number }, { b: number }>('stage-b', (i) => ({ b: i.a + 1 })),
    ];
    const result = await runPipeline(stages, host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-1',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('completed');
    if (result.kind === 'completed') {
      expect(result.pipelineId).toBeDefined();
    }
  });

  it('halts on kill-switch before the first stage', async () => {
    const host = createMemoryHost();
    vi.spyOn(host.scheduler, 'killswitchCheck').mockReturnValue(true);
    const stages = [mkStage<unknown, unknown>('stage-a', () => ({}))];
    const result = await runPipeline(stages, host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-2',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('halted');
  });

  it('writes pipeline-failed atom when a stage throws', async () => {
    const host = createMemoryHost();
    const failingStage: PlanningStage<unknown, unknown> = {
      name: 'fail-stage',
      async run() {
        throw new Error('boom');
      },
    };
    const result = await runPipeline([failingStage], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-3',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.failedStageName).toBe('fail-stage');
    }
  });

  it('halts on critical audit finding', async () => {
    const host = createMemoryHost();
    const auditedStage: PlanningStage<unknown, { x: number }> = {
      name: 'audited-stage',
      async run() {
        return { value: { x: 1 }, cost_usd: 0, duration_ms: 0, atom_type: 'spec' };
      },
      async audit() {
        return [
          {
            severity: 'critical',
            category: 'cite-fail',
            message: 'fabricated path',
            cited_atom_ids: [],
            cited_paths: ['nope.ts'],
          },
        ];
      },
    };
    const result = await runPipeline([auditedStage], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-4',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('failed');
  });

  it('rejects stage output whose cost_usd exceeds budget_cap_usd', async () => {
    const host = createMemoryHost();
    const expensiveStage: PlanningStage<unknown, unknown> = {
      name: 'expensive-stage',
      budget_cap_usd: 1.0,
      async run() {
        return { value: {}, cost_usd: 50.0, duration_ms: 0, atom_type: 'spec' };
      },
    };
    const result = await runPipeline([expensiveStage], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-5',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.cause).toMatch(/budget/);
  });

  it('emits a pipeline-stage-event atom per state transition', async () => {
    const host = createMemoryHost();
    const stages = [
      mkStage<unknown, unknown>('a', () => ({})),
      mkStage<unknown, unknown>('b', () => ({})),
    ];
    await runPipeline(stages, host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-6',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    const page = await host.atoms.query({ type: ['pipeline-stage-event'] }, 100);
    expect(page.atoms.length).toBeGreaterThanOrEqual(4);
  });
});
