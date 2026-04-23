# Autonomous-org walkthrough: Question → Plan → PR

This is a concrete walkthrough of what happens when you hand LAG a question and let the virtual org deliberate. It reflects the state of main at commit 63c6c40 (2026-04-23). The walkthrough is grounded in a real run: the `scripts/git-as.mjs` push-auth fix shipped as PR #124. The **CTO deliberation half** of that run was autonomous (CTO produced a Plan atom at confidence 0.88 with 11 canon citations); the **CodeAuthor drafting half was operator-executed**, because the standalone `CodeAuthorActor` that `scripts/run-code-author.mjs` invokes is currently a skeleton. See "Implementation status" below.

The goal of this doc is not to argue the architecture; `docs/framework.md` and `design/target-architecture.md` cover that. It is to show the seams a new reader needs to locate before running their first autonomous deliberation. For the operational retro that motivated this walkthrough (including why CodeAuthor did not produce a diff on the real run), see [`docs/dogfooding/2026-04-23-virtual-org-phase-3-git-as-push-auth.md`](dogfooding/2026-04-23-virtual-org-phase-3-git-as-push-auth.md).

## Implementation status

Not every arrow in the diagram below is fully wired. Reading the walkthrough without this context will make more of the loop sound automated than it is today. Concretely at commit 63c6c40:

