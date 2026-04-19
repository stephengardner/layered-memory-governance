# Host Interface

The boundary between LAG (framework logic) and any concrete implementation (stores, LLM providers, notification channels, schedulers, filesystem / git / MCP). LAG never reaches around this interface. Below the line is host. Above is logic. Adapters implement the interface; they do not implement LAG itself.

## Why this matters

Without a defined boundary, LAG becomes a product bound to its first implementation (the external ChromaDB store + chroma + claude CLI + git on Windows). A framework must be able to run unchanged on a different substrate: plain JSON + filesystem, SQLite + FAISS, Postgres + pgvector, Neo4j, GPT instead of Claude, email instead of Slack for notifications, cron instead of the Claude Code /loop skill. The interface is how you enforce that independence.

It also gives us a unit-test surface. Every adapter gets run through the same conformance suite. If it passes, LAG works on top of it. If LAG breaks on a new adapter, the bug is in the adapter, not LAG.

## Design principles

1. **Minimal**: each method is atomic and single-purpose. Composition happens above the line.
2. **Complete**: LAG never has to reach into a specific adapter's guts. Everything expressible through the interface.
3. **Typed**: first-class types for Atom, Principal, Diff, Proposal. No stringly-typed dicts.
4. **Async-aware**: LLM, Notifier, Scheduler are inherently async. Others may be sync.
5. **Transactional** where correctness demands it (promotions specifically).
6. **Testable in isolation**: every method has a conformance scenario. Adapters self-certify by passing the suite.
7. **Versionable**: interface evolves through numbered versions; old adapters keep working via shims.

## Types

### Scalars and identifiers

```
Time              = ISO-8601 string, UTC, millisecond precision
AtomId            = str, content-derived hash (sha256 of content + type + principal_id, first 32 hex)
PrincipalId       = str, opaque stable identifier
ProposalId        = str
CommitRef         = str (git SHA or equivalent)
AuditId           = str
NotificationHandle = str
RegistrationId    = str
Vector            = float[]
Disposition       = "approve" | "reject" | "ignore" | "timeout" | "pending"
Severity          = "info" | "warn" | "critical"
TaintState        = "clean" | "tainted" | "quarantined"
Layer             = "L0" | "L1" | "L2" | "L3"
Scope             = "session" | "project" | "user" | "global"
```

### Atom

```
Atom {
  schema_version       int                            # for schema migration
  id                   AtomId
  content              str                            # the claim itself
  type                 "directive" | "observation" | "decision" | "preference" | "reference" | "ephemeral"
  layer                Layer
  provenance {
    kind               "user-directive" | "agent-observed" | "agent-inferred" | "llm-refined" | "canon-promoted"
    source             { session_id, agent_id?, tool?, file_path? }
    derived_from       AtomId[]                       # parent atoms this was synthesized from
  }
  confidence           float                          # 0.0..1.0
  created_at           Time
  last_reinforced_at   Time
  expires_at           Time?
  supersedes           AtomId[]
  superseded_by        AtomId[]
  scope                Scope
  signals {
    agrees_with        AtomId[]
    conflicts_with     AtomId[]
    validation_status  "verified" | "unchecked" | "stale" | "invalid"
    last_validated_at  Time?
  }
  principal_id         PrincipalId
  taint                TaintState
  metadata             dict                           # extensible, not used by core LAG logic
}
```

### Principal

```
Principal {
  id                 PrincipalId
  name               str
  role               str
  permitted_scopes {
    read             Scope[]
    write            Scope[]
  }
  permitted_layers {
    read             Layer[]
    write            Layer[]
  }
  goals              str[]
  constraints        str[]
  active             bool
  compromised_at     Time?                            # if set, principal is compromised from this time
  signed_by          PrincipalId?                     # principal hierarchy; null for root (user)
  created_at         Time
}
```

### Diff

```
Diff {
  path               str                              # file or canon section selector
  before             str                              # full before text (for review)
  after              str                              # full after text (for review)
  reason             str                              # why this change
}
```

