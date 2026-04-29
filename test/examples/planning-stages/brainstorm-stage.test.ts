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
import type { AtomId, PrincipalId } from '../../../src/types.js';

describe('brainstormStage', () => {
  it('exports a PlanningStage with name "brainstorm-stage"', () => {
    expect(brainstormStage.name).toBe('brainstorm-stage');
  });

  it('audit() flags a fabricated cited atom id as critical', async () => {
    const host = createMemoryHost();
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
        pipelineId: 'p' as AtomId,
        stageName: 'brainstorm-stage',
      },
    );
    expect(findings?.some((f) => f.severity === 'critical')).toBe(true);
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
  describe('BRAINSTORM_SYSTEM_PROMPT (citation-grounding)', () => {
    it('mentions a verified seed atom set the LLM is constrained to', () => {
      // The exact wording is intentional surface: a follow-up that
      // weakens this guidance must update both the prompt AND this
      // assertion. The pair is the gate.
      expect(BRAINSTORM_SYSTEM_PROMPT).toMatch(/verified seed atom set/i);
    });

    it('instructs the LLM to omit a citation rather than guess', () => {
      expect(BRAINSTORM_SYSTEM_PROMPT).toMatch(/omit/i);
    });

    it('asks the LLM to walk every emitted atom-id against the verified set', () => {
      expect(BRAINSTORM_SYSTEM_PROMPT).toMatch(/walk|verify|self-check/i);
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
    // Prompt-grounding contract: the data block carries the verified
    // seed-atom set under a stable key so the LLM has a templated
    // DATA reference for the prompt's "verified seed atom set"
    // language.
    expect(captured).not.toBeNull();
    if (captured !== null) {
      const c = captured as { system: string; data: Record<string, unknown> };
      expect(Array.isArray(c.data.verified_seed_atom_ids)).toBe(true);
      expect(c.data.verified_seed_atom_ids).toEqual(seedIds.map(String));
      expect(c.system).toMatch(/verified seed atom set/i);
    }
  });

  // Runtime enforcement (CR PR #244 #3159516661): the audit() must
  // reject a citation that resolves but is NOT in the verified seed-
  // atom set. Prompt-only restraint is insufficient because a model
  // can choose any existing atom and pass resolvability while still
  // ignoring the seed-set contract.
  it('audit() flags a cited atom that resolves but is NOT in the seed set', async () => {
    const host = createMemoryHost();
    // Seed an atom that resolves but is NOT in the pipeline's seed set.
    const outOfSetId = 'atom-resolvable-but-out-of-seed' as AtomId;
    await host.atoms.put({
      schema_version: 1,
      id: outOfSetId,
      content: 'out-of-set seed',
      type: 'observation',
      layer: 'L0',
      provenance: {
        kind: 'agent-observed',
        source: { agent_id: 'test' },
        derived_from: [],
      },
      confidence: 1.0,
      created_at: '2026-04-28T00:00:00.000Z',
      last_reinforced_at: '2026-04-28T00:00:00.000Z',
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
    // Seed a pipeline atom whose derived_from is the verified seed set;
    // this atom does NOT include outOfSetId, so the audit must catch
    // a citation of outOfSetId as non-seed.
    const inSetId = 'atom-in-the-seed-set' as AtomId;
    const pipelineId = 'pipeline-corr-non-seed-test' as AtomId;
    await host.atoms.put({
      schema_version: 1,
      id: pipelineId,
      content: 'pipeline',
      type: 'pipeline',
      layer: 'L0',
      provenance: {
        kind: 'agent-observed',
        source: { agent_id: 'cto-actor' },
        derived_from: [inSetId],
      },
      confidence: 1.0,
      created_at: '2026-04-28T00:00:00.000Z',
      last_reinforced_at: '2026-04-28T00:00:00.000Z',
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
    expect(findings?.[0]?.severity).toBe('critical');
    expect(findings?.[0]?.category).toBe('non-seed-cited-atom');
  });

  it('audit() lets a cited atom in the verified seed set pass', async () => {
    const host = createMemoryHost();
    const inSetId = 'atom-in-seed-and-resolves' as AtomId;
    await host.atoms.put({
      schema_version: 1,
      id: inSetId,
      content: 'in-set seed',
      type: 'observation',
      layer: 'L0',
      provenance: {
        kind: 'agent-observed',
        source: { agent_id: 'test' },
        derived_from: [],
      },
      confidence: 1.0,
      created_at: '2026-04-28T00:00:00.000Z',
      last_reinforced_at: '2026-04-28T00:00:00.000Z',
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
    const pipelineId = 'pipeline-corr-in-seed-test' as AtomId;
    await host.atoms.put({
      schema_version: 1,
      id: pipelineId,
      content: 'pipeline',
      type: 'pipeline',
      layer: 'L0',
      provenance: {
        kind: 'agent-observed',
        source: { agent_id: 'cto-actor' },
        derived_from: [inSetId],
      },
      confidence: 1.0,
      created_at: '2026-04-28T00:00:00.000Z',
      last_reinforced_at: '2026-04-28T00:00:00.000Z',
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

  it('audit() returns no findings when every cited id resolves', async () => {
    const host = createMemoryHost();
    // Seed an atom that the brainstorm rejection_reason will cite.
    const seededId = 'observation-real-atom' as AtomId;
    await host.atoms.put({
      schema_version: 1,
      id: seededId,
      content: 'seed',
      type: 'observation',
      layer: 'L0',
      provenance: {
        kind: 'agent-observed',
        source: { agent_id: 'test' },
        derived_from: [],
      },
      confidence: 1.0,
      created_at: '2026-04-28T00:00:00.000Z',
      last_reinforced_at: '2026-04-28T00:00:00.000Z',
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
        pipelineId: 'p' as AtomId,
        stageName: 'brainstorm-stage',
      },
    );
    expect(findings?.length).toBe(0);
  });
});
