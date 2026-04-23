/**
 * PlanningActor tests.
 *
 * Drive the actor through runActor with:
 *   - an in-memory host seeded with a couple of canon atoms
 *   - a stub PlanningJudgment returning deterministic classifications
 *     and drafted plans (so 55b's real LLM can slot in without
 *     re-testing the actor machinery)
 *   - a stubbed principal + empty adapters
 *
 * Assertions:
 *   - observe builds a PlanningContext with directives + decisions
 *   - classify returns the key the stub supplies
 *   - propose emits one ProposedAction per drafted plan with tool
 *     'plan-propose'
 *   - apply writes a type='plan' atom at layer L1 with plan_state
 *     'proposed', cites derivedFrom atoms, and surfaces via notifier
 *   - reflect done=true once all drafted plans are applied
 *   - policy deny on plan-propose blocks writes (autonomy dial works)
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import { runActor } from '../../../src/actors/run-actor.js';
import { PlanningActor } from '../../../src/actors/planning/planning-actor.js';
import type {
  PlanningClassification,
  PlanningContext,
  PlanningJudgment,
  ProposedPlan,
} from '../../../src/actors/planning/types.js';
import type { AtomId, PrincipalId } from '../../../src/types.js';
import { sampleAtom, samplePrincipal } from '../../fixtures.js';

function stubJudgment(
  classification: PlanningClassification,
  plans: ReadonlyArray<ProposedPlan>,
): PlanningJudgment {
  return {
    async classify(_ctx: PlanningContext): Promise<PlanningClassification> {
      return classification;
    },
    async draft(): Promise<ReadonlyArray<ProposedPlan>> {
      return plans;
    },
  };
}

const DIR_ATOM: AtomId = 'dev-right-over-easy' as AtomId;

function seedHost() {
  const host = createMemoryHost();
  return (async () => {
    await host.atoms.put(sampleAtom({
      id: DIR_ATOM,
      type: 'directive',
      layer: 'L3',
      content: 'Right over easy.',
    }));
    return host;
  })();
}

function planOne(overrides: Partial<ProposedPlan> = {}): ProposedPlan {
  return {
    title: 'Plan X',
    body: 'Do A, B, C in sequence.',
    derivedFrom: [DIR_ATOM],
    principlesApplied: [DIR_ATOM],
    alternativesRejected: [{ option: 'Do nothing', reason: 'leaves risk open' }],
    whatBreaksIfRevisit: 'Low; recoverable via atom supersession.',
    ...overrides,
  };
}

describe('PlanningActor', () => {
  it('writes a proposed Plan atom per drafted plan and halts when all are applied', async () => {
    const host = await seedHost();
    const actor = new PlanningActor({
      request: 'how do we ship X',
      judgment: stubJudgment(
        { kind: 'greenfield', rationale: 'no precedent', applicableDirectives: [DIR_ATOM] },
        [planOne({ title: 'Plan Alpha' })],
      ),
    });
    const report = await runActor(actor, {
      host,
      principal: samplePrincipal({ id: 'cto-actor' as PrincipalId }),
      adapters: {},
      budget: { maxIterations: 2 },
      origin: 'operator',
    });

    expect(report.haltReason).toBe('converged');
    // Exactly one plan atom written, type=plan, layer=L1, plan_state=proposed.
    const all = await host.atoms.query({ type: ['plan'] }, 50);
    expect(all.atoms).toHaveLength(1);
    const plan = all.atoms[0]!;
    expect(plan.layer).toBe('L1');
    // plan_state is the top-level Atom field; prior versions wrote
    // it into metadata where dispatch/auto-approve loops couldn't
    // see it. Top-level assertion locks the fix in.
    expect(plan.plan_state).toBe('proposed');
    expect(plan.metadata.title).toBe('Plan Alpha');
    expect(plan.provenance.derived_from).toContain(DIR_ATOM);
    expect(plan.content).toContain('Plan Alpha');
    expect(plan.content).toContain('dev-right-over-easy'); // principle atom id cited (consumers resolve to content)
  });

  it('classify key encodes the classification kind', async () => {
    const host = await seedHost();
    const seenKinds: string[] = [];
    const actor = new PlanningActor({
      request: 'should we reverse D7',
      judgment: {
        async classify() {
          const c: PlanningClassification = {
            kind: 'reversal',
            rationale: 'explicit reversal request',
            applicableDirectives: [],
          };
          seenKinds.push(c.kind);
          return c;
        },
        async draft() { return []; },
      },
    });
    const report = await runActor(actor, {
      host,
      principal: samplePrincipal({ id: 'cto-actor' as PrincipalId }),
      adapters: {},
      budget: { maxIterations: 2 },
      origin: 'operator',
    });
    expect(seenKinds).toContain('reversal');
    expect(report.haltReason).toBe('converged');
  });

  it('multiple drafted plans produce one Plan atom per plan', async () => {
    const host = await seedHost();
    const actor = new PlanningActor({
      request: 'weigh options for Y',
      judgment: stubJudgment(
        { kind: 'modification', rationale: 'multi-option', applicableDirectives: [DIR_ATOM] },
        [
          planOne({ title: 'Plan A' }),
          planOne({ title: 'Plan B' }),
          planOne({ title: 'Plan C' }),
        ],
      ),
    });
    const report = await runActor(actor, {
      host,
      principal: samplePrincipal({ id: 'cto-actor' as PrincipalId }),
      adapters: {},
      budget: { maxIterations: 2 },
      origin: 'operator',
    });
    const all = await host.atoms.query({ type: ['plan'] }, 50);
    expect(all.atoms.map((a) => a.metadata.title).sort()).toEqual(['Plan A', 'Plan B', 'Plan C']);
    expect(report.haltReason).toBe('converged');
  });

  it('policy deny on plan-propose blocks Plan atom writes', async () => {
    const host = await seedHost();
    // Seed a canon policy that denies plan-propose.
    await host.atoms.put(sampleAtom({
      id: 'deny-planning' as AtomId,
      type: 'directive',
      layer: 'L3',
      metadata: {
        policy: {
          subject: 'tool-use',
          tool: 'plan-propose',
          origin: '*',
          principal: '*',
          action: 'deny',
          reason: 'planning suspended',
          priority: 100,
        },
      },
    }));
    const actor = new PlanningActor({
      request: 'plan anything',
      judgment: stubJudgment(
        { kind: 'greenfield', rationale: 'x', applicableDirectives: [] },
        [planOne()],
      ),
    });
    const report = await runActor(actor, {
      host,
      principal: samplePrincipal({ id: 'cto-actor' as PrincipalId }),
      adapters: {},
      budget: { maxIterations: 2 },
      origin: 'operator',
    });
    // Policy denied plan-propose; no plan atom should have been written.
    const plans = await host.atoms.query({ type: ['plan'] }, 50);
    expect(plans.atoms).toHaveLength(0);
    expect(report.escalations.some((e) => e.startsWith('deny:'))).toBe(true);
  });

  it('originatingQuestion: when omitted, plan metadata has no question_id or question_prompt (baseline parity)', async () => {
    const host = await seedHost();
    const actor = new PlanningActor({
      request: 'bare request, no question atom',
      judgment: stubJudgment(
        { kind: 'greenfield', rationale: 'x', applicableDirectives: [DIR_ATOM] },
        [planOne({ title: 'Plan No-Q' })],
      ),
      // originatingQuestion intentionally not set
    });
    await runActor(actor, {
      host,
      principal: samplePrincipal({ id: 'cto-actor' as PrincipalId }),
      adapters: {},
      budget: { maxIterations: 2 },
      origin: 'operator',
    });
    const all = await host.atoms.query({ type: ['plan'] }, 10);
    expect(all.atoms).toHaveLength(1);
    const plan = all.atoms[0]!;
    // Absent-when-omitted is load-bearing: pre-seam callers' plan
    // metadata shape must not change or MemoryLLM data-hash-keyed
    // fixtures break and downstream consumers that `'question_id' in
    // metadata` check would see a false positive.
    expect('question_id' in plan.metadata).toBe(false);
    expect('question_prompt' in plan.metadata).toBe(false);
  });

  it('originatingQuestion: id + prompt propagate into plan metadata (mirrors agent-sdk executor seam)', async () => {
    const host = await seedHost();
    const actor = new PlanningActor({
      request: 'concrete request derived from a Question atom',
      judgment: stubJudgment(
        { kind: 'greenfield', rationale: 'x', applicableDirectives: [DIR_ATOM] },
        [planOne({ title: 'Plan With-Q' })],
      ),
      originatingQuestion: {
        id: 'q-abc123-2026-04-23T12-00-00-000Z' as AtomId,
        prompt: 'Replace the `7Z UTC` line in docs/retro.md with `7Z`.',
      },
    });
    await runActor(actor, {
      host,
      principal: samplePrincipal({ id: 'cto-actor' as PrincipalId }),
      adapters: {},
      budget: { maxIterations: 2 },
      origin: 'operator',
    });
    const all = await host.atoms.query({ type: ['plan'] }, 10);
    const plan = all.atoms[0]!;
    expect(plan.metadata.question_id).toBe('q-abc123-2026-04-23T12-00-00-000Z');
    expect(plan.metadata.question_prompt).toBe(
      'Replace the `7Z UTC` line in docs/retro.md with `7Z`.',
    );
    // Pre-existing baseline metadata keys stay present (no overwrite).
    expect(plan.metadata.title).toBe('Plan With-Q');
    expect(plan.metadata.planning_actor_version).toBeDefined();
  });

  it('originatingQuestion: empty id or empty prompt is omitted (parity with agent-sdk seam)', async () => {
    const host = await seedHost();
    const actor = new PlanningActor({
      request: 'edge: caller passed a Question-shaped object with empty fields',
      judgment: stubJudgment(
        { kind: 'greenfield', rationale: 'x', applicableDirectives: [DIR_ATOM] },
        [planOne({ title: 'Plan Empty-Q' })],
      ),
      originatingQuestion: {
        id: '' as AtomId,
        prompt: '',
      },
    });
    await runActor(actor, {
      host,
      principal: samplePrincipal({ id: 'cto-actor' as PrincipalId }),
      adapters: {},
      budget: { maxIterations: 2 },
      origin: 'operator',
    });
    const all = await host.atoms.query({ type: ['plan'] }, 10);
    const plan = all.atoms[0]!;
    expect('question_id' in plan.metadata).toBe(false);
    expect('question_prompt' in plan.metadata).toBe(false);
  });

  it('originatingQuestion: only id populated -> question_id present, question_prompt absent', async () => {
    const host = await seedHost();
    const actor = new PlanningActor({
      request: 'asymmetric edge: id known, prompt missing',
      judgment: stubJudgment(
        { kind: 'greenfield', rationale: 'x', applicableDirectives: [DIR_ATOM] },
        [planOne({ title: 'Plan Id-Only' })],
      ),
      originatingQuestion: {
        id: 'q-only-id-2026-04-23' as AtomId,
        prompt: '',
      },
    });
    await runActor(actor, {
      host,
      principal: samplePrincipal({ id: 'cto-actor' as PrincipalId }),
      adapters: {},
      budget: { maxIterations: 2 },
      origin: 'operator',
    });
    const plan = (await host.atoms.query({ type: ['plan'] }, 10)).atoms[0]!;
    expect(plan.metadata.question_id).toBe('q-only-id-2026-04-23');
    expect('question_prompt' in plan.metadata).toBe(false);
  });

  it('originatingQuestion: only prompt populated -> question_prompt present, question_id absent', async () => {
    const host = await seedHost();
    const actor = new PlanningActor({
      request: 'asymmetric edge: prompt known, id missing',
      judgment: stubJudgment(
        { kind: 'greenfield', rationale: 'x', applicableDirectives: [DIR_ATOM] },
        [planOne({ title: 'Plan Prompt-Only' })],
      ),
      originatingQuestion: {
        id: '' as AtomId,
        prompt: 'Do the thing described in this verbatim prompt.',
      },
    });
    await runActor(actor, {
      host,
      principal: samplePrincipal({ id: 'cto-actor' as PrincipalId }),
      adapters: {},
      budget: { maxIterations: 2 },
      origin: 'operator',
    });
    const plan = (await host.atoms.query({ type: ['plan'] }, 10)).atoms[0]!;
    expect(plan.metadata.question_prompt).toBe(
      'Do the thing described in this verbatim prompt.',
    );
    expect('question_id' in plan.metadata).toBe(false);
  });

  it('renders principles + alternatives + what-breaks into the plan body', async () => {
    const host = await seedHost();
    const actor = new PlanningActor({
      request: 'how to Z',
      judgment: stubJudgment(
        { kind: 'greenfield', rationale: 'x', applicableDirectives: [DIR_ATOM] },
        [planOne({
          alternativesRejected: [
            { option: 'Skip Z', reason: 'violates dev-right-over-easy' },
            { option: 'Outsource Z', reason: 'substrate concern' },
          ],
          whatBreaksIfRevisit: 'Two-week cleanup if reversed.',
        })],
      ),
    });
    await runActor(actor, {
      host,
      principal: samplePrincipal({ id: 'cto-actor' as PrincipalId }),
      adapters: {},
      budget: { maxIterations: 2 },
      origin: 'operator',
    });
    const all = await host.atoms.query({ type: ['plan'] }, 10);
    const body = all.atoms[0]!.content;
    expect(body).toContain('Skip Z');
    expect(body).toContain('violates dev-right-over-easy');
    expect(body).toContain('Two-week cleanup');
    expect(body).toContain('Principles applied');
    expect(body).toContain('Alternatives considered');
    expect(body).toContain('What breaks if we revisit');
  });
});
