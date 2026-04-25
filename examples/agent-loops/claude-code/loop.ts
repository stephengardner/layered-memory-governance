/**
 * Production AgentLoopAdapter that spawns the Claude Code CLI in
 * agentic-headless mode (`claude -p --output-format stream-json
 * --verbose ...`), parses the streamed NDJSON, writes session +
 * placeholder turn atoms BEFORE each LLM call (per substrate
 * contract `src/substrate/agent-loop.ts:46-47`), and updates them
 * as content streams in.
 *
 * Composes the helpers in this directory:
 *   - parseStreamJsonLine (./stream-json-parser.ts)
 *   - buildPromptText     (./prompt-builder.ts)
 *   - classifyClaudeCliFailure (./classifier.ts)
 *   - captureArtifacts    (./artifacts.ts)
 *   - spawnClaudeCli      (./spawn.ts)
 */

import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { execa as ExecaType } from 'execa';
import type {
  AdapterCapabilities,
  AgentLoopAdapter,
  AgentLoopInput,
  AgentLoopResult,
} from '../../../src/substrate/agent-loop.js';
import type { BlobStore, BlobRef } from '../../../src/substrate/blob-store.js';
import type {
  AgentSessionMeta,
  AgentTurnMeta,
  Atom,
  AtomId,
  PrincipalId,
} from '../../../src/substrate/types.js';
import { parseStreamJsonLine } from './stream-json-parser.js';
import { buildPromptText } from './prompt-builder.js';
import { classifyClaudeCliFailure } from './classifier.js';
import { spawnClaudeCli } from './spawn.js';

export interface ClaudeCodeAgentLoopOptions {
  readonly claudePath?: string;
  readonly extraArgs?: ReadonlyArray<string>;
  readonly verbose?: boolean;
  readonly execImpl?: typeof ExecaType;
  readonly killGracePeriodMs?: number;
}

export class ClaudeCodeAgentLoopAdapter implements AgentLoopAdapter {
  readonly capabilities: AdapterCapabilities = {
    tracks_cost: true,
    supports_signal: true,
    classify_failure: classifyClaudeCliFailure,
  };

  constructor(private readonly opts: ClaudeCodeAgentLoopOptions = {}) {}

