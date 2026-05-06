# Telegram Plan Auto-Trigger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-push every newly-proposed plan atom from cto-actor / cpo-actor (canon-tunable allowlist) to Telegram exactly once per plan, via a new LoopRunner tick that mirrors the PR #318 (approval-cycle) shape.

**Architecture:** New tick function `runPlanProposalNotifyTick` in `src/runtime/plans/plan-trigger-telegram.ts` (mechanism only -- atom query, allowlist filter, idempotence-record check, delegate to a `PlanProposalNotifier` seam). LoopRunner gains `runPlanProposalNotifyPass` flag + `planProposalNotifier` seam. CLI gains `--notify-proposed-plans` (default ON). Bin entrypoint factory builds the Telegram-shaped adapter from `scripts/lib/telegram-plan-trigger.mjs`. Idempotence via `type: 'plan-push-record'` atoms with `provenance.derived_from: [planId]` so re-tick of the same state is a no-op. Allowlist comes from canon policy atom `pol-telegram-plan-trigger-principals` with `['cto-actor', 'cpo-actor']` defaults.

**Tech Stack:** TypeScript (framework src/), Node.js .mjs (deployment-side scripts), Vitest, fetch (Telegram bot API).

**Spec:** `docs/superpowers/specs/2026-05-05-telegram-plan-auto-trigger-design.md`

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/runtime/plans/plan-trigger-telegram.ts` | NEW | Pure tick function + types. Mechanism only. |
| `src/runtime/loop/telegram-plan-trigger-allowlist.ts` | NEW | Canon reader for the principal allowlist. |
| `src/runtime/loop/types.ts` | MODIFY | Add `runPlanProposalNotifyPass` + `planProposalNotifier` to LoopOptions; add `planProposalNotifyReport` to LoopTickReport; add `'plan-push-record'` to DEFAULT_HALF_LIVES. |
| `src/runtime/loop/runner.ts` | MODIFY | Wire the new pass; add silent-skip latch + `planProposalNotifyPass` private method. |
| `src/substrate/types.ts` | MODIFY | Add `'plan-push-record'` to `AtomType` union. (`src/types.ts` is a re-export shim; the union lives under substrate/.) |
| `src/substrate/canon-md/generator.ts` | MODIFY | Add the new atom type to TYPE_ORDER + TYPE_HEADINGS (mandatory for the Record<AtomType, string> typing). |
| `src/cli/run-loop.ts` | MODIFY | CLI flag plumbing + factory option. |
| `bin/lag-run-loop.js` | MODIFY | Build the notifier factory; pass to runLoopMain. |
| `scripts/lib/telegram-plan-trigger.mjs` | NEW | Deployment-side adapter; reads env, POSTs to Telegram. |
| `scripts/lib/plan-summary.mjs` | NEW | Pure plan-summary formatter (extracted at N=3 per `dev-dry-extract-at-second-duplication`). |
| `scripts/lib/plan-approve-telegram.mjs` | MODIFY | Wrap shared `extractPlanTitleAndBody` (zero behavior change for existing callers). |
| `scripts/plan-discuss-telegram.mjs` | MODIFY | Replace inline summary extractor with import from `plan-summary.mjs`. |
| `scripts/bootstrap-telegram-plan-trigger-canon.mjs` | NEW | Idempotent installer for the policy atom; supports `--dry-run`. |
| `scripts/lib/telegram-plan-trigger-canon-policies.mjs` | NEW | Pure POLICIES factory imported by both the bootstrap script and the drift test. |
| `test/runtime/plans/plan-trigger-telegram.test.ts` | NEW | Unit tests on the tick function. |
| `test/loop/runner.test.ts` | MODIFY | LoopRunner integration tests for the new pass (default-off, missing-seam, enabled, idempotence, allowlist, rate-limit, best-effort-failure). |
| `test/loop/telegram-plan-trigger-allowlist.test.ts` | NEW | Canon reader tests. |
| `test/scripts/plan-summary.test.ts` | NEW | Pure formatter tests. |
| `test/scripts/telegram-plan-trigger.test.ts` | NEW | Adapter validation + factory env-handling tests. |
| `test/scripts/bootstrap-telegram-plan-trigger-canon.test.ts` | NEW | Drift test pinning POLICIES vs DEFAULT_PRINCIPAL_ALLOWLIST. |

---

## Task 0: Worktree + baseline

**Files:** none (verification only)

- [ ] **Step 0.1: Verify clean worktree HEAD = 870fb98**

```bash
cd C:/Users/opens/memory-governance/.worktrees/feat-loop-runner-telegram-auto-trigger
git status
git log -1 --oneline
```

Expected: `nothing to commit, working tree clean` and `870fb98 feat(loop-runner): auto-fire approval-cycle ticks (refresh + reconcile) (#318)`.

- [ ] **Step 0.2: Install deps + verify baseline**

```bash
C:/Users/opens/AppData/Roaming/nvm/v22.17.1/node.exe --version  # v22.17.1
npm ci
npm run typecheck
npm run build
npx vitest run test/loop/runner.test.ts
```

Expected: typecheck clean, build clean, all 29 LoopRunner tests pass.

- [ ] **Step 0.3: Copy bot creds into the new worktree**

`feedback_bot_creds_copy_to_new_worktrees`: fresh worktrees start empty.

```bash
mkdir -p .lag/apps
cp -r ../../.lag/apps/. .lag/apps/
```

Expected: `.lag/apps/lag-ceo/`, `.lag/apps/lag-cto/`, `.lag/apps/lag-pr-landing/` populated.

---

## Task 1: AtomType extension + DEFAULT_HALF_LIVES entry (TDD)

**Files:**
- Modify: `src/substrate/types.ts` (the AtomType union; `src/types.ts` is a re-export shim)
- Modify: `src/substrate/canon-md/generator.ts` (TYPE_ORDER + TYPE_HEADINGS entries are required for the Record<AtomType, string> typing)
- Modify: `src/runtime/loop/types.ts`
- Test: `test/loop/types.test.ts` (existing or create minimal)

- [ ] **Step 1.1: Locate AtomType union in src/substrate/types.ts**

```bash
grep -n "type AtomType" src/substrate/types.ts
```

Open the file. The `AtomType` union literal lists: `'directive' | 'decision' | ... | 'plan' | ... | 'pipeline-resume'`. Add `'plan-push-record'` immediately after `'plan-merge-settled'` (alphabetical-ish grouping with other operational records). `src/types.ts` is a re-export shim and propagates the change automatically. ALSO add the same key to TYPE_ORDER and TYPE_HEADINGS in `src/substrate/canon-md/generator.ts` (Record<AtomType, string> typing makes a missing key a typecheck failure).

- [ ] **Step 1.2: Add half-life entry**

`src/runtime/loop/types.ts`, inside `DEFAULT_HALF_LIVES`, add after `'plan-merge-settled'`:

```typescript
  'plan-push-record': 7 * 24 * 60 * 60 * 1000,  // ~1 week
```

7 days outlasts the proposed-plan reaper window (default 72h) so idempotence holds for the plan's full proposed lifetime.

- [ ] **Step 1.3: Run typecheck**

```bash
npm run typecheck 2>&1 | tail -20
```

Expected: clean. The literal addition to `AtomType` propagates everywhere via TypeScript.

- [ ] **Step 1.4: Run vitest baseline still passes**

```bash
npx vitest run test/loop/runner.test.ts
```

Expected: all 29 tests still pass (no behavior change yet -- only added a literal to a union).

- [ ] **Step 1.5: Commit**

```bash
git add src/substrate/types.ts src/runtime/loop/types.ts src/substrate/canon-md/generator.ts
node scripts/git-as.mjs lag-ceo git commit -m "feat(types): register plan-push-record atom type + half-life"
```

---

## Task 2: Pure plan-summary formatter (DRY extraction at N=3)

**Files:**
- Create: `scripts/lib/plan-summary.mjs`
- Test: `test/scripts/plan-summary.test.ts`

The same logic ships inline in `plan-discuss-telegram.mjs:441-456` and as `formatPlanSummary` exported from `scripts/lib/plan-approve-telegram.mjs`. The new auto-trigger adapter is the third caller. Extract first.

The shared module exports `extractPlanTitleAndBody(plan)` returning `{ title, body }` where `body` is the FULL untruncated body. Truncation is a per-consumer concern: approve uses a 600-char preview, the auto-trigger adapter caps at 3000 chars, discuss uses the full body. Existing `formatPlanSummary` in `scripts/lib/plan-approve-telegram.mjs` becomes a thin wrapper that calls `extractPlanTitleAndBody` then truncates -- zero behavior change for existing callers.

- [ ] **Step 2.1: Read existing inline implementation**

```bash
grep -n "first markdown heading" scripts/plan-discuss-telegram.mjs scripts/lib/plan-approve-telegram.mjs
```

Confirm both versions agree: pull `^#{1,3}\s+(.+)$` as title, body is everything after that line trimmed.

- [ ] **Step 2.2: Write the failing test**

Create `test/scripts/plan-summary.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { extractPlanTitleAndBody } from '../../scripts/lib/plan-summary.mjs';

describe('extractPlanTitleAndBody', () => {
  it('extracts title from first markdown heading', () => {
    const plan = { id: 'p1', content: '# Add a feature\n\nBody line.\nSecond line.' };
    expect(extractPlanTitleAndBody(plan)).toEqual({
      title: 'Add a feature',
      body: 'Body line.\nSecond line.',
    });
  });
  it('falls back to id-bearing title when no heading', () => {
    const plan = { id: 'p2', content: 'Body without heading.' };
    expect(extractPlanTitleAndBody(plan)).toEqual({
      title: '(no title - id p2)',
      body: 'Body without heading.',
    });
  });
  it('handles empty content', () => {
    const plan = { id: 'p3', content: '' };
    expect(extractPlanTitleAndBody(plan)).toEqual({
      title: '(no title - id p3)',
      body: '',
    });
  });
  it('handles null/undefined content', () => {
    const plan = { id: 'p4' };
    expect(extractPlanTitleAndBody(plan)).toEqual({
      title: '(no title - id p4)',
      body: '',
    });
  });
  it('accepts h1 / h2 / h3', () => {
    expect(extractPlanTitleAndBody({ id: 'p5', content: '## H2 title\n\nbody' }).title).toBe('H2 title');
    expect(extractPlanTitleAndBody({ id: 'p6', content: '### H3 title\n\nbody' }).title).toBe('H3 title');
  });
});
```

Run: `npx vitest run test/scripts/lib/plan-summary.test.ts`. Expected: FAIL -- module not found.

- [ ] **Step 2.3: Implement the formatter**

Create `scripts/lib/plan-summary.mjs`:

```javascript
/**
 * Pure plan-summary formatter shared by every plan-Telegram surface
 * (approve, discuss, and the auto-trigger tick adapter). Extracts the
 * title from the first markdown heading (h1-h3) and treats the rest as
 * the body. Returns a stable shape:
 *
 *   { title: string, body: string }
 *
 * No side effects, no I/O. Pure function so adapter wiring can call
 * it for the auto-trigger push without dragging in any deployment-side
 * concerns.
 */

/**
 * @param {{ id?: string; content?: string | null }} plan
 * @returns {{ title: string; body: string }}
 */
export function extractPlanTitleAndBody(plan) {
  const id = plan && typeof plan.id === 'string' ? plan.id : null;
  const content = plan && plan.content != null ? String(plan.content) : '';
  const lines = content.split('\n');
  let title = '';
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#{1,3}\s+(.+)$/);
    if (m) {
      title = m[1].trim();
      bodyStart = i + 1;
      break;
    }
  }
  const fallbackTitle = id ? `(no title - id ${id})` : '(no title)';
  return {
    title: title || fallbackTitle,
    body: lines.slice(bodyStart).join('\n').trim(),
  };
}
```

Run: `npx vitest run test/scripts/plan-summary.test.ts`. Expected: PASS.

- [ ] **Step 2.4: Migrate existing callers**

`scripts/lib/plan-approve-telegram.mjs`: keep the existing `formatPlanSummary` signature but make it a thin wrapper that calls `extractPlanTitleAndBody` then truncates the body at the existing 600-char preview budget. Zero behavior change for existing callers.

`scripts/plan-discuss-telegram.mjs`: replace the inline IIFE at lines ~441-456 with a direct call:

```javascript
import { extractPlanTitleAndBody } from './lib/plan-summary.mjs';
// ...
const summary = extractPlanTitleAndBody(plan);
```

Discuss uses the FULL body (no truncation); the inline IIFE was already doing that.

Run all existing tests:

```bash
npx vitest run test/scripts/plan-approve-telegram.test.ts test/scripts/plan-discuss-telegram.test.ts 2>&1 | tail -20
```

Expected: green. If a test fails, the migration is wrong (regression -- fix before commit).

- [ ] **Step 2.5: Commit**

```bash
git add scripts/lib/plan-summary.mjs scripts/lib/plan-approve-telegram.mjs scripts/plan-discuss-telegram.mjs test/scripts/lib/plan-summary.test.ts
node scripts/git-as.mjs lag-ceo git commit -m "refactor(scripts): extract plan-summary formatter at N=3 callers"
```

---

## Task 3: Canon reader for principal allowlist (TDD)

**Files:**
- Create: `src/runtime/loop/telegram-plan-trigger-allowlist.ts`
- Test: `test/loop/telegram-plan-trigger-allowlist.test.ts`

- [ ] **Step 3.1: Write the failing test**

```typescript
import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import {
  DEFAULT_PRINCIPAL_ALLOWLIST,
  readPlanTriggerAllowlist,
} from '../../src/runtime/loop/telegram-plan-trigger-allowlist.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../src/types.js';

function policyAtom(id: string, policy: Record<string, unknown>): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'telegram-plan-trigger principals policy',
    type: 'directive',
    layer: 'L3',
    provenance: { kind: 'operator-seeded', source: { agent_id: 'bootstrap' }, derived_from: [] },
    confidence: 1,
    created_at: '2026-05-05T00:00:00.000Z' as Time,
    last_reinforced_at: '2026-05-05T00:00:00.000Z' as Time,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
    principal_id: 'apex-agent' as PrincipalId,
    taint: 'clean',
    metadata: { policy },
  };
}

describe('readPlanTriggerAllowlist', () => {
  it('returns DEFAULT_PRINCIPAL_ALLOWLIST when no policy atom exists', async () => {
    const host = createMemoryHost();
    const allowlist = await readPlanTriggerAllowlist(host);
    expect(allowlist).toEqual(DEFAULT_PRINCIPAL_ALLOWLIST);
    expect(allowlist).toContain('cto-actor');
    expect(allowlist).toContain('cpo-actor');
  });

  it('returns canon-supplied allowlist when policy atom exists', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-telegram', {
      subject: 'telegram-plan-trigger-principals',
      principal_ids: ['cto-actor'],
    }));
    const allowlist = await readPlanTriggerAllowlist(host);
    expect(allowlist).toEqual(['cto-actor']);
  });

  it('returns empty allowlist when canon explicitly empties it (org-ceiling opt-out)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-telegram', {
      subject: 'telegram-plan-trigger-principals',
      principal_ids: [],
    }));
    const allowlist = await readPlanTriggerAllowlist(host);
    expect(allowlist).toEqual([]);
  });

  it('falls back to defaults on malformed policy (non-array principal_ids)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-telegram', {
      subject: 'telegram-plan-trigger-principals',
      principal_ids: 'cto-actor',  // string, not array
    }));
    const allowlist = await readPlanTriggerAllowlist(host);
    expect(allowlist).toEqual(DEFAULT_PRINCIPAL_ALLOWLIST);
  });

  it('falls back to defaults on malformed policy (non-string entries)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-telegram', {
      subject: 'telegram-plan-trigger-principals',
      principal_ids: ['cto-actor', 42, ''],
    }));
    const allowlist = await readPlanTriggerAllowlist(host);
    expect(allowlist).toEqual(DEFAULT_PRINCIPAL_ALLOWLIST);
  });

  it('ignores tainted policy atoms', async () => {
    const host = createMemoryHost();
    const a = policyAtom('pol-telegram', {
      subject: 'telegram-plan-trigger-principals',
      principal_ids: ['cto-actor'],
    });
    a.taint = 'tainted-by-author';
    await host.atoms.put(a);
    const allowlist = await readPlanTriggerAllowlist(host);
    expect(allowlist).toEqual(DEFAULT_PRINCIPAL_ALLOWLIST);
  });

  it('ignores superseded policy atoms', async () => {
    const host = createMemoryHost();
    const a = policyAtom('pol-telegram', {
      subject: 'telegram-plan-trigger-principals',
      principal_ids: ['cto-actor'],
    });
    a.superseded_by = ['some-newer-id' as AtomId];
    await host.atoms.put(a);
    const allowlist = await readPlanTriggerAllowlist(host);
    expect(allowlist).toEqual(DEFAULT_PRINCIPAL_ALLOWLIST);
  });
});
```

Run: `npx vitest run test/loop/telegram-plan-trigger-allowlist.test.ts`. Expected: FAIL -- module not found.

- [ ] **Step 3.2: Implement the canon reader**

Create `src/runtime/loop/telegram-plan-trigger-allowlist.ts`:

```typescript
/**
 * Canon reader for the telegram-plan-trigger principal allowlist.
 *
 * Mirrors `readPrObservationFreshnessMs` and
 * `readApprovalCycleTickIntervalMs`: scan canon directive atoms for
 * `metadata.policy.subject === 'telegram-plan-trigger-principals'`,
 * read `policy.principal_ids` as the allowlist. Falls back to
 * DEFAULT_PRINCIPAL_ALLOWLIST when no policy atom exists or the value
 * is malformed (non-array, non-string entries, etc).
 *
 * An explicitly EMPTY array in the policy atom is honored -- that is
 * the org-ceiling opt-out path. The fallback only triggers on
 * absent / malformed.
 *
 * Substrate purity: this reader is mechanism-only. It does not encode
 * principal names in framework code beyond the indie-floor defaults
 * (which match the seed canon written by the bootstrap script).
 */

import type { Host } from '../../interface.js';
import type { PrincipalId } from '../../types.js';

/**
 * Default indie-floor allowlist. Solo developers running LAG without
 * a canon override get phone-pings on cto / cpo plans. Org-ceiling
 * deployments override via the policy atom.
 */
export const DEFAULT_PRINCIPAL_ALLOWLIST: ReadonlyArray<PrincipalId> = Object.freeze([
  'cto-actor' as PrincipalId,
  'cpo-actor' as PrincipalId,
]);

export async function readPlanTriggerAllowlist(host: Host): Promise<ReadonlyArray<PrincipalId>> {
  const PAGE_SIZE = 200;
  let cursor: string | undefined;
  do {
    const page = await host.atoms.query({ type: ['directive'] }, PAGE_SIZE, cursor);
    for (const atom of page.atoms) {
      if (atom.taint !== 'clean') continue;
      if (atom.superseded_by.length > 0) continue;
      const meta = atom.metadata as Record<string, unknown>;
      const policy = meta['policy'] as Record<string, unknown> | undefined;
      if (!policy || policy['subject'] !== 'telegram-plan-trigger-principals') continue;
      const raw = policy['principal_ids'];
      if (!Array.isArray(raw)) continue;
      // Validate every entry: non-empty string. A single bad entry
      // invalidates the whole policy and falls through to defaults
      // rather than silently dropping bad entries (which would let a
      // typo'd principal stay in the allowlist forever invisibly).
      const valid = raw.every((p) => typeof p === 'string' && p.length > 0);
      if (!valid) continue;
      // Empty array is honored -- that's the explicit opt-out.
      return Object.freeze(raw.map((p) => p as PrincipalId));
    }
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);
  return DEFAULT_PRINCIPAL_ALLOWLIST;
}
```

Run: `npx vitest run test/loop/telegram-plan-trigger-allowlist.test.ts`. Expected: PASS (7/7).

- [ ] **Step 3.3: Commit**

```bash
git add src/runtime/loop/telegram-plan-trigger-allowlist.ts test/loop/telegram-plan-trigger-allowlist.test.ts
node scripts/git-as.mjs lag-ceo git commit -m "feat(loop): canon reader for telegram-plan-trigger principal allowlist"
```

---

## Task 4: Tick function (TDD, the heart of the feature)

**Files:**
- Create: `src/runtime/plans/plan-trigger-telegram.ts`
- Test: `test/runtime/plans/plan-trigger-telegram.test.ts`

- [ ] **Step 4.1: Write the failing tests**

Create `test/runtime/plans/plan-trigger-telegram.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import { runPlanProposalNotifyTick } from '../../../src/runtime/plans/plan-trigger-telegram.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../src/types.js';
import { samplePlanAtom } from '../../fixtures.js';

const tickPrincipal = 'lag-loop' as PrincipalId;

interface NotifyCall {
  readonly planId: string;
  readonly title: string;
  readonly body: string;
}

function buildPlanFor(id: string, principal: string, plan_state: 'proposed' | 'executing' = 'proposed'): Atom {
  const a = samplePlanAtom(id, '2026-05-05T00:00:00.000Z', { plan_state });
  return { ...a, principal_id: principal as PrincipalId, content: `# ${id} title\n\nbody for ${id}.` };
}

