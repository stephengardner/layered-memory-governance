# Deep Planning Pipeline Substrate Design

**Date:** 2026-04-28
**Status:** Brainstormed via `superpowers:brainstorming`. Pending implementation plan via `superpowers:writing-plans`.
**Tracks:** `operator-intent-deep-planning-pipeline-1777408799112` (operator quote: "the pipeline on execution is basically the bread and butter on engineering deliverables. It will probably even grow beyond this. It needs to be extremely flexible because the engineering decisions are the most critical decisions in the org.")
**Builds on:** PlanningActor (`src/runtime/actors/planning/`), autonomous-intent substrate (`src/runtime/actor-message/intent-approve.ts`), plan-dispatch loop (`src/runtime/actor-message/plan-dispatch.ts`), SubActorRegistry (`src/runtime/actor-message/sub-actor-registry.ts`), agentic actor-loop trilogy (`docs/superpowers/specs/2026-04-25-agentic-actor-loop-design.md`).

---

## 1. Goal

Replace the single-pass `HostLlmPlanningJudgment` (classify + draft via PLAN_DRAFT zod schema) with a pluggable, atom-projected, per-stage-audited planning pipeline so substantive engineering deliverables route through brainstorm, spec, plan, review, and dispatch stages with verification gates between each, while tactical fixes keep the existing single-pass path for cost amortization.

---

## 2. Architecture

The pipeline is a state-machine of `PlanningStage` objects composed in `src/runtime/planning-pipeline/`. Each stage is a pluggable adapter (interface in `src/runtime/planning-pipeline/stage.ts`, reference adapters live in `examples/planning-stages/`). Pipeline state is fully atom-projected: every stage transition is a `pipeline-stage-event` atom, every stage output is a stage-typed atom (spec, plan, review-report, dispatch-record), every audit finding is a `pipeline-audit-finding` atom, and a partial run resumes by re-reading the last completed stage. Mode-gated activation (`--mode=substrate-deep`) means tactical fixes still go through the existing single-pass `PlanningActor`; only deliverables larger than a typo-fix pay the multi-stage cost. The seam reuses `SubActorRegistry` for stage-actor invocation so we do NOT introduce a new Host sub-interface yet (single-consumer rule per `arch-host-interface-boundary`).

The pipeline is the load-bearing path for engineering deliverables; the operator-intent calls this "bread-and-butter posture." Per `dev-substrate-not-prescription`, framework code in `src/` carries the mechanism only; concrete stage prompts, schemas, and ordering live in canon policy atoms and `examples/`.

---

## 3. Tech Stack

- TypeScript (strict, ES modules, NodeNext resolution) consistent with the rest of `src/`.
- `zod` for stage output schemas (existing dep, used by `PLAN_CLASSIFY` / `PLAN_DRAFT`).
- Existing Host substrate (AtomStore, Auditor, Notifier, Scheduler, Clock, LLM).
- Existing SubActorRegistry seam at `src/runtime/actor-message/sub-actor-registry.ts` for stage-actor dispatch.
- No new runtime dependencies. No new Host sub-interface. No coupling to Claude Code plugin or any specific LLM vendor.

---

## 4. Architectural Seams

The pipeline plugs into existing substrate at four anchor points and adds one new directory:

- **New: `src/runtime/planning-pipeline/`.** Contains the `PlanningStage` interface, `PlanningPipeline` orchestrator, atom-shape definitions for `pipeline-stage-event`, `pipeline-audit-finding`, `pipeline-failed`, the `spec` atom shape, and the canon policy parsers for `pol-planning-pipeline-stages-<scope>` and `pol-pipeline-stage-hil-<stage>`. Mechanism only per `dev-substrate-not-prescription`.
- **Reused: `SubActorRegistry`.** Stage-actors (e.g. `brainstorm-actor`, `spec-author`, `plan-author`, `pipeline-auditor`) register as sub-actor principals at bootstrap and are invoked by the pipeline orchestrator the same way `runDispatchTick` (`src/runtime/actor-message/plan-dispatch.ts:58`) invokes a sub-actor for an approved plan. The registry seam is sufficient; we do not introduce a new `StageRegistry` substrate primitive when the existing one fits.
- **Reused: AtomStore as state machine.** Pipeline state IS the atom set, mirroring the autonomous-intent pattern (`src/runtime/actor-message/intent-approve.ts`) where the proposed/approved/executing/succeeded transitions are atom-field updates, not in-memory state. This honors `arch-atomstore-source-of-truth` and gives free resumability per the resume-default operator-intent (`operator-intent-resume-default-non-pr-fix-actors-1777391142435`).
- **Reused: Auditor.** Per-stage audit findings emit `pipeline.stage-audit-finding` audit-log events identical in shape to the `plan.skipped-by-intent` events the intent-approve tick already emits. Console live-ops surfaces consume the same audit channel.
- **Reused: Kill-switch.** The orchestrator checks `host.scheduler.killswitchCheck()` before each stage transition (mirroring `runIntentAutoApprovePass`) so `.lag/STOP` halts the pipeline mid-run cleanly per `inv-kill-switch-first`.

