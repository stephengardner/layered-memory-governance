/**
 * SKELETON reference AgentLoopAdapter.
 *
 * IMPORTANT: this is a substrate-validation skeleton, NOT the
 * production agentic Claude Code path. Full Claude Code CLI
 * integration (subprocess spawn, real tool whitelist, real budget
 * enforcement, signal handling, multi-turn iteration) is a separate
 * follow-up that consumes this seam.
 *
 * What this skeleton DOES
 * -----------------------
 *   - Emits one `agent-session` atom on entry.
 *   - Emits one `agent-turn` atom for the LLM call.
 *   - Applies `input.redactor` to LLM input + output before atom
 *     write.
 *   - Honors `AbortSignal` early-cancellation.
 *   - Optional `stubResponse` for deterministic tests.
 *
 * What this skeleton does NOT do
 * ------------------------------
 *   - Spawn the Claude Code CLI subprocess (a real production
 *     adapter would).
 *   - Iterate multiple turns.
 *   - Emit real tool-call records.
 *   - Compute canon snapshots for strict replay tier.
 *
 * The seam shape is what this skeleton ships. The behaviour grows
 * once a production adapter consumes the same interface.
 */

import { randomBytes } from 'node:crypto';
import type {
  AgentLoopAdapter,
  AgentLoopInput,
  AgentLoopResult,
  AdapterCapabilities,
} from '../../../src/substrate/agent-loop.js';
import { defaultClassifyFailure } from '../../../src/substrate/agent-loop.js';
import type {
  Atom,
  AtomId,
  AgentSessionMeta,
  AgentTurnMeta,
  PrincipalId,
} from '../../../src/substrate/types.js';

export interface ClaudeCodeAgentLoopSkeletonOptions {
  /** For tests: stubbed LLM output. Production path calls `host.llm.judge()`. */
  readonly stubResponse?: string;
}

export class ClaudeCodeAgentLoopSkeleton implements AgentLoopAdapter {
  readonly capabilities: AdapterCapabilities = {
    tracks_cost: false,
    supports_signal: true,
    classify_failure: defaultClassifyFailure,
  };

  constructor(private readonly opts: ClaudeCodeAgentLoopSkeletonOptions = {}) {}

  async run(input: AgentLoopInput): Promise<AgentLoopResult> {
    if (input.signal?.aborted) {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    const startedAt = new Date().toISOString();
    const sessionId = `agent-session-${randomBytes(6).toString('hex')}` as AtomId;
    const sessionMetaInitial: AgentSessionMeta = {
      model_id: 'claude-opus-4-7',
      adapter_id: 'claude-code-agent-loop-skeleton',
      workspace_id: input.workspace.id,
      started_at: startedAt,
      terminal_state: 'completed',
      replay_tier: input.replayTier,
      budget_consumed: { turns: 0, wall_clock_ms: 0 },
    };
    const sessionAtom: Atom = mkAtom(sessionId, 'agent-session', input.principal, [], { agent_session: sessionMetaInitial });
    await input.host.atoms.put(sessionAtom);

    const promptText = input.task.questionPrompt ?? '';
    const redactedInput = input.redactor.redact(promptText, { kind: 'llm-input', principal: input.principal });
    const responseText = this.opts.stubResponse ?? `(skeleton response to: ${promptText.slice(0, 40)})`;
    const redactedOutput = input.redactor.redact(responseText, { kind: 'llm-output', principal: input.principal });

    const turnId = `agent-turn-${randomBytes(6).toString('hex')}` as AtomId;
    const turnMeta: AgentTurnMeta = {
      session_atom_id: sessionId,
      turn_index: 0,
      llm_input: { inline: redactedInput },
      llm_output: { inline: redactedOutput },
      tool_calls: [],
      latency_ms: 0,
    };
    const turnAtom: Atom = mkAtom(turnId, 'agent-turn', input.principal, [sessionId], { agent_turn: turnMeta });
    await input.host.atoms.put(turnAtom);

    // Update session terminal state. AtomStore.update performs a
    // SHALLOW merge at the top of metadata; the agent_session value
    // is REPLACED in full. Build the full replacement here rather
    // than relying on a (non-existent) deep merge.
    const completedAt = new Date().toISOString();
    await input.host.atoms.update(sessionId, {
      metadata: {
        agent_session: {
          ...sessionMetaInitial,
          completed_at: completedAt,
          terminal_state: 'completed',
          budget_consumed: { turns: 1, wall_clock_ms: 0 },
        },
      },
    });

    return {
      kind: 'completed',
      sessionAtomId: sessionId,
      turnAtomIds: [turnId],
    };
  }
}

function mkAtom(
  id: AtomId,
  type: 'agent-session' | 'agent-turn',
  principal: PrincipalId,
  derived: ReadonlyArray<AtomId>,
  metadata: Record<string, unknown>,
): Atom {
  const now = new Date().toISOString();
  return {
    schema_version: 1, id, content: '', type, layer: 'L1',
    provenance: { kind: 'agent-observed', source: { agent_id: principal as unknown as string }, derived_from: derived as AtomId[] },
    confidence: 1, created_at: now, last_reinforced_at: now, expires_at: null,
    supersedes: [], superseded_by: [], scope: 'project',
    signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
    principal_id: principal, taint: 'clean',
    metadata,
  };
}
