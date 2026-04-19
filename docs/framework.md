# Layered Autonomous Governance (LAG): Framework

Working framework, V0. Implemented; see per-phase findings in
`../design/phase-*-findings.md` and `../NEXT.md` for the live status.

## The core object: a memory atom

Every stored unit is an atom with this shape. Without these fields you cannot decay, arbitrate, audit, or scope.

```
id                              stable, content-derived hash
content                         the claim itself
type                            directive | observation | decision | preference | reference | ephemeral
provenance
  kind                          user-directive | agent-observed | agent-inferred | llm-refined | canon-promoted
  source                        session id, agent id, tool, file path
  derived_from                  [atom ids this was synthesized from]
confidence                      0.0 to 1.0, declining without reinforcement
created_at                      ISO-8601
last_reinforced_at              ISO-8601
expires_at                      ISO-8601 or null
supersedes                      [atom ids this overrides]
superseded_by                   [atom ids overriding this]
scope                           session | project | user | global
signals
  agrees_with                   [atom ids observed to agree]
  conflicts_with                [atom ids observed to conflict]
  validation_status             verified | unchecked | stale | invalid
  last_validated_at             ISO-8601 or null
principal_id                    who wrote it, under what role
taint                           clean | tainted | quarantined
```

## Four layers (tiers of trust)

```
L0  Raw         transcripts, tool output           high volume, low trust, regeneratable
L1  Extracted   LLM-refined atoms                  medium volume, medium trust, provenance tagged
L2  Curated     deduped, conflict-resolved, versioned
                                                    low volume, high trust
L3  Canon       committed CLAUDE.md / principals   lowest volume, human-signed, rollback-able
```

Atoms flow upward through promotion, downward through decay. An L1 observation can never directly override L3 canon. It can only propose an edit via governance.

## Lifecycle verbs (9, not 2)

```
INGEST        raw  ->  extracted (LLM refinement or regex)
REINFORCE     same fact seen again  ->  confidence+, last_reinforced_at=now
DECAY         scheduled; confidence declines by type-specific half-life
CHALLENGE     new atom contradicts old  ->  arbiter called
ARBITRATE     resolve conflict; loser.superseded_by=winner
PROMOTE       L1->L2 or L2->L3 when confidence * consensus * validation > threshold
INVALIDATE    explicit removal with reason
EXPIRE        TTL reached
PROPOSE       agent proposes CLAUDE.md diff  ->  review queue
```

## Staleness (not just TTL)

Four signals combined:

```
confidence = base * decay(age) * consensus(distinct_sources) * validation(active_tests)
```

- **decay(age)**: exponential with type-specific half-life. Directives: years. Decisions: months. Ephemeral: days.
- **consensus**: number of distinct sessions / agents / principals that wrote or reinforced this claim.
- **validation**: a fact about the world can be re-checked. "File X at path Y" is verifiable. This is the part every system skips, and it is where hallucination rot lives.

Low-confidence atoms are demoted, not deleted. Still findable by explicit query, deprioritized in default retrieval.

## Precedence (priority ladder)

```
1  Live user directive (this session)
2  Committed CLAUDE.md (L3 canon)
3  High-confidence L2 propositions
4  Recent reinforced L1
5  Old unreinforced L1
6  Single-session observations
```

Arbitration path: rule-based first (deterministic, cheap), LLM-judge second (nuanced), escalate to human for high blast radius. Loser is marked `superseded_by`, never deleted. Audit trail intact.

See `../design/arbitration-options.md` for option analysis.

## CLAUDE.md canon pipeline

```
L2 atom (consensus reached)
  |
  v  PromotionEngine.runPass('L3')
policy evaluation
  |  (confidence >= 0.9, consensus >= 3 distinct principals, validation ok)
  |
  +-- requireHumanApproval=true: telegraph -> Notifier -> awaitDisposition
  |     |
  |     +-- approve: L3 atom created with provenance.kind=canon-promoted
  |     +-- reject / timeout: rejected, audit trail intact
  |
  v  CanonMdManager.applyCanon(L3 atoms, target file)
bracketed section in CLAUDE.md
  <!-- lag:canon-start -->
  ## Decisions
  - ...
  <!-- lag:canon-end -->
```

