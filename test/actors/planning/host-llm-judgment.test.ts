/**
 * HostLlmPlanningJudgment tests.
 *
 * Verifies the judgment's behavior via a MemoryLLM stub: register canned
 * judge responses keyed on (system prompt, data, schema) and assert:
 *
 *   - classify happy path returns the expected kind + directives
 *   - classify LLM failure -> synthetic 'ambiguous' classification
 *   - classify output with invented directive ids gets scrubbed
 *   - draft happy path returns N plans, each cites >= 1 real atom
 *   - draft rejects plans that only cite invented ids (no uncited atoms leak)
 *   - draft filters plans below minConfidence
 *   - draft returns a missing-judgment escalation when all plans drop
 *   - draft LLM failure -> single missing-judgment plan
 *
 * These tests drive the judgment directly (not via runActor) so the
 * assertion surface is the judgment's contract, not the actor loop.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import { HostLlmPlanningJudgment } from '../../../src/actors/planning/host-llm-judgment.js';
import { PLAN_CLASSIFY, PLAN_DRAFT } from '../../../src/schemas/index.js';
import type {
  PlanningClassification,
  PlanningContext,
} from '../../../src/actors/planning/types.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../src/types.js';

function atomAt(
  id: string,
  type: 'directive' | 'decision' | 'observation' | 'plan',
  layer: 'L0' | 'L1' | 'L2' | 'L3',
  content: string,
  metadata: Record<string, unknown> = {},
): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content,
    type,
    layer,
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'test', agent_id: 'test' },
      derived_from: [],
    },
    confidence: 1,
    created_at: '2026-04-19T00:00:00.000Z' as Time,
    last_reinforced_at: '2026-04-19T00:00:00.000Z' as Time,
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
    principal_id: 'apex-agent' as PrincipalId,
    taint: 'clean',
    metadata,
  };
}

function makeContext(overrides: Partial<PlanningContext> = {}): PlanningContext {
  const base: PlanningContext = {
    request: 'Should we ship the auditor role?',
    directives: [
      atomAt(
        'dev-extreme-rigor',
        'directive',
        'L3',
        'Development decisions require extreme rigor and research before shipping.',
      ),
      atomAt(
        'dev-kill-switch-first',
        'directive',
        'L3',
        'Design the kill switch before moving the autonomy dial.',
      ),
    ],
    decisions: [
      atomAt(
        'D13',
        'decision',
        'L3',
        'No auto-merge until the medium-tier kill switch ships.',
      ),
    ],
    relevantAtoms: [
      atomAt(
        'obs-auditor-need',
        'observation',
        'L1',
        'Operator noted that recommendations without a runner drift stale.',
      ),
    ],
    openPlans: [],
    relevantPrincipals: [
      { id: 'cto-actor' as PrincipalId, role: 'agent', signed_by: 'claude-agent' as PrincipalId },
    ],
    selfContext: [],
    gatheredAt: '2026-04-19T00:00:00.000Z' as Time,
  };
  return { ...base, ...overrides };
}

function renderDataForJudge(context: PlanningContext): Record<string, unknown> {
  // Mirror the internal renderContextForJudge; must match exactly so
  // the MemoryLLM response is keyed the same way.
  const renderAtom = (a: Atom) => {
    const title = typeof a.metadata?.title === 'string' ? (a.metadata.title as string) : undefined;
    return {
      id: String(a.id),
      type: a.type,
      layer: a.layer,
      confidence: a.confidence,
      content: a.content,
      principal_id: String(a.principal_id),
      ...(title !== undefined ? { title } : {}),
    };
  };
  return {
    request: context.request,
    gathered_at: context.gatheredAt,
    directives: context.directives.map(renderAtom),
    decisions: context.decisions.map(renderAtom),
    relevant_atoms: context.relevantAtoms.map(renderAtom),
    open_plans: context.openPlans.map((a) => ({
      id: String(a.id),
      title: typeof a.metadata?.title === 'string' ? (a.metadata.title as string) : '(untitled)',
      plan_state: String(a.metadata?.plan_state ?? 'unknown'),
      content: a.content,
    })),
    principals: context.relevantPrincipals.map((p) => ({
      id: String(p.id),
      role: p.role,
      signed_by: p.signed_by === null ? null : String(p.signed_by),
    })),
    self_context: context.selfContext.map(renderAtom),
  };
}

describe('HostLlmPlanningJudgment', () => {
  describe('classify', () => {
    it('returns the LLM-supplied classification on happy path', async () => {
      const host = createMemoryHost();
      const context = makeContext();
      const data = renderDataForJudge(context);
      host.llm.register(PLAN_CLASSIFY.jsonSchema, PLAN_CLASSIFY.systemPrompt, data, {
        kind: 'greenfield',
        rationale: 'The auditor role has no prior implementation to modify.',
        applicable_directives: ['dev-extreme-rigor', 'dev-kill-switch-first'],
      });
      const judgment = new HostLlmPlanningJudgment(host, { classifyModel: 'test-model', draftModel: 'test-model' });

      const classification = await judgment.classify(context);
      expect(classification.kind).toBe('greenfield');
      expect(classification.rationale).toMatch(/auditor/);
      expect(classification.applicableDirectives).toEqual([
        'dev-extreme-rigor',
        'dev-kill-switch-first',
      ]);
    });

    it('scrubs invented directive ids out of applicableDirectives', async () => {
      const host = createMemoryHost();
      const context = makeContext();
      const data = renderDataForJudge(context);
      host.llm.register(PLAN_CLASSIFY.jsonSchema, PLAN_CLASSIFY.systemPrompt, data, {
        kind: 'modification',
        rationale: 'cites a real directive and a hallucinated one',
        applicable_directives: ['dev-extreme-rigor', 'dev-invented-directive-xyz'],
      });
      const judgment = new HostLlmPlanningJudgment(host, { classifyModel: 'test-model', draftModel: 'test-model' });

      const classification = await judgment.classify(context);
      expect(classification.applicableDirectives).toEqual(['dev-extreme-rigor']);
    });

    it('falls back to ambiguous when the judge throws', async () => {
      const host = createMemoryHost();
      const context = makeContext();
      // No register() call -> MemoryLLM throws UnsupportedError.
      const judgment = new HostLlmPlanningJudgment(host, { classifyModel: 'test-model', draftModel: 'test-model' });

      const classification = await judgment.classify(context);
      expect(classification.kind).toBe('ambiguous');
      expect(classification.rationale).toMatch(/LLM classification failed/);
      expect(classification.applicableDirectives).toEqual([]);
    });
  });

  describe('draft', () => {
    const classification: PlanningClassification = {
      kind: 'greenfield',
      rationale: 'new role',
      applicableDirectives: ['dev-extreme-rigor'] as unknown as ReadonlyArray<AtomId>,
    };

    function classifiedData(context: PlanningContext): Record<string, unknown> {
      return {
        ...renderDataForJudge(context),
        classification: {
          kind: classification.kind,
          rationale: classification.rationale,
          applicable_directives: [...classification.applicableDirectives],
        },
      };
    }

    it('returns cleaned plans on happy path', async () => {
      const host = createMemoryHost();
      const context = makeContext();
      host.llm.register(PLAN_DRAFT.jsonSchema, PLAN_DRAFT.systemPrompt, classifiedData(context), {
        plans: [
          {
            title: 'Ship auditor as a PlanningActor instance',
            body: '## Plan body...',
            derived_from: ['dev-extreme-rigor', 'D13'],
            principles_applied: ['dev-extreme-rigor'],
            alternatives_rejected: [
              { option: 'Wait', reason: 'Drift accumulates without a runner.' },
            ],
            what_breaks_if_revisit: 'None: auditor is superseded when it is.',
            confidence: 0.8,
            delegation: {
              sub_actor_principal_id: 'code-author',
              reason: 'Requires implementing new PlanningActor role.',
              implied_blast_radius: 'framework',
            },
          },
        ],
      });
      const judgment = new HostLlmPlanningJudgment(host, { classifyModel: 'test-model', draftModel: 'test-model' });

      const plans = await judgment.draft(context, classification);
      expect(plans).toHaveLength(1);
      expect(plans[0]!.title).toMatch(/auditor/);
      expect(plans[0]!.derivedFrom).toEqual(['dev-extreme-rigor', 'D13']);
      expect(plans[0]!.confidence).toBe(0.8);
      // Regression for the wiring gap that dropped delegation between
      // PLAN_DRAFT JSON and ProposedPlan: every field the schema
      // requires must round-trip into the cleaned plan, otherwise the
      // downstream apply() can never write metadata.delegation onto
      // the plan atom and the autonomous-intent approval tick has
      // nothing to gate against.
      expect(plans[0]!.delegation).toEqual({
        sub_actor_principal_id: 'code-author',
        reason: 'Requires implementing new PlanningActor role.',
        implied_blast_radius: 'framework',
      });
    });

    it('drops plans that only cite invented atom ids', async () => {
      const host = createMemoryHost();
      const context = makeContext();
      host.llm.register(PLAN_DRAFT.jsonSchema, PLAN_DRAFT.systemPrompt, classifiedData(context), {
        plans: [
          {
            title: 'Good plan',
            body: '...',
            derived_from: ['dev-extreme-rigor'],
            principles_applied: [],
            alternatives_rejected: [{ option: 'Skip', reason: 'invalid' }],
            what_breaks_if_revisit: '...',
            confidence: 0.7,
            delegation: {
              sub_actor_principal_id: 'code-author',
              reason: 'Implement valid plan.',
              implied_blast_radius: 'framework',
            },
          },
          {
            title: 'Invented-citation plan',
            body: '...',
            derived_from: ['dev-hallucinated-atom'],
            principles_applied: [],
            alternatives_rejected: [{ option: 'Skip', reason: 'invalid' }],
            what_breaks_if_revisit: '...',
            confidence: 0.9,
            delegation: {
              sub_actor_principal_id: 'code-author',
              reason: 'Implement plan with hallucinated citation.',
              implied_blast_radius: 'framework',
            },
          },
        ],
      });
      const judgment = new HostLlmPlanningJudgment(host, { classifyModel: 'test-model', draftModel: 'test-model' });

      const plans = await judgment.draft(context, classification);
      expect(plans).toHaveLength(1);
      expect(plans[0]!.title).toBe('Good plan');
    });

    it('filters plans below minConfidence', async () => {
      const host = createMemoryHost();
      const context = makeContext();
      host.llm.register(PLAN_DRAFT.jsonSchema, PLAN_DRAFT.systemPrompt, classifiedData(context), {
        plans: [
          {
            title: 'Confident plan',
            body: '...',
            derived_from: ['dev-extreme-rigor'],
            principles_applied: [],
            alternatives_rejected: [{ option: 'Skip', reason: 'invalid' }],
            what_breaks_if_revisit: '...',
            confidence: 0.8,
            delegation: {
              sub_actor_principal_id: 'code-author',
              reason: 'Implement confident plan with high rigor.',
              implied_blast_radius: 'framework',
            },
          },
          {
            title: 'Shaky plan',
            body: '...',
            derived_from: ['D13'],
            principles_applied: [],
            alternatives_rejected: [{ option: 'Skip', reason: 'invalid' }],
            what_breaks_if_revisit: '...',
            confidence: 0.3,
            delegation: {
              sub_actor_principal_id: 'code-author',
              reason: 'Implement uncertain plan.',
              implied_blast_radius: 'framework',
            },
          },
        ],
      });
      const judgment = new HostLlmPlanningJudgment(host, { classifyModel: 'test-model', draftModel: 'test-model', minConfidence: 0.55 });

      const plans = await judgment.draft(context, classification);
      expect(plans).toHaveLength(1);
      expect(plans[0]!.title).toBe('Confident plan');
    });

    it('returns missing-judgment escalation when every plan drops', async () => {
      const host = createMemoryHost();
      const context = makeContext();
      host.llm.register(PLAN_DRAFT.jsonSchema, PLAN_DRAFT.systemPrompt, classifiedData(context), {
        plans: [
          {
            title: 'Invented only',
            body: '...',
            derived_from: ['dev-totally-made-up'],
            principles_applied: [],
            alternatives_rejected: [{ option: 'Skip', reason: 'invalid' }],
            what_breaks_if_revisit: '...',
            confidence: 0.9,
            delegation: {
              sub_actor_principal_id: 'code-author',
              reason: 'Plan cites only invented directives.',
              implied_blast_radius: 'framework',
            },
          },
        ],
      });
      const judgment = new HostLlmPlanningJudgment(host, { classifyModel: 'test-model', draftModel: 'test-model' });

      const plans = await judgment.draft(context, classification);
      expect(plans).toHaveLength(1);
      expect(plans[0]!.title).toMatch(/Clarify/);
      // The missing-judgment escalation itself must still carry a
      // provenance chain per canon ("every atom carries a source
      // chain, no exceptions"); it falls back to the first directive
      // from the aggregated context.
      expect(plans[0]!.derivedFrom).toEqual(['dev-extreme-rigor']);
      expect(plans[0]!.confidence).toBeLessThan(0.3);
    });

    it('returns missing-judgment escalation when the judge throws', async () => {
      const host = createMemoryHost();
      const context = makeContext();
      // No register -> throws.
      const judgment = new HostLlmPlanningJudgment(host, { classifyModel: 'test-model', draftModel: 'test-model' });

      const plans = await judgment.draft(context, classification);
      expect(plans).toHaveLength(1);
      expect(plans[0]!.title).toMatch(/Clarify/);
      expect(plans[0]!.title).toMatch(/LLM draft failed/);
    });
  });
});
