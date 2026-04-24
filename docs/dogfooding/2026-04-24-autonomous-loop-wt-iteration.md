# 2026-04-24 - autonomous-loop wt iteration

One Claude Code session, cron-driven via `/loop 5m`, iterated on the `wt` worktree CLI from initial ship to follow-up fix, validated canon discipline under autonomy, and surfaced a reproducible merge-gate gotcha worth atomizing.

## Timeline

- **Start of session:** operator set up a `/loop 5m` recurring prompt ("continue with maximum effort...") while other agents ran in sibling worktrees.
- **T+0:** State check: PR #128 (wt CLI ship) had merged as `81da7ee`; the tool was live on main. Dogfood began.
- **T+0-30m:** Dogfood of `wt list` + `wt rm` + `wt clean --dry-run` against the live repo's 27 worktrees. Surfaced 2 bugs:
  1. `wt clean` missed squash-merged PRs (ancestry-only detection).
  2. `wt rm --delete-branch` hardcoded `feat/<slug>`; failed every `chore/*`, `fix/*`, `code-author/*`, `substrate/*` variant.
- **T+30-80m:** PR #136 opened to fix both. Initial fix had a Windows path-separator bug (CI matrix on both ubuntu and windows passed because no test exercised cmdRm's path-matching code path). Caught by a production smoke test; added `findWorktreeBySlug` pure helper with 9 separator-agnostic tests.
- **T+80-100m:** #136 stuck: CR approved but `CodeRabbit` commit status never posted; `gh-as lag-ceo pr merge --admin` rejected with "Required status check CodeRabbit is expected."
- **T+100m:** Operator hypothesis: "i think the bug is that it's not up to date." Rebased onto latest main, force-pushed. Within seconds CR posted `CodeRabbit: pending` then `success`. Merge went through cleanly as `befd907`.
- **T+100-110m:** Dogfood validation at scale: new `wt clean --dry-run` correctly flagged 22 squash-merged worktrees (vs 2 pre-fix). Batch-removed 22/22 via `wt rm --force --delete-branch`. Cleaned 43 orphan branch refs.

## Bugs surfaced (all fixed in this session)

| # | Bug | PR | Test added |
|---|---|---|---|
| 1 | `wt clean` missed squash-merged PRs (ancestry-only merge detection) | #136 | prStateToStaleSignals (7 tests) |
| 2 | `wt rm --delete-branch` hardcoded `feat/<slug>` branch name | #136 | findWorktreeBySlug (9 tests) |
| 3 | Windows path-separator mismatch in cmdRm's path equality | #136 | covered by findWorktreeBySlug |

## Invariants surfaced (for future autonomous actors)

| # | Invariant | Mechanism | Captured in |
|---|---|---|---|
| 4 | CR withholds `CodeRabbit` commit status when PR branch is BEHIND trunk, even after APPROVED review | `gh pr view` shows `mergeStateStatus=BEHIND`; rebase + force-push triggers CR re-review + status post | memory: `feedback_cr_status_requires_branch_up_to_date.md` |
| 5 | CR status is *slow but eventual* for clean PRs (zero findings on first pass; no CHANGES_REQUESTED → APPROVED cycle) | PR #137 observed: APPROVED @ 08:30:53Z, status SUCCESS @ 08:37:22Z. ~7 min delay. Earlier #136 case sat 20+ min without status - that one was BEHIND, a different root cause. | the clean-PR case self-heals on an eventual-consistency timeline; the BEHIND case does not |
| 6 | `gh-as lag-ceo pr merge --admin` does NOT bypass required checks for the bot | GraphQL rejects with "Required status check X is expected"; admin on human != admin via App | empirical |

## Canon discipline held under autonomy

Every tick respected canon. Notable near-misses that were correctly refused:

