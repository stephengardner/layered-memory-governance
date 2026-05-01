# PR-Observation Re-Observe Mechanism Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close substrate gap #8 - plans stuck in `executing` after their PR merges/closes - by adding a periodic re-observe tick that writes a fresh `pr-observation` atom whose terminal `pr_state` is then picked up by the existing `pr-merge-reconcile` tick.

**Architecture:** New mechanism-only framework module `src/runtime/plans/pr-observation-refresh.ts` exposing `runPlanObservationRefreshTick(host, refresher, options)`. The framework module never touches GitHub or shells; the deployment-side adapter `scripts/lib/pr-observation-refresher.mjs` spawns `run-pr-landing.mjs --observe-only` to do the actual fresh observation. Atom-id revision (minute-truncated suffix) so the new observation lands under a fresh deterministic id and supersedes the prior one.

**Tech Stack:** TypeScript (framework), Node ESM (.mjs scripts), Vitest, existing FileHost / MemoryHost adapters, existing `host.atoms.query` / `host.atoms.put` / `host.atoms.update` substrate seams.

---

## Spec reference

`docs/superpowers/specs/2026-05-01-pr-observation-re-observe-mechanism-design.md`

## File structure

| File | Status | Responsibility |
|------|--------|----------------|
| `src/runtime/plans/pr-observation-refresh.ts` | Create | Framework module: tick + refresher interface |
| `test/runtime/plans/pr-observation-refresh.test.ts` | Create | Unit tests for the tick |
| `src/runtime/actors/pr-landing/pr-observation.ts` | Modify | Atom-id formula gains minute-truncated suffix |
| `test/actors/pr-observation.test.ts` | Modify | Tests for the new id formula |
| `scripts/run-pr-landing.mjs` | Modify | runObserveOnly: write fresh atom + supersede prior |
| `scripts/lib/pr-observation-refresher.mjs` | Create | Deployment-side adapter that spawns run-pr-landing |
| `scripts/run-approval-cycle.mjs` | Modify | Wire the new tick between plan-approval and plan-reconcile |
| `scripts/bootstrap-workflow-canon.mjs` | Modify | Bootstrap the freshness-threshold canon atom |

---

### Task 1: Add the freshness-threshold canon atom shape and reader

**Files:**
- Create: `src/runtime/plans/pr-observation-refresh.ts` (initial scaffold + canon reader)
- Test: `test/runtime/plans/pr-observation-refresh.test.ts`

**Security + correctness considerations:**
- Reader must default to a sensible value when no canon atom exists (substrate stays mechanism-only; data is policy).
- Reader must reject non-numeric / non-positive values from a malformed canon atom rather than silently using zero.
- `Number.isFinite` check rejects `NaN`/`Infinity` from a malformed JSON payload before the value is used.

- [ ] **Step 1.1: Write the failing test for the freshness reader**

```ts
// test/runtime/plans/pr-observation-refresh.test.ts (new file)
import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import { readPrObservationFreshnessMs, DEFAULT_FRESHNESS_MS } from '../../../src/runtime/plans/pr-observation-refresh.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../src/types.js';

const NOW = '2026-05-01T00:00:00.000Z' as Time;

function policyAtom(id: string, value: unknown): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'policy',
    type: 'directive',
    layer: 'L3',
    provenance: { kind: 'operator-seeded', source: { agent_id: 'bootstrap' }, derived_from: [] },
    confidence: 1,
    created_at: NOW,
    last_reinforced_at: NOW,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
    principal_id: 'apex-agent' as PrincipalId,
    taint: 'clean',
    metadata: { policy: { subject: 'pr-observation-freshness-threshold-ms', value } },
  };
}

describe('readPrObservationFreshnessMs', () => {
  it('returns DEFAULT_FRESHNESS_MS when no canon atom exists', async () => {
    const host = createMemoryHost();
    const result = await readPrObservationFreshnessMs(host);
    expect(result).toBe(DEFAULT_FRESHNESS_MS);
  });
  it('returns the configured value when a valid canon atom exists', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-pr-observation-freshness-threshold-ms', 60_000));
    const result = await readPrObservationFreshnessMs(host);
    expect(result).toBe(60_000);
  });
  it('falls back to default when the canon atom value is not a finite positive number', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-malformed', 'not-a-number'));
    const result = await readPrObservationFreshnessMs(host);
    expect(result).toBe(DEFAULT_FRESHNESS_MS);
  });
  it('falls back to default when the canon atom value is zero or negative', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-zero', 0));
    expect(await readPrObservationFreshnessMs(host)).toBe(DEFAULT_FRESHNESS_MS);
  });
  it('ignores tainted or superseded canon atoms', async () => {
    const host = createMemoryHost();
    const a = policyAtom('pol-tainted', 60_000);
    await host.atoms.put({ ...a, taint: 'tainted' });
    expect(await readPrObservationFreshnessMs(host)).toBe(DEFAULT_FRESHNESS_MS);
  });
});
```

- [ ] **Step 1.2: Run the failing test**

Run: `npx vitest run test/runtime/plans/pr-observation-refresh.test.ts`
Expected: FAIL with "Cannot find module '../../../src/runtime/plans/pr-observation-refresh.js'"

- [ ] **Step 1.3: Implement the framework module scaffold**

```ts
// src/runtime/plans/pr-observation-refresh.ts (new file)
/**
 * PR-observation refresh tick.
 *
 * Closes substrate gap #8 - plans stuck in plan_state='executing'
 * after their PR merges or closes because the only pr-observation
 * atom for the PR was written ONCE at PR-creation time and carries
 * `pr_state='OPEN'`. This module's tick scans pr-observation atoms
 * still showing non-terminal pr_state, filters to those whose linked
 * Plan is still `executing`, and asks a pluggable refresher to write
 * a fresh observation atom. The existing pr-merge-reconcile tick
 * then transitions the plan on the next pass.
 *
 * Substrate purity: this module never imports a GitHub adapter, never
 * shells out, never parses a PR number from a string. The pluggable
 * `PrObservationRefresher` seam takes structured `{owner, repo,
 * number}` data read from the observation atom's `metadata.pr` field;
 * the deployment-side adapter (scripts/lib/...) does the actual
 * GitHub query.
 *
 * Per-tick fairness: maxRefreshes bounds GitHub API spend per tick;
 * deferred plans get refreshed next tick.
 */
import type { Host } from '../../interface.js';
import type { Atom, Time } from '../../types.js';

/** Default freshness threshold: 5 minutes. */
export const DEFAULT_FRESHNESS_MS = 5 * 60 * 1_000;

/**
 * Read the configured freshness threshold from canon. Falls back to
 * DEFAULT_FRESHNESS_MS when no policy atom exists or the value is
 * malformed. Substrate stays mechanism-only; the threshold is data.
 */
export async function readPrObservationFreshnessMs(host: Host): Promise<number> {
  const PAGE_SIZE = 200;
  let cursor: string | undefined;
  do {
    const page = await host.atoms.query({ type: ['directive'] }, PAGE_SIZE, cursor);
    for (const atom of page.atoms) {
      if (atom.taint !== 'clean') continue;
      if (atom.superseded_by.length > 0) continue;
      const meta = atom.metadata as Record<string, unknown>;
      const policy = meta.policy as Record<string, unknown> | undefined;
      if (!policy || policy.subject !== 'pr-observation-freshness-threshold-ms') continue;
      const value = policy.value;
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
      return value;
    }
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);
  return DEFAULT_FRESHNESS_MS;
}
```

