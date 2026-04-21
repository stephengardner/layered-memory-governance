# ADR: Medium-tier kill switch (runtime revocation)

**Status:** PROPOSED. Shape only; no implementation in this PR.
**Canon id:** `arch-medium-tier-kill-switch`.
**Replaces shorthand:** `D13` in `design/adr-code-author-blast-radius-fence.md`, `design/adr-code-author-principal-bootstrap.md`, `design/phase-55b-llm-judgment.md`. Those documents refer to "D13" as the kill-switch decision; `DECISIONS.md` D13 is a different decision ("Telegram-as-operator, tools auto-fire on TG-originated prompts"). Follow-up PRs should cite `arch-medium-tier-kill-switch` instead.
**Authored:** 2026-04-21.

## Why this ADR

The code-author fence ADR (`design/adr-code-author-blast-radius-fence.md`) lists the medium-tier kill switch as graduation criterion #2: a runtime-revocation mechanism that can halt an in-flight action mid-operation. The existing soft STOP sentinel is insufficient for that role, and there is no ratified design for the medium tier. This ADR supplies the design and names the canon atom so future work can cite it unambiguously.

## Terminology: the three tiers

| Tier | Mechanism (today / proposed) | Halts what |
|---|---|---|
| **Soft** | `.lag/STOP` file, checked at actor loop boundaries via `killSwitch` predicate in `runActor` | The loop, at the next iteration boundary or the next pre-apply check. In-flight adapter calls, HTTP requests, child-process invocations continue. |
| **Medium** (this ADR) | `AbortController` backed by a filesystem watch on `.lag/STOP`; `AbortSignal` propagated through the full adapter + HTTP + child-process tree | In-flight work is cancelled within milliseconds. LLM streams abort; `fetch`/GraphQL requests reject with `AbortError`; spawned child processes receive SIGTERM. The actor writes a `kill-switch-tripped` atom and exits. |
| **Hard** (future, out of scope) | OS-level process termination (parent process kills child group). No post-kill atom; relies on external audit of the fact of termination. | The Node process itself. |

Soft is what's shipped today. Hard is the last-resort nuclear option. Medium is the tier the code-author needs because it can push commits mid-loop - a soft halt that waits for the current `git push` to finish is an unacceptable blast radius.

## Shape of the medium-tier kill switch

### 1. `KillSwitchController`

New module `src/kill-switch/` exporting:

```ts
export interface KillSwitchController {
  /** AbortSignal every adapter, HTTP client, and child process subscribes to. */
  readonly signal: AbortSignal;
  /** True when STOP has been observed. */
  readonly tripped: boolean;
  /**
   * The mechanism that tripped. Observable in the kill-switch-tripped
   * atom's metadata so the operator can diagnose.
   */
  readonly trippedBy: 'stop-sentinel' | 'deadline' | 'parent-signal' | null;
  /** Dispose fs.watch + any other listeners. Idempotent. */
  dispose(): void;
}

export interface CreateKillSwitchOptions {
  readonly stateDir: string;                    // .lag root
  readonly sentinelFilename?: string;           // default 'STOP'
  readonly additionalAbortSignals?: ReadonlyArray<AbortSignal>; // parent compositions
  readonly pollFallbackMs?: number;             // default 1000; used when fs.watch is not reliable
}

export function createKillSwitch(options: CreateKillSwitchOptions): KillSwitchController;
```

Creation sequence:

1. Check `stateDir/<sentinelFilename>` at construction. If present, trip immediately.
2. Start `fs.watch(stateDir)` filtered to the sentinel filename. On `rename`/`change` events where the file now exists, trip.
3. Also start a `setInterval(pollFallbackMs)` that `statSync`s the sentinel. Redundant with `fs.watch` by design: some filesystems (network shares, Windows under certain watch APIs, Docker bind mounts) drop watch events silently. The poll fallback caps worst-case detection latency at `pollFallbackMs`.
4. `signal` is wired to an internal `AbortController`. When any trip path fires, `controller.abort()`. The signal is also wired to any `additionalAbortSignals` via `AbortSignal.any()` so parent compositions (process-level SIGTERM → AbortSignal) propagate in.

