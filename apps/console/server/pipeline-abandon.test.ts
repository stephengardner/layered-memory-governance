import { describe, it, expect } from 'vitest';
import {
  buildAbandonAtomId,
  buildPipelineAbandonedAtom,
  pickPipelineAtom,
  REASON_MAX_LENGTH,
  REASON_MIN_LENGTH,
  resolveAllowedAbandoners,
  validatePipelineAbandonInput,
  validateReason,
  type PipelineAbandonSourceAtom,
} from './pipeline-abandon';

/*
 * Unit tests for the pipeline-abandon pure helpers.
 *
 * Pure-helper tests: feed atoms, assert the tagged-union return value.
 * No I/O, no time, no globals. Mirrors the test pattern in
 * pipeline-resume.test.ts and intent-outcome.test.ts.
 *
 * Coverage focus: every rung in the validatePipelineAbandonInput
 * ladder (not-found / already-terminal / no-policy / forbidden / reason
 * gates / ok) plus the substrate-parity rungs (tainted, superseded
 * canon, and superseded pipeline atoms must not authorize a state
 * flip) plus the layer-floor regression mirroring CR PR #396.
 */

function atom(
  partial: Partial<PipelineAbandonSourceAtom> & {
    id: string;
    type: string;
    created_at: string;
  },
): PipelineAbandonSourceAtom {
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
}): PipelineAbandonSourceAtom {
  return atom({
    id: opts.id,
    type: 'pipeline',
    created_at: opts.created_at ?? '2026-05-10T10:00:00.000Z',
    pipeline_state: opts.state,
    ...(opts.superseded_by !== undefined ? { superseded_by: opts.superseded_by } : {}),
    ...(opts.taint !== undefined ? { taint: opts.taint } : {}),
  });
}

function abandonPolicy(opts: {
  allowed: ReadonlyArray<string>;
  layer?: string;
  superseded_by?: ReadonlyArray<string>;
  taint?: string;
}): PipelineAbandonSourceAtom {
  return atom({
    id: 'pol-pipeline-abandon',
    type: 'directive',
    /*
     * Default layer to L3 so the common-case fixture matches canon's
     * shape. Tests that exercise the layer-floor regression (an L0/L1
     * directive must NOT satisfy the abandon gate) override this
     * explicitly.
     */
    layer: opts.layer ?? 'L3',
    created_at: '2026-04-28T12:00:00.000Z',
    ...(opts.superseded_by !== undefined ? { superseded_by: opts.superseded_by } : {}),
    ...(opts.taint !== undefined ? { taint: opts.taint } : {}),
    metadata: {
      policy: {
        subject: 'pipeline-abandon',
        allowed_principals: [...opts.allowed],
      },
    },
  });
}

const VALID_REASON = 'User decided the dispatched plan was wrong; abandoning before next stage runs';

describe('validateReason', () => {
  it('returns reason-missing when reason is undefined', () => {
    expect(validateReason(undefined)).toEqual({ kind: 'reason-missing' });
  });

  it('returns reason-missing when reason is null', () => {
    expect(validateReason(null)).toEqual({ kind: 'reason-missing' });
  });

  it('returns reason-missing when reason is empty string', () => {
    expect(validateReason('')).toEqual({ kind: 'reason-missing' });
  });

  it('returns reason-missing when reason is only whitespace', () => {
    expect(validateReason('          ')).toEqual({ kind: 'reason-missing' });
  });

  it('returns reason-missing when reason is not a string', () => {
    expect(validateReason(42)).toEqual({ kind: 'reason-missing' });
  });

  it('returns reason-too-short when reason length is below floor', () => {
    expect(validateReason('too short')).toEqual({
      kind: 'reason-too-short',
      length: 9,
      min: REASON_MIN_LENGTH,
    });
  });

  it('returns reason-too-long when reason length exceeds cap', () => {
    const long = 'a'.repeat(REASON_MAX_LENGTH + 1);
    expect(validateReason(long)).toEqual({
      kind: 'reason-too-long',
      length: long.length,
      max: REASON_MAX_LENGTH,
    });
  });

  it('returns ok with trimmed reason on the happy path', () => {
    expect(validateReason(VALID_REASON)).toEqual({ kind: 'ok', trimmed: VALID_REASON });
  });

  it('trims leading and trailing whitespace before counting', () => {
    /*
     * A reason of exactly REASON_MIN_LENGTH chars after trim must pass.
     * "1234567890" is 10 chars; padded with whitespace it must still
     * count as 10 characters of real content.
     */
    expect(validateReason('   1234567890   ')).toEqual({ kind: 'ok', trimmed: '1234567890' });
  });
});