The Host interface gains zero new sub-interfaces. If a future second consumer (e.g. an off-tree CD pipeline) wants the same shape, that is when we extract a `PipelineRuntime` Host sub-interface and not before per `arch-host-interface-boundary`.

---

## 5. Stage Interface

```ts
// src/runtime/planning-pipeline/stage.ts

export interface PlanningStage<TInput = unknown, TOutput = unknown> {
  /** Stable identifier; appears in atom ids and audit events. */
  readonly name: string;

  /** Optional zod schema validating TOutput shape before the orchestrator atom-writes. */
  readonly outputSchema?: ZodSchema<TOutput>;

  /**
   * Run the stage. Receives the prior stage's typed output (or the
   * pipeline-seed input on stage 0). Returns the stage output that
   * the orchestrator persists as a stage-typed atom and threads
   * forward to the next stage.
   */
  run(input: StageInput<TInput>): Promise<StageOutput<TOutput>>;

  /**
   * Optional auditor. Receives the stage's own output and emits zero
   * or more findings. Critical findings halt advancement; major and
   * minor findings record but allow advance per the pol-pipeline-stage-hil
   * configuration. Default-deny when omitted: a stage with no auditor
   * cannot auto-advance past an HIL gate (force a manual operator pass).
   */
  audit?(output: TOutput, ctx: StageContext): Promise<ReadonlyArray<AuditFinding>>;

  /**
   * Per-stage retry strategy. Defaults to the pol-judgment-fallback-ladder
   * shape: retry-with-jitter -> single re-draft against cheaper_model ->
   * escalation. A stage that wants to opt out of retries (e.g. an HIL
   * stage where the operator IS the retry strategy) returns 'no-retry'.
   */
  readonly retry?: RetryStrategy;
}

export interface StageInput<T> {
  readonly host: Host;
  readonly principal: PrincipalId;
  readonly correlationId: string;
  readonly priorOutput: T;          // typed by the prior stage
  readonly pipelineId: AtomId;      // root atom id for the pipeline run
  readonly seedAtomIds: ReadonlyArray<AtomId>; // operator-intent + seed context
}

export interface StageOutput<T> {
  readonly value: T;                // schema-validated payload
  readonly cost_usd: number;        // declared by the stage; orchestrator records
  readonly duration_ms: number;
  readonly atom_type: string;       // 'spec' | 'plan' | 'review-report' | etc.
  readonly atom_id?: AtomId;        // if the stage already wrote its own atom
}

export interface AuditFinding {
  readonly severity: 'critical' | 'major' | 'minor';
  readonly category: string;        // 'citation-unverified' | 'schema-drift' | 'budget-overflow' | ...
  readonly message: string;
  readonly cited_atom_ids: ReadonlyArray<AtomId>;
  readonly cited_paths: ReadonlyArray<string>;
}
```

**Composition.** A `PlanningPipeline` is `ReadonlyArray<PlanningStage>` plus a stage-ordering policy. The orchestrator walks the array sequentially; the output of stage N is the input to stage N+1. Each stage runs in a fresh sub-actor invocation through `SubActorRegistry.invoke`, so a stage-actor's compromise does not contaminate the orchestrator. State transitions are atom writes: when stage N completes, the pipeline atom's `pipeline_state` field flips from `running:N` to `running:N+1` and a `pipeline-stage-event` atom records the transition. A failed stage transitions the pipeline to `failed:N` and emits a `pipeline-failed` atom carrying the full chain.