### 2. Propagation through the Actor loop

`runActor` accepts a new option:

```ts
export interface RunActorOptions<Adapters extends ActorAdapters> {
  // ...existing fields...
  /**
   * Optional runtime revocation signal. When aborted, runActor halts
   * at the EARLIEST SAFE POINT in the loop AND propagates the signal
   * into the ActorContext for adapters and apply/observe/classify
   * calls to observe. Compatible with the existing `killSwitch`
   * predicate; a consumer may pass either or both. If both are
   * supplied, either one tripping halts the loop.
   */
  readonly killSwitchSignal?: AbortSignal;
}
```

Behavior when `killSwitchSignal.aborted` is true at any check:

1. Abort in-flight `observe`/`classify`/`propose`/`apply` by passing the signal into `ActorContext`. Adapters throw `AbortError`; the loop catches it and halts.
2. Write the `kill-switch-tripped` atom (see §3) before `runActor` returns.
3. Return an `ActorReport` with `haltReason: 'kill-switch'` and `lastNote` describing the trip cause.

### 3. `kill-switch-tripped` atom

L1 observation. Written by the actor runner (not the framework) on a trip. Discriminated by `metadata.kind: 'kill-switch-tripped'` (no AtomType widening, same pattern as `pr-observation`).

```ts
{
  type: 'observation',
  layer: 'L1',
  metadata: {
    kind: 'kill-switch-tripped',
    actor: '<actor name>',
    principal_id: '<principal>',
    tripped_by: 'stop-sentinel' | 'deadline' | 'parent-signal',
    tripped_at: '<iso>',
    iteration: <last-started-iteration>,
    phase: 'observe' | 'classify' | 'propose' | 'apply' | 'between-iterations',
    in_flight_tool?: string,  // the tool name that was apply()ing at trip time, if any
    revocation_notes?: string,
  },
  principal_id: '<actor principal>',
  provenance: {
    kind: 'agent-observed',
    source: {
      agent_id: '<principal>',
      tool: 'kill-switch-revocation',
      session_id: '<session id>',      // required; lineage projections (D-mbb-V1-4/V2-2) depend on session-scoped provenance
    },
    derived_from: [],
  },
  // ...rest of the atom envelope...
}
```

Atom id: `kill-switch-tripped-<actor>-<principal>-<iso-timestamp>`. Not idempotent - every trip is a distinct observation.

### 4. ActorContext changes

`ActorContext` gains `readonly abortSignal: AbortSignal` - ALWAYS present, never optional. On the soft path (no `killSwitchSignal` passed to `runActor`), the runner injects a never-aborted `AbortSignal` (an `AbortController` that is constructed and never called) so adapters can thread it unconditionally without null-checking. This keeps the adapter contract single-shape across soft and medium paths, matching the canon's "substrate stays mechanism-only" posture - adapters decide whether to forward; the context always has a signal to forward.

Adapters that perform I/O forward the signal:

- `GhClient`: `fetch(..., { signal })` + `AbortController`-aware `spawn` for child processes.
- `ClaudeCliLLM`: signal threaded into `execa(..., { cancelSignal: signal })`. SIGTERM to the CLI child on abort.
- `PrReviewAdapter` methods: signal forwarded to the underlying `GhClient`.

Adapters without I/O (e.g., in-memory stubs in tests) ignore the signal; no-op forwarding costs nothing.

Backward-compat note for existing actors: actors that never read `ctx.abortSignal` still work; the field is additive. A future `ctx.abortSignal.aborted` check is the opt-in for medium-tier awareness.

### 5. Revocation protocol for the code-author case

The fence ADR's `pol-code-author-write-revocation-on-stop` says:

> when `.lag/STOP` is written during a code-author run, the actor: (a) halts its current operation, (b) closes (not abandons) any in-progress draft PR with a comment explaining the revocation, and (c) writes a `code-author-revoked` atom

The medium-tier kill switch delivers (a). The code-author actor implements (b) and (c) in its halt handler (registered via a cleanup hook on the KillSwitchController). The framework stays mechanism-only; the code-author supplies the revocation semantics in its own module.

## What this PR does NOT do