### Proposal

```
Proposal {
  id                 ProposalId
  atom_id            AtomId                           # the atom whose promotion this proposal represents
  diff               Diff
  principal_id       PrincipalId
  rationale          str
  created_at         Time
  timeout_at         Time
  default_disposition Disposition                     # what happens on timeout
  status             "pending" | Disposition
  approver_id        PrincipalId?                     # null until resolved
}
```

### Filters and patches

```
AtomFilter {
  ids?               AtomId[]
  layer?             Layer[]
  type?              str[]
  scope?             Scope[]
  principal_id?      PrincipalId[]
  taint?             TaintState[]
  created_before?    Time
  created_after?     Time
  min_confidence?    float
  max_confidence?    float
  superseded?        bool                             # include superseded atoms in result
}

AtomPatch {
  confidence?        float
  last_reinforced_at? Time
  expires_at?        Time
  supersedes?        AtomId[]                         # append
  superseded_by?     AtomId[]                         # append
  signals.*          any                              # patch signal fields
  taint?             TaintState
  metadata?          dict                             # merge
}
```

## Interface groups

### AtomStore

Core atom persistence. Responsible for: storage, indexing, embedding, similarity, content hashing. Not responsible for: LAG logic (reinforcement decisions, arbitration, promotion).

```
put(atom: Atom) -> AtomId
  # Insert new atom. If atom.id already exists, raise ConflictError.
  # Called during INGEST and PROMOTE.

get(id: AtomId) -> Atom | None
  # Retrieve by id. None if not present.

query(filter: AtomFilter, limit: int, cursor?: str) -> (Atom[], next_cursor: str?)
  # Metadata-filtered retrieval. Paginated. Order: created_at desc by default.

search(query: str | Vector, k: int, filter?: AtomFilter) -> [(Atom, score: float)]
  # Semantic search. Optionally filtered. Returns top-k by similarity.
  # Scores are implementation-specific but normalized to [0, 1] where 1 is best.

update(id: AtomId, patch: AtomPatch) -> Atom
  # Apply patch, return updated atom. Patch operations are defined above.
  # Content field is IMMUTABLE: to change content, write new atom + supersede.

batch_update(filter: AtomFilter, patch: AtomPatch) -> count: int
  # Bulk update. Used for taint propagation, decay sweeps.

embed(text: str) -> Vector
  # Compute embedding. Model is adapter-determined.
  # Conformance test: embed(same_text) is deterministic within a single adapter version.

similarity(a: Vector, b: Vector) -> float
  # Cosine similarity by default. Adapter may offer others via metadata, but cosine is the spec.

content_hash(text: str) -> str
  # Normalized hash for deterministic matching.
  # Normalization: lowercase, collapse whitespace, strip non-semantic punctuation.
  # Conformance test: content_hash("Use Postgres.") == content_hash("use postgres")
  # BUT: content_hash("use Postgres") != content_hash("use MySQL")
```

### CanonStore

Responsible for: reading canonical state, proposing changes, committing approved proposals, reverting on taint. Not responsible for: deciding whether to commit (that's LAG's governance layer).

```
read(selector?: str) -> str
  # Read canon. Selector is optional, e.g. a bracketed section id.
  # Without selector, returns full canon.

propose(diff: Diff, principal_id: PrincipalId, rationale: str) -> ProposalId
  # Create a proposal. Does NOT commit. Proposal enters a pending state.
  # Must be idempotent: identical diff+principal+rationale returns existing ProposalId.

commit(proposal_id: ProposalId, approver_id: PrincipalId) -> CommitRef
  # Apply a proposal. Returns a commit reference for rollback.
  # Only callable after proposal status is "approve".
  # Must update canon atomically.

revert(commit_ref: CommitRef, reason: str, principal_id: PrincipalId) -> CommitRef
  # Reverse a commit. Returns the new commit ref (the revert itself is a commit).

history(path_filter?: str, limit?: int) -> Commit[]
  # Canon change history. For audit and taint cascade.

Commit {
  ref            CommitRef
  diff           Diff
  principal_id   PrincipalId
  approver_id    PrincipalId
  committed_at   Time
  reason         str
}
```

