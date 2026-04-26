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

## D19: Auth backend is a consumer choice, not a framework mandate (Phase 58)

**Context**: Phase 58 ships per-role GitHub App identity provisioning. An Actor can now talk to GitHub as its own bot (`<slug>[bot]`) instead of as the operator's PAT. But not every consumer wants that overhead: a single-maintainer project is fine having everything show up under one human user; an autonomous-org deployment wants distinct bot identities for audit. The framework must not force a choice.

**Decision**: Authentication is pluggable at the `Actor` boundary. Every Actor that touches GitHub takes a `GhClient`-shaped object in its constructor (D17: ActorAdapter). Consumers wire one of two implementations:

- **PAT mode**: the existing `createGhClient` (shells out to `gh` CLI using the operator's PAT). Zero setup; PRs, reviews, comments all attributed to the human operator.
- **App-per-role mode**: a `GhClient` adapter over `AppAuthedFetch` (Phase 59). Requires provisioning via `lag-actors sync` once per role. PRs, reviews, comments attributed to `<role-slug>[bot]`.

The Actor code is identical in both modes. Only the client factory changes.

**Why**:
- "Everything must be a bot" is wrong for solo and small-team projects where a single human identity IS the accountability trail.
- "Everything must be the human" loses the whole point of a governance substrate that enables autonomous org shape.
- Pluggability lets the same Actor code graduate with the consumer: start on PAT, adopt role bots when the org grows, without a rewrite.
- Declaring this at the interface level (GhClient stays the seam) means new auth backends (OAuth Apps, GitHub Enterprise SCIM, future identity systems) drop in without touching Actor logic.

**Alternatives rejected**:
- Make Apps the only supported backend. Raises the onboarding floor; a new contributor can no longer just paste a PAT and run.
- Make PAT the only supported backend. Throws away the whole Phase 58 investment; per-role accountability becomes impossible.
- Branch the Actor code (`if (useApp)`): scatters auth concerns through Actor internals; untestable composition.
- Two separate Actor classes (`PrLandingActorPat`, `PrLandingActorApp`): duplicates all behavior for one axis of variation. Violates Actor-is-a-shape-not-a-hierarchy (D16).

**What breaks if we revisit**:
- Removing PAT mode closes the door on zero-setup onboarding and breaks every existing LAG consumer who provisioned against their PAT.
- Removing App mode strands Phase 58's identity infrastructure and forfeits per-role audit.
- Picking one as framework default is fine; removing the other is the breaking change.

**Primary reference**: `src/actors/provisioning/` (App-per-role mechanism); Phase 59 will ship the `GhClient` adapter.

---

## D18: Actor identity is one GitHub App per role, not one App for all (Phase 58)

**Context**: Phase 58 introduces a way for LAG actors to have their own GitHub identity. The question: does the framework provision one umbrella App (`lag-bot`) that all actors share, or does each actor (pr-landing, cto, ceo-force, planner, reviewer) get its own App?

**Decision**: One GitHub App per role. A role declaration in `roles.json` generates exactly one App (one slug, one bot username, one private key, one installation). The credential store is keyed by role name; `PrLandingActor` loads `lag-pr-landing` credentials, `CtoActor` loads `lag-cto`, etc. There is no sharing.

**Why**:
- The bot username (`<slug>[bot]`) is the only identity GitHub surfaces on PRs, reviews, commits, comments. If all actors share one App, they all show up as the same bot and the "who did this" audit trail collapses to a single actor.
- GitHub scopes permissions per App. A role that needs `contents:write` and a role that only needs `pull_requests:read` can each ask for exactly what they need; a shared App has to grant the UNION of all its actors' permissions, which violates least privilege.
- Revocation is surgical: if one actor's key leaks, only that role's identity is compromised; revoke the App, re-provision, other actors continue unaffected. Shared App would force a full rotation on every revocation.
- Future work (LLM-backed CTO approving plans, CEO-force enforcing release windows) expects each role to show up as a distinct identity on timeline events; same-bot muddies that affordance.

**Alternatives rejected**:
- One App, role encoded in commit-author name: commit author is free-text and lies easily; the PR author (App identity) is the ground truth and can't be spoofed. Relying on commit-author for identity is brittle.
- One App, multiple installation-level scopes: GitHub doesn't support per-installation scopes on a single App; all installations inherit the App's declared permission set.
- N Apps auto-multiplexed behind one abstraction ("identity pool"): possible but adds a layer of indirection whose only purpose is to hide the fact that there are N Apps. Better to expose the N-App reality: operators see exactly what bot appears where.

**What breaks if we revisit**:
- Collapsing to one shared App loses per-role accountability AND forces permission-union; both are load-bearing for organizations > 1 actor.
- Role provisioning becomes a one-time cost instead of an ongoing maintenance: worth it for the audit shape we get.

**Primary reference**: `src/actors/provisioning/schema.ts` (RoleRegistry), `src/actors/provisioning/provisioner.ts`.

---

## D17: `ActorAdapter` as a deliberate second seam; D1 scope narrowed to governance (Phase 53-pre)

**Context**: Phase 53 introduces LAG's first outward-acting agents -- Actors that touch systems outside the governance substrate (GitHub, CI, deploys). D1 says the `Host` interface is the sole boundary between framework logic and implementation, but the current 8-sub-interface `Host` has no reasonable slot for arbitrary external systems, and forcing them in (as a 9th `externalSystems` sub-interface or a typed extension registry) turns `Host` into a god object and loses the "Host is a governance boundary" story.

**Decision**: Narrow D1's scope. `Host` is the sole boundary **for governance primitives** (atoms, canon, LLM, notifications, scheduling, audit, principals, time). A new `ActorAdapter` interface is the boundary for external systems that Actors consume. Actors declare their adapter dependencies at the type level; the `runActor` driver gates every external action through `Host.auditor` + `checkToolPolicy` before the adapter executes.

**Why**:
- Preserves D1's intent exactly (no framework code reaches past governance), while honestly acknowledging that governance primitives and external-system adapters are different concerns.
- Keeps `Host` a focused, testable 8-interface contract. Adding GitHub / CI / deploy support never touches `Host`.
- Each Actor's adapter dependencies are visible at the type level; consumers see what an Actor reaches for without spelunking a registry.
- Test story stays clean: stub the Host for governance, stub the adapters for external effects, compose both.
- The gate point where `checkToolPolicy` (52a) lives is inside `runActor`, between `propose` and `apply` -- the exact seam needed for the autonomy dial to actually bite on real external actions.

**Alternatives rejected**:
- Widen `Host` with a 9th `externalSystems` sub-interface: God-object risk; Host has to be constructable knowing every external system the consumer's actors will ever touch. Scales poorly for orgs with many actors.
- Actors instantiate their own adapters directly, bypassing Host: violates D1 in letter and spirit; no canonical gate point for policy or audit.
- Typed extension registry on `Host`: extensible but opaque; documentation and discoverability suffer; still funnels non-governance concerns through Host.

**What breaks if we revisit**:
- Unifying everything back under Host destroys Actor self-declared adapter surface and makes tests harder to compose.
- Dropping the `ActorAdapter` seam entirely (Actors free to instantiate anything) loses the gate point where policy and audit live -- the whole reason the governance substrate exists.

**Primary reference**: `design/actors-and-adapters.md` (this phase).

---

## D16: Two agent classes -- inward governance loops and outward actors (Phase 53-pre)

**Context**: Until Phase 53, every autonomous loop in LAG was inward-facing: `LoopRunner` runs decay + TTL + canon application over our own atom store. With pr-landing, deploy-agents, test-triage, docs-refreshers on the roadmap, LAG now has a second class of loop -- **outward** -- that observes and acts on external systems.

**Decision**: Name the two classes explicitly.
- **Inward Actor**: a governance loop over LAG's own state. `LoopRunner` is the first instance; canon reconciliation and TTL expiration are both inward work. No external adapters required.
- **Outward Actor**: a loop that takes effects on external systems through `ActorAdapter`s. `PrLandingActor` is the first instance. Every action goes through `checkToolPolicy` + audit; the kill-switch halts unconditionally.

Both classes share the `Actor` interface (`observe -> classify -> propose -> apply -> reflect`, per MAPE-K lineage). The direction is a metadata property, not a separate type hierarchy.

**Why**:
- Naming the classes now prevents confusion when a reader sees `LoopRunner` alongside `PrLandingActor` and wonders if they are parallel abstractions (answer: they are the same shape, at different directions).
- The autonomy dial (52a / 52b) applies uniformly to both classes because both go through `runActor`. That's load-bearing.
- V2 will reframe `LoopRunner` as the canonical `InwardActor` implementation, keeping the current class as a thin adapter over the unified primitive; naming the two classes upfront clears the migration path.

**Alternatives rejected**:
- Separate type hierarchies for inward vs outward: premature; they share 100% of the loop shape. Differences are which adapters are plugged in.
- Leave the distinction nameless and let readers figure it out: we have been burned by implicit framework distinctions before (D1 vs actor boundary was the most recent example); naming is cheap.

**What breaks if we revisit**: if we decide outward and inward need different driver semantics (they currently don't), we refactor `runActor` into two drivers with a shared core. Low cost.

**Primary reference**: `design/actors-and-adapters.md` + `design/prior-art-actor-frameworks.md`.

---

## D15: Terminal wrapper (Phase 51a) as the preferred real-time surface, not OS-level stdin injection

**Context**: To give a running Claude Code terminal real-time Telegram reception (no turn-boundary wait), we needed some layer that owns the child's stdin. Two options were on the table:
1. **Wrapper launcher** (shipped as `scripts/lag-terminal.mjs`): spawns `claude` as a node-pty child, wrapper owns the PTY master, Telegram poller injects into it.
2. **OS-level stdin injection** into an already-running `claude` process (Windows `WriteConsoleInput` / Unix `ioctl(TIOCSTI)`).

**Decision**: Ship option 1. Treat the wrapper as a first-class runtime surface composable with the other runtime modes (terminal, three daemon modes, hook-attached).

**Why**:
- One implementation vs three platform-specific ones; the wrapper behaves identically on Windows, macOS, Linux.
- Single terminal emulator variance: the wrapper owns the PTY, so iTerm/Alacritty/Windows Terminal/tmux quirks are irrelevant.
- No ambiguity about *which* `claude` instance is targeted (wrapper spawns its own child).
- Invisible keystroke injection into an existing terminal is harder to reason about as a framework primitive; an explicit wrapper matches the "pluggable, auditable" discipline.
- Mid-stream user typing can't collide with injection -- wrapper sequences both streams into the PTY.

**Alternatives considered**:
- OS-level injection: wow-factor for the user who doesn't want to relaunch, but the trade-off dominates against a framework shipping to other developers.
- Agent SDK service (Phase 44): long-term better answer for true push-to-running-process; blocked on zod v3 → v4 migration (Phase 44a). Complements rather than replaces the wrapper; both will ship.

**What breaks if we revisit**: very little. The wrapper is an opt-in script; disabling is a non-launch. OS-level injection could layer in later as a second "attach-to-running" path for the specific "I can't relaunch" scenario; it would NOT replace the wrapper.

---

## D14: HIL causality -- question atoms + reply-to + sent-log, layered (Phase 50a/b/b-live)

**Context**: The Notifier's handle-based escalation path (`telegraph` -> disposition via handle) already gives Q-A causal binding for *structured* governance events. But free-form Telegram chat had no such binding: a "Yes" reply bound only to "the most recent question I sent," which races catastrophically under network delay (imagine the operator answers an older question while a newer question is already on the wire).

**Decision**: Three layered primitives, all opt-in:
1. **Phase 50a signals**: daemon records `tgMessageId` + `tgDate` on inbound, writes `sent-log.jsonl` for outbound with `message_id` + `sentAt`. Stop hook emits a *Causality context* block into the systemMessage -- explicit reply-to match when the operator swipes-to-reply, TEMPORAL WARNING when an inbound is older than the most recent outbound.
2. **Phase 50b primitive**: `type: 'question'` atom with a `pending | answered | expired | abandoned` state machine. `askQuestion`, `bindAnswer`, `listPendingQuestions`, `expirePastDueQuestions`. Answer atoms carry `provenance.derived_from = [questionId]`.
3. **Phase 50b-live wiring**: `scripts/tg-ask.mjs` creates a question atom AND queues an outbox message tagged with `questionId`. Daemon's `drainOutbox` captures the Telegram-assigned `message_id` back onto the question's metadata. On an inbound with `reply_to_message.message_id`, daemon looks up `sent-log.jsonl` for a matching `questionId` and calls `bindAnswer` automatically. Hook annotates with "AUTO-BOUND".

**Why layered**: signals alone are insufficient (timestamps don't bind across concurrent pending questions). Primitive alone is insufficient (agent has to remember to bind manually). Wiring closes the loop: the operator swipes-to-reply and the Q-A chain is captured automatically with full provenance.

**Alternatives considered**:
- **Timestamp heuristic only** (ship what 50a already provides; drop 50b): simple, but fails on concurrent questions -- can't tell which one a "Yes" answers.
- **LLM disambiguator first** (Phase 50c before 50b-live): works when explicit reply-to is missing, but adds an LLM call on the hot path. Deferred; reply-to covers the common case.
- **Force every HIL exchange through the Notifier handle path**: rejected because free-form chat is a first-class modality now (mirror-all, tg-ask, wrapper injection) and shouldn't require structured-event envelope.

**What breaks if we revisit**: Phase 50c adds an LLM classifier for ambiguous inbounds (no reply-to + multiple pending questions + timestamps don't decide). That layers on top of 50a/b without changing them.

---

## D13: Telegram-as-operator, tools auto-fire on TG-originated prompts (current trade-off)

**Context**: The LAG terminal wrapper (Phase 51a) injects incoming Telegram messages directly into the Claude Code child's stdin. When the child is launched with `--permission-mode auto` (standard Claude Code flag), it auto-approves tool execution. So a Telegram message from the operator can trigger Bash / Edit / Write / etc on the host machine without a second confirmation.

**Decision (current)**: Accept this behavior. Treat Telegram-authenticated messages as operator-authored, equivalent to operator typing in the terminal. The `npm run terminal:auto` script makes this mode explicit and opt-in.

**Why (today)**:
- The bot token + chat id pair in `.env` is already a delegated operator credential. Anyone who can send messages IS the operator by our current threat model.
- Asking for double-confirmation on every TG message would defeat the purpose of the remote runtime ("operate in perpetuity from Telegram").
- The wrapper is explicitly opt-in (user has to launch via the script); autonomous-org setups that want stricter gating simply do not use auto mode.

**Alternatives considered (not shipped today)**:
- **LAG autonomy dial** layered above Claude Code's permission mode: canon atom asserts "TG-originated prompts require L3 validation before tool execution." Wrapper enforces it by intercepting the injected prompt and running `validatePlan` before forwarding. Correct long-term; adds latency + scope today.
- **Per-tool auth**: some tools (Bash, Write) gated, others (Read, Grep) auto. Middle ground; requires tool-aware interception.
- **Double-confirm via TG inline keyboard**: before running a tool call triggered by a TG prompt, bot asks "approve?" back via Telegram. Safest; breaks perpetual-session ergonomics.

**What breaks if we revisit**:
- If the bot token or chat id leaks, the attacker can auto-run arbitrary code on the host.
- Revisiting likely adds a LAG autonomy dial (canon-driven) and interception at the wrapper layer, without changing the wrapper's external shape.

**Revisit trigger**: first time a second operator joins (multi-user setup), or first time the wrapper is used on a shared / non-personal machine, or first security incident. Until then, document-and-ship.

---

## D12: This repo is its own first LAG-governed organization

**Context**: While building LAG, we realized our collaboration (one human operator + one AI agent, occasionally calling in subagents or daemons) is itself a small autonomous-org instance operating on LAG's own primitives. The repo is simultaneously the product, the reference implementation, and the lived case study.

**Decision**: Treat the repo's development as a first-class LAG deployment. Concretely:

1. Bootstrap models the real principal hierarchy: `apex-agent` (role=apex, signed_by=null, root) and `claude-agent` (role=agent, signed_by=apex-agent). Hierarchy-aware source-rank (Phase 34) now means operator decisions outrank agent decisions at equal layer/provenance.
2. The daemon's `principalResolver` maps Telegram `from.id` to `apex-agent` for the configured operator chat. Future multi-user setups expand the map.
3. Generated `CLAUDE.md` canon, DECISIONS.md, and commit history are the substrate LAG governs, not just static docs about LAG.
4. Every non-trivial choice gets a DECISIONS.md entry with rationale and rejected alternatives so the trajectory is legible to future readers, including future autonomous agents.

**Why**: The point of LAG is to govern the kind of work we're doing right now. If we build a framework that we ourselves would not use to govern our work, the framework has a blind spot. Forcing ourselves to eat our own dogfood catches that gap. And doing it in public, with history intact, means the repo's commit log + DECISIONS.md + canon becomes a reference a new user can scan to see how LAG decisions actually get made over time.

**Alternatives rejected**:
- Keep `lag-self` as a single placeholder principal. Simpler, but hides the hierarchy story that differentiates LAG from a flat vector store.
- Don't model the operator as a first-class principal. Fine for a demo; wrong for the autonomous-org north star.
- Rely on comments and docs to convey "this repo is self-governed". Words are cheap; the principal file and the atoms in `.lag/` are cheap talk's opposite.

**What breaks if we revisit**: Adding multi-user multi-agent principals later (e.g. multiple humans, multiple agents) expands the resolver and the bootstrap, but the hierarchy and source-rank already accommodate it. No data migration for this 2-principal shape since `.lag/` is gitignored and regenerable.

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

> **Scope narrowed by D17 (Phase 53-pre).** `Host` is the sole boundary for **governance primitives**. External-system adapters (GitHub, CI, deploy targets) live behind a second, actor-scoped seam called `ActorAdapter`. Read this entry with D17 in hand.

**Context**: Where is the seam between LAG's framework logic and concrete storage / LLM / scheduling?

**Decision**: Eight sub-interfaces bundled in `Host` (AtomStore, CanonStore, LLM, Notifier, Scheduler, Auditor, PrincipalStore, Clock). LAG logic imports `type { Host }`. Adapters implement the interfaces. No exceptions **within governance**; external-effect adapters flow through `ActorAdapter` per D17.

**Why**: One-level abstraction that maps 1:1 to capability areas. Testable via conformance suites (one per interface, parameterized across adapters). Swapping a file host for a Postgres host is a new adapter, not a refactor.

**Alternatives rejected**:
- Single `Host` with tight concrete types. Would fight with testability.
- Hexagonal/ports-adapters with deeper layers. Over-structured for what we need; invited ceremony.

**What breaks if we revisit**: Adapter authors implement eight interfaces (conformance specs exist). Adding a ninth capability is a planned event, not a routine extension.
