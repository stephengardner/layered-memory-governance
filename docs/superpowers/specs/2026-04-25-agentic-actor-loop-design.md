# Agentic Actor Loop + Session-Log Substrate Design

**Date:** 2026-04-25
**Status:** Brainstormed via `superpowers:brainstorming`. Pending implementation plan via `superpowers:writing-plans`.
**Tracked as:** task #67 (was "Spec agentic CodeAuthorExecutor + session-log substrate").
**Scope expanded** during brainstorming from `CodeAuthorExecutor`-only to substrate-level: the seam serves any actor that wants multi-turn agentic reasoning.

---

## 1. Goal

Replace the single-shot `CodeAuthorExecutor` (LLM emits a unified diff, framework runs `git apply`) with a constrained sub-agent in an isolated workspace. The agent uses real tools (Read / Edit / Bash / Grep) inside a fresh worktree, sees compile and test errors, fixes them itself, and surrenders a commit + PR.

Capture the agent's reasoning + tool-call ledger as atoms so the entire chain - operator-intent → CTO plan → dispatch → agent reasoning → commit → PR → merge → outcome - is queryable, traceable, and replayable.

The substrate is the value. `CodeAuthorExecutor` is the first migration; `PlanningActor`, `AuditorActor`, `PrLandingActor`, and any future actor that wants multi-turn reasoning compose the same seam without the framework changing shape.

**Why not stay with the diff path:** it's empirically brittle. ~10-30% of LLM-emitted diffs fail `git apply` due to hunk-header arithmetic drift, whitespace mismatches, BOMs, line-ending mismatches. PR #164's self-correcting retry loop is the band-aid. The right fix is to give the agent a workspace it can iterate in.

**Why this is durable, not flaky:** atoms are the source of truth. The substrate captures session-level metadata + turn-by-turn IO + tool-call ledger. Replay walks the atom tree. Audits, taint cascades, compromise response, debug-why all work because the chain is content-addressed.

---

## 2. Architecture

The agentic actor loop is a **substrate-level** addition. The same seam serves any current or future actor (`CodeAuthorExecutor`, `PlanningActor`, `AuditorActor`, `PrLandingActor`). `CodeAuthorExecutor` is the first migration; the seam is named so its other consumers are first-class.

**Mental model: the chain becomes a tree of agent-sessions.** Each principal's reasoning = one `agent-session` atom. Each LLM call within a session = one `agent-turn` atom. Tool calls embed in the turn's metadata (no per-tool atoms; volume bounded). Session-tree edges are existing dispatch atoms (one principal handing off to another). Replay walks the tree.

### 2.1 Four pluggable seams

Interfaces live in `src/substrate/`. Reference adapters live in `examples/`. Indie copies an example; org swaps for their own without the framework changing shape.

| Seam | Purpose | Reference adapter (in `examples/`) |
|---|---|---|
| `AgentLoopAdapter` | Drive an agent run: LLM + tool use + turn-level atom emission. | `ClaudeCodeAgentLoop` - spawns a Claude Code sub-agent in the provided workspace with a curated tool whitelist. |
| `WorkspaceProvider` | Provision an isolated workspace per dispatch. | `GitWorktreeProvider` - creates `.worktrees/<correlation_id>` off the configured base ref; cleans up on release. Org-side swap → docker / k8s / ephemeral FS. |
| `BlobStore` | Content-addressed storage for turn payloads above the inline threshold. | `FileBlobStore` - writes to `.lag/blobs/<sha256>` with content-hash deduplication. |
| `Redactor` | At-write content filter applied to LLM IO + tool args + tool results before atom write. | `RegexRedactor` - common secret-format patterns (AWS keys, GitHub PATs, JWTs, generic high-entropy strings). |

### 2.2 Two new atom types

The existing `AtomType` union (`src/substrate/types.ts`) gets two additive entries:

