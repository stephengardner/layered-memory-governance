# Resume-Author AgentLoopAdapter Design

> **Status:** Draft. Spec for PR6 of the agentic-actor-loop sequence (PRs #166-#170).

## 0. Future-proofing checklist (per `dev-design-decisions-3-month-review`)

This design must survive a 3-month-later review with 10x more actors, 10x more canon, and an order of magnitude more external integrations. Here is how each canonical concern is addressed:

| Canon | How this design satisfies it |
|---|---|
| `dev-design-decisions-3-month-review` | Strategy pluggability + adapter-neutral naming (`resumable_session_id`, `sessionPersistExtras`) means LangGraph or other future agent-loop adapters reuse the same shape without forking. The wrapper itself is generic; today's claude-code-specific logic lives only in the strategy implementation. See §3.3, §3.4. |
| `dev-indie-floor-org-ceiling` | Indie default is `[SameMachineCliResumeStrategy]` (zero config; works with the operator's existing local Claude CLI sessions). Org ceiling enables `BlobShippedSessionResumeStrategy` (with operator-tuned redactor + BYO BlobStore + explicit consent). Same wrapper code; capability dialed by constructor options. See §6.5. |
| `dev-substrate-not-prescription` | The wrapper + strategies live in `examples/agent-loops/resume-author/`, not `src/`. The only `src/` touch is `BlobStore.describeStorage()` (general-purpose; useful for any caller wanting destination introspection). No actor names, no PR-specific logic, no claude-code-specific surface in `src/`. |
| `dev-easy-vs-pluggability-tradeoff` | The "easy" path would be embedding resume into `ClaudeCodeAgentLoopAdapter` directly. Rejected for pluggability: a wrapper-pattern keeps the existing adapter narrow ("spawn fresh CLI session") and lets operators compose. See §2 + §3.7. |
| `dev-no-org-shape-in-src` | Substrate change is ONE additive method on `BlobStore`. No PR-specific or actor-specific types added to `src/substrate/`. PR-fix's needs are satisfied via the runner script's wiring (Option I in §6.1). |
| `inv-conflict-detection-at-write-time` | Capture-side `onSessionPersist` fires synchronously on session-end before the session atom is finalized; any redactor/blob-store error surfaces immediately as a session failure, not a delayed nightly batch. |
| `inv-l3-requires-human-default` | Capture-side strategy writes to `extra` on a non-canon (L0) atom; no L3 promotion involved. Resume-side never escalates. |
| `inv-design-kill-switch-first` | Wrapper inherits the substrate's existing kill-switch behavior (signal propagated through `AgentLoopInput.signal`); both resume + fallback paths abort cooperatively. |
| `dev-coderabbit-cli-pre-push` | PR6 itself ships through this gate: task #123 lands first, then PR6's diff goes through CR CLI locally before push. See §9.2. |
| `dev-implementation-canon-audit-loop` | Plan dispatches a canon-compliance auditor sub-agent per task during implementation, IN ADDITION to spec-compliance and code-quality reviewers. The auditor reads the canon + the diff + the threat-model section and returns Approved or Issues Found. See §9.1 + §9.3. |

## 1. Purpose

PrFixActor (PR5 / #170) drives an open PR through CodeRabbit feedback by spawning a fresh Claude Code CLI session in a workspace pinned to the PR's HEAD branch, addressing findings, committing, and pushing. The fresh-spawn behavior is robust but loses the original code-author session's context: the file reads, the design rationale, the trade-offs the author considered when writing the PR. A fix-loop that re-derives that context wastes turns and may make different choices than the author would have, producing fix-cycles that drift from the PR's original intent.

The remedy: when the original author session is recoverable, resume it instead of spawning fresh. The author's accumulated context (codebase reads, design memory, candid commentary in tool-call traces) carries into the fix turn naturally. When the session is unrecoverable, fall back to fresh-spawn (today's behavior). Both paths remain available; this is purely additive.

## 2. Architectural seam

This is a NEW reference adapter behind the existing PR1 substrate `AgentLoopAdapter` interface. PrFixActor's `apply` path consumes whatever adapter is wired; no actor or substrate change is required to pick up the new behavior. The wrapper composes with `ClaudeCodeAgentLoopAdapter` as the fall-back implementation, so `[wrapper -> fresh]` matches today's `[fresh]` semantics when no resumable session is found.

### 2.1 What ships in PR6

1. `BlobStore.describeStorage()` substrate capability (additive interface method + types).
2. `ClaudeCodeAgentLoopAdapter` additions (mechanism-neutral naming so future adapters reuse the same shape):
   - Always persists `metadata.agent_session.extra.resumable_session_id` (today: the UUID extracted from the CLI's stream-json system-init line; tomorrow: whatever opaque resume-token a different agent loop produces). Field name is adapter-neutral; the value is opaque to consumers.
   - Optional `sessionPersistExtras?: (sessionId, workspace, host) => Promise<Record<string, unknown>>` capture hook called after a successful session ends, before the session atom is finalized. The hook's return value merges into `metadata.agent_session.extra`. Hook name is adapter-neutral so the same callback shape works for LangGraph, custom node loops, etc.
3. New reference adapter `examples/agent-loops/resume-author/` exporting:
   - `ResumeAuthorAgentLoopAdapter` (the wrapper)
   - `SessionResumeStrategy` interface
   - `SameMachineCliResumeStrategy`
   - `BlobShippedSessionResumeStrategy`
4. `scripts/run-pr-fix.mjs` rewires the `agentLoop` slot to construct the wrapper with `[SameMachineCliResumeStrategy]` (default; today's deployment is same-machine).
5. Tests + threat-model section in this spec.

### 2.2 What does NOT ship in PR6

- No actor change. PrFixActor sees the same `AgentLoopAdapter` contract.
- No new policy atoms. Both strategies inherit existing tool-policy gates.
- No new atom types. The `extra` slot on `AgentSessionMeta` is the documented extension point.
- No deployment/CI changes. Cross-machine deployment is a separate concern; the blob-shipped strategy is shipped as constructible code but unwired in our reference driver.

## 3. Components

### 3.1 `BlobStore.describeStorage()` -- substrate capability

Additive method on the existing `BlobStore` interface (`src/substrate/blob-store.ts`):

```ts
export type BlobStorageDescriptor =
  | { readonly kind: 'local-file'; readonly rootPath: string }
  | { readonly kind: 'remote'; readonly target: string };

export interface BlobStore {
  // ...existing methods...
  /**
   * Describe where this blob store puts data. Used by callers that need
   * to gate data flow on storage destination (e.g. refusing to ship
   * sensitive content into a git-tracked tree). Implementations MUST
   * return a deterministic, operator-readable descriptor; the field is
   * part of the public contract a security-conscious caller can rely on.
   */
  describeStorage(): BlobStorageDescriptor;
}
```

Reference `FileBlobStore` (`examples/blob-stores/file/`) implements: returns `{ kind: 'local-file', rootPath: this.rootDir }`.

### 3.2 `ClaudeCodeAgentLoopAdapter` additions

Two changes, both additive:

1. **Persist `resumable_session_id`.** The adapter extracts the CLI's `session_id` UUID from stream-json's system-init message (already captured at `examples/agent-loops/claude-code/stream-json-parser.ts:50`). On session-atom finalization, write this UUID to `metadata.agent_session.extra.resumable_session_id`. No schema change; `AgentSessionMeta.extra` is the documented extension slot.

2. **Optional capture hook.** New constructor option:

   ```ts
   readonly sessionPersistExtras?: (input: {
     readonly sessionId: string;             // CLI UUID
     readonly workspace: Workspace;
     readonly host: Host;
   }) => Promise<Record<string, unknown>>;
   ```

   Called once after a successful session ends, BEFORE the session atom is updated for finalization. The hook's return value is merged into `metadata.agent_session.extra` (after the standard `resumable_session_id` is added). On hook throw: log via host audit and continue with finalization (the failure record on the session atom is unchanged); the adapter does NOT fail-loud on a hook exception because the hook is an extension surface, not a contract obligation.

### 3.3 `ResumeAuthorAgentLoopAdapter` -- the wrapper

The wrapper is actor-neutral. The actor (or runner script) provides an `assembleCandidates` callback at construction; the wrapper invokes it per call to assemble the session-candidate list passed to strategies. PR-fix's callback walks `dispatched_session_atom_id`; future actors plug different walks (Auditor, Migrator, etc.) without touching the wrapper.

```ts
export interface ResumeAuthorAdapterOptions {
  readonly fallback: AgentLoopAdapter;        // typically ClaudeCodeAgentLoopAdapter
  readonly host: Host;
  readonly strategies: ReadonlyArray<SessionResumeStrategy>;  // tried in order
  /**
   * Caller-supplied callback that assembles candidate sessions for the current
   * fix-iteration. Invoked once per `run(input)` call. The callback does whatever
   * walk makes sense for its actor (PR-fix walks dispatched_session_atom_id from
   * the prior PR observation; auditor walks audit-event chains; etc.). The wrapper
   * does NOT interpret atoms; it only iterates the returned list against strategies.
   *
   * Returning an empty array is fine: strategies will all return null and the
   * wrapper delegates to `fallback`.
   */
  readonly assembleCandidates: (input: AgentLoopInput) => Promise<ReadonlyArray<CandidateSession>>;
  /** Default 8 hours. Strategies SHOULD respect this; some may apply their own additional staleness rules. */
  readonly maxStaleHours?: number;
}

export class ResumeAuthorAgentLoopAdapter implements AgentLoopAdapter {
  readonly capabilities: AdapterCapabilities;
  constructor(opts: ResumeAuthorAdapterOptions);
  run(input: AgentLoopInput): Promise<AgentLoopResult>;
}
```

`capabilities` mirrors the fallback's capabilities (delegated). The wrapper does NOT advertise different `tracks_cost` / `supports_signal` / `classify_failure` than the fallback, so consumers see uniform behavior.

`run(input)` semantics:

1. Call `opts.assembleCandidates(input)` to get the candidate session list (newest-first; up to `maxStaleHours` filtering can also happen here, or be deferred to strategies).
2. Build a `ResumeContext` from `{ candidateSessions, workspace: input.workspace, host: opts.host }`. Iterate `opts.strategies` in declaration order; first non-null `ResolvedSession` wins.
3. If a strategy resolves: invoke `resolved.preparation?.()` if present (e.g., session-file rehydration writes `.jsonl` to local CLI cache). Then spawn the resume invocation via the underlying CLI / SDK using `resolved.resumableSessionId`. On success, write a NEW `agent-session` atom for this run with `metadata.agent_session.extra.resumed_from_atom_id` (= `resolved.resumedFromSessionAtomId`) and `extra.resume_strategy_used` (= `resolved.strategyName`); chain via `provenance.derived_from`. Return `AgentLoopResult` as the underlying invocation produced it.
4. If resume's invocation returns ANY non-`completed` result OR throws, the wrapper delegates to `opts.fallback.run(input)`. The wrapper does NOT retry resume itself; the underlying adapter (the spawn-call inside `findResumableSession.preparation`-and-spawn path) handles its own retries the same way the fallback does. Compounded retry is a known anti-pattern. Both attempts get separate `agent-session` atoms; the wrapper writes a small `extra.fallback_invoked: true` field on the original resumed atom for audit clarity.
5. If NO strategy resolves (all return null): skip resume entirely, delegate to `opts.fallback.run(input)` directly.

The intent is that the wrapper itself is policy-free: it doesn't classify failures, doesn't retry, doesn't escalate. Strategies own resume-specific decisions; the fallback owns its own behavior; the wrapper only orchestrates the try-resume-then-fallback shape.

### 3.4 `SessionResumeStrategy` interface (actor-neutral)

`ResumeContext` does NOT name PrFixActor or any specific actor. It carries a list of candidate session atoms; the wrapper's caller is responsible for assembling that list (typically by walking `dispatched_session_atom_id` from a prior observation atom, but the actor decides how). This keeps the wrapper reusable by future actors (auditor flows, deprecated-PrLanding's replacement, custom org actors).

```ts
export interface ResumeContext {
  /** Caller-assembled candidate sessions, sorted newest-first.
      Caller walks whatever atom chain makes sense for its actor (PR observations,
      iteration logs, custom). Wrapper does not interpret the source chain. */
  readonly candidateSessions: ReadonlyArray<CandidateSession>;
  readonly workspace: Workspace;
  readonly host: Host;
}

export interface CandidateSession {
  readonly sessionAtomId: AtomId;
  /** Adapter-neutral resumable token. Read from metadata.agent_session.extra.resumable_session_id. */
  readonly resumableSessionId: string;
  readonly startedAt: Time;
  /** Full extra slot from the session atom. Strategies that need adapter-specific
      fields (e.g. session_file_blob_ref, cli_version) read them from here. */
  readonly extra: Readonly<Record<string, unknown>>;
  /** The agent-loop adapter id that produced this session (e.g. 'claude-code-agent-loop').
      Strategies use this to skip sessions produced by an incompatible adapter. */
  readonly adapterId: string;
}

export interface ResolvedSession {
  /** Pass directly to the adapter's resume invocation. */
  readonly resumableSessionId: string;
  readonly resumedFromSessionAtomId: AtomId;
  readonly strategyName: string;
  /** Optional preparation step (e.g., write a session file to local CLI cache
      before `claude --resume`). Wrapper calls this after the strategy resolves
      and before the adapter spawn. */
  readonly preparation?: () => Promise<void>;
}

export interface SessionResumeStrategy {
  readonly name: string;
  /** Resolve a resumable session, or return null to defer to the next strategy. */
  findResumableSession(ctx: ResumeContext): Promise<ResolvedSession | null>;
  /** Optional capture hook plugged into the underlying adapter's
      `sessionPersistExtras` callback. The wrapper handles registration so the
      strategy doesn't need to know which adapter implements the hook. */
  onSessionPersist?(input: {
    readonly sessionId: string;
    readonly workspace: Workspace;
    readonly host: Host;
  }): Promise<Record<string, unknown>>;
}
```

### 3.5 `SameMachineCliResumeStrategy`

Concrete claude-code adapter implementation. Filters candidates to those produced by `'claude-code-agent-loop'` (the adapter id PR1+PR3 wired) so it skips sessions from incompatible adapters; returns the freshest within `maxStaleHours`. No preparation needed (`claude --resume` reads from the local `~/.claude/projects/<slug>/` directly).

```ts
const DEFAULT_MAX_STALE_HOURS = 8;
const HOUR_MS = 60 * 60 * 1000;

export class SameMachineCliResumeStrategy implements SessionResumeStrategy {
  readonly name = 'same-machine-cli';
  private readonly maxStaleMs: number;
  constructor(opts?: { maxStaleHours?: number }) {
    this.maxStaleMs = (opts?.maxStaleHours ?? DEFAULT_MAX_STALE_HOURS) * HOUR_MS;
  }
  async findResumableSession(ctx: ResumeContext): Promise<ResolvedSession | null> {
    const compatible = ctx.candidateSessions.filter(s => s.adapterId === 'claude-code-agent-loop');
    const fresh = compatible.find(s => Date.now() - new Date(s.startedAt).getTime() < this.maxStaleMs);
    if (!fresh) return null;
    return {
      resumableSessionId: fresh.resumableSessionId,
      resumedFromSessionAtomId: fresh.sessionAtomId,
      strategyName: this.name,
    };
  }
  // No onSessionPersist; same-machine doesn't need to capture anything.
}
```

Future agent-loop adapters (LangGraph, custom node loops, GPT-5 CLI) ship their own per-adapter strategy alongside; the same wrapper composes them. Strategy names should follow the convention `<deployment>-<adapter-key>` (e.g. `same-machine-langgraph`, `blob-shipped-claude-code`) so logs disambiguate cleanly at scale.

### 3.6 `BlobShippedSessionResumeStrategy`

Same shape, but with capture (`onSessionPersist`) and rehydration (`findResumableSession` writes the .jsonl to local CLI cache before returning the session id).

```ts
export interface BlobShippedStrategyOptions {
  readonly blobStore: BlobStore;
  readonly redactor: Redactor;             // REQUIRED; no default
  readonly cliVersion: string;             // pinned at construction
  readonly acknowledgeSessionDataFlow: true;  // default-deny without explicit opt-in
  readonly maxStaleHours?: number;
}

export class BlobShippedSessionResumeStrategy implements SessionResumeStrategy {
  readonly name = 'blob-shipped';
  constructor(opts: BlobShippedStrategyOptions);
  // ...
}
```

**Construction-time guards (default-deny):**

1. `acknowledgeSessionDataFlow` MUST be the literal `true`. The TypeScript type forces an explicit positional opt-in; `false` and `undefined` reject at compile time.
2. `redactor` MUST be supplied. No default. Identity-redactor (function returning input unchanged) is rejected by the constructor (runtime check on a known-sentinel).
3. `blobStore.describeStorage()` is called and the result inspected:
   - `kind: 'local-file'`: the `rootPath` MUST resolve OUTSIDE any git-tracked tree. The constructor walks up from `rootPath` looking for a `.git/` directory; if found, throws with an operator-actionable message naming the path AND the offending git root.
   - `kind: 'remote'`: the `target` is logged at INFO level for operator review. The constructor does not block remote targets; the operator who chose a remote BlobStore is presumed to have applied their own destination-trust review. The threat-model section below documents this trust transfer.
4. `cliVersion` is pinned at construction. On `findResumableSession`, the captured blob's `cli_version` extra MUST match. Mismatch -> return null (skip), log structured diagnostic.

**`onSessionPersist` (capture path):**

```ts
async onSessionPersist({ sessionId, workspace, host }): Promise<Record<string, unknown>> {
  // 1. Resolve the .jsonl path.
  // 2. Read the file. If absent or unreadable, return {} (capture fails open; the
  //    same-machine strategy still works for the operator's local fix-runs).
  // 3. Apply the redactor to the file contents.
  // 4. Compute the BlobRef (sha256), put via blobStore.
  // 5. Return { session_file_blob_ref: <BlobRef>, cli_version: <pinned>, captured_at: <iso> }.
}
```

**`findResumableSession` (rehydration path):**

```ts
async findResumableSession(ctx): Promise<ResolvedSession | null> {
  for (const candidate of ctx.candidateSessions) {
    const blobRef = candidate.extra['session_file_blob_ref'];
    const capturedVersion = candidate.extra['cli_version'];
    if (typeof blobRef !== 'string' || capturedVersion !== this.cliVersion) continue;
    return {
      resumableSessionId: candidate.resumableSessionId,
      resumedFromSessionAtomId: candidate.sessionAtomId,
      strategyName: this.name,
      preparation: async () => {
        const bytes = await this.blobStore.get(blobRef as BlobRef);
        // Resolve the local CLI cache path: ~/.claude/projects/<slug>/<uuid>.jsonl
        // where <slug> is Claude Code CLI's project slug for the workspace cwd.
        // Slug derivation (CLI v2.x convention; verify on each --resume version
        // bump): take absolute cwd, drop the leading separator, replace remaining
        // path separators (`/` on POSIX, `\` on Windows) with `-`. Example:
        // `/Users/op/memory-governance` -> `Users-op-memory-governance`.
        // The strategy's CLI-version pin (cliVersion option) is exactly the gate
        // that catches a CLI version where this convention changes; a mismatch
        // makes findResumableSession return null and the wrapper falls through.
        // Write bytes to that path. Permissions: 0600. Parent directories
        // created with mode 0700.
      },
    };
  }
  return null;
}
```

### 3.7 Driver wiring

`scripts/run-pr-fix.mjs` constructs:

```ts
const fresh = new ClaudeCodeAgentLoopAdapter({ /* unchanged */ });
const agentLoop = new ResumeAuthorAgentLoopAdapter({
  fallback: fresh,
  host,
  strategies: [new SameMachineCliResumeStrategy({ maxStaleHours: 8 })],
  // PR-fix's candidate walk: from the current iteration's PrFixObservation,
  // walk dispatched_session_atom_id back through prior iterations on the same
  // PR, return the agent-session atoms with `extra.resumable_session_id`
  // populated, sorted newest-first. The runner constructs this closure with
  // a reference to the current observation atom id supplied by the driver.
  assembleCandidates: walkAuthorSessionsForPrFix(host, currentPrObservationAtomId),
  maxStaleHours: 8,
});
```

`BlobShippedSessionResumeStrategy` is shipped but not constructed by the reference driver. To enable it, an operator copies the driver and wires:

```ts
strategies: [
  new SameMachineCliResumeStrategy({ maxStaleHours: 8 }),
  new BlobShippedSessionResumeStrategy({
    blobStore: someOperatorControlledBlobStore,
    redactor: operatorTunedRedactor,
    cliVersion: 'detected-cli-version',
    acknowledgeSessionDataFlow: true,
    maxStaleHours: 8,
  }),
],
```

The `assembleCandidates` callback closes over the per-iteration context an actor needs (for PR-fix: the current PR observation atom). It is invoked once per `run(input)` call by the wrapper. Future actors plug different walk-functions for different chain shapes. See §6.1.

## 4. Data flow

### 4.1 Capture (when blob-shipped is enabled, future deployment)

```
[author Claude session ends successfully on machine A]
     -> ClaudeCodeAgentLoopAdapter.sessionPersistExtras hook fires
     -> BlobShippedSessionResumeStrategy.onSessionPersist runs:
            reads ~/.claude/projects/<slug>/<uuid>.jsonl
            applies redactor
            puts blob via BlobStore -> BlobRef
            returns { session_file_blob_ref, cli_version, captured_at }
     -> hook return merges into metadata.agent_session.extra
     -> session atom finalized
```

### 4.2 Resume (today's same-machine flow)

```
PrFixActor.apply -> ctx.adapters.agentLoop.run(input)
     -> ResumeAuthorAgentLoopAdapter.run:
            walk dispatched_session_atom_id chain on PR observations -> candidate sessions
            iterate strategies:
                SameMachineCliResumeStrategy.findResumableSession:
                    pick freshest candidate within maxStaleHours
                    return ResolvedSession{ resumableSessionId, ... }
            spawn `claude --resume <resumable_session_id> -p <prompt>` via execa
            (success path) write new agent-session atom with resumed_from_atom_id, return AgentLoopResult
            (structural failure) delegate to fallback.run(input); both atoms recorded
     -> AgentLoopResult flows back to PrFixActor.apply -> commit-SHA verify -> thread resolve
```

### 4.3 Resume (cross-machine, future deployment)

Same as 4.2, with one addition: before the spawn step, `ResolvedSession.preparation()` runs to write the rehydrated `.jsonl` file into the local `~/.claude/projects/<slug>/` directory matching the spawn cwd's slug.

## 5. Threat model + operator-trust contract

This section is load-bearing. Future maintainers MUST consult it before relaxing any guard described above.

### 5.1 Same-machine path (today)

- **No new exfiltration surface.** `claude --resume <uuid>` reads from the operator's local `~/.claude/projects/<slug>/<uuid>.jsonl`. The wrapper invokes it as a subprocess in the same workspace cwd; nothing crosses to GitHub or to any networked surface introduced by PR6.
- **Persisted `resumable_session_id` is just an opaque token.** For Claude Code it's the CLI session UUID. It identifies a session but does not contain its contents. Stored in `metadata.agent_session.extra.resumable_session_id`, which lands in `.lag/atoms/<id>.json`. `.lag/` is gitignored at the framework default; no leakage.
- **Atom transcripts (existing PR1 behavior): unchanged.** PR1's `agent-turn` atoms with `llm_input` / `llm_output` fields are written to atoms (potentially via BlobStore for large turns). PR6 does not change this. The `.lag/blobs/` default path is gitignored.

### 5.2 Blob-shipped path (future, opt-in)

The Claude CLI session file IS the full conversation transcript: every user message, model response, tool call, tool argument, tool result, file read, command output. Some of that very plausibly contains:

- Bearer tokens, GitHub tokens, x-access-token URLs (operator's machine, command outputs, env vars surfaced into tool args)
- File paths, internal directory structures, project names not yet public
- Operator's draft thinking, candid commentary, ad-hoc explorations not shared with the team
- Tool outputs containing PII or proprietary content

Shipping this content into framework-managed blob storage is a privilege escalation across the operator-trust boundary. The strategy ships with explicit guards:

1. **Default-deny construction.** `acknowledgeSessionDataFlow: true` is required. An operator who copies the driver and wires this strategy makes a deliberate, named choice; they cannot enable it by accident.
2. **Required redactor.** No default. Operator MUST supply a redactor explicitly tuned for session content. A configured redactor is no guarantee of completeness, but it shifts the "blast pattern" from "everything in the file" to "the patterns the operator chose to redact"; that's where the author's own judgment is the right place to lean.
3. **Destination guard.** The strategy validates `BlobStore.describeStorage()` at construction. If the storage is `local-file` AND the `rootPath` resolves inside a git-tracked tree, construction throws with an operator-actionable diagnostic. The check is best-effort (an operator could still construct a custom `BlobStore` that lies about its descriptor); the diagnostic explicitly states this and makes the operator the locus of trust.
4. **Remote BlobStore: trust-transfer.** If `describeStorage` returns `kind: 'remote'`, the constructor logs the target at INFO and proceeds. The framework does not validate the remote's authorization model. The operator who wired a remote `BlobStore` is presumed to have reviewed where that data lands. This is documented explicitly so future maintainers do not introduce a silent trust expansion.
5. **CLI-version guard.** The captured blob carries `cli_version` (the version at capture time). Rehydration on a mismatched runtime version is rejected (returns null -> next strategy or fallback). Session file format may evolve; we refuse to silently feed a stale-format file into a newer CLI.
6. **No default wiring in the reference driver.** `scripts/run-pr-fix.mjs` constructs `[SameMachineCliResumeStrategy]` only. Operator opt-in is by writing their own driver, not by flipping a flag.

### 5.3 Future hardening (out of scope for PR6, noted for the next maintainer)

- Audit-trail mode: every BlobShippedSessionResumeStrategy capture writes a separate `actor-message` atom to the operator principal with `severity: 'info'` and the blob target. This is a "your conversation just got captured" notification; the operator can choose to enable it via a constructor option.
- Encryption at rest: `BlobShippedSessionResumeStrategy` could encrypt the .jsonl payload with an operator-controlled key before `blobStore.put`; the strategy stores only the encrypted blob, decrypts on rehydration. Out of scope for PR6 (the redactor + destination guard + opt-in are the today-line); flagged here so the next iteration can pick it up without re-deriving the threat model.

## 6. Open architectural decisions

### 6.1 How does the wrapper learn which sessions are candidates?

`ResumeAuthorAgentLoopAdapter.run(input)` needs the candidate session list to pass to strategies. Two options:

**Option I: Caller supplies an `assembleCandidates` callback at wrapper construction; wrapper invokes it per `run(input)` call.** The callback closes over whatever per-iteration context the actor needs (PR observation atom id for PR-fix; audit-event chain head for an auditor; etc.). Pro: keeps `AgentLoopInput` substrate-clean (no actor-specific fields); future actors with different walks compose naturally without changing the wrapper or the substrate; wrapper is built ONCE per driver run and invoked many times -- no per-iteration construction. Con: callback indirection is one extra layer to reason about, but the closure is the natural place to thread per-iteration context.

**Option II: Extend `AgentLoopInput` with optional `priorObservationAtomId?: AtomId`.** Substrate-additive (optional field). Wrapper walks the chain itself. Pro: stateless wrapper. Con: substrate gains a field whose semantic ("walk dispatched_session_atom_id") is actor-specific even though the field is optional.

**Recommended: Option I.** Substrate-purity weighs against absorbing actor-shape into `AgentLoopInput`. Per-iteration construction is cheap (the wrapper is a thin facade). The runner script is the right place to assemble PR-specific candidate chains; an Auditor actor would assemble a different chain from the same primitives. The wrapper itself stays generic.

### 6.2 Multi-tenancy + 10x scaling concerns

When the org runs 50+ concurrent actors across different PRs:

1. **Candidate-walk MUST be PR-scoped.** Different PRs share an atom store; the actor's walk-fn (Option I above) is responsible for stopping at PR boundaries. Don't accidentally pick up a sibling PR's session as a "fresh candidate" -- wrong author, wrong context.
2. **Concurrent fix-iterations on the same PR.** Today's PrFixActor is sequential per PR by construction (single actor instance per PR), so this is invariant. If a future actor runs parallel iterations against the same PR, the resume strategy needs locking. PR6 does NOT introduce locking; documented as a future-maintainer note for parallelism work.
3. **Strategy enumeration cost.** The wrapper iterates strategies per iteration. With ~3 strategies (same-machine, blob-shipped, future-X), this is O(strategies). At 50+ actors x 8 hour fix-cycles, total is well below any meaningful overhead. Documented for completeness; no optimization needed.
4. **Atom-store walk cost.** Walking `dispatched_session_atom_id` is O(prior-iterations). At 10x more PRs and 10x more actors, cap fix-iterations per PR via existing budget caps (`maxIterations`); walk depth stays bounded.

### 6.3 Replay-tier interaction

PR1's substrate defines `ReplayTier = 'best-effort' | 'content-addressed' | 'strict'`. The captured `.jsonl` (blob-shipped path) IS exactly the "content-addressed transcript" replay-tier-content-addressed already implies. Field naming aligned: `metadata.agent_session.extra.session_file_blob_ref` is the canonical pointer for "the full transcript, content-addressed" and is intentionally reusable by future replay tooling. Capture-side strategies SHOULD set this field; resume-side strategies SHOULD read it. New replay tools (debugger, deterministic-replay simulator) consume the same field; no fork.

Note: today's `ClaudeCodeAgentLoopAdapter` does NOT capture the .jsonl by default at any replay tier (PR3 deferred this). PR6's `BlobShippedSessionResumeStrategy` is the FIRST consumer of session-file blobs in the framework; future replay tooling builds on the same primitive without re-deriving.

### 6.4 What if the wrapper is misconfigured (no fallback)?

If `opts.fallback` is undefined: the TypeScript `readonly fallback: AgentLoopAdapter` enforces presence at compile time. The runtime constructor adds a defensive `if (!opts.fallback) throw` so JS callers get a clear error rather than a delayed `TypeError` mid-`run`. If the fallback's `run()` throws synchronously (rare; constructor-stage misconfig usually): the wrapper does NOT catch -- the synchronous throw propagates as the wrapper's throw. Consumer's responsibility to construct a working fallback. No additional fallback chain (would compound failure modes).

### 6.5 Indie-floor + org-ceiling fit

- **Indie floor (solo developer with default host + Claude Code session directory):** today's deployment. `[SameMachineCliResumeStrategy]` only; `BlobShippedSessionResumeStrategy` is shipped-but-unwired. Zero extra config. The same `claude` binary the operator uses interactively now powers the fix-loop, with the same session continuity. A solo developer running `node scripts/run-pr-fix.mjs --pr 170` gets a real win on day one.
- **Org ceiling (50+ concurrent actors, BYO adapters):** the strategy interface is the substrate seam. An org wires its own `BlobStore` (S3, GCS, encrypted filesystem with audit trail), constructs `BlobShippedSessionResumeStrategy` with their tuned `Redactor`, and the wrapper Just Works across machines/runners. Different agent loops (LangGraph for some actors, Claude Code for others) ship their own per-adapter strategies; the wrapper itself stays general.
- **Same architecture serves both ends.** No fork; no parallel "indie" vs "org" code paths. The capability dial is constructor options on a single wrapper, not separate implementations.

### 6.6 Concurrent fix-iterations on the same PR

Two fix-iterations running concurrently on the same PR would both try to resume the same session. Claude CLI's behavior is undefined here (likely one wins; one fails with "session locked"). PR6 does NOT introduce locking; PrFixActor's loop is sequential per PR by construction. Documented for future maintainers who might add parallelism: would need either a per-session lease atom or strategy-level mutex; both compose with the existing wrapper without rewrites.

## 7. Components by file

```
src/substrate/blob-store.ts                                    # +describeStorage method
examples/blob-stores/file/blob-store.ts                        # +describeStorage impl
examples/agent-loops/claude-code/loop.ts                       # +resumable_session_id persist + sessionPersistExtras hook
examples/agent-loops/resume-author/index.ts                    # NEW barrel
examples/agent-loops/resume-author/loop.ts                     # NEW ResumeAuthorAgentLoopAdapter
examples/agent-loops/resume-author/types.ts                    # NEW SessionResumeStrategy + ResolvedSession + ResumeContext
examples/agent-loops/resume-author/strategies/same-machine.ts  # NEW
examples/agent-loops/resume-author/strategies/blob-shipped.ts  # NEW
examples/agent-loops/resume-author/walk-author-sessions.ts     # NEW (atom-walking helper)
scripts/run-pr-fix.mjs                                         # +wrapper wiring
test/examples/agent-loops/resume-author/loop.test.ts           # NEW
test/examples/agent-loops/resume-author/strategies/same-machine.test.ts  # NEW
test/examples/agent-loops/resume-author/strategies/blob-shipped.test.ts  # NEW
test/substrate/blob-store-contract.test.ts                     # +describeStorage contract test
docs/superpowers/specs/2026-04-25-resume-author-agent-loop-adapter-design.md  # this spec
docs/superpowers/plans/2026-04-25-resume-author-agent-loop-adapter.md         # the plan (writing-plans output)
```

## 8. Testing

### 8.1 Unit

- `walkAuthorSessions(host, prObservationAtomId, maxStaleMs)` is the example-level helper PrFixActor's runner uses to construct its `assembleCandidates` callback (per §6.1 Option I). Tests verify the helper returns the candidate list correctly across stale + missing-extra + non-`pr-fix-observation` atoms in the chain. The helper is NOT part of the wrapper's public API; it lives in `examples/agent-loops/resume-author/walk-author-sessions.ts` as a reference for actor authors.
- `SameMachineCliResumeStrategy` returns the freshest candidate; null on empty; null on all-stale.
- `BlobShippedSessionResumeStrategy` constructor: throws on `acknowledgeSessionDataFlow: false`, missing redactor, identity redactor, in-tree FileBlobStore. Logs INFO on remote BlobStore.
- `BlobShippedSessionResumeStrategy.findResumableSession`: skips on missing blob ref, skips on cli-version mismatch, returns ResolvedSession with preparation closure on match.
- `BlobShippedSessionResumeStrategy.onSessionPersist`: applies redactor to file contents; computes BlobRef; returns expected extras.
- `ResumeAuthorAgentLoopAdapter.run`: success path (strategy resolves, resume invocation returns `completed`); non-completed-result delegation to fallback; throw-from-resume delegation to fallback; no-strategy-resolves delegation to fallback; both attempts get separate agent-session atoms cross-referenced via `derived_from` and `extra.fallback_invoked`.

### 8.2 Integration shape

End-to-end on `MemoryHost`:

1. Seed a prior `pr-fix-observation` atom on PR (owner, repo, number, head_sha) with `dispatched_session_atom_id` -> a stub `agent-session` atom whose `extra.resumable_session_id` is `'test-uuid-001'`.
2. Construct `ResumeAuthorAgentLoopAdapter` with `[stubResumeStrategy]` that returns ResolvedSession; fallback that returns canned AgentLoopResult.
3. Call `adapter.run(input)`. Assert: stubResumeStrategy was called; fallback was NOT called; AgentLoopResult carries `extra.resume_strategy_used: 'stub'`; atom store gained one new agent-session atom whose `extra.resumed_from_atom_id` matches the seed.

Mirror the test for the failure path: stubResumeStrategy returns null; fallback IS called.

### 8.3 Regression guards

- A claude-code session WITHOUT `extra.resumable_session_id` (legacy session predating PR6) MUST be skipped by SameMachineCliResumeStrategy without throwing.
- A `BlobStore` whose `describeStorage` is missing (legacy implementation) is treated as remote (defensive default); the constructor logs and proceeds. (Belt-and-suspenders for back-compat; actual back-compat is the new method being added by PR6 itself.)

### 8.4 What NOT to test

Per YAGNI:
- No tests against a real Claude Code CLI process. The ClaudeCodeAgentLoopAdapter integration test in PR3 covers that surface; PR6 stubs the spawn.
- No tests against a real network BlobStore. The trust-transfer guard is documented; the test suite covers the local-file destination guard.

## 9. Implementation discipline + pre-flight

### 9.1 Per-task canon-compliance audit (during implementation)

Per canon `dev-implementation-canon-audit-loop`, every substantive task in the plan dispatches a separate canon-compliance auditor sub-agent BEFORE commit. The auditor receives:

- The canon (CLAUDE.md plus relevant `.lag/atoms/`)
- The plan task being executed
- The implementer's diff (git diff against the prior task's HEAD)
- The threat model section (§5) for tasks touching `BlobShippedSessionResumeStrategy`, the destination guard, the redactor contract, or the `BlobStore.describeStorage()` substrate change

The auditor evaluates: canon adherence, security/correctness concerns, substrate purity, indie-floor/org-ceiling fit, pluggability, spec match. Returns Approved or Issues Found; on Issues Found the implementer fixes and the auditor re-reviews before commit. This runs IN ADDITION TO the existing spec-compliance reviewer and code-quality reviewer in `superpowers:subagent-driven-development`. The plan's task template MUST include a "canon-audit" step between "implement + tests pass" and "commit."

### 9.2 Pre-push gates

1. Task #123 (CR CLI capability in repo) MUST land first. Once available, run CR CLI on the PR6 diff locally and address every critical/major finding before pushing. Per canon `dev-coderabbit-cli-pre-push`.
2. Standard pre-push grep: emdashes, AI attribution, design/ refs in src/, PR-phase markers in src/.
3. `npm run typecheck && npm run build && npx vitest run` -- all green.
4. Push via `node scripts/git-as.mjs lag-ceo`. Open PR via `node scripts/gh-as.mjs lag-ceo`.

### 9.3 Final canon-audit before push

In addition to per-task canon-audit, dispatch one final canon-compliance auditor on the FULL diff before pushing. This catches cross-task drift (e.g., a refactor on task 4 that subtly violates an invariant established in task 2; per-task audit on task 4 alone may not surface this). Same auditor profile, broader scope.

## 10. Open follow-ups (not PR6)

- Operator-notification atom on every BlobShippedSessionResumeStrategy capture (5.3).
- Encryption-at-rest for blob-shipped session payloads (5.3).
- Optional: a `ResumeAuthorAgentLoopAdapter` factory wrapper that an operator can drop into `scripts/run-pr-landing.mjs` so PrLandingActor's hand-rolled CR-fix loop also benefits when same-machine. (Out of scope until PrLanding is deprecated in favor of PrFix.)
