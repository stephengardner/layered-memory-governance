# PR-Observation Re-Observe Mechanism -- Design Spec

**Status**: draft
**Date**: 2026-05-01
**Derived from**: substrate gap #8 (PR #274 closing comment, 2026-05-01), `dev-substrate-not-prescription`, `dev-indie-floor-org-ceiling`, `arch-pr-state-observation-via-actor-only`
**Successor work to**: PR #274 (closed 2026-05-01 after CR's two MAJOR findings on the wrong fix)

## 0. Indie-floor + org-ceiling fit

Indie default: a solo developer running a one-line README typo-fix should never see a re-observe poll. The mechanism activates only when there is a plan in `plan_state='executing'` whose latest pr-observation is older than the freshness threshold. Zero plans in `executing` -> zero re-observe activity -> zero GitHub API spend. The freshness threshold is a canon policy atom with a sensible default (5 minutes); a deployment that never wants polling sets the threshold to `Infinity` and ships only the manual `run-pr-landing.mjs --observe-only` path.

Org ceiling: a 50-actor deployment with many concurrent dispatched plans gets a single periodic tick that re-observes only the plans that need it (executing + stale-observation). The tick batches GitHub API calls per (owner, repo, number) so 50 plans against the same repo produce 50 reads, not 50 round-trips for each tick the worst case is N reads per tick where N is `executing` plan count, bounded by `maxScan` for safety.

## 1. Goal

Close substrate gap #8: plans whose PR has merged or closed but whose `pr-observation` atom still carries `pr_state='OPEN'` from PR-creation time. The reconciler reads the stale observation and never transitions `executing -> succeeded|abandoned`.

Concrete: PR #273 was CLOSED. The only observation atom at `.lag/atoms/pr-observation-stephengardner-layered-autonomous-governance-273-47bfe0698453.json` carries `pr_state='OPEN'` because it was written ONCE at PR creation. The reconciler skips it. Plan `plan-add-one-line-bullet-...-3ahubw-0` stays at `plan_state='executing'` forever.

The fix: a re-observe mechanism that writes a fresh `pr-observation` atom when the underlying GitHub state has changed, so the reconciler sees the terminal state and finishes the transition.

## 2. Current state (as of 2026-05-01)

- `scripts/invokers/autonomous-dispatch.mjs` calls `run-pr-landing.mjs --observe-only --live --plan-id <id>` ONCE immediately after the PR is opened. Atom is keyed `pr-observation-${owner}-${repo}-${number}-${shaSuffix}` (line 55-63 of `src/runtime/actors/pr-landing/pr-observation.ts`).
- The atom id encodes the head SHA. When a PR's head SHA changes (new commit pushed), a NEW atom is written.
- When a PR merges or closes WITHOUT a new commit (the common case after CR-precheck merge or operator close), the head SHA is unchanged, the existing atom-id collides, and `runObserveOnly` (line 615-648 of `scripts/run-pr-landing.mjs`) sees `existing !== null` and exits with "already exists; not reposting".
- The original observation's `metadata.pr_state` stays at the value GitHub returned at PR-creation time (`'OPEN'`), forever.

## 3. Proposed: periodic re-observe tick

A new approval-cycle tick that scans `pr-observation` atoms and refreshes each one whose linked plan is still `executing`, whose `pr_state` is non-terminal (i.e. still `OPEN`), and whose `observed_at` is older than the freshness threshold. The scan is observation-side because the canonical observation -> plan linkage already exists (`metadata.plan_id`); a plan-side scan would have to reverse-walk that linkage on every plan.