- **`agent-session`** - one per agent run. Principal-bound. `metadata.agent_session` carries `model_id`, `adapter_id`, `workspace_id`, `started_at`, `completed_at`, `terminal_state`, `replay_tier`, optional `canon_snapshot_blob_ref` (strict tier only), `budget_consumed`, optional `failure`.
- **`agent-turn`** - one per LLM call. `derived_from` includes parent `agent-session`. `metadata.agent_turn` carries `session_atom_id`, `turn_index`, `llm_input` (inline-or-`BlobRef`), `llm_output` (inline-or-`BlobRef`), `tool_calls[]` (each with `tool`, `args`, `result`, `latency_ms`, `outcome`), `latency_ms`, optional `failure`.

### 2.3 Two new policy atom types

Stored as `type='preference'` per the existing pattern, with a `kind` discriminator in metadata:

- **`pol-replay-tier`** - per-principal or per-actor-type. Values: `best-effort | content-addressed | strict`. Default: `content-addressed`.
- **`pol-blob-threshold`** - per-principal or per-actor-type. Threshold in bytes. Validator clamps to `[256, 1_048_576]`. Default: `4096`.

### 2.4 Substrate purity

`src/` contains:
- The four interfaces in `src/substrate/agent-loop.ts`, `workspace-provider.ts`, `blob-store.ts`, `redactor.ts`.
- The atom-schema additions in `src/substrate/types.ts` (additive entries to the `AtomType` union; new `metadata.agent_session` and `metadata.agent_turn` shapes).
- Policy parsers + validators for `pol-replay-tier` and `pol-blob-threshold`.
- The replay-projection helpers (e.g., `projections/session-tree.ts`).
- The default failure-kind classifier.

`src/` does NOT contain:
- Concrete agent loops (Claude Code, LangGraph, custom).
- Workspace impls (git-worktree, docker, k8s).
- BlobStore impls (file, S3, in-memory).
- Redactor pattern libraries.

All concrete adapters live in `examples/`. This preserves the directive: "Framework code under `src/` must stay mechanism-focused and pluggable."

### 2.5 Indie / org floor + ceiling

- **Indie path:** `npm install + cp -r examples/agent-loops/claude-code .`. Working agentic executor in two commands.
- **Org path:** Implement four adapter classes; swap them in via Host composition. Framework's atom output shape stays identical, so dashboards / replay / audit / taint work uniformly.

---

## 3. Components

Concrete interface shapes (TypeScript-style). Full TypeDoc lives next to each interface; this section is the contract surface.

### 3.1 `AgentLoopAdapter`

```ts
// src/substrate/agent-loop.ts

export interface AgentLoopAdapter {
  readonly capabilities: AdapterCapabilities;

  /**
   * Drive one agent run end-to-end. The adapter MUST:
   *   1. Write an agent-session atom on entry, populating started_at,
   *      replay_tier, workspace_id, and an optimistic terminal_state
   *      (typically 'completed'); the same atom is updated on exit.
   *   2. Write an agent-turn atom for each LLM call, before issuing the call.
   *   3. Apply input.redactor to all content before atom write.
   *   4. Honor input.budget (turns + wall_clock_ms; usd if capabilities.tracks_cost).
   *   5. Honor input.signal (cooperative cancellation).
   *   6. Update the agent-session atom on exit (completed_at, terminal_state,
   *      failure, budget_consumed).
   *
   * Threat model:
   *   - The agent inherits whatever auth is in input.workspace's `.lag/apps/`.
   *     Caller is responsible for provisioning workspace creds appropriately
   *     (typically: copy from primary on workspace acquire).
   *   - Returns: artifacts + atom ids; no raw bytes (those flow via atom store).
   */
  run(input: AgentLoopInput): Promise<AgentLoopResult>;
}

export interface AdapterCapabilities {
  readonly tracks_cost: boolean;       // can it report tokens-spent → max_usd?
  readonly supports_signal: boolean;   // does it honor AbortSignal?
  readonly classify_failure: (err: unknown) => FailureKind;
}

export interface AgentLoopInput {
  readonly host: Host;
  readonly principal: PrincipalId;
  readonly workspace: Workspace;
  readonly task: AgentTask;            // plan atom + question prompt + file contents
  readonly budget: BudgetCap;          // { max_turns, max_wall_clock_ms, max_usd? }
  readonly toolPolicy: ToolPolicy;     // resolved from pol-llm-tool-policy-per-principal
  readonly redactor: Redactor;
  readonly blobStore: BlobStore;
  readonly replayTier: ReplayTier;
  readonly blobThreshold: number;      // bytes, clamped 256..1_048_576
  readonly correlationId: string;
  readonly signal?: AbortSignal;
}

export interface AgentLoopResult {
  readonly kind: 'completed' | 'budget-exhausted' | 'error' | 'aborted';
  readonly sessionAtomId: AtomId;
  readonly turnAtomIds: ReadonlyArray<AtomId>;
  readonly failure?: FailureRecord;
  readonly artifacts?: { commitSha?: string; branchName?: string; touchedPaths?: string[] };
}

export type FailureKind = 'transient' | 'structural' | 'catastrophic';

export interface FailureRecord {
  readonly kind: FailureKind;
  readonly reason: string;
  readonly stage: string;             // 'workspace-acquire' | 'agent-init' | 'turn-N' | 'commit' | ...
}
```