describe('resolveAllowedAbandoners', () => {
  it('returns null when no canon policy atom exists', () => {
    expect(resolveAllowedAbandoners([])).toBeNull();
  });

  it('returns the allowed_principals list from the matching policy atom', () => {
    const atoms = [abandonPolicy({ allowed: ['apex-agent'] })];
    expect(resolveAllowedAbandoners(atoms)).toEqual(['apex-agent']);
  });

  it('returns an empty array when allowed_principals is malformed', () => {
    const malformed = atom({
      id: 'pol-pipeline-abandon',
      type: 'directive',
      layer: 'L3',
      created_at: '2026-04-28T12:00:00.000Z',
      metadata: {
        policy: {
          subject: 'pipeline-abandon',
          // allowed_principals not an array
          allowed_principals: 'apex-agent',
        },
      },
    });
    expect(resolveAllowedAbandoners([malformed])).toEqual([]);
  });

  it('ignores superseded canon atoms', () => {
    const atoms = [
      abandonPolicy({
        allowed: ['apex-agent'],
        superseded_by: ['pol-pipeline-abandon-v2'],
      }),
    ];
    expect(resolveAllowedAbandoners(atoms)).toBeNull();
  });

  it('ignores tainted canon atoms', () => {
    const atoms = [
      abandonPolicy({ allowed: ['apex-agent'], taint: 'compromised' }),
    ];
    expect(resolveAllowedAbandoners(atoms)).toBeNull();
  });

  /*
   * Layer-floor regression: only L3 canon atoms can authorize an
   * abandon. Without this floor, any principal with write access to
   * the atom store could mint a directive at L0 that adds itself to
   * `allowed_principals` and bypass canon governance entirely.
   * Cited by CR PR #396 as a critical finding; mirrored here.
   */
  it('ignores directives below L3 (L0 proposal cannot satisfy the gate)', () => {
    const atoms = [abandonPolicy({ allowed: ['rogue-bot'], layer: 'L0' })];
    expect(resolveAllowedAbandoners(atoms)).toBeNull();
  });

  it('ignores directives below L3 (L1 working set cannot satisfy the gate)', () => {
    const atoms = [abandonPolicy({ allowed: ['rogue-bot'], layer: 'L1' })];
    expect(resolveAllowedAbandoners(atoms)).toBeNull();
  });

  it('ignores directives without a layer field (defensive fail-closed)', () => {
    /*
     * Build a directive atom with no layer at all -- legacy fixtures or
     * a forward-compat schema migration could surface this shape; the
     * resolver must fail closed rather than treat undefined as L3.
     */
    const atomWithoutLayer = atom({
      id: 'pol-pipeline-abandon',
      type: 'directive',
      created_at: '2026-04-28T12:00:00.000Z',
      metadata: {
        policy: {
          subject: 'pipeline-abandon',
          allowed_principals: ['rogue-bot'],
        },
      },
    });
    expect(resolveAllowedAbandoners([atomWithoutLayer])).toBeNull();
  });

  it('picks the L3 policy when both L3 and L1 exist', () => {
    const atoms = [
      abandonPolicy({ allowed: ['rogue-bot'], layer: 'L1' }),
      abandonPolicy({ allowed: ['apex-agent'], layer: 'L3' }),
    ];
    expect(resolveAllowedAbandoners(atoms)).toEqual(['apex-agent']);
  });

  it('ignores directives whose policy.subject does not match', () => {
    const offSubject = atom({
      id: 'pol-pipeline-stage-hil-spec-stage',
      type: 'directive',
      layer: 'L3',
      created_at: '2026-04-28T12:00:00.000Z',
      metadata: {
        policy: {
          subject: 'pipeline-stage-hil',
          allowed_principals: ['apex-agent'],
        },
      },
    });
    expect(resolveAllowedAbandoners([offSubject])).toBeNull();
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
    const p = pipeline({ id: 'pipeline-x', state: 'running', taint: 'compromised' });
    expect(pickPipelineAtom([p], 'pipeline-x')).toBeNull();
  });

  it('ignores superseded pipeline atoms', () => {
    const p = pipeline({ id: 'pipeline-x', state: 'running', superseded_by: ['pipeline-x-v2'] });
    expect(pickPipelineAtom([p], 'pipeline-x')).toBeNull();
  });
});

