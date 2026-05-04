import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import { ClaudeCodeAgentLoopAdapter } from '../../../examples/agent-loops/claude-code/loop.js';
import type { AgentLoopInput } from '../../../src/substrate/agent-loop.js';
import type { Workspace } from '../../../src/substrate/workspace-provider.js';
import type { BlobStore, BlobRef } from '../../../src/substrate/blob-store.js';
import type { Redactor } from '../../../src/substrate/redactor.js';
import type { AtomId, PrincipalId } from '../../../src/substrate/types.js';
import { randomBytes } from 'node:crypto';

/*
 * Top-level metadata shadow keys for projection-compat.
 *
 * Why this exists
 * ---------------
 * The substrate's canonical AgentSessionMeta / AgentTurnMeta shape
 * lives under nested `metadata.agent_session.*` / `metadata.agent_turn.*`
 * fields. Substrate consumers (validators, replay, audit) read the
 * nested shape. Top-level shadow keys (`metadata.session_id`,
 * `metadata.started_at`, `metadata.ended_at`,
 * `metadata.terminal_state` on session atoms;
 * `metadata.session_id` on turn atoms) mirror the nested fields so
 * projections that key on top-level metadata (e.g. the LAG Console's
 * `listActiveSessions`) see adapter-written sessions uniformly with
 * the operator-pulse pathway in
 * `scripts/lib/operator-claude-session.mjs`.
 *
 * Note the name shift: the substrate canonicalizes `completed_at`
 * while the projection convention uses `ended_at`. Both refer to the
 * same concept (when the session terminated).
 *
 * These tests pin the contract: ADD top-level shadows; do NOT remove
 * or rename existing nested keys. Back-compat is load-bearing.
 */

const NOOP_REDACTOR: Redactor = { redact: (s) => s };
const PRINCIPAL = 'agentic-code-author' as PrincipalId;
const WS: Workspace = { id: 'ws-1', path: '/tmp/stub-ws', baseRef: 'main' };

function inMemBlob(): BlobStore {
  const m = new Map<string, Buffer>();
  return {
    put: async (c) => {
      const buf = typeof c === 'string' ? Buffer.from(c) : c;
      const ref = `sha256:${randomBytes(32).toString('hex')}` as BlobRef;
      m.set(ref, buf);
      return ref;
    },
    get: async (r) => m.get(r as string)!,
    has: async (r) => m.has(r as string),
    describeStorage: () => ({ kind: 'remote' as const, target: 'in-memory:test' }),
  };
}

function makeStubExeca(stdoutLines: string[], opts: { exitCode?: number; stderr?: string } = {}) {
  return ((..._args: unknown[]) => {
    const stdoutStream = Readable.from(stdoutLines.map((l) => `${l}\n`));
    const stderrText = opts.stderr ?? '';
    const stderrStream = Readable.from([stderrText]);
    let resolveResult!: (v: unknown) => void;
    let rejectResult!: (e: unknown) => void;
    const resultPromise: Promise<unknown> = new Promise((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });
    let killed = false;
    const kill = (_signal?: NodeJS.Signals) => {
      if (!killed) {
        killed = true;
        rejectResult(Object.assign(new Error('subprocess killed'), { isTerminated: true }));
      }
      return true;
    };
    stdoutStream.on('end', () => {
      if (!killed) {
        resolveResult({
          stdout: stdoutLines.join('\n'),
          stderr: stderrText,
          exitCode: opts.exitCode ?? 0,
        });
      }
    });
    return Object.assign(resultPromise, {
      stdout: stdoutStream,
      stderr: stderrStream,
      kill,
    }) as never;
  }) as never;
}

function mkInput(host: ReturnType<typeof createMemoryHost>, signal?: AbortSignal): AgentLoopInput {
  return {
    host,
    principal: PRINCIPAL,
    workspace: WS,
    task: { planAtomId: 'plan-1' as AtomId, questionPrompt: 'do X' },
    budget: { max_turns: 10, max_wall_clock_ms: 60_000, max_usd: 1 },
    toolPolicy: { disallowedTools: [] },
    redactor: NOOP_REDACTOR,
    blobStore: inMemBlob(),
    replayTier: 'content-addressed',
    blobThreshold: 4096,
    correlationId: 'corr-1',
    ...(signal !== undefined ? { signal } : {}),
  };
}

