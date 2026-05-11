import { describe, it, expect } from 'vitest';
import {
  buildResumeAtomId,
  pickPipelineAtom,
  resolveAllowedResumers,
  resolvePausedStageName,
  validateResumeRequest,
  type PipelineResumeSourceAtom,
} from './pipeline-resume';

/*
 * Unit tests for the pipeline-resume pure helpers.
 *
 * Pure-helper tests: feed atoms, assert the tagged-union return value.
 * No I/O, no time, no globals. Mirrors the test pattern in
 * intent-outcome.test.ts and pipelines.test.ts.
 *
 * Coverage focus: every rung in the validateResumeRequest ladder
 * (not-found / not-paused / no-stage / no-policy / forbidden / ok)
 * plus the substrate-parity rungs (tainted, superseded canon, and
 * superseded pipeline atoms must not authorize a state flip).
 */

function atom(
  partial: Partial<PipelineResumeSourceAtom> & {
    id: string;
    type: string;
    created_at: string;
  },
): PipelineResumeSourceAtom {
  return {
    content: '',
    principal_id: 'cto-actor',
    metadata: {},
    taint: 'clean',
    ...partial,
  };
}

function pipeline(opts: {
  id: string;
  state: string;
  created_at?: string;
  superseded_by?: ReadonlyArray<string>;
  taint?: string;
}): PipelineResumeSourceAtom {
  return atom({
    id: opts.id,
    type: 'pipeline',
    created_at: opts.created_at ?? '2026-05-10T10:00:00.000Z',
    pipeline_state: opts.state,
    ...(opts.superseded_by !== undefined ? { superseded_by: opts.superseded_by } : {}),
    ...(opts.taint !== undefined ? { taint: opts.taint } : {}),
  });
}

function pauseEvent(opts: {
  pipelineId: string;
  stageName: string;
  at: string;
}): PipelineResumeSourceAtom {
  return atom({
    id: `pipeline-stage-event-${opts.pipelineId}-${opts.stageName}-hil-pause-corr`,
    type: 'pipeline-stage-event',
    created_at: opts.at,
    metadata: {
      pipeline_id: opts.pipelineId,
      stage_name: opts.stageName,
      transition: 'hil-pause',
    },
  });
}

function hilPolicy(opts: {
  stageName: string;
  allowed: ReadonlyArray<string>;
  superseded_by?: ReadonlyArray<string>;
  taint?: string;
}): PipelineResumeSourceAtom {
  return atom({
    id: `pol-pipeline-stage-hil-${opts.stageName}`,
    type: 'directive',
    created_at: '2026-04-28T12:00:00.000Z',
    ...(opts.superseded_by !== undefined ? { superseded_by: opts.superseded_by } : {}),
    ...(opts.taint !== undefined ? { taint: opts.taint } : {}),
    metadata: {
      policy: {
        subject: 'pipeline-stage-hil',
        stage_name: opts.stageName,
        pause_mode: 'on-critical-finding',
        auto_resume_after_ms: null,
        allowed_resumers: [...opts.allowed],
      },
    },
  });
}

describe('resolvePausedStageName', () => {
  it('returns null when no hil-pause event exists for the pipeline', () => {
    const atoms = [
      pipeline({ id: 'pipeline-x', state: 'hil-paused' }),
    ];
    expect(resolvePausedStageName(atoms, 'pipeline-x')).toBeNull();
  });

  it('returns the stage name from the only hil-pause event', () => {
    const atoms = [
      pipeline({ id: 'pipeline-x', state: 'hil-paused' }),
      pauseEvent({ pipelineId: 'pipeline-x', stageName: 'spec-stage', at: '2026-05-10T10:05:00.000Z' }),
    ];
    expect(resolvePausedStageName(atoms, 'pipeline-x')).toBe('spec-stage');
  });

  it('returns the latest stage when multiple hil-pause events exist (resume then re-pause)', () => {
    const atoms = [
      pauseEvent({ pipelineId: 'pipeline-x', stageName: 'spec-stage', at: '2026-05-10T10:00:00.000Z' }),
      pauseEvent({ pipelineId: 'pipeline-x', stageName: 'plan-stage', at: '2026-05-10T11:00:00.000Z' }),
    ];
    expect(resolvePausedStageName(atoms, 'pipeline-x')).toBe('plan-stage');
  });

  it('ignores tainted hil-pause events', () => {
    const atoms = [
      pauseEvent({ pipelineId: 'pipeline-x', stageName: 'spec-stage', at: '2026-05-10T10:00:00.000Z' }),
    ];
    atoms[0]!.metadata!['pipeline_id'] = 'pipeline-x';
    // Manually taint the event
    const tainted = { ...atoms[0]!, taint: 'compromised' };
    expect(resolvePausedStageName([tainted], 'pipeline-x')).toBeNull();
  });

  it('ignores events from a different pipeline', () => {
    const atoms = [
      pauseEvent({ pipelineId: 'pipeline-y', stageName: 'spec-stage', at: '2026-05-10T10:00:00.000Z' }),
    ];
    expect(resolvePausedStageName(atoms, 'pipeline-x')).toBeNull();
  });
});