```text
runPlanObservationRefreshTick(host, refresher, options):
  scanned = 0; refreshed = 0; skipped = {}
  for obs in atoms where type='observation' and taint='clean' and superseded_by=[]:
    scanned += 1
    if obs.metadata.kind != 'pr-observation': continue
    if obs.metadata.pr_state in TERMINAL_PR_STATES:
      skipped['already-terminal'] += 1; continue   // reconciler will handle
    plan_id = obs.metadata.plan_id
    if plan_id is null: skipped['no-plan-id'] += 1; continue
    if (now - obs.metadata.observed_at) < freshness_threshold_ms:
      skipped['fresh'] += 1; continue
    plan = host.atoms.get(plan_id)
    if plan is null or plan.type != 'plan': skipped['plan-missing'] += 1; continue
    if plan.plan_state != 'executing': skipped['plan-not-executing'] += 1; continue
    pr = obs.metadata.pr  // {owner, repo, number}, structured data already on the atom
    if not isValidPrObject(pr): skipped['pr-malformed'] += 1; continue
    if refreshed >= maxRefreshes: skipped['rate-limited'] += 1; continue
    try:
      await refresher.refresh({ pr, plan_id })   // pluggable seam, see section 4
      refreshed += 1
    except err:
      log err; skipped['refresh-failed'] += 1
  return { scanned, refreshed, skipped }
```

The tick reads `metadata.pr` (a structured `{owner, repo, number}` object already on every observation atom) so there is no string-parsing inside `src/`; this respects the failure mode CR's first MAJOR finding on PR #274 caught.

The tick is **mechanism-only**. It defines:
1. Which plans to consider (substrate concern: query + plan_state filter)
2. Which observations are stale (substrate concern: timestamp arithmetic against a canon-supplied threshold)
3. **Delegates the actual GitHub query** to a pluggable `Observer` seam injected by the caller

