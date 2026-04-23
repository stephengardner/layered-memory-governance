# Plan-approval + multi-reviewer consensus + merge writeback: design spec

**Date:** 2026-04-23
**Status:** Draft awaiting operator approval
**Context:** PR #125 closed the Question → Plan metadata gap. Two adjacent gaps remain before the Plan-state lifecycle is fully useful for autonomous orgs:

1. **Plan-state writeback on PR merge:** a Plan sits at `executing` forever; nothing transitions it to `succeeded` when the PR it drove lands.
2. **Multi-reviewer auto-approval:** `pol-plan-auto-approve-low-stakes` only auto-approves read-only sub-actors (auditor-actor). State-mutating actors (code-author) require operator HIL approval via `lag-respond`. The operator's ask: if a Plan collects reviewer votes from multiple distinct principals at high confidence, treat that as a CEO-equivalent quorum and auto-approve.

Both sit on top of the existing Plan state machine (`proposed → approved → executing → succeeded | failed | abandoned`, `src/runtime/plans/state.ts`) without changing it.

## Substrate check (what exists, what's missing)

Grounded in the research pass against commit 498b881:

| Surface | Status |
|---|---|
| Plan atom type + `plan_state` field | Wired (`src/runtime/plans/state.ts`, `src/substrate/types.ts`) |
| `runAutoApprovePass` (single-principal allowlist) | Wired (`src/runtime/actor-message/auto-approve.ts`) |
| `runDispatchTick` (`approved → executing`) | Wired (`src/runtime/actor-message/plan-dispatch.ts:98`) |
| Inline `executePlan()` (`executing → succeeded/failed`) | Wired but sync; not invoked by CodeAuthor chain |
| PR body footer carries `plan_id` | Wired (`src/runtime/actors/code-author/pr-creation.ts:218`) |
| `pr-observation` atom (merge state capture) | Wired (PR #138, `src/runtime/actors/pr-landing/pr-observation.ts`) |
| Plan ↔ PR cross-reference on the Plan atom | **Missing** |
| Reconciler that reads pr-observation → updates Plan state | **Missing** |
| Multi-principal vote atom type | **Missing** |
| Multi-reviewer auto-approval pass | **Missing** |
| `PromotionEngine` consensus (L1→L2 atom promotion) | Wired but wrong layer for authority grants |

## Design principles for this change

Spelled out so every decision below can be checked against them.

1. **Governance before autonomy** (canon directive). New auto-approval paths add gates, not bypass existing ones. Every seam has a policy atom that defaults to fail-closed (empty allowlist).
2. **Authority vs epistemics are different concerns.** `PromotionEngine` handles "is this fact true across N observers?"; this work handles "does this plan have organizational sign-off?". Do not conflate by reusing PromotionEngine for plan approval.
3. **Every state transition is atom-backed.** Today's HIL approval happens off-atom (notifier file → orchestrator disposition check). That's invisible to the audit trail. The new multi-reviewer path will emit vote atoms with full provenance so the approval chain is reconstructible. HIL approval migrates to the same atom shape in a later PR.
4. **Tick/pass pattern, not escalation/await.** Merge reconciliation and multi-reviewer approval are both recurring scans over existing atoms. Matches `runAutoApprovePass`, `runDispatchTick`, `runAuditor` shape. Each is testable in isolation and composable by callers.
5. **Narrow PR chain.** Break this into 4 PRs, each ≤ 350 LOC, each independently useful and independently reviewable.

## Capability A: Plan-state writeback on PR merge

### Atom-level mechanism

Already there: the PR body carries `plan_id: "plan-..."` as a YAML-parseable footer line. The `pr-observation` atom records the merge event.

Missing: a reconciliation pass that connects them and mutates the Plan.

### Design

New module: `src/runtime/plans/pr-merge-reconcile.ts`

```ts
export async function runPlanStateReconcileTick(
  host: Host,
  options?: { readonly now?: () => Time; readonly maxScan?: number },
): Promise<PlanReconcileTickResult>;

export interface PlanReconcileTickResult {
  readonly scanned: number;   // pr-observation atoms inspected
  readonly matched: number;   // pr-observation with parseable plan_id + mergeStateStatus indicating terminal
  readonly transitioned: number; // Plan atoms actually moved to succeeded/failed/abandoned
}
```

### Algorithm

1. Paginated query: `type === 'observation' AND metadata.kind === 'pr-observation' AND metadata.merge_state_status IN {'merged', 'closed'}` (the terminal PR states).
2. For each observation atom:
   - Read the Plan id. Two sources, in priority order:
     a. `metadata.plan_id` on the pr-observation atom itself (populated by pr-landing on observe; requires a small `src/runtime/actors/pr-landing/pr-observation.ts` change to parse the PR body footer and stamp it).
     b. Fallback: fetch the PR body via the adapter, parse the YAML footer, extract `plan_id`. Used when pre-stamping didn't happen.
   - **Claim step (race-safe, not just idempotency check).** Compute a deterministic marker id: `marker_id = 'plan-merge-settled-' + sha256(plan_id + '|' + pr_observation_id).slice(0, 16)`. Attempt `host.atoms.put({ id: marker_id, type: 'plan-merge-settled', ... })`. The atom store rejects duplicate ids, so the first worker to write wins and subsequent workers get a conflict/already-exists error, which they treat as "another worker claimed this; skip". This turns the marker into a mutual-exclusion claim, not just a post-hoc idempotency check, and is correct even under concurrent ticks. `AtomStore` does not expose a general compare-and-swap primitive; deterministic-id + put-is-unique is the workaround pattern used by the existing `runDispatchTick` for plan-state claims.
3. Load the Plan atom (only after claim succeeded). Verify `taint === 'clean'` and `superseded_by.length === 0` in code (not just query predicate). Accept current states `'executing'` and `'approved'` (the latter for plans that skipped the executing step); reject others loudly. If the guard fails, log and skip ; the claim marker stays and prevents retry on this observation.
4. Determine terminal transition:
   - `merged` → `'succeeded'`
   - `closed` + PR not merged → `'abandoned'`
   - anything else → no-op, observation filtered out upstream.
5. Write the plan update: `host.atoms.update(planId, { plan_state: next, metadata: { merged_pr: {...}, plan_state_reason: 'pr-merge-reconcile', plan_state_changed_at: now } })`.
   - The claim marker written in step 2 is the record of the reconciliation event itself; no additional marker is needed.

### Safety

- Idempotent by the marker atom. Re-running the tick on an already-settled plan is a no-op.
- Read-only on pr-observation atoms. The tick never mutates observations.
- Audit: each transition logs via `host.auditor.log({ kind: 'plan.state-reconciled', ... })`.
- Policy atom (`pol-plan-merge-reconcile`) isn't strictly required: the mechanism is deterministic + fail-open on missing plan_id. But we add one anyway so operators can disable the pass per-environment by setting `enabled: false`.

### Tests

TDD matrix in `test/runtime/plans/pr-merge-reconcile.test.ts`:

- `merged` pr-observation with stamped plan_id + plan in `executing` → plan becomes `succeeded`, marker atom written.
- `closed` pr-observation → plan becomes `abandoned`.
- Second tick on same inputs → 0 transitions (idempotent via marker).
- Plan already in `succeeded` → no-op (guard).
- pr-observation missing plan_id → skipped (return value tracks).
- Parse fallback: pr-observation without stamped id but with parseable PR body footer → resolves plan, transitions.

## Capability B: Multi-reviewer plan auto-approval

### Why this shape

The operator's vision: a Plan gathers "approve" signals from multiple principals; when consensus is reached, the Plan auto-approves even for state-mutating actors like code-author.

Constraint: state-mutating actors need rigor. A single reviewer vote isn't enough; policy must express "N distinct principals, at least one with role X, each at confidence ≥ Y".

### Atom-level mechanism

New atom type: **`plan-approval-vote`** (to be added to `src/substrate/types.ts` AtomType union).

Shape:

```ts
{
  schema_version: 1,
  id: AtomId,              // `vote-${plan_id.slice(...)}-${voter}-${timestamp}`
  type: 'plan-approval-vote',
  layer: 'L1',
  content: string,         // human-readable rationale
  provenance: {
    kind: 'user-directive' | 'agent-observed',
    source: { agent_id: PrincipalId, session_id?: string },
    derived_from: [plan_id],
  },
  confidence: number,      // vote strength; 0.5 = conditional, 1.0 = strong
  principal_id: PrincipalId, // voter identity; the atom store guards against spoofing via write permissions
  taint: 'clean',
  metadata: {
    plan_id: AtomId,
    vote: 'approve' | 'reject',
    reason: string,
    role?: string,         // optional; enables role-based policies
    voted_at: Time,
  },
}
```

Two ways to write these atoms:

- **Agent reviewers:** a principal (e.g., lag-security-reviewer, lag-perf-reviewer) running an Actor that reads Plans, deliberates, and writes a vote atom. These are peer reviewers to the CTO's planning.
- **Human reviewers:** extend `lag-respond` with an `[v]ote` disposition that writes a vote atom in addition to the existing notifier-state record. This migrates HIL approval to the atom store while preserving the existing notifier flow.

### New pass: `runPlanApprovalTick`

Module: `src/runtime/actor-message/plan-approval.ts`.

```ts
export async function runPlanApprovalTick(
  host: Host,
  options?: { readonly now?: () => Time; readonly maxScan?: number },
): Promise<PlanApprovalTickResult>;

export interface PlanApprovalTickResult {
  readonly scanned: number;
  readonly approved: number;
  readonly rejected: number;      // plans transitioned to 'abandoned' via hard-reject
  readonly stale: number;         // vote atoms older than max_age_ms dropped
}
```

### Policy atom: `pol-plan-multi-reviewer-approval`

```yaml
type: directive
layer: L3
metadata:
  policy:
    subject: 'plan-multi-reviewer-approval'
    # sub-actors this policy will auto-approve via consensus
    # (distinct from pol-plan-auto-approve-low-stakes which is
    # read-only-only). Empty default = fail-closed.
    allowed_sub_actors: []
    # minimum distinct-principal approve votes
    min_votes: 2
    # per-vote confidence floor
    min_vote_confidence: 0.8
    # plan's own confidence floor (PlanningActor-assigned)
    min_plan_confidence: 0.85
    # optional whitelist of roles that must have voted approve
    # (intersection requirement: every listed role must have a voter).
    # Empty = no role requirement.
    required_roles: []
    # single reject hard-blocks and abandons the plan
    hard_reject_on_any_reject: true
    # vote freshness window; older than this, the vote doesn't count
    max_age_ms: 86400000   # 24 hours
```

### Algorithm

1. Paginated query for plans in `plan_state === 'proposed'` with `taint === 'clean'` and non-empty `metadata.delegation.sub_actor_principal_id`.
2. Skip if target not in `policy.allowed_sub_actors`.
3. Skip if `plan.confidence < policy.min_plan_confidence`.
4. Query all `plan-approval-vote` atoms with `derived_from.includes(plan.id)`. **In-code guard (not just query predicate):** filter the returned atoms to `atom.taint === 'clean' && atom.superseded_by.length === 0` before counting. Adapter-level predicate enforcement can vary; enforcing these invariants in the pass itself guarantees superseded/revoked votes never contribute regardless of adapter behavior. Same guard applies to the plan atom loaded in step 1.
5. Filter votes by freshness (`voted_at >= now - max_age_ms`); count staleness for return value.
6. If `hard_reject_on_any_reject === true` and any fresh vote has `metadata.vote === 'reject'`: transition plan to `'abandoned'` with `metadata.abandoned_reason = 'hard-reject-by-<principal>'`, log audit, increment `rejected` counter. Continue to next plan.
7. Otherwise, count distinct `principal_id` with `vote === 'approve'` AND `confidence >= policy.min_vote_confidence`.
8. If count < `policy.min_votes`: skip.
9. If `policy.required_roles.length > 0`: verify each required role has at least one fresh approve vote from a principal with that role in its record. Skip if any missing.
10. Transition plan to `'approved'` with `metadata.multi_reviewer_approved = { via: policy_id, voters: [principalId,...], at: now }`.

### Interaction with existing `runAutoApprovePass`

`runAutoApprovePass` handles the "low-stakes auditor-only" path. `runPlanApprovalTick` handles the "multi-reviewer consensus" path. They're independent; callers invoke whichever fits.

Both passes are called by the same upstream runner (a new `scripts/run-approval-cycle.mjs` or equivalent). Order matters: `runAutoApprovePass` first (cheaper filter), then `runPlanApprovalTick`. If either approves a plan, the other skips on the next tick (plan_state filter).

### Safety

- Fail-closed by default. Empty `allowed_sub_actors` means nothing auto-approves (this is the hard gate; operator widens the allowlist explicitly to enable the pass for a given sub-actor). Empty `required_roles` means "no role constraint" ; the vote-count and confidence thresholds still apply, but no role-based veto is checked. These two fields are intentionally different knobs: `allowed_sub_actors` is the pass's on/off switch; `required_roles` is the intersection requirement on top of vote-count when the pass is on.
- Vote atoms carry `principal_id`. Write permissions on the atom store determine who can vote for whom. Compromise propagation (existing taint mechanism) automatically invalidates votes from compromised principals.
- Single reject abandons the plan : gives any reviewer a veto. Matches real-org governance.
- `max_age_ms` prevents stale approval reuse. A week-old approve vote on a since-edited plan doesn't auto-approve a re-derived version.
- Plan taint check: votes on tainted plans don't accumulate.
- Audit trail: every approval logs `plan.approved-by-consensus` with the voter set, policy id, and plan's at-approval confidence.

### Tests

TDD matrix in `test/actor-message/plan-approval.test.ts`:

- 1 approve vote, threshold = 2 → no transition.
- 2 approve votes from distinct principals → plan becomes `approved`, metadata.multi_reviewer_approved populated.
- 2 approve votes from the same principal → no transition (distinct-principal guard).
- 2 approve + 1 reject → plan becomes `abandoned` (hard reject).
- 3 approves but one is stale (voted_at < now - max_age_ms) → 2 fresh, threshold = 2 → approves.
- `required_roles: ['sre']`, 3 approves but none with role 'sre' → no transition.
- `required_roles: ['sre']`, 3 approves including one with role 'sre' → approves.
- Plan confidence < min_plan_confidence → no transition.
- Target sub-actor not in allowlist → no transition.
- Plan tainted → no transition.
- Plan already `approved` → no-op (respects state machine).

## PR chain

Four PRs off main, each independently landable:

### PR A (first): plan-approval-vote atom type + `runPlanApprovalTick` pass + tests

- Add `'plan-approval-vote'` to `AtomType` union in `src/substrate/types.ts`.
- New module `src/runtime/actor-message/plan-approval.ts` with `runPlanApprovalTick`.
- Policy atom factory or bootstrap seeds `pol-plan-multi-reviewer-approval` with empty allowlist (fail-closed).
- Tests: full matrix above.
- No runner wiring yet; pass is callable but never invoked in production paths.

**Scope:** ~300 LOC src + ~400 LOC tests. Zero behavior change; purely additive.

### PR B: plan_id stamping on pr-observation + `runPlanStateReconcileTick` + tests

- Extend `src/runtime/actors/pr-landing/pr-observation.ts` to parse the PR body footer's `plan_id:` at observation time and stamp `metadata.plan_id` on the atom.
- New module `src/runtime/plans/pr-merge-reconcile.ts` with `runPlanStateReconcileTick`.
- Marker atom type `plan-merge-settled` added to AtomType union.
- Tests: merged/closed transitions, idempotency, missing plan_id fallback to body-parse, taint/guard cases.
- Runner: `scripts/run-plan-state-reconcile.mjs`.

**Scope:** ~250 LOC src + ~350 LOC tests.

### PR C: operator-reviewer bridge + `lag-respond` vote writeback

- Extend `lag-respond` disposition vocabulary to include `[v]ote (approve/reject with rationale)` in addition to existing `[a]pprove/[r]eject/...`.
- Vote disposition writes a `plan-approval-vote` atom into the store in addition to the existing notifier-state response file.
- Back-compat: existing `[a]` still functions as direct notifier approval (no atom write). The `[v]` path is additive.
- Tests: CLI integration tests, end-to-end with `runPlanApprovalTick`.
- Docs: update `docs/autonomous-org-walkthrough.md` with the multi-reviewer flow.

**Scope:** ~200 LOC src + ~250 LOC tests + doc updates.

### PR D: canon seed + runner integration

- Widen `pol-plan-multi-reviewer-approval` allowlist (in canon) to include `code-author` and any real agent-reviewer principals the operator seeds.
- Extend `scripts/run-cto-actor.mjs` to call `runPlanApprovalTick` at end-of-run (opportunistic approval check if votes already exist).
- Add `scripts/run-approval-cycle.mjs` as the canonical "tick all approval passes + merge reconcile" daemon-style script.
- Updates `docs/autonomous-org-walkthrough.md` implementation-status table: CodeAuthor loop + plan state writeback flip from Skeleton to Wired (for the reconcile half; CodeAuthorActor is a separate concern).

**Scope:** ~150 LOC + doc updates.

## Rejected alternatives

- **Reuse `PromotionEngine` for plan approval.** Rejected: promotion is epistemic (fact consensus across identical content hashes), not authority (a plan is approved to execute). Reusing would force vote atoms to have identical content hashes, which breaks the per-principal rationale field. Separate machinery is cleaner.
- **Widen `pol-plan-auto-approve-low-stakes` to include code-author.** Rejected: that policy's content explicitly says "Never auto-approve a sub-actor that mutates state beyond atom writes." Widening it contradicts its charter. A new policy atom for a new concern is the right move.
- **Embed vote counts in a mutable field on the Plan atom.** Rejected: mutation breaks provenance reconstruction. Each vote is its own atom with its own provenance chain. Counts are derived, not stored.
- **Skip hard-reject; require a full re-plan loop on reject.** Rejected: the HIL reject path already exists via `lag-respond [r]eject`. Parity requires the multi-reviewer path to support reject too. Alternative operator preference via `hard_reject_on_any_reject: false` is configurable.
- **Auto-succeed plans on any PR merge referencing them, regardless of Plan state.** Rejected: a plan already in `'abandoned'` or `'failed'` shouldn't be resurrected by a late PR merge. Guard on accepted source states.

## What this ships, what it doesn't

**Ships:**
- Plan atoms transition to `succeeded`/`abandoned` when their originating PR merges/closes (PR B).
- State-mutating sub-actors (code-author) can auto-approve via multi-reviewer consensus (PRs A+D).
- HIL approval path is migrated to atom-backed votes (PR C), preserving audit trail.

**Doesn't ship (tracked as follow-ups, not in scope here):**
- CodeAuthorActor skeleton → full loop (separate, larger workstream).
- Dispatch envelope injection in `run-cto-actor.mjs` (noted in walkthrough; trivial follow-up).
- Delegation envelope schema standardization across runners.
- Vote weighting by principal depth (current design: one vote per principal, flat).

## Open questions for operator review

Before implementation begins, three calls worth making explicit:

1. **Default allowlist.** Should `pol-plan-multi-reviewer-approval` ship with empty allowlist (fail-closed), or seed with `code-author` behind a high `min_votes` threshold (fail-paranoid-but-functional)? Recommend **empty** : operator widens explicitly once at least one non-CEO reviewer principal exists.

2. **Role schema.** Should `metadata.role` on vote atoms be free-string (operator picks names) or enum-gated? Recommend **free-string**, to keep the framework role-agnostic (per canon `src/ stays mechanism-focused`). Instance canon can enforce role vocab via a validator atom later.

3. **Vote freshness window.** 24 hours is my default. Is that right, or should it be shorter (to prevent a plan sitting 23 hours with one fast approve, getting one more stale approve, and auto-approving without a fresh look)? Alternative: require all votes to fall within a narrower window from each other, not just from "now". Recommend **24h default**, with the narrower-window option deferred as a follow-up if drift observed.

## References

- `src/runtime/plans/state.ts` : Plan state machine.
- `src/runtime/actor-message/auto-approve.ts` : existing single-principal pass, structural template for `runPlanApprovalTick`.
- `src/runtime/actor-message/plan-dispatch.ts` : existing `approved → executing → succeeded/failed` transitions.
- `src/runtime/actors/pr-landing/pr-observation.ts` : pr-observation atom shape.
- `src/runtime/actors/code-author/pr-creation.ts:218` : PR body footer with `plan_id:`.
- `src/substrate/promotion/engine.ts` : the consensus machinery this spec deliberately does NOT reuse, for reasons above.
- `pol-plan-auto-approve-low-stakes` : existing low-stakes policy, intentionally left narrow.
- Canon directives cited: `governance-before-autonomy`, `dev-l3-promotion-requires-human-approval`, `dev-right-over-easy`, `dev-no-hacks-without-approval`, `dev-extreme-rigor-and-research`.