**State machine.** `pipeline_state ∈ {pending, running:<n>, hil-paused:<n>, failed:<n>, completed}`. Transitions are claim-before-mutate (re-read pipeline atom, check current state, atom-store update) following the pattern in `runIntentAutoApprovePass` and `runDispatchTick`.

---

## 6. Default Stage Set (Indie Floor)

Five reference stages ship in `examples/planning-stages/`. A solo developer running LAG with the bootstrap canon gets this set automatically; no canon edits required.

1. **`brainstorm-stage`.** Seed: the operator-intent atom. Output: a `brainstorm-notes` atom holding open questions, alternatives surveyed, decision points. Uses `host.llm.judge` with a brainstorm prompt; equivalent to the HIL phase of `superpowers:brainstorming` but autonomous when the operator-intent envelope authorizes. The auditor checks that every alternative carries a rejection reason and every cited atom resolves (`dev-drafter-citation-verification-required`).
2. **`spec-stage`.** Input: brainstorm-notes. Output: a `spec` atom (looser zod schema than `PLAN_DRAFT`; prose-shaped per the superpowers spec convention; required sections: goal, architecture, components, data flow, alternatives, tradeoffs, threat model, test plan). Stage-actor has read-only Read+Grep+Glob tools so the spec grounds in actual file state. The auditor verifies every cited path is readable, every cited atom id resolves, and no path is fabricated.
3. **`plan-stage`.** Input: spec atom. Output: a `plan` atom matching the existing `PLAN_DRAFT` schema, gated on `spec.audit_status == clean`. The plan cites the spec atom in `derived_from` and inherits the trust envelope from the upstream operator-intent. Stage-actor is the existing CTO-class planner.
4. **`review-stage`.** Input: plan atom. Output: a `review-report` atom (severity-tagged finding list). Calls a registered `pipeline-auditor` sub-actor (read-only) that re-walks every cited path and atom from the plan body and verifies each. This stage is the substrate-level fix for `dev-drafter-citation-verification-required`: tonight's `runApprovedPlanDispatchPass` confabulation would have been caught here, before any dispatch.
5. **`dispatch-stage`.** Input: plan atom + review-report (must be all-clean or operator-acked). Output: a `dispatch-record` atom. Hands off to the existing `runDispatchTick` (`src/runtime/actor-message/plan-dispatch.ts:58`) so all the existing claim-before-mutate, escalation, and `pol-plan-auto-approve-low-stakes` machinery applies unchanged. The pipeline does NOT reimplement dispatch; it composes with what is already shipped.

The default ordering atom is `pol-planning-pipeline-stages-default` shipped in bootstrap canon. The whole pipeline is mode-gated (Section 10) so single-pass plans are unaffected.

---

## 7. BYO Stages (Org Ceiling)

An org-ceiling consumer registers custom stages by writing a canon policy atom of shape:

```jsonc
{
  "id": "pol-planning-pipeline-stages-acme-org",
  "type": "directive",
  "layer": "L3",
  "metadata": {
    "policy": {
      "subject": "planning-pipeline-stages",
      "scope": "project",                     // or 'principal:<id>' or 'feature:<name>'
      "stages": [
        { "name": "brainstorm-stage", "principal_id": "brainstorm-actor" },
        { "name": "spec-stage",       "principal_id": "spec-author" },
        { "name": "legal-review",     "principal_id": "legal-review-actor" },
        { "name": "security-threat-model", "principal_id": "secops-actor" },
        { "name": "plan-stage",       "principal_id": "cto-actor" },
        { "name": "review-stage",     "principal_id": "pipeline-auditor" },
        { "name": "perf-benchmark",   "principal_id": "perf-actor" },
        { "name": "dispatch-stage",   "principal_id": "plan-dispatcher" }
      ]
    }
  }
}
```

The orchestrator resolves the active pipeline by walking canon for `subject == planning-pipeline-stages` atoms and selecting the highest-priority match for the current scope, mirroring how `readIntentApprovePolicy` picks the active intent-approve allowlist (`src/runtime/actor-message/intent-approve.ts`).