The tick does NOT:
- Make GitHub API calls (substrate purity per `dev-substrate-not-prescription`)
- Parse PR numbers from strings (the bug from PR #274's first MAJOR finding)
- Bypass the existing reconciler (the bug from PR #274's second MAJOR finding)

Per-tick the reconciler runs AFTER refresh in the approval-cycle ordering, so a refresh that surfaces a terminal state in the same tick is picked up by the reconciler immediately:

```text
0. intent-approve
1. auto-approve
2. plan-approval
3. plan-observation-refresh   <-- NEW
4. plan-reconcile               <-- already-reads-fresh-observations
5. dispatch
```

Refresh-then-reconcile is the same fixed-order claim that makes auto-approve-then-dispatch work (`scripts/run-approval-cycle.mjs:23-28`).

## 4. Substrate boundary

### 4.1 `src/runtime/plans/pr-observation-refresh.ts` (new framework module)

Mechanism:
- `runPlanObservationRefreshTick(host, refresher, options)` - the tick
- `PrObservationRefresher` - interface with one method: `refresh({ pr, plan_id }) -> Promise<void>`
- `PrRef` - structured type `{owner: string, repo: string, number: number}` read from each observation atom's `metadata.pr` field

The framework module never imports `execa`, `gh`, GitHub SDK, or any string-parsing of PR numbers from summaries. `pr` is a structured object read from the canonical source (`metadata.pr`); no string-parsing path exists inside `src/`.

### 4.2 `scripts/lib/pr-observation-refresher.mjs` (new instance-side adapter)

The deployment-specific adapter that implements `PrObservationRefresher.refresh()` by spawning `node scripts/run-pr-landing.mjs --observe-only --live --pr <n> --owner <o> --repo <r> --plan-id <id>`. Lives in `scripts/lib/` (instance configuration, not framework code), per `dev-substrate-not-prescription`.

### 4.3 `scripts/run-approval-cycle.mjs` wiring

A single new wired step between plan-approval and plan-reconcile:

```js
import { runPlanObservationRefreshTick } from '../dist/runtime/plans/pr-observation-refresh.js';
import { createPrLandingObserveRefresher } from './lib/pr-observation-refresher.mjs';

// in main():
const refresher = createPrLandingObserveRefresher({ repoRoot: REPO_ROOT });
try {
  const r = await runPlanObservationRefreshTick(host, refresher);
  console.log(`[approval-cycle] plan-obs-refresh   scanned=${r.scanned} refreshed=${r.refreshed} skipped=${formatSkipped(r.skipped)}`);
} catch (err) {
  console.error(`[approval-cycle] plan-obs-refresh FAILED: ${err?.message ?? err}`);
  firstError = firstError ?? err;
}
```

The runner stays canonical: an indie deployment without a refresher passes `--no-refresh` (or omits the wiring); an org with a different transport (Slack-bridge, internal git host) passes a different refresher implementation pointing at their adapter.

### 4.4 No reconciler change

`src/runtime/plans/pr-merge-reconcile.ts` is **untouched** in this PR. It already does the right thing: scans observation atoms with terminal `pr_state` and transitions plans. The bug it appeared to have was not its bug; it was that no fresh observations were being written. Once refresh starts running, the reconciler picks up terminal-state observations on the next tick.

## 5. Freshness threshold

A canon policy atom: `pol-pr-observation-freshness-threshold-ms`. Default `300_000` (5 minutes). The threshold is read at tick start and applied to the observation's `metadata.observed_at`.

Why a canon atom and not a constant:
- Indie deployments running a single PR through the autonomous loop see latency budgets in the ~5-minute range; 5 minutes is a sensible default.
- Org-ceiling deployments running 50 concurrent dispatches may want to tighten the threshold to 60 seconds (faster autonomous loop) or relax it to 30 minutes (cheaper GitHub API spend).
- Per `dev-future-tunable-dial-seam`, the dial is preserved as a substrate seam, sized to the existing canon-atom resolver, and ships with a default that matches the prior behavior of `manual-only-via-operator-trigger` (effectively `Infinity` until this PR).

The atom's `value` is the freshness window in milliseconds. Read via `host.canon.list({type: 'policy', kind: 'pr-observation-freshness-threshold-ms', scope})` at tick start, falling back to the bundled `DEFAULT_FRESHNESS_MS` constant if the atom is absent (substrate stays mechanism-only; the policy is data, not code).

## 6. PR-state terminal handling and idempotence

The tick filters `obs.metadata.pr_state in TERMINAL_PR_STATES` BEFORE calling refresher.refresh(). If the observation already shows MERGED or CLOSED, no refresh is needed; the reconciler will pick it up.

If a refresh produces an observation that is identical to the prior one (same head SHA, same surface counts), the deterministic atom-id makes the put a no-op - `runObserveOnly` already handles `existing !== null` case (`scripts/run-pr-landing.mjs:615-648`), and a second observation re-key by SHA collides with the first. **The fix below addresses this.**

### 6.1 Atom-id stability is the failure mode; supersedes is the fix

The current atom-id formula `pr-observation-${owner}-${repo}-${number}-${shaSuffix}` ties identity to the head SHA. When PR state evolves WITHOUT a new SHA (the merge case), the new observation cannot land because the id is already taken.

**Fix**: extend the atom-id to include a stable revision suffix derived from `(head_sha, observed_at_iso_minute_truncated)`. Specifically: `pr-observation-${owner}-${repo}-${number}-${shaSuffix}-${observedAtSlug}` where `observedAtSlug = observed_at.slice(0, 16).replace(/[:T-]/g, '')` (i.e. minute granularity: `202605011711`). Re-observations within the same minute are idempotent (collision); cross-minute observations get a new id chained via `provenance.derived_from` to the prior observation. The reconciler already filters `superseded_by.length > 0` so when a new observation supersedes an old one (via `host.atoms.update(prior, { superseded_by: [new_id] })`), the reconciler ignores the stale observation.

This is a backward-compatible change. The id grows a stable suffix; existing atoms keep their old ids and are read as-is by the reconciler. New observations after this PR write under the new id format; re-observes work.

### 6.2 Supersedes wiring

`runObserveOnly` after this PR:
1. Compute new atom id with the minute-truncated suffix.
2. If `existing !== null` -> idempotent no-op (within-minute re-observe).
3. If new id is unused but prior observation exists for (owner, repo, number, head_sha) -> write new atom with `provenance.derived_from = [prior.id]`, then `host.atoms.update(prior.id, { superseded_by: [new.id] })`.

The reconciler's existing `if (obs.superseded_by.length > 0) continue;` guard handles the rest.

## 7. Per-tick guard rails

- `maxScan` (default 5_000) bounds plans considered per tick (prevents pathological cases).
- `maxRefreshes` (default 50) bounds the GitHub API spend per tick. Hitting the cap surfaces in audit telemetry as `skipped['rate-limited'] += 1` for the deferred plans; they get refreshed next tick.
- The refresher's `refresh()` is best-effort; failures (network, transient GitHub error) are logged and counted in `skipped['refresh-failed']` but do NOT halt the tick. The next tick re-attempts.
- Plans skipped on `'fresh'` are NOT counted toward refresher cost; the threshold check happens BEFORE the refresher is called.

## 8. Test plan

### 8.1 Unit tests for the framework module (`test/runtime/plans/pr-observation-refresh.test.ts`)

- empty atom store -> `{scanned: 0, refreshed: 0}`, refresher never called
- observation with `pr_state='MERGED'` -> skipped['already-terminal']=1, refresher never called
- observation with no `metadata.plan_id` -> skipped['no-plan-id']=1
- observation with plan_id pointing at a non-existent plan -> skipped['plan-missing']=1
- observation pointing at a plan in `succeeded` -> skipped['plan-not-executing']=1
- observation pointing at a plan in `executing` BUT fresh (within threshold) -> skipped['fresh']=1
- observation pointing at `executing` plan AND stale (`OPEN`, beyond threshold) -> refreshed=1, refresher called once with `{pr: {owner, repo, number}, plan_id}`
- observation with malformed `metadata.pr` (missing owner/repo/number) -> skipped['pr-malformed']=1
- observation with kind != 'pr-observation' -> skipped (not counted; query filter is advisory)
- tainted or superseded observation -> skipped (not counted; advisory in-code guards)
- refresher.refresh throws -> skipped['refresh-failed']=1, tick still returns and continues to next observation
- maxRefreshes=2, 5 stale-eligible observations -> refreshed=2, skipped['rate-limited']=3

### 8.2 Unit tests for atom-id supersedes flow (`test/actors/pr-landing/pr-observation-supersedes.test.ts`)

- mkPrObservationAtomId given (owner, repo, number, sha, observedAt) returns the new minute-truncated form
- Two calls within the same minute -> same id (idempotent)
- Two calls across-minute boundary -> different ids
- runObserveOnly with prior observation under same SHA but earlier minute -> writes new atom with `derived_from = [prior.id]`
- runObserveOnly with prior observation -> updates prior with `superseded_by = [new.id]`
- Reconciler ignores superseded observations (existing test, regression-only)

### 8.3 Integration test for approval-cycle wiring (`test/scripts/run-approval-cycle-with-refresh.test.ts`)

- Mock host + stub refresher; verify the new tick is called between plan-approval and plan-reconcile
- Verify exit code 0 when refresher.refresh throws (failures non-fatal)
- Verify `--no-refresh` flag (or absence of refresher wiring) skips the tick cleanly

### 8.4 Dogfeed validation (post-merge)

After merging the PR:
1. Pull main locally.
2. Mint a new operator-intent atom for a tiny README change via `node scripts/decide.mjs`.
3. Trigger the deep planning pipeline via `node scripts/run-cto-actor.mjs --request "..." --mode=substrate-deep`.
4. Watch for: brainstorm -> spec -> plan -> review -> dispatch -> PR opens.
5. Wait for PR merge (autonomous or operator-driven).
6. Verify `plan_state` transitions to `succeeded` within ONE approval-cycle interval after the merge.
7. Verify the audit chain: Plan -> pr-observation (fresh, MERGED) -> plan-merge-settled.

## 9. Alternatives rejected

### A1: Reconciler-side GitHub query (the original Option B)

Have the reconciler call GitHub directly when it sees a stale OPEN observation past some threshold. Rejected because:
- Couples `src/runtime/plans/pr-merge-reconcile.ts` to a GitHub API client. Substrate purity violation per `dev-substrate-not-prescription` (framework code stays mechanism-only).
- Reconciler becomes responsible for two distinct concerns: state-machine bookkeeping AND PR-state polling. Single-responsibility violation.
- The fix surfaced in PR #274 hit this exact failure mode; CR's first MAJOR finding was "framework code under src/ baking PR-string-parsing into the reconciler".

### A2: Webhook surface (the original Option C)

Subscribe to GitHub `pull_request` events via webhook; write fresh observation atom on `closed` / `merged`. Rejected because:
- No webhook surface exists today; building one is its own infrastructure project (HTTP server, auth, durability, replay).
- The existing approval-cycle tick is already the canonical "advance-plans" loop; adding another I/O channel doubles the substrate's deployment story (run-approval-cycle vs webhook server).
- Indie-floor: a solo developer should not need to expose an HTTPS endpoint to the internet to merge a typo PR. Polling is invisible-by-default.
- Org-ceiling: an org that wants webhook ingestion has the option to ship a custom refresher that translates webhook events into refresh-now signals (e.g. `WebhookDrivenRefresher` in their fork of `scripts/lib/`). The substrate is webhook-ready WITHOUT mandating webhooks.

### A3: Always-write-new-atom (no de-duplication)

Scrap the deterministic-id-by-SHA approach. Every observation gets a fresh UUID-keyed atom. Rejected because:
- Loses the natural idempotence the SHA-keyed id provides (two concurrent observe-only runs within seconds of each other should NOT write two atoms).
- Loses the cheap "did anything change?" check (caller can `host.atoms.get(deterministicId)` to short-circuit).
- The minute-truncated suffix preserves both properties.

### A4: Inline the refresh in the reconciler tick

Have `runPlanStateReconcileTick` call the refresher BEFORE its existing scan. Rejected because:
- Conflates "advance state-machine" with "trigger GitHub I/O" in the same module.
- The refresh+reconcile-as-one-tick blocks the reconcile pass on a slow refresh (each plan refresh is a GitHub API call); refresh-as-its-own-tick keeps each tick's responsibility scoped and the timing budget separable.
- Reduces test isolation: refresh tests would need to mock both the reconciler and the GitHub adapter.

### A5: Mutate the existing observation in place

`host.atoms.update(prior.id, { metadata: {...prior.metadata, pr_state: 'MERGED', observed_at: now}})`. Rejected because:
- Loses provenance: the audit chain becomes `Plan -> observation@Time-N` where observation has been mutated N times, vs. `Plan -> obs1 -> obs2 -> obs3` where each is a discrete event.
- Violates `arch-atom-store-source-of-truth`'s implicit "atoms are immutable observations". Existing pattern is supersedes + chain; the design follows it.
- A consumer reading the atom store at any point in time sees a consistent immutable record.

## 10. What breaks if revisited

If a future maintainer wants to reconsider this design (e.g. swap polling for webhook), the substrate seam (`PrObservationRefresher` interface in framework code) means they re-implement only `scripts/lib/pr-observation-refresher.mjs` (or supply a new file in `scripts/lib/`). The framework module, the reconciler, and the approval-cycle ordering all stay unchanged.

The freshness threshold being a canon atom means a deployment can disable the polling-side cost (set threshold to `Infinity`) without code changes; combined with a webhook-driven refresher, the polling becomes a fallback rather than the primary path.

The minute-truncated atom-id suffix is a permanent contract - once observations are landing under the new id format, the reconciler ignores the older format implicitly (different ids; old atoms still readable but no new ones get written under them). Any future revisit that wants per-second granularity, hash-only ids, or time-free ids ships as a new id-formula version that coexists; the reconciler does not need to know about the format.

## 11. Principles applied

- `dev-substrate-not-prescription`: framework code in `src/` mechanism-only; GitHub adapter in `scripts/lib/`.
- `dev-indie-floor-org-ceiling`: zero-cost when no plans are executing; canon-atom-tunable for org deployments.
- `dev-extreme-rigor-and-research`: PR #274 closed because the original framing was wrong; this design is grounded in the actual observation-freshness failure mode and the existing reconciler's correct behavior.
- `dev-flag-structural-concerns-proactively`: the original PR #274 sub-agent surfaced both MAJOR findings and closed the PR rather than ship the wrong fix; this design takes that work as its starting point.
- `arch-atom-store-source-of-truth`: observations remain immutable; mutation is via supersedes + chain.
- `arch-pr-state-observation-via-actor-only`: refresh routes through `run-pr-landing.mjs --observe-only`, the canonical observation surface; no new GitHub query path.
- `dev-future-tunable-dial-seam`: freshness threshold is a canon policy atom with a sensible default, sized to the existing arbitration stack.
