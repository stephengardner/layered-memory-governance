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

    // The stage-output extraMetadata bag MUST surface the per-principal
    // tool-policy id and the canon-directives-applied list (even when
    // empty -- the field carries an explicit empty array, not absent).
    // The adapter consumes this via StageOutput.extraMetadata so the
    // runner shallow-merges it into the persisted stage-output atom.
    // tool_policy_source is 'policy' because no disallowedToolsOverride
    // was supplied -> loadLlmToolPolicy was consulted under the stage
    // principal.
    expect(result.stageOutputExtraMetadata).toMatchObject({
      tool_policy_source: 'policy',
      tool_policy_principal_id: 'brainstorm-actor',
      canon_directives_applied: expect.any(Array),
    });

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

    const result = await runStageAgentLoop({
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

    // Provenance discipline on override-bound runs: the canonical
    // pol-llm-tool-policy-<P> atom was NOT loaded (override bypassed
    // loadLlmToolPolicy), so tool_policy_principal_id MUST NOT appear
    // on the stamp -- stamping it would lie about which canon atom
    // bound the LLM. tool_policy_source records 'override' so the
    // Console can render an explicit override-bound state.
    expect(result.stageOutputExtraMetadata).toMatchObject({
      tool_policy_source: 'override',
      canon_directives_applied: expect.any(Array),
    });
    expect(result.stageOutputExtraMetadata)
      .not.toHaveProperty('tool_policy_principal_id');

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

  it("fails canon-audit closed when the audit run does not complete (kind != 'completed' MUST NOT silently approve)", async () => {
    const { host, blobStore, redactor, workspaceProvider } = makeHostBundle();
    const stageInput = makeStageInput(host);
    const finalOutput = JSON.stringify({
      goal: 'go',
      alternatives: [],
      cost_usd: 0,
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
        if (runCount === 1) {
          // Main run completes normally with a schema-valid output.
          const stub = makeStubAdapter({ outputs: [finalOutput] });
          return stub.run(input);
        }
        // Audit run: budget-exhausted. Helper MUST treat this as a
        // fail-closed verdict, NOT silently call parseCanonAuditResponse
        // with undefined and clear the canon gate.
        return {
          kind: 'budget-exhausted',
          sessionAtomId: 'agent-session-fake' as AtomId,
          turnAtomIds: [],
          failure: { kind: 'budget', detail: 'max_turns reached' },
        };
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
    expect(result.canonAuditVerdict).toBe('issues-found');
    expect(result.canonAuditFindings).toHaveLength(1);
    expect(result.canonAuditFindings[0]?.severity).toBe('critical');
    expect(result.canonAuditFindings[0]?.category).toBe('canon-audit-failed');
    expect(result.canonAuditFindings[0]?.message).toMatch(/budget-exhausted/);
  });

  it('dereferences blob-backed final llm_output through BlobStore so large outputs validate', async () => {
    // Adapter that writes its own session + turn atoms and externalizes
    // the final-turn llm_output to the blob store (simulating an
    // adapter that exceeded blobThreshold). The helper MUST resolve the
    // BlobRef back to the actual JSON payload; if it instead handed the
    // {ref} wrapper to the parser, schema validation would fail even
    // though the agent emitted valid JSON.
    const { host, blobStore, redactor, workspaceProvider } = makeHostBundle();
    const stageInput = makeStageInput(host);
    const finalOutput = JSON.stringify({
      goal: 'externalized-output-survived-blob-roundtrip',
      alternatives: ['A', 'B'],
      cost_usd: 0.25,
    });

    // Pre-stash the payload into the blob store so the adapter's turn
    // atom can carry the BlobRef without the adapter needing to do the
    // put itself. The stub blobStore is now backed by an in-memory Map
    // so put/get round-trip correctly without bespoke overrides; tests
    // exercise the real {ref:BlobRef} branch through the actual stub.
    const ref = await blobStore.put(finalOutput);

    const adapter: AgentLoopAdapter = {
      capabilities: {
        tracks_cost: false,
        supports_signal: false,
        classify_failure: () => 'structural',
      },
      async run(input) {
        const sessionId = `agent-session-blobref-${input.correlationId}` as AtomId;
        const turnId = `agent-turn-blobref-${input.correlationId}-0` as AtomId;
        await input.host.atoms.put({
          schema_version: 1,
          id: sessionId,
          content: 'blob-ref-session',
          type: 'agent-session',
          layer: 'L0',
          provenance: {
            kind: 'agent-observed',
            source: {
              tool: 'stub',
              agent_id: String(input.principal),
              session_id: input.correlationId,
            },
            derived_from: [],
          },
          confidence: 1,
          created_at: '2026-05-01T00:00:00.000Z' as never,
          last_reinforced_at: '2026-05-01T00:00:00.000Z' as never,
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
          principal_id: input.principal,
          taint: 'clean',
          metadata: {
            agent_session: {
              model_id: 'stub',
              adapter_id: 'blob-ref-stub',
              workspace_id: input.workspace.id,
              started_at: '2026-05-01T00:00:00.000Z' as never,
              completed_at: '2026-05-01T00:00:00.000Z' as never,
              terminal_state: 'completed',
              replay_tier: input.replayTier,
              budget_consumed: { turns: 1, wall_clock_ms: 0, usd: 0 },
            },
          },
        });
        await input.host.atoms.put({
          schema_version: 1,
          id: turnId,
          content: 'blob-ref-turn',
          type: 'agent-turn',
          layer: 'L0',
          provenance: {
            kind: 'agent-observed',
            source: {
              tool: 'stub',
              agent_id: String(input.principal),
              session_id: input.correlationId,
            },
            derived_from: [sessionId],
          },
          confidence: 1,
          created_at: '2026-05-01T00:00:00.000Z' as never,
          last_reinforced_at: '2026-05-01T00:00:00.000Z' as never,
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
          principal_id: input.principal,
          taint: 'clean',
          metadata: {
            agent_turn: {
              session_atom_id: sessionId,
              turn_index: 0,
              llm_input: { inline: '<test-input>' },
              // Externalized payload: the helper must resolve this via
              // blobStore.get to recover the actual JSON.
              llm_output: { ref },
              tool_calls: [],
              latency_ms: 100,
            },
          },
        });
        return {
          kind: 'completed',
          sessionAtomId: sessionId,
          turnAtomIds: [turnId],
        };
      },
    };

    const result = await runStageAgentLoop({
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
    });
    expect(result.value.goal).toBe('externalized-output-survived-blob-roundtrip');
    expect(result.value.alternatives).toEqual(['A', 'B']);
    // The blob ref the adapter wrote was the same ref the helper read
    // back; the round-trip is what proves readFinalOutputJson resolved
    // the ref instead of stringifying the {ref} wrapper.
    expect(await blobStore.has(ref)).toBe(true);
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