### 3.2 `WorkspaceProvider`

```ts
// src/substrate/workspace-provider.ts

export interface WorkspaceProvider {
  acquire(input: AcquireInput): Promise<Workspace>;
  release(workspace: Workspace): Promise<void>;   // idempotent
}

export interface AcquireInput {
  readonly principal: PrincipalId;
  readonly baseRef: string;
  readonly correlationId: string;
}

export interface Workspace {
  readonly id: string;
  readonly path: string;              // absolute
  readonly baseRef: string;
}
```

The reference `GitWorktreeProvider` creates a worktree at `.worktrees/agentic/<correlation_id>` off the configured base ref, copies bot creds from the primary worktree's `.lag/apps/`, and on release calls `git worktree remove --force` + cleans up the cred copy.

### 3.3 `BlobStore`

```ts
// src/substrate/blob-store.ts

export interface BlobStore {
  put(content: Buffer | string): Promise<BlobRef>;
  get(ref: BlobRef): Promise<Buffer>;
  has(ref: BlobRef): Promise<boolean>;
}

export type BlobRef = string & { readonly __brand: 'BlobRef' };  // 'sha256:<hex>'
```

The reference `FileBlobStore` writes to `<root>/.lag/blobs/<first2chars>/<sha256>` (sharding to keep directory listings sane at 100K+ blobs). Reads are passthrough; deduplication is automatic via content-addressing.

### 3.4 `Redactor`

```ts
// src/substrate/redactor.ts

export interface Redactor {
  redact(content: string, context: RedactContext): string;   // pure
}

export interface RedactContext {
  readonly kind: 'llm-input' | 'llm-output' | 'tool-args' | 'tool-result';
  readonly tool?: string;             // present for tool-args / tool-result
  readonly principal: PrincipalId;
}
```

The reference `RegexRedactor` ships with patterns for AWS keys, GitHub PATs (`ghp_`, `ghs_`, `gho_`), GitHub App installation tokens, JWT-shaped strings, generic high-entropy hex/base64 over a length threshold. Replaces matches with `[REDACTED:<pattern_name>]`. Pattern set is configurable; org swaps in their own patterns.

### 3.5 Atom shapes

```ts
// metadata.agent_session for atoms with type='agent-session'
interface AgentSessionMeta {
  model_id: string;                   // 'claude-opus-4-7' etc
  adapter_id: string;                 // 'claude-code-agent-loop' etc
  workspace_id: string;
  started_at: Time;
  completed_at?: Time;
  terminal_state: 'completed' | 'budget-exhausted' | 'error' | 'aborted';
  replay_tier: 'best-effort' | 'content-addressed' | 'strict';
  canon_snapshot_blob_ref?: BlobRef;  // strict tier only
  budget_consumed: { turns: number; wall_clock_ms: number; usd?: number };
  failure?: FailureRecord;
}

// metadata.agent_turn for atoms with type='agent-turn'
interface AgentTurnMeta {
  session_atom_id: AtomId;
  turn_index: number;                 // 0-based
  llm_input: { ref: BlobRef } | { inline: string };
  llm_output: { ref: BlobRef } | { inline: string };
  tool_calls: ReadonlyArray<{
    tool: string;
    args: { ref: BlobRef } | { inline: string };
    result: { ref: BlobRef } | { inline: string };
    latency_ms: number;
    outcome: 'success' | 'tool-error' | 'policy-refused';
  }>;
  latency_ms: number;
  failure?: FailureRecord;
}
```

