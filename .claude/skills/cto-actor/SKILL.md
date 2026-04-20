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

Actor (mechanism)             -- PlanningActor (src/actors/planning)
  |
  +-- PlanningContext         -- directives + decisions + relevantAtoms
  |                             + openPlans + relevantPrincipals
  |
  +-- PlanningJudgment        -- classify + draft (stub in 55b;
  |                             LLM-backed in follow-up phase)
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

- **Local**: `node scripts/run-cto-actor.mjs --request "<text>"`.
  Uses the stub judgment (55b). Replace with the LLM-backed
  judgment when that ships.
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

## What 55b ships vs what's deferred

- **55b (this phase)**: Principal bootstrap, policy atoms, driver
  script, skill doc. End-to-end runnable with a stub judgment.
- **LLM judgment** (follow-up): real PlanningJudgment backed by
  Host.llm with versioned prompt templates, proper classification
  across all 6 kinds, plan drafting that cites atom contents
  (not just ids).
- **55c**: sub-actor delegation. An approved plan can invoke
  PrLandingActor / DeployActor / etc. with budget + audit
  composition.

## Consult before changing behavior

- `design/actors-and-adapters.md`: Actor + ActorAdapter shape.
- `DECISIONS.md` D13, D16, D17: autonomy trade-offs and the
  two-seam architecture.
- `src/actors/planning/`: the primitive code.
- `scripts/bootstrap-cto-actor-canon.mjs`: our instance bootstrap.
