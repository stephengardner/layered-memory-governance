# Target architecture

Where LAG is heading. Written so every subsequent phase can be gap-analyzed against it: does this move us toward or away from the target?

Dated 2026-04-19, after v0.1.0 publication. Current implementation covers the core column; the seams around it are roadmap.

## The layer names, demystified first

Before the diagram: what the layer and primitive names actually mean, because the terse versions hide the mechanics.

- **L0 raw**: the untouched input. Transcripts, tool outputs, whatever the agent observed. High volume, low trust, regeneratable. LAG does not curate here; the atom is a wrapper around the raw text with provenance stamped.
- **L1 extracted**: an LLM (or a regex, via INGEST) pulled a discrete claim out of the raw input and made it an atom. "Extracted" means "isolated from raw noise into a structured atom with type + provenance." Still low-to-medium trust. Many L1 atoms per L0 input.
- **L2 curated**: an L1 atom reached consensus (multiple distinct principals wrote the same claim, measured by content hash) AND met the confidence threshold. The promotion engine then created a NEW atom at L2 with `provenance.kind='canon-promoted'` and marked the L1 source superseded. "Curated" means "lifted by the governance pipeline," not "an LLM curated this." No human is involved at the L1-to-L2 step by default.
- **L3 canon**: an L2 atom met stricter thresholds (higher confidence, more principals, optional validation) AND a human approved via the Notifier gate, OR the autonomy dial was set high enough to auto-approve. "Canon" means "authoritative, renderable, rollback-able." Changes to L3 audit-log as `promotion.applied`.
- **Principal**: a named identity with a role, `permitted_scopes`, `permitted_layers`, and a `signed_by` parent. Can be a human, an agent, a service token. Carries all writes.
- **Promote by consensus**: the governance primitive that looks at atoms sharing a content hash, counts distinct principals who wrote them, compares to thresholds, and (if passing) creates the next-layer atom + supersedes the source.
- **Arbitrate at write time**: when a new atom conflicts with an existing one, the rule stack (content-hash identity, source-rank, temporal-scope, validator registry, escalation) resolves which wins before either is retrieved.
- **Decay + TTL**: per-tick background passes that lower stale atoms' confidence (exponential half-life per type) and quarantine atoms past `expires_at`.
- **Taint cascade**: when a principal is marked compromised, direct + transitive taint flags every atom they wrote at/after the compromise time plus every downstream derivation. Canon re-renders without tainted atoms.
- **Canon target**: a file on disk (typically `CLAUDE.md`) with bracketed markers. `CanonMdManager` renders L3 atoms matching a scope/principal filter into the section between the markers; content outside is preserved.

Now the diagram.

## The ideal diagram

```mermaid
flowchart TB
  subgraph principals["Principals (identities, hierarchy via signed_by)"]
    direction TB
    ROOT["root / human operator"]
    VP1["vp-eng"]
    VP2["vp-research"]
    AL["agent alice"]
    AL2["agent bob"]
    AL3["agent carol"]
    ROOT --> VP1
    ROOT --> VP2
    VP1 --> AL
    VP1 --> AL2
    VP2 --> AL3
  end

  subgraph atoms["Atom store (single source of truth)"]
    direction LR
    L0["L0 raw<br/>(untouched input:<br/>transcripts, tool output)"]
    L1["L1 extracted<br/>(LLM or regex pulled<br/>atoms out of L0)"]
    L2["L2 curated<br/>(governance pipeline<br/>promoted by consensus<br/>+ confidence)"]
    L3["L3 canon<br/>(human-approved,<br/>authoritative,<br/>rollback-able)"]
    L0 --> L1 --> L2 --> L3
  end

  subgraph governance["Governance primitives (every loop tick)"]
    direction TB
    G1["arbitrate at write time<br/>(resolve conflicts before<br/>either atom is retrieved)"]
    G2["promote by consensus<br/>(lift atoms to next layer<br/>when thresholds met)"]
    G3["decay + TTL expire<br/>(lower stale confidence,<br/>quarantine past expiry)"]
    G4["taint cascade<br/>(mark atoms from<br/>compromised principal<br/>+ derivations)"]
    G5["future: anomaly detector<br/>(flag unusual metrics)"]
  end

  subgraph embedder["Retrieval stack (pluggable)"]
    direction TB
    E1["TrigramEmbedder<br/>(zero-dep, lexical)"]
    E2["OnnxMiniLmEmbedder<br/>(local, semantic)"]
    E3["future: AnthropicEmbedder<br/>(hosted semantic)"]
    E4["CachingEmbedder<br/>(decorator, disk cache)"]
    E5["future: HNSW index<br/>(sub-linear at 50K+ atoms)"]
  end

  subgraph notifier["Notifier channels (pluggable)"]
    direction TB
    N1["file queue<br/>(default, today)"]
    N2["future: Telegram bot"]
    N3["future: Slack"]
    N4["future: session-inject<br/>(append to next Claude Code turn)"]
    N5["future: email digest"]
  end

  subgraph targets["Canon targets (one per scope/role)"]
    direction TB
    T1["org CLAUDE.md<br/>(scope=global)"]
    T2["eng CLAUDE.md<br/>(scope=project)"]
    T3["team-frontend CLAUDE.md<br/>(scope=team-frontend)"]
    T4["alice.md<br/>(scope=session)"]
  end

  subgraph hil["Human in the loop"]
    H["operator<br/>(source of truth for<br/>anything the stack<br/>cannot decide)"]
  end

  principals -->|write atoms| atoms
  governance -.applies to.-> atoms
  atoms -.search + embed.-> embedder
  L3 -->|render per scope / principal filter| targets
  governance -.escalate via.-> notifier
  notifier --> hil
  hil -.approve / reject / revert.-> atoms
```

