# LAG: Layered Autonomous Governance

**The governance substrate for autonomous agent organizations. Memory is the foundation.**

A framework for multi-agent systems where memory has to stay true over time, authority has to cascade through a hierarchy, disagreements have to resolve without a human in every write, and humans stay in the loop for anything consequential. Built for **autonomous organizations of agents**, not one-shot chatbots.

> **If RAG brings knowledge into an agent, LAG governs knowledge across agents.** Retrieval makes one agent smarter; governance keeps a hundred agents coherent.

Node 22+. TypeScript. Three host adapters, five operator surfaces (terminal, three daemon modes, hook-attached), three embedders, pluggable session sources, a canon-driven tool-use policy primitive, and an Actor primitive for governed outward-acting agents. **568+ unit tests + 30 gated integration tests** (count grows as open PRs land), GitHub Actions CI on Ubuntu + Windows.

---

## The problem

Once memory lives longer than a single session and spans more than one agent, it rots. Three named failure modes:

1. **Stale decisions.** A decision made last month does not surface this week. Retrieval returns similar text, not the authoritative version. The decision gets re-litigated.
2. **Unmarked reversals.** Someone (user or agent) changed their mind. The old opinion still surfaces three months later, as confidently as the new one, because nothing marked it superseded.
3. **Silent poison.** A hallucination or a write from a compromised agent reinforces itself via later turns ("we established X"). By the time anyone notices, the lineage is tangled and the clean-up is manual.

These are **governance** problems, not retrieval problems. Any vector store can return similar text. The hard part is knowing which memory is still true, who said it, what supersedes what, what to do when two sources disagree, and what to do when one of them turns out to have been compromised.

Current agentic memory systems (MemGPT, Letta, GraphRAG, Anthropic Projects) each solve one slice. None solve the governance problem.

## The solution

LAG treats memory as a governed substrate. Every stored unit is an **atom** with provenance, confidence, layer, principal, and scope. The framework applies six deterministic primitives on top, with a human in the loop as the ultimate arbiter:

- **Layered promotion**: atoms flow upward through four trust tiers (L0 raw, L1 extracted, L2 curated, L3 canon) gated by confidence x consensus x validation thresholds. Promotion creates a new atom at the target layer with `provenance.kind='canon-promoted'` and marks the source superseded. Rollback is a graph operation, not a mutation.
- **Arbitration at write time**: when two atoms conflict, a deterministic rule stack resolves before either reaches retrieval. Source-rank (layer x provenance x **principal hierarchy depth** x confidence) comes first, then temporal-scope, then validator registry, then escalation to a human. Most conflicts never reach a human.
- **Intent governance via Plans**: plans are atoms with `type: 'plan'` and a `plan_state` state machine (proposed → approved → executing → succeeded | failed | abandoned). `validatePlan()` runs a plan's content through the arbitration stack against L3 canon BEFORE execution; conflicts block or escalate. Outcome atoms tagged `derived_from: [plan_id]` preserve lineage from intent to result.
- **HIL causality via Questions**: questions are atoms with `type: 'question'` and a lifecycle (pending → answered | expired | abandoned). `askQuestion()` creates a pending-Q atom; `bindAnswer()` writes the answer as an atom with `derived_from: [question_id]` so every Q-A pair has an audit-grade causal link. Free-form Telegram replies auto-bind to the pending question they reply to, eliminating the "which question did you answer" race.
- **Tool-use policy (the autonomy dial)**: L3 canon atoms carry a `metadata.policy` object that `checkToolPolicy(host, ctx)` matches against every proposed tool call. Match scoring is exact > regex > wildcard per field (tool/origin/principal); highest specificity wins. Decisions are `allow | deny | escalate`. The policy layer sits above Claude Code's permission mode; it is canon-driven, so the autonomy dial is data, not code.
- **Actors for outward effects**: an `Actor` is a governed autonomous loop (observe → classify → propose → apply → reflect, MAPE-K lineage). `runActor` drives it with kill-switch, budget, convergence guard, and per-action policy gating via `checkToolPolicy`. Actors compose with a `Host` (governance primitives) and an actor-scoped set of `ActorAdapter`s (external systems). The Actor / Host split is a deliberate two-seam model (see D17): `Host` stays the governance boundary; `ActorAdapter` is the external-effect boundary.
- **Decay and expiration**: atoms lose confidence on a per-type half-life without reinforcement. Atoms with `expires_at` past now move to `taint='quarantined'`. Stale and expired atoms drop out of retrieval, canon, and promotion automatically.
- **Taint propagation**: when a principal is marked compromised, `propagateCompromiseTaint` walks their atoms and every derived atom across `provenance.derived_from` chains to fixpoint. The canon re-renders without the poisoned subgraph on the next tick.
- **Canon with a human gate**: L3 atoms render into a bracketed section of target `CLAUDE.md` files via `CanonMdManager`. Multi-target canon: one file per scope or role (org-wide, per-project, per-team, per-agent). L3 promotion telegraphs through the `Notifier` for human approval (or auto-approves at higher autonomy levels). Human edits outside the markers are preserved byte-for-byte.

