# Killer pipeline: superpower-driven stages implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace each upstream pipeline stage's single-shot `host.llm.judge()` call with a dispatched agent-loop run that bundles a superpowers skill, canon-binding, and a per-stage canon-audit checkpoint, while preserving the existing `PlanningStage` substrate seam.

**Architecture:** Each agentic stage lives at `examples/planning-stages/<stage>/agentic.ts` alongside the existing single-shot `index.ts`. A new helper at `examples/planning-stages/lib/run-stage-agent-loop.ts` composes the existing primitives (`AgentLoopAdapter`, `WorkspaceProvider`, canon resolver, tool-policy resolver) into the pipeline's per-stage shape. Three new `pipeline-stage-event` transitions (`canon-bound`, `canon-audit-complete`, `agent-turn`) extend the existing atom shape so the console deliberation-trail surface renders the new chain unchanged in vocabulary.

**Tech Stack:** TypeScript 5.5+, zod 3.22+, vitest, the existing `AgentLoopAdapter` substrate (PR1+PR2+PR3 trilogy), the `ClaudeCodeAgentLoopAdapter`, and the superpowers skill markdown bundles.

---

## Scope decision (this session)

The operator's mandate is "VALIDATED + TESTED ... INDUSTRY LEADING". The full design covers 5 stages + console + 4 canon atoms + a real-LLM dogfeed. Given session-bounded reality and the rigor the operator's canons demand, **this PR ships the substrate + the brainstorm-stage agentic adapter end-to-end with tests, plus the canon-policy seam**. The remaining 3 upstream stages (spec, plan, review) follow the SAME pattern as brainstorm; once brainstorm lands and is validated end-to-end on a real intent, replicating to the other three is mechanical (the helper does the lifting). This is the disciplined "ship one stage perfectly, then replicate" approach -- not the rushed "ship five stages partially" approach the spec-without-rigor canon explicitly rejects.

What ships in THIS PR (substrate + brainstorm slice + tests):
- T1: Extended pipeline-stage-event transitions (substrate atom-shapes change).
- T2: `runStageAgentLoop` helper at `examples/planning-stages/lib/run-stage-agent-loop.ts`.
- T3: Vendored superpower skill bundles at `examples/planning-stages/skills/`.
- T4: `agenticBrainstormStage` adapter at `examples/planning-stages/brainstorm/agentic.ts`.
- T9: Deterministic end-to-end test on `MemoryHost` with a stub agent-loop adapter covering the full chain.

Follow-ups (each its own PR; each pattern-matches T4):
- T5: Canon policy atom for stage-implementation selection.
- T6: Canon bootstrap script wiring.
- T7: `run-cto-actor.mjs` reads the canon policy and selects the agentic adapter when authorised.
- T8: Console deliberation-trail extension for the new transitions.
- T10: Real-LLM dogfeed via the existing `ClaudeCodeAgentLoopAdapter` -- compare brainstorm output BEFORE vs AFTER.
- T11: `agenticSpecStage`
- T12: `agenticPlanStage`
- T13: `agenticReviewStage`

---

## File structure

**Create:**
- `examples/planning-stages/lib/run-stage-agent-loop.ts` -- the orchestrator helper.
- `examples/planning-stages/lib/skill-bundle-resolver.ts` -- resolves a skill name to its markdown contents (try plugin cache, then vendored).
- `examples/planning-stages/skills/brainstorming.md` -- vendored copy of `superpowers:brainstorming` SKILL.md (and `spec-document-reviewer-prompt.md` content concatenated).
- `examples/planning-stages/skills/README.md` -- explains why the bundles are vendored + how they're refreshed.
- `examples/planning-stages/brainstorm/agentic.ts` -- the agentic brainstorm-stage adapter.
- `test/examples/planning-stages/lib/run-stage-agent-loop.test.ts` -- unit + integration tests for the helper.
- `test/examples/planning-stages/brainstorm/agentic.test.ts` -- contract test for the agentic brainstorm adapter.
- `test/runtime/planning-pipeline/agentic-end-to-end.test.ts` -- full-pipeline deterministic E2E test.