function recorder(): { calls: NotifyCall[]; notifier: { notify: (args: { plan: Atom; summary: { title: string; body: string } }) => Promise<void> } } {
  const calls: NotifyCall[] = [];
  return {
    calls,
    notifier: {
      async notify(args) {
        calls.push({ planId: args.plan.id, title: args.summary.title, body: args.summary.body });
      },
    },
  };
}

describe('runPlanProposalNotifyTick', () => {
  it('notifies a new proposed plan from cto-actor (default allowlist)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(buildPlanFor('p1', 'cto-actor'));
    const { calls, notifier } = recorder();
    const result = await runPlanProposalNotifyTick(host, notifier, tickPrincipal);
    expect(result.notified).toBe(1);
    expect(calls.length).toBe(1);
    expect(calls[0].planId).toBe('p1');
    expect(calls[0].title).toBe('p1 title');
    // Idempotence record was written.
    const records = await host.atoms.query({ type: ['plan-push-record'] }, 50);
    expect(records.atoms.length).toBe(1);
    expect((records.atoms[0].metadata as Record<string, unknown>)['plan_id']).toBe('p1');
    expect(records.atoms[0].provenance.derived_from).toEqual(['p1']);
  });

  it('is idempotent: re-running the tick on the same state does NOT re-notify', async () => {
    const host = createMemoryHost();
    await host.atoms.put(buildPlanFor('p1', 'cto-actor'));
    const { calls, notifier } = recorder();
    const first = await runPlanProposalNotifyTick(host, notifier, tickPrincipal);
    expect(first.notified).toBe(1);
    const second = await runPlanProposalNotifyTick(host, notifier, tickPrincipal);
    expect(second.notified).toBe(0);
    expect(second.skipped['already-pushed']).toBe(1);
    expect(calls.length).toBe(1);  // notifier was NOT called the second time
  });

  it('skips plans whose principal is NOT in the allowlist', async () => {
    const host = createMemoryHost();
    await host.atoms.put(buildPlanFor('p1', 'code-author'));
    const { calls, notifier } = recorder();
    const result = await runPlanProposalNotifyTick(host, notifier, tickPrincipal);
    expect(result.notified).toBe(0);
    expect(result.skipped['not-in-allowlist']).toBe(1);
    expect(calls.length).toBe(0);
  });

  it('only sees proposed plans (the AtomFilter narrows by plan_state)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(buildPlanFor('p1', 'cto-actor', 'executing'));
    const { calls, notifier } = recorder();
    const result = await runPlanProposalNotifyTick(host, notifier, tickPrincipal);
    expect(result.notified).toBe(0);
    expect(calls.length).toBe(0);
  });

  it('honors the canon allowlist override', async () => {
    const host = createMemoryHost();
    // Canon override: only cto-actor (cpo dropped).
    await host.atoms.put({
      schema_version: 1,
      id: 'pol-telegram' as AtomId,
      content: 'telegram-plan-trigger principals policy',
      type: 'directive',
      layer: 'L3',
      provenance: { kind: 'operator-seeded', source: { agent_id: 'bootstrap' }, derived_from: [] },
      confidence: 1,
      created_at: '2026-05-05T00:00:00.000Z' as Time,
      last_reinforced_at: '2026-05-05T00:00:00.000Z' as Time,
      expires_at: null,
      supersedes: [],
      superseded_by: [],
      scope: 'project',
      signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
      principal_id: 'apex-agent' as PrincipalId,
      taint: 'clean',
      metadata: {
        policy: {
          subject: 'telegram-plan-trigger-principals',
          principal_ids: ['cto-actor'],
        },
      },
    });
    await host.atoms.put(buildPlanFor('p1', 'cpo-actor'));
    await host.atoms.put(buildPlanFor('p2', 'cto-actor'));
    const { calls, notifier } = recorder();
    const result = await runPlanProposalNotifyTick(host, notifier, tickPrincipal);
    expect(result.notified).toBe(1);
    const ids = calls.map((c) => c.planId).sort();
    expect(ids).toEqual(['p2']);
    expect(result.skipped['not-in-allowlist']).toBe(1);
  });

  it('counts notify-failed and does NOT write push-record on adapter throw', async () => {
    const host = createMemoryHost();
    await host.atoms.put(buildPlanFor('p1', 'cto-actor'));
    const notifier = {
      async notify(): Promise<void> {
        throw new Error('synthetic Telegram failure');
      },
    };
    const result = await runPlanProposalNotifyTick(host, notifier, tickPrincipal);
    expect(result.notified).toBe(0);
    expect(result.skipped['notify-failed']).toBe(1);
    // No push-record was written -> next tick will retry.
    const records = await host.atoms.query({ type: ['plan-push-record'] }, 50);
    expect(records.atoms.length).toBe(0);
  });

  it('rate-limits at maxNotifies', async () => {
    const host = createMemoryHost();
    for (let i = 0; i < 5; i += 1) {
      await host.atoms.put(buildPlanFor(`p${i}`, 'cto-actor'));
    }
    const { calls, notifier } = recorder();
    const result = await runPlanProposalNotifyTick(host, notifier, tickPrincipal, { maxNotifies: 2 });
    expect(result.notified).toBe(2);
    expect(result.skipped['rate-limited']).toBe(3);
    expect(calls.length).toBe(2);
  });

  it('skips tainted and superseded plans defensively', async () => {
    const host = createMemoryHost();
    const tainted = buildPlanFor('p1', 'cto-actor');
    tainted.taint = 'tainted-by-author';
    await host.atoms.put(tainted);
    const superseded = buildPlanFor('p2', 'cto-actor');
    superseded.superseded_by = ['p2-newer' as AtomId];
    await host.atoms.put(superseded);
    const { calls, notifier } = recorder();
    const result = await runPlanProposalNotifyTick(host, notifier, tickPrincipal);
    expect(result.notified).toBe(0);
    expect(calls.length).toBe(0);
  });

  it('uses the allowlist override option (test injection bypassing canon read)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(buildPlanFor('p1', 'maverick-actor'));
    const { calls, notifier } = recorder();
    const result = await runPlanProposalNotifyTick(host, notifier, tickPrincipal, {
      principalAllowlistOverride: ['maverick-actor' as PrincipalId],
    });
    expect(result.notified).toBe(1);
    expect(calls.length).toBe(1);
  });
});
```

Run: `npx vitest run test/runtime/plans/plan-trigger-telegram.test.ts`. Expected: FAIL -- module not found.

- [ ] **Step 4.2: Implement the tick**

Create `src/runtime/plans/plan-trigger-telegram.ts`:

```typescript
/**
 * Telegram plan-proposal auto-trigger tick.
 *
 * Closes the substrate gap where new proposed plans accumulate during
 * autonomous /loop sessions but the operator gets no Telegram ping
 * unless they manually run scripts/plan-approve-telegram.mjs or
 * scripts/plan-discuss-telegram.mjs. This tick scans proposed plan
 * atoms whose principal is in the canon-defined allowlist, calls a
 * pluggable PlanProposalNotifier seam exactly once per plan, and
 * writes a plan-push-record atom to make the push idempotent
 * across re-ticks.
 *
 * Substrate purity: this module never imports a Telegram client,
 * never reads env vars, never spawns a process. The
 * PlanProposalNotifier seam takes structured plan + summary data;
 * the deployment-side adapter does the actual HTTP POST.
 *
 * Per-tick fairness: maxNotifies bounds the per-tick adapter-call
 * budget; plans beyond the cap are counted as 'rate-limited' and
 * picked up next tick. maxScan bounds total atoms inspected per
 * tick to keep the scan cost O(maxScan) regardless of store size.
 *
 * Idempotence design: a `plan-push-record` atom is written per
 * notified plan with `provenance.derived_from: [planId]`. The next
 * tick queries the existing records and short-circuits any plan that
 * already has one. A failed notify (adapter throw) deliberately does
 * NOT write the record so the next tick retries -- the operator
 * always eventually sees the plan when Telegram recovers.
 *
 * Allowlist source: canon policy atom
 * `pol-telegram-plan-trigger-principals` (subject:
 * 'telegram-plan-trigger-principals', principal_ids: array).
 * Indie-floor default: ['cto-actor', 'cpo-actor']. Org-ceiling
 * deployments override or empty the array per
 * dev-substrate-not-prescription.
 */

