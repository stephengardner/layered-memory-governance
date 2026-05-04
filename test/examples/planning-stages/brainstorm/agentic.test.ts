/**
 * Contract test for the agentic brainstorm-stage adapter.
 *
 * Asserts:
 *   - the adapter is a PlanningStage<unknown, BrainstormPayload>;
 *   - run() returns a StageOutput with atom_type='brainstorm-output';
 *   - the produced payload passes brainstormPayloadSchema (mirrors the
 *     single-shot adapter's output contract);
 *   - the adapter emits the canon-bound + agent-turn + canon-audit-complete
 *     pipeline-stage-event chain;
 *   - audit() re-runs the single-shot citation-closure check unchanged.
 */

import { describe, expect, it } from 'vitest';
import { buildAgenticBrainstormStage } from '../../../../examples/planning-stages/brainstorm/agentic.js';
import { brainstormPayloadSchema } from '../../../../examples/planning-stages/brainstorm/index.js';
import { createMemoryHost } from '../../../../src/adapters/memory/index.js';
import type {
  AgentLoopAdapter,
} from '../../../../src/substrate/agent-loop.js';
import type {
  AtomId,
  PrincipalId,
} from '../../../../src/substrate/types.js';
import type { StageInput } from '../../../../src/runtime/planning-pipeline/index.js';
import {
  makeStubAdapter,
  makeStubHostBundle,
} from '../agent-loop-stubs.js';

const PRINCIPAL = 'brainstorm-actor' as PrincipalId;
const PIPELINE_ID = 'pipeline-agentic-test' as AtomId;

function makeStageInput(host: ReturnType<typeof createMemoryHost>): StageInput<unknown> {
  return {
    host,
    principal: PRINCIPAL,
    correlationId: 'corr-agentic-1',
    priorOutput: null,
    pipelineId: PIPELINE_ID,
    seedAtomIds: [],
    verifiedCitedAtomIds: [],
    verifiedSubActorPrincipalIds: [],
    operatorIntentContent:
      'add a one-line note to the README explaining what the deep planning pipeline does',
  };
}

describe('agenticBrainstormStage', () => {
  it('produces a BrainstormPayload with atom_type brainstorm-output', async () => {
    const { host, blobStore, redactor, workspaceProvider } = makeStubHostBundle();
    // Sequencing adapter: first call returns the brainstorm payload,
    // second call returns the canon-audit verdict.
    let runIdx = 0;
    const sequencingAdapter: AgentLoopAdapter = {
      capabilities: {
        tracks_cost: true,
        supports_signal: true,
        classify_failure: () => 'structural',
      },
      async run(input) {
        const stub = makeStubAdapter({
          outputs: [
            JSON.stringify({
              open_questions: [
                'where in the README is the right insertion point?',
              ],
              alternatives_surveyed: [
                {
                  option: 'append to top of README',
                  rejection_reason: 'pushes other content down',
                },
                {
                  option: 'add under existing Architecture section',
                  rejection_reason: 'natural home',
                },
                {
                  option: 'create new section',
                  rejection_reason: 'too heavy for a one-line note',
                },
              ],
              decision_points: ['where to insert', 'one-line vs short paragraph'],
              cost_usd: 0.42,
            }),
          ],
        });
        const auditStub = makeStubAdapter({
          outputs: [JSON.stringify({ verdict: 'approved', findings: [] })],
        });
        const a = runIdx === 0 ? stub : auditStub;
        runIdx++;
        return a.run(input);
      },
    };

    const stage = buildAgenticBrainstormStage({
      agentLoop: sequencingAdapter,
      workspaceProvider,
      blobStore,
      redactor,
      baseRef: 'main',
    });
    expect(stage.name).toBe('brainstorm-stage');
    expect(stage.outputSchema).toBe(brainstormPayloadSchema);

    const stageInput = makeStageInput(host);
    const out = await stage.run(stageInput);
    expect(out.atom_type).toBe('brainstorm-output');
    const parsed = brainstormPayloadSchema.safeParse(out.value);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.alternatives_surveyed).toHaveLength(3);
    }

    // Verify chain.
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

  it('exposes audit() so the runner re-runs the single-shot citation-closure check', () => {
    const { blobStore, redactor, workspaceProvider } = makeStubHostBundle();
    const adapter = makeStubAdapter({ outputs: ['{}'] });
    const stage = buildAgenticBrainstormStage({
      agentLoop: adapter,
      workspaceProvider,
      blobStore,
      redactor,
    });
    expect(typeof stage.audit).toBe('function');
  });

  it('threads config.principal into the prompt so the override stays in sync with the actor identity', async () => {
    const { host, blobStore, redactor, workspaceProvider } = makeStubHostBundle();
    const customPrincipal = 'custom-brainstorm-actor' as PrincipalId;
    const recorder: { lastInput?: import('../../../../src/substrate/agent-loop.js').AgentLoopInput } = {};
    let runIdx = 0;
    const sequencingAdapter: AgentLoopAdapter = {
      capabilities: {
        tracks_cost: true,
        supports_signal: true,
        classify_failure: () => 'structural',
      },
      async run(input) {
        if (runIdx === 0) {
          recorder.lastInput = input;
        }
        const stub = makeStubAdapter({
          outputs: [
            JSON.stringify({
              open_questions: ['q'],
              alternatives_surveyed: [
                { option: 'a', rejection_reason: 'r' },
                { option: 'b', rejection_reason: 'r' },
              ],
              decision_points: ['d'],
              cost_usd: 0,
            }),
          ],
        });
        const auditStub = makeStubAdapter({
          outputs: [JSON.stringify({ verdict: 'approved', findings: [] })],
        });
        const a = runIdx === 0 ? stub : auditStub;
        runIdx++;
        return a.run(input);
      },
    };

    const stage = buildAgenticBrainstormStage({
      agentLoop: sequencingAdapter,
      workspaceProvider,
      blobStore,
      redactor,
      principal: customPrincipal,
    });
    await stage.run(makeStageInput(host));

    // The brainstorm-prompt embeds the resolved principal id; the
    // hardcoded literal 'brainstorm-actor' must NOT appear when the
    // caller supplied an override.
    const prompt = recorder.lastInput?.task.successCriteria ?? '';
    expect(prompt).toContain(`- principal: ${customPrincipal}`);
    expect(prompt).not.toMatch(/- principal: brainstorm-actor\b/);
    expect(recorder.lastInput?.principal).toBe(customPrincipal);
  });
});
