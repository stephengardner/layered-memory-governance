/**
 * End-to-end test: full chain through AgenticCodeAuthorExecutor on
 * MemoryHost. Stubs the AgentLoopAdapter (writes real session + turn
 * atoms but no real LLM), the WorkspaceProvider (in-memory path), the
 * BlobStore (in-memory map), and the GhClient (returns a synthetic PR
 * object).
 *
 * Validates:
 *   - dispatched success result (PR #, branch, commit)
 *   - atom emission shape (session + N turns landed in store)
 *   - session-tree projection round-trips the chain (turn ordering
 *     by turn_index)
 *   - one budget-exhausted failure path through the full chain
 */

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';

import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { buildAgenticCodeAuthorExecutor } from '../../src/runtime/actor-message/agentic-code-author-executor.js';
import { buildSessionTree } from '../../src/substrate/projections/session-tree.js';
import { defaultClassifyFailure } from '../../src/substrate/agent-loop.js';
import type {
  AgentLoopAdapter,
  AgentLoopResult,
} from '../../src/substrate/agent-loop.js';
import type { Workspace, WorkspaceProvider } from '../../src/substrate/workspace-provider.js';
import type { BlobStore, BlobRef } from '../../src/substrate/blob-store.js';
import type { Redactor } from '../../src/substrate/redactor.js';
import type { GhClient } from '../../src/external/github/index.js';
import type { Atom, AtomId, PrincipalId } from '../../src/substrate/types.js';

// In-memory BlobStore stub.
function inMemoryBlobStore(): BlobStore {
  const store = new Map<string, Buffer>();
  return {
    put: async (content) => {
      const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
      // Cheap content-addressing for the stub: random sha-shaped key
      // (good enough; the stub only validates the contract surface).
      const ref = `sha256:${randomBytes(32).toString('hex')}` as BlobRef;
      store.set(ref, buf);
      return ref;
    },
    get: async (ref) => store.get(ref as string)!,
    has: async (ref) => store.has(ref as string),
  };
}

const NOOP_REDACTOR: Redactor = { redact: (s) => s };

// Stub adapter that emits one session + N turns + returns a commit SHA.
// `costUsd` (optional) seeds budget_consumed.usd on the session atom so
// tests can verify the executor reads cost off the session atom.
function stubAdapter(turnCount: number, costUsd?: number): AgentLoopAdapter {
  return {
    capabilities: { tracks_cost: costUsd !== undefined, supports_signal: true, classify_failure: defaultClassifyFailure },
    run: async (input) => {
      const sessionId = `agent-session-${randomBytes(6).toString('hex')}` as AtomId;
      const turnIds: AtomId[] = [];
      const now = new Date().toISOString();
      const sessionAtom: Atom = {
        schema_version: 1,
        id: sessionId,
        content: '',
        type: 'agent-session',
        layer: 'L1',
        provenance: {
          kind: 'agent-observed',
          source: { agent_id: input.principal as unknown as string },
          derived_from: [],
        },
        confidence: 1,
        created_at: now,
        last_reinforced_at: now,
        expires_at: null,
        supersedes: [],
        superseded_by: [],
        scope: 'project',
        signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
        principal_id: input.principal,
        taint: 'clean',
        metadata: {
          agent_session: {
            model_id: 'stub-model',
            adapter_id: 'stub-adapter',
            workspace_id: input.workspace.id,
            started_at: now,
            terminal_state: 'completed',
            replay_tier: input.replayTier,
            budget_consumed: {
              turns: turnCount,
              wall_clock_ms: 1,
              ...(costUsd !== undefined ? { usd: costUsd } : {}),
            },
          },
        },
      };
      await input.host.atoms.put(sessionAtom);
      for (let i = 0; i < turnCount; i++) {
        const turnId = `agent-turn-${randomBytes(6).toString('hex')}` as AtomId;
        const turnAtom: Atom = {
          schema_version: 1,
          id: turnId,
          content: '',
          type: 'agent-turn',
          layer: 'L1',
          provenance: {
            kind: 'agent-observed',
            source: { agent_id: input.principal as unknown as string },
            derived_from: [sessionId],
          },
          confidence: 1,
          created_at: now,
          last_reinforced_at: now,
          expires_at: null,
          supersedes: [],
          superseded_by: [],
          scope: 'project',
          signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
          principal_id: input.principal,
          taint: 'clean',
          metadata: {
            agent_turn: {
              session_atom_id: sessionId,
              turn_index: i,
              llm_input: { inline: `i${i}` },
              llm_output: { inline: `o${i}` },
              tool_calls: [],
              latency_ms: 1,
            },
          },
        };
        await input.host.atoms.put(turnAtom);
        turnIds.push(turnId);
      }
      const result: AgentLoopResult = {
        kind: 'completed',
        sessionAtomId: sessionId,
        turnAtomIds: turnIds,
        artifacts: { commitSha: 'stub-sha-deadbeef', branchName: 'agentic/test-branch', touchedPaths: ['README.md'] },
      };
      return result;
    },
  };
}

