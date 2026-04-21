# ADR: Defer redirecting `enforce-pr-status-composite.mjs` to `--observe-only`

Status: **Deferred** (awaiting ≥2-consumer bar).
Date: 2026-04-21.
Source plan: `plan-ship-run-pr-landing-mjs-observe-only-obs-cto-actor-20260421035513`.

## Context

Session 2026-04-21 shipped three related layers to force multi-surface PR observation:

- `getPrReviewStatus(pr)` on `PrReviewAdapter` — a composite read covering mergeable + mergeStateStatus + line comments + body-nits + submitted reviews + check-runs + legacy statuses, with a `partial:true` degrade path when any surface fails. Canon: `dev-multi-surface-review-observation`.
- `scripts/pr-status.mjs` — the canonical CLI wrapper. Prints every surface in one shot.
- `.claude/hooks/enforce-pr-status-composite.mjs` — PreToolUse hook that blocks ad-hoc `gh pr view` / `gh api .../pulls/<N>` / commits-status / check-runs queries and redirects the agent to `pr-status.mjs`.

The architectural long-term shape is `arch-pr-state-observation-via-actor-only`: session agents do not poll PR state directly at all; the pr-landing actor is the canonical observer and session agents read its output (atom + PR comment). `pr-status.mjs` is a stepping stone — it wraps the same composite read the actor uses, but invokes it from the session.

PR #58 (this ADR) ships `run-pr-landing.mjs --observe-only`, the actor-native observer: single-shot observe, writes a `pr-observation` atom, posts a PR comment, zero reply/resolve/merge. With it, the final shape is ready: the hook could redirect to `run-pr-landing.mjs --observe-only <N>` instead of `pr-status.mjs <N>`.

## Decision

**Do not redirect the hook in PR #58.** Keep the hook target as `pr-status.mjs` for now. Ship the observe-only subcommand and the atom shape; let the consumer surface develop against them before generalising the redirect.

## Rationale

`dev-substrate-not-prescription` encodes the ≥2-consumer bar for promoting a seam to canonical status. A seam validated by exactly one consumer ossifies around that consumer's needs — the next consumer then has to deform either its own shape or the seam. Wait for a second consumer before committing.

Today's consumers of the composite read:

1. `pr-status.mjs` — directly via the adapter (rehydrated from atom when fresh; API fallback otherwise).
2. `run-pr-landing.mjs --observe-only` — via the adapter, then written to atom.
3. `run-pr-landing.mjs` (full mode) — via the adapter during `observe()`.

All three invoke the adapter from JS; none read the atom. The redirect value is "force the agent through the actor atom trail" — but the atom trail only has one writer so far (the observer itself) and zero non-script readers.

Candidate second consumers that would unlock the redirect:

- **`lag inbox` PR view**: a surface that lists open PRs and their latest observation atom, for the operator's Telegram / terminal. Reads pr-observation atoms; does not poll GitHub.
- **cto-actor research**: the planning loop cites pr-observation atoms by id in its `derived_from` chain when drafting plans that touch open PRs. Reads the atom; never polls.
- **pr-landing full run**: could be refactored to read the most recent pr-observation atom for the PR's head SHA (when one exists and is fresh) instead of re-running observe(). This would actually push the atom trail to three consumers.

When any one of these ships and is exercised in a non-trivial way, the ≥2-consumer bar is satisfied and this ADR graduates. The graduation PR redirects the hook, removes the `API fallback` branch from `pr-status.mjs` (it becomes atom-only, with `run-pr-landing --observe-only` the only path to refresh), and updates this ADR's status to **Accepted**.

## Alternatives considered

1. **Redirect the hook in PR #58.** Rejected per `dev-substrate-not-prescription`: one consumer + one observer = no seam-stress yet. If the atom shape turns out to need a field the second consumer requires, a pre-committed hook locks in the wrong shape.
2. **Ship the atom but not the subcommand (observer-less writer).** Rejected: an atom with no actor writing it has no provenance chain to any actor-authored decision. The observer's role is to own the write.
3. **Ship a thin `--observe-only` that only writes the atom, no PR comment.** Rejected per Gap 1's lesson: the atom dies in an ephemeral filesystem in CI; the PR comment is the synchronous operator-visible channel and must ship alongside the atom.

## Graduation criteria

All must hold:

1. A second consumer reads `pr-observation` atoms (not the adapter or the API) and acts on them.
2. The pr-observation atom shape has not changed in 2 weeks of normal use.
3. The fallback path in `pr-status.mjs` (stale atom → API re-read) has not been hit more than once per week in that window (indicates the observer is running often enough to keep atoms fresh).

When all three hold, open the graduation PR: redirect `enforce-pr-status-composite.mjs` to `run-pr-landing.mjs --observe-only <N>`, remove the API fallback from `pr-status.mjs`, update this ADR's status.

## Canon chain

- `arch-pr-state-observation-via-actor-only` (the long-term shape)
- `dev-multi-surface-review-observation` (the observation discipline)
- `dev-substrate-not-prescription` (the ≥2-consumer bar that defers the redirect)
- `dev-forward-thinking-no-regrets` (atom shape is additive with metadata hatch so future fields land without migration)
- `inv-provenance-every-write` (every atom carries provenance; pr-observation's `derived_from` chains to the prior observation for the same PR so history is traceable)