import type { Host } from '../../interface.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../types.js';
import {
  DEFAULT_PRINCIPAL_ALLOWLIST,
  readPlanTriggerAllowlist,
} from '../loop/telegram-plan-trigger-allowlist.js';
import { formatPlanSummary } from '../../../scripts/lib/plan-summary.mjs';

/**
 * Pluggable seam for the deployment-side adapter that actually sends
 * the Telegram message. Errors thrown by `notify` are caught by the
 * tick and counted as `skipped['notify-failed']`; the
 * plan-push-record is NOT written for failed sends so a future
 * tick will retry.
 */
export interface PlanProposalNotifier {
  notify(args: {
    readonly plan: Atom;
    readonly summary: { readonly title: string; readonly body: string };
  }): Promise<void>;
}

export interface PlanProposalNotifyOptions {
  /** Time provider; defaults to host clock. Test injection point. */
  readonly now?: () => string;
  /** Upper bound on plan atoms scanned per tick; defaults to 5000. */
  readonly maxScan?: number;
  /** Upper bound on notifier.notify calls per tick; defaults to 20. */
  readonly maxNotifies?: number;
  /**
   * Override the canon allowlist read. Test injection point.
   * Production callers leave this undefined; the canon read is the
   * canonical path.
   */
  readonly principalAllowlistOverride?: ReadonlyArray<PrincipalId>;
}

export interface PlanProposalNotifyResult {
  readonly scanned: number;
  readonly notified: number;
  readonly skipped: Record<string, number>;
}

/**
 * The notify tick. Mechanism-only: no Telegram I/O, no env reads,
 * no string parsing. Reads plan atoms, filters to those needing a
 * push, delegates the actual send to the injected adapter.
 */