**Stage-ordering rules.** The orchestrator enforces only two structural invariants: (a) `dispatch-stage` is terminal (must be last); (b) `review-stage` must follow `plan-stage` if both are present (a plan cannot dispatch without a review). All other ordering is policy-defined. Fail-closed: a malformed stages array or unknown stage principal halts the pipeline at pre-flight with a `pipeline-failed` atom citing the malformation.

**Conflict resolution.** Two scope-matching policy atoms get arbitrated via the existing source-rank formula (`conv-source-rank-formula`). A `principal:<id>` scope beats `project` scope on principal-depth; `feature:<name>` scope beats `project` for the matching feature flag; the layer/provenance/depth/confidence ladder breaks remaining ties.

**Stage-actor compromise.** A compromised stage-actor cannot widen scope: every stage-actor runs through `SubActorRegistry.invoke` which already enforces the `pol-llm-tool-policy-<principal-id>` deny-list per principal (`src/llm-tool-policy.ts`). A stage-actor's writes are bounded to its declared output atom type; the orchestrator validates `output.atom_type` against the stage's registered output schema before persisting.

---

## 8. HIL Gates

Per-stage operator-pause is configured via a per-stage policy atom:

```jsonc
{
  "id": "pol-pipeline-stage-hil-spec",
  "type": "directive",
  "layer": "L3",
  "metadata": {
    "policy": {
      "subject": "pipeline-stage-hil",
      "stage_name": "spec-stage",
      "pause_mode": "always" | "on-critical-finding" | "never",
      "auto_resume_after_ms": null,
      "allowed_resumers": ["operator-principal"]
    }
  }
}
```

Default bootstrap canon: `spec-stage`, `plan-stage`, and `dispatch-stage` ship with `pause_mode: 'on-critical-finding'`; `brainstorm-stage` and `review-stage` ship with `pause_mode: 'never'`. An operator-intent with a fresh trust envelope can downgrade `on-critical-finding` to `never` for a single pipeline run by including `allow_pause_skip: true` in the envelope, but the per-deployment canon default cannot be skipped without an explicit envelope overlay (this is the "default-deny escape hatch" per `inv-governance-before-autonomy`).

A pipeline that hits an HIL pause transitions to `hil-paused:<stage_index>`, writes a notifier message to the resumer principal via the existing Notifier seam, and waits. A `pipeline-resume` atom signed by an allowed resumer transitions the pipeline back to `running:<stage_index>` and re-invokes the stage. Resume idempotency: if the stage already wrote its output atom, the orchestrator skips re-invocation and advances.

---

## 9. Atom Shapes

Six new atom types ship with this pipeline. All carry full provenance per `arch-atomstore-source-of-truth` and follow the existing atom schema contract.

- **`pipeline`.** Root atom for a pipeline run. Fields: `pipeline_state` (top-level field, mirroring how `plan_state` was extracted from metadata per the prior decision), `derived_from` chains back to the seed operator-intent. Metadata: `stage_policy_atom_id`, `mode`, `started_at`, `completed_at`, `total_cost_usd`.
- **`spec`.** Looser shape than `PLAN_DRAFT` because specs are prose-shaped. Required metadata fields: `goal`, `cited_paths` (array of verified paths the auditor will re-check), `cited_atom_ids` (array of verified atom ids), `alternatives_rejected` (matching the existing `PLAN_DRAFT` field name for downstream consistency), `audit_status` (`unchecked` | `clean` | `findings`). Body is markdown.
- **`pipeline-stage-event`.** One per state transition. Metadata: `stage_name`, `transition` (`enter` | `exit-success` | `exit-failure` | `hil-pause` | `hil-resume`), `duration_ms`, `cost_usd`, `output_atom_id` (when applicable). Bounded volume: at most O(stage_count) per pipeline run.
- **`pipeline-audit-finding`.** One per finding. Metadata: `pipeline_id`, `stage_name`, `severity`, `category`, `cited_atom_ids`, `cited_paths`, `message`. Distinguished from a generic `audit-finding` so the Console can filter pipeline findings without scanning unrelated audit atoms.
- **`pipeline-failed`.** Terminal atom on rollback. Metadata: `pipeline_id`, `failed_stage_name`, `failed_stage_index`, `cause`, `chain` (full ordered list of stage atom ids produced before failure), `recovery_hint` (e.g. "re-run from `spec-stage` after addressing finding X").
- **`pipeline-resume`.** Operator-signed (or allowed-resumer-signed) atom that lifts an HIL pause. Validated against `pol-pipeline-stage-hil-<stage_name>.allowed_resumers`.