- [ ] **Step 1.4: Build and run the test**

Run: `npm run build && npx vitest run test/runtime/plans/pr-observation-refresh.test.ts`
Expected: 5 PASSING tests for the freshness reader.

- [ ] **Step 1.5: Commit**

```bash
git add src/runtime/plans/pr-observation-refresh.ts test/runtime/plans/pr-observation-refresh.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(plans): add pr-observation freshness threshold canon reader"
```

---

### Task 2: Implement the refresh tick

**Files:**
- Modify: `src/runtime/plans/pr-observation-refresh.ts` (add tick)
- Modify: `test/runtime/plans/pr-observation-refresh.test.ts` (add tick tests)

**Security + correctness considerations:**
- The pr object from `metadata.pr` MUST be validated before being passed to refresher.refresh - a malformed metadata payload (missing `owner`, non-numeric `number`) should be skipped, not crash the tick.
- Refresher.refresh failures must not halt the whole tick (one bad PR should not block 50 healthy ones). Wrap each refresh in try/catch, count in `skipped['refresh-failed']`, continue.
- maxRefreshes bound is checked BEFORE the refresh call so a runaway list does not flood GitHub.
- Fresh check uses `nowFn()` to allow test injection of deterministic time.
- The query is `type: ['observation']` (not the entire atom store) to bound scan cost.

- [ ] **Step 2.1: Write the failing tick tests**

Add to `test/runtime/plans/pr-observation-refresh.test.ts`:

```ts
import { runPlanObservationRefreshTick } from '../../../src/runtime/plans/pr-observation-refresh.js';
import type { PlanState } from '../../../src/types.js';

const T0 = '2026-05-01T00:00:00.000Z' as Time;
const T_OLD = '2026-05-01T00:00:00.000Z' as Time;
const T_NOW = '2026-05-01T01:00:00.000Z' as Time;  // 1 hour later

function planAtom(id: string, plan_state: PlanState): Atom {
  return {
    schema_version: 1, id: id as AtomId, content: 'plan', type: 'plan', layer: 'L1',
    provenance: { kind: 'agent-observed', source: { agent_id: 'cto-actor' }, derived_from: [] },
    confidence: 0.9, created_at: T0, last_reinforced_at: T0, expires_at: null,
    supersedes: [], superseded_by: [], scope: 'project',
    signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
    principal_id: 'cto-actor' as PrincipalId, taint: 'clean',
    plan_state, metadata: {},
  };
}

function obsAtom(id: string, opts: {
  plan_id?: string | null; pr_state?: string; observed_at?: string;
  pr?: Record<string, unknown>; superseded?: boolean; tainted?: boolean; kind?: string;
} = {}): Atom {
  return {
    schema_version: 1, id: id as AtomId, content: 'pr-observation', type: 'observation', layer: 'L1',
    provenance: { kind: 'agent-observed', source: { agent_id: 'pr-landing-agent' }, derived_from: [] },
    confidence: 1, created_at: T_OLD, last_reinforced_at: T_OLD, expires_at: null,
    supersedes: [], superseded_by: opts.superseded ? ['x' as AtomId] : [], scope: 'project',
    signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
    principal_id: 'pr-landing-agent' as PrincipalId, taint: opts.tainted ? 'tainted' : 'clean',
    metadata: {
      kind: opts.kind ?? 'pr-observation',
      pr: opts.pr ?? { owner: 'foo', repo: 'bar', number: 1 },
      pr_state: opts.pr_state ?? 'OPEN',
      observed_at: opts.observed_at ?? T_OLD,
      ...(opts.plan_id !== undefined ? { plan_id: opts.plan_id } : { plan_id: 'p1' }),
    },
  };
}

describe('runPlanObservationRefreshTick', () => {
  const nowFn = () => T_NOW;
  function makeRefresher() {
    const calls: Array<{ pr: unknown; plan_id: string }> = [];
    return {
      calls,
      refresh: async (args: { pr: unknown; plan_id: string }) => { calls.push(args); },
    };
  }

  it('returns zero counts on empty store', async () => {
    const host = createMemoryHost();
    const r = await runPlanObservationRefreshTick(host, makeRefresher(), { now: nowFn });
    expect(r).toEqual({ scanned: 0, refreshed: 0, skipped: {} });
  });

  it('refreshes a stale OPEN observation linked to executing plan', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1', 'executing'));
    await host.atoms.put(obsAtom('o1'));
    const refresher = makeRefresher();
    const r = await runPlanObservationRefreshTick(host, refresher, { now: nowFn });
    expect(r.refreshed).toBe(1);
    expect(refresher.calls).toEqual([{ pr: { owner: 'foo', repo: 'bar', number: 1 }, plan_id: 'p1' }]);
  });

  it('skips terminal pr_state', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1', 'executing'));
    await host.atoms.put(obsAtom('o1', { pr_state: 'MERGED' }));
    const refresher = makeRefresher();
    const r = await runPlanObservationRefreshTick(host, refresher, { now: nowFn });
    expect(r.refreshed).toBe(0);
    expect(r.skipped['already-terminal']).toBe(1);
    expect(refresher.calls).toEqual([]);
  });

  it('skips fresh observation', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1', 'executing'));
    await host.atoms.put(obsAtom('o1', { observed_at: T_NOW }));
    const r = await runPlanObservationRefreshTick(host, makeRefresher(), { now: nowFn });
    expect(r.skipped['fresh']).toBe(1);
  });

  it('skips when linked plan is not in executing', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1', 'succeeded'));
    await host.atoms.put(obsAtom('o1'));
    const r = await runPlanObservationRefreshTick(host, makeRefresher(), { now: nowFn });
    expect(r.skipped['plan-not-executing']).toBe(1);
  });

  it('skips when no plan_id on observation', async () => {
    const host = createMemoryHost();
    await host.atoms.put(obsAtom('o1', { plan_id: null }));
    const r = await runPlanObservationRefreshTick(host, makeRefresher(), { now: nowFn });
    expect(r.skipped['no-plan-id']).toBe(1);
  });

  it('skips when plan referenced does not exist', async () => {
    const host = createMemoryHost();
    await host.atoms.put(obsAtom('o1', { plan_id: 'missing' }));
    const r = await runPlanObservationRefreshTick(host, makeRefresher(), { now: nowFn });
    expect(r.skipped['plan-missing']).toBe(1);
  });

  it('skips when pr metadata is malformed', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1', 'executing'));
    await host.atoms.put(obsAtom('o1', { pr: { owner: 'foo' } }));  // missing repo+number
    const r = await runPlanObservationRefreshTick(host, makeRefresher(), { now: nowFn });
    expect(r.skipped['pr-malformed']).toBe(1);
  });

  it('counts refresh failures and continues', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1', 'executing'));
    await host.atoms.put(planAtom('p2', 'executing'));
    await host.atoms.put(obsAtom('o1', { plan_id: 'p1' }));
    await host.atoms.put(obsAtom('o2', { plan_id: 'p2', pr: { owner: 'b', repo: 'c', number: 2 } }));
    let calls = 0;
    const refresher = {
      refresh: async () => { calls += 1; if (calls === 1) throw new Error('boom'); },
    };
    const r = await runPlanObservationRefreshTick(host, refresher, { now: nowFn });
    expect(r.skipped['refresh-failed']).toBe(1);
    expect(r.refreshed).toBe(1);
  });

  it('respects maxRefreshes', async () => {
    const host = createMemoryHost();
    for (let i = 1; i <= 3; i++) {
      await host.atoms.put(planAtom(`p${i}`, 'executing'));
      await host.atoms.put(obsAtom(`o${i}`, { plan_id: `p${i}`, pr: { owner: 'a', repo: 'b', number: i } }));
    }
    const refresher = makeRefresher();
    const r = await runPlanObservationRefreshTick(host, refresher, { now: nowFn, maxRefreshes: 2 });
    expect(r.refreshed).toBe(2);
    expect(r.skipped['rate-limited']).toBe(1);
  });

  it('ignores observations with kind != pr-observation', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1', 'executing'));
    await host.atoms.put(obsAtom('o1', { kind: 'something-else' }));
    const r = await runPlanObservationRefreshTick(host, makeRefresher(), { now: nowFn });
    expect(r.refreshed).toBe(0);
  });

  it('ignores tainted or superseded observations', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planAtom('p1', 'executing'));
    await host.atoms.put(obsAtom('o1', { tainted: true }));
    await host.atoms.put(obsAtom('o2', { plan_id: 'p1', superseded: true }));
    const r = await runPlanObservationRefreshTick(host, makeRefresher(), { now: nowFn });
    expect(r.refreshed).toBe(0);
  });
});
```