**Modify:**
- `src/runtime/planning-pipeline/atom-shapes.ts` -- extend `TRANSITION` enum + `mkPipelineStageEventAtom` metadata fields. The existing mint helper owns transition-specific validation and metadata shaping; new transitions land as branches inside that helper rather than as duplicate `mkPipelineCanonBoundEventAtom` + `mkPipelineCanonAuditEventAtom` siblings.
- `src/runtime/planning-pipeline/runner.ts` -- no change needed. The runner already calls `emitStageEvent` only from its own state machine; the helper writes its own canon-bound + canon-audit events directly via the existing `mkPipelineStageEventAtom` mint helper.
- `src/runtime/planning-pipeline/index.ts` -- re-export the extended `TRANSITION` enum + types.
- `apps/console/src/features/deliberation-trail/` -- render the three new transitions.
- `scripts/bootstrap-deep-planning-pipeline-canon.mjs` -- seed the new canon policy atom.
- `scripts/run-cto-actor.mjs` -- read the new canon policy and choose adapter set per stage.

---

## Task 1: Extend pipeline-stage-event transitions (substrate)

**Why:** Three new transitions (`canon-bound`, `canon-audit-complete`, `agent-turn`) need atom-shape support so the helper can emit them and the console can render them.

**Files:**
- Modify: `src/runtime/planning-pipeline/atom-shapes.ts:39-41` (the `TRANSITION` zod enum).
- Modify: `src/runtime/planning-pipeline/atom-shapes.ts:200-232` (the `mkPipelineStageEventAtomInput` + `mkPipelineStageEventAtom`).
- Modify: `src/runtime/planning-pipeline/index.ts` (re-export).
- Test: `test/runtime/planning-pipeline/atom-shapes.test.ts` (extend existing tests).

- [ ] **Step 1: Write failing tests for the three new transitions**