### 3.6 Policy atom shapes

```ts
// metadata.kind = 'pol-replay-tier'
interface PolReplayTier {
  kind: 'pol-replay-tier';
  target_principal?: PrincipalId;
  target_actor_type?: string;         // e.g. 'cto-actor', 'code-author'
  tier: 'best-effort' | 'content-addressed' | 'strict';
}

// metadata.kind = 'pol-blob-threshold'
interface PolBlobThreshold {
  kind: 'pol-blob-threshold';
  target_principal?: PrincipalId;
  target_actor_type?: string;
  threshold_bytes: number;            // clamped at validator: [256, 1_048_576]
}
```

Validator enforces clamp. Resolution order: `target_principal` (most specific) → `target_actor_type` → framework default.

### 3.7 `AgenticCodeAuthorExecutor` (first consumer)

`src/runtime/actor-message/agentic-code-author-executor.ts` composes the seam:

1. Resolve `pol-replay-tier` + `pol-blob-threshold` for the executing principal.
2. `WorkspaceProvider.acquire({ principal, baseRef, correlationId })` → workspace.
3. `AgentLoopAdapter.run({ ..., workspace, budget, toolPolicy, redactor, blobStore, ... })` → result.
4. On `kind: 'completed'` with `artifacts.commitSha`: create PR via `GhClient` (existing flow).
5. On `kind: 'error' | 'budget-exhausted'`: per-failure-kind response (Section 5).
6. `WorkspaceProvider.release(workspace)`.

`buildDefaultCodeAuthorExecutor` (the diff-based version) keeps shipping as `buildDiffBasedCodeAuthorExecutor` (renamed for clarity). Actors opt into agentic mode via config; default for new actors is agentic, default for existing actors is whatever they had at PR2 land time (no silent flips).

---

## 4. Data flow

```text
operator-intent
   │
   ▼
CTO PlanningActor (one agent-session)
   │ each LLM call → agent-turn (linked via derived_from to session)
   ▼
plan atom (proposed)
   │ approved via plan-approval-vote
   ▼
plan atom (approved → executing)
   │ AgenticCodeAuthorExecutor consumed via dispatch
   ▼
WorkspaceProvider.acquire() → Workspace
AgentLoopAdapter.run({...})
   │ writes agent-session atom on entry (started_at, replay_tier,
   │   workspace_id, optimistic terminal_state)
   │ for each turn:
   │   • Redactor applied at-write to all content
   │   • payloads ≤ pol-blob-threshold → inline in agent-turn metadata
   │   • payloads > threshold → BlobStore.put → BlobRef in metadata
   │   • write agent-turn atom (derived_from: session)
   │ on completion: update agent-session
   │   (completed_at, terminal_state, budget_consumed, optional failure)
   ▼
AgentLoopResult { kind: 'completed', commitSha, branchName }
   │
   ▼
PR created via GhClient (existing gh-as flow)
plan atom (executing → succeeded)
WorkspaceProvider.release()
   │
   ▼
PR review + merge (existing flow; PrLandingActor handles CR loop)
```

### 4.1 Replay semantics by tier

| Tier | What's captured | Replay guarantee |
|---|---|---|
| `best-effort` | Turn IO inline / blob, tool call args + results, model_id | "Re-fed inputs to the same model usually produce similar output." No promise. |
| `content-addressed` (default) | Above + `canon_hash` per turn (read at session-start), `tool_versions` snapshot, `fence` snapshot | "Re-fed inputs produce deterministic-modulo-LLM-sampling-noise output (typically temp=0 → deterministic)." Replay works as long as the model_id is still available from the provider. |
| `strict` | Above + full `canon_snapshot_blob_ref` (canon serialized at session-start) + sampling params + principal-hierarchy snapshot | "Reproducible byte-identical traces modulo provider nondeterminism." Requires content-hashing tool implementations and snapshotting canon at session-start. ~10-100 KB extra per session for the canon snapshot. |

