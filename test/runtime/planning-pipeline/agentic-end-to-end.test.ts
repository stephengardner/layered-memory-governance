/**
 * End-to-end deterministic test for the killer-pipeline upgrade.
 *
 * Composes:
 *   - the agentic brainstorm-stage adapter (stub-driven AgentLoopAdapter)
 *   - the substrate runner (`runPipeline`)
 *
 * Asserts the chain integrity end-to-end:
 *   1. The pipeline atom ends in pipeline_state='completed' or
 *      'hil-paused' (HIL pause is correct substrate behaviour for an
 *      unconfigured pipeline; the policy default is pause_mode='always'
 *      when no policy atom matches).
 *   2. The brainstorm stage emits canon-bound + agent-turn +
 *      canon-audit-complete pipeline-stage-events around the runner's
 *      enter + (exit-success | hil-pause) sequence.
 *   3. The brainstorm-output atom matches `brainstormPayloadSchema`.
 *
 * Uses MemoryHost + a stub AgentLoopAdapter so the test is fully
 * deterministic and runs in the standard vitest pass without spawning
 * an LLM subprocess.
 */

import { describe, expect, it } from 'vitest';
import { runPipeline } from '../../../src/runtime/planning-pipeline/index.js';
import { buildAgenticBrainstormStage } from '../../../examples/planning-stages/brainstorm/agentic.js';
import { brainstormPayloadSchema } from '../../../examples/planning-stages/brainstorm/index.js';
import type { AgentLoopAdapter } from '../../../src/substrate/agent-loop.js';
import type { PlanningStage } from '../../../src/runtime/planning-pipeline/types.js';
import type {
  Atom,
  AtomId,
  PrincipalId,
  Time,
} from '../../../src/substrate/types.js';
import {
  makeStubAdapter,
  makeStubHostBundle,
} from '../../examples/planning-stages/agent-loop-stubs.js';

const NOW: Time = '2026-05-01T00:00:00.000Z' as Time;
const PRINCIPAL = 'brainstorm-actor' as PrincipalId;

describe('killer-pipeline E2E (single agentic stage)', () => {
  it('runs an agentic brainstorm-stage end-to-end and emits the full chain', async () => {
    const { host, blobStore, redactor, workspaceProvider } = makeStubHostBundle();

    // Seed a synthetic operator-intent so the runner has a non-empty
    // seedAtomIds chain.
    const intentId = 'intent-e2e-1' as AtomId;
    const intentAtom: Atom = {
      schema_version: 1,
      id: intentId,
      content:
        'add a one-line note to the README explaining the deep planning pipeline',
      type: 'operator-intent',
      layer: 'L0',
      provenance: {
        kind: 'user-directive',
        source: { tool: 'test', agent_id: 'operator', session_id: 'session-1' },
        derived_from: [],
      },
      confidence: 1,
      created_at: NOW,
      last_reinforced_at: NOW,
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
      principal_id: 'operator-principal' as PrincipalId,
      taint: 'clean',
      metadata: {},
    };
    await host.atoms.put(intentAtom);

    // Sequencing adapter: first call returns the brainstorm payload,
    // second call returns the canon-audit verdict. The agentic
    // brainstorm adapter calls the AgentLoopAdapter twice per stage
    // run (main + audit).
    let callIdx = 0;
    const sequenceAdapter: AgentLoopAdapter = {
      capabilities: {
        tracks_cost: true,
        supports_signal: true,
        classify_failure: () => 'structural',
      },
      async run(input) {
        const isMain = callIdx === 0;
        callIdx++;
        const stub = makeStubAdapter({
          outputs: isMain
            ? [
                JSON.stringify({
                  open_questions: [
                    'where in the README is the right insertion point?',
                    'one-line vs short paragraph?',
                  ],
                  alternatives_surveyed: [
                    {
                      option:
                        'insert under existing Architecture section (selected)',
                      rejection_reason: 'natural home for a pipeline pointer',
                    },
                    {
                      option: 'append to top of README',
                      rejection_reason:
                        'would push the project tagline down; rejected',
                    },
                    {
                      option: 'create a new See Also section',
                      rejection_reason:
                        'too heavy for a one-line addition; rejected',
                    },
                  ],
                  decision_points: ['exact insertion point', 'phrasing'],
                  cost_usd: 0.42,
                }),
              ]
            : [JSON.stringify({ verdict: 'approved', findings: [] })],
        });
        return stub.run(input);
      },
    };

    const agenticBrainstorm = buildAgenticBrainstormStage({
      agentLoop: sequenceAdapter,
      workspaceProvider,
      blobStore,
      redactor,
      baseRef: 'main',
    });

    // Compose just the brainstorm stage; this test isolates the agentic
    // chain integrity from cross-stage concerns.
    const stages: ReadonlyArray<PlanningStage> = [agenticBrainstorm];

    const result = await runPipeline(stages, host, {
      principal: PRINCIPAL,
      correlationId: 'corr-e2e-1',
      seedAtomIds: [intentId],
      stagePolicyAtomId: 'pol-test',
      mode: 'substrate-deep',
    });

    // The substrate's HIL policy default is 'always' when no policy
    // atom matches, so a single-stage pipeline run with no policy seed
    // halts at hil-paused after the stage completes successfully. The
    // chain integrity is what we assert; the HIL state is correct
    // substrate behaviour for an unconfigured pipeline.
    expect(['completed', 'hil-paused']).toContain(result.kind);
    if (result.kind !== 'completed' && result.kind !== 'hil-paused') return;

    // Walk the atom store for the chain.
    const events = await host.atoms.query({ type: ['pipeline-stage-event'] }, 200);
    const ourEvents = events.atoms.filter(
      (a) => (a.metadata as { pipeline_id?: AtomId }).pipeline_id === result.pipelineId,
    );
    const transitions = ourEvents.map(
      (a) => (a.metadata as { transition: string }).transition,
    );

    // The runner emits enter around stage.run(); the helper emits
    // canon-bound, agent-turn (>=1), and canon-audit-complete. The
    // runner's exit-success or hil-pause event lands depending on HIL
    // policy; either is correct substrate behaviour.
    expect(transitions).toContain('enter');
    expect(transitions).toContain('canon-bound');
    expect(transitions).toContain('canon-audit-complete');
    expect(transitions.filter((t) => t === 'agent-turn').length).toBeGreaterThan(0);
    expect(
      transitions.includes('exit-success') || transitions.includes('hil-pause'),
    ).toBe(true);

    // The brainstorm-output atom is persisted by the runner; assert it
    // matches the schema.
    const outputs = await host.atoms.query({ type: ['brainstorm-output'] }, 50);
    const ourOutputs = outputs.atoms.filter(
      (a) => (a.metadata as { pipeline_id?: AtomId }).pipeline_id === result.pipelineId,
    );
    expect(ourOutputs.length).toBeGreaterThan(0);
    const stageOutput = ourOutputs[0]!;
    const stageMeta = stageOutput.metadata as { stage_output?: unknown };
    const parsed = brainstormPayloadSchema.safeParse(stageMeta.stage_output);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.alternatives_surveyed.length).toBeGreaterThanOrEqual(2);
    }
  });
});