| Surface | Status |
|---|---|
| `PlanningActor` under `cto-actor` | **Wired.** Runs LLM judgment (Opus), produces Plan atoms with canon citations + `metadata.question_prompt`. Exercised by `scripts/run-cto-actor.mjs`. |
| `askQuestion` + Question atom provenance | **Wired.** `run-cto-actor.mjs --request` seeds the Question atom before planning (PR #125). |
| `draftCodeChange` diff primitive | **Wired** as a library function (`src/runtime/actors/code-author/drafter.ts`). Produces unified diffs against APPEND/MODIFY/CREATE plans, with `question_prompt` as a ground-truth override. |
| `CodeAuthorActor` (standalone loop) | **Skeleton.** `src/runtime/actors/code-author/code-author.ts` line 17: `propose() returns no actions (no plan pickup yet)`. `scripts/run-code-author.mjs` validates the fence and halts; it does not pick plans off an inbox, call the drafter, or open PRs. |
| `createAppBackedGhClient` + per-role App identity | **Wired.** Used by the agent-sdk executor and pr-landing; the primitive is ready even though CodeAuthorActor does not yet invoke it itself. |
| `PrLandingActor` | **Wired.** Observes PR state, merges when checks + CodeRabbit approval + required status all land. |
| Delegation envelope + auto-approve + dispatch | **Manual.** `run-cto-actor.mjs` drops the Plan at `proposed` with no `metadata.delegation`. The `runAutoApprovePass` + `runDispatchTick` primitives exist; wiring them behind a single command is a follow-up. |
| Plan-state writeback on merge | **Not wired.** PrLanding observes merges but nothing updates the originating Plan to `succeeded`. |

## Actor topology

Three Actors, each under its own Principal. Every one of them is governed by the same substrate (atoms, provenance, arbitration, canon, kill-switch):

| Principal | Actor | Scope |
|---|---|---|
| `cto-actor` | `PlanningActor` + LLM judgment | Read canon + relevant atoms, classify the request, draft a Plan atom with citations |
| `code-author` | `CodeAuthorActor` | Consumes an approved Plan atom with a delegation envelope, drafts a diff, opens a PR via the `code-author` GitHub App |
| `lag-pr-landing` | `PrLandingActor` | Observes PR review state, merges when checks + CR approval + required status all land |

All three are provisioned per-actor GitHub Apps via `lag-actors sync` (see `docs/bot-identities.md`). Pushes go through `scripts/git-as.mjs` (installation-token URL-auth for receive-pack), GitHub API calls go through `scripts/gh-as.mjs` (installation-token Bearer for REST/GraphQL).

## The Atom shapes you will see

```
question  ─derived_from→  plan  ─metadata.delegation→  code-author-inbox-message
                                 metadata.question_id      ↓
                                 metadata.question_prompt  ↓
                                                           drafter-input
                                                           ↓
                                                           pr-observation
                                                           ↓
                                                           pr-landing-observation
```

- **Question atom** (`type: 'question'`, `question_state: 'pending'`): the operator's verbatim request. Seeded by `askQuestion(host, { content, asker, ... })`. See `src/runtime/questions/index.ts`.
- **Plan atom** (`type: 'plan'`, `plan_state: 'proposed'`): the CTO's deliberated response, citing canon directives by id, listing rejected alternatives, and committing to a state-machine lifecycle (`proposed → approved → executing → succeeded | failed | abandoned`). `metadata.question_id` + `metadata.question_prompt` propagate via the PlanningActor `originatingQuestion` seam (landed in PR #125).
- **Delegation envelope** on `metadata.delegation`: names the target sub-actor (`code-author`), carries a correlation id, optional escalation target. Added by the runner; see `scripts/run-cto-self-audit-continue.mjs` for the canonical shape.
- **Inbox message** (`type: 'actor-message'`): plan-dispatch writes this to the target actor's inbox after plan approval.
- **PR observation atoms**: shipped by `PrLandingActor` for each state transition (review requested, review received, merged, closed).

## The deliberation run (canonical shape)

```bash
# 1. Bootstrap canon (once per environment) -- seeds L3 directives,
#    decisions, policies the CTO will cite.
node scripts/bootstrap.mjs

# 2. Seed Question + run CTO deliberation. Produces a Plan atom at
#    plan_state='proposed', metadata.question_id + question_prompt
#    propagated.
node scripts/run-cto-actor.mjs --request "Fix scripts/git-as.mjs: push hangs on Windows because the Bearer header is 401'd..."
# [cto-actor] seeded question atom q-9a1f...-2026-04-23T14-19-28
# [cto-actor] LLM (thinking) run as cto-actor
# [cto-actor] --- REPORT ---
# { haltReason: 'converged', iterations: 1, ... }
```

After the run you have a Plan atom under `.lag/atoms/plan-*.json` with:

```jsonc
{
  "type": "plan",
  "plan_state": "proposed",
  "confidence": 0.88,
  "provenance": { "derived_from": ["dev-gh-actions-require-bot-attribution", ...] },
  "metadata": {
    "planning_actor_version": "0.1.0",
    "title": "Fix scripts/git-as.mjs push auth: x-access-token URL Basic auth...",
    "principles_applied": ["dev-gh-actions-require-bot-attribution", ...],
    "alternatives_rejected": ["persistently rewrite origin URL", ...],
    "what_breaks_if_revisit": "Still sound in 3 months: ...",
    "question_id": "q-9a1f...-2026-04-23T14-19-28",
    "question_prompt": "Fix scripts/git-as.mjs: push hangs on Windows because..."
  }
}
```

## Why the Plan sits at `proposed` for `code-author`

This is deliberate, not a gap. Canon atom `pol-plan-auto-approve-low-stakes` has `allowed_sub_actors: ['auditor-actor']` and explicitly excludes state-mutating actors:

> *Never auto-approve a sub-actor that mutates state beyond atom writes; use the manual plan-approval path for those.*

CodeAuthor mutates external state (opens PRs, pushes commits). Per canon `dev-l3-promotion-requires-human-approval` and `governance-before-autonomy`, the `proposed → approved` transition is an operator gate.

The operator advances the plan either through `lag-respond` (interactive) or by editing the allowlist via `/decide` to widen auto-approval (rare, requires operator intent).

## Advancing the Plan: proposed → approved → executing → succeeded

```bash
# 3. Attach a delegation envelope to the Plan (targets code-author's
#    inbox, carries a correlation id so the reply threads back).
#    Canonical shape in scripts/run-cto-self-audit-continue.mjs.

# 4. Operator approves via lag-respond:
lag-respond --root-dir .lag
# -> disposition: approve

# 5. Dispatch tick writes the plan to code-author's inbox:
node -e "/* runDispatchTick(host, subActorRegistry) */"

# 6. CodeAuthor picks up the inbox message, drafts a PR.
#    IMPORTANT: at commit 63c6c40 this step is not fully automated.
#    `scripts/run-code-author.mjs` currently validates the code-author
#    fence and halts (see "Implementation status" above). The drafter
#    primitive (`draftCodeChange` in src/runtime/actors/code-author/
#    drafter.ts) exists and is exercised by the agent-sdk executor
#    path, but the standalone CodeAuthorActor loop that this script
#    drives is a skeleton. Closing that wiring is a tracked follow-up.
#    For now, the operator executes the plan's concrete steps and
#    opens the PR via scripts/git-as.mjs + gh-as.mjs; the Plan atom
#    stays at plan_state='proposed' as provenance.
node scripts/run-code-author.mjs --max-iterations 1 --deadline-ms 1800000  # fence validation only today

# 7. PrLandingActor observes the PR, merges when checks + CR approve.
node scripts/run-pr-landing.mjs
```

Each step is deterministic. Each atom carries provenance. `.lag/atoms/` lets you reconstruct the full chain after the fact.

## What's automated today, what isn't

**Automated today (wired end-to-end):**
- Question atom seeded automatically by `run-cto-actor.mjs --request` (PR #125).
- CTO deliberation: Plan atom produced with canon citations + `metadata.question_prompt` via the `originatingQuestion` seam (PR #121 + #125). Exercised by `scripts/run-cto-actor.mjs` against a live LLM.
- PR push uses installation-token URL-auth, no hang on Cursor-managed Windows hosts (PR #124).
- Stale-base recovery: `scripts/update-branch-if-stale.mjs <pr>` keeps queued PRs fresh (PR #123).
- Pre-push lint mirrors CI, ~1s catch for patterns CR would otherwise flag (PR #122).
- PrLandingActor merges when checks + CR APPROVED + required status all post.
- Drafter primitive (`draftCodeChange`) and `createAppBackedGhClient` are ready library surfaces; they just aren't called from the standalone `CodeAuthorActor` loop yet.

**Skeleton / manual (instance-level gaps):**
- **CodeAuthorActor loop.** `scripts/run-code-author.mjs → CodeAuthorActor` is the fence-validation skeleton described in "Implementation status". No plan pickup, no drafter invocation, no PR creation from this path. Operator runs the plan's steps until the loop is wired.
- **Delegation envelope injection.** `run-cto-actor` drops the Plan at `proposed` with no `metadata.delegation`; a follow-up will chain envelope + auto-approve + dispatch into one command.
- **`proposed → approved` for state-mutating sub-actors (code-author).** Operator approval via `lag-respond` is required by `pol-plan-auto-approve-low-stakes` ("Never auto-approve a sub-actor that mutates state beyond atom writes"). Governance gate, not a bug.
- **Plan-state writeback on PR merge.** `PrLandingActor` observes the merge but does not update the originating Plan atom's `plan_state` to `succeeded`. The state machine (`src/runtime/plans/state.ts`) and `executePlan()` seam exist; code-author does not currently route through `executePlan()`.

## Debugging checklist when a Plan sits stuck

1. **Plan in `proposed`, no delegation envelope**: expected; operator must approve, or the runner must inject delegation + call `runAutoApprovePass`. Check `metadata.delegation` on the Plan atom.
2. **Plan in `approved`, no inbox message**: `runDispatchTick` not running. Check the SubActorRegistry knows about the target.
3. **Inbox message present, CodeAuthor converged empty**: drafter didn't see a literal payload. Check `metadata.question_prompt` on the Plan (PR #125 closed this gap for CTO-produced plans).
4. **PR open but blocked**: check `gh pr view <n> --json statusCheckRollup` for missing `CodeRabbit` legacy status. `@coderabbitai review` nudges, or a new real-diff push forces CR to re-post.
5. **PR merged but Plan atom still in `executing` / `proposed`**: the writeback gap noted above. Manual fix: update the atom's `plan_state` via `host.atoms.update(planId, { plan_state: 'succeeded' })`.

## Governance posture, in one paragraph

The virtual org is autonomous for **deliberation**, gated for **external state mutation**. The Question → Plan half runs without operator touch, grounded in L3 canon and producing a citation-rich plan atom. The Plan → PR half requires operator approval for code-author-class actors, per the auto-approve policy that ships with the substrate. The machinery to loosen that gate exists (widen `allowed_sub_actors`, raise the autonomy dial), but that's a conscious move by the operator, not a default. "Governance before autonomy" is the canon directive; this topology encodes it.

## Next-step follow-ups (tracked, not shipped)

- **Chain-closure runner**: a script that takes `--request`, runs CTO, injects delegation, runs `runAutoApprovePass` (for actors on the allowlist) OR escalates for operator approval, runs `runDispatchTick`, runs `run-code-author` on the queued message, returns with the draft PR URL.
- **Plan state writeback on PR merge**: wire `PrLandingActor`'s merge-observation to locate the originating Plan (via the code-author inbox message's `correlation_id`) and `host.atoms.update(planId, { plan_state: 'succeeded' })`.
- **Widen autonomy for specific low-risk plans**: canon atoms that narrow the auto-approve scope to particular plan-title patterns (e.g., doc-only changes) so repeated low-blast-radius loops can close without operator touch.

None of these change the substrate. They are instance-level instrumentation over seams that already exist.
