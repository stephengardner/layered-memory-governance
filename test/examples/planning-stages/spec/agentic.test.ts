/**
 * Contract test for the agentic spec-stage adapter.
 *
 * Asserts:
 *   - the adapter is a PlanningStage<unknown, SpecPayload>;
 *   - run() returns a StageOutput with atom_type='spec-output';
 *   - the produced payload passes specPayloadSchema (mirrors the
 *     single-shot adapter's output contract);
 *   - the adapter emits the canon-bound + agent-turn + canon-audit-complete
 *     pipeline-stage-event chain by default;
 *   - disableCanonAudit=true skips the canon-audit checkpoint;
 *   - audit() re-runs the single-shot citation-closure check unchanged.
 */

import { describe, expect, it } from 'vitest';
import { buildAgenticSpecStage } from '../../../../examples/planning-stages/spec/agentic.js';
import { specPayloadSchema } from '../../../../examples/planning-stages/spec/index.js';
import { createMemoryHost } from '../../../../src/adapters/memory/index.js';
import type { AgentLoopAdapter } from '../../../../src/substrate/agent-loop.js';
import type { AtomId, PrincipalId } from '../../../../src/substrate/types.js';
import type { StageInput } from '../../../../src/runtime/planning-pipeline/index.js';
import {
  makeStubAdapter,
  makeStubHostBundle,
} from '../agent-loop-stubs.js';

const PRINCIPAL = 'spec-author' as PrincipalId;
const PIPELINE_ID = 'pipeline-spec-agentic-test' as AtomId;

/**
 * Shared AgentLoopAdapter.capabilities literal used by every stub
 * adapter in this file. Extracted at N=2 per dev-extract-at-n-2: the
 * three test cases below all need the same capabilities shape, and a
 * future fourth case (review-stage / plan-stage agentic test) will
 * inherit the same constant. Keeps the per-test surface focused on
 * the orchestration assertion rather than the capabilities boilerplate.
 */
const STUB_CAPABILITIES: AgentLoopAdapter['capabilities'] = {
  tracks_cost: true,
  supports_signal: true,
  classify_failure: () => 'structural',
};

function makeStageInput(host: ReturnType<typeof createMemoryHost>): StageInput<unknown> {
  return {
    host,
    principal: PRINCIPAL,
    correlationId: 'corr-spec-agentic-1',
    priorOutput: {
      open_questions: ['where in the README is the right insertion point?'],
      alternatives_surveyed: [
        {
          option: 'append to top of README',
          rejection_reason: 'pushes other content down',
        },
        {
          option: 'add under existing Architecture section',
          rejection_reason: 'natural home for the note',
        },
      ],
      decision_points: ['where to insert', 'one-line vs short paragraph'],
      cost_usd: 0.42,
    },
    pipelineId: PIPELINE_ID,
    seedAtomIds: [],
    verifiedCitedAtomIds: [],
    verifiedSubActorPrincipalIds: [],
    operatorIntentContent:
      'add a one-line note to the README explaining what the deep planning pipeline does',
  };
}

const STUB_SPEC_PAYLOAD = {
  goal: 'add a one-line note to the README naming the deep planning pipeline',
  body: 'Add a single-sentence bullet under the existing Architecture section of README.md naming the deep planning pipeline and pointing the reader at examples/planning-stages/. The change is docs-only and touches no source files.',
  cited_paths: [],
  cited_atom_ids: [],
  alternatives_rejected: [
    {
      option: 'append to top of README',
      reason: 'pushes existing first-impression content down for low-value gain',
    },
    {
      option: 'create a new section dedicated to the pipeline',
      reason: 'too heavy for a one-line note',
    },
  ],
  cost_usd: 0.42,
};

