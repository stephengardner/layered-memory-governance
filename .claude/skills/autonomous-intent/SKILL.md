---
name: autonomous-intent
description: Use when the operator wants a problem solved autonomously through the plan-approval pipeline: from operator-intent atom -> CTO plan -> auto-approval -> code-author dispatch -> auditor pre-flight -> PR merge -> plan-state reconcile.
---

# autonomous-intent substrate

> Shipped across tasks T2-T14 of plan 2026-04-24-autonomous-intent-substrate; some surfaces below (scripts/intend.mjs, invokers/autonomous-dispatch.mjs, runIntentAutoApprovePass) may not yet exist on disk during plan execution.

The substrate exists so the operator can declare "solve X autonomously within
these bounds" as a first-class atom. The pipeline (CTO -> approval tick ->
code-author -> auditor -> pr-landing -> reconcile) closes the loop without
per-step operator approval. Trust is declared up-front via the intent's
trust envelope; every downstream tick enforces that envelope mechanically.

## The `intend` CLI surface

```
node scripts/intend.mjs \
  --request "<text>"                                     # required: problem statement
  --scope tooling|docs|framework|canon                   # required: tenant scope
  --blast-radius none|docs|tooling|framework|l3-canon-proposal  # required: max plan reach
  --sub-actors code-author[,auditor-actor]               # required: authorized sub-actors
  --min-confidence 0.75                                  # default: plan confidence gate
  --expires-in 24h                                       # default (max 72h): auto-expiry
  --kind autonomous-solve                                # default; reserved: research-only, incident
  --dry-run                                              # print atom without writing
  --trigger                                              # spawn run-cto-actor.mjs --request <text> --intent-id <id> inline
```

## Trust envelope fields

Written to `metadata.trust_envelope` on the resulting intent atom:

| Field                          | Value / Default                  |
| ------------------------------ | -------------------------------- |
| `max_blast_radius`             | from `--blast-radius`            |
| `max_plans`                    | `5` (runaway cap; not CLI-configurable in v1; default-only) |
| `min_plan_confidence`          | `0.75` (or `--min-confidence`)   |
| `allowed_sub_actors`           | from `--sub-actors`              |
| `require_ci_green`             | `true`                           |
| `require_cr_approve`           | `true`                           |
| `require_auditor_observation`  | `true`                           |
| `expires_at`                   | ISO timestamp derived from `--expires-in` |

## Flow after `intend`

```text
Operator calls intend                  -- writes autonomous-intent atom
  |                                       (optionally invoked as --trigger: spawns run-cto-actor.mjs inline)
  |
  CTO drafts Plan atom                 -- metadata.delegation.sub_actor_principal_id set
  |                                       provenance.derived_from -> intent atom id
  |
  runIntentAutoApprovePass             -- reads intent via derived_from
  |   checks: envelope match           -- blast-radius, confidence, allowed_sub_actors
  |           intent not expired       -- expires_at > now
  |           principal whitelisted    -- allowed_sub_actors contains plan principal
  |   transitions: proposed -> approved
  |
  runDispatchTick                      -- invokes code-author
  |   via scripts/invokers/autonomous-dispatch.mjs
  |
  Code-author opens PR                 -- applies labels: autonomous-intent, plan-id:<id>
  |
  pr-landing workflow (lag-auditor job)-- fires on label presence
  |   writes LAG-auditor GitHub commit status
  |   writes observation atom
  |
  CR reviews; CI runs                  -- standard pipeline
  |
  PR merges (CI green + auditor pass)
  |
  pr-observation atom written
  |
  runPlanStateReconcileTick            -- closes plan to succeeded
```

## When NOT to use this skill

- **L3 canon edits**: human-only per `inv-l3-requires-human`; intent cannot
  authorize `canon-write-l3`.
- **Observation-only experiments**: use `auditor-actor` sub-actor directly via
  `run-cto-actor`, no intent atom needed.
- **Urgent manual fixes**: if the operator will merge the PR directly, skip the
  intent pipeline.

## Kill switch

`.lag/STOP` halts at the top of every tick (`runIntentAutoApprovePass`,
dispatch, auditor). The `intend` CLI also refuses to write if STOP is present.

## Failure modes (escalation paths, not crashes)

| Condition                        | Behavior                                                          |
| -------------------------------- | ----------------------------------------------------------------- |
| Expired intent                   | Approval tick skips; operator sees stale proposed plan; re-declare or approve manually |
| Compromised principal            | Taint cascade invalidates intent; approval tick skips             |
| Plan confidence below envelope   | Skipped silently; operator manually approves or re-runs CTO       |
| Blast-radius exceeds envelope    | Skipped; operator tightens envelope or widens scope               |
| Auditor verdict=fail             | `LAG-auditor` status fails; merge blocked; plan times out or operator abandons |

## Integration with other skills

- `cto-actor` - downstream when intent triggers a CTO run via `--trigger`.
- `pr-landing-agent` - downstream when code-author opens the PR and the auditor
  gate runs.
- `using-git-worktrees` / `worktree-workflow` - the autonomous flow operates on
  normal PR branches; no worktree requirement.

## Consult before changing behavior

- `design/target-architecture.md`: north-star diagram; gap analysis covers
  intent substrate placement.
- `src/runtime/actors/planning/`: PlanningActor primitive.
- `src/runtime/actor-message/intent-approve.ts`: where `runIntentAutoApprovePass`
  actually lives (consumed by the dispatch entry).
- `scripts/invokers/autonomous-dispatch.mjs`: dispatch entry point.
- `DECISIONS.md` D13, D16, D17: autonomy dial trade-offs and the two-seam
  architecture.