describe('validatePipelineAbandonInput', () => {
  it('rejects with reason-missing when reason is absent', () => {
    const result = validatePipelineAbandonInput([], {
      pipelineId: 'pipeline-x',
      abandonerPrincipalId: 'apex-agent',
      reason: undefined,
    });
    expect(result).toEqual({ kind: 'reason-missing' });
  });

  it('rejects with reason-too-short when reason is below the floor', () => {
    const result = validatePipelineAbandonInput([], {
      pipelineId: 'pipeline-x',
      abandonerPrincipalId: 'apex-agent',
      reason: 'too short',
    });
    expect(result).toEqual({
      kind: 'reason-too-short',
      length: 9,
      min: REASON_MIN_LENGTH,
    });
  });

  it('rejects with reason-too-long when reason exceeds the cap', () => {
    const long = 'a'.repeat(REASON_MAX_LENGTH + 1);
    const result = validatePipelineAbandonInput([], {
      pipelineId: 'pipeline-x',
      abandonerPrincipalId: 'apex-agent',
      reason: long,
    });
    expect(result).toEqual({
      kind: 'reason-too-long',
      length: long.length,
      max: REASON_MAX_LENGTH,
    });
  });

  it('returns not-found when the pipeline atom is missing', () => {
    const result = validatePipelineAbandonInput([], {
      pipelineId: 'pipeline-x',
      abandonerPrincipalId: 'apex-agent',
      reason: VALID_REASON,
    });
    expect(result).toEqual({ kind: 'not-found' });
  });

  it('returns already-terminal when pipeline is abandoned', () => {
    const atoms = [pipeline({ id: 'pipeline-x', state: 'abandoned' })];
    const result = validatePipelineAbandonInput(atoms, {
      pipelineId: 'pipeline-x',
      abandonerPrincipalId: 'apex-agent',
      reason: VALID_REASON,
    });
    expect(result).toEqual({ kind: 'already-terminal', pipelineState: 'abandoned' });
  });

  it('returns already-terminal when pipeline is completed', () => {
    const atoms = [pipeline({ id: 'pipeline-x', state: 'completed' })];
    const result = validatePipelineAbandonInput(atoms, {
      pipelineId: 'pipeline-x',
      abandonerPrincipalId: 'apex-agent',
      reason: VALID_REASON,
    });
    expect(result).toEqual({ kind: 'already-terminal', pipelineState: 'completed' });
  });

  it('returns already-terminal when pipeline is failed', () => {
    const atoms = [pipeline({ id: 'pipeline-x', state: 'failed' })];
    const result = validatePipelineAbandonInput(atoms, {
      pipelineId: 'pipeline-x',
      abandonerPrincipalId: 'apex-agent',
      reason: VALID_REASON,
    });
    expect(result).toEqual({ kind: 'already-terminal', pipelineState: 'failed' });
  });

  it('returns no-policy when canon entry is missing', () => {
    const atoms = [pipeline({ id: 'pipeline-x', state: 'running' })];
    const result = validatePipelineAbandonInput(atoms, {
      pipelineId: 'pipeline-x',
      abandonerPrincipalId: 'apex-agent',
      reason: VALID_REASON,
    });
    expect(result).toEqual({ kind: 'no-policy' });
  });

  it('returns forbidden when caller is not in allowed_principals', () => {
    const atoms = [
      pipeline({ id: 'pipeline-x', state: 'running' }),
      abandonPolicy({ allowed: ['apex-agent'] }),
    ];
    const result = validatePipelineAbandonInput(atoms, {
      pipelineId: 'pipeline-x',
      abandonerPrincipalId: 'random-bot',
      reason: VALID_REASON,
    });
    expect(result).toEqual({ kind: 'forbidden', allowedPrincipals: ['apex-agent'] });
  });

  it('returns ok when running, canon allows, and reason is valid', () => {
    const atoms = [
      pipeline({ id: 'pipeline-x', state: 'running' }),
      abandonPolicy({ allowed: ['apex-agent', 'ops-bot'] }),
    ];
    const result = validatePipelineAbandonInput(atoms, {
      pipelineId: 'pipeline-x',
      abandonerPrincipalId: 'apex-agent',
      reason: VALID_REASON,
    });
    expect(result).toEqual({
      kind: 'ok',
      allowedPrincipals: ['apex-agent', 'ops-bot'],
    });
  });

  it('returns ok when pipeline is hil-paused (paused pipelines abandonable)', () => {
    const atoms = [
      pipeline({ id: 'pipeline-x', state: 'hil-paused' }),
      abandonPolicy({ allowed: ['apex-agent'] }),
    ];
    const result = validatePipelineAbandonInput(atoms, {
      pipelineId: 'pipeline-x',
      abandonerPrincipalId: 'apex-agent',
      reason: VALID_REASON,
    });
    expect(result).toEqual({ kind: 'ok', allowedPrincipals: ['apex-agent'] });
  });

  it('returns ok when pipeline is pending (not yet started)', () => {
    /*
     * pending is NOT terminal -- a pipeline that has not yet started
     * executing CAN be abandoned (operator decides early that the
     * direction is wrong before any cost is paid). Substrate state
     * machine in src/runtime/planning-pipeline/runner.ts.
     */
    const atoms = [
      pipeline({ id: 'pipeline-x', state: 'pending' }),
      abandonPolicy({ allowed: ['apex-agent'] }),
    ];
    const result = validatePipelineAbandonInput(atoms, {
      pipelineId: 'pipeline-x',
      abandonerPrincipalId: 'apex-agent',
      reason: VALID_REASON,
    });
    expect(result).toEqual({ kind: 'ok', allowedPrincipals: ['apex-agent'] });
  });

  it('returns no-policy when canon is superseded (substrate parity)', () => {
    const atoms = [
      pipeline({ id: 'pipeline-x', state: 'running' }),
      abandonPolicy({
        allowed: ['apex-agent'],
        superseded_by: ['pol-pipeline-abandon-v2'],
      }),
    ];
    const result = validatePipelineAbandonInput(atoms, {
      pipelineId: 'pipeline-x',
      abandonerPrincipalId: 'apex-agent',
      reason: VALID_REASON,
    });
    expect(result).toEqual({ kind: 'no-policy' });
  });
});