**Provenance chain.** Every stage output atom's `provenance.derived_from` includes (a) the upstream stage's output atom id, (b) the seed operator-intent atom id, and (c) every cited path's underlying file-content-hash blob ref (when blob storage is configured per the agent-loop substrate). This makes taint cascade work transitively: if a cited atom is later marked tainted, every downstream stage atom inherits the taint and the pipeline atom flips to `tainted` so a re-run is forced.

---

## 10. Mode Gating

The pipeline activates only when `--mode=substrate-deep` is passed to `scripts/run-cto-actor.mjs` (or the equivalent flag on a future `scripts/run-pipeline.mjs` driver). Without the flag, planning runs through the existing single-pass `PlanningActor` unchanged. Rationale: cost amortization. A typo-fix should not pay the brainstorm + spec + review tax; an architectural decision must.

The mode is itself canon-tunable via `pol-planning-pipeline-default-mode` so an org-ceiling deployment that has decided every plan goes through the deep pipeline can flip the default; the indie floor's bootstrap canon ships with `default-mode: 'single-pass'` so a solo developer does not surprise-pay the multi-stage cost on a one-line README fix. Per `dev-indie-floor-org-ceiling` both ends are first-class.

The drift signal: a CTO-class actor that needs the deep pipeline but was invoked without `--mode=substrate-deep` writes an escalation atom rather than degrading to single-pass. The classification step (re-using the existing `PLAN_CLASSIFY` schema) gains a new outcome `'requires-deep-pipeline'` for `greenfield` and `architectural` requests; the single-pass path treats this outcome as an escalation rather than a draft attempt. Per `dev-judgment-ladder-required-for-llm-actors` the failed classification cannot auto-advance.

---

## 11. Resumability

Pipeline state is fully atom-projected per `arch-atomstore-source-of-truth` and the atom-store is durable. A pipeline run that crashes (process kill, host failure, kill-switch) leaves the pipeline atom in `running:<n>` with the prior n stage-output atoms persisted; on restart, the orchestrator queries for `pipeline_state` matching `running:*`, identifies the next stage to run, and re-invokes from there.

This mirrors the `ResumeAuthorAgentLoopAdapter` pattern that PR #171 (`docs/superpowers/specs/2026-04-25-resume-author-agent-loop-adapter-design.md`) shipped for the agentic actor loop: the substrate already proves resume-from-the-last-completed-step is the right shape; here we apply it to the planning pipeline.

The resume-default operator-intent (`operator-intent-resume-default-non-pr-fix-actors-1777391142435`) names this as the goal for non-pr-fix actors broadly. The pipeline inherits the property by construction: there is no in-memory state that survives a process boundary, only atom reads.

A `--resume-from-stage <name>` flag on the driver script lets the operator force a re-run from an earlier stage (e.g. brainstorm produced bad notes, operator wants to redo with new context). The flag transitions the pipeline back to `running:<earlier_index>` and supersedes the stage-output atoms produced after that point (sets `superseded_by` on each rather than deleting; provenance survives).

---

## 12. Observability

The Console `/plans` view gains a per-pipeline drill-in surface. Three additions:

- **Pipeline-stage trail.** Per-pipeline timeline rendering each stage as a card: stage name, status (running / completed / failed / hil-paused), wall-clock duration, declared `cost_usd`, output-atom link. Built on existing `pipeline-stage-event` atoms via the existing in-memory atom index (per the LAG Console projection decision).
- **Live-ops `in_flight_pipelines` tile.** New tile on the live-ops snapshot that counts pipeline atoms with `pipeline_state` matching `running:*` or `hil-paused:*`. Sits next to the existing `in_flight_actors` and `in_flight_pr_reviews` tiles.
- **Audit findings panel.** Per-pipeline drill-in tab listing every `pipeline-audit-finding` atom for the run, severity-grouped, with linked source-path snippets when the finding cites a path.

Per `dev-web-mobile-first-required` the drill-in renders as single-column on 390px viewports with 44px tap targets; desktop progressive-enhancement reveals the timeline horizontally.

