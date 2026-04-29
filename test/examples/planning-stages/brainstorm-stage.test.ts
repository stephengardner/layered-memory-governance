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
import { brainstormStage } from '../../../examples/planning-stages/brainstorm/index.js';
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