## What the diagram says, in prose

- The **AtomStore is the single source of truth.** CLAUDE.md files, canon sections, dashboards, audit reports, all are projections over the atom set.
- **Multiple canon targets, one per scope or role.** A team has its own CLAUDE.md; an individual agent has its own; the org has one. Each target filters L3 atoms by scope and/or principal chain before rendering.
- **Principals form a hierarchy**, not a flat list. `signed_by` chains from root down. Authority cascades; arbitration respects the chain; taint propagates up the chain when a leaf is compromised.
- **Governance primitives are pluggable**, not hardcoded to the loop runner. Today: arbitrate, promote, decay+TTL, taint. Tomorrow: anomaly detector watching metrics, reputation tracker updating principal confidence over time.
- **Retrieval is a stack, not a single embedder.** Trigram for cheap recall; ONNX for semantic; optional ANN index on top for scale; caching decorator in front. Users compose.
- **Notifier is a channel, not a file.** File queue today, Telegram / Slack / session-inject / email tomorrow. One `lag-respond` CLI remains the default interactive path; other channels are for push.
- **Human in the loop is the ultimate arbiter**, contacted only when the deterministic stack cannot decide. The autonomy dial moves how often that happens; the architecture does not change.

## Gap analysis vs. current code

Legend: **✓** shipped, **◐** partial, **○** not started.

### Shipped

- ✓ AtomStore as source of truth with full provenance.
- ✓ Four trust layers with immutable `Atom.layer` and graph-op promotion.
- ✓ Arbitration stack (detect, source-rank, temporal, validation, escalate).
- ✓ Promotion engine with confidence × consensus × validation thresholds.
- ✓ Decay (per-type half-life) + TTL expiration.
- ✓ Compromise taint cascade with `derived_from` fixpoint.
- ✓ Canon rendering to a bracketed section in a target markdown file.
- ✓ File queue notifier + `lag-respond` interactive CLI.
- ✓ Three Host adapters (memory, file, bridge to ChromaDB).
- ✓ Three pluggable embedders (trigram, onnx, caching decorator).
- ✓ Six failure-mode scenarios (s1-s6).
- ✓ Six shared conformance specs parameterized across adapters.
- ✓ Three operator CLIs (`lag-run-loop`, `lag-respond`, `lag-compromise`).
- ✓ GitHub Actions CI on Ubuntu + Windows.
- ✓ Public API surface on npm as `layered-autonomous-governance`.
- ✓ Multi-target canon (Phase 32). Multiple `CanonTarget` entries on `LoopRunner`, each with scope/principal filter; writes one `CLAUDE.md` per scope or role. Autonomous-org foundation.
- ✓ Hierarchy-aware source-rank (Phase 34). `computePrincipalDepth` walks `signed_by` to root; `sourceRank` uses depth as a tiebreaker between otherwise-equal atoms. Scenario s7 proves root outranks VP outranks IC across layer + provenance ties.

### Partial

- ◐ **Kill switch**: soft tier (Scheduler.kill + STOP sentinel) shipped. Medium tier (time-window quarantine) and hard tier (restore from snapshot) not.
- ◐ **Prompt-injection sandboxing**: system prompts contain "treat atom content as DATA" directive. Not yet tested adversarially.