- [ ] **Step 2.2: Verify the tests fail**

Run: `npx vitest run test/runtime/plans/pr-observation-refresh.test.ts`
Expected: 11 failing tests for `runPlanObservationRefreshTick is not a function`.

- [ ] **Step 2.3: Implement the tick**

Append to `src/runtime/plans/pr-observation-refresh.ts`:

```ts
const TERMINAL_PR_STATES: ReadonlySet<string> = new Set(['MERGED', 'CLOSED']);

/** Structured PR reference read directly from observation metadata. */
export interface PrRef {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

export interface PrObservationRefresher {
  /** Trigger a fresh observation for the given PR + plan. Errors are
   *  caught by the tick and counted as skipped['refresh-failed']. */
  refresh(args: { readonly pr: PrRef; readonly plan_id: string }): Promise<void>;
}

export interface PlanObservationRefreshOptions {
  readonly now?: () => string | Time | number;
  /** Maximum atoms scanned per tick; defaults to 5000. */
  readonly maxScan?: number;
  /** Maximum refresh calls per tick; defaults to 50. */
  readonly maxRefreshes?: number;
  /** Override the freshness threshold; otherwise read from canon. */
  readonly freshnessMsOverride?: number;
}

export interface PlanObservationRefreshResult {
  readonly scanned: number;
  readonly refreshed: number;
  readonly skipped: Record<string, number>;
}

function isPrRef(value: unknown): value is PrRef {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.owner === 'string' && v.owner.length > 0
    && typeof v.repo === 'string' && v.repo.length > 0
    && typeof v.number === 'number' && Number.isFinite(v.number) && v.number > 0;
}

function toMs(value: string | Time | number): number {
  if (typeof value === 'number') return value;
  return new Date(value).getTime();
}

export async function runPlanObservationRefreshTick(
  host: Host,
  refresher: PrObservationRefresher,
  options: PlanObservationRefreshOptions = {},
): Promise<PlanObservationRefreshResult> {
  const nowFn = options.now ?? (() => new Date().toISOString());
  const nowMs = toMs(nowFn());
  const MAX_SCAN = options.maxScan ?? 5_000;
  const MAX_REFRESHES = options.maxRefreshes ?? 50;
  const freshnessMs = options.freshnessMsOverride ?? await readPrObservationFreshnessMs(host);

  const PAGE_SIZE = 500;
  let scanned = 0;
  let refreshed = 0;
  const skipped: Record<string, number> = {};
  const bump = (k: string) => { skipped[k] = (skipped[k] ?? 0) + 1; };

  let cursor: string | undefined;
  outer: do {
    const remaining = MAX_SCAN - scanned;
    if (remaining <= 0) break;
    const page = await host.atoms.query(
      { type: ['observation'] },
      Math.min(PAGE_SIZE, remaining),
      cursor,
    );
    for (const obs of page.atoms) {
      scanned += 1;
      if (obs.taint !== 'clean') continue;
      if (obs.superseded_by.length > 0) continue;
      const meta = obs.metadata as Record<string, unknown>;
      if (meta.kind !== 'pr-observation') continue;
      const prState = meta.pr_state;
      if (typeof prState === 'string' && TERMINAL_PR_STATES.has(prState)) {
        bump('already-terminal');
        continue;
      }
      const planIdRaw = meta.plan_id;
      if (typeof planIdRaw !== 'string' || planIdRaw.length === 0) {
        bump('no-plan-id');
        continue;
      }
      const observedAtRaw = meta.observed_at;
      if (typeof observedAtRaw !== 'string' && typeof observedAtRaw !== 'number') {
        bump('observed-at-malformed');
        continue;
      }
      const observedAtMs = toMs(observedAtRaw as string | number);
      if (!Number.isFinite(observedAtMs)) {
        bump('observed-at-malformed');
        continue;
      }
      if (nowMs - observedAtMs < freshnessMs) {
        bump('fresh');
        continue;
      }
      const plan = await host.atoms.get(planIdRaw as Atom['id']);
      if (plan === null) { bump('plan-missing'); continue; }
      if (plan.type !== 'plan') { bump('plan-missing'); continue; }
      if (plan.taint !== 'clean') { bump('plan-tainted'); continue; }
      if (plan.superseded_by.length > 0) { bump('plan-superseded'); continue; }
      if (plan.plan_state !== 'executing') { bump('plan-not-executing'); continue; }
      const pr = meta.pr;
      if (!isPrRef(pr)) { bump('pr-malformed'); continue; }
      if (refreshed >= MAX_REFRESHES) {
        bump('rate-limited');
        continue;
      }
      try {
        await refresher.refresh({ pr, plan_id: planIdRaw });
        refreshed += 1;
      } catch (err) {
        bump('refresh-failed');
        // Continue to next observation. The tick is best-effort; a
        // single transport failure must not halt the whole pass.
      }
    }
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
    if (refreshed >= MAX_REFRESHES) {
      // We still want to count remaining stale observations as
      // rate-limited so operators see the backlog. Continue iterating
      // pages but skip the refresh call (handled above).
    }
  } while (cursor !== undefined);

  return { scanned, refreshed, skipped };
}
```

