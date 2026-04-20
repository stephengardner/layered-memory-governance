# Session-Memory Backbone - V0/V1/V2 Plan

_Status: proposed. V0 decisions below are candidates for D-entries and L3 canon once operator-approved._

_Last updated: 2026-04-19_

## Position

LAG's job is to ingest the output of autonomous work, extract governable atoms from it, arbitrate between competing claims, and render the surviving claims as canon that future agents read before they act. The "session-memory backbone" is the pipeline that turns raw agent output (primarily Claude Code session transcripts, also other agent frameworks and conversation artifacts) into governed atoms.

This document locks V0 decisions so the remaining wiring work does not re-litigate settled ground, and lays out V1/V2 affordances so the architecture survives the "3-month-later review without regret" test.

## One-sentence pitch for each consumer tier

- **Solo developer**: "point LAG at your repo, keep working with Claude Code; at session end LAG ingests your transcript, extracts the decisions worth keeping, and updates your `CLAUDE.md` canon so the next session starts smarter."
- **Team / multi-agent setup**: "every agent writes into its own LAG watch; shared canon renders across watches; disagreements escalate to the human operator for arbitration."
- **Organization**: "per-actor watches with scoped principals, federated through a central AtomStore; the CTO actor and equivalents propose canon changes; the operator approves via Telegram / Slack / session-inject."

Same primitives. Same interfaces. Opt-in complexity, opt-out complexity.

## Scope (V0)

In-scope:
1. Watch-location model - one or more named watches, each independent.
2. `ClaudeCodeTranscriptSource` as the default SessionSource, already shipping.
3. `SessionEnd` hook integration so ingestion fires automatically at session boundaries.
4. Extraction pass triggered after ingest (wiring existing `extractClaimsFromAtom`).
5. Budget + worthiness classifier to keep noise manageable.
6. Human-gate via existing Notifier → Telegram for L3 promotion.
7. Per-watch `.lag/` directory; trust isolation by default.
8. Opt-in registry at `~/.config/lag/watches.yaml` (platform equivalents resolved at runtime).

Explicit non-goals for V0:
- Cross-watch federation (V2).
- Streaming tail-follow of live jsonl (V1).
- Source-chain visualizer / importance-timeline projection (V1/V2).
- Claude Agent SDK Sessions API integration (V1).
- BYO-extractor seam beyond "replace the LLM" (V2).

## V0 Architectural Decisions (locked)

### D-mbb-1: Watch-location as primitive

A "watch" is `{path, host, principal_scope, budget, filter, extractor?}`. Each watch runs a LoopRunner independently against its own AtomStore. Watches are composed via the registry; the framework does not assume a single cwd or a single host.

```text
Watch = {
  path: string            // directory being watched
  host: HostConfig        // file:./.lag | file:/abs | bridge:chromadb | byo:<name>
  principal_scope: 'repo-local' | 'cross-project-personal' | 'org:<id>'
  budget_usd_per_day: number
  filter?: { include?: string[]; exclude?: string[] }
  extractor?: 'default' | 'byo:<name>'
}
```

Rationale: autonomous work happens in many places. A developer may edit here, an agent may write in another repo, a CI runner may produce atoms from a third. The watch primitive generalizes over all three without assuming any specific runner.

### D-mbb-2: Opt-in by default, empty default watch set

No directory is watched unless the operator explicitly adds it via `lag watch add <path>`. The initial registry is empty. Privacy floor: LAG never ingests content from a path the operator has not named. This is strict - `~/.claude/projects/` is not a default watch.

Rationale: Claude session directories contain whatever the operator has ever typed. Defaulting to "watch everything" is a trust violation we do not ship.

### D-mbb-3: Per-watch trust isolation

Atoms from Watch A cannot read/write Watch B's atoms. Each watch has its own AtomStore under `<path>/.lag/` (or the configured absolute path). Federation is a V2 opt-in, explicitly composed by the operator via a FederatedHost.

Rationale: a personal side-project must not poison an employer repo's canon. Trust is per-watch until explicitly federated.

### D-mbb-4: Budget per watch, paused on breach

