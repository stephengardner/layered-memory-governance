# Decisions

Living log of architectural choices that shaped LAG. One entry per decision that would take a newcomer more than 60 seconds to reverse-engineer from the code. Newest at top.

Format: short context, the decision, why, alternatives we rejected, what breaks if we revisit.

> **Status of this document**: nothing here is frozen. Every entry is a *working* judgment given the state of the world and the data we had on hand. As LAG runs against real workloads, we expect to revisit, reorganize, and sometimes reverse decisions. The "what breaks if we revisit" field exists because revisitation is expected behavior, not a governance failure. Treat entries as precedent, not law.

---

## D0: This document is itself a test case

**Context**: LAG exists to govern the kind of decision-making that happens during the authoring of software, architecture, and policy. The decisions logged here (trade-offs between alternatives, reasons for deferral, push-back on premature abstraction, escalations to the human in the loop) are the exact class of judgments an orchestrated autonomous agent will need to reproduce.

**Decision**: Treat every entry below as both a rationale record for humans AND a training instance for future autonomous operation. Always record the context, the alternatives considered, the rationale for the choice, and the HIL interaction where it happened.

**Why**:
- An agent that reads only "we chose X" cannot learn the judgment. The rejected alternatives and the reasoning are load-bearing.
- When the autonomy dial turns up and agents start making these calls themselves, LAG's arbitration stack needs settled precedent to reference. This file IS precedent.
- HIL-in-the-loop frequency (when the agent asks vs decides) calibrates on recorded history. Entries that document "I escalated this to a human" teach the seam.

**Alternatives rejected**:
- Pure code comments. Lose the rejected-alternative context and the "who signed off" trail.
- Wiki / external doc. Breaks version lockstep with the code that embodies the decision.
- Implicit in git history. Commit messages rarely carry alternatives considered or push-back received.

**What breaks if we revisit**: Nothing mechanical. The discipline is informational: future reviewers miss the "why" and re-open settled debates.

---

## D11: Queue mode + hook = terminal-attached runtime (Phase 42)

**Context**: Phase 41's daemon spawns a fresh `claude -p` per message (stateless) or with `--resume` (shared-jsonl). Both are independent processes from the terminal Claude Code instance. The user asked for the Telegram bot to literally be the running terminal instance, so a session persists in-terminal that includes Telegram exchanges.

**Decision**: Add `--queue-only` mode to the daemon. In queue mode, the daemon does NOT spawn claude-cli; it writes incoming Telegram messages to `.lag/tg-queue/inbox/` and drains `.lag/tg-queue/outbox/` to Telegram. A companion `Stop` hook (at `examples/hooks/lag-tg-attached-stop.cjs`) runs after each terminal turn, reads the inbox, re-prompts Claude via `decision: block` with the message as reason, captures Claude's reply from the transcript on the next Stop, writes to outbox.

**Why**: Gives the "terminal is brain, Telegram is remote mouth" experience without a separate process. The running Claude Code instance handles both terminal and Telegram on the same session state. Both transcripts (terminal jsonl + Telegram chat history) record the same exchange coherently.

**Alternatives rejected**:
- TIOCSTI / fake-stdin injection on Unix. Hacky, Windows-hostile.
- MCP server that exposes `tg_check` / `tg_send` as tools for Claude to poll. Requires Claude to think to poll; doesn't fit ambient UX.
- Polling loop inside the main Claude Code process. No such extension point ships today.

**What breaks if we revisit**: Hook registration is in user settings.local.json (out of repo); removing the feature means un-registering the hook. Queue dir is recoverable (drain, delete).

## D10: Runtime modes compose rather than replace (Phases 41, 42)

**Context**: LAG needs to serve both autonomous orgs (stateless agents) and solo dev (continuity, bidirectional). The temptation is to pick one runtime shape and build everything around it.

**Decision**: Ship three composable runtime modes for the same daemon binary, all sharing the same `.lag/` substrate:

1. **Stateless daemon** (default): every message is independent; canonical autonomous-org shape.
2. **Resume-shared daemon** (`--resume-session <id>` or `--resume-latest`): daemon uses claude-cli's `--resume` flag so replies append to the pinned jsonl; terminal and daemon share state through the file.
3. **Queue + hook** (`--queue-only`): daemon becomes pure transport; running terminal Claude Code instance handles via Stop hook.

All three can run concurrently against the same `.lag/` in principle (file adapter supports cross-process access). A user chooses based on context.

**Why**: "Pluggable architecture" is the north star. Hardcoding one runtime mode sacrifices either solo-dev ergonomics or org-scale semantics. Three modes is cheap (~300 lines, all behind one flag each) and lets us learn which is useful.

