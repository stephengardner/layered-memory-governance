# Principal Rotation and Compromise

Design for the case where a principal is compromised (prompt injection, leaked credentials, bug amplification, behavioral drift).

## Problem

An agent with principal P writes atoms over many sessions. If P is compromised at some time T, many atoms written after T may be wrong or adversarial. Transitively, atoms that other agents derived from P's writes are also suspect. We need to surgically remove the damage without nuking the whole palace.

## Design: taint propagation

Every atom carries a `taint` field: `clean | tainted | quarantined`. When a principal is marked compromised:

```
1. Admin marks principal P compromised at time T.
2. All atoms with principal_id = P AND created_at >= T  ->  taint = tainted.
3. For each tainted atom A:
     For each atom B where A in B.provenance.derived_from:
       B.taint = tainted  (transitive)
   Iterate until fixed point.
4. Tainted atoms are soft-excluded from retrieval:
     search() filters out taint != clean by default.
     Explicit `include_tainted=true` required for audit queries.
5. L3 canon atoms that are tainted  ->  human review required.
     Auto-generate a revert PR on the memory-updates branch.
     Human approves the revert.
6. During audit, reviewer can:
     a. Confirm tainted (keep quarantined, never promote).
     b. Clear taint (re-verify and mark clean).
     c. Rewrite (human-edit the content, reset provenance).
```

## Why this works

- **Provenance chain is the payoff.** Without per-atom `derived_from`, transitive taint is impossible. This is why the atom schema insists on the chain.
- **Soft exclusion, not deletion.** Tainted atoms remain for audit. You can reconstruct what the compromised principal did.
- **Git-like semantics for canon.** L3 atoms are tracked by commits. Revert is a first-class operation.
- **Graduated response.** `tainted` means "suspect, excluded pending review". `quarantined` means "confirmed bad, never promote". `clean` means "verified or never touched by compromise".

## Edge cases

### Compromise time unknown

If we cannot pin T precisely, taint all atoms from P since last-known-clean checkpoint. Users generally cannot find T to the second; we tolerate over-tainting as the safe default.

### Reinforcement by compromised principal of older clean atoms

An atom written before T but reinforced by P at time T+delta has a tainted reinforcement record but the original content is clean. We reduce the atom's consensus count by the tainted reinforcements, recompute confidence, keep the atom but mark its provenance partial-tainted. It stays retrievable but loses trust weight.

### User compromise

The user's own principal can theoretically be compromised (session hijack, shared machine, someone else typing). This is the nuclear case. Mitigation: user directives have a session-level signature; outside-session "user directives" from uncorroborated channels do not carry full weight. In practice, L0 raw transcripts should mark which turns were typed versus injected.

### Principal rotation (routine, not compromise)

Normal key rotation: new principal_id, old one deprecated but not compromised. Atoms from old principal remain clean. This is provenance bookkeeping, not taint.

## What is still missing

- **How do we detect compromise before it is obvious?** Behavioral anomaly detection: atom write rate spike, unusually confident writes, writes in scopes the principal historically did not touch. Needs a baseline and an alerting layer. Out of scope for V0 framework, in scope for V1 implementation.
- **How do we measure "cleared taint" correctness?** Reviewer might clear a taint they should not have. Mitigation: clear-taint operations are themselves audited and can be re-reverted.
- **Per-atom review at scale.** If P wrote 10,000 tainted atoms, manual audit is infeasible. Need triage: taint-sample-review and use the sample to decide whether bulk-delete or bulk-keep.

## Open

- Should taint cascade across L3 canon edits that were auto-merged from tainted L2 atoms? Yes, but the mechanism is git revert plus re-open for manual re-merge. Write this up.
- What does the review-reviewer loop look like? Second-reviewer required for clearing high-blast taints? TBD.