describe('resolveAllowedResumers', () => {
  it('returns null when no canon policy atom exists for the stage', () => {
    expect(resolveAllowedResumers([], 'spec-stage')).toBeNull();
  });

  it('returns the allowed_resumers list from the matching policy atom', () => {
    const atoms = [
      hilPolicy({ stageName: 'spec-stage', allowed: ['apex-agent'] }),
    ];
    expect(resolveAllowedResumers(atoms, 'spec-stage')).toEqual(['apex-agent']);
  });

  it('returns an empty array when allowed_resumers is missing or malformed', () => {
    const malformed = atom({
      id: 'pol-pipeline-stage-hil-spec-stage',
      type: 'directive',
      created_at: '2026-04-28T12:00:00.000Z',
      metadata: {
        policy: {
          subject: 'pipeline-stage-hil',
          stage_name: 'spec-stage',
          // allowed_resumers omitted -- the empty-default falls through
        },
      },
    });
    expect(resolveAllowedResumers([malformed], 'spec-stage')).toEqual([]);
  });

  it('ignores superseded canon atoms', () => {
    const atoms = [
      hilPolicy({
        stageName: 'spec-stage',
        allowed: ['apex-agent'],
        superseded_by: ['pol-pipeline-stage-hil-spec-stage-v2'],
      }),
    ];
    expect(resolveAllowedResumers(atoms, 'spec-stage')).toBeNull();
  });

  it('ignores tainted canon atoms', () => {
    const atoms = [
      hilPolicy({ stageName: 'spec-stage', allowed: ['apex-agent'], taint: 'compromised' }),
    ];
    expect(resolveAllowedResumers(atoms, 'spec-stage')).toBeNull();
  });

  it('returns the right list when policies exist for multiple stages', () => {
    const atoms = [
      hilPolicy({ stageName: 'spec-stage', allowed: ['apex-agent'] }),
      hilPolicy({ stageName: 'plan-stage', allowed: ['apex-agent', 'review-bot'] }),
    ];
    expect(resolveAllowedResumers(atoms, 'plan-stage')).toEqual(['apex-agent', 'review-bot']);
  });
});

describe('pickPipelineAtom', () => {
  it('returns null when no pipeline atom with the id exists', () => {
    expect(pickPipelineAtom([], 'pipeline-x')).toBeNull();
  });

  it('returns the matching pipeline atom', () => {
    const p = pipeline({ id: 'pipeline-x', state: 'running' });
    expect(pickPipelineAtom([p], 'pipeline-x')).toBe(p);
  });

  it('ignores tainted pipeline atoms', () => {
    const p = pipeline({ id: 'pipeline-x', state: 'hil-paused', taint: 'compromised' });
    expect(pickPipelineAtom([p], 'pipeline-x')).toBeNull();
  });

  it('ignores superseded pipeline atoms', () => {
    const p = pipeline({ id: 'pipeline-x', state: 'hil-paused', superseded_by: ['pipeline-x-v2'] });
    expect(pickPipelineAtom([p], 'pipeline-x')).toBeNull();
  });
});

