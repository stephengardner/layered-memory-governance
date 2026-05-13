# Cross-stage re-prompt deliberation design

**Date:** 2026-05-12
**Status:** Draft (spec only; implementation deferred)
**Operator north-star (verbatim 2026-05-12):** "We need an explicit handoff state, deliberation back and forth, visibility into the contextual handoffs."

## Problem

The substrate-deep planning pipeline runs five stages: brainstorm -> spec -> plan -> review -> dispatch. Today's re-prompt machinery is INTRA-stage only:

- `pol-auditor-feedback-reprompt-default` (task #293): when a stage's `audit()` returns critical findings, the runner re-invokes the SAME stage with `priorAuditFindings` as input. Max attempts = 2.
- `pol-plan-stage-validator-retry-default` (task #339): when plan-stage zod-schema parsing fails, the runner re-invokes plan-stage with `priorValidatorError`. Max attempts = 2.

Both re-prompt the failing stage. Neither propagates findings UPSTREAM.

The failure mode this gap leaves open: dispatch-stage observes a `code-author-invoked` atom whose drafter refused (`executor_result.kind='noop'`, `reason='drafter-emitted-empty-diff'`). PR #425 (Phase 1 of this north-star) added a `dispatch-drafter-refusal` critical finding in `auditDispatch`. The runner's halt-on-critical machinery then halts the pipeline. But the right move is not to re-run dispatch-stage with the same plan -- the plan is bad. The right move is to re-run PLAN-STAGE with the drafter's refusal notes as feedback, producing a revised plan that the drafter can actually act on.

Same shape applies to other upstream-rooted failures. Examples:

1. dispatch-stage detects fence violation (delegation.sub_actor not in verified set) -> re-prompt plan-stage with the violation as feedback.
2. review-stage detects citation fabrication in the plan -> re-prompt plan-stage (today: re-prompts review-stage which can't fix the plan).
3. plan-stage's schema validator rejects target_paths that don't exist on disk -> re-prompt brainstorm + spec stages so they re-survey and emit a tighter scope (today: re-prompts plan-stage which can only retry the same scope).

Phase 2 ships the substrate seam that lets a finding say "I'm caused by an upstream stage's output; re-prompt that stage, not me".

## Architecture

### Mechanism: scoped findings

Extend `AuditFinding` with a `reprompt_target` field:

```ts
export interface AuditFinding {
  readonly severity: 'critical' | 'major' | 'minor';
  readonly category: string;
  readonly message: string;
  readonly cited_atom_ids: ReadonlyArray<AtomId>;
  readonly cited_paths: ReadonlyArray<string>;
  /**
   * Stage whose output caused this finding. Default: the auditing stage
   * itself (current intra-stage re-prompt). When set to an upstream stage
   * name (one of the pipeline's prior stages), the runner re-invokes THAT
   * stage with this finding folded into its priorAuditFindings instead
   * of re-running the auditing stage.
   */
  readonly reprompt_target?: string;
}
```

Default behavior unchanged: omit `reprompt_target` -> intra-stage re-prompt (current behavior).

### Runner change

`src/runtime/planning-pipeline/runner.ts` extends the re-prompt loop:

1. After a stage's `audit()` returns findings, partition by `reprompt_target`:
   - Findings with no target or self-target -> intra-stage re-prompt bucket (existing behavior).
   - Findings with upstream target -> cross-stage re-prompt bucket (new).

2. If the cross-stage bucket is non-empty AND the target stage is upstream of the current stage in the pipeline ordering:
   - Mark the current stage's attempt as "deferred-pending-upstream-revision".
   - Jump back to the target upstream stage.
   - The upstream stage's StageInput carries `priorAuditFindings` populated with the cross-stage findings.
   - From the upstream stage forward, run every stage between target and current stage again (fresh outputs).
   - All re-runs respect the runner's unified pipeline-attempt counter. The counter is shared across intra-stage re-prompts, cross-stage re-prompts, and validator retries: `total_attempts_remaining = max(intra-stage cap, cross-stage cap, validator cap)` minus attempts already consumed regardless of which mechanism triggered them. With the indie default `max_attempts=2` set on every mechanism, the pipeline budget is 2 total attempts per stage (not 6); a drafter-refusal that fires the cross-stage path consumes 1 of the same 2 attempts an intra-stage retry would have consumed.

3. New canon policy `pol-cross-stage-reprompt-default`:
   ```json
   {
     "id": "pol-cross-stage-reprompt-default",
     "type": "policy",
     "kind": "cross-stage-reprompt",
     "max_attempts": 2,
     "severities_to_reprompt": ["critical"],
     "allowed_targets": "derive-from-pipeline-composition"
   }
   ```
   `max_attempts=2` shares the unified attempt counter described above. `severities_to_reprompt` matches the indie floor for the auditor-feedback policy.

   `allowed_targets` is DERIVED at runtime from the active pipeline composition rather than hardcoded so the spec stays valid for any stage shape. The runner exposes `pipelineComposition.allowedReprompTargets()`: every stage in the composition EXCEPT the terminal stage (dispatch-stage in the 5-stage default) and any stage flagged as audit-only (review-stage in the 5-stage default; the `audit_only: true` flag on the PlanningStage interface is the seam) is an allowed target. Org-ceiling deployments that compose additional stages (legal-review, perf-benchmark) automatically get them as re-prompt targets. The string literal `"derive-from-pipeline-composition"` is the policy-atom signal that the runner should derive at startup; deployments that want to explicitly narrow the set write a higher-priority atom with a literal `string[]` of stage names.

### Stage-adapter change: dispatch finding scoping

`examples/planning-stages/dispatch/index.ts` `buildDrafterRefusalFinding` (shipped in PR #425) gains `reprompt_target: 'plan-stage'`:

```ts
return {
  severity: 'critical' as const,
  category: 'dispatch-drafter-refusal',
  message,
  cited_atom_ids: [observation.id, planId] as ReadonlyArray<AtomId>,
  cited_paths: [],
  reprompt_target: 'plan-stage',
};
```

Now when the drafter refuses, the runner walks back to plan-stage with the drafter's notes as `priorAuditFindings`. The plan-stage adapter reads them, sees "drafter refused plan X because: <notes>", emits a revised plan that addresses the specific scope-impossibility, and dispatch re-runs against the revised plan.

### What survives review-stage gap

Today, `auditReview` (in `examples/planning-stages/review/index.ts`) emits findings about review-report correctness. If a finding traces back to a fabricated citation in the upstream PLAN, the right re-prompt target is `plan-stage`. Phase 2's `reprompt_target: 'plan-stage'` ships this for review-stage too without further code -- the runner machinery is generic.

### What stays unchanged

- Intra-stage re-prompt for findings whose `reprompt_target` is undefined or equals the auditing stage's name. Default behavior identical to today.
- `pol-auditor-feedback-reprompt-default` continues to govern intra-stage cap.
- `pol-plan-stage-validator-retry-default` continues to govern plan-stage schema retry.
- AuditFinding's other fields unchanged.

## Failure modes + guards

1. **Cycle**: A finding from plan-stage targets brainstorm-stage; brainstorm emits revised output; plan-stage runs again; plan-stage emits ANOTHER critical finding targeting brainstorm again. Guard: the runner's unified pipeline-attempt counter (see Mechanism section) caps total re-runs at `max(intra-stage cap, cross-stage cap, validator cap)`. With indie defaults all three caps equal 2, so the cycle terminates at 2 total iterations regardless of which mechanism fired. The pipeline cannot exceed `max(all three)` total iterations even if every mechanism contributes findings.

2. **Forward target**: A finding from plan-stage targets dispatch-stage (downstream). Reject at the runner: dispatch is downstream, not upstream; targeting it is a config error. Emit a runner-level critical finding so the operator sees the misconfiguration.

3. **Unknown target**: A finding targets a stage name not in the pipeline composition. Reject at the runner; emit operator-visible finding.

4. **Cost cap**: The existing per-stage `budget_cap_usd` and the pipeline-level cost cap (task #291) both apply to re-runs cumulatively. A cross-stage re-prompt does not reset the cost counter; the pipeline halts at cap regardless of which stage is currently running.

5. **STOP sentinel**: Each stage iteration checks the kill-switch at the top of its loop, per `inv-kill-switch-first`. Cross-stage re-prompt does NOT bypass the STOP check; the runner re-enters the stage loop normally.

6. **Citation drift across re-runs**: Citation drift is EXPECTED for cross-stage re-prompts because the re-prompt mechanism is DESIGNED to produce new upstream output. When a finding from plan-stage targets brainstorm-stage with feedback, brainstorm-stage re-runs WITH `priorAuditFindings` populated and emits a brainstorm atom that differs from the original. The downstream stages then need to re-resolve their citations against the new upstream atom set.

   Resolution policy (RFC-style; option A is the indie-floor default):
   - **(A) Invalidate-and-re-derive (default)**: When a cross-stage re-prompt fires, the runner walks every stage between the re-prompt target (inclusive) and the original auditing stage (exclusive). For each stage in the walk, the runner discards the prior `verifiedCitedAtomIds` set computed from upstream and re-derives it from the LATEST upstream atoms in scope (those produced by the most recent re-run). The new plan-stage run gets a `verifiedCitedAtomIds` set that reflects the new brainstorm. Plan-stage emits cited_atom_ids grounded in the new set; any prior cited_atom_ids that no longer exist in the new set are dropped (since they referenced the prior, now-superseded brainstorm atoms). The dispatch-stage audit then walks the new plan's citations against the new verified set; a fabricated citation in the new plan still emits a critical finding (existing behavior).
   - **(B) Deterministic remapping with fallback (deferred to a follow-up spec)**: An optional substrate layer maps prior atom-ids to new ones when content is structurally similar (e.g. same purpose, same target_path). Not in scope for v1.
   - **(C) Preserve old atom-id set**: Rejected as a default because it would let plan-stage cite atoms the new brainstorm did not produce, creating audit-trail confusion.

   For the v1 implementation, option (A) is the contract. The runner annotates each re-run with metadata `verified_cited_atom_ids_origin: 'derived-from-rerun-<target-stage>-attempt-<n>'` so the Console projection and the audit trail show explicitly which run's upstream the citations were resolved against.

## Indie floor vs org ceiling

- **Indie floor**: ships `pol-cross-stage-reprompt-default` with `max_attempts=2`, `severities_to_reprompt=['critical']`, `allowed_targets='derive-from-pipeline-composition'` (resolves to brainstorm/spec/plan in the 5-stage default; review and dispatch excluded because they carry `audit_only:true` and terminal flags respectively). A solo developer sees a drafter-refusal trigger one re-plan attempt; if the second drafter run also refuses, the pipeline halts and surfaces both refusal notes for HIL. Cost-bound by the existing per-stage cap.

- **Org ceiling**: registers a higher-priority `pol-cross-stage-reprompt-<scope>` atom to raise `max_attempts` (still bounded by the unified counter described in Mechanism), OR narrow `allowed_targets` to a literal `string[]` (e.g. drop brainstorm-stage to prevent expensive re-survey), OR widen `severities_to_reprompt` to include 'major'. Substrate is one mechanism; deployments tune via canon edits, no framework release needed.

## Visibility (operator north-star)

Every cross-stage re-prompt event emits a `pipeline-cross-stage-reprompt` atom with:
- `from_stage`: the auditing stage that emitted the finding (e.g. 'dispatch-stage')
- `to_stage`: the re-prompt target (e.g. 'plan-stage')
- `finding`: the AuditFinding payload (severity, category, message, citations)
- `attempt`: the cumulative pipeline attempt counter at re-prompt time
- `correlation_id`: pipeline correlation
- `provenance.derived_from`: pipeline atom id + finding's source observation atom id

The Console's `/pipelines/<id>` view picks these up via the existing PipelineLifecycle projection and renders a "Deliberation thread" section: each cross-stage re-prompt is a row showing FROM -> TO with the finding message. Operator sees the explicit handoff state per their north-star.

Threading: each cross-stage re-prompt atom carries `provenance.derived_from` of the prior re-prompt atom (if any) so the Console can render a back-and-forth chain rather than a flat list.

## Cited canon

- `dev-deep-planning-pipeline` (5-stage composition; this directive's intra-stage rules)
- `dev-substrate-not-prescription` (the cross-stage re-prompt is a mechanism, behavior gated by canon policy)
- `dev-indie-floor-org-ceiling` (indie default + org dials)
- `dev-governance-before-autonomy` (deterministic re-prompt rules first, then raise the autonomy dial)
- `inv-kill-switch-first` (re-prompt loops still respect STOP)
- The "agent-to-agent deliberation preserves context" pattern (operator-stated 2026-05-12 in `feedback_agent_to_agent_deliberation_preserves_context.md` memory; not yet a canon directive). Phase 2 is the substrate mechanism that supports this pattern; if and when the operator promotes the pattern to L3 canon, this spec is the implementation reference. Until then, treat this as a local design choice that aligns with the memory-recorded preference rather than a load-bearing canon citation.

## Out of scope

- Auto-merge after re-prompt success. The existing operator merge gate stays in place; cross-stage re-prompt only un-blocks the pipeline's NEXT-STAGE attempt, not the merge.
- New atom types beyond `pipeline-cross-stage-reprompt`. The finding shape carries everything else needed.
- Cross-PIPELINE re-prompt (one pipeline's failure causes another pipeline to re-run). Each pipeline is independent.
- UI controls for forcing a cross-stage re-prompt manually. HIL resume is the operator-driven path; the deliberation loop is the autonomous path.

## Implementation plan (deferred)

The implementation lives in a follow-up plan document:

- **PR1**: AuditFinding gains `reprompt_target?` (additive, default behavior preserved). Tests cover (a) undefined target -> intra-stage path; (b) self-target -> intra-stage path; (c) upstream target -> cross-stage path; (d) forward target -> runner-level error; (e) unknown target -> runner-level error.

- **PR2**: `pol-cross-stage-reprompt-default` canon atom + reader + bootstrap script. Tests cover policy fall-through (no atom -> hardcoded default), priority resolution, and the `allowed_targets` allowlist.

- **PR3**: `runPipeline` runner branch for cross-stage re-prompt. Partition findings by target, unified attempt counter, max(all caps) enforcement, STOP-sentinel respect, cost-cap respect. Tests cover all six failure-modes from this spec plus the happy path.

- **PR4**: `auditDispatch` (Phase 1) gains `reprompt_target: 'plan-stage'` on drafter-refusal findings. Tests cover end-to-end: drafter refusal at dispatch -> finding emitted -> plan-stage re-prompted with notes -> plan-stage emits revised plan -> dispatch runs against revised plan -> dispatched=1.

- **PR5**: Console `pipeline-cross-stage-reprompt` atom rendering on `/pipelines/<id>`. Deliberation-thread section between stages and post-dispatch lifecycle. Renders FROM -> TO with finding message; chains threaded back via provenance.derived_from.

- **PR6**: E2E Playwright test: file an intent likely to be refused (drafter-refusal-prone scope), watch /pipelines/<id> render the cross-stage deliberation, confirm pipeline reaches dispatched=1 on the second attempt.

Each PR is independently TESTABLE via unit tests, but full integration follows a dependency chain: PR1 (schema additive change) -> PR2 (canon policy + reader) -> PR3 (runner branching + unified attempt counter) -> PR4 (auditDispatch sets reprompt_target on drafter-refusal findings, depends on PR1 + PR3) -> PR5 (Console rendering, depends on PR3 emitting the cross-stage-reprompt atom) -> PR6 (E2E test, depends on PR1-PR5 integrated). The codebase REMAINS COMPILEABLE at every PR boundary: PR1's additive optional field does not break existing AuditFinding consumers; PR3's runner change ships behind a feature gate that defaults to off until PR4's adapter sets the new field; PR5 is a pure UI addition. Stopping mid-arc leaves a working system; full visibility-of-handoffs only lands when PR5 ships.

## Operator-pre-authorization

Per operator directive 2026-05-12 ("drive every pending task to merge"): when the operator returns and reviews this spec, the implementation arc may proceed without per-PR approval gates IF this spec is accepted as-written. If the operator wants to redirect, the spec is the place to redirect from -- not mid-implementation.
