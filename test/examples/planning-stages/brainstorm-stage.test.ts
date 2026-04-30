/**
 * Reference brainstorm-stage adapter contract tests.
 *
 * The brainstorm-stage adapter is mechanism scaffolding for the first
 * pipeline stage: it exports a PlanningStage value with name
 * "brainstorm-stage", an output zod schema that rejects a negative
 * cost (signed-numeric prompt-injection guard), and an audit() method
 * that flags fabricated cited atom-ids as critical findings.
 *
 * Tests assert the adapter's surface only; the actual LLM-driven loop
 * is wired through a follow-up via stub LLM registration.
 */

import { describe, expect, it } from 'vitest';
import {
  BRAINSTORM_SYSTEM_PROMPT,
  brainstormStage,
} from '../../../examples/planning-stages/brainstorm/index.js';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import type { AtomId, PrincipalId, Time } from '../../../src/types.js';

/**
 * Seed a pipeline atom whose provenance.derived_from is the supplied
 * verified seed-atom set. Brainstorm audit() reads through this atom
 * to recover the authoritative seed set; the helper centralises the
 * boilerplate at N=2 per the duplication-floor canon.
 */
async function seedPipelineAtom(
  host: ReturnType<typeof createMemoryHost>,
  pipelineId: AtomId,
  verifiedSeedAtomIds: ReadonlyArray<AtomId>,
): Promise<void> {
  await host.atoms.put({
    schema_version: 1,
    id: pipelineId,
    content: 'pipeline',
    type: 'pipeline',
    layer: 'L0',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: 'cto-actor' },
      derived_from: verifiedSeedAtomIds,
    },
    confidence: 1.0,
    created_at: '2026-04-28T00:00:00.000Z' as Time,
    last_reinforced_at: '2026-04-28T00:00:00.000Z' as Time,
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
    principal_id: 'cto-actor' as PrincipalId,
    taint: 'clean',
    metadata: {},
  });
}

