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

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_DISPATCH_INVOKER_ROLE,
  DEFAULT_PIPELINE_STAGES,
  DEFAULT_PIPELINE_MODE,
  DEFAULT_STAGE_IMPLEMENTATION_MODES,
  PIPELINE_STAGE_HIL_DEFAULTS,
  buildAtomFromSpec,
  buildDeepPlanningPipelineAtoms,
  buildDeepPlanningPipelineSpecs,
} from '../../scripts/lib/deep-planning-pipeline-canon-atoms.mjs';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import {
  readDispatchInvokerDefaultPolicy,
  readPipelineDefaultModePolicy,
  readPipelineStageHilPolicy,
  readPipelineStageImplementationsPolicy,
  readPipelineStagesPolicy,
} from '../../src/runtime/planning-pipeline/policy.js';
import type { Atom } from '../../src/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const BOOTSTRAP_SCRIPT = resolve(
  REPO_ROOT,
  'scripts',
  'bootstrap-deep-planning-pipeline-canon.mjs',
);

const OP = 'test-operator';

describe('bootstrap-deep-planning-pipeline-canon specs', () => {
  it('returns the expected stable set of atom ids', () => {
    // dev-deep-planning-pipeline moved to scripts/bootstrap-operator-directives.mjs
    // after operator promotion via /decide; this module seeds policy + ordering only.
    const ids = buildDeepPlanningPipelineSpecs(OP).map((s) => s.id).sort();
    expect(ids).toEqual([
      'pol-dispatch-invoker-default',
      'pol-pipeline-stage-hil-brainstorm-stage',
      'pol-pipeline-stage-hil-dispatch-stage',
      'pol-pipeline-stage-hil-plan-stage',
      'pol-pipeline-stage-hil-review-stage',
      'pol-pipeline-stage-hil-spec-stage',
      'pol-planning-pipeline-default-mode',
      'pol-planning-pipeline-stage-implementations-default',
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

  it('default mode is substrate-deep (this deployment opted in to the audit chain)', () => {
    // The framework directive dev-deep-planning-pipeline teaches
    // single-pass as the indie-floor default; this deployment chose
    // substrate-deep so every plan flows through the brainstorm + spec
    // + plan + review + dispatch audit chain. A fresh LAG deployment
    // that wants the indie default re-writes DEFAULT_PIPELINE_MODE and
    // rebootstraps.
    expect(DEFAULT_PIPELINE_MODE).toBe('substrate-deep');
  });

  it('default dispatch-invoker role is lag-ceo (operator-proxy in this deployment)', () => {
    expect(DEFAULT_DISPATCH_INVOKER_ROLE).toBe('lag-ceo');
  });

  it('default per-stage implementation modes are single-shot for every stage', () => {
    expect(DEFAULT_STAGE_IMPLEMENTATION_MODES['brainstorm-stage']).toBe('single-shot');
    expect(DEFAULT_STAGE_IMPLEMENTATION_MODES['spec-stage']).toBe('single-shot');
    expect(DEFAULT_STAGE_IMPLEMENTATION_MODES['plan-stage']).toBe('single-shot');
    expect(DEFAULT_STAGE_IMPLEMENTATION_MODES['review-stage']).toBe('single-shot');
    expect(DEFAULT_STAGE_IMPLEMENTATION_MODES['dispatch-stage']).toBe('single-shot');
  });

  it('every default stage has a valid implementation mode (no undefined drift)', () => {
    // Drift guard: the bootstrap builder throws if a DEFAULT_PIPELINE_STAGES
    // entry lacks a corresponding DEFAULT_STAGE_IMPLEMENTATION_MODES entry.
    // This test catches the same drift at test-time so a CI run rejects a
    // commit that adds a stage without setting its default mode.
    for (const stage of DEFAULT_PIPELINE_STAGES) {
      const mode = DEFAULT_STAGE_IMPLEMENTATION_MODES[stage.name];
      expect(['agentic', 'single-shot']).toContain(mode);
    }
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
      'plan-author',
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

  it('pol-planning-pipeline-default-mode round-trips to substrate-deep', async () => {
    const host = createMemoryHost();
    const atom = findAtom(
      buildDeepPlanningPipelineAtoms(OP),
      'pol-planning-pipeline-default-mode',
    );
    expect(atom.type).toBe('directive');
    expect(atom.layer).toBe('L3');
    const policy = readPolicyBlock(atom);
    expect(policy.subject).toBe('planning-pipeline-default-mode');
    expect(policy.mode).toBe('substrate-deep');
    await host.atoms.put(atom);
    const result = await readPipelineDefaultModePolicy(host);
    expect(result.mode).toBe('substrate-deep');
    expect(result.atomId).toBe('pol-planning-pipeline-default-mode');
  });

  it('pol-dispatch-invoker-default round-trips to lag-ceo with the policy reader', async () => {
    const host = createMemoryHost();
    const atom = findAtom(
      buildDeepPlanningPipelineAtoms(OP),
      'pol-dispatch-invoker-default',
    );
    expect(atom.type).toBe('directive');
    expect(atom.layer).toBe('L3');
    expect(atom.principal_id).toBe(OP);
    const policy = readPolicyBlock(atom);
    expect(policy.subject).toBe('dispatch-invoker-default');
    expect(policy.role).toBe('lag-ceo');
    await host.atoms.put(atom);
    const result = await readDispatchInvokerDefaultPolicy(host);
    expect(result.role).toBe('lag-ceo');
    expect(result.atomId).toBe('pol-dispatch-invoker-default');
  });

  it('pol-planning-pipeline-stage-implementations-default round-trips to single-shot for every stage', async () => {
    const host = createMemoryHost();
    const atom = findAtom(
      buildDeepPlanningPipelineAtoms(OP),
      'pol-planning-pipeline-stage-implementations-default',
    );
    expect(atom.type).toBe('directive');
    expect(atom.layer).toBe('L3');
    const policy = readPolicyBlock(atom);
    expect(policy.subject).toBe('planning-pipeline-stage-implementations');
    expect(policy.scope).toBe('project');
    expect(policy.implementations).toHaveLength(5);
    await host.atoms.put(atom);
    const result = await readPipelineStageImplementationsPolicy(host, { scope: 'project' });
    expect(result.atomId).toBe('pol-planning-pipeline-stage-implementations-default');
    expect(result.implementations.get('brainstorm-stage')).toBe('single-shot');
    expect(result.implementations.get('spec-stage')).toBe('single-shot');
    expect(result.implementations.get('plan-stage')).toBe('single-shot');
    expect(result.implementations.get('review-stage')).toBe('single-shot');
    expect(result.implementations.get('dispatch-stage')).toBe('single-shot');
  });

  it('every emitted atom carries operator-seeded provenance with derived_from', () => {
    // The substrate-shape directive `dev-deep-planning-pipeline` lived here as
    // an L0 stub before promotion; after the operator ratified it via /decide,
    // it moved to scripts/bootstrap-operator-directives.mjs (see that file's
    // ATOMS array). The 9 atoms below are the policy + ordering atoms the
    // pipeline substrate needs at the seed-time of any deployment (8
    // pipeline-stage policies + 1 dispatch-invoker default).
    const atoms = buildDeepPlanningPipelineAtoms(OP);
    expect(atoms.length).toBe(9);
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

describe('bootstrap-deep-planning-pipeline-canon honors LAG_STATE_DIR', () => {
  // Regression: prior to this guard the wrapper hardcoded
  //   const STATE_DIR = resolve(REPO_ROOT, '.lag');
  // so a deployment whose other substrate components honored
  // LAG_STATE_DIR (e.g. scripts/invokers/autonomous-dispatch.mjs) would
  // silently fork canon: every runtime read landed at the env-pointed
  // dir, but bootstrap writes landed at REPO_ROOT/.lag. The next
  // bootstrap run against the env-pointed dir would then "rewrite" 9
  // atoms that the runtime had never seen, masking real drift.
  //
  // Indie-floor default (env unset) preserved by the unset-env case in
  // the existing builder tests above; this block locks in the
  // org-ceiling case (env set) by running the real wrapper end-to-end.
  let tempStateDir: string;

  beforeEach(() => {
    tempStateDir = mkdtempSync(join(tmpdir(), 'lag-bootstrap-state-dir-'));
  });

  afterEach(() => {
    try { rmSync(tempStateDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('writes atoms to the LAG_STATE_DIR-pointed dir, not REPO_ROOT/.lag', () => {
    // Snapshot the in-repo .lag/atoms/ before the run so a later
    // diff isolates atoms written by this invocation (the dir already
    // exists in a real checkout and carries unrelated atoms).
    const inRepoAtomsDir = resolve(REPO_ROOT, '.lag', 'atoms');
    const beforeInRepo = existsSync(inRepoAtomsDir)
      ? new Set(readdirSync(inRepoAtomsDir))
      : new Set<string>();

    const r = spawnSync(
      process.execPath,
      [BOOTSTRAP_SCRIPT],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          LAG_STATE_DIR: tempStateDir,
          LAG_OPERATOR_ID: 'test-operator',
        },
      },
    );

    expect(r.status, `bootstrap stderr: ${r.stderr}`).toBe(0);

    // Atoms must land at the env-pointed dir.
    const tempAtomsDir = join(tempStateDir, 'atoms');
    expect(existsSync(tempAtomsDir)).toBe(true);
    const writtenInTemp = readdirSync(tempAtomsDir);
    // Builder emits 9 atoms (8 pipeline policies + 1 dispatch-invoker
    // default); same count as the every-atom-shape test above.
    expect(writtenInTemp.length).toBe(9);

    // The bootstrap MUST NOT have added any new atom files to the
    // in-repo .lag/atoms/ directory. Pre-existing atoms are out of
    // scope (the test isn't asserting cleanliness of the checkout).
    const afterInRepo = existsSync(inRepoAtomsDir)
      ? new Set(readdirSync(inRepoAtomsDir))
      : new Set<string>();
    const newInRepo = [...afterInRepo].filter((f) => !beforeInRepo.has(f));
    expect(newInRepo, 'bootstrap leaked atoms into REPO_ROOT/.lag/atoms/').toEqual([]);
  });

  it('falls back to REPO_ROOT/.lag when LAG_STATE_DIR is unset (indie-floor default)', () => {
    // Drive --dry-run so the unset-env case asserts the resolved path
    // shape without writing real atoms into the checkout. The dry-run
    // path still resolves STATE_DIR at module-eval time and lists every
    // atom id it would have written; success on this branch confirms
    // the env-aware logic preserves the indie default behaviour.
    const env = { ...process.env, LAG_OPERATOR_ID: 'test-operator' };
    delete env.LAG_STATE_DIR;

    const r = spawnSync(
      process.execPath,
      [BOOTSTRAP_SCRIPT, '--dry-run'],
      { cwd: REPO_ROOT, encoding: 'utf8', env },
    );

    expect(r.status, `dry-run stderr: ${r.stderr}`).toBe(0);
    // Dry-run prints "dry-run: 9 atoms would be written" and lists
    // each id; a regression that broke the wrapper's argv handling
    // would surface as a non-zero exit.
    expect(r.stdout).toContain('dry-run: 9 atoms');
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
