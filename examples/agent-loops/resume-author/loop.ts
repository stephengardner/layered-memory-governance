/**
 * ResumeAuthorAgentLoopAdapter: a policy-free wrapper that tries to resume
 * a prior agent session before falling back to a fresh-spawn via the
 * underlying agent-loop adapter.
 *
 * Composition shape
 * -----------------
 * The wrapper accepts a `fallback` AgentLoopAdapter (typically a
 * fresh-spawn adapter such as ClaudeCodeAgentLoopAdapter) plus an ordered
 * list of `SessionResumeStrategy` instances. On each `run()` invocation:
 *
 *   1. The caller-supplied `assembleCandidates` callback returns the
 *      candidate session list (caller decides the walk; wrapper does
 *      not interpret the source chain).
 *   2. Strategies are tried in declaration order; the first non-null
 *      `ResolvedSession` wins.
 *   3. If a strategy resolves: the wrapper invokes the optional
 *      `preparation` closure, then delegates to `fallback.run(input)`
 *      with `input.resumeSessionId` set to the resolved session's
 *      opaque resume token. The fallback adapter is responsible for
 *      honoring that token (e.g. spawning `claude --resume <uuid>`).
 *   4. On any non-`completed` resume result OR any throw from the resume
 *      attempt OR any throw from `preparation`, the wrapper delegates
 *      to `fallback.run(input)` again WITHOUT the resume token (a
 *      fresh-spawn). Both the resume attempt and the fresh-spawn
 *      produce separate session atoms for audit clarity.
 *   5. If no strategy resolves (or candidate assembly throws), the
 *      wrapper delegates directly to `fallback.run(input)` without ever
 *      attempting a resume.
 *
 * Policy posture
 * --------------
 * The wrapper is intentionally policy-free: no failure classification,
 * no retry, no escalation. Strategies own resume-specific decisions; the
 * fallback owns its own behavior; the wrapper only orchestrates the
 * try-resume-then-fallback shape. Compounded retry is a known
 * anti-pattern and is explicitly avoided.
 *
 * Substrate touch
 * ---------------
 * The wrapper relies on a substrate-additive optional field
 * `AgentLoopInput.resumeSessionId`. Adapters that do not support resume
 * MUST ignore this field; resume-aware adapters MAY honor it by
 * spawning a resumed session. The field is mechanism-neutral: the
 * value's interpretation is adapter-specific.
 *
 * Audit-trail invariants
 * ----------------------
 * Both the resume attempt and any subsequent fresh-spawn produce
 * separate `agent-session` atoms via the underlying adapter's standard
 * write-on-entry contract; the wrapper never edits the fresh-spawn's
 * atoms. On a successful resume, the wrapper patches the resumed
 * session atom's `metadata.agent_session.extra` with
 * `resumed_from_atom_id` and `resume_strategy_used`; the patch failure
 * (e.g. atom-store unavailable) is non-fatal because the resume itself
 * already succeeded.
 */

import type {
  AdapterCapabilities,
  AgentLoopAdapter,
  AgentLoopInput,
  AgentLoopResult,
} from '../../../src/substrate/agent-loop.js';
import type { Host } from '../../../src/substrate/interface.js';
import type {
  AgentSessionMeta,
} from '../../../src/substrate/types.js';
import type {
  CandidateSession,
  ResolvedSession,
  ResumeContext,
  SessionResumeStrategy,
} from './types.js';

export interface ResumeAuthorAdapterOptions {
  readonly fallback: AgentLoopAdapter;
  readonly host: Host;
  readonly strategies: ReadonlyArray<SessionResumeStrategy>;
  /**
   * Caller-supplied callback that assembles candidate sessions for the
   * current run. The wrapper invokes it once per `run(input)` call. The
   * callback closes over whatever per-iteration context the caller
   * needs; the wrapper does not interpret the source chain.
   *
   * Returning an empty array is fine: strategies will all return null
   * and the wrapper delegates directly to `fallback`.
   */
  readonly assembleCandidates: (input: AgentLoopInput) => Promise<ReadonlyArray<CandidateSession>>;
  /*
   * Staleness windows are owned by individual strategies (each strategy
   * accepts its own `maxStaleHours` constructor option). The wrapper
   * intentionally exposes no global default to avoid the dead-knob
   * trap: a wrapper-level field that never reaches strategies misleads
   * operators tuning a single number and seeing no effect. If a future
   * cross-strategy default emerges, plumb it via `ResumeContext` so
   * strategies can read and choose to honor it.
   */
}

export class ResumeAuthorAgentLoopAdapter implements AgentLoopAdapter {
  readonly capabilities: AdapterCapabilities;