Each watch has `budget_usd_per_day` (default $1.00). Every LLM call the pipeline makes - both the worthiness classifier call (D-mbb-5) and the extraction call - records usd_spent through the adapter's reported usage and accrues to the same per-watch ledger. "Budget" means total LLM spend for the watch, not just extraction. When the daily budget is breached, the watch pauses both the classifier and extraction (but not ingestion - raw L0 atoms still land). Pause emits an Audit event `watch.budget.paused` and optionally notifies the operator via Notifier.

Rationale: classifier cost on high-volume sessions is not negligible (it runs on every L0 atom, not just the worthy ones); separating the two budgets would let a broken classifier silently blow past the extraction cap. A runaway loop without a budget is an outage regardless of which LLM call caused it.

### D-mbb-5: LLM worthiness classification gates extraction

Before the LLM extracts claims from an L0 atom, a cheap classifier decides whether the atom is atom-worthy (decisions, directives, preferences, references, observations) versus operational chatter ("checkout this branch", "run tests"). Worthiness classifier is a separate primitive with its own adapter (`WorthinessClassifier`), default implementation is a small LLM call (or rules-first fallback).

Non-atom-worthy L0 atoms are retained for audit but not extracted into L1 candidates. This is the single biggest noise-reduction decision; without it, daily atom volume makes the canon useless.

Rationale: Anthropic-scale session content has ~3:1 operational-to-substantive ratio. A worthiness gate kills 75% of extraction cost and 75% of canon noise.

### D-mbb-6: SessionEnd hook is the V0 trigger

The primary ingestion trigger is a `SessionEnd` hook that runs `lag ingest --for <cwd> --session <session-id>`. Hook payload carries `transcript_path`, so the hook reads the jsonl directly and emits L0 atoms. Extraction runs after ingest within the same hook invocation, subject to budget.

Rationale: SessionEnd is reliable (fires on clean exit), bounded (one invocation per session), and avoids the noisy per-turn cost of a Stop hook. `PreCompact` is added in V1 as a secondary trigger so long-running sessions still get extracted before their raw content is summarized.

### D-mbb-7: Session lineage carried in provenance

Every atom written by the session-memory pipeline carries:
- `provenance.source.session_id` - the Claude Code session UUID
- `provenance.source.tool` - `claude-code` | `claude-agent-sdk` | `<byo>`
- `provenance.source.file_path` - the transcript path
- `provenance.derived_from` - for L1 extracted atoms, the L0 source ids

This makes the source chain two-hop traversable: `L3 canon → L2 promoted → L1 extracted → L0 ingested → session jsonl on disk`.

Rationale: the north-star dashboard answer "where did this directive come from?" requires lineage at write time. Back-filling is not feasible.

## V0 Components

### Watch registry

`~/.config/lag/watches.yaml` (Linux), `~/Library/Application Support/lag/watches.yaml` (macOS), `%APPDATA%/lag/watches.yaml` (Windows). Resolved by `pathToRegistry()` that respects `XDG_CONFIG_HOME` / platform conventions.

```yaml
version: 1
watches:
 - id: memory-governance
    path: /home/stephen/code/memory-governance
    host:
      kind: file
      dir: ./.lag
    principal_scope: repo-local
    budget_usd_per_day: 1.0
    extractor: default
 - id: personal-cross
    path: ~
    host:
      kind: file
      dir: ~/.lag
    principal_scope: cross-project-personal
    budget_usd_per_day: 0.25
    filter:
      exclude:
 - ~/code/employer/*
```

CLI: `lag watch add <path>`, `lag watch list`, `lag watch remove <id>`, `lag watch pause <id>`, `lag watch resume <id>`.

### SessionEnd hook

Installed under `.claude/hooks/lag-session-end.mjs` (project-scope) or globally (user-scope). The hook:
1. Reads `transcript_path` from stdin JSON.
2. Loads the registry, finds watches matching `cwd`.
3. For each matching watch, calls `lagClient.ingest(watch, transcript_path)`.
4. Triggers extraction pass (budget-gated) for newly ingested L0 atoms.
5. Exits 0 regardless of inner errors - hooks never block sessions. **But** every inner error is appended to `<watch>/.lag/hooks/session-end-errors.jsonl` AND emits an Audit event `hook.session_end.error` with fields `{watch_id, session_id, error_message, timestamp, consecutive_error_count}`. On `consecutive_error_count >= 3` the hook also emits a `Notifier.escalate()` call so the operator learns before their canon silently drifts. The exit-0 is for hook politeness, not for silent failure.