Canon application is a direct file write, not a git commit. The
bracketed section is replaced atomically (write-to-tmp + rename);
content OUTSIDE the markers is preserved byte-for-byte. Human edits to
non-canon sections survive every tick.

Auto-apply threshold (requireHumanApproval) is THE dial. V0 default:
true (every L3 promotion telegraphs). Operators can flip per-deployment
in `DEFAULT_THRESHOLDS` or pass custom thresholds to PromotionEngine.

The human approval loop is operator-facing via the `lag-respond` CLI,
which reads pending notifications from `rootDir/notifier/pending/` and
drives interactive approve/reject/ignore.

When a principal is discovered compromised, `lag-compromise` marks
them and runs `propagateCompromiseTaint` across direct + derived
atoms; tainted atoms drop out of the next canon render automatically.

## Multi-agent coordination

Same primitives at every autonomy level, different thresholds:

- Shared palace, per-agent provenance tags.
- L0 / L1 writes are free (own observations, agent-id tagged).
- L2 requires cross-agent consensus OR human arbitration.
- L3 requires human gate at low autonomy, anomaly-only review at high autonomy.
- Read scoping: team-scoped, user-private, project-scoped. Agents retrieve within permitted scope only.

**Invariant at every autonomy level**: agents cannot rewrite governance rules that were set at L3 canon. Principals are L3. That is how prompt injection cannot self-authorize.

## Principals (agent identity is memory too)

A principal is a special L3 atom signed by the user:

```
identity, role, permitted_scopes (read / write), goals, constraints
```

Every tool use and every memory write is attributed to a principal. Audit log reads: "principal X wrote atom Y at time T based on atoms [A, B, C]". IAM for reasoning.

Principals are versioned, hierarchical (team inherits org), and per-context scopeable. Full autonomy ("manage their own principals") means agents propose principal edits through the same governance pipeline as CLAUDE.md edits.

Compromise handling: see `../design/principal-rotation.md` (taint propagation).

## The autonomy dial

```
L0  human reads all atoms, approves all edits                       (today)
L1  human approves L2+ promotions; L1 auto-refined
L2  human reviews canon diff weekly; auto-merge below threshold
L3  human reviews anomalies only; agents govern most of L1-L3
L4  human reviews escalations; agents manage principals             (autonomous org)
```

Moving up a level is threshold config, not architecture change. That is the point of the framework.

## Retrieval

Retrieval is a pluggable `Embedder` interface (`src/interface.ts`).
Three implementations ship:

- **TrigramEmbedder** (default): character-trigram FNV-hash into
  128-dim + L2 normalize + cosine. Zero dependencies, deterministic,
  fast, good enough for the common case where atoms reinforce the
  same vocabulary (phase-15 measured 0.95+ top-1 on exact /
  rearranged / paraphrase / synonym / adversarial queries; collapses
  to 0.20 on hard-paraphrase where the query shares zero vocabulary).
- **OnnxMiniLmEmbedder**: local `Xenova/all-MiniLM-L6-v2` via
  `@huggingface/transformers`. 384-dim mean-pool + L2 normalize.
  Deterministic, private, offline after first-run model download.
  Lifts hard-paraphrase top-1 from 0.20 to 0.60 (phase 17).
- **CachingEmbedder**: decorator. Persists any inner embedder's
  outputs to `rootDir/embed-cache/<embedderId>/<sha>.json`. Turns
  first-query cost from O(N) embeds to O(N) disk reads (phase 18
  measured 17x speedup on 200 atoms).

Host factories accept an optional `embedder`. `lag-run-loop` exposes
`--embedder trigram|onnx-minilm` and `--embed-cache / --no-embed-cache`
flags so operators configure retrieval at the command line without
writing code.

## Observability

Metrics that must run green:

- Atoms written / day, read / day, read-rate-30d (dead weight alarm)
- Conflict rate (confusion alarm)
- Auto-merge rate and reversal rate (calibration alarm)
- Human review queue depth (autonomy too aggressive alarm)
- CLAUDE.md edit velocity (drift alarm)
- Cost per written atom, cost per retrieved-and-actioned atom (ROI alarm)

Traces: every agent action logs atoms retrieved and atoms acted on. Post-hoc debugging of "why did agent X do Y".

## Open questions

Running list with status at `../design/open-questions.md`.

## Simulation

Test harness design at `../design/simulation-harness.md`. The simulation IS the spec.
