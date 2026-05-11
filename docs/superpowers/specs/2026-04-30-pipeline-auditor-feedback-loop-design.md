# Pipeline Auditor-Findings Feedback Loop -- Design Spec

**Status**: PR-B implemented (2026-05-11). The substrate runner-side loop, `decideRePromptAction` + `buildRePromptContext` helpers, and the `pol-auditor-feedback-reprompt-default` canon policy ship together. The runner re-prompts the failing stage on a critical finding, bounded at `max_attempts=2` total per stage. Stage adapters that want the prompt-side teaching signal read `StageInput.priorAuditFindings` (additive, non-breaking); existing adapters continue to work without changes. PR-C through PR-F (per-stage prompt-template migrations) remain follow-ups.

**Substrate surface** (PR-B):
- `src/runtime/planning-pipeline/auditor-feedback-reprompt.ts` -- `decideRePromptAction`, `buildRePromptContext`, `AuditorFeedbackRePromptConfig`
- `src/runtime/planning-pipeline/auditor-feedback-reprompt-config.ts` -- canon-policy reader + `HARDCODED_DEFAULT`
- `src/runtime/planning-pipeline/runner.ts` -- inner attempt loop; reads canon once per pipeline; emits `retry-after-findings` events with `attempt_index` + `findings_summary`
- `scripts/bootstrap-auditor-feedback-reprompt-canon.mjs` + `scripts/lib/auditor-feedback-reprompt-canon-policies.mjs` -- canon seed (idempotent, drift-checked)