const STUB_WS_PROVIDER: WorkspaceProvider = {
  acquire: async (input): Promise<Workspace> => ({
    id: `ws-${input.correlationId}`,
    path: '/tmp/stub',
    baseRef: input.baseRef,
  }),
  release: async () => undefined,
};

const STUB_GH: GhClient = {
  rest: (async () => ({
    number: 4242,
    html_url: 'https://example.test/pr/4242',
    url: 'https://example.test/api/pr/4242',
    node_id: 'PR_x',
    state: 'open',
  })) as never,
} as unknown as GhClient;

function mkPlan(id: string, meta: Record<string, unknown> = {}): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'README touch-up',
    type: 'plan',
    layer: 'L1',
    provenance: { kind: 'agent-observed', source: { agent_id: 'cto-actor' }, derived_from: [] },
    confidence: 1,
    created_at: '2026-04-25T00:00:00.000Z',
    last_reinforced_at: '2026-04-25T00:00:00.000Z',
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
    principal_id: 'cto-actor' as PrincipalId,
    taint: 'clean',
    metadata: { plan_state: 'approved', ...meta },
  };
}

describe('agentic-actor-loop end-to-end', () => {
  it('chain: plan -> agentic executor -> stub adapter -> stub gh -> dispatched success', async () => {
    const host = createMemoryHost();
    const executor = buildAgenticCodeAuthorExecutor({
      host,
      principal: 'agentic-code-author' as PrincipalId,
      actorType: 'code-author',
      agentLoop: stubAdapter(3),
      workspaceProvider: STUB_WS_PROVIDER,
      blobStore: inMemoryBlobStore(),
      redactor: NOOP_REDACTOR,
      ghClient: STUB_GH,
      owner: 'o',
      repo: 'r',
      baseRef: 'main',
      model: 'stub-model',
    });

    const plan = mkPlan('plan-test', { target_paths: ['README.md'] });
    await host.atoms.put(plan);

    const result = await executor.execute({
      plan,
      fence: {
        signedPrOnly: { subject: 's', output_channel: 'signed-pr', allowed_direct_write_paths: [], require_app_identity: true },
        perPrCostCap: { subject: 's', max_usd_per_pr: 10, include_retries: true },
        ciGate: { subject: 's', required_checks: [], require_all: true, max_check_age_ms: 60_000 },
        writeRevocationOnStop: { subject: 's', on_stop_action: 'close-pr-with-revocation-comment', draft_atoms_layer: 'L0', revocation_atom_type: 'code-author-revoked' },
        warnings: [],
      },
      correlationId: 'corr-e2e-1',
      observationAtomId: 'obs-1' as AtomId,
    });

    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') throw new Error('unreachable');
    expect(result.prNumber).toBe(4242);
    expect(result.commitSha).toBe('stub-sha-deadbeef');
    expect(result.branchName).toBe('agentic/test-branch');
    expect(result.touchedPaths).toEqual(['README.md']);

    // Validate atom emission shape: one session + three turns landed.
    const sessionAtoms = (await host.atoms.query({ type: ['agent-session'] }, 100)).atoms;
    expect(sessionAtoms.length).toBe(1);
    const sessionId = sessionAtoms[0]!.id;

    const turnAtoms = (await host.atoms.query({ type: ['agent-turn'] }, 100)).atoms;
    expect(turnAtoms.length).toBe(3);
    // Each turn cites the session via provenance.derived_from + via
    // metadata.agent_turn.session_atom_id (the contract requires both
    // pointers to agree).
    for (const t of turnAtoms) {
      expect(t.provenance.derived_from).toContain(sessionId);
      const md = t.metadata as Record<string, unknown>;
      const turnMeta = md['agent_turn'] as Record<string, unknown>;
      expect(turnMeta['session_atom_id']).toBe(sessionId);
    }

    // Session-tree projection round-trip: the projection rebuilds the
    // session + ordered turns from the atom store alone.
    const tree = await buildSessionTree(host.atoms, sessionId);
    expect(tree.session.id).toBe(sessionId);
    expect(tree.turns.length).toBe(3);
    // Turns must be ordered by turn_index 0,1,2.
    const idx = (a: Atom): number =>
      (((a.metadata as Record<string, unknown>)['agent_turn']) as Record<string, unknown>)['turn_index'] as number;
    expect(idx(tree.turns[0]!)).toBe(0);
    expect(idx(tree.turns[1]!)).toBe(1);
    expect(idx(tree.turns[2]!)).toBe(2);
  });

  it('reads totalCostUsd from session atom budget_consumed.usd written by adapter', async () => {
    const host = createMemoryHost();
    const executor = buildAgenticCodeAuthorExecutor({
      host,
      principal: 'agentic-code-author' as PrincipalId,
      actorType: 'code-author',
      // Adapter writes budget_consumed.usd = 0.42 on the session atom;
      // the executor must read that off the session and surface it as
      // dispatched.totalCostUsd. Hardcoding 0 was the prior behavior.
      agentLoop: stubAdapter(1, 0.42),
      workspaceProvider: STUB_WS_PROVIDER,
      blobStore: inMemoryBlobStore(),
      redactor: NOOP_REDACTOR,
      ghClient: STUB_GH,
      owner: 'o',
      repo: 'r',
      baseRef: 'main',
      model: 'stub-model',
    });
    const plan = mkPlan('plan-cost', { target_paths: ['README.md'] });
    await host.atoms.put(plan);
    const result = await executor.execute({
      plan,
      fence: {
        signedPrOnly: { subject: 's', output_channel: 'signed-pr', allowed_direct_write_paths: [], require_app_identity: true },
        perPrCostCap: { subject: 's', max_usd_per_pr: 10, include_retries: true },
        ciGate: { subject: 's', required_checks: [], require_all: true, max_check_age_ms: 60_000 },
        writeRevocationOnStop: { subject: 's', on_stop_action: 'close-pr-with-revocation-comment', draft_atoms_layer: 'L0', revocation_atom_type: 'code-author-revoked' },
        warnings: [],
      },
      correlationId: 'corr-cost-1',
      observationAtomId: 'obs-cost' as AtomId,
    });
    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') throw new Error('unreachable');
    expect(result.totalCostUsd).toBe(0.42);
  });

  it('chain: plan -> agentic executor -> REAL ClaudeCodeAgentLoopAdapter (stubbed CLI) -> canonical AgentTurnMeta atoms', async () => {
    // Validates the full chain through the production adapter -- not the
    // inline stubAdapter() above. Asserts agent-turn atoms emitted by the
    // production adapter match the canonical AgentTurnMeta shape from
    // src/substrate/types.ts:570-597 exactly: `tool` (not tool_name),
    // `args` / `result` as `{inline}|{ref}` discriminated unions, `outcome`
    // in `'success'|'tool-error'|'policy-refused'`. A regression guard so
    // a future refactor cannot silently drift back to a non-canonical
    // shape (CR caught one such drift in spec round 1).
    const { Readable } = await import('node:stream');
    const { ClaudeCodeAgentLoopAdapter } = await import('../../examples/agent-loops/claude-code/loop.js');
    const stdoutLines = [
      JSON.stringify({ type: 'system', model: 'claude-opus-4-7', session_id: 's1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'a\nb', is_error: false }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }),
      JSON.stringify({ type: 'result', cost_usd: 0.07, is_error: false }),
    ];
    const stubExeca = ((..._args: unknown[]) => {
      const stdoutStream = Readable.from(stdoutLines.map((l) => `${l}\n`));
      const stderrStream = Readable.from(['']);
      const resultPromise = Promise.resolve({
        stdout: stdoutLines.join('\n'),
        stderr: '',
        exitCode: 0,
      });
      return Object.assign(resultPromise, {
        stdout: stdoutStream,
        stderr: stderrStream,
        kill: (_signal?: NodeJS.Signals) => true,
      }) as never;
    }) as never;
    const realAdapter = new ClaudeCodeAgentLoopAdapter({ execImpl: stubExeca });
    const host = createMemoryHost();
    // The real adapter does not return commitSha (it would normally come
    // from `captureArtifacts` reading git inside the workspace). For this
    // chain test we focus on atom-shape correctness; the executor will map
    // the missing artifacts to `agentic/no-artifacts`. That path is the
    // one we want exercised here -- the atoms must still be canonical.
    const executor = buildAgenticCodeAuthorExecutor({
      host,
      principal: 'agentic-code-author' as PrincipalId,
      actorType: 'code-author',
      agentLoop: realAdapter,
      workspaceProvider: STUB_WS_PROVIDER,
      blobStore: inMemoryBlobStore(),
      redactor: NOOP_REDACTOR,
      ghClient: STUB_GH,
      owner: 'o',
      repo: 'r',
      baseRef: 'main',
      model: 'stub-model',
    });
    const plan = mkPlan('plan-real-shape', { target_paths: ['README.md'] });
    await host.atoms.put(plan);
    await executor.execute({
      plan,
      fence: {
        signedPrOnly: { subject: 's', output_channel: 'signed-pr', allowed_direct_write_paths: [], require_app_identity: true },
        perPrCostCap: { subject: 's', max_usd_per_pr: 10, include_retries: true },
        ciGate: { subject: 's', required_checks: [], require_all: true, max_check_age_ms: 60_000 },
        writeRevocationOnStop: { subject: 's', on_stop_action: 'close-pr-with-revocation-comment', draft_atoms_layer: 'L0', revocation_atom_type: 'code-author-revoked' },
        warnings: [],
      },
      correlationId: 'corr-real-1',
      observationAtomId: 'obs-real' as AtomId,
    });
    // Validate canonical AgentTurnMeta shape across emitted turns.
    const turnAtoms = (await host.atoms.query({ type: ['agent-turn'] }, 100)).atoms;
    expect(turnAtoms.length).toBeGreaterThanOrEqual(2);
    let totalToolCalls = 0;
    const canonicalTurnKeys = ['session_atom_id', 'turn_index', 'llm_input', 'llm_output', 'tool_calls', 'latency_ms'];
    for (const t of turnAtoms) {
      const md = t.metadata as Record<string, unknown>;
      const tm = md['agent_turn'] as Record<string, unknown>;
      for (const k of canonicalTurnKeys) {
        expect(tm).toHaveProperty(k);
      }
      // tool_calls[i] uses canonical field names (tool, args, result, latency_ms, outcome).
      const toolCalls = tm['tool_calls'] as ReadonlyArray<Record<string, unknown>>;
      totalToolCalls += toolCalls.length;
      for (const tc of toolCalls) {
        expect(tc).toHaveProperty('tool');           // NOT tool_name
        expect(tc).toHaveProperty('args');           // NOT args_redacted
        expect(tc).toHaveProperty('result');         // NOT result_redacted
        expect(tc).toHaveProperty('latency_ms');
        expect(tc).toHaveProperty('outcome');
        // outcome is in the canonical union
        expect(['success', 'tool-error', 'policy-refused']).toContain(tc['outcome']);
      }
    }
    // Streamed input includes one tool_use (tu_1 Bash) + matching tool_result;
    // regression guard only fires if at least one tool_call survived. A future
    // refactor that drops `tool_calls` entirely would otherwise pass the
    // per-entry assertions above silently (empty arrays satisfy `for...of`).
    expect(totalToolCalls).toBeGreaterThan(0);
  });

  it('chain: budget-exhausted result maps to CodeAuthorExecutorFailure with stage agentic/budget-exhausted', async () => {
    const host = createMemoryHost();
    const adapter: AgentLoopAdapter = {
      capabilities: { tracks_cost: false, supports_signal: false, classify_failure: defaultClassifyFailure },
      run: async (_input) => ({
        kind: 'budget-exhausted',
        sessionAtomId: 'sess-x' as AtomId,
        turnAtomIds: [],
        failure: { kind: 'structural', reason: 'turn budget hit', stage: 'turn-cap' },
      }),
    };
    const executor = buildAgenticCodeAuthorExecutor({
      host,
      principal: 'agentic-code-author' as PrincipalId,
      actorType: 'code-author',
      agentLoop: adapter,
      workspaceProvider: STUB_WS_PROVIDER,
      blobStore: inMemoryBlobStore(),
      redactor: NOOP_REDACTOR,
      ghClient: STUB_GH,
      owner: 'o',
      repo: 'r',
      baseRef: 'main',
      model: 'stub-model',
    });
    const plan = mkPlan('plan-test-2');
    const result = await executor.execute({
      plan,
      fence: {
        signedPrOnly: { subject: 's', output_channel: 'signed-pr', allowed_direct_write_paths: [], require_app_identity: true },
        perPrCostCap: { subject: 's', max_usd_per_pr: 10, include_retries: true },
        ciGate: { subject: 's', required_checks: [], require_all: true, max_check_age_ms: 60_000 },
        writeRevocationOnStop: { subject: 's', on_stop_action: 'close-pr-with-revocation-comment', draft_atoms_layer: 'L0', revocation_atom_type: 'code-author-revoked' },
        warnings: [],
      },
      correlationId: 'corr-e2e-2',
      observationAtomId: 'obs-2' as AtomId,
    });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    // The structured failure routes through the budget-exhausted branch
    // with the failure-kind suffix.
    expect(result.stage).toBe('agentic/budget-exhausted/structural');
    expect(result.reason).toContain('turn budget hit');
  });
});
