import type { AtomId, PrincipalId, Time } from '../../../src/substrate/types.js';
import type { Workspace } from '../../../src/substrate/workspace-provider.js';
import type { Host } from '../../../src/substrate/interface.js';

export interface CandidateSession {
  readonly sessionAtomId: AtomId;
  /**
   * Adapter-neutral resumable token. Read from
   * metadata.agent_session.extra.resumable_session_id. For one CLI adapter
   * this is the CLI session UUID; for other adapters it is whatever opaque
   * token the adapter's sessionPersistExtras produced.
   */
  readonly resumableSessionId: string;
  readonly startedAt: Time;
  /**
   * Full extra slot from the session atom. Strategies that need
   * adapter-specific fields (e.g. session_file_blob_ref, cli_version)
   * read them from here.
   */
  readonly extra: Readonly<Record<string, unknown>>;
  /**
   * The agent-loop adapter id that produced this session
   * (e.g. 'claude-code-agent-loop'). Strategies use this to skip
   * sessions produced by an incompatible adapter.
   */
  readonly adapterId: string;
}

export interface ResumeContext {
  /**
   * Caller-assembled candidate sessions, sorted newest-first. The caller
   * walks whatever atom chain makes sense for its workflow; the wrapper
   * does not interpret the source chain.
   */
  readonly candidateSessions: ReadonlyArray<CandidateSession>;
  readonly workspace: Workspace;
  readonly host: Host;
}

export interface ResolvedSession {
  /** Pass directly to the adapter's resume invocation. */
  readonly resumableSessionId: string;
  readonly resumedFromSessionAtomId: AtomId;
  readonly strategyName: string;
  /**
   * Optional preparation step (e.g., write a session file to local CLI
   * cache before the underlying adapter resumes). The wrapper calls this
   * after the strategy resolves and before delegating to the fallback
   * adapter with `resumeSessionId`.
   *
   * A throw from `preparation` is caught by the wrapper and treated as
   * "resume not viable": the wrapper delegates to fresh-spawn via
   * `fallback.run(input)` (without the resume token). Strategies SHOULD
   * NOT rely on the exception propagating to the caller; the wrapper
   * actively neutralizes it. Loud failure semantics live INSIDE the
   * strategy (e.g. logging via `host.auditor`) before throwing.
   */
  readonly preparation?: () => Promise<void>;
}

export interface SessionResumeStrategy {
  readonly name: string;
  /** Resolve a resumable session, or return null to defer to the next strategy. */
  findResumableSession(ctx: ResumeContext): Promise<ResolvedSession | null>;
  /**
   * Optional capture hook plugged into the underlying adapter's
   * `sessionPersistExtras` callback. The wrapper handles registration so
   * the strategy doesn't need to know which adapter implements the hook.
   *
   * `principal` is the session's owning principal. Strategies that
   * perform redaction or audit on capture SHOULD pass this through to
   * downstream redactors / auditors so attribution is correct (no
   * strategy-level sentinel leaks into per-principal rules or audit
   * logs).
   */
  onSessionPersist?(input: {
    readonly sessionId: string;
    readonly workspace: Workspace;
    readonly host: Host;
    readonly principal: PrincipalId;
  }): Promise<Readonly<Record<string, unknown>>>;
}
