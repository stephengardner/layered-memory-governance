/**
 * Scenario s13: whole-system end-to-end trajectory.
 *
 * One test that exercises every load-bearing primitive in LAG:
 *
 *   1. Seed a two-principal org: operator (root) + two agents
 *      (signed_by operator).
 *   2. Operator seeds an L3 canon invariant.
 *   3. Agent proposes a plan that CONFLICTS with canon; validatePlan
 *      blocks; plan transitions to 'abandoned'.
 *   4. Agent proposes a second plan that aligns with canon; validate
 *      clean; transitions to 'approved'.
 *   5. executePlan runs with a user-provided run() that succeeds
 *      with outcome atoms.
 *   6. Outcome atoms land at L1 with derived_from: [plan_id].
 *   7. Two agents separately write L1 atoms reinforcing the same
 *      downstream claim (via independent extraction from L0 sources).
 *   8. Promotion engine lifts that L1 claim to L2 (consensus).
 *   9. Audit trail reconstructs the full trajectory.
 *
 * This is the "LAG in one test" proof: all primitives compose, with
 * provenance surviving from L0 source material through plan
 * validation, execution, outcomes, and re-promotion.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { DETECT_SCHEMA, DETECT_SYSTEM } from '../../src/arbitration/index.js';
import { executePlan, transitionPlanState, validatePlan } from '../../src/plans/index.js';
import { runExtractionPass } from '../../src/extraction/index.js';
import { PromotionEngine } from '../../src/promotion/index.js';
import { EXTRACT_CLAIMS, type ExtractClaimsOutput } from '../../src/schemas/index.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../src/substrate/types.js';
import { sampleAtom, samplePrincipal } from '../fixtures.js';

const operator = 'stephen-human' as PrincipalId;
const alice = 'agent-alice' as PrincipalId;
const bob = 'agent-bob' as PrincipalId;
const FIXED = '2026-04-19T00:00:00.000Z' as Time;

function registerJudge(
  host: ReturnType<typeof createMemoryHost>,
  a: Atom,
  b: Atom,
  response: { kind: 'semantic' | 'temporal' | 'none'; explanation: string },
) {
  host.llm.register(
    DETECT_SCHEMA,
    DETECT_SYSTEM,
    {
      atom_a: { content: a.content, type: a.type, layer: a.layer, created_at: a.created_at },
      atom_b: { content: b.content, type: b.type, layer: b.layer, created_at: b.created_at },
    },
    response,
  );
}

function registerExtract(
  host: ReturnType<typeof createMemoryHost>,
  atom: Atom,
  out: ExtractClaimsOutput,
) {
  host.llm.register(
    EXTRACT_CLAIMS.jsonSchema,
    EXTRACT_CLAIMS.systemPrompt,
    { content: atom.content, type: atom.type, layer: atom.layer },
    out,
  );
}

describe('s13: whole-system end-to-end trajectory', () => {
  it('seed -> propose -> validate -> approve -> execute -> outcomes -> promote -> audit', async () => {
    const host = createMemoryHost();

    // 1. Two-principal org.
    await host.principals.put(samplePrincipal({ id: operator, role: 'user', signed_by: null, created_at: FIXED }));
    await host.principals.put(samplePrincipal({ id: alice, role: 'agent', signed_by: operator, created_at: FIXED }));
    await host.principals.put(samplePrincipal({ id: bob, role: 'agent', signed_by: operator, created_at: FIXED }));

    // 2. L3 canon invariant from the operator.
    const canon = sampleAtom({
      id: 'canon-structured-logs' as AtomId,
      type: 'directive',
      layer: 'L3',
      content: 'All services emit structured logs.',
      confidence: 1.0,
      principal_id: operator,
      provenance: { kind: 'user-directive', source: {}, derived_from: [] },
      scope: 'global',
      created_at: FIXED,
      last_reinforced_at: FIXED,
    });
    await host.atoms.put(canon);

    // 3. Conflicting plan -> validate blocks -> abandoned.
    const badPlan = sampleAtom({
      id: 'plan-plaintext' as AtomId,
      type: 'plan',
      layer: 'L1',
      content: 'Switch billing service to plain-text logs for readability.',
      plan_state: 'proposed',
      principal_id: alice,
      scope: 'global',
      created_at: FIXED,
      last_reinforced_at: FIXED,
    });
    await host.atoms.put(badPlan);
    registerJudge(host, badPlan, canon, {
      kind: 'semantic',
      explanation: 'Plan contradicts the structured-logs invariant.',
    });
    const badValidation = await validatePlan(badPlan, host, { principalId: operator });
    expect(badValidation.status).toBe('conflicts');
    await transitionPlanState(badPlan.id, 'abandoned', host, operator, 'contradicts canon');

    // 4. Compliant plan -> validate clean -> approved.
    const goodPlan = sampleAtom({
      id: 'plan-extend' as AtomId,
      type: 'plan',
      layer: 'L1',
      content: 'Add request_id to every structured log line in billing service.',
      plan_state: 'proposed',
      principal_id: alice,
      scope: 'global',
      created_at: FIXED,
      last_reinforced_at: FIXED,
    });
    await host.atoms.put(goodPlan);
    registerJudge(host, goodPlan, canon, {
      kind: 'none',
      explanation: 'Plan extends structured logging; compatible.',
    });
    const goodValidation = await validatePlan(goodPlan, host, { principalId: operator });
    expect(goodValidation.status).toBe('clean');
    const approvedPlan = await transitionPlanState(goodPlan.id, 'approved', host, operator, 'HIL approved');

    // 5. Execute with user-provided run() producing outcome atoms.
    const execReport = await executePlan(approvedPlan, host, {
      principalId: alice,
      run: async () => ({
        ok: true,
        outcomes: [
          { content: 'Billing service now emits request_id on every structured log line.', confidence: 0.95 },
        ],
      }),
    });
    expect(execReport.terminalState).toBe('succeeded');
    expect(execReport.outcomesWritten).toHaveLength(1);

    // 6. Outcome atom has derived_from pointing to the plan.
    const outcomeId = execReport.outcomesWritten[0]!;
    const outcome = await host.atoms.get(outcomeId);
    expect(outcome?.provenance.derived_from).toContain(goodPlan.id);

    // 7. Two independent agents later write L1 atoms reinforcing the
    //    outcome via extraction from separate L0 transcripts.
    const aliceL0 = sampleAtom({
      id: 'l0-alice-tx' as AtomId,
      type: 'observation',
      layer: 'L0',
      content: 'Alice notes: billing logs now have request_id.',
      principal_id: alice,
      created_at: FIXED,
      last_reinforced_at: FIXED,
    });
    const bobL0 = sampleAtom({
      id: 'l0-bob-tx' as AtomId,
      type: 'observation',
      layer: 'L0',
      content: 'Bob confirmed: request_id present in staging billing logs.',
      principal_id: bob,
      created_at: FIXED,
      last_reinforced_at: FIXED,
    });
    await host.atoms.put(aliceL0);
    await host.atoms.put(bobL0);

    const sharedClaim = 'Billing logs include request_id.';
    registerExtract(host, aliceL0, {
      claims: [{ type: 'observation', content: sharedClaim, confidence: 0.9 }],
    });
    registerExtract(host, bobL0, {
      claims: [{ type: 'observation', content: sharedClaim, confidence: 0.88 }],
    });
    const extractionReport = await runExtractionPass(host, { principalId: operator });
    expect(extractionReport.sourcesExtracted).toBe(2);
    // Each source writes an L1 atom; different source-prefixed ids.
    expect(extractionReport.totalClaimsWritten).toBe(2);

    // 8. Promotion: two L1 atoms with same content hash from distinct
    //    principals -> consensus -> L2 canon-promoted atom.
    const engine = new PromotionEngine(host, { principalId: operator });
    const outcomes = await engine.runPass('L2');
    const promoted = outcomes.filter((o) => o.kind === 'promoted');
    expect(promoted).toHaveLength(1);
    const l2 = await host.atoms.query({ layer: ['L2'] }, 10);
    expect(l2.atoms).toHaveLength(1);
    expect(l2.atoms[0]!.content).toBe(sharedClaim);
    expect(l2.atoms[0]!.provenance.kind).toBe('canon-promoted');

    // 9. Audit trail reconstructs the trajectory: plan.state_transition
    //    events (abandoned, approved, executing, succeeded) + execution
    //    event + extraction events + promotion event.
    const transitions = await host.auditor.query({ kind: ['plan.state_transition'] }, 100);
    expect(transitions.length).toBeGreaterThanOrEqual(4); // 1 abandoned + 3 for goodPlan
    const executions = await host.auditor.query({ kind: ['plan.executed'] }, 100);
    expect(executions).toHaveLength(1);
    const extractions = await host.auditor.query({ kind: ['extraction.applied'] }, 100);
    expect(extractions.length).toBeGreaterThanOrEqual(2);
    const promotions = await host.auditor.query({ kind: ['promotion.applied'] }, 100);
    expect(promotions.length).toBeGreaterThanOrEqual(1);

    // Final state summary: L3 canon (seed) still present; L2 new
    // consensus observation; abandoned + succeeded plans; all outcome
    // + L1 atoms pointing back to their sources.
    const allAtoms = await host.atoms.query({ superseded: true }, 100);
    const layerCounts = new Map<string, number>();
    for (const a of allAtoms.atoms) {
      layerCounts.set(a.layer, (layerCounts.get(a.layer) ?? 0) + 1);
    }
    // Expect at least: 1 L3 (canon), 1 L2 (promoted), 2 L1 (extracted) +
    // 1 outcome L1 + 2 plans, 2 L0.
    expect(layerCounts.get('L3')).toBeGreaterThanOrEqual(1);
    expect(layerCounts.get('L2')).toBeGreaterThanOrEqual(1);
    expect(layerCounts.get('L1')).toBeGreaterThanOrEqual(3); // 2 extracted + outcome
    expect(layerCounts.get('L0')).toBeGreaterThanOrEqual(2);
  });
});