  async run(input: AgentLoopInput): Promise<AgentLoopResult> {
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();
    const sessionId = `agent-session-${randomBytes(6).toString('hex')}` as AtomId;
    const sessionAtom: Atom = mkAtom(sessionId, 'agent-session', input.principal, [], {
      agent_session: {
        model_id: 'claude-opus-4-7',
        adapter_id: 'claude-code-agent-loop',
        workspace_id: input.workspace.id,
        started_at: startedAt,
        terminal_state: 'completed',
        replay_tier: input.replayTier,
        budget_consumed: { turns: 0, wall_clock_ms: 0 },
      } satisfies AgentSessionMeta,
    });
    await input.host.atoms.put(sessionAtom);

    const turnAtomIds: AtomId[] = [];
    let costUsd: number | undefined;
    let kind: AgentLoopResult['kind'] = 'completed';
    let failure: AgentLoopResult['failure'] | undefined;

    try {
      const prompt = buildPromptText(input.task);
      const proc = spawnClaudeCli({
        prompt,
        workspaceDir: input.workspace.path,
        budget: input.budget,
        disallowedTools: input.toolPolicy.disallowedTools,
        ...(this.opts.claudePath !== undefined ? { claudePath: this.opts.claudePath } : {}),
        ...(this.opts.extraArgs !== undefined ? { extraArgs: this.opts.extraArgs } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        ...(this.opts.execImpl !== undefined ? { execImpl: this.opts.execImpl } : {}),
      });

      // The adapter does not override stdio, so execa always exposes
      // `proc.stdout` as a Readable; the non-null assertion is justified.
      const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });

      let currentTurnAtomId: AtomId | null = null;
      let currentTurnIndex = 0;
      let pendingFirstTurnOpened = false;

      // Tool-use correlation maps. In-memory only, never persisted.
      // The (turn_id, index) pair is the only safe correlation under
      // parallel tool_use; "walk backwards looking for last empty
      // result" would write the wrong tool's result into the wrong
      // entry. tool_use_id -> turn atom id and tool_use_id -> index
      // within that turn's tool_calls array, captured at tool_use time.
      const toolUseToTurn = new Map<string, AtomId>();
      const toolUseToCallIndex = new Map<string, number>();
      const toolUseStartMs = new Map<string, number>();

      const openPlaceholderTurn = async (turnIndex: number, llmInputText: string): Promise<AtomId> => {
        const turnId = `agent-turn-${randomBytes(6).toString('hex')}` as AtomId;
        let redactedInput: string;
        try {
          redactedInput = input.redactor.redact(llmInputText, { kind: 'llm-input', principal: input.principal });
        } catch (e) {
          throw Object.assign(new Error('redactor crashed on llm-input'), { name: 'RedactorError', cause: e });
        }
        const turnMeta: AgentTurnMeta = {
          session_atom_id: sessionId,
          turn_index: turnIndex,
          llm_input: { inline: redactedInput },
          llm_output: { inline: '' },
          tool_calls: [],
          latency_ms: 0,
        };
        const turnAtom: Atom = mkAtom(turnId, 'agent-turn', input.principal, [sessionId], { agent_turn: turnMeta });
        await input.host.atoms.put(turnAtom);
        turnAtomIds.push(turnId);
        return turnId;
      };

      for await (const rawLine of rl) {
        // Parser returns ReadonlyArray<StreamJsonEvent>: zero-or-many
        // events per line so multi-block assistant messages (text +
        // tool_use, parallel tool_use) and parallel tool_result blocks
        // are not lost. Iterate per-line.
        const events = parseStreamJsonLine(rawLine);
        for (const ev of events) {
          if (ev.kind === 'system') {
            if (!pendingFirstTurnOpened) {
              currentTurnAtomId = await openPlaceholderTurn(currentTurnIndex, prompt);
              pendingFirstTurnOpened = true;
            }
          } else if (ev.kind === 'assistant-text') {
            if (currentTurnAtomId === null) {
              currentTurnAtomId = await openPlaceholderTurn(currentTurnIndex, prompt);
              pendingFirstTurnOpened = true;
            }
            let redactedOut: string;
            try {
              redactedOut = input.redactor.redact(ev.text, { kind: 'llm-output', principal: input.principal });
            } catch (e) {
              throw Object.assign(new Error('redactor crashed on llm-output'), { name: 'RedactorError', cause: e });
            }
            // Read existing turn atom; preserve llm_input + tool_calls;
            // update llm_output + latency_ms only. Avoids re-redacting
            // the prompt on every assistant-text event.
            const existing = await input.host.atoms.get(currentTurnAtomId);
            const existingMeta = existing !== null
              ? ((existing.metadata as Record<string, unknown>)['agent_turn'] as AgentTurnMeta)
              : undefined;
            await input.host.atoms.update(currentTurnAtomId, {
              metadata: {
                agent_turn: {
                  session_atom_id: sessionId,
                  turn_index: currentTurnIndex,
                  llm_input: existingMeta?.llm_input ?? { inline: '' },
                  llm_output: await routePayload(redactedOut, input.blobStore, input.blobThreshold),
                  tool_calls: existingMeta?.tool_calls ?? [],
                  latency_ms: Date.now() - startedAtMs,
                } satisfies AgentTurnMeta,
              },
            });
          } else if (ev.kind === 'result') {
            if (typeof ev.costUsd === 'number') costUsd = ev.costUsd;
          } else if (ev.kind === 'tool-use') {
            if (currentTurnAtomId === null) {
              // CLI emitted tool_use before any system event; open turn 0 lazily.
              currentTurnAtomId = await openPlaceholderTurn(currentTurnIndex, prompt);
              pendingFirstTurnOpened = true;
            }
            const argsStr = JSON.stringify(ev.input);
            let redactedArgs: string;
            try {
              redactedArgs = input.redactor.redact(argsStr, { kind: 'tool-args', principal: input.principal });
            } catch (e) {
              throw Object.assign(new Error('redactor crashed on tool_use args'), { name: 'RedactorError', cause: e });
            }
            const turnAtom = await input.host.atoms.get(currentTurnAtomId);
            if (turnAtom !== null) {
              const meta = turnAtom.metadata as Record<string, unknown>;
              const turnMeta = meta['agent_turn'] as AgentTurnMeta;
              const newIndex = turnMeta.tool_calls.length;
              const updated: AgentTurnMeta = {
                ...turnMeta,
                tool_calls: [...turnMeta.tool_calls, {
                  tool: ev.toolName,
                  args: await routePayload(redactedArgs, input.blobStore, input.blobThreshold),
                  result: { inline: '' },
                  latency_ms: 0,
                  outcome: 'success',
                }],
              };
              await input.host.atoms.update(currentTurnAtomId, { metadata: { agent_turn: updated } });
              toolUseToTurn.set(ev.toolUseId, currentTurnAtomId);
              toolUseToCallIndex.set(ev.toolUseId, newIndex);
              toolUseStartMs.set(ev.toolUseId, Date.now());
            }
          } else if (ev.kind === 'tool-result') {
            const targetTurnId = toolUseToTurn.get(ev.toolUseId);
            const targetCallIndex = toolUseToCallIndex.get(ev.toolUseId);
            if (targetTurnId === undefined || targetCallIndex === undefined) {
              // Unknown tool_use_id (corruption / version skew); log + skip, never throw.
              continue;
            }
            let redactedResult: string;
            try {
              redactedResult = input.redactor.redact(ev.content, { kind: 'tool-result', principal: input.principal });
            } catch (e) {
              throw Object.assign(new Error('redactor crashed on tool_result'), { name: 'RedactorError', cause: e });
            }
            const targetAtom = await input.host.atoms.get(targetTurnId);
            if (targetAtom !== null) {
              const meta = targetAtom.metadata as Record<string, unknown>;
              const turnMeta = meta['agent_turn'] as AgentTurnMeta;
              const startedToolMs = toolUseStartMs.get(ev.toolUseId) ?? Date.now();
              const policyDenied = ev.isError && /permission denied|tool not allowed/i.test(ev.content);
              const outcome: 'success' | 'tool-error' | 'policy-refused' = ev.isError
                ? (policyDenied ? 'policy-refused' : 'tool-error')
                : 'success';
              // Replace the SPECIFIC tool_calls[targetCallIndex] entry. Safe
              // under parallel tool_use because the index was recorded at
              // tool_use time.
              const newCalls = turnMeta.tool_calls.slice();
              const existing = newCalls[targetCallIndex];
              if (existing !== undefined) {
                newCalls[targetCallIndex] = {
                  tool: existing.tool,
                  args: existing.args,
                  result: await routePayload(redactedResult, input.blobStore, input.blobThreshold),
                  latency_ms: Date.now() - startedToolMs,
                  outcome,
                };
              }
              const updated: AgentTurnMeta = { ...turnMeta, tool_calls: newCalls };
              await input.host.atoms.update(targetTurnId, { metadata: { agent_turn: updated } });
            }
            toolUseToTurn.delete(ev.toolUseId);
            toolUseToCallIndex.delete(ev.toolUseId);
            toolUseStartMs.delete(ev.toolUseId);
            // Open the NEXT placeholder turn -- the CLI is feeding tool
            // results back to the LLM, which triggers a new LLM call.
            currentTurnIndex += 1;
            currentTurnAtomId = await openPlaceholderTurn(currentTurnIndex, '<tool-results-summary>');
          }
          // parse-error: log + skip (no-op)
        }
      }

      const procResult = await proc;
      if (procResult.exitCode !== 0) {
        const failureKind = classifyClaudeCliFailure(null, procResult.exitCode, String(procResult.stderr ?? ''));
        kind = 'error';
        failure = {
          kind: failureKind,
          reason: String(procResult.stderr ?? '').slice(0, 1000),
          stage: 'claude-cli',
        };
      }
    } catch (err) {
      kind = 'error';
      const errName = err instanceof Error ? err.name : '';
      const isRedactorErr = errName === 'RedactorError';
      const isBlobStoreErr = errName === 'BlobStoreError';
      const pinnedCatastrophic = isRedactorErr || isBlobStoreErr;
      failure = {
        kind: pinnedCatastrophic ? 'catastrophic' : classifyClaudeCliFailure(err, null, ''),
        reason: err instanceof Error ? err.message : String(err),
        stage: isRedactorErr ? 'redactor' : (isBlobStoreErr ? 'blob-store' : 'claude-cli'),
      };
    } finally {
      const completedAt = new Date().toISOString();
      try {
        await input.host.atoms.update(sessionId, {
          metadata: {
            agent_session: {
              model_id: 'claude-opus-4-7',
              adapter_id: 'claude-code-agent-loop',
              workspace_id: input.workspace.id,
              started_at: startedAt,
              completed_at: completedAt,
              terminal_state: kind === 'completed' ? 'completed' : kind,
              replay_tier: input.replayTier,
              budget_consumed: {
                turns: turnAtomIds.length,
                wall_clock_ms: Date.now() - startedAtMs,
                ...(costUsd !== undefined ? { usd: costUsd } : {}),
              },
              ...(failure !== undefined ? { failure } : {}),
            } satisfies AgentSessionMeta,
          },
        });
      } catch {
        // Atom-store update failure on session close is non-fatal;
        // we do not let it overwrite the upstream `kind`.
      }
    }