Hook never runs LLM calls inline; ingest is synchronous (file read + atom write), extraction is dispatched to a short-lived worker (`lag extract --for <watch-id>`) so the hook returns fast.

### Worthiness classifier

`src/extraction/worthiness.ts` - new module. Interface:

```ts
interface WorthinessClassifier {
  classify(atom: L0Atom): Promise<{
    worthy: boolean
    reason: string
    suggested_types: Array<'directive'|'decision'|'preference'|'reference'|'observation'>
  }>
}
```

V0 implementation: LLM-backed with a rules-first short-circuit. Rules: conversations shorter than N chars → unworthy; only-tool-results → unworthy; contain imperative language or declarative decisions → worthy-candidate → LLM confirms.

### Budget tracker

`src/extraction/budget.ts` - per-watch daily budget ledger stored at `<watch>/.lag/budget/<yyyy-mm-dd>.json`. Every LLM call records `{usd_spent, model, session_id}`. Gate checks ledger total before each call.

### Claude-session adapter (already shipping)

`src/sources/claude-code.ts` - `ClaudeCodeTranscriptSource.ingest(host, options)` already does this. V0 wires it into the hook trigger. `session_id` in `provenance.source.session_id` is **mandatory**, not optional, for every atom the pipeline emits - the D-mbb-7 lineage contract depends on it. If `ClaudeCodeTranscriptSource` does not currently populate it, the V0 work includes adding it AND a contract test that asserts `typeof atom.provenance.source.session_id === 'string'` for every atom produced by the pipeline. Conditional population was a hedge the design should not carry; make it load-bearing up front so the lineage invariant can't quietly drift.

## V1 Additions

### D-mbb-V1-1: PreCompact hook as secondary trigger

When Claude Code auto-compacts a session that exceeds context, the raw jsonl persists but downstream agents lose the richer signal. A `PreCompact` hook fires ingest+extract on the pre-compaction state so long-running sessions get atoms before summarization.

### D-mbb-V1-2: Claude Agent SDK SessionSource

New `src/sources/claude-agent-sdk.ts` that uses the Agent SDK Sessions API to subscribe to session events in real-time rather than polling jsonl files. Same SessionSource interface; different transport. Operators with long-running managed agents prefer this path.

### D-mbb-V1-3: session-inject Notifier channel