describe('validateResumeRequest', () => {
  it('returns not-found when the pipeline atom is missing', () => {
    const result = validateResumeRequest([], { pipelineId: 'pipeline-x', resumerPrincipalId: 'apex-agent' });
    expect(result).toEqual({ kind: 'not-found' });
  });

  it('returns not-paused when the pipeline is running', () => {
    const atoms = [pipeline({ id: 'pipeline-x', state: 'running' })];
    const result = validateResumeRequest(atoms, { pipelineId: 'pipeline-x', resumerPrincipalId: 'apex-agent' });
    expect(result).toEqual({ kind: 'not-paused', pipelineState: 'running' });
  });

  it('returns not-paused when the pipeline is completed', () => {
    const atoms = [pipeline({ id: 'pipeline-x', state: 'completed' })];
    const result = validateResumeRequest(atoms, { pipelineId: 'pipeline-x', resumerPrincipalId: 'apex-agent' });
    expect(result).toEqual({ kind: 'not-paused', pipelineState: 'completed' });
  });

  it('returns no-stage when paused but no hil-pause event resolves', () => {
    const atoms = [pipeline({ id: 'pipeline-x', state: 'hil-paused' })];
    const result = validateResumeRequest(atoms, { pipelineId: 'pipeline-x', resumerPrincipalId: 'apex-agent' });
    expect(result).toEqual({ kind: 'no-stage' });
  });

  it('returns no-policy when the canon entry for the paused stage is missing', () => {
    const atoms = [
      pipeline({ id: 'pipeline-x', state: 'hil-paused' }),
      pauseEvent({ pipelineId: 'pipeline-x', stageName: 'spec-stage', at: '2026-05-10T10:00:00.000Z' }),
    ];
    const result = validateResumeRequest(atoms, { pipelineId: 'pipeline-x', resumerPrincipalId: 'apex-agent' });
    expect(result).toEqual({ kind: 'no-policy', stageName: 'spec-stage' });
  });

  it('returns forbidden when caller is not in allowed_resumers', () => {
    const atoms = [
      pipeline({ id: 'pipeline-x', state: 'hil-paused' }),
      pauseEvent({ pipelineId: 'pipeline-x', stageName: 'spec-stage', at: '2026-05-10T10:00:00.000Z' }),
      hilPolicy({ stageName: 'spec-stage', allowed: ['apex-agent'] }),
    ];
    const result = validateResumeRequest(atoms, { pipelineId: 'pipeline-x', resumerPrincipalId: 'random-bot' });
    expect(result).toEqual({
      kind: 'forbidden',
      stageName: 'spec-stage',
      allowedResumers: ['apex-agent'],
    });
  });

  it('returns ok when paused, stage resolves, and caller is allowed', () => {
    const atoms = [
      pipeline({ id: 'pipeline-x', state: 'hil-paused' }),
      pauseEvent({ pipelineId: 'pipeline-x', stageName: 'spec-stage', at: '2026-05-10T10:00:00.000Z' }),
      hilPolicy({ stageName: 'spec-stage', allowed: ['apex-agent', 'ops-bot'] }),
    ];
    const result = validateResumeRequest(atoms, { pipelineId: 'pipeline-x', resumerPrincipalId: 'apex-agent' });
    expect(result).toEqual({
      kind: 'ok',
      stageName: 'spec-stage',
      allowedResumers: ['apex-agent', 'ops-bot'],
    });
  });

  it('returns no-policy when canon is superseded (substrate parity)', () => {
    const atoms = [
      pipeline({ id: 'pipeline-x', state: 'hil-paused' }),
      pauseEvent({ pipelineId: 'pipeline-x', stageName: 'spec-stage', at: '2026-05-10T10:00:00.000Z' }),
      hilPolicy({
        stageName: 'spec-stage',
        allowed: ['apex-agent'],
        superseded_by: ['pol-pipeline-stage-hil-spec-stage-v2'],
      }),
    ];
    const result = validateResumeRequest(atoms, { pipelineId: 'pipeline-x', resumerPrincipalId: 'apex-agent' });
    expect(result).toEqual({ kind: 'no-policy', stageName: 'spec-stage' });
  });
});

describe('buildResumeAtomId', () => {
  it('produces the substrate-compatible atom id format', () => {
    const id = buildResumeAtomId({
      pipelineId: 'pipeline-cto-1234',
      stageName: 'spec-stage',
      correlationId: 'console-resume-9876',
    });
    expect(id).toBe('pipeline-resume-pipeline-cto-1234-spec-stage-console-resume-9876');
  });

  it('is deterministic given the same inputs', () => {
    const inputs = { pipelineId: 'p-1', stageName: 'plan-stage', correlationId: 'c-1' };
    expect(buildResumeAtomId(inputs)).toBe(buildResumeAtomId(inputs));
  });
});