    return {
      kind,
      sessionAtomId: sessionId,
      turnAtomIds,
      ...(failure !== undefined ? { failure } : {}),
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
    schema_version: 1,
    id,
    content: '',
    type,
    layer: 'L1',
    provenance: { kind: 'agent-observed', source: { agent_id: principal as unknown as string }, derived_from: derived as AtomId[] },
    confidence: 1,
    created_at: now,
    last_reinforced_at: now,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
    principal_id: principal,
    taint: 'clean',
    metadata,
  };
}

async function routePayload(
  payload: string,
  blobStore: BlobStore,
  threshold: number,
): Promise<{ readonly inline: string } | { readonly ref: BlobRef }> {
  if (Buffer.byteLength(payload, 'utf8') > threshold) {
    let ref: BlobRef;
    try {
      ref = await blobStore.put(payload);
    } catch (e) {
      // Wrap with a typed marker so the run() catch block can pin
      // failure.kind = 'catastrophic'. A BlobStore put failure on an
      // over-threshold payload cannot fall through to inline (the
      // payload may not fit safely in an atom), and re-running the
      // CLI is unlikely to succeed without operator intervention.
      throw Object.assign(new Error('blob-store put failed'), { name: 'BlobStoreError', cause: e });
    }
    return { ref };
  }
  return { inline: payload };
}