### 4.2 Tree projection

A future projection (`src/projections/session-tree.ts`) walks dispatch atoms by `correlation_id` to produce a multi-actor session log:

```text
intent-<id>
  └── plan-<id> (CTO session: T turns)
       └── dispatch-<id>
            └── code-author session (executor: U turns)
                 └── tool calls embedded per turn
                 └── dispatch-<id> (if executor delegates)
                      └── ... (recursive)
```

Replay walks this tree depth-first. The projection itself is read-only; it derives from atoms, never writes.

---

## 5. Error handling

### 5.1 Failure taxonomy (per brainstorming Q8 = C)

| Kind | Examples | Default response |
|---|---|---|
| `transient` | LLM rate limit; network blip; transient tool failure (e.g. EBUSY on a Windows file op); ENOTFOUND on first DNS attempt | retry up to 3 attempts with exponential backoff (1s, 2s, 4s); turn budget consumed each retry |
| `structural` | Out of budget (turns / time / usd); agent stuck (no progress signal across N turns); policy-refused tool that the agent can't work around; plan-impossible (drafter says "I can't" with rationale) | escalate via Notifier; session terminates with `terminal_state: 'error'` and `failure.kind: 'structural'` |
| `catastrophic` | Workspace can't be acquired (disk full / perms); Redactor crashed; BlobStore unavailable; atom store write failed (corrupted disk) | hard fail; no retry; `terminal_state: 'error'`, `failure.kind: 'catastrophic'`. Dispatch atom marked failed; plan transitions to `failed` |

### 5.2 Classification mechanism

`AdapterCapabilities.classify_failure: (err) => FailureKind`. Default classifier in `src/substrate/agent-loop.ts` covers common error shapes (Node `ECONN*`, HTTP 429/503, file-system EBUSY/EACCES on Windows, signal-aborted). Adapters override for adapter-specific failure modes (e.g., Claude Code subscription "max budget exhausted" → structural).

### 5.3 No retry-policy atom

The taxonomy + hardcoded defaults serve indie + org from day one. Orgs needing different behavior (5 retries instead of 3, or escalate-on-transient) swap `AgentLoopAdapter` itself - already pluggable per Section 2. We avoid policy proliferation (we already have `pol-replay-tier`, `pol-blob-threshold`).

### 5.4 Cooperative cancellation

`AgentLoopInput.signal?: AbortSignal` is honored by adapters whose `capabilities.supports_signal === true`. The CTO actor / executor passes a signal that fires on:
- Kill switch atom (`.lag/STOP` sentinel) detected by the dispatcher.
- Budget cap exceeded (executor's outer guard, not the adapter's inner one).
- Explicit operator cancel via `lag-respond cancel <correlation_id>`.

Adapters without `supports_signal` ignore the signal and rely on budget caps to terminate.

---

## 6. Security + correctness up front

This section is **load-bearing**: every implementation task must be designed for security + correctness BEFORE writing code, not after CR flags it. Memory `feedback_security_correctness_at_write_time` captures the discipline; this section makes it spec-level.

### 6.1 Threat model documented per seam (in JSDoc)

For each interface, the JSDoc names:
- Who can invoke the seam (principal scope).
- What auth scope the spawned activity inherits.
- What's in the workspace's `.lag/apps/` (bot creds; same threat model as today).
- Data flowing through the Redactor and what's exposed if it crashes.

