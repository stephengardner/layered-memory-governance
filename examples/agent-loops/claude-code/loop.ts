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
    // Fast-path: signal already aborted before we spawn anything.
    // We still write a minimal session atom (audit trail) but skip
    // the subprocess entirely.
    if (input.signal?.aborted === true) {
      const startedAt = new Date().toISOString();
      const sessionId = `agent-session-${randomBytes(6).toString('hex')}` as AtomId;
      const sessionAtom: Atom = mkAtom(sessionId, 'agent-session', input.principal, [], {
        agent_session: {
          model_id: 'claude-opus-4-7',
          adapter_id: 'claude-code-agent-loop',
          workspace_id: input.workspace.id,
          started_at: startedAt,
          completed_at: startedAt,
          terminal_state: 'aborted',
          replay_tier: input.replayTier,
          budget_consumed: { turns: 0, wall_clock_ms: 0 },
          failure: {
            kind: 'catastrophic',
            reason: 'signal already aborted at entry',
            stage: 'signal',
          },
        } satisfies AgentSessionMeta,
      });
      await input.host.atoms.put(sessionAtom);
      return {
        kind: 'aborted',
        sessionAtomId: sessionId,
        turnAtomIds: [],
        failure: {
          kind: 'catastrophic',
          reason: 'signal already aborted at entry',
          stage: 'signal',
        },
      };
    }

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
    // Hoisted out of the try block so the catch handler can route on
    // them. Without this, execa rejecting the result-promise on kill
    // (the documented v9 behavior: `subprocess.kill()` rejects with
    // ExecaError where isTerminated=true) would land in the catch with
    // these flags out of scope, and budget-exhausted / wall-clock /
    // signal-abort would all be misclassified as `kind: 'error'` via
    // the structural/transient default classifier.
    let wallClockExpired = false;
    let signalAborted = false;
    let turnsExhausted = false;
    // Captured from the CLI's `system` event (see stream-json-parser).
    // Threaded into the finally-block session-atom update so the agent
    // session records the model the CLI actually routed to (which may
    // differ from the hardcoded entry-time default, e.g. when the
    // operator's CLI auto-routes to a non-Opus default).
    let capturedModelId: string | undefined;
    // Hoisted so `finally` can clean them up even when the try block
    // throws before reaching its own cleanup site. The wall-clock
    // timer, signal-abort listener, and SIGKILL fallback timer all
    // hold `proc` in their closures; on a long-lived host across
    // many invocations, leaking these would tie up memory until the
    // timers fire (potentially minutes per invocation).
    let wallClockTimer: NodeJS.Timeout | null = null;
    let killTimerHard: NodeJS.Timeout | null = null;
    let onAbort: (() => void) | null = null;

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

      // Adapter-side wall-clock guard. The CLI's --max-budget-usd
      // covers cost; the adapter enforces wall-clock at the process
      // boundary so a hung subprocess cannot exceed the substrate
      // contract's max_wall_clock_ms. SIGTERM first, then SIGKILL
      // after killGracePeriodMs (default 5000ms) as a hard fallback.
      // Both .unref() so the timer never blocks process exit on its own.
      // wallClockExpired is hoisted to the run() scope so the catch
      // handler can route on it when execa rejects on kill().
      wallClockTimer = setTimeout(() => {
        wallClockExpired = true;
        try { proc.kill('SIGTERM'); } catch { /* already dead */ }
        const grace = this.opts.killGracePeriodMs ?? 5000;
        setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* already dead */ }
        }, grace).unref();
      }, input.budget.max_wall_clock_ms);
      wallClockTimer.unref();

      // Mid-run AbortSignal forwarding. Mirror the wall-clock pattern:
      // SIGTERM first, then SIGKILL after killGracePeriodMs as a hard
      // fallback. Set a flag so the post-loop classifier can map this
      // to kind: 'aborted' instead of relying on the exitCode.
      // signalAborted is hoisted to the run() scope so the catch
      // handler can route on it when execa rejects on kill().
      onAbort = () => {
        signalAborted = true;
        try { proc.kill('SIGTERM'); } catch { /* already dead */ }
        const grace = this.opts.killGracePeriodMs ?? 5000;
        killTimerHard = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* already dead */ }
        }, grace);
        killTimerHard.unref();
      };
      input.signal?.addEventListener('abort', onAbort, { once: true });

      // The adapter does not override stdio, so execa always exposes
      // `proc.stdout` as a Readable; the non-null assertion is justified.
      const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });

      let currentTurnAtomId: AtomId | null = null;
      let currentTurnIndex = 0;
      let pendingFirstTurnOpened = false;
      // max_turns guard: tripped in the tool-result branch when the
      // CLI is about to feed results back for the (max_turns+1)-th turn.
      // The substrate distinguishes structural exhaustion (this) from
      // catastrophic wall-clock cap above. Hoisted to the run() scope
      // so the catch handler can route on it when execa rejects on
      // the post-trip kill().

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
        // Stop draining the stream once a budget guard has tripped.
        // The subprocess has already been signalled (SIGTERM); we just
        // need to exit cooperatively so the post-loop classifier can
        // map the trip to the right `kind` + `failure`.
        if (turnsExhausted || wallClockExpired || signalAborted) break;
        // Parser returns ReadonlyArray<StreamJsonEvent>: zero-or-many
        // events per line so multi-block assistant messages (text +
        // tool_use, parallel tool_use) and parallel tool_result blocks
        // are not lost. Iterate per-line.
        const events = parseStreamJsonLine(rawLine);
        for (const ev of events) {
          if (turnsExhausted || wallClockExpired || signalAborted) break;
          if (ev.kind === 'system') {
            if (ev.modelId !== undefined) capturedModelId = ev.modelId;
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
            // Enforce max_turns here: if opening the next turn would
            // exceed the budget, signal the subprocess + flag the trip
            // and break out. The post-loop classifier maps this to
            // `kind: 'budget-exhausted'`.
            currentTurnIndex += 1;
            if (currentTurnIndex >= input.budget.max_turns) {
              turnsExhausted = true;
              try { proc.kill('SIGTERM'); } catch { /* already dead */ }
              break;
            }
            currentTurnAtomId = await openPlaceholderTurn(currentTurnIndex, '<tool-results-summary>');
          }
          // parse-error: log + skip (no-op)
        }
      }

      const procResult = await proc;
      // Cleanup of timers + listeners is hoisted to the finally block
      // below so a thrown exception inside the streaming loop cannot
      // leak the closures (which all hold `proc`).

      if (signalAborted) {
        // Highest precedence: operator-explicit "stop NOW". Beats
        // wall-clock + max-turns because the caller's intent is
        // explicit cancellation, not an internal budget trip.
        kind = 'aborted';
        failure = {
          kind: 'catastrophic',
          reason: 'caller cancelled',
          stage: 'signal',
        };
      } else if (wallClockExpired) {
        // Catastrophic: the subprocess hung past max_wall_clock_ms.
        // Distinguished from max_turns (structural) so postmortems can
        // separate "agent ran too long" from "agent hit turn budget".
        kind = 'aborted';
        failure = {
          kind: 'catastrophic',
          reason: 'wall-clock budget exhausted',
          stage: 'wall-clock-cap',
        };
      } else if (turnsExhausted) {
        // Structural: the agent used its whole turn budget without
        // converging. Recoverable by raising the cap or splitting work.
        kind = 'budget-exhausted';
        failure = {
          kind: 'structural',
          reason: 'turn budget hit',
          stage: 'max-turns-cap',
        };
      } else if (procResult.exitCode !== 0) {
        const failureKind = classifyClaudeCliFailure(null, procResult.exitCode, String(procResult.stderr ?? ''));
        kind = 'error';
        failure = {
          kind: failureKind,
          reason: String(procResult.stderr ?? '').slice(0, 1000),
          stage: 'claude-cli',
        };
      }
    } catch (err) {
      // Precedence order matches the post-loop classifier above:
      // signal-abort beats wall-clock beats turns-exhausted beats
      // generic error. execa v9 rejects the result-promise when the
      // subprocess is killed (ExecaError.isTerminated === true), so a
      // budget trip that signals SIGTERM lands HERE, not in the
      // try-block's procResult branch. Flag-routing keeps the
      // classification consistent across both paths.
      if (signalAborted) {
        kind = 'aborted';
        failure = {
          kind: 'catastrophic',
          reason: 'caller cancelled',
          stage: 'signal',
        };
      } else if (wallClockExpired) {
        kind = 'aborted';
        failure = {
          kind: 'catastrophic',
          reason: 'wall-clock budget exhausted',
          stage: 'wall-clock-cap',
        };
      } else if (turnsExhausted) {
        kind = 'budget-exhausted';
        failure = {
          kind: 'structural',
          reason: 'turn budget hit',
          stage: 'max-turns-cap',
        };
      } else {
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
      }
    } finally {
      // Hoisted-cleanup discipline: clear timers + remove the abort
      // listener even when the try block throws. Each closure holds
      // `proc` in scope; on a long-lived host across many invocations,
      // leaking these would tie up memory until the timers fire (up
      // to max_wall_clock_ms per leak). .unref() is not enough -- it
      // prevents process-hang but does not release the closure.
      if (wallClockTimer !== null) clearTimeout(wallClockTimer);
      if (killTimerHard !== null) clearTimeout(killTimerHard);
      if (input.signal !== undefined && onAbort !== null) {
        input.signal.removeEventListener('abort', onAbort);
      }
      const completedAt = new Date().toISOString();
      try {
        await input.host.atoms.update(sessionId, {
          metadata: {
            agent_session: {
              // Prefer the model the CLI's `system` event reported (so
              // operator CLIs that auto-route to a different default
              // record the actual model that ran). Fall back to the
              // entry-time default for runs that never reached the
              // first system event (e.g. spawn-time error).
              model_id: capturedModelId ?? 'claude-opus-4-7',
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
