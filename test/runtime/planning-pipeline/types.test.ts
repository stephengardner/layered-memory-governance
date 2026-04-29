import { describe, expect, it } from 'vitest';
import type {
  PlanningStage,
  StageInput,
  StageOutput,
  AuditFinding,
  RetryStrategy,
} from '../../../src/runtime/planning-pipeline/types.js';
import * as PipelineExports from '../../../src/runtime/planning-pipeline/index.js';

describe('PlanningStage type', () => {
  it('compiles a minimal stage', () => {
    const stage: PlanningStage<{ in: number }, { out: string }> = {
      name: 'noop-stage',
      async run(input: StageInput<{ in: number }>): Promise<StageOutput<{ out: string }>> {
        return {
          value: { out: String(input.priorOutput.in) },
          cost_usd: 0,
          duration_ms: 0,
          atom_type: 'spec',
        };
      },
    };
    expect(stage.name).toBe('noop-stage');
  });

  it('AuditFinding severity is constrained at the type level', () => {
    const finding: AuditFinding = {
      severity: 'critical',
      category: 'cite-fail',
      message: 'x',
      cited_atom_ids: [],
      cited_paths: [],
    };
    expect(finding.severity).toBe('critical');
  });

  it('RetryStrategy discriminated union covers no-retry vs with-jitter', () => {
    const a: RetryStrategy = { kind: 'no-retry' };
    const b: RetryStrategy = { kind: 'with-jitter', max_attempts: 3, base_delay_ms: 500 };
    expect(a.kind).toBe('no-retry');
    expect(b.kind).toBe('with-jitter');
  });
});

describe('planning-pipeline barrel', () => {
  it('exports the public surface', () => {
    expect(typeof PipelineExports.runPipeline).toBe('function');
    expect(typeof PipelineExports.mkPipelineAtom).toBe('function');
    expect(typeof PipelineExports.mkPipelineStageEventAtom).toBe('function');
    expect(typeof PipelineExports.readPipelineStagesPolicy).toBe('function');
  });
});