export async function runPlanProposalNotifyTick(
  host: Host,
  notifier: PlanProposalNotifier,
  notifyPrincipal: PrincipalId,
  options: PlanProposalNotifyOptions = {},
): Promise<PlanProposalNotifyResult> {
  const nowFn = options.now ?? (() => host.clock.now());
  const MAX_SCAN = options.maxScan ?? 5_000;
  const MAX_NOTIFIES = options.maxNotifies ?? 20;
  const allowlist
    = options.principalAllowlistOverride ?? (await readPlanTriggerAllowlist(host));
  const allowSet = new Set<string>(allowlist);

  // Empty allowlist short-circuits without scanning. This is the
  // explicit org-ceiling opt-out path.
  if (allowSet.size === 0) {
    return { scanned: 0, notified: 0, skipped: { 'allowlist-empty': 0 } };
  }

  const PAGE_SIZE = 500;
  let scanned = 0;
  let notified = 0;
  const skipped: Record<string, number> = {};
  const bump = (k: string): void => {
    skipped[k] = (skipped[k] ?? 0) + 1;
  };

  // Pre-scan existing push-records to build a Set of already-pushed
  // plan IDs. One scan up-front is cheaper than N point-queries
  // inside the plan loop, and the record set is bounded by the
  // 7-day half-life decay, so it stays small in steady state.
  const pushedPlanIds = new Set<string>();
  {
    let cursor: string | undefined;
    do {
      const page = await host.atoms.query({ type: ['plan-push-record'] }, PAGE_SIZE, cursor);
      for (const rec of page.atoms) {
        if (rec.taint !== 'clean') continue;
        if (rec.superseded_by.length > 0) continue;
        const meta = rec.metadata as Record<string, unknown>;
        const planId = meta['plan_id'];
        if (typeof planId === 'string' && planId.length > 0) {
          pushedPlanIds.add(planId);
        }
      }
      cursor = page.nextCursor === null ? undefined : page.nextCursor;
    } while (cursor !== undefined);
  }

  let cursor: string | undefined;
  do {
    const remaining = MAX_SCAN - scanned;
    if (remaining <= 0) break;
    const page = await host.atoms.query(
      { type: ['plan'], plan_state: ['proposed'] },
      Math.min(PAGE_SIZE, remaining),
      cursor,
    );
    for (const plan of page.atoms) {
      scanned += 1;
      if (plan.taint !== 'clean') {
        bump('tainted');
        continue;
      }
      if (plan.superseded_by.length > 0) {
        bump('superseded');
        continue;
      }
      if (!allowSet.has(String(plan.principal_id))) {
        bump('not-in-allowlist');
        continue;
      }
      if (pushedPlanIds.has(String(plan.id))) {
        bump('already-pushed');
        continue;
      }
      if (notified >= MAX_NOTIFIES) {
        bump('rate-limited');
        continue;
      }
      const summary = formatPlanSummary({ id: plan.id, content: plan.content });
      try {
        await notifier.notify({ plan, summary });
      } catch {
        bump('notify-failed');
        continue;
      }
      // Write the idempotence record AFTER a successful notify. A
      // crash between the two leaves the plan re-pushable next tick;
      // this is the correct failure mode (better duplicate ping than
      // silent drop).
      const nowIso = String(nowFn());
      const recordId = `plan-push-${String(plan.id)}-${nowIso}` as AtomId;
      const record: Atom = {
        schema_version: 1,
        id: recordId,
        content: `plan ${String(plan.id)} pushed to telegram`,
        type: 'plan-push-record',
        layer: 'L0',
        provenance: {
          kind: 'agent-observed',
          source: { agent_id: notifyPrincipal as string, tool: 'plan-trigger-telegram' },
          derived_from: [plan.id],
        },
        confidence: 1.0,
        created_at: nowIso as Time,
        last_reinforced_at: nowIso as Time,
        expires_at: null,
        supersedes: [],
        superseded_by: [],
        scope: 'session',
        signals: {
          agrees_with: [],
          conflicts_with: [],
          validation_status: 'unchecked',
          last_validated_at: null,
        },
        principal_id: notifyPrincipal,
        taint: 'clean',
        metadata: {
          plan_id: String(plan.id),
          pushed_at: nowIso,
          channel: 'telegram',
        },
      };
      try {
        await host.atoms.put(record);
        notified += 1;
        pushedPlanIds.add(String(plan.id));
      } catch {
        // Write failure: don't increment notified (the operator got
        // the message, but we couldn't persist the idempotence). The
        // next tick will re-notify on this plan, which is a duplicate
        // -- but a duplicate ping is preferable to losing the audit
        // record. Counted distinctly so the operator can spot the
        // anomaly in the per-tick report.
        bump('record-write-failed');
      }
    }
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);

  return { scanned, notified, skipped };
}

// Re-export the default allowlist so test suites can pin it without
// reaching into the loop module.
export { DEFAULT_PRINCIPAL_ALLOWLIST };
```

Run: `npx vitest run test/runtime/plans/plan-trigger-telegram.test.ts`. Expected: PASS (9/9).

- [ ] **Step 4.3: Run typecheck + build**

```bash
npm run typecheck && npm run build
```

Expected: clean.

- [ ] **Step 4.4: Commit**

```bash
git add src/runtime/plans/plan-trigger-telegram.ts test/runtime/plans/plan-trigger-telegram.test.ts
node scripts/git-as.mjs lag-ceo git commit -m "feat(plans): runPlanProposalNotifyTick with idempotent push-record"
```

---

## Task 5: LoopRunner integration (TDD)

**Files:**
- Modify: `src/runtime/loop/types.ts`
- Modify: `src/runtime/loop/runner.ts`
- Modify: `test/loop/runner.test.ts`

- [ ] **Step 5.1: Add types to LoopOptions + LoopTickReport**

In `src/runtime/loop/types.ts`:

Import the seam at the top:
```typescript
import type { PlanProposalNotifier } from '../../runtime/plans/plan-trigger-telegram.js';
```

Add to `LoopOptions` (after `prObservationRefresher`):

```typescript
  /**
   * Run the plan-proposal notify pass on every tick. Default `false`.
   * When the flag is true and `planProposalNotifier` is supplied, the
   * pass scans proposed plan atoms whose principal is in the canon-
   * defined allowlist (`pol-telegram-plan-trigger-principals`), calls
   * the notifier exactly once per plan, and writes a
   * `plan-push-record` atom to make the push idempotent across
   * re-ticks.
   *
   * When the flag is true but `planProposalNotifier` is absent, the
   * pass silent-skips and warns once per runner. This permits a
   * deployment to opt into the flag from canon while bringing the
   * notifier seam online later (or a sandboxed deployment to disable
   * outbound Telegram entirely without removing the canon-side
   * configuration).
   */
  readonly runPlanProposalNotifyPass?: boolean;
  /**
   * Pluggable adapter the notify tick calls when a proposed plan
   * needs a Telegram push. Optional; absent activates the silent-
   * skip path. The framework consumes the adapter only through the
   * `PlanProposalNotifier` interface; concrete adapter construction
   * happens entirely outside framework code.
   */
  readonly planProposalNotifier?: PlanProposalNotifier;
  /**
   * Principal id the notify tick attributes its `plan-push-
   * record` atoms to. Required when `runPlanProposalNotifyPass: true`
   * and a notifier is supplied; ignored otherwise. Defaults to
   * `principalId` (the loop's own principal) when omitted -- the
   * record is operational data the loop is recording about its own
   * action.
   */
  readonly planProposalNotifyPrincipal?: string;
```

Add to `LoopTickReport`:

```typescript
  /**
   * Per-tick plan-proposal notify summary. `null` when the pass is
   * disabled OR when the pass is enabled but the notifier seam is
   * absent (the silent-skip path; the operator sees the gap via the
   * once-per-tick log line, not via this field). When the pass
   * actually runs, populated with `scanned` (proposed plans
   * inspected), `notified` (notifier.notify calls succeeded + record
   * written), and `skipped` (a histogram of skip reasons including
   * 'already-pushed', 'not-in-allowlist', 'notify-failed',
   * 'rate-limited', etc.).
   */
  readonly planProposalNotifyReport:
    | {
        readonly scanned: number;
        readonly notified: number;
        readonly skipped: Readonly<Record<string, number>>;
      }
    | null;
