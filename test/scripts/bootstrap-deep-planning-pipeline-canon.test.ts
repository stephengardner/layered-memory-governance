/**
 * Drift tests for scripts/bootstrap-deep-planning-pipeline-canon.mjs.
 *
 * The deep-planning pipeline runner reads three policy subjects:
 *   - planning-pipeline-stages (registers the default 5 stages)
 *   - pipeline-stage-hil (one atom per stage; pause_mode + auto-resume)
 *   - planning-pipeline-default-mode (single-pass vs substrate-deep)
 * plus a substrate-shape directive. Keeping the seed and the runner's
 * policy parsers (src/runtime/planning-pipeline/policy.ts) aligned is
 * load-bearing: a deployment that never re-runs the bootstrap script
 * gets the runtime fail-closed default, and a silent divergence (e.g.
 * seed says pause_mode='never' but parser drifts to require 'always')
 * means the policy the operator thinks they have differs from what
 * actually runs.
 *
 * Covers:
 *   - buildDeepPlanningPipelineSpecs returns the expected stable set
 *     of ids: pol-planning-pipeline-stages-default plus per-stage HIL
 *     atoms, the default-mode atom, and the substrate-shape directive.
 *   - The 5 default stages register the canonical stage_name values
 *     the reference adapters emit (brainstorm-stage, spec-stage,
 *     plan-stage, review-stage, dispatch-stage).
 *   - HIL defaults match the spec section 8 indie floor:
 *     brainstorm + review = 'never'; spec + plan + dispatch =
 *     'on-critical-finding'.
 *   - Default-mode policy seeds 'single-pass' per the indie floor and
 *     dev-indie-floor-org-ceiling.
 *   - The dev- substrate-shape directive ships as L0 with
 *     validation_status='pending_review' so the operator gates the L3
 *     promotion via /decide post-merge per inv-l3-requires-human.
 *   - Each policy atom round-trips through the runner's parser
 *     (readPipelineStagesPolicy, readPipelineStageHilPolicy,
 *     readPipelineDefaultModePolicy) against a memory host so a
 *     parser drift surfaces here instead of at runtime.
 *   - operatorId is required and seeds principal_id (not hardcoded).
 *   - Operator id rejection mirrors the symmetric guard in the
 *     autonomous-intent-canon-atoms builder.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PIPELINE_STAGES,
  DEFAULT_PIPELINE_MODE,
  PIPELINE_STAGE_HIL_DEFAULTS,
  buildAtomFromSpec,
  buildDeepPlanningPipelineAtoms,
  buildDeepPlanningPipelineSpecs,
} from '../../scripts/lib/deep-planning-pipeline-canon-atoms.mjs';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import {
  readPipelineDefaultModePolicy,
  readPipelineStageHilPolicy,
  readPipelineStagesPolicy,
} from '../../src/runtime/planning-pipeline/policy.js';
import type { Atom } from '../../src/types.js';

const OP = 'test-operator';

describe('bootstrap-deep-planning-pipeline-canon specs', () => {
  it('returns the expected stable set of atom ids', () => {
    // dev-deep-planning-pipeline moved to scripts/bootstrap-operator-directives.mjs
    // after operator promotion via /decide; this module seeds policy + ordering only.
    const ids = buildDeepPlanningPipelineSpecs(OP).map((s) => s.id).sort();
    expect(ids).toEqual([
      'pol-pipeline-stage-hil-brainstorm-stage',
      'pol-pipeline-stage-hil-dispatch-stage',
      'pol-pipeline-stage-hil-plan-stage',
      'pol-pipeline-stage-hil-review-stage',
      'pol-pipeline-stage-hil-spec-stage',
      'pol-planning-pipeline-default-mode',
      'pol-planning-pipeline-stages-default',
    ]);
  });

  it('rejects an empty operator id', () => {
    expect(() => buildDeepPlanningPipelineSpecs('')).toThrow(/operatorId/);
    expect(() => buildDeepPlanningPipelineSpecs(undefined as unknown as string)).toThrow(/operatorId/);
  });

  it('default stage list registers brainstorm/spec/plan/review/dispatch in that order', () => {
    expect(DEFAULT_PIPELINE_STAGES.map((s: { name: string }) => s.name)).toEqual([
      'brainstorm-stage',
      'spec-stage',
      'plan-stage',
      'review-stage',
      'dispatch-stage',
    ]);
  });

  it('HIL defaults match the spec section 8 indie floor', () => {
    expect(PIPELINE_STAGE_HIL_DEFAULTS['brainstorm-stage']).toBe('never');
    expect(PIPELINE_STAGE_HIL_DEFAULTS['spec-stage']).toBe('on-critical-finding');
    expect(PIPELINE_STAGE_HIL_DEFAULTS['plan-stage']).toBe('on-critical-finding');
    expect(PIPELINE_STAGE_HIL_DEFAULTS['review-stage']).toBe('never');
    expect(PIPELINE_STAGE_HIL_DEFAULTS['dispatch-stage']).toBe('on-critical-finding');
  });

  it('default mode is single-pass per dev-indie-floor-org-ceiling', () => {
    expect(DEFAULT_PIPELINE_MODE).toBe('single-pass');
  });
});

describe('bootstrap-deep-planning-pipeline-canon atom shapes', () => {
  it('pol-planning-pipeline-stages-default is L3 directive carrying 5 stages', async () => {
    const atom = findAtom(buildDeepPlanningPipelineAtoms(OP), 'pol-planning-pipeline-stages-default');
    expect(atom.type).toBe('directive');
    expect(atom.layer).toBe('L3');
    expect(atom.principal_id).toBe(OP);
    expect(atom.taint).toBe('clean');
    const policy = readPolicyBlock(atom);
    expect(policy.subject).toBe('planning-pipeline-stages');
    expect(policy.scope).toBe('project');
    expect(policy.stages).toHaveLength(5);
  });

  it('round-trips through readPipelineStagesPolicy with the canonical 5 stages', async () => {
    const host = createMemoryHost();
    const atom = findAtom(buildDeepPlanningPipelineAtoms(OP), 'pol-planning-pipeline-stages-default');
    await host.atoms.put(atom);
    const result = await readPipelineStagesPolicy(host, { scope: 'project' });
    expect(result.atomId).toBe('pol-planning-pipeline-stages-default');
    expect(result.stages.map((s) => s.name)).toEqual([
      'brainstorm-stage',
      'spec-stage',
      'plan-stage',
      'review-stage',
      'dispatch-stage',
    ]);
    expect(result.stages.map((s) => s.principal_id)).toEqual([
      'brainstorm-actor',
      'spec-author',
      'cto-actor',
      'pipeline-auditor',
      'plan-dispatcher',
    ]);
  });

  it.each(['brainstorm-stage', 'spec-stage', 'plan-stage', 'review-stage', 'dispatch-stage'])(
    'pol-pipeline-stage-hil-%s ships as L3 directive with the spec section 8 default',
    async (stageName) => {
      const id = `pol-pipeline-stage-hil-${stageName}`;
      const atom = findAtom(buildDeepPlanningPipelineAtoms(OP), id);
      expect(atom.type).toBe('directive');
      expect(atom.layer).toBe('L3');
      const policy = readPolicyBlock(atom);
      expect(policy.subject).toBe('pipeline-stage-hil');
      expect(policy.stage_name).toBe(stageName);
      expect(policy.pause_mode).toBe(PIPELINE_STAGE_HIL_DEFAULTS[stageName]);
      expect(policy.allowed_resumers).toEqual([OP]);

      const host = createMemoryHost();
      await host.atoms.put(atom);
      const result = await readPipelineStageHilPolicy(host, stageName);
      expect(result.pause_mode).toBe(PIPELINE_STAGE_HIL_DEFAULTS[stageName]);
      expect(result.allowed_resumers).toEqual([OP]);
    },
  );

  it('pol-planning-pipeline-default-mode round-trips to single-pass', async () => {
    const host = createMemoryHost();
    const atom = findAtom(
      buildDeepPlanningPipelineAtoms(OP),
      'pol-planning-pipeline-default-mode',
    );
    expect(atom.type).toBe('directive');
    expect(atom.layer).toBe('L3');
    const policy = readPolicyBlock(atom);
    expect(policy.subject).toBe('planning-pipeline-default-mode');
    expect(policy.mode).toBe('single-pass');
    await host.atoms.put(atom);
    const result = await readPipelineDefaultModePolicy(host);
    expect(result.mode).toBe('single-pass');
  });

  it('every emitted atom carries operator-seeded provenance with derived_from', () => {
    // The substrate-shape directive `dev-deep-planning-pipeline` lived here as
    // an L0 stub before promotion; after the operator ratified it via /decide,
    // it moved to scripts/bootstrap-operator-directives.mjs (see that file's
    // ATOMS array). The 7 atoms below are the policy + ordering atoms the
    // pipeline substrate needs at the seed-time of any deployment.
    const atoms = buildDeepPlanningPipelineAtoms(OP);
    expect(atoms.length).toBe(7);
    for (const atom of atoms) {
      expect(atom.provenance.kind).toBe('operator-seeded');
      expect(atom.provenance.derived_from.length).toBeGreaterThan(0);
      expect(atom.principal_id).toBe(OP);
      expect(atom.taint).toBe('clean');
    }
  });

  it('buildAtomFromSpec rejects an empty operator id', () => {
    const spec = buildDeepPlanningPipelineSpecs(OP)[0];
    expect(() => buildAtomFromSpec(spec, '')).toThrow(/operatorId/);
    expect(() =>
      buildAtomFromSpec(spec, undefined as unknown as string),
    ).toThrow(/operatorId/);
  });
});

function findAtom(atoms: ReadonlyArray<Atom>, id: string): Atom {
  const atom = atoms.find((a) => a.id === id);
  if (!atom) throw new Error(`expected atom ${id} in builder output`);
  return atom;
}

function readPolicyBlock(atom: Atom): Record<string, unknown> {
  const meta = atom.metadata as { policy?: Record<string, unknown> };
  if (!meta?.policy) throw new Error(`atom ${atom.id} missing metadata.policy`);
  return meta.policy;
}
