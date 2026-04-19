---
name: pr-landing-agent
description: How the autonomous pr-landing actor is composed and operated in this repo. Consult when a PR needs review-feedback addressed, when adjusting the autonomy policies, or when extending the agent's authority.
---

# The pr-landing autonomous role

This repo is the first LAG-governed organization and the pr-landing
agent is our first outward-acting Actor. It reads review comments on
open PRs (CodeRabbit and human reviewers alike) and takes actions
within delegated authority: replies to nits and resolves their
threads, acknowledges suggestions, escalates architectural feedback.
It never merges.

## Composition (framework -> instance)

```
Host (governance)        --  createFileHost(.lag)
  |
  +-- Principal          --  pr-landing-agent (signed_by claude-agent)
  |
  +-- Policy atoms (L3)  --  pol-pr-landing-* in .lag/atoms
  |
  +-- Auditor            --  host.auditor (every iteration recorded)

Actor (mechanism)        --  PrLandingActor (src/actors/pr-landing)
  |
  +-- runActor driver    --  src/actors/run-actor.ts
                               kill-switch + budget + convergence guard
                               + per-action checkToolPolicy gate

ActorAdapter (D17 seam)  --  GitHubPrReviewAdapter (src/actors/pr-review)
                               over GhClient (src/external/github)
```

## Run paths

- **Ambient (GitHub Actions)**: `.github/workflows/pr-landing.yml`
  fires on `pull_request`, `pull_request_review`, and
  `pull_request_review_comment` events; also on `workflow_dispatch`
  for manual runs.
- **Local**: `node scripts/run-pr-landing.mjs --pr <n>` (add `--live`
  to enable writes; default is dry-run).
- **Kill switch**: `touch .lag/STOP`. Actor halts at the top of the
  next iteration.

## Autonomy dial (canon policy atoms)

Set by `scripts/bootstrap-pr-landing-canon.mjs`. Current shape:

| Tool                         | Action    | Rationale |
| ---------------------------- | --------- | --------- |
| `pr-reply-nit`               | allow     | low blast radius |
| `pr-resolve-nit`             | allow     | symmetric with reply-nit |
| `pr-reply-suggestion`        | allow     | best-effort ack |
| `pr-reply-architectural`     | escalate  | operator judges |
| `pr-ensure-review`           | allow     | prompts a reviewer bot when it has not engaged (e.g., posts `@coderabbitai review`). Idempotent: skipped when bot has already posted on this PR. |
| `^pr-merge-.*`               | deny      | no auto-merge (D13) |
| `*` (catch-all)              | deny      | default-deny scoped to this principal |

To raise the autonomy dial: add a more-specific allow policy atom
with higher priority. Do NOT edit src/ to change behavior; edit canon.

## What to consult before changing behavior

- `design/actors-and-adapters.md` for the Actor + ActorAdapter shape.
- `DECISIONS.md` D13 (TG-as-operator trade-off), D16 (two agent
  classes), D17 (ActorAdapter as second seam / D1 narrowed).
- `src/policy/index.ts` for how checkToolPolicy scores matches.
- `.lag/atoms/` (via `node scripts/inspect-atoms.mjs` if it exists,
  or a grep over the file adapter store) to see current L3 policies.

## Live rollout discipline

1. Ship in dry-run. Watch at least three PR events through it.
2. Confirm audit log contains the expected phases per iteration
   (iteration-start, observation, classification, proposal,
   policy-decision per action, apply-outcome, reflection, halt).
3. Flip `PR_LANDING_LIVE=true` repo variable to enable writes.
4. First live run should be against a low-stakes PR (docs, config).
5. If anything feels wrong: `touch .lag/STOP` and investigate
   before re-enabling.
