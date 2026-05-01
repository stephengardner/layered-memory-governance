import { AtomRef } from '@/components/atom-ref/AtomRef';
import { Section, AttrRow } from '../Section';
import { asString, asNumber, asRecord, formatDate } from './helpers';
import styles from '../AtomDetailView.module.css';
import type { AtomRendererProps } from './types';

/**
 * Agent-session renderer. Agent-loop sessions (PR1 substrate) emit a
 * session atom on start and one agent-turn atom per tool/LLM call;
 * this renderer surfaces the session-tree breadcrumb (model, adapter,
 * workspace, terminal_state, budget_consumed).
 */
export function AgentSessionRenderer({ atom }: AtomRendererProps) {
  const meta = asRecord(atom.metadata) ?? {};
  const sessionId = asString(meta['session_id']);
  const startedAt = asString(meta['started_at']);
  const workspaceId = asString(meta['workspace_id']);
  const session = asRecord(meta['agent_session']);
  const modelId = session ? asString(session['model_id']) : null;
  const adapterId = session ? asString(session['adapter_id']) : null;
  const terminalState = session ? asString(session['terminal_state']) : null;
  const replayTier = session ? asString(session['replay_tier']) : null;
  const budget = session ? asRecord(session['budget_consumed']) : null;
  const budgetTurns = budget ? asNumber(budget['turns']) : null;
  const budgetWallClockMs = budget ? asNumber(budget['wall_clock_ms']) : null;
  const budgetUsd = budget ? asNumber(budget['usd']) : null;

  return (
    <Section title="Agent session" testId="atom-detail-agent-session">
      <dl className={styles.attrs}>
        {sessionId && (
          <AttrRow
            label="Session id"
            value={<code data-testid="atom-detail-agent-session-id">{sessionId}</code>}
            mono
          />
        )}
        {modelId && <AttrRow label="Model" value={<code>{modelId}</code>} />}
        {adapterId && <AttrRow label="Adapter" value={<code>{adapterId}</code>} />}
        {workspaceId && <AttrRow label="Workspace" value={<code>{workspaceId}</code>} />}
        {startedAt && <AttrRow label="Started" value={formatDate(startedAt)} />}
        {terminalState && (
          <AttrRow
            label="Terminal state"
            value={<code data-testid="atom-detail-agent-session-terminal-state">{terminalState}</code>}
          />
        )}
        {replayTier && <AttrRow label="Replay tier" value={replayTier} />}
        {budgetTurns !== null && (
          <AttrRow label="Turns" value={String(budgetTurns)} />
        )}
        {budgetWallClockMs !== null && (
          <AttrRow label="Wall clock" value={`${budgetWallClockMs}ms`} />
        )}
        {budgetUsd !== null && (
          <AttrRow label="USD" value={`$${budgetUsd.toFixed(4)}`} />
        )}
      </dl>
    </Section>
  );
}

/**
 * Agent-turn renderer. Each turn captures one LLM call: input/output
 * (often abbreviated to inline previews), tool_calls list, latency,
 * plus the parent session pointer.
 */
export function AgentTurnRenderer({ atom }: AtomRendererProps) {
  const meta = asRecord(atom.metadata) ?? {};
  const sessionId = asString(meta['session_id']);
  const turn = asRecord(meta['agent_turn']);
  const sessionAtomId = turn ? asString(turn['session_atom_id']) : null;
  const turnIndex = turn ? asNumber(turn['turn_index']) : null;
  const latencyMs = turn ? asNumber(turn['latency_ms']) : null;
  const llmInput = turn ? asRecord(turn['llm_input']) : null;
  const llmOutput = turn ? asRecord(turn['llm_output']) : null;
  const llmInputInline = llmInput ? asString(llmInput['inline']) : null;
  const llmOutputInline = llmOutput ? asString(llmOutput['inline']) : null;
  const toolCalls = turn && Array.isArray(turn['tool_calls']) ? turn['tool_calls'].length : 0;

  return (
    <>
      <Section title="Agent turn" testId="atom-detail-agent-turn">
        <dl className={styles.attrs}>
          {turnIndex !== null && (
            <AttrRow label="Turn" value={`#${turnIndex}`} testId="atom-detail-agent-turn-index" />
          )}
          {sessionAtomId && (
            <AttrRow label="Session" value={<AtomRef id={sessionAtomId} />} />
          )}
          {!sessionAtomId && sessionId && (
            <AttrRow label="Session id" value={<code>{sessionId}</code>} mono />
          )}
          {latencyMs !== null && <AttrRow label="Latency" value={`${latencyMs}ms`} />}
          <AttrRow label="Tool calls" value={String(toolCalls)} />
        </dl>
      </Section>

      {(llmInputInline || llmOutputInline) && (
        <Section title="LLM exchange" testId="atom-detail-agent-turn-llm">
          {llmInputInline && (
            <div data-testid="atom-detail-agent-turn-input">
              <h4 className={styles.attrLabel}>Input (inline)</h4>
              <pre className={styles.codeBlock}>{llmInputInline}</pre>
            </div>
          )}
          {llmOutputInline && (
            <div data-testid="atom-detail-agent-turn-output">
              <h4 className={styles.attrLabel}>Output (inline)</h4>
              <pre className={styles.codeBlock}>{llmOutputInline}</pre>
            </div>
          )}
        </Section>
      )}
    </>
  );
}
