# cpo-actor

## Purpose

The product-lens planning Actor: peer to `cto-actor`. Both observe intent and canon, propose plans and canon refinements, and route them for human or auto-approval. The CPO weighs product/operator-experience concerns (surface complexity, onboarding feel, demo readiness, narrative coherence); the CTO weighs architectural and substrate cost. Two lenses on the same `PlanningActor` primitive; the operator arbitrates conflicts via `/decide`.

Like the CTO, the CPO does not mutate tracked files; tracked-file changes go through `code-author`.

## Signed by

Principal: `cpo-actor`. Chain: `apex-agent` -> `claude-agent` -> `cpo-actor`. See `arch-principal-hierarchy-signed-by` for hierarchy semantics; CPO is depth 2, identical to CTO.

## Inbox / Outbox

- Inbox: `intent` atoms from the operator, `audit-finding` atoms, `actor-message` atoms from other Actors flagging product-shape concerns.
- Outbox: `plan` atoms, `canon-proposal` atoms, `actor-message` atoms dispatching work.

Anchored on `arch-actor-message-inbox-primitive`.

## Canon it must obey

- `pol-cpo-*` policy atoms (8 total): scoped tool surface, no tracked-file writes, no merges, no L3 writes, no self-approval.
- `dev-canon-proposals-via-cto-not-direct`: canon edits originate as proposals, not as direct writes.
- `dev-flag-structural-concerns`: halt and surface when verification fails.
- `dev-substrate-not-prescription`: framework primitives stay vendor-neutral; the CPO lens lives in canon (principal goals + judgment prompt), not in `src/`.

## Source

`src/runtime/actors/planning/` on `main` (shared with `cto-actor`). The role-specific shape lives in:

- `scripts/run-cpo-actor.mjs`: runner mirroring `run-cto-actor.mjs`.
- `scripts/bootstrap-cpo-actor-canon.mjs`: principal + 8 policy atoms.
- `.lag/principals/cpo-actor.json`: principal record (materialized by the bootstrap).

## Authority (canon policy atoms)

Set by `scripts/bootstrap-cpo-actor-canon.mjs`. Mirror of `pol-cto-*` with `principal: cpo-actor`:

| Tool                         | Action    | Rationale |
| ---------------------------- | --------- | --------- |
| `plan-propose`               | allow     | primary job |
| `plan-research`              | allow     | read-only synthesis |
| `plan-escalate`              | allow     | surface to operator via Notifier |
| `plan-approve`               | deny      | approval is the operator's |
| `plan-execute-direct`        | escalate  | sub-actor delegation wires the right path; direct execution is a bug |
| `^canon-write-l3.*`          | deny      | L3 promotion requires the human gate (inv-l3-requires-human) |
| `^pr-merge-.*`               | deny      | no auto-merge until medium-tier kill switch ships |
| `*` (catch-all)              | deny      | default-deny scoped to cpo-actor |

To raise the autonomy dial: add a more-specific allow atom with higher priority. Edit canon, not `src/`.

## What ships vs what is deferred

- **Shipped**: Principal bootstrap (chain: `apex-agent` -> `claude-agent` -> `cpo-actor`), 8 policy atoms (`pol-cpo-*`), runner script, skill doc. End-to-end runnable with a stub judgment via `--stub` and with the LLM-backed judgment via the default `HostLlmPlanningJudgment`.
- **Deferred (follow-up)**:
  - `dev-cpo-actor-soul` L3 directive: requires operator `/decide` ratification per `inv-l3-requires-human`.
  - CPO-specific judgment prompt: today the CPO uses the same shared judgment prompt as the CTO via `HostLlmPlanningJudgment` in `src/runtime/actors/planning/host-llm-judgment.ts`. The lens difference shows up through the principal's `goals` + `constraints` prose surfaced into the prompt context. A dedicated `cpo-actor` prompt variant is queued behind the soul-directive ratification.
  - Pairwise CTO-CPO deliberation protocol (`intent-cpo-cto-pairwise-deliberation`).

## Consult before changing behavior

- `docs/actors/cto-actor.md`: peer Actor with shared mechanism.
- `design/actors-and-adapters.md`: Actor + ActorAdapter shape.
- `src/runtime/actors/planning/`: the primitive code (shared with `cto-actor`).
- `scripts/bootstrap-cpo-actor-canon.mjs`: this instance's bootstrap.
