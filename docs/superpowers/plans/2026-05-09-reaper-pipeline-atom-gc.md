# Implementation Plan: Extend LAG Reaper to GC Pipeline + Stage Atoms

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add TTL-driven GC for completed-pipeline and stage-event atom subgraphs to the existing LAG reaper, so the `.lag/atoms/` store stops growing unbounded as pipeline runs accumulate.

**Architecture:** Introduce a sibling `pipeline-reaper.ts` module under `src/runtime/plans/` (alongside the existing `reaper.ts`), with its own TTL config, classification, and transition primitives. Compose both reapers under one LoopRunner pass. New canon-policy atom `pol-pipeline-reaper-ttls-default` is parallel to `pol-reaper-ttls-default`.

**Tech Stack:** TypeScript, vitest, FileHost adapter, AtomStore substrate.

---

## Status Today

The reaper at `src/runtime/plans/reaper.ts` (332 lines) only abandons stale `proposed` plans (24h warn / 72h auto-abandon). The driver `scripts/reap-stale-plans.mjs` and the LoopRunner pass at `src/runtime/loop/runner.ts:486` both wrap that single function. Eleven other atom types accumulate per pipeline run and are never reaped.

## Section 1 - Audit findings

### 1.1 What types accumulate (concrete, today)

Census of `.lag/atoms/` (3,239 files total):

| Atom type | Count today | Per-pipeline | Reaped today? |
|---|---|---|---|
| `agent-session` | 291 | 1 (root) + N (one per stage agentic run) | no |
| `agent-turn` | 296 | N per session (typically 2-15) | no |
| `pipeline-stage-event` | 438 | 5-10 per pipeline | no |
| `pipeline-audit-finding` | 15 | 0-N per stage | no |
| `pipeline` (root atom) | 49 | 1 per run | no |
| `pipeline-failed` | 10 | 0-1 per failed run | no |
| `pipeline-resume` | 0 | 0-N per HIL-paused run | no |
| `brainstorm-output` | 46 | 1 per run | no |
| `spec-output` | 45 | 1 per run | no |
| `review-report` | 38 | 1 per run | no |
| `dispatch-record` | 38 | 1 per run | no |

A single substrate-deep pipeline run produces ~15-25 atoms. At 49 runs to date this is ~500-1,200 atoms; at 10x volume the store crosses ~12k atoms. Cost is not just disk: `host.atoms.query()` pages through every JSON file on FileHost on every reaper sweep.

### 1.2 Current TTL policy shape (`pol-reaper-ttls-default`)

Confirmed from `scripts/lib/reaper-canon-policies.mjs:32-61`:

```js
metadata.policy = {
  subject: 'reaper-ttls',
  reason: '<rationale>',
  warn_ms: 86_400_000,      // 24h
  abandon_ms: 259_200_000,  // 72h
}
```

Today this is a single warn/abandon pair, not parameterized by atom-type. The reader returns `{staleWarnMs, staleAbandonMs}`. Any pipeline-GC TTLs need to be additive (new atom subject), not a rewrite of the existing shape.

### 1.3 Deletion vs. labeling doctrine for non-plan atoms

The doctrine in `reaper.ts:9` ("Content is preserved; the label is the change") is enforced at the substrate layer: `AtomStore` has `put`, `get`, `query`, `update`, `batchUpdate`, `embed`, `similarity`, `contentHash`, `subscribe` - and **zero deletion verbs**. Hard deletion would violate substrate purity (atom-detail viewer, `derived_from` provenance chains).