**Date**: 2026-04-30 (spec); 2026-05-11 (PR-B shipped)
**Derived from**: `dev-deep-planning-pipeline` (L3, ratified 2026-04-30 via PR #246), PR #247 (`feat/brainstorm-citation-soft`)
**Successor work to**: PR #247 (severity-downgrade interim fix)

## 0. Indie-floor + org-ceiling fit

A solo developer running a typo-fix prompt should never see a feedback loop. The mode-gate stays `single-pass` by default (per `pol-planning-pipeline-default-mode`), and within a substrate-deep run the loop activates only on findings of severity `>= major` AND only when the stage opts in via an explicit `acceptsAuditFeedback: true` flag on the `PlanningStage` interface. An org running 50+ concurrent actors that wants the loop on every stage flips a higher-priority canon atom; raising the dial is a canon edit, not a code change.

## 1. Goal

When a pipeline stage's `audit()` returns findings the LLM could plausibly self-correct, give the drafter exactly one chance to re-emit a corrected payload before the runner halts the stage. Closes the gap PR #247 papers over with a severity downgrade.

Concrete: a brainstorm-stage emits a payload with a fabricated `atom:foo-bar` citation. Today (post-PR #247): finding logged at `major`, pipeline proceeds with bad data on disk. Tomorrow: finding fed back to drafter, drafter re-emits without the citation, pipeline proceeds with correct data.

## 2. Current state (post-PR #247)

```text
runStage:
  output  = stage.run(input)
  findings = stage.audit(output, ctx) ?? []
  for finding in findings:
    write pipeline-audit-finding atom
  if any finding has severity === 'critical':
    write pipeline-stage-event(exit-failure)
    return { halted: true }
  else:
    write pipeline-stage-event(exit-success)
    return { halted: false, output }
```

Failure mode: a `major` finding is logged but the pipeline accepts the imperfect output. The auditor is observational, not corrective.

## 3. Proposed: re-prompt on findings

The control flow filters findings by the configured `severity_floor` so the loop activates only on findings at-or-above that floor. Define `actionable = findings.filter(f => rank[f.severity] >= rank[severity_floor])`, where `rank = { minor: 0, major: 1, critical: 2 }`. The loop exits success when `actionable` is empty (any below-floor findings are passed through as advisory). When `severity_floor='critical'`, only critical findings are actionable; majors and minors are non-actionable and accepted with the output. When `severity_floor='major'` (the indie-floor default), majors and criticals are actionable; minors are non-actionable.

```text
runStage:
  attempts = 0
  prior_findings = []
  loop:
    output = stage.run({ ...input, prior_audit_findings: prior_findings })
    findings = stage.audit(output, ctx) ?? []
    for finding in findings: write pipeline-audit-finding atom
    actionable = findings.filter(f => rank[f.severity] >= rank[severity_floor])
    if actionable.length === 0:
      write pipeline-stage-event(exit-success)
      return { halted: false, output }
    if attempts >= max_audit_retries:
      // Original critical-halts-stage / major-proceeds-with-warning behaviour
      if actionable.some(f => f.severity === 'critical'):
        write pipeline-stage-event(exit-failure)
        return { halted: true }
      write pipeline-stage-event(exit-success-with-findings)
      return { halted: false, output }
    if !stage.acceptsAuditFeedback:
      // Stage opted out; fall through to the floor-respecting halt logic above.
      if actionable.some(f => f.severity === 'critical'):
        write pipeline-stage-event(exit-failure)
        return { halted: true }
      write pipeline-stage-event(exit-success-with-findings)
      return { halted: false, output }
    write pipeline-stage-event(retry-after-findings)
    prior_findings = actionable
    attempts += 1
```

## 4. Substrate changes

### 4.1 `StageInput<T>` gains an optional field

```ts
interface StageInput<T> {
  ...existing fields;
  /** Audit findings from the prior attempt at this stage; absent on first attempt. */
  readonly prior_audit_findings?: ReadonlyArray<AuditFinding>;
}
```

The field is optional. When the runner re-invokes a stage after findings, it passes the actionable subset; on the first attempt it omits the field entirely. Stages SHOULD treat `undefined` and `[]` identically (default to `[]` at the read site). Existing stages that don't read this field stay backwards-compatible.

### 4.2 `PlanningStage` gains an opt-in flag

```ts
interface PlanningStage<TIn, TOut> {
  ...existing fields;
  /** When true, runner re-invokes `run()` with prior_audit_findings on findings of severity >= major,
   *  up to max_audit_retries times. Default: false (preserves current behaviour). */
  readonly acceptsAuditFeedback?: boolean;
}
```

Reference adapters (`brainstorm-stage`, `spec-stage`, `plan-stage`, `review-stage`, `dispatch-stage`) flip this to `true` per stage as they become loop-aware. The runner change ships first; adapter migrations follow per stage.

### 4.3 New atom event transition

The existing `pipeline-stage-event` shape (`src/runtime/planning-pipeline/atom-shapes.ts`, `mkPipelineStageEventAtom` + `TRANSITION` enum) carries the kind on `metadata.transition`, typed as the union `'enter' | 'exit-success' | 'exit-failure' | 'hil-pause' | 'hil-resume'`. PR-B extends the union to add `'retry-after-findings'` (and the parallel `'exit-success-with-findings'` value used at retry-cap). The new transition variants carry `attempt_index`, `findings_summary` (count by severity), and `total_attempted` inside `metadata`, alongside the existing `pipeline_id`, `stage_name`, `duration_ms`, and `cost_usd` fields. No new atom type is introduced; only the typed `transition` discriminant grows.

### 4.4 New policy atom

```text
pol-pipeline-stage-audit-retry-max
  scope: { stage_name?: string }   // omit for global default
  policy:
    max_audit_retries: number      // default: 1
    severity_floor: 'major'        // 'major' | 'critical' -- only findings at/above this severity are actionable; below-floor findings are advisory and accepted with the output
```

Indie-floor default: `max_audit_retries=1`, `severity_floor='major'`. Org-ceiling deployments raise to 2-3 if their LLM-of-choice benefits from multi-shot self-correction.

## 5. Stage-adapter migration: brainstorm-stage as the first consumer

When `prior_audit_findings` is non-empty, the brainstorm-stage prompt prepends:

```text
Your prior attempt produced these audit findings:

{for f in prior_audit_findings:}
  - [{f.severity}] {f.category}: {f.message}

Re-emit the payload addressing each finding. If a finding flags a fabricated
citation, omit the citation. If a finding flags a non-seed citation, omit it
or replace it with the corresponding verified id from data.verified_seed_atom_ids.
```

The LLM's second pass should produce a payload that satisfies the audit. If it doesn't, the loop terminates per max_audit_retries and the original halt-on-critical behaviour fires.

PR #247's severity downgrade can then be reverted (separate PR): brainstorm citation findings return to `critical`, but the runner re-prompts before halting. The audit-trail atom flow remains identical.

## 6. Threat model

**Tampered pipeline atom mid-loop**: between attempts, a malicious peer could mutate the pipeline atom's seedAtomIds. The runner already does claim-before-mutate via the optimistic-version field; we extend the claim window to cover the entire retry loop, not just one attempt. Concretely: `lastVersion` is captured at attempt 0, every attempt's pipeline-stage-event write asserts that version, the loop terminates on a version-mismatch claim-failure rather than racing.

**Prompt injection via prior_audit_findings**: a stage that emits a malicious `cited_paths: ["../../../etc/passwd"]` could inject prose into the next attempt's prompt. Mitigation: the runner sanitizes finding messages before passing them to `stage.run()`. Specifically, `cited_paths` and `cited_atom_ids` are flattened into structured fields that the prompt template consumes positionally; raw `message` strings are bounded by `MAX_FINDING_MESSAGE_LEN` (default 1024) and HTML-stripped.

**Cost overflow via retry storm**: `max_audit_retries=1` is the default, hard-capped at 5 even by canon override. Each attempt's `cost_usd` accumulates against the existing per-stage `budget_cap_usd`; a runaway re-prompt loop hits the budget cap and halts with `cause: 'budget-overflow'` (existing mechanism, no new code).

**Self-confirming bias**: feeding the auditor's findings back to the drafter risks the drafter "fixing" the citation in a way the same auditor accepts but a fresh auditor would reject. Mitigation: when `acceptsAuditFeedback === true`, the auditor's atom-resolvability check stays mechanical (host.atoms.get) -- the auditor does not take prior findings as input. The bias surface is the LLM, not the auditor.

## 7. Test plan

- Unit: `runStage` retry-loop with mock audit returning findings on attempt 0, none on attempt 1. Asserts `run()` called twice, `prior_audit_findings` populated on the second call, exit-success event written.
- Unit: `runStage` with `max_audit_retries=0` falls through to original behaviour (no retry, halt on critical).
- Unit: `runStage` with `acceptsAuditFeedback=false` skips the loop entirely.
- Unit: budget overflow during retry triggers `exit-failure(budget-overflow)`, not `exit-success-with-findings`.
- Integration (MemoryHost): full pipeline run with brainstorm-stage that emits a fabricated citation on attempt 0 and a clean payload on attempt 1; pipeline reaches spec-stage successfully.
- Conformance: claim-before-mutate version assertion holds across the entire retry window.

## 8. Migration plan

PR-A (this spec, docs only) -- committed as `docs/pipeline-feedback-loop-spec`.
PR-B -- substrate runner change: optional `StageInput.prior_audit_findings` field, `PlanningStage.acceptsAuditFeedback` flag, runner retry loop with `severity_floor`-aware actionable filtering, extension of the `TRANSITION` union in `mkPipelineStageEventAtom` to include `'retry-after-findings'` and `'exit-success-with-findings'`, new `pol-pipeline-stage-audit-retry-max` policy parser. Reference adapters opt out (`acceptsAuditFeedback: false`) initially.
PR-C -- brainstorm-stage opt-in (`acceptsAuditFeedback: true`), prompt-template change, revert PR #247's severity downgrade.
PR-D -- spec-stage opt-in.
PR-E -- plan-stage opt-in.
PR-F -- review-stage / dispatch-stage opt-in.

Per PR-B's flag-default-false, the substrate change is non-breaking; deployments running pinned reference adapters keep current behaviour until they explicitly opt in.

## 9. What breaks if revisited in 3 months

The retry loop is a substrate-defined ENUM (per `dev-apex-tunable-trade-off-dials`): off / minor-only / major-and-up / critical-and-up. Default is major-and-up. A future deployment that wants finer control adds a higher-priority policy atom, not a code change.

The `prior_audit_findings` field is additive on `StageInput<T>`; adapters that don't read it continue to work. The `acceptsAuditFeedback` flag is opt-in; existing reference adapters preserve their post-PR #247 severity-downgrade until each is migrated.

The DAG forward-compat seam (`PlanningStage.dependsOn`) is orthogonal to retry behaviour: a stage in a parallel DAG branch retries the same way regardless of how the runner orders branches.

## 10. Out of scope (deferred)

- **Auditor-of-auditor**: a second auditor verifying the first didn't drift. Wait for the second concrete consumer per `dev-no-speculative-substrate`.
- **Cross-stage retry**: re-running stage N+1 when stage N's findings change after N+1 has already started. Today the runner walks stages strictly sequentially; cross-stage retry is a parallel-DAG concern.
- **Operator-in-the-loop interleaving**: pausing the retry on the first finding for HIL approval. The `pol-pipeline-stage-hil-<stage>` atom already gates on `pause_mode='on-critical-finding'`; HIL interleaves between stages, not within a stage's retry loop.

## 11. Implementation gating

Land PR-A (this spec) only after PR #247 (`feat/brainstorm-citation-soft`) has merged, so the severity-downgrade interim is in main as the no-loop fallback. PR-C's revert of #247 then becomes the natural cap of the migration.