- Does NOT implement `src/kill-switch/`. Implementation is a follow-up PR.
- Does NOT modify `runActor`. The `killSwitchSignal` option lands with the implementation.
- Does NOT modify any adapter. Signal-wiring lands with the implementation.
- Does NOT seed any canon atom for the fence work. That is gated on all of PR D-impl + PR E (conflict-fuzz) + PR F (bootstrap-code-author-canon.mjs) per the fence ADR.

## Open questions (deliberately not resolved here)

1. **How fast does the medium tier need to halt?** Target is "in-flight HTTP / child-process calls abort within 1s of STOP file appearing." Watched by benchmark tests at implementation time. If filesystem watch drops events more often than this budget allows, raise `pollFallbackMs` to a smaller value (lose a bit of CPU to gain latency guarantees).
2. **What if the child process ignores SIGTERM?** Medium tier is cooperative; a process that ignores SIGTERM (or blocks in uninterruptible I/O) defeats medium-tier. That is the use case for hard tier, which is out of scope for this ADR.
3. **What happens to the `kill-switch-tripped` atom write if the AtomStore itself is wedged?** The write is best-effort; the actor logs a fatal stderr line and exits non-zero. The operator sees the stderr log even when the atom write fails. Medium tier is about stopping work, not about guaranteed durable audit.

## Alternatives rejected

1. **Soft STOP is enough for code-author.** Rejected per the fence ADR: a code-author that is pushing a commit cannot be safely halted at an iteration boundary. The commit either has to finish or be torn down mid-push.
2. **Synchronous polling every N ms with no `AbortSignal`.** Rejected: it only halts at poll boundaries, which is the same soft-halt problem at finer granularity. The adapter's in-flight `fetch` still blocks until response or timeout.
3. **Hard-tier immediately (no medium).** Rejected: a hard kill of the actor process orphans atoms mid-write (the kill-switch-tripped atom) and orphans in-flight PR drafts (the code-author revocation atom). Medium tier delivers cooperative tear-down that hard tier skips.
4. **Keep the shorthand "D13" in the fence ADR.** Rejected: D13 in `DECISIONS.md` is a different decision; the conflation creates a citation ambiguity that will harden into canon if unfixed. This ADR names the decision `arch-medium-tier-kill-switch` and follow-up PRs should migrate citations.

## Graduation criteria for the follow-up implementation PR

1. This ADR merged.
2. Unit tests for `createKillSwitch`: trip-on-file-already-present, trip-on-file-appears-mid-run, dispose cleanup, fs.watch-fallback behavior, AbortSignal.any composition.
3. Integration test: `runActor` with a slow `apply()` halts within 1s of STOP file creation; `kill-switch-tripped` atom is written; adapter's in-flight HTTP receives `AbortError`.
4. Backward-compat: existing `killSwitch` callback predicate continues to work when `killSwitchSignal` is absent; both together is valid.
5. Performance: the `pollFallbackMs` default (1000) adds < 1% CPU to an otherwise-idle actor loop. Benched in CI.

## Provenance

- `inv-kill-switch-first` - the invariant the medium tier operationalizes.
- `design/adr-code-author-blast-radius-fence.md` - the downstream ADR that requires this tier.
- `design/adr-code-author-principal-bootstrap.md` - also cites the medium tier.
- `dev-forward-thinking-no-regrets` - ADR-frozen shape means the implementation PR is mechanical.
- `dev-flag-structural-concerns` - the reason this ADR exists at all (D13 shorthand was ambiguous; surfacing rather than silently working around).
- `dev-substrate-not-prescription` - revocation semantics live in actor modules, not in framework kill-switch primitive.

## Decision record

| Date | Actor | Action |
|---|---|---|
| 2026-04-20 | cto-actor (self-audit) | Listed the medium-tier kill switch as fence graduation criterion #2. |
| 2026-04-21 | operator + claude-agent | This ADR: shape + canon id (`arch-medium-tier-kill-switch`); resolves "D13" shorthand ambiguity. |
| (pending) | reviewer | Approve the shape or request edits. |
| (pending) | future implementer | Ship `src/kill-switch/` + `runActor` integration + tests in a follow-up PR. |