The Console reads everything via the existing HTTP API surface (`POST /api/canon.list`, `POST /api/atoms.references`, etc.) per the API canon decision. No filesystem reach-around.

---

## 13. Rollback

Stage failure transitions the pipeline atom `pipeline_state: running:<n> -> failed:<n>` cleanly:

1. The stage's `run` method threw, `audit` returned a critical finding, or the stage exceeded its `cost_usd` cap.
2. The orchestrator writes a `pipeline-failed` atom carrying the full chain (every stage output atom id produced so far) and a `recovery_hint`.
3. The orchestrator emits an actor-message escalation to the resumer principal via Notifier (existing seam).
4. The pipeline atom is updated with `pipeline_state: failed:<n>`; downstream consumers (Console, dispatch loop) see the terminal state.
5. The operator can re-run from any stage via `--resume-from-stage <name>`; the prior `pipeline-failed` atom remains as audit evidence and the new run derives from it (`derived_from: [pipeline-failed-atom-id, original-pipeline-atom-id]`).

No automatic retry at the pipeline level. Per-stage retry (`pol-judgment-fallback-ladder` shape) handles transient failures; if the stage's retry ladder exhausts, the pipeline as a whole fails. This is the right boundary because a stage-author can implement nuanced retry (e.g. cheaper-model fallback) but the pipeline orchestrator should not guess what "retry" means at a coarser grain. Per `dev-judgment-ladder-required-for-llm-actors`, a failed stage cannot produce auto-approvable output.

---

## 14. Threat Model

- **LLM hallucination of paths or atom ids.** Pipeline's `review-stage` runs a registered `pipeline-auditor` (read-only Read+Grep+Glob) that walks every cited path and atom id from the plan body and verifies each resolves. Tonight's `runApprovedPlanDispatchPass` confabulation is exactly this failure class; the review stage closes the gap. Mitigates `dev-drafter-citation-verification-required` failure mode at the substrate level.
- **Runaway cost.** Each stage declares `cost_usd` in its output, the orchestrator enforces a per-stage cap from `pol-pipeline-stage-cost-cap-<stage>` (default to `pol-code-author-per-pr-cost-cap` value when no per-stage atom exists), and the pipeline atom carries `total_cost_usd` against a per-pipeline cap. Exceeding the cap fails the stage; per-stage caps prevent a runaway brainstorm from burning the whole pipeline budget.
- **Stage prompt injection.** Stage outputs are zod-validated against `outputSchema` before persistence; an LLM that emits a payload outside the schema fails validation and the stage is retried per its retry strategy. Prompts themselves are versioned and stored as canon policy atoms (`pol-pipeline-stage-prompt-<stage>` mirroring `pol-llm-tool-policy-<principal>`); a tampered prompt is a canon edit, visible in the audit chain.
- **Sub-actor compromise.** A compromised stage-actor (e.g. `spec-author` with leaked credentials) is bounded by the existing principal-based deny-list (`pol-llm-tool-policy-<principal>`), the existing `SubActorRegistry.invoke` taint-checks the produced atoms, and the orchestrator's schema validation rejects malformed output. Existing taint cascade applies: a tainted stage atom poisons every downstream stage and the pipeline as a whole flips to `tainted`.
- **Pipeline-mode escalation.** A non-operator principal cannot enable `substrate-deep` mode for a different principal: the mode flag is read from the invoker's authorizing operator-intent and validated against the existing `pol-operator-intent-creation` allowlist. A compromised CTO-actor cannot escalate its own mode without a signed intent.
- **HIL bypass.** The HIL gate atoms (`pol-pipeline-stage-hil-<stage>`) carry the existing canon-edit gate (L3 promotion requires `inv-l3-requires-human`); silently dropping HIL on a stage requires a canon edit, visible in the canon diff and rejected at promotion time without an operator signature.
- **Kill-switch race.** The orchestrator checks `host.scheduler.killswitchCheck()` before each stage transition (mirroring `runIntentAutoApprovePass:241`). A pipeline mid-stage when STOP is written halts cleanly at the next checkpoint; the running stage's sub-actor receives an AbortSignal via the SubActorRegistry seam. Per `inv-kill-switch-first`, this is the absolute-priority gate.

---

## 15. Alternatives Considered