A `SessionInjectNotifier` adapter that turns `Notifier.escalate()` into a `systemMessage` injected into the active Claude Code session (via a running daemon or a hook that writes to the session's input queue). Operator approves L3 atoms without leaving the terminal.

### D-mbb-V1-4: source-chain explorer

A projection tool that reads the AtomStore and renders the derivation graph: given an atom id, show the ancestor chain back to L0 session atoms, and forward to canon renders. CLI: `lag lineage <atom-id>`. Optional TUI for interactive navigation.

### D-mbb-V1-5: BYO SessionSource contract documented

`design/session-source-contract.md` locks the contract: inputs, outputs, error modes, idempotency guarantees, test harness. Reference implementations: `ClaudeCodeTranscriptSource`, `ClaudeAgentSdkSource`, plus one BYO example (e.g., a LettaSource or an OpenAI-Threads source) to prove the seam.

## V2 Additions

### D-mbb-V2-1: Cross-watch federation

A `FederatedHost` composes multiple per-watch AtomStores into a unified read view. Writes stay per-watch (no cross-watch write paths). Consensus across watches becomes a first-class promotion signal. Opt-in, configured explicitly by the operator.

### D-mbb-V2-2: Importance-timeline projection

A periodic snapshot (daily or per-promotion-event) records top-N atom importance rankings. Importance = function of (derived_from in-degree, promotion hits, taint fan-out, reinforcement count). Timeline viz shows rank deltas over time: "atom X was #3 on 2026-04-19, #17 on 2026-05-19 - why?"

No new data required; all signals already in the AtomStore. Adds: snapshot table, render layer, CLI `lag lineage timeline`.

### D-mbb-V2-3: Domain extractors

Pluggable `ExtractionAdapter` registry beyond the default LLM extractor. Regex extractors, classifier-based extractors, domain-specific claim models. Consumer composes at host-build time.

## Risks

1. **Classifier false negatives kill high-value atoms.** Mitigation: worthiness classifier emits a confidence; low-confidence candidates land in a "review queue" rather than being discarded. Operator can promote manually.
2. **Session jsonl schema drift from Claude Code.** Mitigation: `ClaudeCodeTranscriptSource` already does defensive parsing - ignore unknown fields, continue. Add contract tests against a sample corpus of pinned session files.
3. **Budget breached mid-session leaves partial atoms.** Mitigation: extraction is chunked; each L0 atom is extracted independently with transactional write. Budget breach stops the next chunk; already-written atoms are valid.
4. **Privacy escape via filter misconfiguration.** Mitigation: `lag watch add` explicitly prints what is in scope; `lag watch diff <id>` shows content sample before ingestion; CI on the CLI validates the filter shape.
5. **Noisy canon from mid-session atoms.** Mitigation: session-memory atoms land at L1 by default, not L2 or L3. Promotion requires consensus or explicit operator approval. Canon stays clean.

## Consumer tier examples

### Solo developer story (V0)

```bash
npm install -g lag
lag init                               # makes ~/.config/lag/watches.yaml
lag watch add .                        # adds current repo as watch
# Install the SessionEnd hook (one line, opt-in)
lag hooks install session-end
# Keep working with Claude Code normally.
# After each session, L0 atoms arrive; extraction runs; canon updates.
# Approve L3 changes via Telegram (or `lag respond`).
```

10 commands to a working loop. Out-of-the-box default host, default extractor, default Notifier.

### Multi-agent team story (V1)

Each agent runs under its own watch. Agents write to their own `.lag/`. A shared "team-canon" watch (e.g., `/team/.lag/`) aggregates promoted atoms that agents have published. Disagreements escalate through Notifier to the operator.

### Organization story (V2)

Per-actor watches (CTO actor, Planning actor, Pr-landing actor, Deploy actor) with signed-by principals. FederatedHost aggregates for cross-actor consensus. Custom extractors for domain-specific claim shapes. Source-chain explorer for audit. Importance-timeline for retro.

## Alignment with existing canon

- `dev-indie-floor-org-ceiling` (seeded): this design serves both ends explicitly via the consumer tier examples.
- `dev-no-hacks-without-approval` (seeded): the worthiness classifier and budget gate are *right path*, not shortcuts.
- `dev-extreme-rigor-and-research` (existing, amended): research is embedded - the three research passes that produced this plan are cited.
- `dev-rigor-tokens-not-constraint` (seeded): research token spend is never the constraint; the three research passes are budgeted accordingly.
- `dev-substrate-not-prescription`: watch primitive + pluggable adapters, no role names in framework src/.
- `dev-simple-surface-deep-architecture`: 10-command solo-dev story; org-scale deeply composable via the same primitives.
- `inv-kill-switch-first`: `lag watch pause`, `touch .lag/STOP` in the watch directory, and per-watch budget auto-pause are three kill-switch tiers.
- `inv-l3-requires-human`: extracted atoms land L1; promotion to L3 passes through Notifier.

## Next steps

1. Operator approves this design doc (inline review + edits).
2. Proposal atoms written via `scripts/propose-principles.mjs` for the three new directives.
3. Telegram approval flow exercised end-to-end.
4. V0 implementation broken into phases and tasks:
 - P0: `WatchRegistry` module + CLI (`lag watch add|list|remove|pause`)
 - P1: `SessionEnd` hook + `lag ingest --for <watch>` entry point
 - P2: `WorthinessClassifier` primitive + default implementation
 - P3: `BudgetTracker` + extraction gate
 - P4: End-to-end integration test against a sample transcript corpus
5. V1/V2 items land as their own design docs as they come up.

## References

- `src/sources/claude-code.ts` - existing SessionSource.
- `src/extraction/extract.ts` - existing L0 → L1 extraction.
- `src/promotion/engine.ts` - promotion pipeline with L3 human gate.
- `src/loop/runner.ts` - tick runner.
- `src/canon-md/` - canon renderer.
- Research pass 1 (repo audit): ~70% of backbone already built.
- Research pass 2 (prior decisions): D0, D6, D8, D13, D16, D17 relevant.
- Research pass 3 (Claude Code mechanics): hook types, session jsonl format, Agent SDK Sessions API.