Specific notes per seam:
- **`AgentLoopAdapter`**: the agent process inherits whatever credentials are in the workspace. Caller MUST set up creds with the minimum scope needed (typically: copy `lag-ceo` only, not `lag-cto` or other bot identities the agent shouldn't act as).
- **`WorkspaceProvider`**: the isolation boundary is implementation-defined. The reference `GitWorktreeProvider` is process-local - same OS user, same disk. Stronger isolation (docker, k8s) is opt-in via swap.
- **`BlobStore`**: blobs are unencrypted at rest by default (per #5 brainstorming). Encryption is a deferred follow-up; until then, treat blob storage as having the same trust boundary as the rest of `.lag/`.
- **`Redactor`**: pattern coverage is the operator's responsibility for org-specific secrets; the default `RegexRedactor` covers common third-party formats but NOT org-specific (customer IDs, internal API tokens). Document the exact patterns covered; encourage org override.

### 6.2 Per-task security + correctness walkthrough

The implementation plan generated via `superpowers:writing-plans` has every task carry a "Security + correctness considerations" subsection. The implementer subagent walks through these BEFORE writing code, not after. Walkthrough includes:
- Empty input, missing field, unicode/whitespace edge cases.
- Concurrent writes (atom store is multi-writer in a worktree-per-actor world).
- Partial-failure rollback (workspace acquired then crash mid-session: how does cleanup happen?).
- Time-zone, line-ending, off-by-one in line counts.
- For YAML / workflow changes: event-type triggers, fork-vs-same-repo gating, secret injection paths, dual-mechanism risks (per the experience on PR #165).
- For seam interfaces carrying auth: scope, blast radius, fork-vs-same-repo.

### 6.3 Pre-push checklist gate per task

Implementer subagent runs the pre-push grep (memory `feedback_pre_push_grep_checklist`) before each commit. CI's package-hygiene gate is the safety net, but the implementer's pre-push is the primary discipline.

### 6.4 At-write redaction is mandatory, not opt-in

The seam composes `Redactor` unconditionally. Adapters that bypass it (e.g., write raw LLM output to atom store) violate the substrate contract.

A future validator can enforce this at write-time by re-running the principal's `Redactor` over agent-turn payloads and rejecting any payload that produces redaction markers a second time. This validator is NOT shipped in PR1; redaction is enforced at the adapter level via the `AgentLoopAdapter` MUST contract. The validator-atom design lands in a separate substrate plan when org-scale deployments need the second line of defense.

### 6.5 Default-deny tool policy

`pol-llm-tool-policy-per-principal` already exists in canon. The agent loop respects it: tool calls denied by policy emit `tool_calls[].outcome: 'policy-refused'` and the agent receives a structured rejection it can reason about. Tool whitelists are explicit, not implicit.

### 6.6 Adapter capability declarations

`AdapterCapabilities` flags prevent silent misuse:
- `tracks_cost: boolean` - executor only enforces `max_usd` if true.
- `supports_signal: boolean` - executor falls back to budget-cap-only termination if false.
- Adapters that lack a capability are first-class, not second-class - their constraints are visible in the type system.

---

## 7. Testing

### 7.1 Substrate-level

- **Interface contract tests** in `test/substrate/`:
  - `agent-loop-contract.test.ts`: any conforming `AgentLoopAdapter` MUST pass these (atom emission, redaction applied, budget honored, cancellation honored).
  - `workspace-provider-contract.test.ts`: acquire/release semantics; cleanup-on-error.
  - `blob-store-contract.test.ts`: round-trip, dedup by hash, error shapes.
  - `redactor-contract.test.ts`: pattern coverage, idempotence, fail-mode (catastrophic if redactor crashes).
- **Atom schema tests**: validate `agent-session` + `agent-turn` shapes; replay-tier promotion; blob-threshold clamp at 256/1048576.
- **Failure taxonomy tests**: each `FailureKind` round-trips through atoms and produces correct executor behavior (retry / escalate / hard-fail).
- **Replay-projection tests**: given a chain of session/turn atoms, the projection reconstructs the tree by `correlation_id` traversal.

### 7.2 Reference adapters

- `test/examples/claude-code-agent-loop.test.ts`: run against a small fixture plan (touch `README.md`) in a tmpdir workspace. Validates that turn atoms are emitted, redaction works on a planted "fake API key" string, budget is honored.
- `test/examples/git-worktree-provider.test.ts`: acquire creates a worktree at the right path; release cleans up; cleanup-on-error tested via stubbed git failure mid-acquire.
- `test/examples/file-blob-store.test.ts`: round-trip; dedup test with two `put`s of the same content; sharded path layout.
- `test/examples/regex-redactor.test.ts`: each pattern covered with positive + negative test cases.

### 7.3 End-to-end on `MemoryHost`

`test/e2e/agentic-chain.test.ts`: full chain (operator-intent → plan → dispatch → agent-loop → result) on `MemoryHost` with stub LLM emitting deterministic turns. Validates:
- Atom chain is correct (derived_from links).
- Replay projection reconstructs the tree.
- Failure taxonomy on injected error → correct executor behavior.
- Tool policy denial → `outcome: 'policy-refused'` in turn atom.

---

## 8. Phasing (per brainstorming Q-Phasing = B)

### 8.1 PR1 - Substrate foundations

**`src/`:**
- `src/substrate/agent-loop.ts` - `AgentLoopAdapter`, `AdapterCapabilities`, `AgentLoopInput`, `AgentLoopResult`, `FailureKind`, `FailureRecord` interfaces. Default failure-kind classifier.
- `src/substrate/workspace-provider.ts` - `WorkspaceProvider`, `Workspace` interfaces.
- `src/substrate/blob-store.ts` - `BlobStore`, `BlobRef` interfaces.
- `src/substrate/redactor.ts` - `Redactor`, `RedactContext` interfaces.
- `src/substrate/types.ts` - additive entries in `AtomType` union; `AgentSessionMeta`, `AgentTurnMeta` shapes.
- `src/substrate/policy/replay-tier.ts` - `pol-replay-tier` parser + resolver (read from `metadata.kind === 'pol-replay-tier'`).
- `src/substrate/policy/blob-threshold.ts` - `pol-blob-threshold` parser + clamp.
- `src/substrate/projections/session-tree.ts` - projection helper.

**`examples/`:**
- `examples/agent-loops/claude-code/` - `ClaudeCodeAgentLoop` reference adapter.
- `examples/workspace-providers/git-worktree/` - `GitWorktreeProvider` reference.
- `examples/blob-stores/file/` - `FileBlobStore` reference.
- `examples/redactors/regex-default/` - `RegexRedactor` reference + default pattern set.

**`test/`:**
- Full unit + contract test coverage per Section 7.
- Reference-adapter integration tests.

**Atom-store migration:** purely additive (new types in the union; no breaking changes to existing atom files). Memory `feedback_pull_main_after_pr_merge` discipline applies.

**Out of scope for PR1:** `AgenticCodeAuthorExecutor`. PR1 ships the substrate; nothing consumes it yet (the substrate dogfoods via tests only).

### 8.2 PR2 - `AgenticCodeAuthorExecutor` migration

**`src/`:**
- `src/runtime/actor-message/agentic-code-author-executor.ts` - composes the seam.
- `src/runtime/actor-message/code-author-executor-default.ts` - renamed to `diff-based-code-author-executor.ts` for clarity. The diff path stays available for adapters that prefer it.
- Config flag in `DefaultExecutorConfig` to choose `diff-based` vs `agentic`.

**Back-compat alias for the rename**: PR2 ships a deprecated re-export named `buildDefaultCodeAuthorExecutor` from `src/runtime/actor-message/code-author-executor-default.ts` (or a thin shim file at the old path) that forwards to `buildDiffBasedCodeAuthorExecutor` for one minor release. The old import path keeps working for any consumer (or `examples/`) that hasn't migrated; a deprecation note in the JSDoc points at the new symbol. Removed in the release after.

**`test/e2e/`:**
- End-to-end on `MemoryHost` with stub agent loop emitting deterministic turns + a stub git client. Validates the full chain produces a PR.

**Out of scope for PR2:** other-actor migrations (planning, auditor, pr-landing). Each migration is its own follow-up plan.

### 8.3 Out-of-scope deferred follow-ups

- **At-rest encryption** for atom store + BlobStore (per brainstorming Q5). To revisit when an org with compliance requirements drives demand.
- **`PlanningActor` migration** to the agent-loop seam (replaces today's `HostLlmPlanningJudgment` two-shot draft).
- **`AuditorActor` migration** when the auditor ships.
- **`PrLandingActor` migration** to the agent-loop seam (replaces today's hand-rolled CR-fix loop).
- **Replay UI** - a console view that walks the session tree, shows turn-by-turn IO, links to the produced PR.
- **Cross-actor session-tree projection / dashboard** - `console/` view of the chain.

---

## 9. Open follow-ups (cross-cutting)

- **App-token migration for `lag-auditor-noop`** (task #68; not blocked by this spec but worth doing concurrently).
- **At-rest encryption** for atom store (deferred per Section 8.3).
- **Per-actor migrations** to the seam (Section 8.3).

---

## 10. Provenance

This design derives from:

**Canon directives:**
- `dev-substrate-not-prescription` - framework code stays mechanism-focused; adapters live in `examples/`.
- `simple-surface-deep-architecture` - pluggable seam keeps the surface simple while enabling org-scale architecture.
- `dev-flag-structural-concerns-proactively` - surfaced during brainstorming: per-tool atoms would inflate volume 5-10x; per-session-only loses turn-level provenance; turn-level is the right cut.
- `inv-provenance-every-write` - every new atom (`agent-session`, `agent-turn`) carries `derived_from` linking back through the chain.
- `inv-governance-before-autonomy` - failure taxonomy + Notifier escalation keeps a human in the loop on structural failures by default.
- `dev-extreme-rigor-and-research` - the brainstorming session worked through 8 design questions sequentially, each with multiple alternatives weighed.
- `dev-no-hacks-without-approval` - the at-write redaction mandate is a hard substrate contract; bypass requires explicit operator override.
- `dev-forward-thinking-no-regrets` - atom schemas are additive (new types in the union); existing atoms unaffected; future encryption layer composes without schema change.

**Atoms:**
- `intent-253cf493b08f-2026-04-24T22-54-13-895Z` - operator-intent that drove PRs #157-#165 substrate work.
- Memories: `project_agentic_executor_session_log_direction.md`, `project_autonomous_intent_e2e_complete.md`, `feedback_security_correctness_at_write_time.md`, `feedback_pull_main_after_pr_merge.md`, `feedback_canon_strategic_not_tactical.md`.

**Prior work this builds on:**
- PRs #157-#165 (substrate foundations + dogfood-cycle gaps).
- Existing seams (`Host`, `LLM`, `AtomStore`, `Notifier`, `Auditor`, `PrincipalStore`, `Clock`, `CanonStore`, `Scheduler`).
- Existing actor primitives (`PlanningActor`, `CodeAuthorExecutor` diff-based path).

---

## 11. What breaks if we revisit

This spec is designed to survive a 3-month-later review (per `dev-design-decisions-survive-3-months`):

- **Adapter swap doesn't break atom shape.** Org swaps `ClaudeCodeAgentLoop` for `LangGraphAgentLoop` and the atom output is identical; dashboards / replay / audit work uniformly.
- **New actor types (e.g., a `ReleaseManager` actor in 2027) compose the same seam.** No framework change needed to add a new actor.
- **Encryption layer composes in.** Wraps `AtomStore` and `BlobStore`; atom schema unchanged.
- **Replay UI is a projection, not new infrastructure.** Reads atoms; writes nothing.
- **Org-scale migration to Postgres `AtomStore`.** Pluggable per existing `AtomStore` Host sub-interface; atom shape carries through.
- **Cost cap evolves (per-org budget).** `BudgetCap` is already structured; adding `max_usd_per_session` next to `max_usd` is additive.

The one durable risk: the agent loop ABSTRACTION itself (turn-level emission, tool calls embedded). If a future agent paradigm doesn't fit "turn = LLM call with tool use" (e.g., continuous streaming agents, multi-modal agents with non-text tool IO), the schema would need extension. Mitigation: `metadata` is open; unanticipated fields ride in `metadata.agent_turn.extra` until graduating to core.