V0 doctrine for non-plan atoms:
- Keep "atoms are never deleted" as the unchanged invariant.
- Add a new metadata key `metadata.reaped_at` (ISO timestamp from `host.clock.now()`) + `metadata.reaped_reason` ('terminal-pipeline-ttl', 'stage-event-ttl', etc.) on reaped atoms.
- Filter the Console projection to hide reaped atoms by default with a "Show reaped (N)" toggle.
- Floor confidence to `0.01` so arbitration deprioritizes reaped atoms.
- Defer hard deletion to a separate "compactor" task (out of scope for #298) that requires a new `AtomStore.archive()` substrate primitive.

### 1.4 Reusing `transitionPlanState` for non-plan atoms

`transitionPlanState` is plan-specific by construction (throws on `atom.type !== 'plan'`, validates against `PlanState` machine). For pipeline atoms the runner already uses direct `host.atoms.update` calls; no enforced state machine on `pipeline_state`. For stage outputs and agent atoms, no equivalent state field exists.

**Decision:** introduce two new transition primitives, mirroring the shape of `transitionPlanState`:
- `markPipelineReaped(host, atomId, principalId, reason)` - emits audit `kind: 'pipeline.reaped'`.
- `markStageAtomReaped(host, atomId, principalId, reason)` - emits audit `kind: 'pipeline.stage_atom_reaped'`.

Do NOT widen `transitionPlanState`; its plan-specificity is correctness load-bearing.

---

## Section 2 - Design choice: new `pipeline-reaper.ts` module

**Choice:** Introduce a new `src/runtime/plans/pipeline-reaper.ts` module (sibling to `reaper.ts`).

### Justification

1. **Different doctrine, different module.** The plan reaper transitions `proposed → abandoned` via the existing state machine (one-shot label change on a single atom type). The pipeline reaper GCs the entire subgraph rooted at a terminal-state pipeline (multi-type cascade walk through `derived_from` traversal). The two share zero code paths past the TTL-arithmetic helpers.

2. **Substrate-not-prescription, applied to TTL maps.** The plan reaper's `ReaperTtls` is `{staleWarnMs, staleAbandonMs}` - two scalars. Extending to per-atom-type TTLs would force every existing caller to thread a `Map<AtomType, ...>` through that signature, breaking every test fixture.

3. **Independent kill-switch + pagination posture.** Pagination caps need to be different (per-type budgets vs. one global cap).

4. **Composition, not extension.** Both reapers compose under one LoopRunner pass; the composition layer is where "this is one logical sweep" lives.

5. **Per-atom-type TTL map shape.** Inside `pipeline-reaper.ts`:
   ```ts
   export interface PipelineReaperTtls {
     readonly terminalPipelineMs: number;   // GC after pipeline_state: completed/failed
     readonly hilPausedPipelineMs: number;  // GC for hil-paused that never resumed
     readonly stageEventMs: number;
     readonly stageOutputMs: number;
     readonly agentSessionMs: number;
     readonly auditFindingMs: number;
   }
   ```
   Deliberately NOT a generic `Map<AtomType, number>`: the reaper enumerates types it knows how to GC. New atom types added without an explicit entry get NO GC (default-safe).

### Tradeoff acknowledged

The alternative considered and rejected: a per-atom-type TTL map inside the existing `ReaperTtls`. Pro: one module, one knob surface. Con: existing `validateReaperTtls` strict pair-comparison breaks; existing tests in `test/runtime/plans/reaper.test.ts` (366 lines) all use the two-scalar shape; the LoopRunner constructor's TTL validation is two-scalar throughout. Cost-of-change is high; cost-of-add for a new module is low.

---

## Section 3 - Per-task breakdown

Total: 7 tasks. Each ships as a separate atomic PR.

### Task 1 - Document `metadata.reaped_at` convention on `AtomPatch`

**Files (modify):**
- Create: (none)
- Modify: `src/substrate/types.ts` - JSDoc on `AtomPatch.metadata` documenting the convention; JSDoc on `AtomType` for pipeline-related types describing GC posture.
- Test: `test/conformance/atom-store-conformance.test.ts` - round-trip `metadata.reaped_at`/`metadata.reaped_reason` on MemoryAtomStore + FileAtomStore.

**Steps:**
- [ ] **Step 1:** Read `src/substrate/types.ts` to locate `AtomPatch` + `AtomType` definitions.
- [ ] **Step 2:** Add JSDoc convention block to `AtomPatch.metadata` describing `reaped_at` (ISO via `host.clock.now()`) + `reaped_reason` (finite string discriminator).
- [ ] **Step 3:** Add JSDoc on the relevant `AtomType` union members (pipeline, pipeline-stage-event, brainstorm-output, etc.) noting GC posture.
- [ ] **Step 4:** Write the round-trip conformance test.
- [ ] **Step 5:** Run `npm run typecheck` + `npx vitest run test/conformance/`.
- [ ] **Step 6:** Commit + push.

**Security + correctness considerations:**
- `metadata.reaped_at` MUST be set with `host.clock.now()`, never `new Date().toISOString()` (substrate purity).
- `metadata.reaped_reason` MUST be a finite string discriminator; grep before to confirm zero existing writers.

**Dependencies:** none (foundation).

---

### Task 2 - Add `pipeline-reaper.ts` module

**Files (new):**
- Create: `src/runtime/plans/pipeline-reaper.ts` - exports `PipelineReaperTtls`, `DEFAULT_PIPELINE_REAPER_TTLS`, `validatePipelineReaperTtls`, `classifyPipelineForReap`, `markPipelineReaped`, `markStageAtomReaped`, `loadAllTerminalPipelines`, `runPipelineReaperSweep`.
- Modify: `src/runtime/plans/index.ts` - re-export the new public surface.
- Test: `test/runtime/plans/pipeline-reaper.test.ts` - mirrors structure of `reaper.test.ts`.

**Default TTLs (conservative):**
- `terminalPipelineMs`: 30 days
- `hilPausedPipelineMs`: 14 days
- `stageEventMs`, `stageOutputMs`, `auditFindingMs`: derived (reaped immediately when parent pipeline is reaped)
- `agentSessionMs`: 30 days

**Steps:**
- [ ] **Step 1:** Read `reaper.ts` end-to-end as reference shape.
- [ ] **Step 2:** Write failing tests for `validatePipelineReaperTtls`, `classifyPipelineForReap` (skip running, skip recently-completed, classify old as `reap`, HIL-paused-stale, future-dated safety).
- [ ] **Step 3:** Implement `pipeline-reaper.ts` (TTL types, validation, classification).
- [ ] **Step 4:** Write failing tests for `markPipelineReaped` + `markStageAtomReaped` (idempotent, audit log shape, TOCTOU safety).
- [ ] **Step 5:** Implement transition primitives. Both `markPipelineReaped` and `markStageAtomReaped` MUST set `confidence: 0.01` in the `host.atoms.update` call alongside `metadata.reaped_at` / `metadata.reaped_reason`, so arbitration deprioritizes reaped atoms (per Section 1.3 doctrine).
- [ ] **Step 6:** Write failing tests for end-to-end `runPipelineReaperSweep` (seed full subgraph on MemoryHost, pin clock, assert all children + parent reaped in correct order).
- [ ] **Step 7:** Implement `runPipelineReaperSweep` with `derived_from` walk, per-atom best-effort apply, kill-switch gate.
- [ ] **Step 8:** Add re-exports to `index.ts`.
- [ ] **Step 9:** Run all reaper-adjacent tests.
- [ ] **Step 10:** Commit + push.

**Security + correctness considerations:**
- Provenance chains MUST stay intact (no clearing `derived_from` arrays).
- Kill switch first: `host.scheduler.killswitchCheck()` BEFORE any write.
- Per-atom audit (volume cost ~25 rows per pipeline reap is acceptable; collapsing loses per-atom-id refs).
- Principal id is required (no fallback to a hardcoded id).
- Best-effort per child: per-atom failures logged + skipped, never thrown.
- Reaped marker is a leaf write (no delete, no supersede, no taint).

**Dependencies:** Task 1.

---

### Task 3 - Canon-policy reader for pipeline-reaper TTLs

**Files (new):**
- Create: `src/runtime/loop/pipeline-reaper-ttls.ts` - `readPipelineReaperTtlsFromCanon(host)`. Mirrors `reaper-ttls.ts`.
- Create: `scripts/lib/pipeline-reaper-canon-policies.mjs` - pure POLICIES factory.
- Create: `scripts/bootstrap-pipeline-reaper-canon.mjs` - idempotent installer.
- Test: `test/loop/pipeline-reaper-ttls.test.ts` (mirrors `reaper-ttls.test.ts`).
- Test: `test/scripts/bootstrap-pipeline-reaper-canon.test.ts` - drift-pin between POLICIES factory and `DEFAULT_PIPELINE_REAPER_TTLS`.

**Policy atom shape:**
```js
metadata.policy = {
  subject: 'pipeline-reaper-ttls',
  reason: '<rationale>',
  terminal_pipeline_ms: 2_592_000_000,    // 30d
  hil_paused_pipeline_ms: 1_209_600_000,  // 14d
  agent_session_ms: 2_592_000_000,        // 30d
  // ... per PipelineReaperTtls field
}
```

**Steps:** TDD-shaped: tests first, then reader, then bootstrap script.

**Security + correctness considerations:**
- Reader NEVER throws on malformed canon (operator-data error vs. framework-state error distinction).
- Bootstrap atom carries `provenance.kind: 'operator-seeded'` and `principal_id` from `LAG_OPERATOR_ID` (fail-loud on missing env, exit 2).

**Dependencies:** Task 2.

---

### Task 4 - Driver script `scripts/reap-stale-pipelines.mjs`

**Files (new):**
- Create: `scripts/reap-stale-pipelines.mjs` - sibling to `reap-stale-plans.mjs`. Same exit-code convention (0/1/2/3), same `--dry-run`, `--principal` flags.
- Test: `test/scripts/reap-stale-pipelines.test.ts` - parse-args, dry-run output shape, missing-principal exit, STOP-sentinel exit.

**Steps:**
- [ ] Mirror `reap-stale-plans.mjs` argument parsing + STOP/principal resolution.
- [ ] Wire to `runPipelineReaperSweep` from Task 2.
- [ ] Print per-pipeline reap summary to stdout.
- [ ] Add tests + commit.

**Security + correctness considerations:**
- STOP-sentinel check BEFORE host construction.
- Principal resolution chain: `--principal` > `LAG_REAPER_PRINCIPAL` > `LAG_OPERATOR_ID` > exit 3.
- Mid-sweep STOP halt is OK (per-atom reaps are idempotent on next run).

**Dependencies:** Task 2 + Task 3.

---

### Task 5 - LoopRunner pass: extend `runReaperPass` to call both reapers

**Files (modify):**
- Modify: `src/runtime/loop/runner.ts` - extend `reaperPass` private method (lines 907-967) to call `runPipelineReaperSweep` after the plan-reaper sweep.
- Modify: `src/runtime/loop/types.ts` - add `pipelineReaperReport` field to `LoopTickReport`.
- Test: `test/loop/runner.test.ts` - add cases for both-reapers-run, false-flag-disables-both, decoupled-failure (one fails, other still runs), TTL chain.

**Steps:**
- [ ] **Step 1:** Read `runner.ts:907-967` (existing reaperPass) + `types.ts` (existing LoopTickReport).
- [ ] **Step 2:** Write failing test: `runReaperPass: true` with stale terminal pipeline → both reports populated.
- [ ] **Step 3:** Extend `reaperPass` to invoke pipeline reaper after plan reaper.
- [ ] **Step 4:** Add `pipelineReaperReport` to LoopTickReport types.
- [ ] **Step 5:** Confirm decoupled-failure semantics + add test.
- [ ] **Step 6:** Run all loop tests.
- [ ] **Step 7:** Commit + push.

**Security + correctness considerations:**
- Plan reaper FIRST, pipeline reaper SECOND, in a single tick.
- Independent failures must not cascade (mirrors decayPass / l2Engine.runPass decoupling pattern).
- Same kill-switch + reaper-principal cache gates BOTH reapers.

**Dependencies:** Task 2 + Task 3.

---

### Task 6 - Console projection: hide reaped atoms by default

**Files (modify):**
- Investigate: `apps/console/server/...` (existing query/projection layer).
- Investigate: `apps/console/src/...` (React surface for the toggle UI).
- Modify: extend filter shape to skip atoms with `metadata.reaped_at` set.
- Add: "Show reaped (N)" toggle in the atom-list view.
- Test: Console integration test - seed a reaped pipeline, default view hides; toggle shows.

**Steps:**
- [ ] **Step 1:** Read the Console server query layer to confirm existing filter shape (likely already supports `superseded_by` skip).
- [ ] **Step 2:** Add reaped-at filter to the default query (mirrors existing patterns).
- [ ] **Step 3:** Add toggle UI to atom-list view.
- [ ] **Step 4:** Confirm `derived_from` chain navigation still resolves to reaped atoms (filter is "default hide", not hard fence).
- [ ] **Step 5:** Add integration test.
- [ ] **Step 6:** Run mobile + desktop Playwright (per `dev-mobile-first-floor`).
- [ ] **Step 7:** Commit + push.

**Security + correctness considerations:**
- Provenance navigation MUST work for reaped atoms (filter is projection-layer, not substrate-layer).
- Confidence-floored atoms (0.01) already deprioritize in arbitration; the projection filter is the user-facing complement.

**Dependencies:** Task 2.

---

### Task 7 - Documentation + dogfood the GC

**Files (new/modify):**
- Modify: `docs/framework.md` - append "Reaper" section describing both passes.
- Modify: `docs/observability.md` - describe new audit kinds (`pipeline.reaped`, `pipeline.stage_atom_reaped`).
- Dogfood: run `node scripts/reap-stale-pipelines.mjs --dry-run` against real `.lag/atoms/`. Confirm counts.
- Then run live (after operator approval).

**Steps:**
- [ ] Write framework + observability doc updates.
- [ ] Operator runs --dry-run, reads would-reap list.
- [ ] Operator approves + runs live.
- [ ] Self-audit follow-up scheduled +7 days post-merge.

**Security + correctness considerations:**
- Dogfood is the only path to ship V0 with confidence (catches integration bugs unit tests miss).
- `--dry-run` first; operator reads before flipping live.

**Dependencies:** Tasks 2-6.

---

## Section 4 - Pre-push checklist + canon-audit + cr-precheck gate

### 4.1 Pre-push gates (mechanical)

- [ ] `npm run typecheck` clean
- [ ] `npm run build` clean
- [ ] `npx vitest run test/runtime/plans/pipeline-reaper.test.ts test/runtime/plans/reaper.test.ts test/loop/runner.test.ts test/loop/pipeline-reaper-ttls.test.ts test/loop/reaper-ttls.test.ts`
- [ ] `node scripts/pre-push-lint.mjs` (emdash, private-terms, dogfood-date, z-utc-redundant)
- [ ] `node scripts/cr-precheck.mjs --strict` (CR CLI on local diff; blocks on critical/major + minor)

### 4.2 Canon-audit step (per `dev-implementation-canon-audit-loop`)

For EACH task that modifies `src/`, dispatch a canon-compliance auditor sub-agent. Auditor verifies (citing each):
- `inv-provenance-every-write` - new audit kinds carry `refs.atom_ids`
- `inv-kill-switch-first` - sweep calls `host.scheduler.killswitchCheck()` before mutation
- `inv-l3-requires-human` - no L3 atom is reaped (filter excludes directives)
- `arch-atomstore-source-of-truth` - no deletion verbs added to AtomStore
- `arch-atom-index-is-projection` - Console filter is projection-layer
- `dev-substrate-not-prescription` - TTL knobs land in canon, not framework constants
- `dev-canon-is-strategic-not-tactical` - TTL list enumerated explicitly, not generic
- `dev-dry-extract-at-second-duplication` - shared helpers extracted at second use site
- `dev-extreme-rigor-and-research` - audit findings ride directly into implementer revisions before commit

### 4.3 CR-precheck gate (per `dev-coderabbit-cli-pre-push`)

Run `scripts/cr-precheck.mjs --base origin/main` after every commit before push. Critical/major findings block; address + re-stage + re-run.

### 4.4 Post-merge

- LoopRunner pulls new pipeline reaper into next tick (canon re-read every tick).
- Operator runs `--dry-run` once, sanity-checks would-reap list, enables cron.
- Self-audit follow-up scheduled 7 days post-merge.

---

## Critical Files for Implementation

- `src/runtime/plans/reaper.ts` (existing reaper; reference shape for new module)
- `src/runtime/loop/reaper-ttls.ts` (existing canon-reader; mirror for pipeline reader)
- `src/runtime/loop/runner.ts:907-967` (existing reaperPass to extend)
- `src/runtime/planning-pipeline/atom-shapes.ts` (pipeline atom builders + state values)
- `src/substrate/types.ts` (AtomType union, AtomPatch, Atom shape)
- `scripts/reap-stale-plans.mjs` (existing driver; reference shape)
- `scripts/lib/reaper-canon-policies.mjs` (existing POLICIES factory; reference shape)