### LLM

Every LLM call in LAG goes through this single primitive. Specialization happens via different schemas (classify, extract, compare, summarize, propose-diff). The judge is sandboxed: atom content is always rendered as DATA, never as PROMPT.

```
judge(schema: JsonSchema, system: str, data: dict, options?: LlmOptions) -> JudgeResult

LlmOptions {
  model              str                              # e.g. "claude-haiku-4-5"
  temperature        float                            # default 0.0 for determinism
  max_tokens         int
  timeout_ms         int
  seed?              int                              # if adapter supports
  max_budget_usd     float                            # hard cap per call
  sandboxed          bool                             # default true: no tool access, isolated context
}

JudgeResult {
  output             dict                             # parsed per schema; validation errors raise
  metadata {
    model_used       str
    input_tokens     int
    output_tokens    int
    cost_usd         float
    latency_ms       int
    prompt_fingerprint str                            # sha256 of system prompt; logged in audit
    schema_fingerprint str                            # sha256 of schema
  }
}
```

**Sandboxing requirements (adapter MUST):**

- Isolate the judge's context from any parent session (no conversation history leakage).
- Disable all tools (no Bash, no Edit, no MCP access).
- Render `data` values as DATA: templated into the user message with any LLM control tokens escaped, never concatenated into system prompt.
- Return structured output parsed against `schema`. Parse errors raise `ValidationError`.
- Log `prompt_fingerprint` and `schema_fingerprint` to audit on every call.

**Intended call sites in LAG** (not part of interface, but design guidance):

- `dedup_confirm(atom_a, atom_b) -> same | different | unsure`: gray-zone semantic dedup.
- `arbitrate(atom_a, atom_b, context) -> winner | tie | escalate`: when rule-based arbitration cannot decide.
- `validate_claim(atom, world_snapshot) -> verified | invalid | unverifiable`: world-state check.
- `classify_atom_type(content) -> type`: at INGEST.
- `propose_diff(atom, current_canon) -> diff`: when promoting L2 to L3.
- `summarize_for_digest(atoms[]) -> str`: weekly review digests.
- `anomaly_check(metrics_window) -> flags[]`: meta-governance.

Each call site defines its own schema, passed through `judge`.

### Notifier

Telegraph-the-user is first-class. Every proposal, every canon edit, every principal change that warrants review goes through here. The layer implements the autonomy dial.

```
telegraph(
  event: Event,
  diff?: Diff,
  default_disposition: Disposition,
  timeout_ms: int
) -> NotificationHandle

Event {
  kind              "proposal" | "canon_edit" | "principal_change" | "anomaly" | "taint_alert"
  severity          Severity
  summary           str                              # short one-line
  body              str                              # full human-readable
  atom_refs         AtomId[]
  principal_id      PrincipalId                      # who initiated
  created_at        Time
}

disposition(handle: NotificationHandle) -> Disposition
  # Returns current disposition. "pending" if not yet resolved.

await_disposition(handle: NotificationHandle, max_wait_ms: int) -> Disposition
  # Block until disposition resolves or max_wait_ms expires (then returns current state).

respond(handle: NotificationHandle, disposition: Disposition, responder_id: PrincipalId) -> None
  # Human-side response. Typically called by the adapter when user replies.
```

Adapters can implement delivery via: file-queue (simplest, human watches a directory), Slack, email, Claude Code session-inject (system-reminder), webhook. LAG does not care; it just calls `telegraph` and `await_disposition`.

### Scheduler

```
recurring(task_id: str, cron_expr: str, handler: Callable) -> RegistrationId
  # Register a recurring task. cron_expr is standard crontab syntax.
  # Typical uses: daily decay sweep, weekly validation re-check, promotion scan.

defer(task_id: str, delay_ms: int, handler: Callable) -> RegistrationId
  # One-shot deferred task. For notification timeouts.

cancel(reg: RegistrationId) -> None

killswitch_check() -> bool
  # Returns true if the system should halt all writes.
  # Conformance: adapter honors the presence of a STOP signal
  # (file, env var, remote flag). Implementation-specific.
```