/*
 * The canonical happy-path stream: system event with a CLI session id,
 * a single assistant-text turn, and a result event with cost. Used as
 * the default scenario across every test that does not need a
 * specialized event stream. Extracted at N=2 per the canon directive
 * on duplication (`dev-extract-helpers-at-N-2-plus-one`).
 */
const DEFAULT_HAPPY_STDOUT = [
  JSON.stringify({ type: 'system', model: 'claude-opus-4-7', session_id: 's1' }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }),
  JSON.stringify({ type: 'result', cost_usd: 0.01, is_error: false }),
];

/**
 * Run a default happy-path adapter session against the supplied host
 * and return the host so callers can query it for assertions. Every
 * test that does not need a specialized event stream uses this helper.
 */
async function runDefaultHappyPathSession(host: ReturnType<typeof createMemoryHost>) {
  const adapter = new ClaudeCodeAgentLoopAdapter({ execImpl: makeStubExeca(DEFAULT_HAPPY_STDOUT) });
  await adapter.run(mkInput(host));
}

describe('ClaudeCodeAgentLoopAdapter -- top-level metadata shadow keys', () => {
  it('agent-session atom carries top-level session_id, started_at, terminal_state on session-open', async () => {
    /*
     * The first put() the adapter performs is the session-open write.
     * The Console's `listActiveSessions` projection reads top-level
     * `metadata.session_id` + `started_at` to surface live sessions
     * before any agent-turn lands. Without these shadows, a
     * just-spawned session is invisible until the first turn closes.
     */
    const host = createMemoryHost();
    await runDefaultHappyPathSession(host);
    const sessions = (await host.atoms.query({ type: ['agent-session'] }, 100)).atoms;
    expect(sessions).toHaveLength(1);
    const meta = sessions[0]!.metadata as Record<string, unknown>;
    expect(typeof meta['session_id']).toBe('string');
    expect(meta['session_id']).toBe(sessions[0]!.id);
    expect(typeof meta['started_at']).toBe('string');
    expect(typeof meta['terminal_state']).toBe('string');
  });

  it('agent-session atom carries top-level ended_at + final terminal_state on session-close', async () => {
    /*
     * On terminal update, the adapter must shadow `ended_at` (note the
     * name shift from the substrate's `completed_at`) so the Console's
     * active-vs-completed filter de-lists the session from the active
     * set. The terminal_state shadow shifts from the optimistic
     * 'completed' seeded at open to the actual final state.
     */
    const host = createMemoryHost();
    await runDefaultHappyPathSession(host);
    const sessions = (await host.atoms.query({ type: ['agent-session'] }, 100)).atoms;
    const meta = sessions[0]!.metadata as Record<string, unknown>;
    expect(typeof meta['ended_at']).toBe('string');
    expect(meta['terminal_state']).toBe('completed');
  });

  it('agent-session atom keeps the canonical nested agent_session shape (back-compat)', async () => {
    /*
     * Substrate consumers (validators, replay, audit) read the nested
     * shape. Adding top-level shadows MUST NOT remove or rename the
     * nested keys; both must be present on the same atom.
     */
    const host = createMemoryHost();
    await runDefaultHappyPathSession(host);
    const sessions = (await host.atoms.query({ type: ['agent-session'] }, 100)).atoms;
    const meta = sessions[0]!.metadata as Record<string, unknown>;
    const nested = meta['agent_session'] as Record<string, unknown>;
    expect(nested).toBeDefined();
    expect(typeof nested['model_id']).toBe('string');
    expect(typeof nested['adapter_id']).toBe('string');
    expect(typeof nested['workspace_id']).toBe('string');
    expect(typeof nested['started_at']).toBe('string');
    expect(typeof nested['completed_at']).toBe('string');
    expect(typeof nested['terminal_state']).toBe('string');
    expect(typeof nested['replay_tier']).toBe('string');
    expect(nested['budget_consumed']).toBeDefined();
  });

  it('signal-aborted-at-entry session atom carries top-level shadows (fast-path)', async () => {
    /*
     * The fast-path that fires when AbortSignal is pre-aborted writes
     * a minimal session atom for the audit trail. The shadows must be
     * present on this path too so the Console can surface the failed
     * spawn (an aborted session that has zero turns is still
     * relevant to the operator).
     */
    const host = createMemoryHost();
    const ac = new AbortController();
    ac.abort();
    const stdoutLines = [JSON.stringify({ type: 'result', cost_usd: 0, is_error: false })];
    const adapter = new ClaudeCodeAgentLoopAdapter({ execImpl: makeStubExeca(stdoutLines) });
    await adapter.run(mkInput(host, ac.signal));
    const sessions = (await host.atoms.query({ type: ['agent-session'] }, 100)).atoms;
    expect(sessions).toHaveLength(1);
    const meta = sessions[0]!.metadata as Record<string, unknown>;
    expect(typeof meta['session_id']).toBe('string');
    expect(meta['session_id']).toBe(sessions[0]!.id);
    expect(typeof meta['started_at']).toBe('string');
    expect(typeof meta['ended_at']).toBe('string');
    expect(meta['terminal_state']).toBe('aborted');
    // Nested still present.
    const nested = meta['agent_session'] as Record<string, unknown>;
    expect(nested['terminal_state']).toBe('aborted');
    expect(nested['failure']).toBeDefined();
  });

  it('agent-turn atom carries top-level session_id mirroring agent_turn.session_atom_id', async () => {
    /*
     * The Console's active-session projection indexes the latest turn
     * timestamp by `metadata.session_id` on agent-turn atoms. Without
     * the shadow, turns are unbinnable and active-session liveness
     * falls back to the started_at-only path.
     */
    const host = createMemoryHost();
    await runDefaultHappyPathSession(host);
    const sessions = (await host.atoms.query({ type: ['agent-session'] }, 100)).atoms;
    const turns = (await host.atoms.query({ type: ['agent-turn'] }, 100)).atoms;
    expect(turns).toHaveLength(1);
    const turnMeta = turns[0]!.metadata as Record<string, unknown>;
    expect(typeof turnMeta['session_id']).toBe('string');
    // The shadow on the turn matches the parent session's atom id.
    expect(turnMeta['session_id']).toBe(sessions[0]!.id);
    // Nested canonical pointer still present and equal.
    const nestedTurn = turnMeta['agent_turn'] as Record<string, unknown>;
    expect(nestedTurn['session_atom_id']).toBe(sessions[0]!.id);
    expect(nestedTurn['session_atom_id']).toBe(turnMeta['session_id']);
  });

  it('agent-turn atom keeps the canonical nested agent_turn shape after assistant-text update (back-compat)', async () => {
    /*
     * The streaming-update path patches `metadata.agent_turn` only.
     * Because AtomPatch.metadata is shallow-merged into the existing
     * top-level metadata (per src/substrate/types.ts AtomPatch JSDoc
     * "Merged into existing metadata."), the top-level session_id
     * shadow MUST survive subsequent updates. This test pins that
     * invariant.
     */
    const host = createMemoryHost();
    await runDefaultHappyPathSession(host);
    const turns = (await host.atoms.query({ type: ['agent-turn'] }, 100)).atoms;
    const turnMeta = turns[0]!.metadata as Record<string, unknown>;
    // Top-level shadow survives the update.
    expect(typeof turnMeta['session_id']).toBe('string');
    // Nested shape intact + carrying the assistant-text content.
    const nestedTurn = turnMeta['agent_turn'] as Record<string, unknown>;
    expect(typeof nestedTurn['turn_index']).toBe('number');
    expect(nestedTurn['llm_input']).toBeDefined();
    expect(nestedTurn['llm_output']).toBeDefined();
    expect(Array.isArray(nestedTurn['tool_calls'])).toBe(true);
    expect(typeof nestedTurn['latency_ms']).toBe('number');
  });
});
