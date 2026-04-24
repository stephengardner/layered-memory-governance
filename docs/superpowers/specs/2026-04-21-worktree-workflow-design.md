# Worktree-first parallel workflow  -  design spec

**Status:** draft, pre-review
**Date:** 2026-04-21
**Author:** brainstorming session with operator (stephen@shopsheriff.com)
**Branch:** `feat/worktree-workflow`

## Problem

Parallel agent work in a single checkout collides. Observed pain at time of writing:

- 30+ live feature branches, many with overlapping variants (`kill-switch-*` × 5, `code-author-*` × 5, a `code-author-drafter` → `code-author-drafter-v2` rename suggesting a collision).
- Sibling worktrees at `../memory-governance-apps` and `../memory-governance-substrate` already in use as an ad-hoc isolation pattern, but without a standard layout, NOTES, or cleanup verb.
- Documented convention at `apps/console/CLAUDE.md:43` that says "never start a second instance from a different worktree"  -  confirming the pain is real and known.
- Mid-conversation evidence of two agents in the repo (this session in main + another live on `substrate/1a-core-with-shims` mid-rename). The act of writing this spec required worktree isolation to avoid stepping on the other agent.

## Goals

1. One worktree per parallel unit of work, branched off `main`.
2. A written handoff doc (`NOTES.md`) that travels with each worktree, agent-written at natural handoff moments, never committed.
3. A thin CLI (`scripts/wt.mjs`) that creates, lists, and cleans worktrees with safe defaults.
4. A governance rule (L3 canon) that makes this the org-wide default, not just a local convention.
5. Portable by construction: the CLI + skill should be extractable into a standalone package without rewrites.
6. Stacking permitted for genuinely-dependent work  -  orthogonal to worktrees, not a replacement for branch-off-main.

## Non-goals (explicit)

- **No Stop-hook that auto-updates NOTES.md.** Update cadence is agent-judgment; a hook risks noise and stale-writes.
- **No scheduled/auto cleanup.** Kill-switch-first: cleanup is operator-invoked via `wt clean`.
- **No multi-repo orchestration** (`sessions/<name>/<repo>/` nesting). LAG is a monorepo; the extra directory level buys nothing today. If a second repo ever joins, revisit.
- **No NOTES.md compression/summarization.** V1 is prose the operator and next agent read.
- **No migration of existing sibling worktrees** (`../memory-governance-apps`, `../memory-governance-substrate`) until their current agents explicitly hand off. Migration ships as a separate small PR.

## Design

### 1. Layout

```
<repo-root>/
├── .worktrees/                       # gitignored
│   ├── <slug-a>/                     # linked worktree, branch feat/<slug-a>
│   │   ├── NOTES.md                  # agent-written, gitignored
│   │   └── <branch contents>
│   └── <slug-b>/
├── .gitignore                        # adds /.worktrees/ and /NOTES.md
├── scripts/wt.mjs                    # the CLI
└── .claude/skills/worktree-workflow/
    └── SKILL.md                      # repo-local skill, Tier-2-portable
```

- **Slug** = kebab-case, ≤40 chars, matches the branch name's last segment. `feat/kill-switch-cli-forwarding` → `.worktrees/kill-switch-cli-forwarding/`.
- **`.worktrees/`** is gitignored at repo root (added in `feat/worktree-workflow`, the first worktree this convention creates).
- **`/NOTES.md`** is gitignored so a repo-root or worktree-root NOTES file never lands in a commit on any branch. (Per-worktree `.git/worktrees/<name>/info/exclude` was considered and rejected: git resolves `info/exclude` to the common dir, not the per-worktree admin dir.)

### 2. NOTES.md  -  the handoff doc

**Agent-written.** Updated at natural handoff moments: end of a work block, after a commit, when switching threads, when blocked. Not every turn (noise). Not only at session end (late). Operator can request an update explicitly at any time.

**Schema:**

```markdown
# <slug>

**Intent** (1 line, set at creation, rarely edited)
**Branched off:** main @ <sha>   |   <parent-slug> @ <sha>
**PR:** #<num> (once opened)

## Open threads
- [ ] what's in flight
- [ ] what's blocked on X
- [x] what just landed

## Decisions this worktree
- Chose X over Y because Z

## Next pick-up
1-2 sentences: if a fresh agent opens this worktree tomorrow, what do they do first?
```