- [ ] **Step 2.4: Build and run all tests in this file**

Run: `npm run build && npx vitest run test/runtime/plans/pr-observation-refresh.test.ts`
Expected: All 16 tests pass (5 reader + 11 tick).

- [ ] **Step 2.5: Run a canon-audit check**

Per `dev-implementation-canon-audit-loop`: re-read `CLAUDE.md` directives, especially `dev-substrate-not-prescription`, `arch-pr-state-observation-via-actor-only`. Verify:
- No GitHub adapter imports in `src/runtime/plans/pr-observation-refresh.ts`. (grep for `execa`, `gh`, `@octokit`)
- No string-parsing of PR numbers from summaries. (grep for `parseInt`, `match\(`, `\bsplit\b`)
- Refresher receives structured `{owner, repo, number}` only.

Run: `grep -E "execa|@octokit|gh-as|\\.split\\(|parseInt" src/runtime/plans/pr-observation-refresh.ts`
Expected: No matches.

- [ ] **Step 2.6: Commit**

```bash
git add src/runtime/plans/pr-observation-refresh.ts test/runtime/plans/pr-observation-refresh.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(plans): runPlanObservationRefreshTick to surface stale OPEN observations"
```

---

### Task 3: Atom-id revision (minute-truncated suffix)

**Files:**
- Modify: `src/runtime/actors/pr-landing/pr-observation.ts`
- Modify: `test/actors/pr-landing.test.ts` (or create a focused id test)

**Security + correctness considerations:**
- The new id formula MUST stay deterministic - two calls with the same (owner, repo, number, sha, observedAt-truncated-to-minute) produce the same id.
- The minute truncation must use UTC to avoid host-timezone variance.
- The new id must be syntactically valid as an AtomId (no spaces, no special characters that would break filesystem paths in the file adapter).
- Backward compatibility: a legacy atom written under the SHA-only id is still readable by `host.atoms.get(legacyId)`. The reconciler's superseded_by guard handles supersession when the new id replaces it.

- [ ] **Step 3.1: Write the failing tests for the new id formula**

Create or extend `test/actors/pr-landing.test.ts` (use a focused id test if the existing file does not own this concern):

```ts
import { describe, expect, it } from 'vitest';
import { mkPrObservationAtomId } from '../../src/runtime/actors/pr-landing/pr-observation.js';
import type { Time } from '../../src/types.js';

describe('mkPrObservationAtomId', () => {
  it('produces a deterministic id from (owner, repo, number, headSha, observedAt)', () => {
    const t1 = '2026-05-01T17:11:34.681Z' as Time;
    const id1 = mkPrObservationAtomId('foo', 'bar', 273, 'aabbccddeeff112233445566', t1);
    const id2 = mkPrObservationAtomId('foo', 'bar', 273, 'aabbccddeeff112233445566', t1);
    expect(id1).toBe(id2);
  });
  it('truncates observedAt to UTC minute granularity', () => {
    const tStart = '2026-05-01T17:11:00.000Z' as Time;
    const tMid = '2026-05-01T17:11:34.681Z' as Time;
    const tEnd = '2026-05-01T17:11:59.999Z' as Time;
    const id1 = mkPrObservationAtomId('foo', 'bar', 273, 'aabbccddeeff', tStart);
    const id2 = mkPrObservationAtomId('foo', 'bar', 273, 'aabbccddeeff', tMid);
    const id3 = mkPrObservationAtomId('foo', 'bar', 273, 'aabbccddeeff', tEnd);
    expect(id1).toBe(id2);
    expect(id2).toBe(id3);
  });
  it('produces a different id across the minute boundary', () => {
    const t1 = '2026-05-01T17:11:59.999Z' as Time;
    const t2 = '2026-05-01T17:12:00.000Z' as Time;
    expect(mkPrObservationAtomId('foo', 'bar', 273, 'aabbccddeeff', t1))
      .not.toBe(mkPrObservationAtomId('foo', 'bar', 273, 'aabbccddeeff', t2));
  });
  it('id contains the head sha prefix and minute slug', () => {
    const t = '2026-05-01T17:11:34.681Z' as Time;
    const id = mkPrObservationAtomId('foo', 'bar', 273, 'aabbccddeeff112233', t);
    expect(id).toContain('foo-bar-273');
    expect(id).toContain('aabbccddeeff');
    expect(id).toContain('202605011711');
  });
  it('id has no spaces or filesystem-hostile characters', () => {
    const t = '2026-05-01T17:11:34.681Z' as Time;
    const id = mkPrObservationAtomId('foo', 'bar', 273, 'aabbccddeeff', t);
    expect(/^[a-zA-Z0-9-]+$/.test(id)).toBe(true);
  });
});
```

- [ ] **Step 3.2: Verify the tests fail**

Run: `npx vitest run test/actors/pr-landing.test.ts -t mkPrObservationAtomId`
Expected: FAIL - current `mkPrObservationAtomId` signature does not accept observedAt.

- [ ] **Step 3.3: Update the id formula**

In `src/runtime/actors/pr-landing/pr-observation.ts`, update `mkPrObservationAtomId`:

