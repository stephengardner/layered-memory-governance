# Phase 3 retro: virtual org informs a real infrastructure fix

**Date:** 2026-04-23
**PR:** feat/git-as-push-url-auth
**Driving atom:** `plan-fix-scripts-git-as-mjs-push-auth-x-acces-cto-actor-20260423143434`

## The bug

`scripts/git-as.mjs` was the single documented entry point for every bot-attributed git action. It authenticated pushes via `http.extraHeader: Authorization: Bearer <installation-token>`. GitHub's git smart-HTTP receive-pack endpoint rejects Bearer with `HTTP/2 401, www-authenticate: Basic realm="GitHub"`. Git then fell back to the system askpass helper; on Cursor-managed Windows hosts that shim stalls ~30s with no TTY signalling. Every bot-authored PR push hung before completing.

Captured live on 2026-04-23 via `GIT_TRACE=1 GIT_CURL_VERBOSE=0 node scripts/git-as.mjs lag-ceo push origin feat/pre-push-lint`. The 401 arrived at line 30 of the trace; everything after was Cursor's askpass.sh spinning.

## Loop state during PRs #122 and #123

The bug actively blocked autonomous landings. The workaround was a local-only script (`scripts/git-push-as-url-auth.mjs`) that embedded `x-access-token` as Basic auth in the push URL. That workaround landed the push every time, but it was two entry points for a contract that's supposed to have one, precisely the anti-pattern `dev-gh-actions-require-bot-attribution` prohibits. Keeping it would guarantee that a future agent under context pressure picks the wrong one.

## What the virtual org did

1. **CTO deliberation** (PlanningActor under `cto-actor` principal, LLM-backed, `claude-opus-4-7`, 15-minute run). Input: the bug symptom, reproduction trace, acceptance criteria, known-workaround reference. Output: `plan-fix-scripts-git-as-mjs-push-auth-x-acces-cto-actor-20260423143434` at confidence 0.88.
2. **Plan content** cited 11 canon directives by id (the strategic ones: `dev-gh-actions-require-bot-attribution`, `dev-right-over-easy-for-external-actions`, `dev-no-hacks-without-approval`, `dev-canon-is-strategic-not-tactical`, `dev-extreme-rigor-and-research`, `pol-code-author-signed-pr-only`, `arch-bot-identity-per-actor`, `dev-coderabbit-required-status-check-non-negotiable`, `inv-provenance-every-write`, `dev-no-operator-real-name-on-automation-artifacts`, `dev-forward-thinking-no-regrets`). Produced 8 concrete steps, 5 acceptance-criteria test shapes, explicit rejection of 3 alternatives, a 3-month-later-review clause. It read as a plan a senior engineer would have written.
3. **CodeAuthor execution did NOT produce a diff.** `runActor` halted `converged after 1 iteration(s)` with no audit-emitted proposal or apply-outcome. This matches the pattern the `project_virtual_org_deliberation_loses_literals` memory documented: the code-author loop's drafter requires `question_prompt` metadata on the Plan atom (PR #121 shipped that seam), but my invocation went `--request <text>` → CTO → Plan, which doesn't seed a Question atom in the pipeline. The Plan had no `question_prompt` to read.
4. **Operator implemented the Plan directly.** Every step from the Plan became code in this PR. The Plan is the driving artifact; the human hands are the executor.

## Autonomous-loop gap surfaced (not fixed here)

The current autonomous path is:
  `Question → CTO → Plan → CodeAuthor → PR`
but only works end-to-end when Question is seeded first and the Plan atom inherits `question_prompt` from it. A direct CTO invocation with `--request` skips the Question atom, so CodeAuthor observes a Plan without the metadata it needs and no-ops.

This is a real gap worth a separate follow-up. Two roads:
- Change `run-cto-actor.mjs --request` to synthesize a Question atom and chain it.
- Change the drafter to fall back to reading the Plan's body (not just `question_prompt`) when the metadata key is absent.

The first is structural and cleaner; the second is a resilience dial. Don't ship both; pick one in a follow-up PR.

## What landed in this PR

- `scripts/git-as.mjs` branches by git subcommand. `push` → resolve origin, construct `https://x-access-token:<token>@github.com/<owner>/<repo>.git`, spawn `git push <transient-url> <refspec>` directly. No persistent remote rewrite. Everything else → existing Bearer extraHeader path.
- `scripts/lib/git-as-push-auth.mjs` holds the pure helpers (`findRemoteArg`, `parseGithubHttps`, `buildTransientPushUrl`, `buildPushSpawnArgs`, `buildReadOnlyEnv`, `buildPushEnv`, `isPushCommand`). Shebang-free so vitest's Windows transformer can import it directly (pattern from PR #123).
- 42 unit tests across the helpers. Key assertions:
  - push spawns a git argv containing `x-access-token:<token>@github.com/...`.
  - push env does NOT carry `http.extraHeader: Authorization: Bearer`.
  - read-only verbs DO carry the Bearer extraHeader unchanged.
  - `credential.helper=''` and `GIT_TERMINAL_PROMPT=0` on both paths.
  - SSH remotes, enterprise hosts, bare `git push`, non-GitHub URLs all fall through to Bearer.
  - The push env never carries the token in any key or value (token is argv-only on the push path, per GitHub's documented x-access-token contract).
- `scripts/git-push-as-url-auth.mjs` (the local workaround) deleted from my main checkout; it never reached main.

## Token exposure: explicit trade-off

The push path's transient URL carries the token on argv during the git spawn. It IS visible in `ps`/`/proc/<pid>/cmdline` for same-user processes during the seconds the push runs. The `docs/dev/` comment and JSDoc in the wrapper both describe this. Rejected alternatives:

- **Persistently rewrite origin, push, restore.** Wider on-disk exposure window, breaks `git remote -v` during the push, needs a restore dance on every error path.
- **credential.\<url\>.helper with an inline shell-returning-username script.** Argv-free but an order of magnitude more subprocess machinery for the same protocol git supports directly.

The argv-visibility trade is the narrowest shape that matches GitHub's documented installation-token flow.

## Signals

- Plan atom archived, confidence 0.88, citations trace back to canon.
- 42 unit tests, every acceptance criterion from the Plan locked to a regression test.
- Pre-push lint clean.
- Manual verification: before this PR, `git-as.mjs push` hung; after this PR, the push completes without invoking askpass.
- The Plan is the load-bearing artifact in this retro, not a post-hoc summary.

## Next phase (explicit TODO)

Close the CodeAuthor drafter gap so the Plan → PR step is autonomous, not operator-executed. Either seed-Question on `--request` in `run-cto-actor`, or fall-back-to-plan-body in the drafter. Single-PR follow-up, not in scope here.