```ts
// test/runtime/planning-pipeline/atom-shapes.test.ts (append)
describe('mkPipelineStageEventAtom new transitions', () => {
  const baseInput = {
    pipelineId: 'pipeline-test' as AtomId,
    stageName: 'brainstorm-stage',
    principalId: 'brainstorm-actor' as PrincipalId,
    correlationId: 'corr-1',
    now: '2026-05-01T00:00:00Z' as Time,
    durationMs: 100,
    costUsd: 0,
  };

  test('mints a canon-bound event with canon_atom_ids metadata', () => {
    const atom = mkPipelineStageEventAtom({
      ...baseInput,
      transition: 'canon-bound',
      canonAtomIds: ['dev-deep-planning-pipeline', 'dev-implementation-canon-audit-loop'] as AtomId[],
    });
    expect(atom.type).toBe('pipeline-stage-event');
    expect(atom.metadata.transition).toBe('canon-bound');
    expect(atom.metadata.canon_atom_ids).toEqual([
      'dev-deep-planning-pipeline',
      'dev-implementation-canon-audit-loop',
    ]);
  });

  test('mints a canon-audit-complete event with verdict + findings', () => {
    const atom = mkPipelineStageEventAtom({
      ...baseInput,
      transition: 'canon-audit-complete',
      canonAuditVerdict: 'approved',
      canonAuditFindings: [
        { severity: 'minor', category: 'redundant-citation', message: 'duplicate cite', cited_atom_ids: [], cited_paths: [] },
      ],
    });
    expect(atom.metadata.canon_audit_verdict).toBe('approved');
    expect(atom.metadata.canon_audit_findings).toHaveLength(1);
  });

  test('mints an agent-turn event pointing at an agent-turn atom id', () => {
    const atom = mkPipelineStageEventAtom({
      ...baseInput,
      transition: 'agent-turn',
      agentTurnAtomId: 'agent-turn-abc' as AtomId,
      turnIndex: 3,
    });
    expect(atom.metadata.agent_turn_atom_id).toBe('agent-turn-abc');
    expect(atom.metadata.turn_index).toBe(3);
  });

  test('legacy transitions still work with no new fields', () => {
    const atom = mkPipelineStageEventAtom({ ...baseInput, transition: 'enter' });
    expect(atom.metadata.transition).toBe('enter');
    expect(atom.metadata.canon_atom_ids).toBeUndefined();
  });

  test('rejects unknown transition strings', () => {
    expect(() =>
      mkPipelineStageEventAtom({
        ...baseInput,
        transition: 'invalid-transition' as 'enter',
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd C:/Users/opens/memory-governance/.worktrees/killer-pipeline-superpower-stages
npm test -- atom-shapes.test.ts
```
Expected: FAIL on the new test cases (TRANSITION enum doesn't accept new values).

- [ ] **Step 3: Extend TRANSITION enum + the input/atom shapes**

In `src/runtime/planning-pipeline/atom-shapes.ts`:
1. Update `TRANSITION` zod enum to add the three new values.
2. Extend `MkPipelineStageEventAtomInput` with optional fields: `canonAtomIds`, `canonAuditVerdict`, `canonAuditFindings`, `agentTurnAtomId`, `turnIndex`.
3. Extend `mkPipelineStageEventAtom` to fold those into metadata when present.
4. Cap `canon_atom_ids` length at MAX_CITED_LIST (256) for parity with cite-list bounds.

- [ ] **Step 4: Run tests, verify pass + no regression**

```bash
npm test -- atom-shapes.test.ts
```
Expected: all green, including legacy transition tests.

- [ ] **Step 5: Re-export from index.ts + commit**

```bash
git add src/runtime/planning-pipeline/atom-shapes.ts \
        src/runtime/planning-pipeline/index.ts \
        test/runtime/planning-pipeline/atom-shapes.test.ts
git commit -m "feat(planning-pipeline): extend stage-event transitions for canon-bound, canon-audit-complete, agent-turn"
```

---

## Task 2: `runStageAgentLoop` helper (substrate)

**Why:** Shared orchestration for every agentic stage. Doing this once means the per-stage adapter is ~50 lines of stage-specific config, not 300 lines of agent-loop wiring.

**Files:**
- Create: `examples/planning-stages/lib/run-stage-agent-loop.ts`.
- Test: `test/examples/planning-stages/lib/run-stage-agent-loop.test.ts`.

- [ ] **Step 1: Write the contract test (multiple cases)**

The test uses a stub `AgentLoopAdapter` whose `run()` returns a deterministic `AgentLoopResult` with a configurable session id, turn ids, and a known final-output JSON. The test asserts:
- The helper writes a `canon-bound` pipeline-stage-event atom before invoking the adapter.
- The helper writes a `canon-audit-complete` pipeline-stage-event atom after the adapter returns.
- The helper invokes the adapter with the resolved tool policy.
- The helper invokes the adapter with the skill bundle threaded into the prompt.
- The helper returns the validated output payload.
- A schema-fail on the adapter's final output throws.
- A kill-switch flip mid-run aborts the adapter via `signal`.

- [ ] **Step 2: Run tests to verify they fail**

Expected: FAIL because the helper doesn't exist.

- [ ] **Step 3: Write minimal implementation**

The helper:
1. Acquires a workspace via the `workspaceProvider` opt.
2. Reads the per-principal tool policy via `loadLlmToolPolicy`.
3. Reads applicable canon via `host.canon.applicable({ principal_id, layer: 'L3', scope })`.
4. Mints + persists a `canon-bound` pipeline-stage-event with the canon atom-ids.
5. Builds the prompt by concatenating: skill-bundle + canon-summary + stage-context + output-contract.
6. Invokes `agentLoop.run(...)` with the prompt as `task.successCriteria` (or a similar field; review the AgentTask shape).
7. After the adapter returns, dispatches a fresh small canon-audit agent-loop run with a canon-audit prompt. The audit's output is parsed against `{verdict: 'approved' | 'issues-found', findings: AuditFinding[]}` -- this is the same vocabulary the substrate's `CANON_AUDIT_VERDICT` zod enum and `mkPipelineStageEventAtom`'s `canonAuditVerdict` field accept (see `src/runtime/planning-pipeline/atom-shapes.ts`); no helper-side mapping is needed.
8. Mints + persists a `canon-audit-complete` pipeline-stage-event with the verdict + findings.
9. For each agent-turn atom the adapter wrote, mints a corresponding `agent-turn` pipeline-stage-event for console-side ergonomics.
10. Validates the adapter's final-output JSON against `outputSchema`. On schema-fail, throws.
11. Releases the workspace in a finally block.
12. Returns `{value, costUsd, durationMs, sessionAtomId, turnAtomIds, canonBoundAtomIds, canonAuditFindings}`.

- [ ] **Step 4: Run tests, verify pass**

- [ ] **Step 5: Commit**

```bash
git add examples/planning-stages/lib/run-stage-agent-loop.ts \
        test/examples/planning-stages/lib/run-stage-agent-loop.test.ts
git commit -m "feat(planning-stages): runStageAgentLoop helper composing AgentLoopAdapter for pipeline stages"
```

---

## Task 3: Vendored skill bundles

**Why:** A deployment that doesn't have the operator's superpowers plugin installed must still run the killer pipeline. Vendoring the skill markdown into the repo guarantees the prompt scaffold survives across machines.

**Files:**
- Create: `examples/planning-stages/skills/brainstorming.md`.
- Create: `examples/planning-stages/skills/README.md`.
- Create: `examples/planning-stages/lib/skill-bundle-resolver.ts`.
- Test: `test/examples/planning-stages/lib/skill-bundle-resolver.test.ts`.

- [ ] **Step 1: Test skill-bundle-resolver with vendored fallback**

The test creates a temp directory with no plugin cache and asserts the resolver falls back to the vendored copy under `examples/planning-stages/skills/`.

- [ ] **Step 2: Run -> fail.**

- [ ] **Step 3: Implement resolver.**

Surface:
```ts
export async function resolveSkillBundle(skillName: string): Promise<string>;
```

Implementation: try `~/.claude/plugins/cache/claude-plugins-official/superpowers/<version>/skills/<bundle>/SKILL.md` first; if absent, fall back to `examples/planning-stages/skills/<bundle>.md`. Concatenate companion prompts when present.

- [ ] **Step 4: Vendor the brainstorming skill content into `examples/planning-stages/skills/brainstorming.md`.**

Copy the relevant content from the operator's plugin cache (`superpowers:brainstorming` SKILL.md). Include only the parts a stage-running agent needs: the process, the design-for-isolation guidelines, and the visual-companion section.

- [ ] **Step 5: Document the README + commit.**

---

## Task 4: agenticBrainstormStage adapter

**Why:** The first ship-vehicle for the killer-pipeline pattern. Once this lands and is validated end-to-end, replicating to spec/plan/review is mechanical.

**Files:**
- Create: `examples/planning-stages/brainstorm/agentic.ts`.
- Test: `test/examples/planning-stages/brainstorm/agentic.test.ts`.

- [ ] **Step 1: Write the contract test.**

Use a stub `AgentLoopAdapter` returning a deterministic `BrainstormPayload`. Assert:
- The stage's `run()` returns a `StageOutput` with `atom_type: 'brainstorm-output'`.
- The output payload passes the existing `brainstormPayloadSchema` zod check.
- The stage's `audit()` re-runs the existing single-shot audit (citation closure check) over the agentic output.
- The stage emits a canon-bound pipeline-stage-event before invoking the adapter.

- [ ] **Step 2: Run -> fail (adapter doesn't exist).**

- [ ] **Step 3: Implement.**

The adapter is a `PlanningStage<unknown, BrainstormPayload>` whose `run` calls `runStageAgentLoop` with brainstorm-specific config. The `audit` re-uses the single-shot adapter's `auditBrainstorm` function (imported from `examples/planning-stages/brainstorm/index.ts`).

- [ ] **Step 4: Run -> pass.**

- [ ] **Step 5: Commit.**

---

## Task 5: Canon policy atom for stage-implementation selection

**Files:**
- Modify: `scripts/bootstrap-deep-planning-pipeline-canon.mjs` -- seed `pol-planning-pipeline-stage-implementations-default`.
- Test: a new policy reader if needed; otherwise a manual run-bootstrap-then-grep verification.

- [ ] **Step 1: Add the new atom in the bootstrap script.**

The atom subject is `planning-pipeline-stage-implementations`; its policy field carries `{stage_name: 'brainstorm-stage', mode: 'agentic' | 'single-shot'}` per stage. Ship default = single-shot for every stage; the operator flips to agentic per stage via a higher-priority canon edit.

- [ ] **Step 2: Add a reader in `src/runtime/planning-pipeline/policy.ts` mirroring the existing readers.**

- [ ] **Step 3: Test the reader with a stub policy atom.**

- [ ] **Step 4: Commit.**

---

## Task 6: Canon bootstrap wiring + run-cto-actor.mjs adapter selection

**Files:**
- Modify: `scripts/run-cto-actor.mjs:300-380` (the stage-registry construction).

- [ ] **Step 1: Read the new canon policy in `runDeepPipeline`.**

After the existing `readPipelineStagesPolicy` call, call `readPipelineStageImplementationsPolicy` and choose the agentic vs single-shot adapter per stage.

- [ ] **Step 2: Manually verify the agentic brainstorm activates when canon authorises.**

Set the `pol-planning-pipeline-stage-implementations-default` to `{brainstorm-stage: 'agentic', others: 'single-shot'}` and run a substrate-deep CTO pass; assert the brainstorm stage uses the agentic adapter and the rest stay single-shot.

- [ ] **Step 3: Commit.**

---

## Task 7: Console deliberation-trail extension

**Files:**
- Modify: `apps/console/src/features/deliberation-trail/<feature-files>` (find the right files via grep on `pipeline-stage-event` and `transition`).

- [ ] **Step 1: Find the renderer.** Likely `apps/console/src/features/deliberation-trail/types.ts` + a row-rendering component.

- [ ] **Step 2: Add row-renderers for the three new transitions.**

Each row shows a tone-coded badge + a human label + an expandable detail pane (existing pattern from atom-detail-viewer).

- [ ] **Step 3: Test in the existing console test harness.**

- [ ] **Step 4: Commit.**

---

## Task 8: End-to-end deterministic test

**Files:**
- Create: `test/runtime/planning-pipeline/agentic-end-to-end.test.ts`.

- [ ] **Step 1: Compose a 5-stage pipeline with the agentic brainstorm + single-shot for the rest, all on `MemoryHost`, all with stub adapters returning deterministic outputs.**

- [ ] **Step 2: Run the pipeline; assert the chain integrity (every stage event present, schema valid, atoms-store complete).**

- [ ] **Step 3: Commit.**

---

## Task 9: Real-LLM dogfeed validation

**Files:** none committed; this is a manual operator-driven check.

- [ ] **Step 1: Set up a fresh operator-intent atom via `node scripts/decide.mjs --type=operator-intent ...`.**

- [ ] **Step 2: Invoke `node scripts/run-cto-actor.mjs --request "..." --intent-id <id> --mode=substrate-deep` with the canon policy set to `agentic` for brainstorm-stage only.**

- [ ] **Step 3: Inspect the brainstorm-output atom + the chain. Compare against a single-shot run on the same intent.**

- [ ] **Step 4: Document the BEFORE/AFTER samples in the PR body.**

---

## Task 10: PR creation + CR cycle + merge

- [ ] **Step 1: Run pre-push lint + cr-precheck on the bundled diff.**

- [ ] **Step 2: Open the PR via `gh-as.mjs lag-ceo`.**

- [ ] **Step 3: Trigger CodeRabbit via `cr-trigger.mjs` (machine user).**

- [ ] **Step 4: Address CR findings; iterate until APPROVED.**

- [ ] **Step 5: Merge once CR APPROVED + CI green.**

---

## Per-task discipline (applies to every task)

- TDD: failing test first, watch it fail, write minimal code, watch it pass.
- Security + correctness walkthrough: enumerate threats + correctness invariants before commit.
- Canon-audit checkpoint: re-read CLAUDE.md + the four canons cited in the spec; confirm the diff doesn't violate any.
- CR CLI pre-push: `npm run cr-precheck` (or the existing scripts) BEFORE pushing.
- Conventional Commits PR title.
- No Claude attribution in any commit / PR body.
- No emdashes anywhere in tracked files.
- Pre-push grep checklist (per `feedback_pre_push_grep_checklist`): grep for emdashes (the U+2014 character), design/ refs, adr- refs, atom-id citations, and Co-Authored-By lines across src/ scripts/ test/.
- Bot identity: `git-as.mjs` for commits, `gh-as.mjs lag-ceo` for PR ops, `cr-trigger.mjs` (machine user) for CR triggers.