```

- [ ] **Step 5.2: Write the failing LoopRunner integration tests**

Append to `test/loop/runner.test.ts` (after the existing plan-observation refresh suite):

```typescript
describe('LoopRunner.tick plan-proposal notify integration', () => {
  it('default (runPlanProposalNotifyPass: false) leaves planProposalNotifyReport null and does not call the notifier', async () => {
    const host = createMemoryHost();
    await host.atoms.put({
      ...samplePlanAtom('p1', '2026-05-05T00:00:00.000Z'),
      principal_id: 'cto-actor' as PrincipalId,
    });
    let notifyCalls = 0;
    const notifier = {
      async notify() {
        notifyCalls += 1;
      },
    };
    const runner = new LoopRunner(host, {
      principalId: principal,
      planProposalNotifier: notifier,
    });
    const report = await runner.tick();
    expect(report.planProposalNotifyReport).toBeNull();
    expect(notifyCalls).toBe(0);
  });

  it('enabled-but-notifier-absent silent-skips and warns ONCE across many ticks', async () => {
    const host = createMemoryHost();
    await host.atoms.put({
      ...samplePlanAtom('p1', '2026-05-05T00:00:00.000Z'),
      principal_id: 'cto-actor' as PrincipalId,
    });
    const original = console.error;
    const captured: string[] = [];
    console.error = (...args: unknown[]) => {
      captured.push(args.map((a) => String(a)).join(' '));
    };
    try {
      const runner = new LoopRunner(host, {
        principalId: principal,
        runPlanProposalNotifyPass: true,
      });
      for (let i = 0; i < 5; i += 1) {
        const report = await runner.tick();
        expect(report.planProposalNotifyReport).toBeNull();
      }
      const gapWarnings = captured.filter(
        (l) => l.includes('[plan-proposal-notify]') && l.includes('no planProposalNotifier seam'),
      );
      expect(gapWarnings.length).toBe(1);
    } finally {
      console.error = original;
    }
  });

  it('enabled-with-notifier pushes a proposed cto-actor plan and reports the count', async () => {
    const host = createMemoryHost();
    await host.atoms.put({
      ...samplePlanAtom('p1', '2026-05-05T00:00:00.000Z'),
      principal_id: 'cto-actor' as PrincipalId,
    });
    const notifyCalls: Array<{ planId: string }> = [];
    const notifier = {
      async notify(args: { plan: { id: string }; summary: { title: string } }) {
        notifyCalls.push({ planId: args.plan.id });
      },
    };
    const runner = new LoopRunner(host, {
      principalId: principal,
      runPlanProposalNotifyPass: true,
      planProposalNotifier: notifier,
    });
    const report = await runner.tick();
    expect(report.planProposalNotifyReport).not.toBeNull();
    expect(report.planProposalNotifyReport?.notified).toBe(1);
    expect(notifyCalls.length).toBe(1);
    expect(notifyCalls[0]?.planId).toBe('p1');
    // Audit row carries the count.
    const audits = await host.auditor.query({ kind: ['loop.tick'] }, 5);
    const last = audits[audits.length - 1];
    expect(last?.details?.['plan_proposal_notify_notified']).toBe(1);
  });

  it('idempotent across two ticks: second tick sees already-pushed', async () => {
    const host = createMemoryHost();
    await host.atoms.put({
      ...samplePlanAtom('p1', '2026-05-05T00:00:00.000Z'),
      principal_id: 'cto-actor' as PrincipalId,
    });
    let notifyCalls = 0;
    const notifier = {
      async notify() {
        notifyCalls += 1;
      },
    };
    const runner = new LoopRunner(host, {
      principalId: principal,
      runPlanProposalNotifyPass: true,
      planProposalNotifier: notifier,
    });
    const first = await runner.tick();
    const second = await runner.tick();
    expect(first.planProposalNotifyReport?.notified).toBe(1);
    expect(second.planProposalNotifyReport?.notified).toBe(0);
    expect(second.planProposalNotifyReport?.skipped['already-pushed']).toBe(1);
    expect(notifyCalls).toBe(1);
  });

  it('notifier failure does not fail the tick (counted as skipped)', async () => {
    const host = createMemoryHost();
    await host.atoms.put({
      ...samplePlanAtom('p1', '2026-05-05T00:00:00.000Z'),
      principal_id: 'cto-actor' as PrincipalId,
    });
    const notifier = {
      async notify(): Promise<void> {
        throw new Error('synthetic Telegram failure');
      },
    };
    const runner = new LoopRunner(host, {
      principalId: principal,
      runPlanProposalNotifyPass: true,
      planProposalNotifier: notifier,
    });
    const report = await runner.tick();
    expect(report.planProposalNotifyReport).not.toBeNull();
    expect(report.planProposalNotifyReport?.notified).toBe(0);
    expect(report.planProposalNotifyReport?.skipped['notify-failed']).toBe(1);
    // Plan stays proposed; no push-record was written.
    const records = await host.atoms.query({ type: ['plan-push-record'] }, 5);
    expect(records.atoms.length).toBe(0);
  });

  it('best-effort: synthetic internal failure does not fail the tick', async () => {
    const host = createMemoryHost();
    await host.atoms.put({
      ...samplePlanAtom('p1', '2026-05-05T00:00:00.000Z'),
      principal_id: 'cto-actor' as PrincipalId,
    });
    // Stub host.atoms.query for the plan-trigger query path so the
    // tick throws. We hijack the method, throw on the first call,
    // restore on subsequent ones.
    const realQuery = host.atoms.query.bind(host.atoms);
    let callCount = 0;
    (host.atoms as { query: typeof host.atoms.query }).query = async (filter, limit, cursor) => {
      callCount += 1;
      if (callCount > 1 && Array.isArray(filter.type) && filter.type.includes('plan')) {
        throw new Error('synthetic notify-pass failure');
      }
      return realQuery(filter, limit, cursor);
    };
    const notifier = {
      async notify(): Promise<void> {},
    };
    const runner = new LoopRunner(host, {
      principalId: principal,
      runPlanProposalNotifyPass: true,
      planProposalNotifier: notifier,
    });
    const report = await runner.tick();
    expect(report.planProposalNotifyReport).toBeNull();
    expect(report.errors.some((e) => e.startsWith('plan-proposal-notify:'))).toBe(true);
  });
});
```

Run: `npx vitest run test/loop/runner.test.ts`. Expected: FAIL -- 6 tests fail because LoopRunner doesn't have the wiring yet.

- [ ] **Step 5.3: Wire the new pass into LoopRunner**

In `src/runtime/loop/runner.ts`:

1. Add import at the top:
```typescript
import {
  runPlanProposalNotifyTick,
  type PlanProposalNotifier,
  type PlanProposalNotifyResult,
} from '../plans/plan-trigger-telegram.js';
```

2. Add to the `Pick<LoopOptions, ...>` literal: `'runPlanProposalNotifyPass'`.

3. Add private fields:
```typescript
  private readonly planProposalNotifier: PlanProposalNotifier | null;
  private readonly planProposalNotifyPrincipal: PrincipalId;
  private warnedMissingNotifier: boolean = false;
```

4. In the constructor, populate the option default and store the seam:

```typescript
this.options = {
  // ... existing fields ...
  runPlanProposalNotifyPass: options.runPlanProposalNotifyPass ?? false,
};
// ... existing seam capture ...
this.planProposalNotifier = options.planProposalNotifier ?? null;
this.planProposalNotifyPrincipal = (options.planProposalNotifyPrincipal ?? options.principalId) as PrincipalId;
```

5. In `tick()`, declare the report var:
```typescript
let planProposalNotifyReport: LoopTickReport['planProposalNotifyReport'] = null;
```

6. Add the pass invocation AFTER the reconcile pass and BEFORE the report assembly. Place after the `if (this.options.runPlanReconcilePass)` block:

```typescript
    // --- Plan-proposal notify pass ------------------------------------------
    // Default-disabled. When enabled, scans proposed plans whose
    // principal is in the canon-defined allowlist and calls the
    // PlanProposalNotifier seam exactly once per plan (idempotence
    // via plan-push-record atoms). Runs AFTER reconcile so a
    // plan that just transitioned proposed -> abandoned this tick
    // is NOT pushed. Silent-skip when the notifier seam is absent
    // (once-per-runner warning), matching the refresher gap pattern.
    if (this.options.runPlanProposalNotifyPass) {
      if (this.planProposalNotifier === null) {
        if (!this.warnedMissingNotifier) {
          this.warnedMissingNotifier = true;
          // eslint-disable-next-line no-console
          console.error(
            '[plan-proposal-notify] WARN: runPlanProposalNotifyPass=true but no '
              + 'planProposalNotifier seam supplied; pass is skipped this tick. '
              + 'Wire one through LoopOptions.planProposalNotifier to activate. '
              + '(This warning is logged once per runner; subsequent silent-skip '
              + 'ticks stay quiet.)',
          );
        }
      } else {
        try {
          planProposalNotifyReport = await this.planProposalNotifyPass(this.planProposalNotifier);
        } catch (err) {
          this.errorCounter += 1;
          errors.push(
            `plan-proposal-notify: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
```

7. Add the field to the `kill switch` early-return report and to the regular report assembly (both spots). Both objects gain `planProposalNotifyReport,`.

8. Add audit metric and log fields:

```typescript
    if (planProposalNotifyReport !== null) {
      this.host.auditor.metric(
        'loop.plan_proposal_notify_scanned',
        planProposalNotifyReport.scanned,
      );
      this.host.auditor.metric(
        'loop.plan_proposal_notify_notified',
        planProposalNotifyReport.notified,
      );
    }
```

In the audit log details:

```typescript
        ...(planProposalNotifyReport !== null
          ? {
              plan_proposal_notify_scanned: planProposalNotifyReport.scanned,
              plan_proposal_notify_notified: planProposalNotifyReport.notified,
            }
          : {}),
```

9. Add the private method:

```typescript
  /**
   * Run one plan-proposal notify pass. Pure delegate to
   * `runPlanProposalNotifyTick`; LoopRunner adds scheduling +
   * audit only. The pluggable `PlanProposalNotifier` seam is
   * supplied at construction time via
   * `LoopOptions.planProposalNotifier`. The principal allowlist
   * is read inside the tick from canon
   * `pol-telegram-plan-trigger-principals` (default cto-actor +
   * cpo-actor).
   */
  private async planProposalNotifyPass(
    notifier: PlanProposalNotifier,
  ): Promise<NonNullable<LoopTickReport['planProposalNotifyReport']>> {
    const result: PlanProposalNotifyResult = await runPlanProposalNotifyTick(
      this.host,
      notifier,
      this.planProposalNotifyPrincipal,
    );
    return {
      scanned: result.scanned,
      notified: result.notified,
      skipped: result.skipped,
    };
  }
```

- [ ] **Step 5.4: Run the new tests**

```bash
npx vitest run test/loop/runner.test.ts -t "plan-proposal notify"
```

Expected: 6/6 PASS. (If a test fails, debug -- `vitest --reporter=verbose` to see which.)

Then run the full LoopRunner suite:

```bash
npx vitest run test/loop/runner.test.ts
```

Expected: 35/35 (29 pre-existing + 6 new). All pre-existing tests still pass (no regression).

- [ ] **Step 5.5: Run typecheck + build**

```bash
npm run typecheck && npm run build
```

Expected: clean.

- [ ] **Step 5.6: Commit**

```bash
git add src/runtime/loop/types.ts src/runtime/loop/runner.ts test/loop/runner.test.ts
node scripts/git-as.mjs lag-ceo git commit -m "feat(loop-runner): wire plan-proposal notify pass into LoopRunner.tick"
```

---

## Task 6: CLI plumbing

**Files:**
- Modify: `src/cli/run-loop.ts`

- [ ] **Step 6.1: Add CLI flag + option**

In `src/cli/run-loop.ts`:

1. Add to the parseArgs options object (after `'no-refresh-plan-observations'`):
```typescript
'notify-proposed-plans': { type: 'boolean', default: true },
'no-notify-proposed-plans': { type: 'boolean', default: false },
```

2. Add to `CliArgs`:
```typescript
readonly notifyProposedPlans: boolean;
```

3. Add to the resolved-args block:
```typescript
const notifyProposedPlans = Boolean(values['no-notify-proposed-plans'])
  ? false
  : Boolean(values['notify-proposed-plans']);
```

4. Add to the returned literal:
```typescript
notifyProposedPlans,
```

5. Add to `RunLoopMainOptions`:
```typescript
import type { PlanProposalNotifier } from '../runtime/plans/plan-trigger-telegram.js';

/**
 * Optional injection point: a deployment-side factory that builds the
 * plan-proposal notifier seam used by the notify pass. Mirrors
 * `prObservationRefresherFactory`. Returning `null` (or omitting the
 * field) activates the silent-skip path documented on
 * `LoopOptions.runPlanProposalNotifyPass`.
 */
export type PlanProposalNotifierFactory =
  () => Promise<PlanProposalNotifier | null> | PlanProposalNotifier | null;

export interface RunLoopMainOptions {
  // ... existing field ...
  readonly planProposalNotifierFactory?: PlanProposalNotifierFactory;
}
```

6. In `runLoopMain`, build the notifier:
```typescript
let planProposalNotifier: PlanProposalNotifier | null = null;
if (args.notifyProposedPlans && opts.planProposalNotifierFactory !== undefined) {
  try {
    planProposalNotifier = await opts.planProposalNotifierFactory();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[plan-proposal-notify] WARN: notifier factory threw: `
        + `${err instanceof Error ? err.message : String(err)}; notify pass will silent-skip.`,
    );
    planProposalNotifier = null;
  }
}
console.log(
  `[boot] notify-proposed-plans: ${
    args.notifyProposedPlans
      ? planProposalNotifier !== null
        ? 'ENABLED'
        : 'ENABLED (notifier unresolved; will silent-skip)'
      : 'DISABLED'
  }`,
);
```

7. In the LoopRunner construction:
```typescript
runPlanProposalNotifyPass: args.notifyProposedPlans,
...(planProposalNotifier !== null ? { planProposalNotifier } : {}),
```

8. In `formatTickReport`, add a notify segment after the refresh segment:

```typescript
const notify =
  report.planProposalNotifyReport !== null
    ? ` notify(notified=${report.planProposalNotifyReport.notified})`
    : '';
return (
  `tick ${report.tickNumber}: ` +
  `decayed=${report.atomsDecayed} ` +
  `l2+=${report.l2Promoted}/-=${report.l2Rejected} ` +
  `l3+=${report.l3Proposed} ` +
  `canon=${report.canonApplied}${reaper}${reconcile}${refresh}${notify}${err}${kill}`
);
```

9. Update `printUsage` with the new flags (mirror the `--refresh-plan-observations` block).

- [ ] **Step 6.2: Verify the CLI parses cleanly**

```bash
npm run build
node bin/lag-run-loop.js --help 2>&1 | grep -A 2 "notify-proposed"
```

Expected: the new flags render in --help.

- [ ] **Step 6.3: Run full test suite (no new tests for CLI yet -- bin smoke covers it)**

```bash
npx vitest run
```

Expected: all green (no regression).

- [ ] **Step 6.4: Commit**

```bash
git add src/cli/run-loop.ts
node scripts/git-as.mjs lag-ceo git commit -m "feat(cli): --notify-proposed-plans flag for run-loop"
```

---

## Task 7: Deployment-side adapter (scripts/lib + bin)

**Files:**
- Create: `scripts/lib/telegram-plan-trigger.mjs`
- Modify: `bin/lag-run-loop.js`
- Test: `test/scripts/lib/telegram-plan-trigger.test.ts`

- [ ] **Step 7.1: Write the failing adapter tests**

Create `test/scripts/lib/telegram-plan-trigger.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  validateNotifyArgs,
  createTelegramPlanProposalNotifier,
  formatTelegramMessage,
} from '../../../scripts/lib/telegram-plan-trigger.mjs';