### Auditor

Append-only log plus metric emission. Every consequential action logs here. Includes LLM judge calls (via prompt_fingerprint), canon commits, taint operations, notification dispositions, proposal lifecycle.

```
log(event: AuditEvent) -> AuditId

AuditEvent {
  kind              str                              # e.g. "atom.put", "canon.commit", "llm.judge", "notify.respond"
  principal_id      PrincipalId
  timestamp         Time
  refs {
    atom_ids        AtomId[]
    proposal_ids    ProposalId[]
    commit_refs     CommitRef[]
  }
  details           dict                             # kind-specific payload
}

query(filter: AuditFilter, limit: int) -> AuditEvent[]
  # For anomaly detection, compliance queries, post-hoc debugging.

metric(name: str, value: float, tags?: dict) -> None
  # For observability metrics (atoms written/day, conflict rate, etc.)
```

### PrincipalStore

```
get(id: PrincipalId) -> Principal | None
put(p: Principal) -> PrincipalId

permits(principal_id: PrincipalId, action: Action, target: Target) -> bool
  # Permission check. Actions: "read", "write", "promote", "commit_canon", "mark_compromised".
  # Target: scope, layer, specific atom/canon path.

mark_compromised(id: PrincipalId, at_time: Time, reason: str) -> None
  # Trigger taint propagation. LAG's taint-propagation routine runs on the atom store.

list_active() -> Principal[]
  # Active, non-compromised principals.

Action = "read" | "write" | "promote" | "commit_canon" | "mark_compromised"
Target = { scope?: Scope, layer?: Layer, atom_id?: AtomId, path?: str }
```

### Clock

```
now() -> Time                                         # ISO-8601 UTC
monotonic() -> int                                    # nanoseconds since adapter init; strictly increasing
```

Separate from system clocks so adapters can implement a simulation clock or a wall clock interchangeably. Tests drive the simulation clock; production uses wall clock.

### Transaction (optional capability)

```
with transaction() as tx:
  store.put(atom)
  canon.commit(proposal_id, approver_id)
  auditor.log(event)
  # All three commit or none do.

supports_transactions() -> bool
  # Caller may check; if false, caller runs operations with compensating-action cleanup.
```

LAG uses transactions for promotions specifically. Adapters that cannot support transactions (e.g. pure filesystem) must still provide a best-effort path: LAG runs the sequence, and on failure runs reverse operations in reverse order.

## Error handling

```
HostError                                             # base class
  NotFoundError
  ConflictError                                       # e.g. atom id collision, duplicate proposal
  TimeoutError
  PermissionError                                     # principals.permits returned false
  ValidationError                                     # schema validation, atom schema violation
  TransientError                                      # network blip, rate limit; caller may retry
  UnsupportedError                                    # capability not supported by this adapter
```

Retries are caller responsibility. LAG has retry policy config; adapters should not retry implicitly.

## Concurrency model

- All methods are thread-safe within a single process.
- Multiple processes against the same underlying store is adapter-dependent. Filesystem adapters: single-writer typically. Chroma, Postgres: multi-writer with their own locking.
- LAG issues arbitration at write-time, before put. Concurrent puts that would conflict are serialized at the LAG level via an in-process lock per-content-hash.
- Canon writes are serialized through the CanonStore adapter (git naturally serializes).
- Notifications are handle-idempotent: same event submitted twice yields the same handle if still pending.

## Versioning plan

```
Interface version:      v1, v2, ... (breaking changes bump the number)
Atom schema version:    schema_version field on atom; migration runners handle upgrades
Adapter declares:       supports_interface = "v1"; supports_atom_schema = 1

LAG init checks:        if adapter version < lag version, load shim; if lag > adapter-max, abort
```