- **Single-pass with post-hoc auditor.** Rejected: too late. Tonight's failure case (`runApprovedPlanDispatchPass` confabulation) was caught by a human grep, not by the actor flow itself. A post-hoc auditor finds the bug after the PR is opened; a per-stage auditor finds it before the PR is even drafted. The research investment is the right tradeoff per `dev-extreme-rigor-and-research`.
- **Direct dependency on the superpowers plugin.** Rejected: couples LAG to the Claude Code plugin's update cycle. The superpowers brainstorming/writing-plans/subagent-driven shape is the inspiration; we reproduce the SHAPE in LAG-native primitives so any agent runtime (Claude Code today, others tomorrow) composes the same pipeline.
- **New Host sub-interface (`PipelineRuntime`).** Rejected for v1: single-consumer. Per `arch-host-interface-boundary` we add Host sub-interfaces only when a second consumer exists. SubActorRegistry already does what a `PipelineRuntime` would do; if a second consumer materializes (e.g. a CD pipeline), that is the moment to extract.
- **HIL gate at every stage by default.** Rejected: kills autonomy. The operator-intent envelope already gates the autonomous flow; layering an unconditional HIL pause on every stage means every pipeline run wakes the operator five times for every architectural decision. Per `dev-indie-floor-org-ceiling`, the indie default optimizes for the operator's time budget; the org ceiling can override per-deployment.
- **No mode-gating; every plan goes through the pipeline.** Rejected: the operator's "bread-and-butter posture" framing explicitly contemplates that tactical fixes amortize through the existing single-pass. A typo-fix paying brainstorm + spec + review cost is a 50x tax for no governance value.
- **Stage outputs as in-memory pass-through (no atoms).** Rejected: breaks `arch-atomstore-source-of-truth`, breaks resumability, breaks observability, breaks taint cascade. The atom-projection cost is the substrate's whole point.
- **Linear stage list only (no DAG).** Considered for v1; accepted as the v1 shape with an additive seam for DAG ordering later. A DAG (e.g. spec branches into both `legal-review` and `security-threat-model` running in parallel, both feeding into `plan-stage`) is a real org-ceiling want but not the indie-floor want. Linear-now-with-DAG-seam-later beats DAG-now-with-complexity-cost. The stage-ordering policy atom shape (Section 7) accepts an array; a future schema bump can add `depends_on: string[]` to entries without breaking the linear case.

---

## 16. Test Plan

- **Unit: PlanningStage interface.** Vitest suite per reference stage in `examples/planning-stages/*/test/`. Each stage tested with a `MemoryHost` fixture: input -> run -> typed output, schema validation, `cost_usd` and `duration_ms` reported, audit method called, kill-switch honored. No real LLM (use the `MemoryLLM` fixture per `src/runtime/actors/planning/host-llm-judgment.ts` test patterns).
- **Unit: Pipeline orchestrator state machine.** Vitest suite in `src/runtime/planning-pipeline/__tests__/` covering: pending -> running:0 -> running:N -> completed; stage failure transitions to failed; HIL pause + resume; kill-switch mid-pipeline; claim-before-mutate prevents double-advance under concurrent ticks; resume-from-stage flag; taint-cascade across stage outputs.
- **Integration: end-to-end with default stage set.** A test harness composes the five reference stages with a `MemoryHost`, seeds an operator-intent, runs the pipeline, asserts the produced atom chain (pipeline -> brainstorm-notes -> spec -> plan -> review-report -> dispatch-record), validates provenance, and replays from the atom set to verify reproducibility per `arch-atomstore-source-of-truth`.
- **Integration: review-stage catches confabulated citations.** Specific regression test: spec stage emits a spec atom with a `cited_paths` array containing one fabricated path; review stage's auditor catches it, emits a critical finding, pipeline transitions to `failed`. This is the substrate-level test that prevents tonight's failure mode.
- **Playwright e2e: Console pipeline drill-in.** Single mobile-viewport spec (iPhone 13, 390px) and one desktop spec verifying the pipeline drill-in renders the stage trail correctly, the in-flight tile updates as stages advance, and the audit findings panel displays critical findings prominently. Per `dev-web-mobile-first-required`.
- **Negative: malformed stages policy.** A canon policy atom with an unknown stage principal halts the pipeline at pre-flight with a `pipeline-failed` atom; verified via integration test.