```ts
/**
 * Deterministic id keyed on head SHA AND minute-truncated observation
 * time. The SHA prefix gives within-commit idempotence; the minute slug
 * gives across-minute distinctness so a state-transition observation
 * (OPEN -> MERGED on the same head SHA) can land under a fresh id and
 * supersede the prior one. Two observations within the same minute
 * collapse to the same id (idempotent re-observe).
 */
export function mkPrObservationAtomId(
  owner: string,
  repo: string,
  number: number,
  headSha: string,
  observedAt: Time,
): AtomId {
  const shaSuffix = String(headSha).slice(0, 12);
  // UTC-only slug. observedAt is an ISO-8601 string; truncate to minute
  // (16 chars: YYYY-MM-DDTHH:MM) and strip non-alphanumerics to keep
  // the id filesystem-safe.
  const minute = String(observedAt).slice(0, 16);
  const minuteSlug = minute.replace(/[^0-9]/g, '');
  return `pr-observation-${owner}-${repo}-${number}-${shaSuffix}-${minuteSlug}` as AtomId;
}
```

Update the JSDoc comment and import for `Time` if not already imported.

- [ ] **Step 3.4: Update all callers of mkPrObservationAtomId**

Search for callers and update them to pass `observedAt`:

```bash
grep -rn "mkPrObservationAtomId" src/ scripts/ test/
```

For each caller (likely `scripts/run-pr-landing.mjs`, possibly some tests), pass the observedAt argument that already exists in scope.

In `scripts/run-pr-landing.mjs` around line 608:

```js
// BEFORE:
const atomId = mkPrObservationAtomId(owner, repo, number, headSha);

// AFTER:
const nowIso = new Date().toISOString();   // existing variable
const atomId = mkPrObservationAtomId(owner, repo, number, headSha, nowIso);
```

The `nowIso` variable is already computed below; move its declaration above the atomId line.

- [ ] **Step 3.5: Build and run all id tests**

Run: `npm run build && npx vitest run test/actors/pr-landing.test.ts -t mkPrObservationAtomId`
Expected: All 5 id tests pass.