**Lifecycle:** dies with the worktree. NOTES.md is the handoff doc for *this* parallel unit of work; permanent record goes in PR bodies, canon atoms, or `docs/`. If the operator wants to preserve something from NOTES.md, atomize it before `wt clean`.

### 3. `scripts/wt.mjs`  -  the CLI

One file, Node (matches existing `scripts/*.mjs` convention), thin over `git worktree`, `gh`, and `git-spice`. References to `wt <cmd>` below describe the CLI surface; the discovery mechanism (npm script vs `bin`/PATH) is Open Question #3 and resolves at plan time  -  it does not change the surface.

| Command | Behavior |
|---|---|
| `wt new <slug> [--from main\|<parent-slug>]` | Fetch `origin/main`; create branch off base; `git worktree add .worktrees/<slug> -b feat/<slug>`; write NOTES.md skeleton; verify no other worktree has the same branch or an uncommitted rename in flight (collision warning); auto-detect package manager + run setup (`npm install`, `cargo build`, etc.); verify baseline tests pass (or report + ask). |
| `wt list` | Table: slug · branch · ahead/behind main · PR state (open/merged/none) · NOTES mtime · dirty? · stale? |
| `wt rm <slug>` | Confirm if branch unmerged or tree dirty; `git worktree remove`; optionally `git branch -D`. |
| `wt clean [--dry-run]` | List worktrees where branch is merged to main (local merge-base; falls back to `gh pr view` if available); prompt per item; default answer is skip. Never acts without confirmation. |
| `wt stack <parent-slug> <child-slug>` | Same as `new --from <parent-slug>`, but delegates to `gs branch create` under the hood so `gs restack` works on parent updates. |
| `wt note [<slug>]` | Opens NOTES.md for current or named worktree in `$EDITOR`. |

**Parallel-agent collision detection** (added to the design during this conversation after observing the live substrate agent):

`wt new` and `wt list` must scan every existing worktree for: (a) uncommitted changes, (b) HEAD moved or index touched within the last 10 minutes (default; configurable via `--activity-window`), (c) lockfiles in the worktree's `.git/`. If any worktree shows activity, warn before creating a new one on the same branch or at the same slug. This is the mechanical version of the discipline the operator had to enforce by hand when we discovered the substrate agent mid-rename.

**Stale-candidate thresholds** (used by `wt list` and `wt clean`): no commits for ≥14 days, NOTES.md untouched for ≥14 days, branch merged to main, or PR closed. Thresholds are defaults; both are configurable via the CLI and via env (`WT_STALE_DAYS`, `WT_ACTIVITY_MIN`).

### 4. Cleanup = operator-invoked only

- `wt list` surfaces stale candidates (no commits in ≥N days, NOTES.md untouched for ≥N days, branch merged, PR closed).
- `wt clean` prompts per item. Default is skip; pressing enter is always safe.
- Never a scheduled job. Never a Stop-hook auto-deleter. This matches the `design-the-kill-switch-before-the-dial` and `governance-before-autonomy` canon.

### 5. Stacking

**Codified test** (lives in the skill):
> Does the child branch's first commit compile and pass its own tests without the parent merged? If **yes** → branch off main. If **no** → first ask whether extracting an interface into the parent makes the answer yes; if still no → stack.

**Tool:** `git-spice` (`gs`). Open-source, Go-built, no SaaS dependency. Install docs linked from the skill. **If `gs` is not installed, `wt stack` exits with a recognizable `[wt-stack]` error naming the install instructions; it never falls back to raw `git rebase --onto` silently.** The operator installs `gs` or accepts the error  -  no hidden path.

**Layout:** still one worktree per branch in a stack. `.worktrees/parent/` and `.worktrees/child/` are peers on disk; the dependency is in git topology, handled by `gs restack`. Stacking and worktree-isolation compose; neither replaces the other.

### 6. Canon + skill + memory updates