## How it works

### The substrate (what LAG governs)

A single linear pipeline from session sources to rendered canon, with plans feeding intent governance and a human-in-the-loop gate on the L3 boundary.

```mermaid
%%{init: {'flowchart': {'diagramPadding': 40, 'nodeSpacing': 40, 'rankSpacing': 50}}}%%
flowchart LR
  SRC[Session sources] --> L0[L0 raw]
  L0 -->|extract claims| L1[L1 extracted]
  L1 -->|consensus| L2[L2 curated]
  L2 -->|human gate| L3[L3 canon]
  L3 -->|render| MD[CLAUDE.md targets]
  HIL[Human in the loop] -->|approve / reject| L3
  L3 -.escalate.-> HIL
  PLAN[Plans] -.validate vs canon.-> L3
  PLAN -.escalate.-> HIL
```

Around that pipeline, governance primitives run on every loop tick: **arbitrate at write time** (detect > source-rank > temporal > validate > escalate), **promote by consensus + confidence**, **decay + TTL expire**, **taint cascade** on compromise, **validate plan** before execution. Every transition is audit-logged. Nothing is deleted.

### Runtime surfaces (how LAG is driven)

Three daemon modes plus the terminal Claude Code instance all share the same `.lag/` substrate. Pick one per context, or run them concurrently.

```mermaid
%%{init: {'flowchart': {'diagramPadding': 40, 'nodeSpacing': 40, 'rankSpacing': 50}}}%%
flowchart LR
  TERM[Terminal Claude Code] -->|read + write| LAG[(.lag state)]
  WRAP[Wrapper<br/>lag-terminal.mjs<br/>PTY + TG injector] -->|stdin injection| TERM
  D1[Daemon: stateless] -->|spawn claude -p| LAG
  D2[Daemon: resume-shared] -->|claude -p --resume| LAG
  D3[Daemon: queue + hook] -->|write inbox<br/>drain outbox| LAG
  LAG -->|escalations| TG[Telegram]
  TG -.replies.-> LAG
  TG -.inject.-> WRAP
  D3 -.Stop hook inject.-> TERM
  LAG -.roadmap.-> FUT[Slack / email /<br/>session-inject]
```

