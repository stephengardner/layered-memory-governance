/**
 * Tests for the stage-name mapping helpers.
 *
 * The mapping table is the single source of truth for the
 * stage -> principal -> skill-bundle triple consumed by the Console's
 * stage-context endpoint and any future audit tool that needs to
 * derive bundle + principal from a stage name without re-importing
 * the per-stage adapter modules. Pinning the rows in tests guards
 * against silent drift between the table and the per-stage adapters.
 */

import { describe, it, expect } from 'vitest';
import {
  PIPELINE_STAGE_NAMES,
  bindingForStage,
  isPipelineStageName,
  stageFromAtomType,
  stageForAtom,
} from '../../../../examples/planning-stages/lib/stage-mapping.js';

describe('PIPELINE_STAGE_NAMES', () => {
  it('has the canonical 5 stages in canonical order', () => {
    expect([...PIPELINE_STAGE_NAMES]).toEqual([
      'brainstorm-stage',
      'spec-stage',
      'plan-stage',
      'review-stage',
      'dispatch-stage',
    ]);
  });
});

describe('isPipelineStageName', () => {
  it('returns true for every canonical stage', () => {
    for (const stage of PIPELINE_STAGE_NAMES) {
      expect(isPipelineStageName(stage)).toBe(true);
    }
  });

  it('returns false for unknown stages', () => {
    expect(isPipelineStageName('not-a-stage')).toBe(false);
    expect(isPipelineStageName('')).toBe(false);
    expect(isPipelineStageName(null)).toBe(false);
    expect(isPipelineStageName(undefined)).toBe(false);
    expect(isPipelineStageName(42)).toBe(false);
  });
});

describe('bindingForStage', () => {
  it('maps brainstorm-stage to brainstorm-actor + brainstorming bundle', () => {
    expect(bindingForStage('brainstorm-stage')).toEqual({
      stage: 'brainstorm-stage',
      principalId: 'brainstorm-actor',
      skillBundle: 'brainstorming',
    });
  });

  it('maps spec-stage to spec-author + writing-clearly bundle', () => {
    expect(bindingForStage('spec-stage')).toEqual({
      stage: 'spec-stage',
      principalId: 'spec-author',
      skillBundle: 'writing-clearly',
    });
  });

  it('maps plan-stage to plan-author + writing-plans bundle', () => {
    expect(bindingForStage('plan-stage')).toEqual({
      stage: 'plan-stage',
      principalId: 'plan-author',
      skillBundle: 'writing-plans',
    });
  });

  it('maps review-stage to pipeline-auditor + review-discipline bundle', () => {
    expect(bindingForStage('review-stage')).toEqual({
      stage: 'review-stage',
      principalId: 'pipeline-auditor',
      skillBundle: 'review-discipline',
    });
  });

  it('maps dispatch-stage to plan-dispatcher + dispatch-discipline bundle', () => {
    expect(bindingForStage('dispatch-stage')).toEqual({
      stage: 'dispatch-stage',
      principalId: 'plan-dispatcher',
      skillBundle: 'dispatch-discipline',
    });
  });

  it('returns null for unknown stage names', () => {
    expect(bindingForStage('mystery-stage')).toBeNull();
    expect(bindingForStage('')).toBeNull();
  });
});

describe('stageFromAtomType', () => {
  it('maps each stage-output type to its stage', () => {
    expect(stageFromAtomType('brainstorm-output', undefined)).toBe('brainstorm-stage');
    expect(stageFromAtomType('spec-output', undefined)).toBe('spec-stage');
    expect(stageFromAtomType('review-report', undefined)).toBe('review-stage');
    expect(stageFromAtomType('dispatch-record', undefined)).toBe('dispatch-stage');
  });

  it('maps plan atoms to plan-stage only when metadata.pipeline_id is set', () => {
    expect(stageFromAtomType('plan', { pipeline_id: 'pipeline-foo' })).toBe('plan-stage');
  });

  it('returns null for plan atoms with no pipeline_id (manually authored)', () => {
    expect(stageFromAtomType('plan', undefined)).toBeNull();
    expect(stageFromAtomType('plan', {})).toBeNull();
    expect(stageFromAtomType('plan', { pipeline_id: '' })).toBeNull();
    expect(stageFromAtomType('plan', { pipeline_id: 42 })).toBeNull();
  });

  it('returns null for non-pipeline atom types', () => {
    expect(stageFromAtomType('directive', undefined)).toBeNull();
    expect(stageFromAtomType('observation', undefined)).toBeNull();
    expect(stageFromAtomType('actor-message', undefined)).toBeNull();
    expect(stageFromAtomType('agent-session', undefined)).toBeNull();
  });
});

describe('stageForAtom', () => {
  it('prefers explicit metadata.stage_name when present', () => {
    expect(
      stageForAtom('plan', { stage_name: 'plan-stage', pipeline_id: 'p1' }),
    ).toBe('plan-stage');
  });

  it('falls back to type-based inference when metadata.stage_name is absent', () => {
    expect(stageForAtom('brainstorm-output', undefined)).toBe('brainstorm-stage');
  });

  it('falls back to type-based inference when metadata.stage_name is not a known stage', () => {
    expect(
      stageForAtom('spec-output', { stage_name: 'mystery-stage' }),
    ).toBe('spec-stage');
  });

  it('returns null when neither explicit nor type-based inference resolves', () => {
    expect(stageForAtom('observation', undefined)).toBeNull();
    expect(stageForAtom('actor-message', { stage_name: 'mystery' })).toBeNull();
  });

  it('returns null for plan atoms without pipeline_id even when metadata.stage_name is unset', () => {
    expect(stageForAtom('plan', {})).toBeNull();
  });
});