describe('buildAbandonAtomId', () => {
  it('produces a deterministic atom id from the inputs', () => {
    const id = buildAbandonAtomId({
      pipelineId: 'pipeline-cto-1234',
      correlationId: 'console-abandon-9876',
    });
    expect(id).toBe('pipeline-abandoned-pipeline-cto-1234-console-abandon-9876');
  });

  it('is deterministic given the same inputs', () => {
    const inputs = { pipelineId: 'p-1', correlationId: 'c-1' };
    expect(buildAbandonAtomId(inputs)).toBe(buildAbandonAtomId(inputs));
  });
});

describe('buildPipelineAbandonedAtom', () => {
  const NOW = '2026-05-11T12:30:00.000Z';
  const baseInput = {
    pipelineId: 'pipeline-cto-1234',
    abandonerPrincipalId: 'apex-agent',
    reason: VALID_REASON,
    correlationId: 'console-abandon-9876',
    now: NOW,
  };

  it('produces an atom with the expected id', () => {
    const built = buildPipelineAbandonedAtom(baseInput);
    expect(built.id).toBe('pipeline-abandoned-pipeline-cto-1234-console-abandon-9876');
  });

  it('produces an L0 layer (the abandon is an event observation, not canon)', () => {
    const built = buildPipelineAbandonedAtom(baseInput);
    expect(built.layer).toBe('L0');
  });

  it('uses pipeline-abandoned as the atom type', () => {
    const built = buildPipelineAbandonedAtom(baseInput);
    expect(built.type).toBe('pipeline-abandoned');
  });

  it('carries the abandoner principal id in principal_id', () => {
    const built = buildPipelineAbandonedAtom(baseInput);
    expect(built.principal_id).toBe('apex-agent');
  });

  it('records user-directive provenance kind', () => {
    const built = buildPipelineAbandonedAtom(baseInput);
    expect(built.provenance.kind).toBe('user-directive');
  });

  it('records the tool tag for the audit walker', () => {
    const built = buildPipelineAbandonedAtom(baseInput);
    expect(built.provenance.source.tool).toBe('lag-console-pipeline-abandon');
  });

  it('threads the correlation id through session_id', () => {
    const built = buildPipelineAbandonedAtom(baseInput);
    expect(built.provenance.source.session_id).toBe('console-abandon-9876');
  });

  it('chains derived_from back to the pipeline atom', () => {
    const built = buildPipelineAbandonedAtom(baseInput);
    expect(built.provenance.derived_from).toEqual(['pipeline-cto-1234']);
  });

  it('stamps the reason into metadata', () => {
    const built = buildPipelineAbandonedAtom(baseInput);
    expect(built.metadata.reason).toBe(VALID_REASON);
  });

  it('stamps the pipeline_id into metadata for query joins', () => {
    const built = buildPipelineAbandonedAtom(baseInput);
    expect(built.metadata.pipeline_id).toBe('pipeline-cto-1234');
  });

  it('records abandoned_at == now timestamp', () => {
    const built = buildPipelineAbandonedAtom(baseInput);
    expect(built.metadata.abandoned_at).toBe(NOW);
    expect(built.created_at).toBe(NOW);
  });

  it('records the abandoner principal id in metadata', () => {
    const built = buildPipelineAbandonedAtom(baseInput);
    expect(built.metadata.abandoner_principal_id).toBe('apex-agent');
  });

  it('marks the atom clean (taint-clean)', () => {
    const built = buildPipelineAbandonedAtom(baseInput);
    expect(built.taint).toBe('clean');
  });

  it('marks confidence as 1.0 (operator-direct action, not LLM inference)', () => {
    const built = buildPipelineAbandonedAtom(baseInput);
    expect(built.confidence).toBe(1.0);
  });
});
