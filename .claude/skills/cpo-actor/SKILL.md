---
name: cpo-actor
description: How the cpo-actor planning role is composed and operated. Consult when an operator-experience or product-sense judgment needs the org's accumulated wisdom (canon + prior decisions + relevant atoms) synthesized into a Plan atom for operator approval. Sister role to cto-actor; same primitive, different lens.
---

# The cpo-actor role

The cpo-actor is LAG's CPO-voice. Sister role to cto-actor: same
PlanningActor primitive, same authority shape, different lens.
Where the CTO asks "is this technically sound, does it preserve
substrate discipline, will it survive the 3-month-later review",
the CPO asks "does this read clean to a new operator, does the
on-ramp feel inevitable, does the demo carry weight, is the
narrative coherent end-to-end". Both lenses surface plans the
operator approves; neither lens has merge or self-approve authority.

The lens difference lives in goals/constraints prose and the
judgment-prompt content -- NOT in mechanism-level policy atoms.
That is the substrate point: a CPO and a CTO are different lenses
on the same primitive, not different primitives. Adding a third
lens later (auditor, security-officer, design-lead, etc.) is a
canon edit + skill doc, not a framework release.

## Composition (framework -> instance)

```text
Host (governance)             -- createFileHost(.lag)
  |
  +-- Principal               -- cpo-actor (signed_by claude-agent)
  |
  +-- Policy atoms (L3)       -- pol-cpo-*, enforced by checkToolPolicy
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

- **Local (thinking CPO, default)**: `node scripts/run-cpo-actor.mjs
  --request "<text>"`. Opus-backed classify + draft through
  HostLlmPlanningJudgment. Per-call budget cap $0.50; worst-case
  per-run cost $1.00. Override via `--classify-model`, `--draft-model`,
  `--max-budget-usd`, `--min-confidence`.
- **Local (stub rollback)**: add `--stub` to route through the
  deterministic stub judgment. Use when diagnosing whether a
  regression lives in the actor or in the LLM path.
- **Kill switch**: `touch .lag/STOP`. Actor halts at the top of the
  next iteration. Same sentinel governs every actor in the org;
  one switch halts all.

## Authority (canon policy atoms)

Set by `scripts/bootstrap-cpo-actor-canon.mjs`. Identical shape to
the CTO's authority (the lens difference is in prose, not policy):

| Tool                         | Action    | Rationale |
| ---------------------------- | --------- | --------- |
| `plan-propose`               | allow     | primary job |
| `plan-research`              | allow     | read-only synthesis |
| `plan-escalate`              | allow     | surface to operator via Notifier |
| `plan-approve`               | deny      | approval is the operator's |
| `plan-execute-direct`        | escalate  | sub-actor delegation wires the right path |
| `^canon-write-l3.*`          | deny      | L3 promotion requires the human gate (inv-l3-requires-human) |
| `^pr-merge-.*`               | deny      | no auto-merge until medium-tier kill switch ships (D13) |
| `*` (catch-all)              | deny      | default-deny scoped to cpo-actor |

To raise the autonomy dial: add a more-specific allow atom with
higher priority. Edit canon, not src/.

## When to consult the CPO instead of the CTO

The roles overlap in capability; the lens is what differs. Reach
for the CPO when the question is operator-facing rather than
substrate-facing:

- "Does this onboarding path feel inevitable to a first-time user?"
- "Does the demo flow tell a coherent narrative?"
- "Is the surface complexity justified by the operator value?"
- "Does the README open with the right one-sentence story?"
- "Is the indie-floor experience as polished as the org-ceiling one?"

Reach for the CTO when the question is architecture-facing:

- "Will this pluggability hold at the org-ceiling of 50 actors?"
- "Does this preserve substrate discipline (mechanism in src/,
  instance in canon/skills/examples)?"
- "Will the governance gates survive a future autonomy-dial raise?"
- "Does the atom shape carry the right provenance for arbitration?"

When in doubt, run both -- they will surface different concerns,
and the operator arbitrates. Two complementary lenses are cheaper
than one missed critique.

## What ships vs what is deferred

- **Now**: Principal bootstrap (`bootstrap-cpo-actor-canon.mjs`),
  policy atoms (8 of them, mirror of pol-cto-*), driver script
  (`run-cpo-actor.mjs`), this skill doc. End-to-end runnable with
  Opus or stub judgment.
- **Now (LLM judgment)**: HostLlmPlanningJudgment is the same module
  the CTO uses; the CPO consumes it with a CPO-flavored prompt
  passed at `--request "<text>"` time. A future iteration may add a
  CPO-specific system-prompt template; the substrate seam is
  reserved.
- **Deferred (sub-actor delegation)**: an approved CPO plan invokes
  a downstream actor (DesignActor, OnboardingActor, etc.) with
  budget + audit composition. Without this, an approved plan still
  requires the operator to action it manually. Same gap as the CTO
  side; one fix lands both.

## Consult before changing behavior

- `design/actors-and-adapters.md`: Actor + ActorAdapter shape.
- `DECISIONS.md` D13, D16, D17: autonomy trade-offs and the
  two-seam architecture (these decisions govern both CPO and CTO).
- `src/runtime/actors/planning/`: the primitive code (shared with the CTO).
- `scripts/bootstrap-cpo-actor-canon.mjs`: this instance's bootstrap.
- `.claude/skills/cto-actor/SKILL.md`: the sister role's doc; read
  it alongside this one when designing a third lens.
