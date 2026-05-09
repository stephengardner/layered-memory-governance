/**
 * Drift tests for scripts/bootstrap-pipeline-reaper-canon.mjs.
 *
 * The POLICIES array (built via buildPolicies) seeds the L3 directive
 * atom `pol-pipeline-reaper-ttls-default` whose runtime behavior is
 * consumed by `readPipelineReaperTtlsFromCanon` in
 * src/runtime/loop/pipeline-reaper-ttls.ts and fall-through-validated
 * against `DEFAULT_PIPELINE_REAPER_TTLS` in
 * src/runtime/plans/pipeline-reaper.ts. Keeping seed and runtime
 * fallback in sync is load-bearing: a deployment that never runs the
 * bootstrap gets the runtime fallback at every tick, and a silent
 * divergence (e.g. seed says terminal=14d but
 * DEFAULT_PIPELINE_REAPER_TTLS drifted to 30d) means the policy the
 * operator thinks they have differs from what runs.
 *
 * These tests lock the two together. A drift is a test failure, not a
 * silent runtime surprise.
 *
 * Covers:
 *   - buildPolicies returns the expected stable set of ids.
 *   - pol-pipeline-reaper-ttls-default fields match
 *     DEFAULT_PIPELINE_REAPER_TTLS exactly.
 *   - policyAtom() shape is a well-formed L3 directive with
 *     metadata.policy.subject='pipeline-reaper-ttls'.
 */

import { describe, expect, it } from 'vitest';

import {
  buildPolicies,
  policyAtom,
} from '../../scripts/lib/pipeline-reaper-canon-policies.mjs';
import { DEFAULT_PIPELINE_REAPER_TTLS } from '../../src/runtime/plans/pipeline-reaper.js';

const OP = 'test-operator';

describe('bootstrap-pipeline-reaper-canon POLICIES', () => {
  it('returns the expected stable set of policy ids', () => {
    const policies = buildPolicies(OP);
    const ids = policies.map((p: { id: string }) => p.id).sort();
    expect(ids).toEqual(['pol-pipeline-reaper-ttls-default']);
  });

  it('pol-pipeline-reaper-ttls-default fields match DEFAULT_PIPELINE_REAPER_TTLS exactly', () => {
    // Drift guard: if someone edits buildPolicies OR
    // DEFAULT_PIPELINE_REAPER_TTLS in isolation, this test catches it
    // before a tenant's runtime diverges from their seeded canon. The
    // seed carries metadata.policy.terminal_pipeline_ms /
    // hil_paused_pipeline_ms / agent_session_ms; the runtime fallback
    // uses terminalPipelineMs / hilPausedPipelineMs / agentSessionMs.
    // The reader translates between the two; this test asserts the
    // values match.
    const policies = buildPolicies(OP);
    const spec = policies.find(
      (p: { id: string }) => p.id === 'pol-pipeline-reaper-ttls-default',
    );
    expect(spec).toBeDefined();
    expect(spec!.subject).toBe('pipeline-reaper-ttls');
    const fields = spec!.fields as {
      terminal_pipeline_ms: number;
      hil_paused_pipeline_ms: number;
      agent_session_ms: number;
    };
    expect(fields.terminal_pipeline_ms).toBe(DEFAULT_PIPELINE_REAPER_TTLS.terminalPipelineMs);
    expect(fields.hil_paused_pipeline_ms).toBe(DEFAULT_PIPELINE_REAPER_TTLS.hilPausedPipelineMs);
    expect(fields.agent_session_ms).toBe(DEFAULT_PIPELINE_REAPER_TTLS.agentSessionMs);
  });

  it('policyAtom shape is a well-formed L3 directive with metadata.policy', () => {
    const policies = buildPolicies(OP);
    const spec = policies[0]!;
    const atom = policyAtom(spec, OP);
    expect(atom.id).toBe('pol-pipeline-reaper-ttls-default');
    expect(atom.type).toBe('directive');
    expect(atom.layer).toBe('L3');
    expect(atom.principal_id).toBe(OP);
    expect(atom.taint).toBe('clean');
    expect(atom.scope).toBe('project');
    expect(atom.confidence).toBe(1.0);
    expect(atom.supersedes).toEqual([]);
    expect(atom.superseded_by).toEqual([]);
    expect(atom.provenance.kind).toBe('operator-seeded');
    const meta = atom.metadata as {
      policy: {
        subject: string;
        terminal_pipeline_ms: number;
        hil_paused_pipeline_ms: number;
        agent_session_ms: number;
      };
    };
    expect(meta.policy.subject).toBe('pipeline-reaper-ttls');
    expect(meta.policy.terminal_pipeline_ms).toBe(
      DEFAULT_PIPELINE_REAPER_TTLS.terminalPipelineMs,
    );
    expect(meta.policy.hil_paused_pipeline_ms).toBe(
      DEFAULT_PIPELINE_REAPER_TTLS.hilPausedPipelineMs,
    );
    expect(meta.policy.agent_session_ms).toBe(DEFAULT_PIPELINE_REAPER_TTLS.agentSessionMs);
  });
});
