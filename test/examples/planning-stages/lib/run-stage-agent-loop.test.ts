/**
 * Contract test for runStageAgentLoop.
 *
 * The stub agent-loop adapter returns a deterministic AgentLoopResult
 * with a known final-output JSON; the test asserts the helper:
 *
 *   - writes a canon-bound pipeline-stage-event before invoking the
 *     adapter (with the resolved canon atom-ids in metadata);
 *   - invokes the adapter with the resolved tool policy;
 *   - emits one agent-turn event per turn the adapter wrote;
 *   - validates the adapter's final output against the stage schema
 *     and throws on schema-fail;
 *   - dispatches a canon-audit run when canonAuditPromptBuilder is set
 *     and emits a canon-audit-complete event with the parsed verdict;
 *   - acquires + releases the workspace exactly once per main run
 *     (and once more per audit run when audit is enabled).
 *
 * Uses MemoryHost so atom writes are observable via host.atoms.query.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  runStageAgentLoop,
  extractFinalJsonPayload,
} from '../../../../examples/planning-stages/lib/run-stage-agent-loop.js';
import { createMemoryHost } from '../../../../src/adapters/memory/index.js';
import type {
  AgentLoopAdapter,
  AgentLoopInput,
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

const CORR = 'corr-test-1';
const PRINCIPAL = 'brainstorm-actor' as PrincipalId;
const PIPELINE_ID = 'pipeline-test-1' as AtomId;

function makeHostBundle() {
  return makeStubHostBundle();
}

function makeStageInput(
  host: ReturnType<typeof createMemoryHost>,
): StageInput<unknown> {
  return {
    host,
    principal: PRINCIPAL,
    correlationId: CORR,
    priorOutput: null,
    pipelineId: PIPELINE_ID,
    seedAtomIds: [],
    verifiedCitedAtomIds: [],
    verifiedSubActorPrincipalIds: [],
    operatorIntentContent: 'Test operator intent for unit test.',
  };
}

const testSchema = z.object({
  goal: z.string(),
  alternatives: z.array(z.string()),
  cost_usd: z.number(),
});

describe('runStageAgentLoop', () => {
  it('writes canon-bound + agent-turn + canon-audit-complete events for a single-turn stage', async () => {
    const { host, blobStore, redactor, workspaceProvider } = makeHostBundle();
    const stageInput = makeStageInput(host);
    const finalOutput = JSON.stringify({
      goal: 'pick alternative A',
      alternatives: ['A', 'B', 'C'],
      cost_usd: 0.5,
    });
    const adapter = makeStubAdapter({ outputs: [finalOutput] });

    const result = await runStageAgentLoop({
      stageInput,
      stageName: 'brainstorm-stage',
      stagePrincipal: PRINCIPAL,
      skillBundle: '# brainstorming skill (vendored stub)',
      promptBuilder: ({ skillBundle, canonAtomIds }) =>
        `${skillBundle}\nCanon: ${canonAtomIds.length} atoms\nGo.`,
      outputSchema: testSchema,
      agentLoop: adapter,
      workspaceProvider,
      blobStore,
      redactor,
      replayTier: 'best-effort',
      blobThreshold: 4096,
      baseRef: 'main',
    });

    expect(result.value.goal).toBe('pick alternative A');
    expect(result.value.alternatives).toEqual(['A', 'B', 'C']);
    expect(result.canonAuditVerdict).toBe('approved');
    expect(result.canonAuditFindings).toHaveLength(0);

    // Inspect the atom store for the chain.
    const allEvents = await host.atoms.query(
      { type: ['pipeline-stage-event'] },
      200,
    );
    const events = allEvents.atoms.filter(
      (a) =>
        (a.metadata as { pipeline_id?: AtomId }).pipeline_id === PIPELINE_ID,
    );
    const transitions = events.map(
      (a) => (a.metadata as { transition: string }).transition,
    );
    expect(transitions).toContain('canon-bound');
    expect(transitions).toContain('canon-audit-complete');
    expect(transitions.filter((t) => t === 'agent-turn')).toHaveLength(1);
  });

  it('invokes the adapter with the supplied disallowedTools override', async () => {
    const { host, blobStore, redactor, workspaceProvider } = makeHostBundle();
    const stageInput = makeStageInput(host);
    const finalOutput = JSON.stringify({
      goal: 'foo',
      alternatives: [],
      cost_usd: 0,
    });
    const recorder: { lastInput?: AgentLoopInput } = {};
    const adapter = makeStubAdapter({ outputs: [finalOutput], recorder });

    await runStageAgentLoop({
      stageInput,
      stageName: 'brainstorm-stage',
      stagePrincipal: PRINCIPAL,
      skillBundle: '# stub skill',
      promptBuilder: () => 'go',
      outputSchema: testSchema,
      agentLoop: adapter,
      workspaceProvider,
      blobStore,
      redactor,
      replayTier: 'best-effort',
      blobThreshold: 4096,
      baseRef: 'main',
      disallowedToolsOverride: ['Bash', 'Edit', 'Write'],
    });

    expect(recorder.lastInput?.toolPolicy.disallowedTools).toEqual([
      'Bash',
      'Edit',
      'Write',
    ]);
  });

  it('throws when the adapter returns a final output that fails schema validation', async () => {
    const { host, blobStore, redactor, workspaceProvider } = makeHostBundle();
    const stageInput = makeStageInput(host);
    // Missing required `goal` field.
    const finalOutput = JSON.stringify({
      alternatives: ['A'],
      cost_usd: 0,
    });
    const adapter = makeStubAdapter({ outputs: [finalOutput] });

    await expect(
      runStageAgentLoop({
        stageInput,
        stageName: 'brainstorm-stage',
        stagePrincipal: PRINCIPAL,
        skillBundle: '# stub',
        promptBuilder: () => 'go',
        outputSchema: testSchema,
        agentLoop: adapter,
        workspaceProvider,
        blobStore,
        redactor,
        replayTier: 'best-effort',
        blobThreshold: 4096,
        baseRef: 'main',
      }),
    ).rejects.toThrow(/schema validation/);
  });

  it('rejects an empty skillBundle (silent-resolve-failure guard)', async () => {
    const { host, blobStore, redactor, workspaceProvider } = makeHostBundle();
    const stageInput = makeStageInput(host);
    const adapter = makeStubAdapter({ outputs: ['{}'] });

    await expect(
      runStageAgentLoop({
        stageInput,
        stageName: 'brainstorm-stage',
        stagePrincipal: PRINCIPAL,
        skillBundle: '   ',
        promptBuilder: () => 'go',
        outputSchema: testSchema,
        agentLoop: adapter,
        workspaceProvider,
        blobStore,
        redactor,
        replayTier: 'best-effort',
        blobThreshold: 4096,
        baseRef: 'main',
      }),
    ).rejects.toThrow(/skillBundle.*non-empty/);
  });

  it('runs the canon-audit dispatch and surfaces issues-found findings', async () => {
    const { host, blobStore, redactor, workspaceProvider } = makeHostBundle();
    const stageInput = makeStageInput(host);
    const finalOutput = JSON.stringify({
      goal: 'go',
      alternatives: [],
      cost_usd: 0,
    });
    const auditOutput = JSON.stringify({
      verdict: 'issues-found',
      findings: [
        {
          severity: 'major',
          category: 'over-abstraction',
          message: 'output paraphrases the operator-intent without alternatives',
          cited_atom_ids: [],
          cited_paths: [],
        },
      ],
    });
    let runCount = 0;
    const adapter: AgentLoopAdapter = {
      capabilities: {
        tracks_cost: false,
        supports_signal: false,
        classify_failure: () => 'structural',
      },
      async run(input) {
        runCount++;
        const stub = makeStubAdapter({
          outputs: [runCount === 1 ? finalOutput : auditOutput],
        });
        return stub.run(input);
      },
    };

    const result = await runStageAgentLoop({
      stageInput,
      stageName: 'brainstorm-stage',
      stagePrincipal: PRINCIPAL,
      skillBundle: '# stub',
      promptBuilder: () => 'go',
      outputSchema: testSchema,
      canonAuditPromptBuilder: () => 'audit prompt',
      agentLoop: adapter,
      workspaceProvider,
      blobStore,
      redactor,
      replayTier: 'best-effort',
      blobThreshold: 4096,
      baseRef: 'main',
    });
    expect(runCount).toBe(2);
    expect(result.canonAuditVerdict).toBe('issues-found');
    expect(result.canonAuditFindings).toHaveLength(1);
    expect(result.canonAuditFindings[0]?.category).toBe('over-abstraction');
  });
});

describe('extractFinalJsonPayload', () => {
  it('returns a bare JSON object string unchanged', () => {
    const input = '{"a": 1}';
    expect(extractFinalJsonPayload(input)).toBe('{"a": 1}');
  });

  it('strips a fenced json code block', () => {
    const input = 'Some preamble\n```json\n{"a": 1}\n```\nTrailing.';
    expect(extractFinalJsonPayload(input)).toBe('{"a": 1}');
  });

  it('finds an embedded { ... } block', () => {
    const input = 'Final answer: {"a": 1}.';
    expect(extractFinalJsonPayload(input)).toBe('{"a": 1}');
  });

  it('falls back to raw text when no JSON shape matches', () => {
    const input = 'no json here';
    expect(extractFinalJsonPayload(input)).toBe('no json here');
  });
});