describe('brainstormStage', () => {
  it('exports a PlanningStage with name "brainstorm-stage"', () => {
    expect(brainstormStage.name).toBe('brainstorm-stage');
  });

  it('audit() flags a fabricated cited atom id as a major (non-blocking) finding', async () => {
    const host = createMemoryHost();
    const pipelineId = 'p-fabricated' as AtomId;
    // Seed a pipeline atom with a non-empty seed set so the
    // fail-closed read does not throw. The cited id is unrelated
    // and unresolvable: the auditor's resolvability check fires.
    await seedPipelineAtom(host, pipelineId, ['seed-atom-x' as AtomId]);
    const findings = await brainstormStage.audit?.(
      {
        open_questions: [],
        alternatives_surveyed: [
          { option: 'foo', rejection_reason: 'cited atom:atom-does-not-exist' },
        ],
        decision_points: [],
        cost_usd: 0,
      },
      {
        host,
        principal: 'brainstorm-actor' as PrincipalId,
        correlationId: 'corr',
        pipelineId,
        stageName: 'brainstorm-stage',
      },
    );
    expect(findings?.some(
      (f) => f.severity === 'major' && f.category === 'fabricated-cited-atom',
    )).toBe(true);
    // Pipeline does NOT halt on a brainstorm citation finding -- the
    // review-stage carries the load-bearing citation fence.
    expect(findings?.some((f) => f.severity === 'critical')).toBe(false);
  });

  // CR PR #244 #3159616312: audit() must fail closed when the pipeline
  // atom is unreadable / missing. Returning an empty seed set silently
  // would let out-of-set citations pass when the authoritative state
  // is unavailable.
  it('audit() fails closed when the pipeline atom is missing', async () => {
    const host = createMemoryHost();
    await expect(
      brainstormStage.audit?.(
        {
          open_questions: [],
          alternatives_surveyed: [
            { option: 'foo', rejection_reason: 'cited atom:something' },
          ],
          decision_points: [],
          cost_usd: 0,
        },
        {
          host,
          principal: 'brainstorm-actor' as PrincipalId,
          correlationId: 'corr',
          pipelineId: 'p-missing' as AtomId,
          stageName: 'brainstorm-stage',
        },
      ),
    ).rejects.toThrow(/pipeline atom .* not found/);
  });

  it('audit() fails closed when the pipeline atom has empty derived_from', async () => {
    const host = createMemoryHost();
    const pipelineId = 'p-empty-derived' as AtomId;
    await seedPipelineAtom(host, pipelineId, []);
    await expect(
      brainstormStage.audit?.(
        {
          open_questions: [],
          alternatives_surveyed: [
            { option: 'foo', rejection_reason: 'cited atom:something' },
          ],
          decision_points: [],
          cost_usd: 0,
        },
        {
          host,
          principal: 'brainstorm-actor' as PrincipalId,
          correlationId: 'corr',
          pipelineId,
          stageName: 'brainstorm-stage',
        },
      ),
    ).rejects.toThrow(/empty provenance.derived_from/);
  });

  it('outputSchema rejects a negative cost', () => {
    const result = brainstormStage.outputSchema?.safeParse({
      open_questions: [],
      alternatives_surveyed: [],
      decision_points: [],
      cost_usd: -1,
    });
    expect(result?.success).toBe(false);
  });

  it('outputSchema rejects an alternative without a rejection_reason', () => {
    const result = brainstormStage.outputSchema?.safeParse({
      open_questions: [],
      alternatives_surveyed: [{ option: 'foo' }],
      decision_points: [],
      cost_usd: 0,
    });
    expect(result?.success).toBe(false);
  });

  it('outputSchema accepts a well-formed payload', () => {
    const result = brainstormStage.outputSchema?.safeParse({
      open_questions: ['why does X?'],
      alternatives_surveyed: [{ option: 'foo', rejection_reason: 'too slow' }],
      decision_points: ['choose X over Y'],
      cost_usd: 0.42,
    });
    expect(result?.success).toBe(true);
  });

  // Substrate-design fix: the brainstorm prompt must constrain
  // citations to the verified seed-atom set. The e2e of the deep
  // planning pipeline halted 100% of the time on first try because
  // the prompt invited the LLM to fabricate plausible-but-invented
  // atom-ids (stage-responsibility-brainstorm, stage-isolation, etc.)
  // that the auditor caught. Tightening the prompt is the cheapest
  // mitigation; structural retry-with-feedback is a separate change.
  describe('BRAINSTORM_SYSTEM_PROMPT (citation guidance)', () => {
    // Brainstorm is exploratory; the prompt instructs the LLM to omit
    // literal atom-id citations entirely. The downstream review-stage
    // carries the load-bearing citation fence (per dev-deep-planning-pipeline).
    it('instructs the LLM that brainstorm is exploratory, not citation-load-bearing', () => {
      expect(BRAINSTORM_SYSTEM_PROMPT).toMatch(/exploratory/i);
    });

    it('instructs the LLM not to include literal atom-id citations', () => {
      expect(BRAINSTORM_SYSTEM_PROMPT).toMatch(/do not include literal atom-id citations|do not include.*atom-id|do NOT include literal atom-id/i);
    });

    it('points the citation-grounding fence at the review-stage', () => {
      expect(BRAINSTORM_SYSTEM_PROMPT).toMatch(/review-stage/i);
    });
  });

  it('runBrainstorm passes the seed-atom set through to the LLM data block', async () => {
    const host = createMemoryHost();
    let captured: { system: string; data: Record<string, unknown> } | null = null;
    host.llm.judge = (async (
      _schema: unknown,
      system: unknown,
      data: unknown,
      _options: unknown,
    ) => {
      captured = {
        system: system as string,
        data: data as Record<string, unknown>,
      };
      return {
        output: {
          open_questions: [],
          alternatives_surveyed: [],
          decision_points: [],
          cost_usd: 0,
        },
        metadata: { latency_ms: 1, cost_usd: 0 },
      };
    }) as typeof host.llm.judge;

    const seedIds = ['atom-one', 'atom-two', 'atom-three'] as ReadonlyArray<AtomId>;
    await brainstormStage.run({
      host,
      principal: 'brainstorm-actor' as PrincipalId,
      correlationId: 'corr',
      priorOutput: null,
      pipelineId: 'p' as AtomId,
      seedAtomIds: seedIds,
    });
    // Audit-trail contract: the data block still carries the verified
    // seed-atom set under a stable key so the post-stage auditor can
    // re-walk citations the LLM may emit despite the prompt's
    // instruction. The prompt itself no longer references a "verified
    // seed atom set" because brainstorm is exploratory and the
    // citation fence has moved to the review-stage.
    expect(captured).not.toBeNull();
    if (captured !== null) {
      const c = captured as { system: string; data: Record<string, unknown> };
      expect(Array.isArray(c.data.verified_seed_atom_ids)).toBe(true);
      expect(c.data.verified_seed_atom_ids).toEqual(seedIds.map(String));
      expect(c.system).toMatch(/exploratory/i);
      // Regression guard: the prompt MUST NOT re-introduce the old
      // hard-constraint "verified seed atom set" wording. The fence
      // moved to the review-stage; brainstorm prose stays exploratory.
      expect(c.system).not.toMatch(/verified seed atom set/i);
    }
  });

  /**
   * Seed a content atom for citation tests at N=2 use-sites
   * (out-of-set + in-set). Centralised per the duplication-floor
   * canon; keeps each test's body focused on the assertion shape
   * rather than the atom-fixture boilerplate.
   */
  async function seedContentAtom(
    host: ReturnType<typeof createMemoryHost>,
    atomId: AtomId,
    content: string,
  ): Promise<void> {
    await host.atoms.put({
      schema_version: 1,
      id: atomId,
      content,
      type: 'observation',
      layer: 'L0',
      provenance: {
        kind: 'agent-observed',
        source: { agent_id: 'test' },
        derived_from: [],
      },
      confidence: 1.0,
      created_at: '2026-04-28T00:00:00.000Z' as Time,
      last_reinforced_at: '2026-04-28T00:00:00.000Z' as Time,
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
      metadata: {},
    });
  }

  // Runtime enforcement (CR PR #244 #3159516661): the audit() must
  // reject a citation that resolves but is NOT in the verified seed-
  // atom set. Prompt-only restraint is insufficient because a model
  // can choose any existing atom and pass resolvability while still
  // ignoring the seed-set contract.
  it('audit() flags a cited atom that resolves but is NOT in the seed set', async () => {
    const host = createMemoryHost();
    const outOfSetId = 'atom-resolvable-but-out-of-seed' as AtomId;
    await seedContentAtom(host, outOfSetId, 'out-of-set seed');
    const inSetId = 'atom-in-the-seed-set' as AtomId;
    const pipelineId = 'pipeline-corr-non-seed-test' as AtomId;
    await seedPipelineAtom(host, pipelineId, [inSetId]);

    const findings = await brainstormStage.audit?.(
      {
        open_questions: [],
        alternatives_surveyed: [
          { option: 'foo', rejection_reason: `cited atom:${outOfSetId}` },
        ],
        decision_points: [],
        cost_usd: 0,
      },
      {
        host,
        principal: 'brainstorm-actor' as PrincipalId,
        correlationId: 'corr',
        pipelineId,
        stageName: 'brainstorm-stage',
      },
    );
    expect(findings?.length).toBeGreaterThan(0);
    expect(findings?.[0]?.severity).toBe('major');
    expect(findings?.[0]?.category).toBe('non-seed-cited-atom');
  });

  it('audit() lets a cited atom in the verified seed set pass', async () => {
    const host = createMemoryHost();
    const inSetId = 'atom-in-seed-and-resolves' as AtomId;
    await seedContentAtom(host, inSetId, 'in-set seed');
    const pipelineId = 'pipeline-corr-in-seed-test' as AtomId;
    await seedPipelineAtom(host, pipelineId, [inSetId]);
    const findings = await brainstormStage.audit?.(
      {
        open_questions: [],
        alternatives_surveyed: [
          { option: 'foo', rejection_reason: `cited atom:${inSetId}` },
        ],
        decision_points: [],
        cost_usd: 0,
      },
      {
        host,
        principal: 'brainstorm-actor' as PrincipalId,
        correlationId: 'corr',
        pipelineId,
        stageName: 'brainstorm-stage',
      },
    );
    expect(findings?.length).toBe(0);
  });

  it('audit() returns no findings when every cited id resolves and is in the seed set', async () => {
    const host = createMemoryHost();
    const seededId = 'observation-real-atom' as AtomId;
    await seedContentAtom(host, seededId, 'seed');
    const pipelineId = 'p-resolves-and-in-seed' as AtomId;
    await seedPipelineAtom(host, pipelineId, [seededId]);
    const findings = await brainstormStage.audit?.(
      {
        open_questions: [],
        alternatives_surveyed: [
          { option: 'foo', rejection_reason: `cited atom:${seededId}` },
        ],
        decision_points: [],
        cost_usd: 0,
      },
      {
        host,
        principal: 'brainstorm-actor' as PrincipalId,
        correlationId: 'corr',
        pipelineId,
        stageName: 'brainstorm-stage',
      },
    );
    expect(findings?.length).toBe(0);
  });
});
