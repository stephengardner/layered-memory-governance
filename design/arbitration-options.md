# Arbitration Options

When two atoms conflict, how does the system decide?

Listing options so tradeoffs are visible. Recommendation at bottom.

## 10 options on the table

### 1. Last-write-wins

Newest atom overrides. Trivial to implement. Destroys valid history when the older atom was actually correct and the new one is a regression. No use beyond the crudest cases.

### 2. Confidence-weighted

Atom with higher `confidence` score wins. Principled. But confidence is a latent variable: at bootstrap every atom has confidence from the same prior distribution and the tie-breaking degenerates to one of the other rules anyway. Useful as a final multiplier, not a primary rule.

### 3. Recency-weighted (decay-aware)

Newer wins, old atoms discounted by their decay curve. Usually right when the world changes (we switched from MySQL to Postgres). Wrong when the older atom encoded a deeper truth than the newer, noisier one.

### 4. Source-rank (authority ladder)

Deterministic hierarchy: user directive > committed canon > validated L2 > refined L1 > raw observation. Auditable. Simple to reason about. Static ladder misses edge cases (e.g. a user's offhand remark outranks a carefully validated L2 atom, which may or may not be what you want).

### 5. Temporal scope (both coexist, time-fenced)

Neither is "wrong". Atom A was true before time T, atom B is true after. Both stored, retrieval filters by the query's time context. Handles refactors / reversals / reorgs correctly without destroying history. Requires temporal knowledge graph semantics and query-time time-awareness. The expensive-but-correct choice.

### 6. Consensus voting

N distinct principals / sessions must independently corroborate before a claim is canon. Robust. Slow to form (a single-source observation cannot promote alone). Best for L1 -> L2 promotion gating, not for instantaneous arbitration.

### 7. Validation-based

The atom that can be re-checked against the world wins. "File X contains function Y" is verifiable, so the answer is whichever atom matches the actual current file. Ground-truth aligned. Needs a validator-per-atom-type infrastructure (filesystem, HTTP, SQL, git). Many atoms are not directly verifiable ("user prefers X") so it is not a universal rule.

### 8. Escalation

For anything non-trivial, ask a human or authoritative agent. Safe for high-blast-radius decisions. Bottleneck if overused. Essential as a fallback, unusable as primary policy at scale.

### 9. Bayesian merge

Treat atoms as evidence, compute posterior over the claim space. Elegant in theory. Priors are fictional in practice (what is the prior on "we use Postgres"?). Worth revisiting once we have enough data to estimate priors empirically, not before.

### 10. Cluster-then-resolve

Find clusters of semantically similar atoms (not just pairs), resolve the whole cluster in one operation. Catches n-way conflicts that pairwise resolution misses. Expensive at scale (O(n^2) similarity or ANN). Valuable for L1 -> L2 promotion where a cluster becomes a single L2 atom.

## Recommended stack (since user asked for optimal regardless of cost)

Composition, in order:

1. **Source-rank (4)**; fast first-pass filter. If one atom clearly outranks the other by provenance tier, done.
2. **Temporal scope (5)**; if both are legitimate but describe different time windows, keep both, time-fence.
3. **Validation (7)**; if the claim is verifiable, run the validator, the one that matches wins.
4. **Escalation (8)**; if none of the above resolves, queue for human (low autonomy) or authoritative agent (high autonomy).

Consensus (6) and cluster-resolve (10) live on the promotion path, not the arbitration path.

Bayesian merge (9) and confidence-weighting (2) are deferred. They need empirical priors and a mature calibration record that V0 cannot provide.

## Implementation order

1. Source-rank: static, pure function. Ship first.
2. Temporal scope: needs the time-fence schema and query-side awareness. Second.
3. Validation: needs validator registry, one per atom type. Incremental.
4. Escalation: needs a queue and a reviewer UI. Last.

## Counter-arguments

- **"Source-rank is too rigid."** Correct for nuanced cases. Mitigation: the other three rules are above it in complexity order; source-rank only fires when it is unambiguous.
- **"Temporal scope is over-engineering."** Correct for systems that do not see the world change. For a multi-month agentic org, the world changes constantly and temporal scope is not optional.
- **"Validation is not universal."** Correct. For unverifiable atoms we fall through to the next rule. Validation is best-effort.
- **"Escalation bottlenecks."** Correct at full autonomy. The autonomy dial includes "authoritative agent" as escalation target, not just human. That agent is itself bounded by canon.
