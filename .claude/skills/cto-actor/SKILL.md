---
name: cto-actor
description: How the cto-actor planning role is composed and operated. Consult when a non-trivial architectural or strategic decision needs the org's accumulated wisdom (canon + prior decisions + relevant atoms) synthesized into a Plan atom for operator approval.
---

# The cto-actor role

The cto-actor is LAG's CTO-voice. It does not invent opinions; its
judgment comes from the atom set -- canon directives, prior
decisions, relevant atoms, active principals. Every plan it
proposes cites the atoms it derived from. The operator is the only
authority that can approve a plan; the cto-actor proposes and
surfaces.

## Composition (framework -> instance)

```text
Host (governance)             -- createFileHost(.lag)
  |
  +-- Principal               -- cto-actor (signed_by claude-agent)
  |
  +-- Policy atoms (L3)       -- pol-cto-*, enforced by checkToolPolicy
  |
  +-- Auditor                 -- host.auditor (every phase recorded)

Actor (mechanism)             -- PlanningActor (src/runtime/actors/planning)
  |
  +-- PlanningContext         -- directives + decisions + relevantAtoms
  |                             + openPlans + relevantPrincipals
  |
  +-- PlanningJudgment        -- HostLlmPlanningJudgment (Opus default
  |                             for classify AND draft; stub opt-in
  |                             via --stub rollback flag). Two judge
  |                             calls per run, both schema-validated
  |                             via zod, both audited with prompt and
  |                             schema fingerprints.
  |
  +-- runActor driver         -- kill-switch + budget + convergence +
                                 per-action checkToolPolicy gate

Output atoms                  -- type='plan', layer='L1',
                                 plan_state='proposed', provenance
                                 chaining to cited canon atoms

HIL surface                   -- host.notifier.telegraph(event)
                                 operator approves via lag-respond
                                 or Telegram callback
```

## Run paths

- **Local (thinking CTO, default)**: `node scripts/run-cto-actor.mjs
  --request "<text>"`. Opus-backed classify + draft through
  HostLlmPlanningJudgment. Per-call budget cap $0.50; worst-case
  per-run cost $1.00. Override via `--classify-model`, `--draft-model`,
  `--max-budget-usd`, `--min-confidence`.
- **Local (stub rollback)**: add `--stub` to route through the
  deterministic stub judgment. Use when diagnosing whether a
  regression lives in the actor or in the LLM path.
- **Kill switch**: `touch .lag/STOP`. Actor halts at the top of the
  next iteration.

## Authority (canon policy atoms)

Set by `scripts/bootstrap-cto-actor-canon.mjs`. Current shape:

| Tool                         | Action    | Rationale |
| ---------------------------- | --------- | --------- |
| `plan-propose`               | allow     | primary job |
| `plan-research`              | allow     | read-only synthesis |
| `plan-escalate`              | allow     | surface to operator via Notifier |
| `plan-approve`               | deny      | approval is the operator's |
| `plan-execute-direct`        | escalate  | 55c wires proper sub-actor delegation |
| `^canon-write-l3.*`          | deny      | L3 promotion requires the human gate (inv-l3-requires-human) |
| `^pr-merge-.*`               | deny      | no auto-merge until medium-tier kill switch ships (D13) |
| `*` (catch-all)              | deny      | default-deny scoped to cto-actor |

To raise the autonomy dial: add a more-specific allow atom with
higher priority. Edit canon, not src/.

## What ships vs what is deferred

- **55b**: Principal bootstrap, policy atoms, driver script, skill
  doc. End-to-end runnable with a stub judgment.
- **55b+ (LLM judgment, shipped)**: HostLlmPlanningJudgment with
  PLAN_CLASSIFY + PLAN_DRAFT schemas, provenance guard that rewrites
  uncited plans into missing-context escalations at the judgment
  boundary, LLM-failure surfaced as missing-judgment plans (never
  silent fallback). Default Opus for both calls. See
  `design/phase-55b-llm-judgment.md`.
- **55c (deferred)**: sub-actor delegation. An approved plan invokes
  PrLandingActor / DeployActor / etc. with budget + audit composition.
  Without this, an approved plan still requires the operator to
  action it manually.
- **Auditor role (deferred, first CTO task)**: a code-quality
  auditor principal running on the same PlanningActor primitive with
  its own policy atoms. First real use of the thinking CTO: operator
  asks the CTO to design the auditor; CTO proposes a plan; operator
  approves; we implement from the approved plan. Dogfood loop.

## Consult before changing behavior

- `design/actors-and-adapters.md`: Actor + ActorAdapter shape.
- `DECISIONS.md` D13, D16, D17: autonomy trade-offs and the
  two-seam architecture.
- `src/runtime/actors/planning/`: the primitive code.
- `scripts/bootstrap-cto-actor-canon.mjs`: our instance bootstrap.