describe('validateNotifyArgs', () => {
  it('accepts a valid plan + summary', () => {
    expect(validateNotifyArgs({
      plan: { id: 'p1', content: '...' },
      summary: { title: 'T', body: 'B' },
    })).toBe(true);
  });
  it('throws on missing plan', () => {
    expect(() => validateNotifyArgs({ summary: { title: '', body: '' } })).toThrow(/plan/);
  });
  it('throws on plan without id', () => {
    expect(() => validateNotifyArgs({
      plan: { content: '' },
      summary: { title: 'T', body: 'B' },
    })).toThrow(/id/);
  });
  it('throws on missing summary', () => {
    expect(() => validateNotifyArgs({ plan: { id: 'p1' } })).toThrow(/summary/);
  });
});

describe('formatTelegramMessage', () => {
  it('formats with plan id, title, body, and run-discuss command', () => {
    const msg = formatTelegramMessage({
      plan: { id: 'plan-foo' },
      summary: { title: 'Foo plan', body: 'Body content here.' },
    });
    expect(msg).toContain('Foo plan');
    expect(msg).toContain('Body content here.');
    expect(msg).toContain('plan-foo');
    expect(msg).toContain('plan-discuss-telegram.mjs plan-foo');
  });
  it('truncates very long bodies to keep the Telegram message digestible', () => {
    const longBody = 'x'.repeat(4500);
    const msg = formatTelegramMessage({
      plan: { id: 'p1' },
      summary: { title: 'T', body: longBody },
    });
    // Telegram messages have a 4096 char limit; we cap at ~3500 to leave headroom for title/cmd/etc.
    expect(msg.length).toBeLessThan(4096);
    expect(msg).toContain('[truncated]');
  });
});

describe('createTelegramPlanProposalNotifier', () => {
  const SAVED_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const SAVED_CHAT = process.env.TELEGRAM_CHAT_ID;
  beforeEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
  });
  afterEach(() => {
    if (SAVED_TOKEN === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = SAVED_TOKEN;
    if (SAVED_CHAT === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = SAVED_CHAT;
  });
  it('returns null when TELEGRAM_BOT_TOKEN is missing', () => {
    process.env.TELEGRAM_CHAT_ID = '12345';
    const result = createTelegramPlanProposalNotifier();
    expect(result).toBeNull();
  });
  it('returns null when TELEGRAM_CHAT_ID is missing', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'abc';
    const result = createTelegramPlanProposalNotifier();
    expect(result).toBeNull();
  });
  it('returns null when both are missing (silent-skip path)', () => {
    expect(createTelegramPlanProposalNotifier()).toBeNull();
  });
  it('builds an adapter when env is present (without sending)', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'abc';
    process.env.TELEGRAM_CHAT_ID = '12345';
    const adapter = createTelegramPlanProposalNotifier();
    expect(adapter).not.toBeNull();
    expect(typeof adapter?.notify).toBe('function');
  });
  it('sends via the injected fetchImpl when notify is called', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'abc';
    process.env.TELEGRAM_CHAT_ID = '12345';
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const adapter = createTelegramPlanProposalNotifier({ fetchImpl });
    await adapter.notify({
      plan: { id: 'p1', content: '# T\n\nB' },
      summary: { title: 'T', body: 'B' },
    });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain('https://api.telegram.org/botabc/sendMessage');
    expect((calls[0].body as { chat_id: string }).chat_id).toBe('12345');
    expect((calls[0].body as { text: string }).text).toContain('T');
  });
  it('throws when Telegram returns ok:false (counted as notify-failed by tick)', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'abc';
    process.env.TELEGRAM_CHAT_ID = '12345';
    const fetchImpl: typeof fetch = async () => {
      return new Response(JSON.stringify({ ok: false, error_code: 401, description: 'unauthorized' }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const adapter = createTelegramPlanProposalNotifier({ fetchImpl });
    await expect(adapter.notify({
      plan: { id: 'p1' },
      summary: { title: 'T', body: 'B' },
    })).rejects.toThrow(/Telegram/);
  });
});
```

Run: `npx vitest run test/scripts/lib/telegram-plan-trigger.test.ts`. Expected: FAIL -- module not found.

- [ ] **Step 7.2: Implement the adapter**

Create `scripts/lib/telegram-plan-trigger.mjs`:

```javascript
/**
 * Plan-proposal Telegram notifier: deployment-side adapter that the
 * LoopRunner's runPlanProposalNotifyTick invokes when a new proposed
 * plan needs to land on the operator's phone.
 *
 * Responsibility: read TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID from env,
 * format a Telegram-friendly message from the plan + summary the
 * framework hands us, POST sendMessage. Loud-fail on Telegram API error
 * so the framework counts it as skipped['notify-failed'] and retries
 * next tick.
 *
 * The framework module src/runtime/plans/plan-trigger-telegram.ts stays
 * mechanism-only; this module carries the env-var, HTTP, and Telegram-
 * shaped concerns per the substrate-not-prescription canon. Mirrors
 * scripts/lib/pr-observation-refresher.mjs in shape and budget.
 *
 * Returns null from the factory when env is incomplete -> framework
 * silent-skips per LoopRunner contract. The bin entrypoint
 * (bin/lag-run-loop.js) wires the factory; src/ never reads env.
 */

const TELEGRAM_BASE = 'https://api.telegram.org';
/**
 * Telegram's sendMessage body limit is 4096 chars. We cap message
 * total well below that so we have headroom for the formatting
 * preamble + plan id + run-discuss command. The plan body is
 * truncated independently inside formatTelegramMessage.
 */
const MAX_MESSAGE_CHARS = 3500;
const MAX_BODY_CHARS = 3000;
const HTTP_TIMEOUT_MS = 30_000;

/**
 * Validation guard. Throws Error with descriptive message on malformed
 * input. Exported for unit-test pinning.
 *
 * @param {unknown} args
 * @returns {true}
 */
export function validateNotifyArgs(args) {
  if (!args || typeof args !== 'object') {
    throw new Error('notify: args must be an object');
  }
  const { plan, summary } = args;
  if (!plan || typeof plan !== 'object') {
    throw new Error('notify: args.plan must be an object {id, content?}');
  }
  if (typeof plan.id !== 'string' || plan.id.length === 0) {
    throw new Error('notify: plan.id must be a non-empty string');
  }
  if (!summary || typeof summary !== 'object') {
    throw new Error('notify: args.summary must be an object {title, body}');
  }
  if (typeof summary.title !== 'string') {
    throw new Error('notify: summary.title must be a string');
  }
  if (typeof summary.body !== 'string') {
    throw new Error('notify: summary.body must be a string');
  }
  return true;
}

/**
 * Pure formatter: produces the Telegram message text from plan +
 * summary. Truncates long bodies to keep total under
 * MAX_MESSAGE_CHARS. Exported for unit tests.
 *
 * Format:
 *   LAG: new proposed plan
 *
 *   <title>
 *
 *   <body, truncated if needed>
 *
 *   Plan ID: <id>
 *   Discuss / approve on phone: node scripts/plan-discuss-telegram.mjs <id>
 *
 * @param {{ plan: { id: string }, summary: { title: string, body: string } }} args
 */