**Alternatives rejected**:
- Pick stateless only and tell solo-dev users to run terminal separately. Rejected because continuity is a real ergonomic win.
- Pick resume-shared only. Rejected because autonomous orgs explicitly want no session coupling across messages.
- Full "runtime orchestrator" abstraction with pluggable pipe stages. Premature. Three modes + clean flag surface is enough.

**What breaks if we revisit**: Modes diverge in semantics over time; users may expect one to behave like another. Document differences. Queue-mode's Stop hook is the coupling point most at risk of drift.

## D9: Runtime surfaces are a seam, but only one ships (Phase 41)

**Context**: The LAG daemon (Phase 41) listens on Telegram, spawns `claude -p`, writes atoms. That's ONE runtime surface. Others are obvious (Slack, Discord, web UI, email), and it's tempting to abstract a full pipeline now.

**Decision**: Name the seams (InputSource, ContextAssembler, ModelInvoker, OutputSink, AtomWriter) in the daemon's code. Implement only the Telegram composition. Do not package surfaces as plug-ins yet.

**Why**: One surface today, real users never see the abstraction overhead. Two surfaces later, the refactor is ~half a day and we know exactly what the right abstraction is because we have two data points instead of one.

**Alternatives rejected**:
- Full pluggable pipeline framework today. Premature; nobody is writing a second surface against it right now.
- Hardcode Telegram-specific assumptions deeper. Would require a bigger rewrite when the second surface ships.

**What breaks if we revisit**: Adding a second surface. Expect 1-2 extracted interfaces and some file moves. Not a big lift.

---

## D8: Session sources are a pluggable interface (Phase 40)

**Context**: LAG needs to start SOMEWHERE: either empty, or seeded from prior state (Claude Code transcripts, ChromaDB, Obsidian vault, etc). The question was whether Phase 40 should ship one ingester hard-coded, or a pluggable abstraction.

**Decision**: `SessionSource` interface with pluggable implementations (`FreshSource`, `ClaudeCodeTranscriptSource`). Multiple sources compose via content-hash dedup at the AtomStore layer.

**Why**: The span from solo dev (one source) to autonomous org (five sources) requires composition. The abstraction is tiny (one interface, one method) so the cost is low. Adding an Obsidian or ChromaDB source is then a new file, not an architecture change.

**Alternatives rejected**:
- Hard-coded Claude Code ingester only. Would have worked for V1 dogfooding but forced a rewrite at source #2.
- Pipeline-of-ingesters with transforms. Premature; the only transform needed today is identity.

**What breaks if we revisit**: Every source implements `SessionSource`. Changing the interface ripples to all of them. So far there are two; the cost is bounded.

---

## D7: Plan primitive as Atom field, not separate type (Phase 38)

**Context**: Plans are intent; atoms are facts. Where does a plan live in the schema?

**Decision**: Plans are `Atom`s with `type: 'plan'` and a new optional `plan_state?: PlanState` field on Atom. State transitions patch through `AtomStore.update()` via `plan_state` on `AtomPatch`.

**Why**: Plans share every governance machine piece with atoms: provenance, scope, principal, layer, taint, audit. Building a parallel primitive would duplicate all of that. The Atom field adds one optional property for ~20 lines of schema with no runtime cost for non-plan atoms.

**Alternatives rejected**:
- Separate `Plan` top-level type. Clean separation but 10x the work and duplicated governance code.
- `plan_state` in `atom.metadata`. Zero schema change but weakly typed and harder to filter on.

**What breaks if we revisit**: The Atom shape. Would require a schema migration for any persisted state. We documented it in `AtomPatch` so callers can mechanically find the touchpoints.

---

## D6: Self-bootstrap is data, not a subsystem (Phase 39)

**Context**: LAG should be able to govern its own repo. Should we build a "bootstrap subsystem" with hooks, or just a script that writes curated atoms?

**Decision**: `scripts/bootstrap.mjs` is a 150-line script that writes a curated array of L3 atoms from the `lag-self` root principal. Idempotent via atom-id dedup.

**Why**: Self-bootstrap is a one-shot, manual-editorial task (humans pick the invariants; we do not LLM-extract them). A script is the right abstraction. A subsystem would over-engineer a 20-atom case.

**Alternatives rejected**:
- A `SelfBootstrap` interface + plugin. Zero users beyond us today.
- Auto-seed from design docs via LLM extraction. Real work; deferred until we have a claim-extraction pipeline shipped.