Additions are backward-compatible (new methods with defaults). Removals or signature changes bump the version.

## Conformance test suite

Ships with LAG as `conformance/`. 150+ scenarios covering:

- Basic CRUD on atoms and principals.
- AtomFilter correctness (combinations of layer, scope, taint, time).
- Embedding determinism across calls within an adapter version.
- Content hash normalization (canonical-form tests).
- Similarity bounds (cosine in [-1, 1], normalized to [0, 1] in scores).
- Canon propose/commit/revert roundtrip.
- Canon revert restores prior state exactly.
- LLM judge sandboxing (malicious atom content cannot alter judge decisions).
- LLM judge determinism at temperature 0.
- Notifier timeout respects default disposition.
- Scheduler killswitch halts all registered tasks within a defined grace window.
- Principal permission checks.
- Taint propagation terminates (no infinite loops on cyclic provenance).
- Taint propagation is monotonic (no atom goes from tainted to clean without explicit unmark).
- Transaction atomicity (if supported).
- Clock monotonic property (strictly increasing).
- Audit log is append-only (attempts to modify raise).
- Metric emission does not block.

A new adapter certifies by running the suite and producing a report. LAG ships a CLI: `lag conformance <adapter>` runs it.

## Reference implementations

Shipped in V0:

- **`lag.adapters.memory`**: pure Python in-memory. Used by simulation and unit tests. Deterministic by default. No persistence.
- **`lag.adapters.file`**: JSON files on disk for atoms, git for canon, log file for audit. No LLM (LLM calls stubbed with a deterministic mock for tests). Used for offline / air-gapped scenarios.
- **`lag.adapters.bridge`**: the workspace-specific production adapter. The external ChromaDB store-backed atom store, chroma embeddings, git-backed canon in `lag/canon/current.md` with the bracketed-section inside the main CLAUDE.md as a mirror, `claude -p` for LLM judge, Claude Code session-inject for notifications, cron + /loop for scheduler.

Users writing their own adapters (Postgres, SQLite, Neo4j, custom LLM provider) implement the interface and run conformance.

## Non-goals for V0

- Distributed deployment (multi-node coordination). Single-process.
- Strong authentication / authorization beyond principals. Host environment handles that.
- Backup and restore primitives. Use host-native tools (git clone, chroma export, etc.).
- Caching and prefetch optimization. Implementation detail.
- Vector index tuning (HNSW params, shard layouts). Adapter's concern.
- Cross-language portability of the interface itself. Python-first; other language bindings are V2.

## Open questions remaining

- **Transaction scope**: guaranteed two-phase commit vs best-effort compensating actions. V0 punts to best-effort; we revisit if the reversal rate proves too high.
- **LLM schema registry**: does LAG ship a canonical registry of schemas (for dedup, arbitrate, etc.) or does each call-site define inline? Probably registry, with strong naming; prevents schema drift.
- **Notification channel multiplexing**: should telegraph support multi-channel fan-out (email AND Slack AND session-inject)? V0: one channel per notifier adapter; fan-out via composed adapter later.
- **Cost tracking granularity**: per-call (already in JudgeResult) vs aggregated. V0: per-call; aggregation is a metric view on top.
- **Principal signing**: cryptographic signatures on principal declarations and canon commits? V0: none; relies on host-native trust (OS user, git signed commits). Revisit for multi-tenant.

## Why this interface passes the "really portable" bar

- The the bridge adapter is one of three that ship. If the framework only worked there, the `memory` and `file` adapters could not run the conformance suite.
- All LLM calls funnel through `judge`. Swap model = swap adapter config, no LAG code change.
- Canon location is abstracted via `selector`. Could be a bracketed section in CLAUDE.md, a separate file, a git branch, a database row.
- Notification channel is fully abstract; we do not assume Claude Code session-inject or Slack.
- Scheduler is cron-shaped but accepts cron expressions, not a specific cron implementation.
- The conformance suite IS the portability contract. Pass it, you are LAG-compliant.