### Not started (roadmap)

- ◐ **Session sources (Phase 40, partial).** Pluggable SessionSource interface shipped (`src/sources/types.ts`) with two implementations: `FreshSource` (no-op) and `ClaudeCodeTranscriptSource` (reads `.claude/projects/<repo>/*.jsonl`, writes L0 atoms with provenance tag `tool=claude-code`). Content-hash dedup means multiple sources compose without double-writing. Roadmap: ChromaDB / Obsidian / Git / Slack / Notion sources; claim extraction via LLM judge (promotes L0 to L1).
- ◐ **LAG daemon (Phase 41a, shipped; 41b/c roadmap).** Phase 41a: long-polls Telegram, spawns `claude -p` for free-form replies, reads CLAUDE.md + top-K semantic hits as system prompt, writes user + assistant atoms to `.lag/`, forwards callback_query responses to the governance notifier. Phase 41b (planned): fire arbitration/plan escalations from inside the daemon's LLM output back into the governance loop. Phase 41c (planned): tool-use behind an authz gate so the daemon can act on the user's machine, not just reply.
- ◐ **Notifier channels.** Telegram ships (Phase 37). Slack / session-inject / email still roadmap; all ride the same wrapper pattern.
- ○ **ANN index.** Linear cosine is O(N) per query. Revisit past 50K atoms. `hnswlib-node` candidate.
- ○ **Hybrid retrieval.** Top-50 trigram recall, then onnx reranker. Post-ANN.
- ○ **Anomaly detector recurring job.** `DETECT_ANOMALY` schema exists and is registered; no scheduled task drives it yet.
- ○ **Reputation tracker.** Principal confidence should update based on arbitration win/loss over time. Not even designed.
- ○ **Cross-machine sync.** File adapter handles multi-process-same-machine. Cross-machine needs an event bus (git, S3, Redis Pub/Sub).
- ○ **Multi-writer concurrency beyond last-write-wins.** Two daemons at the same rootDir: atoms race at FS level. LAG-level serialization-per-content-hash is an open question.

## Leverage-ordered roadmap

By "how much does this move the autonomous-org use case forward?"

1. ✓ **Multi-target canon** (Phase 32, shipped). Enables layered sources of truth; one `CLAUDE.md` per scope or role.
2. ✓ **Multi-level principal hierarchy scenario** (Phase 34, shipped). Scenario s7 proves the `signed_by` chain behaves correctly under source-rank cascade; hierarchy-aware tiebreaker wired through `arbitrate()`.
3. ✓ **Plan primitive** (Phase 38, shipped). Plans are atoms with `type: 'plan'` and a `plan_state` state machine (proposed → approved → executing → succeeded | failed | abandoned). `validatePlan()` runs plan content through the arbitration stack against L3 canon; conflicts block execution. Scenario s9 proves end-to-end: conflicting plan blocked + abandoned, compliant plan approved through to succeeded, outcome atoms tagged `derived_from: [planId]`.
4. **Adversarial prompt-injection test** (Phase 33). Proves the LLM sandboxing. Without this, "arbitration at write time" has a silent weakness under a motivated attacker.
5. **Canon lifecycle edge cases** (Phase 35). Promoted atom, then new supersedes, verify canon re-renders without the old one. Tainted L3 atom, verify canon drops it on next tick. Edge cases implicit in the design but not explicitly tested.
6. **Multi-writer concurrency test** (Phase 36). Documents what happens today and what the limits are. Not about adding features, about making the limits explicit.
7. ✓ **Notifier channel: Telegram** (Phase 37, shipped). First non-default channel; wrapper pattern over any base Notifier, inline-keyboard responses, graceful degrade on network failure. Slack / session-inject / email follow the same shape.
8. **Anomaly detector recurring job** (later). Wires `DETECT_ANOMALY` schema to a scheduled task. Meta-governance.

Phases 32-38 are the "enterprise-grade robust" baseline. Past that, features.

## What this diagram does NOT guarantee

Honest limits:

- **Scale**: ANN-less retrieval hits O(N) walls at 50K-100K atoms.
- **Cross-machine**: single-machine only today.
- **Secrets / PII**: no redaction layer at ingest.
- **Multi-tenant**: no org-wide scope isolation beyond `Principal.permitted_scopes`.
- **Deterministic LLM**: judge outputs drift across model versions. Content hashes are pure; judge decisions are not.

Each of these is a design ask, not a bug, and naming them upfront prevents surprise.