- **Terminal** for head-down development.
- **Wrapper (`npm run terminal` / `terminal:auto`)** launches Claude Code inside a node-pty with an embedded Telegram long-poller. Incoming TG messages inject directly into the live stdin for real-time bidirectional sessions, no turn-boundary wait. Ideal for "I want my phone to act as me."
- **Stateless daemon** for autonomous-org (each message independent, no context coupling).
- **Resume-shared daemon** for solo dev (daemon appends to your terminal's jsonl; bidirectional).
- **Queue + hook** for "terminal is brain, Telegram is mouth" (the running Claude Code instance answers Telegram via a Stop hook).

Every atom carries an audit-ready provenance chain. Every transition (promote, supersede, taint, expire, approve, reject) is logged. Nothing gets deleted; superseded atoms stay in the store with `superseded_by` set so history is reconstructible.

## Human in the loop

The deterministic rule stack resolves what it can. Everything else telegraphs a human. The `Notifier` interface makes the channel pluggable; at V0 the channel is a file queue and `lag-respond` is the interactive CLI:

```
$ lag-respond --root-dir ~/.lag/state
----------------------------------------------------------------
Handle:       4d8b8aaa76ef...15f
Kind:         proposal
Summary:      Promote seed_postgres to L3
Atom refs:    seed_postgres
Body:
  Candidate content: Use Postgres as the canonical production database.
  Consensus: 3 principals
  Validation: unverifiable
----------------------------------------------------------------
Disposition [a]pprove / [r]eject / [i]gnore / [s]kip / [q]uit: a
Responded: approve.
```

**Telegram ships today as the first non-default channel** (`src/adapters/notifier/telegram.ts`). It wraps a base `FileNotifier`, forwards the same escalation to your phone with an inline keyboard (Approve / Reject / Ignore), and polls `getUpdates` for callback responses. If Telegram is unreachable, the base notifier keeps working; governance degrades gracefully. Wire in ~15 lines:

```ts
import { createFileHost } from 'layered-autonomous-governance/adapters/file';
import { TelegramNotifier } from 'layered-autonomous-governance/adapters/notifier';

const host = await createFileHost({ rootDir: '.lag' });
const telegram = new TelegramNotifier({
  botToken: process.env.TELEGRAM_BOT_TOKEN!,
  chatId: process.env.TELEGRAM_CHAT_ID!,
  base: host.notifier,
  respondAsPrincipal: 'stephen' as PrincipalId,
});
telegram.startPolling(); // poll getUpdates every 2s for responses
// Compose: use `telegram` wherever you'd use `host.notifier`.
```

Remaining on the roadmap: **Slack** (channel + action buttons), **Claude Code session-inject** (pending reviews appear in the next session's context), **email** (daily digest + individual escalations). All ride the same seam as Telegram. The human is the source of truth for anything the deterministic stack cannot decide; the autonomy dial controls how often that happens.

---

## Who this is for

- **An autonomous organization of agents** with persistent roles, shared memory, and governance that runs without a human in every write. Principal hierarchy (via `signed_by`), consensus-based promotion, compromise cascade, and the full audit trail are the primitives. The autonomy dial moves from "human approves every L3" to "human sees only escalations" without rewriting architecture; you move config, not code.
- **A team of agents on a shared codebase**, where two agents will inevitably disagree and neither should silently win.
- **A per-user agent that lives across weeks**, where a session next month should remember decisions from today without the user re-explaining.
- **A long-running autonomous research process**, where one hallucination today becomes tomorrow's "established fact" unless something is checking.
- **A curated knowledge base** (compliance, security reviews, customer memory) where audit and rollback matter as much as retrieval.

If you want a drop-in RAG setup for a chatbot that forgets between sessions, LAG is overkill. Use a plain vector store.

## Applications (concrete shapes)

- **Autonomous agent organization.** Each agent is a principal with a defined role, signed by a parent principal up to a root. Agents operate on shared L1/L2 atoms under scope + layer permissions; consensus across agents promotes atoms upward automatically; L3 changes telegraph per the autonomy dial. Disagreements resolve via the arbitration stack without waking a human unless the stack cannot decide. When a principal is compromised, `lag-compromise` cascades taint across every derived atom and canon re-renders without the poisoned subgraph. The audit log reconstructs every decision for retrospective review.
- **Bootstrapping from an external vector store.** The bridge adapter ingests drawers from an existing [mempalace](https://pypi.org/project/mempalace/)-style ChromaDB store as L1 observations. Your external store stays authoritative for raw vector retrieval; LAG layers governance (promotion, arbitration, canon writing, audit) on top.
- **Cross-session agent memory.** Each session ingests transcripts into L1 as observations; consensus across sessions lifts content to L2; the L3 human gate writes the canonical bits into your project's `CLAUDE.md`. Stale observations decay; reversals supersede. Covered by `examples/quickstart.mjs` at small scale and `test/integration/bridge-live-flow.test.ts` end-to-end.
- **Multi-agent coordination on a monorepo.** Each agent is a principal with its own `permitted_scopes` and `permitted_layers`. Agreements form consensus and promote automatically; disagreements arbitrate; escalations telegraph for operator review via `lag-respond`.
- **Operator incident response.** When a principal is compromised, `lag-compromise --principal <id>` propagates taint across every direct and derived atom and re-renders canon without the poisoned subgraph.

---

## Quick start

```bash
npm install
npm run build
node examples/quickstart.mjs
```

That script spins up a memory-backed Host, seeds three atoms from three principals, searches them, runs a promotion pass to elevate the consensus into the L2 curated layer, and prints the resulting state plus audit log. About 90 user-facing lines.

## Library shape

Two kinds of imports: **top-level** for the everyday governance primitives, **sub-paths** for heavier or opt-in modules so nothing is paid for unless you use it.

Host factories (sub-paths):

```ts
import { createMemoryHost } from 'layered-autonomous-governance/adapters/memory';
import { createFileHost }   from 'layered-autonomous-governance/adapters/file';
import { createBridgeHost } from 'layered-autonomous-governance/adapters/bridge';
import { TelegramNotifier } from 'layered-autonomous-governance/adapters/notifier';
```

Actors and external-system adapters (sub-paths; outward-acting work is opt-in):

```ts
import { runActor } from 'layered-autonomous-governance/actors';
import { PrLandingActor } from 'layered-autonomous-governance/actors/pr-landing';
import { GitHubPrReviewAdapter } from 'layered-autonomous-governance/actors/pr-review';
import { createGhClient } from 'layered-autonomous-governance/external/github';
```

Everyday governance primitives (top-level):

```ts
import {
  LoopRunner, PromotionEngine,
  arbitrate, applyDecision, computePrincipalDepth,
  propagateCompromiseTaint, CanonMdManager,
  checkToolPolicy, askQuestion, bindAnswer,
  validatePlan, executePlan,
  TrigramEmbedder, CachingEmbedder, OnnxMiniLmEmbedder,
} from 'layered-autonomous-governance';
import type { Host, Atom, AtomId, PrincipalId } from 'layered-autonomous-governance';
```

## CLIs and runtime surfaces

Operator commands ship as npm bins:

- `lag-run-loop` - autonomous tick daemon. Walks decay, TTL expiration, L2 promotion, L3 promotion (with human gate), canon file applier.
- `lag-respond` - interactive human-approval prompt. Displays pending notifications; accepts approve/reject/ignore/skip/quit via stdin.
- `lag-compromise` - operator incident response. Marks a principal compromised, propagates taint across direct and derived atoms, prints the affected atom ids and an audit summary.

Runnable scripts (no install):

- `node scripts/bootstrap.mjs` - self-bootstrap. Seeds a curated set of L3 invariants as atoms from a root principal and renders them into `CLAUDE.md`. This repo's own `CLAUDE.md` is produced by this script against LAG's own substrate.
- `node scripts/ingest.mjs --source <kind>:<path>` - compose one or more `SessionSource`s to pre-populate `.lag/` from existing history (Claude Code transcripts today; Obsidian / Git / Slack / ChromaDB on the roadmap).
- `node scripts/daemon.mjs [--queue-only | --resume-session <id> | --resume-latest]` - the Telegram-facing daemon with three runtime modes:
  - default (stateless): each message spawns a fresh `claude -p`; best for autonomous-org setups.
  - `--resume-session <id>` / `--resume-latest`: each message resumes a specific session via claude-cli's `--resume` flag; replies append to the shared jsonl so a terminal Claude Code session sees them on its next turn.
  - `--queue-only`: daemon becomes a pure transport (write inbox, drain outbox). Pair with the `examples/hooks/lag-tg-attached-stop.cjs` Stop hook to have the *running* terminal Claude Code instance answer Telegram directly, bidirectional.
- `node scripts/telegram-whoami.mjs` - helper to discover your Telegram chat id after you message your bot.

All three CLI bins accept `--help`; scripts are documented in their headers.

## Adapters

Two kinds of adapter seam, kept deliberately separate (see DECISIONS.md D1 and D17):

### Host adapters (governance boundary)

Three Host implementations all satisfying the same 8-interface Host contract (AtomStore, CanonStore, LLM, Notifier, Scheduler, Auditor, PrincipalStore, Clock):

- **memory** - in-process, deterministic, zero-dep. Used for tests and quick scripts.
- **file** - JSON files + atomic tmp+rename writes under `rootDir/`. Cross-session: two Host processes at the same rootDir observe each other through the filesystem.
- **bridge** - wraps `file` and adds a Python subprocess bridge to bootstrap an existing ChromaDB-backed vector store as L1 atoms. Composes with a Claude CLI LLM via OAuth (no API key).

Adding a fourth adapter (remote, postgres, custom vector store) is a factory plus six conformance-spec invocations.

### Actor adapters (external-effect boundary)

Actors are outward-acting autonomous loops; the things they touch (GitHub, CI, deploy targets) are `ActorAdapter`s rather than Host sub-interfaces. This keeps Host focused on governance and lets Actor dependencies stay self-declared at the type level. Shipped today:

- **`external/github` -> `GhClient`** - reusable GitHub transport primitive (typed REST + GraphQL over the `gh` CLI). Any Actor that touches GitHub builds on this single client.
- **`actors/pr-review` -> `GitHubPrReviewAdapter`** - full `PrReviewAdapter` implementation (GraphQL review threads, REST reply, GraphQL resolve mutation, first-class dry-run).

## Embedders

Three pluggable embedders behind a single `Embedder` interface:

- **TrigramEmbedder** (default): FNV-hashed character trigrams into 128-dim + L2 normalize + cosine. Zero deps, deterministic, fast. Handles exact / rearranged / synonym / paraphrase / adversarial queries at 0.95+ top-1; collapses to 0.20 on pure-semantic paraphrase.
- **OnnxMiniLmEmbedder**: local `Xenova/all-MiniLM-L6-v2` via `@huggingface/transformers`. 384-dim. Private, offline after first-run model download, MIT license. Lifts hard-paraphrase top-1 from 0.20 to 0.60 (3x).
- **CachingEmbedder**: decorator. Persists vectors to `rootDir/embed-cache/<embedderId>/<sha>.json`. Turns first-query cost from O(N) embeds to O(N) disk reads. Measured 17x speedup on 200 atoms in isolation.

## Principles (settled)

1. **Governance before autonomy.** Build the rules, then tune the knobs. Not reverse.
2. **Provenance on every write.** No atom without a source chain. It pays back everything hard later.
3. **Conflict detection at write time.** Optimal regardless of cost. Nightly batch is always too late.
4. **Skeptical bootstrap.** Trust is earned over sessions, not granted.
5. **Testable via simulation.** Ground-truth oracle, self-play loops. If it cannot self-bootstrap from its own design conversation, it does not work.
6. **Design the kill switch first.** Before the autonomy dial moves.

## Tests + CI

```
npm test                                                                                        # 568+ passed, 30 gated
LAG_SPAWN_TEST=1 LAG_REAL_CLI=1 LAG_REAL_PALACE=1 LAG_BENCH_SCALE=1 LAG_REAL_EMBED=1 npm test   # full matrix
```

Default suite runs in ~10s across the Host interfaces, scenarios s1-s10 (self-bootstrap, decision reversal, promotion, TTL, collusion, compromise, hierarchy, self-bootstrap canon render, plan governance, source composition), arbitration stack (including hierarchy-aware source-rank), promotion engine, plan validation + state machine, loop runner, canon manager (single- and multi-target), taint propagator, session sources, daemon + format conversion, Telegram notifier with mocked fetch, and every adapter's conformance spec. Gated suites need the ONNX model, a ChromaDB Python bridge, subprocess spawns, or a real Claude CLI; they run under env flags.

GitHub Actions CI runs typecheck, build, default test suite, and a quickstart smoke on Node 22 across Ubuntu and Windows for every push and PR to `main`. A separate package-hygiene job verifies no private-term leaks and no emdashes in prose.

## How to read this repo

1. `docs/core-use-case.md` - the narrow V0 target and acceptance criteria.
2. `docs/framework.md` - the overall model (layers, atoms, lifecycle, arbitration, retrieval).
3. `docs/glossary.md` - terminology, one glance.
4. `examples/quickstart.mjs` - a runnable demonstration.
5. `design/target-architecture.md` - the north-star diagram with gap analysis and a leverage-ordered roadmap.
6. `design/host-interface.md` - the 8-interface Host contract every adapter satisfies.
7. `design/actors-and-adapters.md` - the Actor / ActorAdapter shape and the D1-to-D17 boundary-narrowing rationale.
8. `design/prior-art-actor-frameworks.md` - shape survey of LangGraph / CrewAI / Mastra / Autogen / AI SDK / Pydantic AI; where LAG aligns and where it deliberately differs.
9. `design/structural-audit-2026-04.md` - the last principled audit against pluggability, substrate-discipline, and simple-surface goals.
10. `DECISIONS.md` - living log of architectural choices: what we picked, why, and what we rejected.
11. `CLAUDE.md` - rendered canon (L3 atoms from this repo's own `.lag/` state). What future agents on this repo should read first.

## Non-goals (for now)

- Secrets and PII redaction. Deferred until core works.
- Multi-tenant / org-wide scope bleed. Deferred.
- Cross-machine sync. V0 is single-machine; the file adapter's cross-session primitive handles multi-process on the same machine.
- ANN index (HNSW). Linear cosine handles 10K-100K atoms after the cache warms. Revisit past 50K.
- Hosted embeddings API. Local ONNX is architecturally dominant for a self-contained memory system (private, offline, deterministic, no vendor lock).

## Related work worth studying

- MemGPT (Berkeley 2023): core/archival hierarchy.
- Letta: multi-agent shared memory, eventual consistency.
- Microsoft GraphRAG: entity + relation layer.
- Anthropic Projects: low-autonomy baseline.
- Temporal knowledge graph literature: time as first-class relationship.

## License

MIT. See `LICENSE`.
