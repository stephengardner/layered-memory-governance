---
name: worktree-workflow
description: Use when starting any parallel unit of work in this repo. Isolates a branch into .worktrees/<slug>/, writes a NOTES.md handoff doc, and leaves the main checkout untouched. Pair with git-spice for stacked work.
---

# Worktree Workflow

## Overview

This skill manages the full lifecycle of isolated branch workspaces in the LAG repo: creation, listing, handoff documentation, and removal. Use it whenever you are starting a discrete unit of work that should not disturb the main checkout or any other live workstream. It enforces naming conventions, guards against touching another agent's active worktree, and coordinates stacked branches through git-spice.

**Announce at start:** "I'm using the worktree-workflow skill to set up an isolated workspace for this parallel work."

## Creating a worktree

```
wt new <slug> [--from main|<parent-slug>]
```

Steps performed in order:

1. **Validate slug** — must be kebab-case, 40 characters or fewer. Exits with a `[wt-new]` error if either check fails.
2. **Fetch origin** — runs `git fetch origin <base>` so ahead/behind counts and SHA references are current.
3. **Scan active worktrees** — checks each existing `.worktrees/*/` for activity (modified files, lock files, recent commits) within the last `WT_ACTIVITY_MIN` minutes (default 10). Prints a warning and prompts for confirmation before proceeding if any worktree appears live.
4. **Create the worktree** — `git worktree add .worktrees/<slug> -b feat/<slug> origin/<base>`. The new branch tracks the base.
5. **Write NOTES.md + verify gitignore** — writes the skeleton described below into `.worktrees/<slug>/NOTES.md`, then runs `git check-ignore -q .worktrees/<slug>/NOTES.md` to confirm it is excluded. If not ignored, exits with a `[wt-new]` error rather than silently risking an accidental commit.
6. **Setup** — auto-detects the package manager and runs the appropriate install:

```bash
if [ -f package.json ]; then npm install; fi
if [ -f Cargo.toml ];   then cargo build; fi
if [ -f pyproject.toml ]; then poetry install; fi
if [ -f go.mod ];       then go mod download; fi
```

## NOTES.md schema

Agent-written. Updated at natural handoff moments: end of a work block, after a commit, when switching threads, when blocked. Not every turn. Not only at the end of a workstream.

```markdown
# <slug>

**Intent** (1 line — what this worktree exists to do)
**Branched off:** main @ <sha>   |   <parent-slug> @ <sha>
**PR:** #<num> (once opened)

## Open threads
- [ ] what's in flight
- [ ] what's blocked on X
- [x] what just landed

## Decisions this worktree
- Chose X over Y because Z

## Next pick-up
1–2 sentences: if a fresh agent opens this worktree tomorrow, what do they do first?
```

## Listing and staleness

```
wt list
```

| Column | Meaning |
|--------|---------|
| slug | Directory name under `.worktrees/` |
| branch | Current branch in that worktree |
| ahead/behind | Commits ahead/behind main |
| PR | open / merged / closed / none |
| NOTES mtime | Last modification time of NOTES.md |
| flags | `dirty` (uncommitted changes), `stale` (inactive beyond threshold) |

Default thresholds: activity window **10 minutes** (`WT_ACTIVITY_MIN`), stale threshold **14 days** (`WT_STALE_DAYS`). Override either via environment variable.

## Removing a worktree

```
wt rm <slug>
```

- If the worktree has uncommitted changes or its branch is not merged into main, `wt rm` prints the status and asks for confirmation.
- `--force` skips confirmation.
- `--delete-branch` also deletes the `feat/<slug>` branch locally and on origin.

Runs `git worktree prune` after removal to clean up stale administrative files.

## Cleanup

```
wt clean [--dry-run]
```

Operator-invoked only. Never scheduled. Identifies stale candidates:

- Branch already merged into main.
- PR in closed or merged state.
- No activity in the worktree for more than `WT_STALE_DAYS` days (default 14).

All prompts default to skip (pressing Enter is safe). `--dry-run` lists candidates without touching anything.

## Stacking

Use stacking only when the child branch genuinely cannot compile or pass its own tests without changes from the parent. Apply this test first:

> Does the child branch's first commit compile and pass its own tests without the parent merged?
> - **Yes** → branch off main.
> - **No** → first ask whether extracting an interface into the parent makes the answer yes. If still no → stack.

```
wt stack <parent-slug> <child-slug>
```

Uses `gs` (git-spice) under the hood to track the stack and rebase when the parent moves. If `gs` is not installed, `wt stack` exits immediately with a `[wt-stack]` error:

```
[wt-stack] git-spice is required for stacked worktrees.
Install: https://github.com/abhinav/git-spice/releases
```

`wt stack` never falls back to raw rebase silently. If `gs` is absent, surface the error and wait for the operator to install it.

## Common mistakes

- **Editing files in another worktree while its agent is live.** The activity scan on `wt new` and `wt list` exists precisely to surface this. Heed the warning; coordinate or wait.
- **Creating a worktree on a branch that already exists.** `wt new` will exit rather than clobber. If you need to resume work on an existing branch, use `git worktree add .worktrees/<slug> <existing-branch>` directly and update NOTES.md by hand.
- **Committing NOTES.md by accident.** The `/NOTES.md` pattern in `.gitignore` prevents this. If you need to transfer NOTES content for handoff, paste it into a PR comment or a canon atom — do not remove the gitignore entry.

## Integration

| Skill | Relationship |
|-------|-------------|
| `superpowers:using-git-worktrees` | This skill is the LAG-specific extension. Use this one inside LAG; the upstream skill works for repos without this workflow. |
| `superpowers:executing-plans` / `superpowers:subagent-driven-development` | REQUIRED — call `wt new` before starting any plan-execution work. |
| `superpowers:finishing-a-development-branch` | REQUIRED — use `wt rm` or `wt clean` after work is complete. |