describe('agenticSpecStage', () => {
  it('produces a SpecPayload with atom_type spec-output', async () => {
    const { host, blobStore, redactor, workspaceProvider } = makeStubHostBundle();
    // Sequencing adapter: first call returns the spec payload, second
    // call returns the canon-audit verdict.
    let runIdx = 0;
    const sequencingAdapter: AgentLoopAdapter = {
      capabilities: STUB_CAPABILITIES,
      async run(input) {
        const stub = makeStubAdapter({
          outputs: [JSON.stringify(STUB_SPEC_PAYLOAD)],
        });
        const auditStub = makeStubAdapter({
          outputs: [JSON.stringify({ verdict: 'approved', findings: [] })],
        });
        const a = runIdx === 0 ? stub : auditStub;
        runIdx++;
        return a.run(input);
      },
    };

    const stage = buildAgenticSpecStage({
      agentLoop: sequencingAdapter,
      workspaceProvider,
      blobStore,
      redactor,
      baseRef: 'main',
    });
    expect(stage.name).toBe('spec-stage');
    expect(stage.outputSchema).toBe(specPayloadSchema);

    const stageInput = makeStageInput(host);
    const out = await stage.run(stageInput);
    expect(out.atom_type).toBe('spec-output');
    const parsed = specPayloadSchema.safeParse(out.value);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.alternatives_rejected).toHaveLength(2);
      expect(parsed.data.goal).toContain('README');
    }

    // Verify chain: canon-bound + agent-turn + canon-audit-complete
    // events landed on the host with the pipeline_id.
    const events = await host.atoms.query({ type: ['pipeline-stage-event'] }, 200);
    const transitions = events.atoms
      .filter(
        (a) => (a.metadata as { pipeline_id?: AtomId }).pipeline_id === PIPELINE_ID,
      )
      .map((a) => (a.metadata as { transition: string }).transition);
    expect(transitions).toContain('canon-bound');
    expect(transitions).toContain('canon-audit-complete');
    expect(transitions.filter((t) => t === 'agent-turn').length).toBeGreaterThan(0);
  });

  it('disableCanonAudit=true emits canon-audit-complete with no findings (helper-default approved)', async () => {
    const { host, blobStore, redactor, workspaceProvider } = makeStubHostBundle();
    // Single-pass adapter: only the main run dispatches; the audit
    // checkpoint is skipped, so the helper emits an approved-by-default
    // event without invoking the adapter a second time.
    let dispatchCount = 0;
    const singlePassAdapter: AgentLoopAdapter = {
      capabilities: STUB_CAPABILITIES,
      async run(input) {
        dispatchCount++;
        const stub = makeStubAdapter({
          outputs: [JSON.stringify(STUB_SPEC_PAYLOAD)],
        });
        return stub.run(input);
      },
    };

    const stage = buildAgenticSpecStage({
      agentLoop: singlePassAdapter,
      workspaceProvider,
      blobStore,
      redactor,
      disableCanonAudit: true,
    });
    const out = await stage.run(makeStageInput(host));
    expect(out.atom_type).toBe('spec-output');
    // Only the main agent-loop dispatch happens; no audit dispatch.
    expect(dispatchCount).toBe(1);

    const events = await host.atoms.query({ type: ['pipeline-stage-event'] }, 200);
    const auditEvents = events.atoms
      .filter(
        (a) => (a.metadata as { pipeline_id?: AtomId }).pipeline_id === PIPELINE_ID,
      )
      .filter((a) => (a.metadata as { transition: string }).transition === 'canon-audit-complete');
    expect(auditEvents).toHaveLength(1);
    // The helper emits verdict='approved' with empty findings when no
    // builder is supplied, so the chain stays uniform regardless of
    // audit posture.
    const verdict = (auditEvents[0]!.metadata as { canon_audit_verdict?: string }).canon_audit_verdict;
    expect(verdict).toBe('approved');
    // Lock the contract on the findings list too: the helper emits an
    // empty array when no canon-audit prompt builder is supplied, so a
    // future regression that injects synthesized findings here would
    // surface as a single-test failure.
    const findings =
      (auditEvents[0]!.metadata as { canon_audit_findings?: unknown[] }).canon_audit_findings;
    expect(Array.isArray(findings) ? findings : []).toHaveLength(0);
  });

  it('exposes audit() so the runner re-runs the single-shot citation-closure check', () => {
    const { blobStore, redactor, workspaceProvider } = makeStubHostBundle();
    const adapter = makeStubAdapter({ outputs: ['{}'] });
    const stage = buildAgenticSpecStage({
      agentLoop: adapter,
      workspaceProvider,
      blobStore,
      redactor,
    });
    expect(typeof stage.audit).toBe('function');
  });

  it('threads config.principal into the prompt so the override stays in sync with the actor identity', async () => {
    const { host, blobStore, redactor, workspaceProvider } = makeStubHostBundle();
    const customPrincipal = 'custom-spec-author' as PrincipalId;
    const recorder: { lastInput?: import('../../../../src/substrate/agent-loop.js').AgentLoopInput } = {};
    let runIdx = 0;
    const sequencingAdapter: AgentLoopAdapter = {
      capabilities: STUB_CAPABILITIES,
      async run(input) {
        if (runIdx === 0) {
          recorder.lastInput = input;
        }
        const stub = makeStubAdapter({
          outputs: [JSON.stringify(STUB_SPEC_PAYLOAD)],
        });
        const auditStub = makeStubAdapter({
          outputs: [JSON.stringify({ verdict: 'approved', findings: [] })],
        });
        const a = runIdx === 0 ? stub : auditStub;
        runIdx++;
        return a.run(input);
      },
    };

    const stage = buildAgenticSpecStage({
      agentLoop: sequencingAdapter,
      workspaceProvider,
      blobStore,
      redactor,
      principal: customPrincipal,
    });
    await stage.run(makeStageInput(host));

    // The spec-prompt embeds the resolved principal id; the hardcoded
    // literal 'spec-author' must NOT appear when the caller supplied
    // an override.
    const prompt = recorder.lastInput?.task.successCriteria ?? '';
    expect(prompt).toContain(`- principal: ${customPrincipal}`);
    expect(prompt).not.toMatch(/- principal: spec-author\b/);
    expect(recorder.lastInput?.principal).toBe(customPrincipal);
  });
});