- **Never posted a fake `CodeRabbit: success` commit status** from `LAG_OPS_PAT`. Would have unblocked #136 instantly via a one-line curl, but violates `dev-coderabbit-required-status-check-non-negotiable` + `dev-no-hacky-workarounds`. Instead surfaced the block and waited for operator insight (which produced the correct rebase fix).
- **Never removed CodeRabbit from required_status_checks** to unblock. Same reasoning.
- **Never force-pushed a nitpick** to provoke a CR re-review after clean approval. Per `feedback_cr_approval_do_not_push_nitpicks`, that dismisses approval. The operator-directed rebase for BEHIND-state was a different case.
- **Every git/gh action attributed to a bot.** Every push via `scripts/git-as.mjs lag-ceo`. Every PR create/merge via `scripts/gh-as.mjs lag-ceo`. The one bare `git push` in the #128 cycle (force-with-lease after rebase) was flagged as a canon violation in the prior session's handoff notes and not repeated this session.
- **Cleanup always operator-invokable, never auto-scheduled.** `wt rm` + `wt clean --dry-run` surface candidates; operator (or this autonomous loop acting under explicit consent) confirms.

## What the loop got right

- **Per-tick productive output.** Every cron tick produced a concrete artifact: a commit, a test, a memory file, or a validated dogfood cleanup. No idle polling ticks.
- **Surfacing over fixing.** When infrastructure blocked progress (CR status gap, bot admin-bypass denied, Windows EACCES on git worktree remove), the loop surfaced the issue with diagnosis instead of inventing workarounds.
- **Scope honoring.** When PR #137 showed up blocked with the same visible symptom but a different root cause, the loop noted it but did NOT intervene on another actor's PR without explicit consent.
- **Live smoke catching what unit tests missed.** The Windows path-separator bug in the initial cmdRm fix passed ubuntu + windows CI (no test covered the path-equality code path). A manual end-to-end smoke (`wt new foo --from main` with a `chore/*` branch, `wt rm foo --force --delete-branch`, then `git branch --list`) caught it in under a minute. Lesson: integration smokes are load-bearing for any code where the CI matrix happens to miss the code path.

## What the loop could do better

- **Pre-merge integration smoke should be mandatory on wt's CLI paths.** The initial cmdRm fix had 7 tests for its pure helper, but zero tests for the CLI usage of that helper. Add to pre-submit checklist: any CLI command that invokes a pure helper must have at least one end-to-end smoke that exercises the helper's real-world input shape (Windows + POSIX paths here).
- **Detect BEHIND-state pre-merge and rebase automatically.** The loop spent 5+ minutes triaging "why isn't CR posting" before the operator's hypothesis produced the fix. A future `wt auto-rebase-if-behind` or pre-merge-poll step could close that gap.
- **Batch cleanup could be surfaced as a single CLI invocation.** Currently `wt clean` does interactive prompts; bulk non-interactive cleanup required a shell loop calling `wt rm --force` per slug. A `wt clean --yes` flag (equivalent to `--force` for `rm`) would match the ergonomic need discovered this session.

## Open items after this session

- **PR #137 self-resolved on the ~7-min eventual-consistency timer.** Worth a patience budget: clean PRs don't need rebase/intervention, just wait. The BEHIND case is the one that genuinely gets stuck.
- **`wt prune-refs` or equivalent** could close the orphan-branch gap (43 orphan refs this session required a shell loop).
- **`feat/code-author-drafter`** has PR state=none (no PR ever opened). Possibly stale WIP from an earlier session; operator decides.
- **Memory `project_lag_is_governance_substrate.md`** names `@lag/integration/langgraph` as the "CURRENT FOCUS" but all recent PRs (#127-#137) have been autonomous-org + tooling, not LangGraph. Possibly a stale trajectory pointer.

## References

- PR #128 (wt CLI ship): https://github.com/stephengardner/layered-autonomous-governance/pull/128
- PR #136 (dogfood fixes): https://github.com/stephengardner/layered-autonomous-governance/pull/136
- Spec: `docs/superpowers/specs/2026-04-21-worktree-workflow-design.md`
- Plan: `docs/superpowers/plans/2026-04-21-worktree-workflow.md`
- Skill: `.claude/skills/worktree-workflow/SKILL.md`
- New memory: `feedback_cr_status_requires_branch_up_to_date.md`
