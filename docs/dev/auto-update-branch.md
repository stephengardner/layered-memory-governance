# update-branch-if-stale

`scripts/update-branch-if-stale.mjs` detects a PR whose head is behind
its base branch and merges base into head via a GitHub App, so
CodeRabbit re-reviews and the merge gate re-evaluates.

## Why this script exists

An autonomous org opens multiple PRs off `main`. One lands; `main`
advances. The others still reference the old base. GitHub's
`mergeStateStatus` flips to `BEHIND`. CodeRabbit's re-review logic
does not fire on base-advances alone; the merge gate keeps the PR
stuck. Historically an operator clicked "Update branch" in the UI,
which is not a bot-safe path. This script is the bot-safe equivalent: one
REST call (`POST /repos/.../pulls/<n>/update-branch`) via
`scripts/gh-as.mjs <role>`, so the merge commit attributes to the
App, not the operator.

## Run it

```bash
# Default actor is lag-ceo.
node scripts/update-branch-if-stale.mjs 122

# Or attribute the merge to another provisioned App.
node scripts/update-branch-if-stale.mjs 122 --actor=lag-pr-landing
```

Stdout is a JSON report. The payload is intentionally machine-readable
so shell pipelines or other scripts can chain without reparsing log
prose.

**Always present:**

| Field | Type | Notes |
|-------|------|-------|
| `pr` | number | PR number passed on argv |
| `url` | string | GitHub URL from `gh pr view` |
| `actor` | string | The role whose App will (or would) perform the update; defaults to `lag-ceo` |
| `mergeStateStatus` | string | Raw value from `gh pr view --json mergeStateStatus` |
| `headRefOid` | string | Current head commit SHA |
| `baseRefName` | string | Base branch name |
| `action` | string | `noop`, `update`, or `unknown` |
| `reason` | string | Human-readable rationale for the action |

**Update path extras (only present when `action === "update"`):**

| Field | Type | Notes |
|-------|------|-------|
| `requestAccepted` | boolean (`true`) | Emitted when the update-branch POST returned success |
| `error` | string | Emitted when the update-branch POST failed; carries the first ~400 chars of the error output |

Exactly one of `requestAccepted` or `error` appears on an `update`
run. `noop` and `unknown` runs never carry either.

## Exit codes

| Exit | Meaning |
|------|---------|
| `0` | No-op (already fresh / out of scope state) or update request accepted |
| `1` | PR is `BEHIND` and the update-branch API call failed (read stderr) |
| `2` | Unknown state, invalid args, or `gh pr view` failed |

## Decision table

The classifier (`decideAction`) maps GitHub's
[`mergeStateStatus`](https://docs.github.com/en/graphql/reference/enums#mergestatestatus)
to an action. Tests in `test/scripts/update-branch-if-stale.test.ts`
cover every branch.

| State | Action | Notes |
|-------|--------|-------|
| `BEHIND` | `update` | Head is behind base; this is the script's job. |
| `CLEAN` | `noop` | Already up to date with base. |
| `HAS_HOOKS` | `noop` | Ready to merge; post-merge hooks are not our problem. |
| `BLOCKED` | `noop` | Required checks not satisfied; separate concern. |
| `DIRTY` | `noop` | Merge conflicts; needs human. |
| `DRAFT` | `noop` | Drafts are intentionally not merged. |
| `UNSTABLE` | `noop` | Failing checks; separate concern. |
| `UNKNOWN` | `noop` | GitHub still computing; caller should retry. |
| _other_ | `unknown` (exit 2) | Fail-closed; never silently assume a new enum value is safe. |

## Composition

The script is one layer of mechanism. Compose it:

- `scripts/babysit-prs.mjs` (or your equivalent) can call this for
  every open PR as part of an idle-tick routine.
- A pr-landing actor can call this in its `observe()` loop before
  escalating to the operator.
- A GitHub workflow triggered on `pull_request_target` can call it
  after `main` advances, keeping open PRs fresh.

Each consumer chooses the frequency and error-handling that suits
it; this script does not own those policies.

## Manual integration check

Unit tests cover the pure classifier. A full integration (actual
REST call against a real PR) is a manual check on a low-risk PR:

```bash
node scripts/update-branch-if-stale.mjs <your-pr> --actor=lag-ceo
# Expected: JSON report with action=update, requestAccepted=true
# Then: GitHub UI shows a new merge commit within ~5s, headRefOid
# changes on re-poll.
```

Run this against a disposable PR on a fork before relying on it in
autonomous loops.