- **New L3 canon atom** (summary; the canonical body shipped by `scripts/bootstrap-workflow-canon.mjs` is longer and authoritative):
  > *Parallel workstreams must use isolated `.worktrees/<slug>/` branched off main; one worktree per branch. Stacking is permitted for genuinely-dependent work (codified in the skill); cleanup is operator-invoked via `wt clean` (no scheduled job); mechanics live in the skill, not canon.*
- **Revise memory** `feedback_branch_off_main_not_stacks.md` to reflect nuance: default branch-off-main, stack deliberately per the codified test.
- **New skill** at `.claude/skills/worktree-workflow/SKILL.md`  -  describes CLI, NOTES schema, stacking test, cleanup policy. Any agent entering this repo inherits it.
- **Update** `apps/console/CLAUDE.md:43`  -  drop the sibling-dir instruction once the sibling worktrees are migrated. Until then leave a transitional note.
- **Update** main `CLAUDE.md`  -  drop any sibling-dir convention; point at the new skill.

### 7. Portability (Tier 2)

The CLI and skill are built as if extractable into `@<ns>/worktree-cli` later. Concretely:

1. `scripts/wt.mjs` has **zero imports from `src/`**, zero references to `.lag/`, canon, atoms, principals. Enforced by `test/scripts/wt.portability.test.ts`.
2. Project setup auto-detects: `package.json` → npm, `Cargo.toml` → cargo, `pyproject.toml` → poetry, `go.mod` → go, else skip. Same pattern as the official superpowers `using-git-worktrees` skill.
3. PR-merge check in `wt clean` degrades gracefully if `gh` is missing; local merge-base is the universal default, `gh` is a strict upgrade layered on top.
4. NOTES.md schema is generic: no atom IDs, no canon pointers, no principal references. It's prose for whoever reads it.

Tier 3 (contribute upstream to the `superpowers` plugin as a richer `using-git-worktrees`) is a ~1-day follow-up and explicitly out of scope for this spec.

### 8. Migration plan (deferred)

- **Existing siblings** (`../memory-governance-apps`, `../memory-governance-substrate`) → `git worktree move` into `.worktrees/apps/` and `.worktrees/substrate/`. Ships as a **separate, one-page PR** after both agents currently using those worktrees hand off. Ports, configs, and branch identity are preserved by the move.
- **30+ stale branches** → one pass with `wt list --stale` + `wt clean` once the CLI exists. Expect to delete 15-20 (merged, abandoned, or superseded variants).
- **`backup/*` branches** → CLI leaves `backup/` alone by default; operator prunes manually.

### 9. Testing

- Unit tests for `wt.mjs` (vitest): command parsing, dry-run output, error paths.
- Integration test on a throwaway git repo: `wt new foo --from main && wt list && wt rm foo` round-trip.
- Static test: `wt.mjs` imports nothing from `src/` or `.lag/` (portability guard).
- CI gate: skill file exists at `.claude/skills/worktree-workflow/SKILL.md` and is referenced from main `CLAUDE.md`.

## Open questions

1. **Slug inference.** Does `wt new` accept a free-text intent and LLM-infer the slug, or does the operator always pass an explicit slug? Current design: explicit slug only (deterministic, no hidden LLM cost). Revisit if friction is real.
2. **NOTES.md stop-hook.** A lightweight hook that *warns* (never acts) when NOTES is ≥2h stale could live behind an opt-in setting. Phase 2 if cadence proves insufficient.
3. **Workspace-level `wt` command discovery.** Should `wt` be an npm script (`npm run wt`), a `bin` entry in package.json, or a standalone `npx wt`? Current design: npm script; revisit at implementation time.

## Prior art / references

- Official `superpowers:using-git-worktrees` skill (`.worktrees/<branch>/`, no NOTES).
- Another repo the operator cited (`sessions/<name>/` with worktrees + NOTES.md)  -  community convention.
- Graphite / git-spice for stacked-PR tooling; Anthropic's internal practice (stacks + worktrees + review discipline) publicly discussed.
- LAG canon (prefixed IDs as shipped; match `scripts/bootstrap-workflow-canon.mjs` `derived_from`): `dev-canon-is-strategic-not-tactical`, `inv-governance-before-autonomy`, `inv-kill-switch-first`, `dev-indie-floor-org-ceiling`, `dev-forward-thinking-no-regrets`.
