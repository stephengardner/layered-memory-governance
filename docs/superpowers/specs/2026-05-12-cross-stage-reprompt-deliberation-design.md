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
   - All re-runs respect the unified `attempt` counter the runner already maintains; max(intra-stage cap, cross-stage cap) is the total budget.

3. New canon policy `pol-cross-stage-reprompt-default`:
   ```json
   {
     "id": "pol-cross-stage-reprompt-default",
     "type": "policy",
     "kind": "cross-stage-reprompt",
     "max_attempts": 2,
     "severities_to_reprompt": ["critical"],
     "allowed_targets": ["brainstorm-stage", "spec-stage", "plan-stage"]
   }
   ```
   Indie default: max 2 cross-stage re-prompts per pipeline run. `allowed_targets` lists stages that can be re-prompted from downstream; review-stage and dispatch-stage are NOT allowed targets (they're audit-only / terminal).

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

1. **Cycle**: A finding from plan-stage targets brainstorm-stage; brainstorm emits revised output; plan-stage runs again; plan-stage emits ANOTHER critical finding targeting brainstorm again. Guard: unified `attempt` counter caps the total re-runs per pipeline. The cross-stage `max_attempts=2` plus the intra-stage `max_attempts=2` plus the validator-retry `max_attempts=2` are all CUMULATIVE through the runner's existing attempt-counter machinery. The pipeline cannot loop more than max(all three) total times regardless of which re-prompt path fires.

2. **Forward target**: A finding from plan-stage targets dispatch-stage (downstream). Reject at the runner: dispatch is downstream, not upstream; targeting it is a config error. Emit a runner-level critical finding so the operator sees the misconfiguration.

3. **Unknown target**: A finding targets a stage name not in the pipeline composition. Reject at the runner; emit operator-visible finding.

4. **Cost cap**: The existing per-stage `budget_cap_usd` and the pipeline-level cost cap (task #291) both apply to re-runs cumulatively. A cross-stage re-prompt does not reset the cost counter; the pipeline halts at cap regardless of which stage is currently running.

5. **STOP sentinel**: Each stage iteration checks the kill-switch at the top of its loop, per `inv-kill-switch-first`. Cross-stage re-prompt does NOT bypass the STOP check; the runner re-enters the stage loop normally.

6. **Citation drift across re-runs**: When plan-stage re-runs after a dispatch-stage finding, the verified-cited-atom-id set is re-derived from the upstream brainstorm + spec atoms. If those atoms changed between the original plan-stage run and the re-run (they shouldn't, since brainstorm/spec ran before plan in the original pass), the runner uses the LATEST seed atom set. This matches today's behavior for intra-stage re-prompt.

## Indie floor vs org ceiling

- **Indie floor**: ships `pol-cross-stage-reprompt-default` with `max_attempts=2`, `severities_to_reprompt=['critical']`, `allowed_targets=['brainstorm-stage','spec-stage','plan-stage']`. A solo developer sees a drafter-refusal trigger one re-plan attempt; if the second drafter run also refuses, the pipeline halts and surfaces both refusal notes for HIL. Cost-bound by the existing per-stage cap.

- **Org ceiling**: registers a higher-priority `pol-cross-stage-reprompt-<scope>` atom to raise `max_attempts` to 3 or 4, OR narrow `allowed_targets` (e.g. drop brainstorm-stage to prevent expensive re-survey). Substrate is one mechanism; deployments tune via canon edits, no framework release needed.

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
- `dev-actor-to-actor-deliberation-preserves-context` (memory entry; this spec makes the agent-to-agent thread the operator asked for)

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

Each PR is independent of the next at the substrate seam level; implementation can stop mid-arc and the codebase stays compileable.

## Operator-pre-authorization

Per operator directive 2026-05-12 ("drive every pending task to merge"): when the operator returns and reviews this spec, the implementation arc may proceed without per-PR approval gates IF this spec is accepted as-written. If the operator wants to redirect, the spec is the place to redirect from -- not mid-implementation.