**What breaks if we revisit**: Nothing; the script is isolated. If we want auto-extraction later, it becomes a separate source that takes design/*.md and produces atoms.

---

## D5: Telegram Notifier is a wrapper, not a replacement (Phase 37)

**Context**: Telegram as an escalation channel on top of the file-queue notifier. Should it REPLACE the file queue, or LAYER over it?

**Decision**: `TelegramNotifier` wraps a base notifier (file or memory). All disposition state lives in the base; Telegram just sends the escalation and translates callback responses back to `base.respond()`.

**Why**: If Telegram is unreachable, core governance must keep working. The base notifier is the source of truth; the channel is a view. This lets us degrade gracefully and compose multiple channels (Telegram + Slack + email) over one base without each channel needing its own state machine.

**Alternatives rejected**:
- Telegram-native notifier with its own state. Would have leaked channel-specific concerns into governance code and made composition painful.
- Channel adapters inside the core `Notifier` interface. Would have bloated the interface for a feature most users won't use.

**What breaks if we revisit**: Additional channels follow the same pattern. If we want a "routes to whichever is online" orchestrator, that's a new wrapper, not a schema change.

---

## D4: Package hygiene enforced at CI, not code review (Phase 27)

**Context**: The repo cannot leak private workspace terms or emdashes into any tracked file. The specific term list is defined in CI and intentionally not echoed here. How do we prevent regressions?

**Decision**: A dedicated CI job (`package-hygiene`) runs `grep` across all tracked files. Fails the build on any match. Term list lives in `.github/workflows/ci.yml` only; never in the guarded files themselves.

**Why**: Human code review misses things. Tests don't catch them. A hard CI gate does.

**Alternatives rejected**:
- Pre-commit hook only. Skippable.
- Lint rule. Harder to maintain across TS + MD + YAML.

**What breaks if we revisit**: Need to keep the term list inside only the CI file, otherwise we grep for ourselves.

---

## D3: Hierarchy-aware source-rank uses injected depth (Phase 34)

**Context**: `sourceRank` is pure (same inputs, same output). Adding principal-hierarchy depth as a tiebreaker required an async `PrincipalStore.get` walk. Either `sourceRank` becomes async or depth is pre-computed.

**Decision**: Keep `sourceRank` pure. The arbiter resolves both atoms' principal depths up-front via `Promise.all([...])` and passes them into `sourceRankDecide` via `SourceRankContext`.

**Why**: Purity makes the scoring function trivially testable and cacheable. Callers that don't need hierarchy (memory-only simulations) pass nothing and get depth-0 defaults.

**Alternatives rejected**:
- Async `sourceRank(atom, host)`. Viral async and hard to cache scores.
- Embed the hierarchy in the Atom at write time. Stale when the principal's `signed_by` changes later.

**What breaks if we revisit**: Callers of `sourceRankDecide` need to supply depths for hierarchy-aware behavior; we default to 0/0 when not provided, which is a documented fallback.

---

## D2: Multi-target canon via resolver, backwards-compatible (Phase 32)

**Context**: `LoopRunner` originally accepted a single `canonTargetPath`. Autonomous-org needs one CLAUDE.md per scope or role. How to add without breaking existing consumers?

**Decision**: New `canonTargets: CanonTarget[]` option on LoopOptions, each target with a scope/principal filter. Legacy `canonTargetPath` still works when `canonTargets` is not set. Mandatory `{ layer: ['L3'] }` filter merged automatically so callers cannot accidentally leak L0 into canon.

**Why**: Existing consumers don't break. New consumers get full expressive power. Forced L3 filter protects against the most common misconfiguration (someone forgets to narrow).

**Alternatives rejected**:
- Breaking change: replace `canonTargetPath` with `canonTargets`. Gratuitous; cost for no benefit.
- Let callers specify the layer filter themselves. Invited bugs.

**What breaks if we revisit**: The two-option surface is a little wider, but the docstring is clear about precedence. When every consumer is on `canonTargets`, we can deprecate `canonTargetPath` gracefully.

---

## D1: The Host is the boundary (Phase 1)

**Context**: Where is the seam between LAG's framework logic and concrete storage / LLM / scheduling?

**Decision**: Eight sub-interfaces bundled in `Host` (AtomStore, CanonStore, LLM, Notifier, Scheduler, Auditor, PrincipalStore, Clock). LAG logic imports `type { Host }`. Adapters implement the interfaces. No exceptions.

**Why**: One-level abstraction that maps 1:1 to capability areas. Testable via conformance suites (one per interface, parameterized across adapters). Swapping a file host for a Postgres host is a new adapter, not a refactor.

**Alternatives rejected**:
- Single `Host` with tight concrete types. Would fight with testability.
- Hexagonal/ports-adapters with deeper layers. Over-structured for what we need; invited ceremony.

**What breaks if we revisit**: Adapter authors implement eight interfaces (conformance specs exist). Adding a ninth capability is a planned event, not a routine extension.