export function formatTelegramMessage(args) {
  const { plan, summary } = args;
  let body = summary.body;
  if (body.length > MAX_BODY_CHARS) {
    body = body.slice(0, MAX_BODY_CHARS) + '\n[truncated]';
  }
  const msg = [
    'LAG: new proposed plan',
    '',
    summary.title,
    '',
    body,
    '',
    `Plan ID: ${plan.id}`,
    `Discuss / approve on phone: node scripts/plan-discuss-telegram.mjs ${plan.id}`,
  ].join('\n');
  if (msg.length > MAX_MESSAGE_CHARS) {
    return msg.slice(0, MAX_MESSAGE_CHARS - 12) + '\n[truncated]';
  }
  return msg;
}

/**
 * Build the {@link PlanProposalNotifier} adapter. Returns null when
 * TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is unset (the framework
 * silent-skips). Both env names match the existing
 * scripts/plan-{approve,discuss}-telegram.mjs conventions.
 *
 * @param {{
 *   readonly fetchImpl?: typeof fetch,
 *   readonly timeoutMs?: number,
 * }} [options]
 */
export function createTelegramPlanProposalNotifier(options = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return null;
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? HTTP_TIMEOUT_MS;
  return {
    /**
     * @param {{ plan: { id: string, content?: string }, summary: { title: string, body: string } }} args
     */
    async notify(args) {
      validateNotifyArgs(args);
      const text = formatTelegramMessage(args);
      const url = `${TELEGRAM_BASE}/bot${token}/sendMessage`;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: String(chatId),
            text,
            disable_web_page_preview: true,
          }),
          signal: ac.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      let json;
      try {
        json = await res.json();
      } catch {
        throw new Error(`Telegram sendMessage: response was not JSON (status ${res.status})`);
      }
      if (!json || json.ok !== true) {
        throw new Error(
          `Telegram sendMessage failed: ${json?.error_code ?? 'unknown'} ${json?.description ?? ''}`,
        );
      }
    },
  };
}
```

Run: `npx vitest run test/scripts/lib/telegram-plan-trigger.test.ts`. Expected: PASS (12/12).

- [ ] **Step 7.3: Wire factory into bin entrypoint**

In `bin/lag-run-loop.js`, add a second factory:

```javascript
const NOTIFIER_HELPER = resolve(HERE, '..', 'scripts', 'lib', 'telegram-plan-trigger.mjs');

async function planProposalNotifierFactory() {
  try {
    const mod = await import(pathToFileURL(NOTIFIER_HELPER).href);
    if (typeof mod.createTelegramPlanProposalNotifier !== 'function') {
      console.error(
        `[plan-proposal-notify] WARN: notifier helper at ${NOTIFIER_HELPER} did not `
          + 'export createTelegramPlanProposalNotifier; notify pass will silent-skip.',
      );
      return null;
    }
    return mod.createTelegramPlanProposalNotifier();
  } catch (err) {
    console.error(
      `[plan-proposal-notify] WARN: could not load notifier helper at ${NOTIFIER_HELPER}: `
        + `${err instanceof Error ? err.message : String(err)}; notify pass will silent-skip.`,
    );
    return null;
  }
}

const exitCode = await runLoopMain({
  prObservationRefresherFactory,
  planProposalNotifierFactory,
}).catch((err) => {
  console.error('fatal:', err instanceof Error ? (err.stack ?? err.message) : String(err));
  return 2;
});
```

- [ ] **Step 7.4: Run full suite**

```bash
npx vitest run
```

Expected: all green.

- [ ] **Step 7.5: CLI smoke test**

```bash
npm run build
node bin/lag-run-loop.js --help 2>&1 | head -40
```

Expected: --help renders cleanly with the new flag.

- [ ] **Step 7.6: Commit**

```bash
git add scripts/lib/telegram-plan-trigger.mjs bin/lag-run-loop.js test/scripts/lib/telegram-plan-trigger.test.ts
node scripts/git-as.mjs lag-ceo git commit -m "feat(scripts): telegram plan-proposal notifier adapter + bin wiring"
```

---

## Task 8: Bootstrap canon for the allowlist policy

**Files:**
- Create: `scripts/bootstrap-telegram-plan-trigger-canon.mjs`
- Test: smoke-only (the canon reader test in Task 3 already covers the schema)

The bootstrap script writes the seed `pol-telegram-plan-trigger-principals` directive atom so a fresh deployment without operator action gets the indie-floor defaults visible in canon (matches the pattern of `scripts/lib/reaper-canon-policies.mjs`).

- [ ] **Step 8.1: Inspect the existing canon-bootstrap helper pattern**

```bash
ls scripts/lib/*canon*.mjs
```

Read `scripts/lib/reaper-canon-policies.mjs` quickly to mirror the shape. The pattern is: export an `async function` returning an array of atoms, callable from a top-level bootstrap runner.

- [ ] **Step 8.2: Write the bootstrap helper**

Create `scripts/lib/telegram-plan-trigger-canon-policies.mjs`:

```javascript
/**
 * Canon policy seeds for the telegram-plan-trigger feature.
 *
 * - pol-telegram-plan-trigger-principals: indie-floor allowlist of
 *   principals whose proposed plans are auto-pushed to Telegram.
 *   Defaults to ['cto-actor', 'cpo-actor']. Override by editing the
 *   metadata.policy.principal_ids array on this atom (or supersede
 *   with a higher-priority project-scope atom per
 *   dev-substrate-not-prescription).
 *
 * Shape mirrors scripts/lib/reaper-canon-policies.mjs.
 */

/**
 * @param {string} apexPrincipalId
 * @param {string} createdAtIso
 * @returns {ReadonlyArray<unknown>}
 */