  constructor(private readonly opts: ResumeAuthorAdapterOptions) {
    if (opts.fallback === undefined || opts.fallback === null) {
      throw new Error('ResumeAuthorAgentLoopAdapter: fallback is required');
    }
    // Mirror the fallback's capabilities so consumers see uniform
    // behavior regardless of whether the wrapper is composed in.
    this.capabilities = opts.fallback.capabilities;
  }

  async run(input: AgentLoopInput): Promise<AgentLoopResult> {
    const resolved = await this.resolveSession(input);

    if (resolved === null) {
      // No strategy resolved (or candidate assembly threw); fresh-spawn
      // via the fallback. Pass input through unchanged so the fallback
      // sees no resumeSessionId hint.
      return this.opts.fallback.run(input);
    }

    if (resolved.preparation !== undefined) {
      try {
        await resolved.preparation();
      } catch {
        // Preparation failed (e.g. disk full, blob fetch failure);
        // delegate to fresh-spawn. The wrapper does NOT retry the
        // preparation; that is a strategy concern.
        return this.opts.fallback.run(input);
      }
    }

    let resumeResult: AgentLoopResult;
    try {
      resumeResult = await this.opts.fallback.run({
        ...input,
        resumeSessionId: resolved.resumableSessionId,
      });
    } catch {
      // Resume invocation threw (the underlying adapter raised an
      // exception). Delegate to fresh-spawn. The resume's own session
      // atom (if any was written before the throw) is preserved as-is
      // by the underlying adapter; the wrapper does not retroactively
      // edit it.
      return this.opts.fallback.run(input);
    }

    if (resumeResult.kind !== 'completed') {
      // Resume reached a non-completed terminal state; delegate to
      // fresh-spawn. Both attempts produce separate session atoms,
      // satisfying the audit-trail invariant. The wrapper does NOT
      // retroactively edit the resume's session atom.
      return this.opts.fallback.run(input);
    }

    // Resume succeeded. Patch the new session atom with cross-reference
    // metadata so audit traversal can link the resumed run back to its
    // source session and identify which strategy resolved it. Patch
    // failure (e.g. atom-store update unavailable) is non-fatal: the
    // resume itself already succeeded, so the operator's expected
    // behavior is for the run to return success.
    await this.patchResumedSessionAtom(resumeResult, resolved);
    return resumeResult;
  }

  /**
   * Assemble candidates and try strategies. Returns the first non-null
   * `ResolvedSession`, or null if none resolve OR if assembly/strategy
   * iteration throws. Throw-suppression is intentional: candidate
   * assembly is a best-effort signal, not a hard contract; on failure
   * the wrapper falls through to fresh-spawn.
   */
  private async resolveSession(input: AgentLoopInput): Promise<ResolvedSession | null> {
    let candidates: ReadonlyArray<CandidateSession>;
    try {
      candidates = await this.opts.assembleCandidates(input);
    } catch {
      return null;
    }
    const ctx: ResumeContext = {
      candidateSessions: candidates,
      workspace: input.workspace,
      host: this.opts.host,
    };
    for (const strategy of this.opts.strategies) {
      try {
        const r = await strategy.findResumableSession(ctx);
        if (r !== null) return r;
      } catch {
        // Strategy threw; try the next strategy. A single misbehaving
        // strategy MUST NOT prevent the wrapper from trying the rest.
      }
    }
    return null;
  }

  /**
   * Patch the resumed session atom with `extra.resumed_from_atom_id`
   * and `extra.resume_strategy_used`. Reads-merges-writes so the patch
   * does not erase fields the underlying adapter already wrote (e.g.
   * `resumable_session_id`, model_id, budget_consumed). Patch failure
   * is swallowed so a transient atom-store error does not flip an
   * already-successful resume into an error.
   */
  private async patchResumedSessionAtom(
    resumeResult: AgentLoopResult,
    resolved: ResolvedSession,
  ): Promise<void> {
    try {
      const atom = await this.opts.host.atoms.get(resumeResult.sessionAtomId);
      if (atom === null) return;
      const meta = atom.metadata as Record<string, unknown>;
      const existing = (meta['agent_session'] as AgentSessionMeta | undefined) ?? undefined;
      if (existing === undefined) return;
      const mergedExtra: Record<string, unknown> = {
        ...(existing.extra ?? {}),
        resumed_from_atom_id: resolved.resumedFromSessionAtomId,
        resume_strategy_used: resolved.strategyName,
      };
      const next: AgentSessionMeta = {
        ...existing,
        extra: mergedExtra,
      };
      await this.opts.host.atoms.update(resumeResult.sessionAtomId, {
        metadata: { agent_session: next },
      });
    } catch {
      // Non-fatal: resume already succeeded.
    }
  }
}