The CR CLI pre-push gate (`dev-coderabbit-cli-pre-push`) runs against every implementation PR. Per `dev-implementation-canon-audit-loop`, a canon-compliance auditor sub-agent is dispatched per substantive task during implementation, in addition to the existing spec-compliance and code-quality reviewers per `superpowers:subagent-driven-development`.

---

## 17. What Breaks if Revisited at 3 Months / 10x Scale

The pipeline shape is sound at 10x because:

- **Pluggable stages.** An org running 50+ concurrent actors swaps the default five-stage set for a seven-stage set (legal-review, security-threat-model, perf-benchmark inserted) by writing one canon policy atom; framework code does not change. This is the `dev-indie-floor-org-ceiling` story by construction.
- **Atom-projected state.** The pipeline scales linearly with stage-count not pipeline-count; the AtomStore is already proven at the org-ceiling target through the existing PlanningActor and intent-approve substrate. The Console's in-memory atom index keeps observation cost flat.
- **No new Host sub-interface.** When the second consumer arrives we extract; until then, complexity stays bounded.

The risks at 10x:

- **Linear stage ordering becomes insufficient.** Some consumers will want DAG: parallel `legal-review` + `security-threat-model` stages feeding into a join `plan-stage`. The stage-policy schema is additive (Section 15 alternatives), so adding `depends_on: string[]` to stage entries is a forward-compatible bump; the orchestrator gains a DAG executor without changing the stage interface. Risk is contained.
- **Per-stage cost cap arbitration becomes complex.** With 50+ stages across multiple deployments, the per-stage cost cap policy atoms multiply. Mitigation: source-rank arbitration already handles policy multiplication (`conv-source-rank-formula`); the cost is observability (operators want to see the effective cap per stage per pipeline). Console drill-in shows the resolved cap per stage at run time.
- **Stage-actor proliferation.** With many stages each registered as a SubActor, the registry list grows. Mitigation: SubActorRegistry already provides `list()` for audit; a future canon-driven principal-store query can filter by tag. Not a substrate change.
- **Audit-atom volume.** Per-stage findings at high pipeline-throughput could grow the atom store. Mitigation: existing token-bucket and circuit-breaker policies (`pol-actor-message-rate`, `pol-actor-message-circuit-breaker`) already pattern-match for write-rate gating; a `pol-pipeline-audit-rate` atom mirrors that shape if needed. Not v1.

The shape that does not survive a future redesign is the linear-only stage ordering, and that is precisely the seam we keep additive. Everything else in the design composes through canon edits, not framework edits.

---

## 18. Open Questions

The brainstorm phase surfaces a few questions where the operator-intent does not fully constrain the answer. These are flagged as `q-*` atoms for operator triage; each blocks plan refinement, not the spec itself.

- `q-pipeline-llm-cost-attribution`. When a stage-actor invokes `host.llm.judge` multiple times within one stage, does `cost_usd` reported on `StageOutput` aggregate adapter-reported costs (requires LLM adapter capability), or is it the stage-actor's declared estimate? The agent-loop substrate's `tracks_cost: boolean` capability flag points one direction; the pipeline-stage interface needs an explicit answer.
- `q-pipeline-default-mode-bootstrap`. The default-mode atom (`pol-planning-pipeline-default-mode`) ships with `single-pass` for indie floor. But the operator-intent says "all PR-shipping flows route through it once the dispatcher is wired." Does the default flip to `substrate-deep` once Phase 55c is wired, or stays `single-pass` with deployments opting in? Affects bootstrap-canon shape.
- `q-pipeline-stage-output-superseding`. When `--resume-from-stage` rewinds to an earlier stage, do downstream stage atoms get marked `superseded_by` immediately, or only after the new stages produce replacement atoms? Atom-store consistency vs. partial-state visibility tradeoff.

---

**End of spec.** Plan-from-spec follows via `superpowers:writing-plans` in a subsequent agent invocation. Implementation follows via `superpowers:executing-plans` + `superpowers:subagent-driven-development` per the substrate canon, with per-task canon-compliance auditor sub-agents per `dev-implementation-canon-audit-loop` and CR CLI pre-push per `dev-coderabbit-cli-pre-push`.