Run: `npx vitest run test/`
Expected: Full suite passes (or the only failures are call-site updates we're about to make).

- [ ] **Step 3.6: Commit**

```bash
git add src/runtime/actors/pr-landing/pr-observation.ts test/actors/pr-landing.test.ts scripts/run-pr-landing.mjs
node scripts/git-as.mjs lag-ceo commit -m "feat(pr-landing): minute-truncated suffix on pr-observation atom-id"
```

---

### Task 4: runObserveOnly writes new atom + supersedes prior

**Files:**
- Modify: `scripts/run-pr-landing.mjs`

**Security + correctness considerations:**
- Look up the prior observation via `findPriorObservationId` (already exists in this file). When found, the new atom's `provenance.derived_from` includes prior id; after the new atom is written, the prior is updated with `superseded_by: [new_id]`.
- The supersede-on-prior step must NOT happen if the atom is the same id (within-minute idempotence). Compare ids first.
- Race-safe: if two concurrent observe-only runs cross the minute boundary at the same time, both compute the same new id; second loses on `host.atoms.put` ConflictError; the existing catch already handles this.
- The supersede update is best-effort (a transient host failure shouldn't fail the whole observation); log on failure but continue.

- [ ] **Step 4.1: Write a failing integration test**

Create `test/scripts/run-pr-landing-supersedes.test.ts` (or add to an existing pr-landing observe-only test file):

```ts
import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { mkPrObservationAtom, mkPrObservationAtomId } from '../../src/runtime/actors/pr-landing/pr-observation.js';
import type { AtomId, PrincipalId, Time } from '../../src/types.js';

// Test: writing a new observation atom with derived_from = [prior]
// triggers supersession on the prior atom.
describe('pr-observation supersedes flow', () => {
  it('supersedes the prior observation when a new atom chains via derived_from', async () => {
    const host = createMemoryHost();
    const principal = { id: 'pr-landing-agent' as PrincipalId } as never;
    const prT0 = '2026-05-01T17:11:00.000Z' as Time;
    const prT1 = '2026-05-01T17:13:00.000Z' as Time;  // new minute
    const sha = 'aabbccddeeff112233';
    const id0 = mkPrObservationAtomId('foo', 'bar', 1, sha, prT0);
    const id1 = mkPrObservationAtomId('foo', 'bar', 1, sha, prT1);
    expect(id0).not.toBe(id1);
    // Assume runObserveOnly logic exists (will be added in 4.2). For
    // this unit-level test, simulate the supersede flow directly:
    await host.atoms.put(mkPrObservationAtom({
      atomId: id0, principal, owner: 'foo', repo: 'bar', number: 1, headSha: sha,
      status: { partial: false, partialSurfaces: [], submittedReviews: [], checkRuns: [], legacyStatuses: [], lineComments: [], bodyNits: [], mergeable: true, mergeStateStatus: 'BLOCKED', prState: 'OPEN' } as never,
      body: 'old', observedAt: prT0, priorId: null,
    }));
    await host.atoms.put(mkPrObservationAtom({
      atomId: id1, principal, owner: 'foo', repo: 'bar', number: 1, headSha: sha,
      status: { partial: false, partialSurfaces: [], submittedReviews: [], checkRuns: [], legacyStatuses: [], lineComments: [], bodyNits: [], mergeable: true, mergeStateStatus: 'BLOCKED', prState: 'MERGED' } as never,
      body: 'new', observedAt: prT1, priorId: id0,
    }));
    // The supersedes step in runObserveOnly:
    await host.atoms.update(id0, { superseded_by: [id1] });
    const oldAtom = await host.atoms.get(id0);
    expect(oldAtom?.superseded_by).toEqual([id1]);
  });
});
```

- [ ] **Step 4.2: Verify the test fails or already passes**

Run: `npx vitest run test/scripts/run-pr-landing-supersedes.test.ts`

Expected: PASS (the framework already supports this; the test pins the expected behavior). If the test fails, fix the framework; if it passes, the test serves as regression guard.

- [ ] **Step 4.3: Update runObserveOnly to wire the supersedes step**

In `scripts/run-pr-landing.mjs`, update `runObserveOnly` (around line 608-648):

```js
// BEFORE: nowIso is computed AFTER atomId (line 611). After Task 3
// it's already moved above so atomId can use it. Confirm:
const nowIso = new Date().toISOString();
const atomId = mkPrObservationAtomId(owner, repo, number, headSha, nowIso);
const existing = await host.atoms.get(atomId);

const body = renderPrObservationBody({ owner, repo, number, status, headSha, observedAt: nowIso });

let atomWritten = false;
if (existing === null) {
  // Look up the most recent prior observation for this PR (any
  // SHA, any minute) so the new atom chains via derived_from AND
  // we can flip the prior's superseded_by after a successful put.
  const priorId = await findPriorObservationId({ host, owner, repo, number, skipId: atomId });
  const atom = mkPrObservationAtom({
    atomId,
    principal,
    owner, repo, number, headSha, status, body, observedAt: nowIso,
    origin, priorId,
    ...(planId ? { planId } : {}),
  });
  try {
    await host.atoms.put(atom);
    atomWritten = true;
    console.log(`[pr-landing:observe-only] wrote pr-observation atom ${atomId}`);

    // Supersede the prior observation. Best-effort: a failure here
    // means the prior atom remains visible to the reconciler; the
    // next observe will pick up where this left off. Do not fail
    // the whole run for a supersede miss.
    if (priorId && priorId !== atomId) {
      try {
        await host.atoms.update(priorId, { superseded_by: [atomId] });
        console.log(`[pr-landing:observe-only] superseded prior atom ${priorId}`);
      } catch (sErr) {
        console.warn(`[pr-landing:observe-only] failed to supersede prior atom ${priorId}: ${sErr?.message ?? sErr}`);
      }
    }
  } catch (err) {
    const code = err?.code ?? err?.kind;
    if (code === 'conflict' || /already exists/i.test(String(err?.message ?? ''))) {
      console.log(`[pr-landing:observe-only] pr-observation atom ${atomId} already exists for head ${headSha} (won by a concurrent run); not reposting`);
    } else {
      throw err;
    }
  }
} else {
  console.log(`[pr-landing:observe-only] pr-observation atom ${atomId} already exists for head ${headSha}; not reposting`);
}
```

- [ ] **Step 4.4: Build + run the targeted test**

Run: `npm run build && npx vitest run test/scripts/run-pr-landing-supersedes.test.ts`
Expected: PASS.

- [ ] **Step 4.5: Run full test suite to catch regressions**

Run: `npx vitest run test/`
Expected: All tests pass.

- [ ] **Step 4.6: Commit**

```bash
git add scripts/run-pr-landing.mjs test/scripts/run-pr-landing-supersedes.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(pr-landing): supersede prior pr-observation when fresh observation lands"
```

---

### Task 5: Deployment-side refresher adapter

**Files:**
- Create: `scripts/lib/pr-observation-refresher.mjs`
- Create: `test/scripts/lib/pr-observation-refresher.test.ts` (helper-only test, no spawn)

**Security + correctness considerations:**
- The adapter MUST validate inputs: `pr.owner`, `pr.repo`, `pr.number`, `plan_id` are non-empty strings/positive number. Otherwise reject loudly.
- The spawn argument list MUST NOT include shell-interpolation: use `execa` array form, not `execa('sh', ...)`. (`execa` defaults to no-shell which is correct.)
- `pr.number` MUST be `String(pr.number)` cast at the spawn boundary (execa rejects non-string args silently in some versions).
- Spawn timeout: bound at 90s per refresh call (an over-long observe shouldn't block the whole approval-cycle tick; the next tick will retry).
- Refresher errors propagate via the rejected promise; the tick already catches and counts.

- [ ] **Step 5.1: Write the failing helper test**

```ts
// test/scripts/lib/pr-observation-refresher.test.ts (new file)
import { describe, expect, it } from 'vitest';
import { validateRefreshArgs } from '../../../scripts/lib/pr-observation-refresher.mjs';

describe('validateRefreshArgs', () => {
  it('accepts a well-formed refresh args object', () => {
    expect(validateRefreshArgs({ pr: { owner: 'a', repo: 'b', number: 1 }, plan_id: 'p' })).toBe(true);
  });
  it('rejects missing owner', () => {
    expect(() => validateRefreshArgs({ pr: { owner: '', repo: 'b', number: 1 }, plan_id: 'p' })).toThrow();
  });
  it('rejects non-positive number', () => {
    expect(() => validateRefreshArgs({ pr: { owner: 'a', repo: 'b', number: 0 }, plan_id: 'p' })).toThrow();
    expect(() => validateRefreshArgs({ pr: { owner: 'a', repo: 'b', number: -1 }, plan_id: 'p' })).toThrow();
  });
  it('rejects empty plan_id', () => {
    expect(() => validateRefreshArgs({ pr: { owner: 'a', repo: 'b', number: 1 }, plan_id: '' })).toThrow();
  });
});
```

- [ ] **Step 5.2: Verify it fails with module-not-found**

Run: `npx vitest run test/scripts/lib/pr-observation-refresher.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 5.3: Implement the refresher**

```js
// scripts/lib/pr-observation-refresher.mjs (new file)
/**
 * PR-observation refresher: deployment-side adapter that the
 * approval-cycle's runPlanObservationRefreshTick uses to write a
 * fresh observation atom when the existing one is stale.
 *
 * Spawns `node scripts/run-pr-landing.mjs --observe-only --live` for
 * each (pr, plan_id) the tick surfaces. The substrate stays mechanism-
 * only (src/runtime/plans/pr-observation-refresh.ts); this module
 * carries the GitHub-shaped concern per dev-substrate-not-prescription.
 *
 * Best-effort: spawn failures bubble as a rejected Promise; the tick
 * counts them as skipped['refresh-failed'] and moves on.
 */
import { execa } from 'execa';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_PR_LANDING = resolve(HERE, '..', 'run-pr-landing.mjs');

/**
 * Loud validation guard. Called by refresh() AND exported so unit
 * tests can pin the contract without spawning a child process.
 */
export function validateRefreshArgs(args) {
  if (!args || typeof args !== 'object') {
    throw new Error('refresh: args must be an object');
  }
  const { pr, plan_id } = args;
  if (!pr || typeof pr !== 'object') {
    throw new Error('refresh: args.pr must be an object {owner, repo, number}');
  }
  if (typeof pr.owner !== 'string' || pr.owner.length === 0) {
    throw new Error('refresh: pr.owner must be a non-empty string');
  }
  if (typeof pr.repo !== 'string' || pr.repo.length === 0) {
    throw new Error('refresh: pr.repo must be a non-empty string');
  }
  if (typeof pr.number !== 'number' || !Number.isFinite(pr.number) || pr.number <= 0) {
    throw new Error(`refresh: pr.number must be a positive integer (got ${pr.number})`);
  }
  if (typeof plan_id !== 'string' || plan_id.length === 0) {
    throw new Error('refresh: plan_id must be a non-empty string');
  }
  return true;
}

/**
 * Build the {@link PrObservationRefresher} adapter that the framework
 * tick consumes. Per-call spawn timeout is bounded at 90s so a single
 * stuck call does not block the whole approval-cycle pass.
 */
export function createPrLandingObserveRefresher(options = {}) {
  const repoRoot = options.repoRoot ?? resolve(HERE, '..', '..');
  const timeoutMs = options.timeoutMs ?? 90_000;
  return {
    async refresh(args) {
      validateRefreshArgs(args);
      const { pr, plan_id } = args;
      await execa('node', [
        RUN_PR_LANDING,
        '--pr', String(pr.number),
        '--owner', pr.owner,
        '--repo', pr.repo,
        '--observe-only',
        '--live',
        '--plan-id', plan_id,
      ], { cwd: repoRoot, timeout: timeoutMs, stdio: 'inherit' });
    },
  };
}
```

- [ ] **Step 5.4: Run the validation tests**

Run: `npx vitest run test/scripts/lib/pr-observation-refresher.test.ts`
Expected: All 4 tests pass.

- [ ] **Step 5.5: Commit**

```bash
git add scripts/lib/pr-observation-refresher.mjs test/scripts/lib/pr-observation-refresher.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(scripts): pr-observation refresher adapter for approval-cycle tick"
```

---

### Task 6: Wire the tick into run-approval-cycle

**Files:**
- Modify: `scripts/run-approval-cycle.mjs`

**Security + correctness considerations:**
- The new tick MUST be wired between plan-approval (step 2) and plan-reconcile (step 3 today) so a refresh that surfaces a terminal pr_state is picked up by reconcile in the same pass.
- The wiring must be optional: a deployment that never wants polling can leave the refresher unconfigured (or pass `--no-refresh`). Default-on is fine because the tick is invisible-by-default (zero plans in `executing` -> zero work).
- A refresher import failure must not crash the whole cycle (other ticks should still run). Catch and warn in the caller.
- Logging must follow the existing format `[approval-cycle] <step-name> scanned=N refreshed=N skipped=...` so operators see consistent telemetry.

- [ ] **Step 6.1: Add the import + tick wiring**

In `scripts/run-approval-cycle.mjs`, after the existing imports (around line 76):

```js
import { runPlanObservationRefreshTick } from '../dist/runtime/plans/pr-observation-refresh.js';
import { createPrLandingObserveRefresher } from './lib/pr-observation-refresher.mjs';
```

Update the help text in `parseArgs` to mention the new tick (line ~107):

```js
'  3. runPlanObservationRefreshTick (refresh stale pr-observation atoms)',
'  4. runPlanStateReconcileTick    (pr-merge writeback)',
'  5. runDispatchTick              (approved -> executing)',
```

In `main()`, add the tick after `runPlanApprovalTick` (around line 305) and before `runPlanStateReconcileTick`:

```js
// 3. Refresh stale pr-observation atoms so the reconciler below sees
// terminal pr_state on PRs that have merged or closed since the last
// observation. Best-effort: tick errors and refresher errors are
// non-fatal so the rest of the cycle still runs.
try {
  const refresher = createPrLandingObserveRefresher({ repoRoot: process.cwd() });
  const r = await runPlanObservationRefreshTick(host, refresher);
  const skippedFragment = formatSkipped(r.skipped);
  console.log(
    '[approval-cycle] plan-obs-refresh   '
    + `scanned=${r.scanned} refreshed=${r.refreshed}${skippedFragment}`,
  );
} catch (err) {
  console.error(`[approval-cycle] plan-obs-refresh FAILED: ${err?.message ?? err}`);
  firstError = firstError ?? err;
}
```

Add `formatSkipped` helper above `main()`:

```js
function formatSkipped(skipped) {
  const entries = Object.entries(skipped).filter(([, n]) => n > 0);
  if (entries.length === 0) return '';
  return ` skipped=${entries.map(([k, n]) => `${k}=${n}`).join(',')}`;
}
```

- [ ] **Step 6.2: Re-number the existing logs**

Update the existing `runPlanStateReconcileTick` block comment from `// 3.` to `// 4.`, and the `runDispatchTick` block from `// 4.` to `// 5.`. (Cosmetic; not functional.)

- [ ] **Step 6.3: Manual smoke test (no actual GitHub call)**

Build + run a dry pass against the .lag dir to verify the wiring loads:

Run: `npm run build && node scripts/run-approval-cycle.mjs --root-dir .lag --once --llm memory`

Expected log lines (in order):
```text
[approval-cycle] intent-approve     scanned=N approved=N
[approval-cycle] auto-approve       scanned=N approved=N
[approval-cycle] plan-approval      ...
[approval-cycle] plan-obs-refresh   scanned=N refreshed=N ...
[approval-cycle] plan-reconcile     ...
[approval-cycle] dispatch           ...
```

If `--llm memory` triggers the loud-fail gate due to registered LLM-requiring sub-actors, omit `--llm memory` and let claude-cli wire (or temporarily comment out the dispatch step for the smoke test only).

Note: the refresh tick may attempt actual run-pr-landing spawns against any `executing` plan it finds. To keep this purely a smoke test, ensure `.lag/atoms/` has no stale executing plans, OR comment out the refresher spawn temporarily. The `validateRefreshArgs` test already pins the contract; this smoke test is for tick wiring only.

- [ ] **Step 6.4: Commit**

```bash
git add scripts/run-approval-cycle.mjs
node scripts/git-as.mjs lag-ceo commit -m "feat(approval-cycle): wire pr-observation refresh tick before reconcile"
```

---

### Task 7: Bootstrap the freshness threshold canon atom

**Files:**
- Modify: `scripts/bootstrap-workflow-canon.mjs`

**Security + correctness considerations:**
- Idempotent: a re-run of the bootstrap script must not duplicate the atom (use deterministic id `pol-pr-observation-freshness-threshold-ms`).
- Provenance: principal_id is `apex-agent` matching other policy atoms.
- L3 layer: this is a long-lived governance directive, not an L1 observation.

- [ ] **Step 7.1: Add the atom seeder**

In `scripts/bootstrap-workflow-canon.mjs`, find the policy-atom seeding section and add:

```js
{
  id: 'pol-pr-observation-freshness-threshold-ms',
  type: 'directive',
  layer: 'L3',
  scope: 'project',
  content: 'Freshness threshold for pr-observation atoms. The plan-observation-refresh tick re-observes a PR whose latest observation is older than this many milliseconds, has pr_state=OPEN, and whose linked plan is still executing. Default 5 minutes is a sensible indie-floor; an org running tighter latency budgets sets a smaller value.',
  metadata: {
    policy: {
      subject: 'pr-observation-freshness-threshold-ms',
      value: 300_000,  // 5 minutes
      reason: 'Indie-floor default; tunable per dev-future-tunable-dial-seam.',
    },
  },
},
```

- [ ] **Step 7.2: Run the bootstrap and inspect**

Run: `node scripts/bootstrap-workflow-canon.mjs`
Inspect: `.lag/atoms/pol-pr-observation-freshness-threshold-ms.json` exists and has the right shape.

- [ ] **Step 7.3: Commit**

```bash
git add scripts/bootstrap-workflow-canon.mjs .lag/atoms/pol-pr-observation-freshness-threshold-ms.json
node scripts/git-as.mjs lag-ceo commit -m "feat(canon): seed pr-observation freshness threshold policy atom"
```

---

### Task 8: Pre-push CR CLI gate + final cleanup

**Files:** N/A - verification only.

**Security + correctness considerations:** Per `dev-coderabbit-cli-pre-push`, run the CR CLI on the diff before the final push.

- [ ] **Step 8.1: Run the pre-push grep checklist**

Per `feedback_pre_push_grep_checklist`:

```bash
# Emdashes (private term in repo)
grep -rn $'\u2014' src/runtime/plans/pr-observation-refresh.ts scripts/lib/pr-observation-refresher.mjs scripts/run-approval-cycle.mjs

# Claude attribution (forbidden per feedback_no_claude_attribution)
grep -rn -i "claude\|co-authored-by\|generated with" docs/superpowers/specs/2026-05-01* docs/superpowers/plans/2026-05-01*

# Design/ADR refs in src/ (forbidden per feedback_src_docs_mechanism_only_no_design_links)
grep -rn "design/\|adr-\|atom:.*-" src/runtime/plans/pr-observation-refresh.ts

# Canon ids in src/ (same)
grep -rn "dev-\|pol-\|inv-\|pref-\|arch-" src/runtime/plans/pr-observation-refresh.ts
```

Expected: All four greps return zero matches in src/. Mentions in spec/plan docs ARE allowed.

- [ ] **Step 8.2: Run the full test suite**

Run: `npm run build && npx vitest run`
Expected: All tests pass.

- [ ] **Step 8.3: Run the CR CLI pre-check**

Run: `node scripts/cr-precheck.mjs` (uses CODERABBIT_API_KEY if set; otherwise documents the path)

Expected: 0 critical, 0 major findings on the diff.

If findings appear: address each one and re-run. Critical/major findings are hard blockers per `dev-coderabbit-cli-pre-push`.

- [ ] **Step 8.4: Push branch and open PR**

```bash
node scripts/git-as.mjs lag-ceo push origin feat/pr-observation-re-observe
node scripts/gh-as.mjs lag-ceo pr create \
  --title "feat(plans): pr-observation re-observe mechanism (closes substrate gap #8)" \
  --body "$(cat <<'EOF'
## Summary

Closes substrate gap #8: plans stuck in `plan_state='executing'` after their PR merges or closes because the only `pr-observation` atom for the PR was written ONCE at PR-creation time and carries `pr_state='OPEN'` forever. The reconciler reads the stale observation and never transitions `executing -> succeeded|abandoned`.

This PR adds a periodic re-observe tick that surfaces stale OPEN observations whose linked plan is still `executing`, asks a pluggable `PrObservationRefresher` to write a fresh observation atom, supersedes the stale one, and lets the existing `pr-merge-reconcile` tick do its job on the next pass.

## Substrate purity

Per CR's two MAJOR findings on PR #274:
- The framework module `src/runtime/plans/pr-observation-refresh.ts` is mechanism-only. No `execa`, no `gh`, no GitHub SDK. The pluggable `PrObservationRefresher` seam takes structured `{owner, repo, number}` data already on the observation atom; no string-parsing of PR numbers from summaries lives in `src/`.
- The reconciler `src/runtime/plans/pr-merge-reconcile.ts` is **untouched**. It already does the right thing; the bug it appeared to have was no fresh observations were being written. This PR feeds it fresh observations; it does not bypass it.

## Architecture

1. New `runPlanObservationRefreshTick(host, refresher, options)` framework module: scans `pr-observation` atoms, filters to non-terminal + linked-to-executing-plan + stale, calls `refresher.refresh({pr, plan_id})`.
2. Atom-id revision: minute-truncated suffix on `pr-observation-${owner}-${repo}-${number}-${shaSuffix}-${minuteSlug}` so a state-transition observation (OPEN -> MERGED on the same head SHA) lands under a fresh id.
3. `runObserveOnly` updates the prior atom with `superseded_by: [new]` after writing the new atom.
4. New deployment-side adapter `scripts/lib/pr-observation-refresher.mjs` that spawns `run-pr-landing.mjs --observe-only --live`.
5. Wired into `scripts/run-approval-cycle.mjs` between plan-approval (step 2) and plan-reconcile (step 3).
6. Freshness threshold canon atom `pol-pr-observation-freshness-threshold-ms` (default 5min, tunable per `dev-future-tunable-dial-seam`).

## Test plan

- [x] 16 unit tests for the framework module (5 freshness reader + 11 tick scenarios).
- [x] 5 unit tests for the new atom-id formula.
- [x] 4 unit tests for the deployment-side refresher validation.
- [x] 1 supersedes-flow regression test.
- [x] Full vitest suite passes.
- [x] cr-precheck: 0 critical, 0 major.
- [x] Pre-push grep checklist clean (no emdashes, no canon-id refs in src/, no Claude attribution).

## Dogfeed

Post-merge: pull main locally, mint a small intent atom via `decide.mjs`, run `--mode=substrate-deep` planning loop, watch plan_state transitions through `proposed -> approved -> executing -> succeeded` once the PR merges. The audit chain becomes Plan -> pr-observation (fresh, MERGED) -> plan-merge-settled.

## Spec + plan

- Spec: `docs/superpowers/specs/2026-05-01-pr-observation-re-observe-mechanism-design.md`
- Plan: `docs/superpowers/plans/2026-05-01-pr-observation-re-observe-mechanism.md`
EOF
)"
```

- [ ] **Step 8.5: Trigger CR**

After the PR is created, trigger CR via the machine user (per `dev-cr-trigger-via-machine-user-only`):

```bash
node scripts/cr-trigger.mjs <pr-number>
```

Wait for CR review. Address any findings via fix-pushes. Once CR APPROVED + all checks green:

```bash
node scripts/gh-as.mjs lag-ceo pr merge <pr-number> --squash --delete-branch
```
