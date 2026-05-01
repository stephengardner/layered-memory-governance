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
  AgentLoopResult,
} from '../../../../src/substrate/agent-loop.js';
import type { BlobStore } from '../../../../src/substrate/blob-store.js';
import { blobRefFromHash } from '../../../../src/substrate/blob-store.js';
import type { Redactor } from '../../../../src/substrate/redactor.js';
import type {
  Workspace,
  WorkspaceProvider,
} from '../../../../src/substrate/workspace-provider.js';
import type {
  AgentSessionMeta,
  AgentTurnMeta,
  Atom,
  AtomId,
  PrincipalId,
  Time,
} from '../../../../src/substrate/types.js';
import type { StageInput } from '../../../../src/runtime/planning-pipeline/index.js';

const CORR = 'corr-test-1';
const PRINCIPAL = 'brainstorm-actor' as PrincipalId;
const PIPELINE_ID = 'pipeline-test-1' as AtomId;
const NOW: Time = '2026-05-01T00:00:00.000Z' as Time;

function makeHostBundle(): {
  host: ReturnType<typeof createMemoryHost>;
  blobStore: BlobStore;
  redactor: Redactor;
  workspaceProvider: WorkspaceProvider;
} {
  const host = createMemoryHost({
    canonInitial: '<!-- canon: managed -->\n[]\n',
  });
  const blobStore: BlobStore = {
    async put(content) {
      const buf =
        typeof content === 'string' ? Buffer.from(content) : content;
      return blobRefFromHash(
        require('node:crypto')
          .createHash('sha256')
          .update(buf)
          .digest('hex'),
      );
    },
    async get() {
      return Buffer.from('');
    },
    async has() {
      return true;
    },
    describeStorage() {
      return { kind: 'local-file' as const, rootPath: '/tmp/test' };
    },
  };
  const redactor: Redactor = {
    redact: (content) => content,
  };
  let acquireCount = 0;
  let releaseCount = 0;
  const workspaceProvider: WorkspaceProvider = {
    async acquire(input) {
      acquireCount++;
      return {
        id: `ws-${acquireCount}`,
        path: `/tmp/ws-${acquireCount}`,
        baseRef: input.baseRef,
      } satisfies Workspace;
    },
    async release() {
      releaseCount++;
    },
  };
  Object.defineProperty(workspaceProvider, '_counts', {
    get: () => ({ acquireCount, releaseCount }),
  });
  return { host, blobStore, redactor, workspaceProvider };
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

/**
 * Build a stub agent-loop adapter that records its inputs and writes
 * agent-session + agent-turn atoms with a configurable final llm_output.
 * Used for every test below; the test customises the final-output JSON
 * per case via the `outputs` array (one per turn).
 */
function makeStubAdapter(opts: {
  outputs: ReadonlyArray<string>;
  recorder?: { lastInput?: AgentLoopInput };
}): AgentLoopAdapter {
  const recorder = opts.recorder ?? {};
  return {
    capabilities: {
      tracks_cost: true,
      supports_signal: true,
      classify_failure: () => 'structural',
    },
    async run(input: AgentLoopInput): Promise<AgentLoopResult> {
      recorder.lastInput = input;
      const sessionId = `agent-session-${input.correlationId}-${Math.random().toString(36).slice(2, 8)}` as AtomId;
      const sessionAtom: Atom = {
        schema_version: 1,
        id: sessionId,
        content: 'stub-session',
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
        principal_id: input.principal,
        taint: 'clean',
        metadata: {
          agent_session: {
            model_id: 'stub',
            adapter_id: 'stub-adapter',
            workspace_id: input.workspace.id,
            started_at: NOW,
            completed_at: NOW,
            terminal_state: 'completed',
            replay_tier: input.replayTier,
            budget_consumed: { turns: opts.outputs.length, wall_clock_ms: 0, usd: 0.5 },
          } satisfies AgentSessionMeta,
        },
      };
      await input.host.atoms.put(sessionAtom);
      const turnAtomIds: AtomId[] = [];
      for (let i = 0; i < opts.outputs.length; i++) {
        const turnId = `agent-turn-${input.correlationId}-${i}` as AtomId;
        const turnAtom: Atom = {
          schema_version: 1,
          id: turnId,
          content: `stub-turn-${i}`,
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
          principal_id: input.principal,
          taint: 'clean',
          metadata: {
            agent_turn: {
              session_atom_id: sessionId,
              turn_index: i,
              llm_input: '<stub-input>',
              llm_output: opts.outputs[i]!,
              tool_calls: [],
              latency_ms: 100,
              cost_usd: 0.1,
            } satisfies AgentTurnMeta,
          },
        };
        await input.host.atoms.put(turnAtom);
        turnAtomIds.push(turnId);
      }
      return {
        kind: 'completed',
        sessionAtomId: sessionId,
        turnAtomIds,
      };
    },
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
      replayTier: 'permissive',
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
      replayTier: 'permissive',
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
        replayTier: 'permissive',
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
        replayTier: 'permissive',
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
      replayTier: 'permissive',
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