export function buildTelegramPlanTriggerCanonAtoms(apexPrincipalId, createdAtIso) {
  return [
    {
      schema_version: 1,
      id: 'pol-telegram-plan-trigger-principals',
      content:
        'Allowlist of principals whose newly-proposed plan atoms are auto-pushed to '
        + 'Telegram by the LoopRunner notify pass. Default: cto-actor + cpo-actor (the '
        + 'two planning-shaped roles that produce operator-actionable plans). Org-ceiling '
        + 'deployments override the principal_ids array via canon edit; an empty array '
        + 'is the explicit opt-out.',
      type: 'directive',
      layer: 'L3',
      provenance: {
        kind: 'operator-seeded',
        source: { agent_id: 'bootstrap', tool: 'bootstrap-telegram-plan-trigger-canon' },
        derived_from: [],
      },
      confidence: 1.0,
      created_at: createdAtIso,
      last_reinforced_at: createdAtIso,
      expires_at: null,
      supersedes: [],
      superseded_by: [],
      scope: 'project',
      signals: {
        agrees_with: [],
        conflicts_with: [],
        validation_status: 'unchecked',
        last_validated_at: null,
      },
      principal_id: apexPrincipalId,
      taint: 'clean',
      metadata: {
        policy: {
          subject: 'telegram-plan-trigger-principals',
          principal_ids: ['cto-actor', 'cpo-actor'],
        },
      },
    },
  ];
}
```

Create `scripts/bootstrap-telegram-plan-trigger-canon.mjs`:

```javascript
#!/usr/bin/env node
/**
 * Bootstrap-time installer for the telegram-plan-trigger canon
 * policy atom. Idempotent: re-running on an existing deployment
 * skips writes when the atom already exists (no duplicate seed).
 *
 * Usage:
 *   node scripts/bootstrap-telegram-plan-trigger-canon.mjs [--root .lag] [--principal apex-agent]
 *
 * Exit codes:
 *   0  installed (or already present)
 *   1  unexpected error
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';
import { buildTelegramPlanTriggerCanonAtoms } from './lib/telegram-plan-trigger-canon-policies.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { rootDir: '.lag', principal: 'apex-agent' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) {
      out.rootDir = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--principal' && argv[i + 1]) {
      out.principal = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--help') {
      out.help = true;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/bootstrap-telegram-plan-trigger-canon.mjs [--root .lag] [--principal apex-agent]');
    process.exit(0);
  }
  const rootDir = resolve(REPO_ROOT, args.rootDir);
  const host = await createFileHost({ rootDir });
  const atoms = buildTelegramPlanTriggerCanonAtoms(args.principal, host.clock.now());
  let installed = 0;
  let skipped = 0;
  for (const atom of atoms) {
    const existing = await host.atoms.get(atom.id);
    if (existing !== null) {
      skipped += 1;
      continue;
    }
    await host.atoms.put(atom);
    installed += 1;
    console.log(`[bootstrap] installed canon: ${atom.id}`);
  }
  console.log(`[bootstrap] done. installed=${installed} skipped=${skipped}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('bootstrap-telegram-plan-trigger-canon fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 8.3: Smoke-test the bootstrap**

```bash
npm run build
# Run on a temp directory to avoid mutating .lag/
mkdir -p /tmp/telegram-canon-smoke/.lag/atoms /tmp/telegram-canon-smoke/.lag/principals
echo '{"id":"apex-agent","name":"Apex","role":"agent","permitted_scopes":{"read":["global"],"write":["global"]},"permitted_layers":{"read":["L0","L1","L2","L3"],"write":["L0","L1","L2","L3"]},"goals":[],"constraints":[],"active":true,"compromised_at":null,"signed_by":null,"created_at":"2026-05-05T00:00:00.000Z"}' > /tmp/telegram-canon-smoke/.lag/principals/apex-agent.json
C:/Users/opens/AppData/Roaming/nvm/v22.17.1/node.exe scripts/bootstrap-telegram-plan-trigger-canon.mjs --root /tmp/telegram-canon-smoke/.lag --principal apex-agent
# Re-run to verify idempotence
C:/Users/opens/AppData/Roaming/nvm/v22.17.1/node.exe scripts/bootstrap-telegram-plan-trigger-canon.mjs --root /tmp/telegram-canon-smoke/.lag --principal apex-agent
ls /tmp/telegram-canon-smoke/.lag/atoms/
```

Expected first run: `installed=1 skipped=0` and a `pol-telegram-plan-trigger-principals.json` file. Second run: `installed=0 skipped=1`.

- [ ] **Step 8.4: Commit**

```bash
git add scripts/lib/telegram-plan-trigger-canon-policies.mjs scripts/bootstrap-telegram-plan-trigger-canon.mjs
node scripts/git-as.mjs lag-ceo git commit -m "feat(scripts): bootstrap canon for telegram-plan-trigger principal allowlist"
```

---

## Task 9: Final verification + lint

**Files:** none

- [ ] **Step 9.1: Run the full test suite**

```bash
npx vitest run 2>&1 | tail -10
```

Expected: 100% pass.

- [ ] **Step 9.2: Run typecheck + build**

```bash
npm run typecheck && npm run build
```

Expected: clean.

- [ ] **Step 9.3: Pre-push grep checklist** (per `feedback_pre_push_grep_checklist`)

```bash
# Emdash check
grep -rn $'\u2014' src/ scripts/ test/ docs/superpowers/specs/2026-05-05-* docs/superpowers/plans/2026-05-05-* 2>/dev/null && echo "FAIL: emdashes found" || echo "OK: no emdashes"

# Private terms (the list lives in .github/workflows/ci.yml)
grep -rn -iE "claude.com.code|generated with|co-authored-by: claude|🤖" src/ scripts/ test/ 2>/dev/null && echo "FAIL: private terms" || echo "OK: no private terms"

# src/ JSDoc rule: no design/ paths, no canon ids referenced
grep -rn -iE "design/|adr-|inv-|dev-|pol-|arch-" src/runtime/plans/plan-trigger-telegram.ts src/runtime/loop/telegram-plan-trigger-allowlist.ts 2>/dev/null | grep -v "// " | head -5
```

Expected first: OK. Second: OK. Third: any matches must be in JSDoc comments only and reference policy NAMES (not paths), which is allowed since we cite policy SUBJECTS (the substrate-level identifier) not the CLAUDE.md atom IDs.

Wait -- re-reading `feedback_src_docs_mechanism_only_no_design_links`: "no design/ADR paths, no canon ids, no specific adapter/actor names in framework code docs". The new src/ files reference `pol-telegram-plan-trigger-principals` (a canon id). That's a violation.

Fix: scrub the src/ JSDoc to refer to the POLICY SUBJECT only ("the telegram-plan-trigger-principals policy"), not the canon atom id.

- [ ] **Step 9.4: Scrub src/ JSDoc**

In `src/runtime/plans/plan-trigger-telegram.ts` and `src/runtime/loop/telegram-plan-trigger-allowlist.ts`, replace any reference to `pol-telegram-plan-trigger-principals` with "the telegram-plan-trigger-principals canon policy". No `dev-...`, `arch-...`, or `inv-...` IDs in src/. Allow citing policy SUBJECTS (which are protocol identifiers, not canon atom IDs) since `approval-cycle-interval.ts` already cites subjects.

Verify:

```bash
grep -nE "pol-|inv-|dev-|arch-" src/runtime/plans/plan-trigger-telegram.ts src/runtime/loop/telegram-plan-trigger-allowlist.ts
```

Expected: no matches.

- [ ] **Step 9.5: cr-precheck on the diff**

```bash
node scripts/cr-precheck.mjs --base origin/main --head HEAD 2>&1 | tail -30
```

Expected: 0 critical / 0 major findings. Minor findings: address before push.

- [ ] **Step 9.6: Canon-audit dispatch (per dev-implementation-canon-audit-loop)**

Dispatch a canon-compliance auditor sub-agent on the full diff. Provide:
- `CLAUDE.md` (canon)
- The plan: `docs/superpowers/plans/2026-05-05-telegram-plan-auto-trigger.md`
- The diff: `git diff origin/main...HEAD`
- The threat model context: this introduces an outbound-Telegram I/O path triggered automatically; the substrate purity, indie-floor fit, and idempotence guarantees are the load-bearing claims.

Auditor returns Approved or Issues Found. Address Issues Found before commit.

- [ ] **Step 9.7: Commit any audit fixes**

```bash
git add -p
node scripts/git-as.mjs lag-ceo git commit -m "fix: address canon-audit findings"
```

(Skip this commit if no fixes were needed.)

---

## Task 10: PR open + CR + merge

**Files:** none

- [ ] **Step 10.1: Push the branch**

```bash
node scripts/git-as.mjs lag-ceo git push origin feat/loop-runner-telegram-auto-trigger
```

- [ ] **Step 10.2: Open the PR via lag-ceo**

```bash
node scripts/gh-as.mjs lag-ceo pr create \
  --title "feat(loop-runner): auto-fire telegram-push for proposed plans" \
  --body "$(cat <<'EOF'
## Summary

LoopRunner.tick() now auto-fires a Telegram push for every newly-proposed plan atom from the canon-defined principal allowlist (default: cto-actor + cpo-actor). Closes the substrate gap surfaced by the operator 2026-05-05: "and am I supposed to ever be telegrammed or no" -- yes, but auto-trigger ships in this PR.

This is the same shape as PR #318 (approval-cycle wiring): pluggable seam, default-OFF framework option flipped to ON at the indie-floor CLI, idempotence via a marker atom, best-effort tick (failure logs to errors[] without aborting the loop).

## What's new

- **`runPlanProposalNotifyTick(host, notifier, principal, options)`** -- pure tick function in `src/runtime/plans/plan-trigger-telegram.ts`. Mechanism-only: scans proposed plans, filters by allowlist, checks idempotence, delegates to a `PlanProposalNotifier` seam.
- **`plan-push-record` atom type** -- written per successful notify with `provenance.derived_from: [planId]`. Re-tick of the same state is a no-op.
- **`pol-telegram-plan-trigger-principals` canon policy** -- allowlist (canon-tunable; defaults to cto-actor + cpo-actor).
- **`PlanProposalNotifier` seam + `LoopOptions.runPlanProposalNotifyPass`** -- same pattern as `PrObservationRefresher` from PR #318.
- **`--notify-proposed-plans` CLI flag** -- default ON at the indie-floor; `--no-notify-proposed-plans` for sandboxed deployments.
- **`scripts/lib/telegram-plan-trigger.mjs`** -- deployment-side adapter; reads TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID env, formats message, POSTs sendMessage. Returns null when env is incomplete -> framework silent-skips per the LoopRunner contract.
- **`scripts/lib/plan-summary.mjs`** -- pure formatter extracted at N=3 callers per `dev-dry-extract-at-second-duplication`.
- **`scripts/bootstrap-telegram-plan-trigger-canon.mjs`** -- idempotent installer for the policy atom.

## Why a pluggable seam, not a baked-in Telegram call

`dev-framework-mechanism-only`: framework code stays mechanism-focused. The tick decides "this plan needs a notification"; the deployment-side adapter does the Telegram POST. This mirrors `PrObservationRefresher`. Org-ceiling deployments swap the adapter (Slack, email, multi-chat) without framework changes.

## Why an atom record, not a metadata field, for idempotence

Atoms are signed, append-only records (`arch-atomstore-source-of-truth`). Mutating `plan.metadata.telegram_pushed_at` after the fact would compromise the audit chain. The reconcile-pass uses `plan-merge-settled` markers, not in-place mutation, for the same reason.

## Indie-floor / Org-ceiling fit

- Solo dev with `.env` set: zero config, default cadence, default allowlist. Phone pings within ~60s of new proposed plan.
- Solo dev without `.env`: factory returns null -> silent-skip. No errors.
- Org with custom allowlist: edit the canon policy.
- Org with custom channel (Slack/email): BYO `PlanProposalNotifier` adapter.

## Test plan

- [x] 9 unit tests on `runPlanProposalNotifyTick`: idempotence, allowlist enforcement, plan-state filter, notifier-failure path, rate-limit, taint guard, override option, canon read, default-allowlist.
- [x] 6 LoopRunner integration tests: default-off, missing-seam silent-skip + once-per-runner warning, enabled push, idempotent across two ticks, notifier-throw counted, internal-failure best-effort.
- [x] 7 canon-reader tests: defaults on absence, canon hit, empty-array opt-out, malformed (non-array, non-string entries), tainted, superseded.
- [x] 5 plan-summary formatter tests covering h1/h2/h3, no-heading fallback, empty content.
- [x] 12 telegram-plan-trigger adapter tests: arg validation, message formatter, env-handling, fetchImpl injection, ok:false response handling.
- [x] cr-precheck: 0 critical / 0 major / 0 minor findings.
- [x] CLI smoke: `node bin/lag-run-loop.js --help` renders the new flags cleanly.
- [x] Build: `npm run build` produces clean dist/.
- [x] Bootstrap script smoke: idempotent re-run skips the seed.

EOF
)"
```

Capture the PR number from output.

- [ ] **Step 10.3: Trigger CR via the machine user**

```bash
node scripts/cr-trigger.mjs <PR-NUMBER>
```

- [ ] **Step 10.4: Wait for CR + CI**

Use `node scripts/pr-status.mjs <PR-NUMBER>` to poll. When CR returns findings:
1. Fix critical/major findings; commit + push.
2. After fix-push: `node scripts/resolve-outdated-threads.mjs <PR-NUMBER>` (per `dev-resolve-outdated-threads-after-fix-push`).
3. Re-trigger CR via `cr-trigger.mjs`.

- [ ] **Step 10.5: Merge when CLEAN**

When `mergeStateStatus=CLEAN` + `reviewDecision=APPROVED` + all required checks green:

```bash
node scripts/gh-as.mjs lag-ceo pr merge <PR-NUMBER> --squash
```

Per `dev-required-checks-must-cover-all-meaningful-ci`: never merge on UNSTABLE.

- [ ] **Step 10.6: Pull main in primary worktree**

After merge (per `feedback_pull_main_after_pr_merge`):

```bash
cd C:/Users/opens/memory-governance
git fetch origin main
# (the primary worktree may be on another branch; pull main wherever the live code runs)
```

- [ ] **Step 10.7: (Optional) Run the bootstrap on this deployment**

```bash
C:/Users/opens/AppData/Roaming/nvm/v22.17.1/node.exe scripts/bootstrap-telegram-plan-trigger-canon.mjs
```

This installs the seed canon atom on the live deployment so the auto-trigger tick has the allowlist policy in canon (rather than relying on the hardcoded fallback).

---

## Done criteria

1. PR merged in main with `mergeStateStatus=CLEAN`.
2. All tests green in CI.
3. CR returned APPROVED with no outstanding critical/major findings.
4. `lag-run-loop.js` boot logs show `notify-proposed-plans: ENABLED`.
5. The next /loop tick on a real deployment with a proposed cto-actor plan delivers a Telegram message.
