# Production Readiness Audit -- 2026-04-26

Author: lag-ceo (audit run via cto-actor-shaped review).
Scope: a full-substrate readiness pass before LAG goes from "internal dogfood" to "first external operator." The framework has matured rapidly across PRs #156-#188; this is the first end-to-end pre-enterprise audit.

## Executive Summary

LAG's substrate is in better shape than the size of the codebase suggests. The 8-interface Host contract is mechanism-only and well-documented, the runActor driver checks the kill-switch at every loop boundary AND between every action, the policy primitive defaults to fail-closed escalate, the file adapter writes atomically (write-temp + rename), and the agentic-actor-loop trilogy (substrate + executor + adapter) is shipping real PRs end-to-end (PR #186 landed via the autonomous chain on 2026-04-26 at 07:59:49Z). 2,164 unit tests pass with zero failures, and overall coverage is 80.77% lines / 79.62% branches / 86.25% functions.

The substrate gaps are concentrated in three places: (1) the file AtomStore.put() has a TOCTOU window between read-then-write that the atomic-rename does not fully close; (2) the agent-loop adapter contract leaves commitSha verification "future hardening" (an attacker-controlled adapter could fabricate a SHA and PR creation would proceed); and (3) several src/ modules (provisioning at 1-30% coverage, src/cli at 11.74%, daemon/invoke-claude.ts at 15.32%) are below the production bar. The Console is read-mostly by design, but currently exposes two mutation paths (`/api/kill-switch.transition` and `/api/atom.propose`); the kill-switch transition is correctly enforced server-side and the atom.propose path is the one flagged by Finding 4 below as a contract violation worth closing. The dogfood loop is sound when the worktree is clean; the PR #186 chain captured 5 atom hops with intact provenance.

The work to ship to a first external operator is bounded: address the AtomStore put race, the commit-SHA verification gap, and bring the bottom 8 files above 60% coverage. Most other gaps are quality-of-life, not safety.

## Top-5 Critical Findings

### 1. CRITICAL: AtomStore.put() has a TOCTOU race that lets two concurrent writers both report success

Where: `src/adapters/file/atom-store.ts:49-57`.

```ts
async put(atom: Atom): Promise<AtomId> {
  const path = this.pathFor(atom.id);
  const existing = await readJsonOrNull<Atom>(path);
  if (existing) {
    throw new ConflictError(`Atom ${String(atom.id)} already exists`);
  }
  await writeJson(path, atom);   // atomicWriteFile: write tmp, then rename
  return atom.id;
}
```

Two `put` calls with the same id can both observe `existing === null`, both write to distinct tmp files, and both rename onto the target path. The rename is atomic so one wins, but the loser's caller still receives `atom.id` as if it succeeded; the atom that ended up on disk is whichever rename completed second. At 50 concurrent actors writing, this is no longer a theoretical concern, especially because content-derived hashes are exactly what cause two actors to write the same id.

Why it matters: the AtomStore is the single source of truth (per `arch-atomstore-source-of-truth`). A silent loser of a race produces an audit-grade illusion: the caller logs success, the atom on disk is from a different writer, and downstream chains that derive_from the lost atom point at content the actor never wrote.

Fix shape: write with `flag: 'wx'` on the atomic-write path so EEXIST surfaces; OR rename onto a content-keyed temp first and verify byte-for-byte before claiming success; OR require the caller to redo the readJsonOrNull check after rename and surface a divergence as ConflictError.

Severity: CRITICAL because the failure mode is silent and the substrate's correctness invariant assumes loud loss-of-race.

### 2. MAJOR: Adapter-supplied commitSha is trusted without on-disk verification

Where: `src/runtime/actor-message/agentic-code-author-executor.ts:173-180` and `src/substrate/agent-loop.ts:30-35` (threat model JSDoc).

The substrate's threat model JSDoc explicitly calls this out: "An adapter could in principle return a stale or fabricated SHA. Consumers MUST verify the commit exists in the workspace before trusting it" -- but the executor reads `agentResult.artifacts.commitSha` and proceeds directly to `createPrViaGhClient` without doing that check. A misbehaving or compromised AgentLoopAdapter (or a buggy one with a stale state file) can return any string; the PR opens, the chain looks healthy.

Why it matters: PR creation is the one place where atoms generated inside an isolated workspace become tracked artifacts. Trusting an unverified SHA breaks the lineage invariant the operator relies on when reading provenance.

Fix shape: in `agentic-code-author-executor.ts` after the kind === 'completed' check, run `git -C <workspace> cat-file -e <commitSha>` (or equivalent via the workspace primitive) and refuse with `agentic/sha-verification-failed` if absent. Add a regression test under `test/runtime/actor-message/agentic-code-author-executor.test.ts` with a stub adapter that returns a fake SHA.

Severity: MAJOR because the gap is documented but not closed; an external operator wiring a third-party adapter is exactly when this matters.

### 3. MAJOR: Several substrate modules are below the 60% coverage floor

Where: per `npx vitest run --coverage`:

- `src/actors/provisioning/provisioner.ts` 1.12% lines, `risk-assessor.ts` 30%, `role-loader.ts` 8%, `slack-server.ts` 2.41%, `credentials-store.ts` 4.68%, `manifest-url.ts` 4.76%
- `src/cli/respond.ts`, `compromise.ts`, `run-loop.ts` 0% (cited as 0.00 in the coverage report)
- `src/daemon/invoke-claude.ts` 15.32%, `src/daemon/cli-renderer/claude-streaming.ts` 41.39%
- `src/integrations/agent-sdk/app-client.ts` 14.75%, `jsonl-mirror.ts` 1.41%

Why it matters: these are not all unused. provisioning is the operator-facing onboarding path; cli is the entire interactive surface. The directives canon already reads "no hacky workarounds without explicit operator approval" -- shipping production-grade governance on top of a 1.12%-covered provisioner is a worse violation than any review nit. invoke-claude.ts at 15.32% is the path the daemon takes to spawn claude CLI; the untested 124-248 line range is exactly where mid-stream timeouts, malformed JSON, and signal handling live.

Fix shape: triage each into "feature ships only after coverage > 60%" vs "deprecated, mark for removal." Provisioning + cli/respond+run-loop are load-bearing; invoke-claude.ts is shadowed by `examples/agent-loops/claude-code/` (PR #168) and may already be a removal candidate.

Severity: MAJOR because coverage gaps in the autonomous path are the failure mode that produces silent breakage at 50-actor scale.

### 4. MAJOR: The Console exposes the operator's full atom history but the JSDoc-stated mutation surface is one writeable endpoint

Where: `apps/console/server/index.ts:1495-1517` (`/api/kill-switch.transition`) and `apps/console/server/index.ts:683-735` (`/api/atom.propose`).

The CLAUDE.md for the Console says "read-only in v1; writes go through existing LAG CLIs" -- but the server actually has two write paths today: kill-switch transition and atom.propose. Both are correctly origin-gated via `isAllowedOrigin` and the kill-switch endpoint refuses any tier above soft (medium/hard CLI-only). atom.propose writes to `.lag/atoms/` with `flag: 'wx'` so the EEXIST race is loud (the only place the file adapter does this, by the way -- see Finding #1).

Why it matters: not a vulnerability, but a discoverability problem. An operator reading the README + the Console's own CLAUDE.md will not expect a UI button to mint an L0 atom; the `prop-` prefix is good but the surface needs to be either (a) explicitly removed in v1 and the proposer flow routed through `lag-decide`, or (b) explicitly documented as v1.5 with a CR-equivalent code-review path before write. Right now it sits in between, which is the ambiguity dial #4 the canon names.

Severity: MAJOR for posture, MINOR for actual security.

Fix shape: align the v1 contract (README + Console CLAUDE.md) with the surface that actually ships -- either remove `/api/atom.propose` or keep it and document the trust model.

**Status: RESOLVED via PR fix/atom-propose-readonly (branch).** The route at `/api/atoms.propose` (the actual path; the audit cited `/api/atom.propose` but the code uses the plural form) is now disabled by default and only enabled when `LAG_CONSOLE_ALLOW_WRITES=1` is set in the server environment. When unset, the handler returns 403 with `code: 'console-read-only'` and a body pointing the caller at `node scripts/decide.mjs`. The kill-switch transition stays as the canon-required exception and is now explicitly documented in `apps/console/CLAUDE.md` as the only enabled-by-default write path. Regression test in `apps/console/server/security.test.ts` (`isConsoleWritesAllowed`) covers the gate's strict-equality semantics. Two related write-shaped routes (`/api/atoms.reinforce`, `/api/atoms.mark-stale`) are surfaced in the updated CLAUDE.md as operator-tracked debt for a follow-up that brings them under the same gate.

### 5. MINOR (with footprint): Framework-code-mechanism-only is mostly enforced, with two real cases of vendor-specific logic in src/

Where:

- `src/external/github/gh-client.ts` and `src/external/github-app/` are GitHub-specific transport. The JSDoc honestly labels these "framework-agnostic transport," and they ARE used by the (correctly-placed) examples-pattern actors in `src/runtime/actors/pr-landing/`, `pr-review/`, `pr-fix/`, but their existence under `src/` rather than `examples/` makes them framework-blessed defaults for one vendor.
- `src/runtime/actors/pr-landing/pr-landing.ts:1-9` honestly calls itself "a reference outward Actor that ... is NOT the framework: any consumer can write their own outward actor." That phrasing is correct and the JSDoc is exemplary, but the file lives at `src/runtime/actors/` rather than `examples/`, which says the opposite about its role.

Why it matters: the canon directive `dev-framework-code-mechanism-only` (in `CLAUDE.md`) names "framework code under src/ must stay mechanism-focused and pluggable." Vendor-specific GitHub transport is at the boundary; a fresh adapter for GitLab or Forgejo will need to either reach into the same pattern or duplicate the substrate plumbing.

Fix shape: a follow-up sprint moves `src/external/github*` to `adapters/github/` (or `examples/external/github/`) and the four reference actors move to `examples/actors/` with clear barrel exports from `src/actors/index.ts` for back-compat. Alternative: add a `src/external/README.md` that explicitly grants vendor-specific exception status to GitHub-as-transport because it's the only review/PR system the substrate currently composes with, and forbids further vendor packages without the same explicit grant.

Severity: MINOR for the substrate today; MAJOR if a second vendor (GitLab) is wired without first relocating these.

## Detailed Findings by Category

### 1. Substrate completeness

The 8 Host sub-interfaces (AtomStore, CanonStore, LLM, Notifier, Scheduler, Auditor, PrincipalStore, Clock) are declared in `src/substrate/interface.ts:40-298` and the composed `Host` type at line 370. Every one is mechanism-only: AtomStore declares `put/get/query/search/update/batchUpdate/embed/similarity/contentHash` plus the optional `subscribe/capabilities` push-wake; CanonStore declares `read/propose/commit/revert/history`; LLM declares only `judge<T>` (one sandboxed primitive); Notifier declares `telegraph/disposition/awaitDisposition/respond`; Scheduler exposes `recurring/defer/cancel/killswitchCheck`; Auditor declares `log/query/metric`; PrincipalStore declares `get/put/permits/markCompromised/listActive`; Clock declares `now/monotonic`. There's an Embedder type at line 324 that stays out of the Host bundle (it composes inside AtomStore.search) -- correct shape. The optional `TransactionalCapable` at line 356 is honest about being optional and the Host type at line 379 makes the optionality explicit.

Findings:

- All 8 sub-interfaces are present and have JSDoc that describes the contract from the consumer's perspective, not the adapter's.
- The reference adapters all exist: `src/adapters/file/` covers all 8, `src/adapters/memory/` covers all 8, `src/adapters/notifier/` adds Telegram, `src/adapters/claude-cli/` adds an LLM. `examples/redactors/regex-default/`, `examples/blob-stores/file/`, `examples/workspace-providers/git-worktree/`, `examples/agent-loops/claude-code/` and `examples/agent-loops/resume-author/` all exist.
- Compatibility shims: `src/policy/index.ts:1-6`, `src/actors/actor.ts:1-5`, `src/runtime/actors/pr-landing/pr-landing.ts:1-9` and many others are 1-5-line `export *` shims declaring the substrate/runtime/adapters/integrations layer split. Honest, but the 0% coverage on these is a v8-coverage artifact, not a real gap.
- One genuine framework-code-mechanism-only delta: `src/external/github*` ships vendor-specific transport under src/ rather than examples/ (Top-5 finding #5).
- The optional capability dial (`AtomStoreCapabilities.hasSubscribe`) is correctly opt-in and adapters that don't subscribe ship zero extra code.

### 2. Failure modes

Walking through the five scenarios the audit asked about:

**Claude Code CLI times out mid-stream.** The agent-loop adapter at `examples/agent-loops/claude-code/loop.ts` consumes NDJSON from `claude -p --output-format stream-json --verbose`. The `defaultClassifyFailure` at `src/substrate/agent-loop.ts:182-206` maps AbortError to `catastrophic` (do not retry, halt the chain) and ECONN*/EBUSY/EAGAIN/ETIMEDOUT/ENOTFOUND to `transient` (retry-eligible). Rate-limited HTTP shapes (429/502/503/504) are also `transient`. The bias is correct: unknown errors are `structural` so they escalate to operator rather than retry blindly. The agentic executor at `src/runtime/actor-message/agentic-code-author-executor.ts:293-344` then maps each `FailureKind` to a stage string the dashboard reads. Graceful path; no crash.

**Atom-store hits a write conflict.** As described in Finding #1, the file adapter's `put()` does a read-then-write with no ordering guarantee, so a same-id race produces a silent loser. An update conflict (different id collision) is impossible because ids are unique. The memory adapter has the same shape but in-process so it's safe.

**Dispatcher's bot token is revoked mid-flight.** `scripts/git-as.mjs:170-230` mints fresh installation tokens via `app-auth.ts`, scopes per-role, and explicitly avoids persisting the token URL into `.git/config` (the post-PR-#169 fix). If the token is revoked between mint and push, the push 401s, git-as exits non-zero, the agentic-executor's `try/catch` around `createPrViaGhClient` returns `{ kind: 'error', stage: 'agentic/pr-creation' }`, and the workspace `release()` runs in finally. No leak, no zombie process.

**Two actors race on the same plan_state transition.** Approved -> executing flips happen via `plan-dispatch.ts` (98.36% covered) and the atom store's `update()` reads-then-patches. Same TOCTOU concern as `put` (Finding #1). At write-time scope, the arbitration stack is supposed to detect this -- but arbitration runs after the write, not before, so two near-simultaneous transitions from `approved -> executing` AND `approved -> failed` can both land. The safer story is content-derived id + atom-version checks (CAS); the looser story is "rare, tolerated" but the canon directive `dec-arbitrate-at-write-time` says the cost of real-time detection IS accepted.

**Disk fills up during a session-tree write.** `atomicWriteFile` at `src/adapters/file/util.ts:21-32` writes-to-tmp then renames; ENOSPC during writeFile throws and the catch deletes the tmp. The caller (`atom.put`) propagates the throw. The runActor driver at `src/runtime/actors/run-actor.ts:163-167` catches the throw, halts with `haltReason = 'error'`, and writes a kill-switch-tripped audit (lines 370-396 are the kill-switch path; the error path bypasses that and writes only the audit `kind: 'halt'` event). At 50-actor scale, the redactor-failure -> catastrophic path correctly applies, but a partial atom write (tmp left behind because the catch failed too) is the corner case. Spot-checked; the rm in catch is `force: true` so it survives a tmp-already-gone case.

Other failure modes worth naming:

- `code-author-invoker.ts` correctly marks "atom-update semantics + crash-recovery tests out of scope" as a known limitation (line 22 area). A crash after PR creation but before the observation atom write produces a PR with no in-substrate trace. Acceptable for v0; surface in the README.
- The kill-switch primitive at `src/substrate/kill-switch/index.ts` is exemplary: filesystem watch + setInterval poll fallback (because some FS drop watch events silently), three trip paths (sentinel, parent-signal, already-present), strict input validation on the sentinel filename to prevent path traversal (lines 128-138), and `unref()` on the poll timer so the interval doesn't keep the process alive.

### 3. Operator visibility

The Console (`apps/console/`) is the operator-visibility surface. Findings from `apps/console/server/index.ts` (1,774 lines):

What's visible:

- `canon.list` / `canon.stats` -- live L3 atoms, type breakdown.
- `principals.list` -- all principals with hierarchy, taint state.
- `activities.list` -- recent atoms across types (observations, plans, questions, actor-messages).
- `kill-switch.state` -- tier + autonomyDial + since/reason.
- `arbitration.compare` -- two-atom rank + breakdown for debugging.
- Filewatcher-driven SSE for live updates (described in lines 84-110 with the in-memory atom index as projection).
- The kill-switch transition endpoint correctly enforces UI->soft only (lines 650-680).
- Atom proposal endpoint uses `flag: 'wx'` for fail-loud, nonce-suffixed ids (lines 700-735).

What's invisible today:

- Live actor state per running actor (which iteration, which classify-key, which proposed action). The audit log captures this but the Console doesn't surface a per-actor dashboard.
- Per-PR pipeline state (approved -> executing -> dispatched -> CR-pending -> merged). PR-observation atoms exist (`pr-observation-*`) but the Console doesn't render them as a flow diagram.
- Per-bot-identity health: when did each bot last successfully push? Token expiry? The credentials-store is at 4.68% coverage and surfaces zero state.
- Live dispatch-result feed: `dispatch_result` is on the plan atom's metadata but isn't surfaced separately.
- Kill-switch coverage map: which actors have subscribed to the signal vs not? The substrate doesn't track this; runActor uses the predicate-OR-signal disjunction, but a malicious adapter that ignores both is invisible.

Fix shape: a `/api/actors.live` endpoint that watches recent `actor.iteration-start` audit events and groups by actor/principal/correlation_id; a `/api/dispatch.feed` that pages `dispatch_result` JSON off plan atoms with state transitions.

### 4. Security posture

**Default-deny on policy.** `src/substrate/policy/index.ts:80-186` (`checkToolPolicy`) defaults `fallbackDecision` to `'escalate'` -- fail-closed when no policy atom matches. The runActor driver explicitly opts INTO permissive `'allow'` because runActor is a generic loop primitive used by zero-config callers (line 256-261 of `run-actor.ts`). The substrate primitive is correct; the runActor convenience is documented but is a relevant footnote: any caller running in production should not rely on the default and should provision a policy. Specificity scoring: exact 4 / regex 2 / wildcard 1, summed over tool/origin/principal -- highest wins, ties broken by `metadata.policy.priority` then `created_at` desc. Regex safety has a `MAX_REGEX_SPEC_LENGTH = 200`, a "starts with ^" requirement, and rejection of three classical catastrophic-backtracking shapes -- code at lines 270-283. Solid.

**Per-principal tool access.** `loadLlmToolPolicy` (in `src/llm-tool-policy.ts`) reads canon atoms keyed on principal id; `scripts/run-cto-actor.mjs:279-289` shows the "no policy atom for this principal yet -> adapter default deny-all" behavior. Honest and audit-friendly: the runner logs which posture it picked.

**Token leakage.** `scripts/git-as.mjs` is the load-bearing surface. The `-u`-leak-into-`.git/config` bug fixed in PR #169 is now defended by `extractSetUpstreamPlan` (lines 196-216) and a post-push remote-name-only upstream-set step (lines 251-280). The Bearer-vs-URL-auth split (lines 187-230) is documented inline. Concerns:

- The credentials-store at `src/actors/provisioning/credentials-store.ts` is at 4.68% coverage; the actual read/write paths are untested. Operators self-host their .lag/apps/ tokens; an unprivileged-process read of those JSON files exposes installation tokens. The redactor at `examples/redactors/regex-default/patterns.ts:39-45` covers `ghs_`/`ghp_`/`gho_` but only for redaction in atom content, not for filesystem access control.
- `apps/console/server/index.ts` has `process.env['LAG_CONSOLE_LAG_DIR']` (line 43-46); a console operator with shell access on the server can point this at any user's `.lag/` and get full-substrate read access. Acceptable for a single-user console; not for a deployed multi-tenant one.
- The bot-identity wrappers (`gh-as.mjs`, `git-as.mjs`) explicitly avoid bare `gh pr create` / `git push` (foundational memory rule). The repo is under that posture today.

**Path traversal on Console.** `apps/console/server/security.ts:71-77` (`atomFilenameFromId`) enforces `^[A-Za-z0-9][A-Za-z0-9._-]*$` and throws `invalid-atom-id` -- correct, deliberately stricter than "reject `..` and `/`" because of encoding tricks. Test file at `apps/console/server/security.test.ts` should be checked for null-byte and URL-encoded slash cases (not read in this audit -- flag for verification). The kill-switch sentinel-filename validation in `src/substrate/kill-switch/index.ts:128-138` rejects `.`, `..`, slashes, and drive prefixes -- exemplary.

**Kill-switch coverage.** `src/runtime/actors/run-actor.ts:135-148` checks the kill-switch at the top of every iteration. Lines 232-250 check it AGAIN before each `apply()` call inside one iteration's proposed-actions loop, and the `detectKillSwitchTrip` helper (lines 451-465) consults the AbortSignal first (richer signal wins attribution) then the predicate. Adapters subscribing to `ctx.abortSignal` get the AbortError mid-call. `LoopRunner.tick()` at `src/runtime/loop/runner.ts:138-156` halts the entire tick when `host.scheduler.killswitchCheck()` is true. Confidence: high. The one gap is that an adapter that ignores both the predicate and the signal cannot be detected from runActor's vantage point; the substrate's redactor-on-write fence is the deeper guarantee.

### 5. Dogfood loop integrity

Walked through the most recent successful chain: PR #186, "Prepend single validation-date note to docs/getting-started.md."

Atoms in the chain:

1. `intent-3cee6c40a0ad-2026-04-26T07-36-13-492Z` -- `type: operator-intent`, `principal_id: apex-agent`, `provenance.kind: operator-seeded`, `metadata.trust_envelope` declares `max_blast_radius: docs`, `allowed_sub_actors: [code-author]`, `require_ci_green: true`, `require_cr_approve: true`, `require_auditor_observation: true`. Created 2026-04-26T07:36:13.492Z.
2. `q-fcd9d96cad2dbb1c-2026-04-26T07-36-23-047Z` -- `type: question`, derived_from intent. Created 2026-04-26T07:36:23.047Z (10s after intent).
3. `plan-prepend-single-validation-date-note-to-d-cto-actor-20260426073746` -- `type: plan`, `principal_id: cto-actor`, derived_from carries 14 entries (intent + 13 canon citations), `confidence: 0.92`, `plan_state: succeeded` (final). `metadata.delegation.sub_actor_principal_id: code-author`, `metadata.question_id: q-fcd9...`. Created 2026-04-26T07:37:46.503Z (1m23s after question), approved 2026-04-26T07:40:59.206Z (3m13s later, via `pol-plan-autonomous-intent-approve`), dispatched 2026-04-26T07:41:21.612Z (22s after approval) as PR #186 commit `88e5468`.
4. `code-author-invoked-plan-prepend-...-2026-04-26T07-40-59.510Z-6c120e` -- `type: code-author-invoked` observation, principal `code-author`, citing the plan in derived_from. Created 2026-04-26T07:40:59.510Z (304ms after plan approval).
5. `pr-observation-<owner>-layered-autonomous-governance-186-88e54682fc07` -- `type: pr-observation`, principal `pr-landing` (or auditor; not read in detail), citing PR #186 + commit. The `merged_pr` field on the plan atom resolves to `{ owner, repo, number: 186 }`, and `plan_state_changed_at: 2026-04-26T07:59:49.252Z` records the succeeded transition.
6. `plan-merge-settled-4ef0815e4f6c244f` -- `type: plan-merge-settled`, the reconcile output that flipped plan_state to succeeded.

Chain integrity: every atom's derived_from points to a real, on-disk atom. Provenance is intact across 6 hops. Total wall-clock: 23m36s from intent-creation to plan-state-succeeded -- including a CR review pass, CI run, and merge.

Chain breaks observed: NONE on this successful run. Two cosmetic concerns:

- The plan atom's `derived_from` array contains the intent id twice (lines 13 + 32 of the plan atom JSON; same atom id, two array positions). De-dupe-on-write is missing.
- `plan_state_reconcile_mode: 'first'` is documented but not surfaced in the Console.

### 6. Indie-floor experience: brand-new developer cloning the repo

What the README says: `npm install && npm run build && node examples/quickstart.mjs` (per `docs/getting-started.md:8-12`).

What `node scripts/run-cto-actor.mjs --request "..."` actually requires:

1. `npm install` -- node 22+, ~few-hundred packages, 1-2 minutes.
2. `npm run build` -- TypeScript compile of src/ to dist/. Required because the script `import`s from `../dist/...` (line 31-40 of run-cto-actor.mjs). Not noted in the script's --help output.
3. A bootstrap pass: `scripts/bootstrap-cto-actor-canon.mjs` must have run to seed the cto-actor principal. The script will exit 1 with a clear error message ("principal 'cto-actor' not found. Run scripts/bootstrap-cto-actor-canon.mjs first.") -- good developer-feedback path.
4. A Claude Code CLI on $PATH (default mode uses `ClaudeCliLLM` which shells out to `claude`). `--stub` short-circuits this for a deterministic offline plan, but the documentation does not lead with this.
5. No environment variable required for the basic `--stub` path. For the LLM path, `claude` must be authenticated (Anthropic OAuth via the CLI's own login flow).

Time-to-first-plan estimate, fresh clone:

- `npm install`: 90s
- `npm run build`: 40s (TypeScript)
- `node scripts/bootstrap-cto-actor-canon.mjs`: 3s
- `node scripts/run-cto-actor.mjs --stub --request "Hello LAG"`: 5s
- Total: ~2m18s for a stub plan; +5-8min if running the real LLM path through claude CLI.

The "first plan in 5 minutes" goal is met for the stub path. The LLM path depends on the user already having `claude` set up; the README and getting-started page mention this but do not flag it as a step-0 dependency.

Gaps to "5-minute newcomer success":

- README does not mention `npm run build` is required before any script in `scripts/run-*.mjs` works. The script imports from `../dist/...` rather than `../src/...`.
- `--stub` is buried in the script's --help; should be the documented onboarding path.
- The "node 22+" requirement is in the README but not in `package.json:engines` (verified in package.json -- no engines field).
- The `examples/quickstart.mjs` path uses the memory host (no .lag/ dir required) and is the easiest "see something happen"; the cto-actor path needs .lag/ + bootstrap. The README should signpost this distinction explicitly.

### 7. Org-ceiling check: 50 concurrent actors

Saturation sources, ranked by likelihood of saturating first:

**a. Atom-store reads/writes (file-based on local disk).** The file AtomStore loads ALL atoms on every `.query()` and `.search()` call (`loadAll()` in `src/adapters/file/atom-store.ts`). At 30k atoms (the cited canon ceiling), one query = 30k file reads + JSON parses = 1-3 seconds on a modern SSD. With 50 actors each running query on every iteration, the disk becomes the bottleneck within minutes. The Console's in-memory atom index (line 84-110) is the right pattern but it lives in the Console process; the substrate AtomStore doesn't have an equivalent in-process projection. Path to scale: a SQLite-backed AtomStore adapter (or PostgreSQL for the org-ceiling case) wired to the same interface; the optional `subscribe` capability is already declared so a NOTIFY-style wake works without contract changes.

**b. Bot token rate limits.** Each actor needs its own GitHub App installation token. GitHub's installation-token rate limits are 5,000 req/hr per installation. At 50 actors each making ~100 GitHub calls/hour (PR observation, status checks, comment polling), the limit is tight but not breached. Path to scale: per-role bot identities (already shipped per `arch-bot-identity-per-actor`), and a token-mint cache that re-uses a fresh token for ~1h instead of minting per-call.

**c. Claude Code CLI session count.** One `claude -p` per actor instance, each spawning a child node-pty or npm-shell. At 50 concurrent, that's 50 long-running stream-json subprocesses -- non-trivial RSS (each agent loop holds context). The path to scale is the AgentLoopAdapter seam: swap the CLI adapter for an HTTP-API adapter that pools connections and amortizes the loop across actors. The substrate does not lock you in to the CLI; this is exactly the pluggability story the canon promises.

**d. Cron / scheduler conflict.** The Scheduler interface exposes `recurring/defer/cancel` -- adapter-implementation-specific. The file-backed scheduler is in-process, so 50 actors = 50 schedulers. No global locking; a tick on actor A doesn't see actor B's schedule. For the org case, the Scheduler adapter would need to coordinate via the AtomStore (a "next-tick-at" atom + leader-election); that's not in src/ today and is correctly absent because it's policy, not mechanism.

**e. Operator-escalation channel.** The Notifier interface is pluggable but the V0 file queue serializes to disk. At 50 actors all telegraphing concurrent escalations, the file queue becomes the throughput limit. Path to scale: the Notifier is a seam by design (`arch-notifier-is-a-channel`); Telegram, Slack, and a stub HTTP webhook are documented options.

Overall: the substrate scales correctly via adapter swap. The default ones don't. Documenting which defaults are "indie-floor only" vs "org-ceiling capable" is the missing onboarding artifact.

### 8. Test coverage gaps

`npx vitest run` (in repo root): 2,164 passing / 32 skipped / 0 failing across 194 test files. Coverage 80.77% lines / 79.62% branches / 86.25% functions overall.

Files below 60% lines coverage (excluding 0% compatibility shims, which v8-coverage prints as 0% even though they're export-* re-exports):

| file | lines | branches | functions | comments |
|---|---|---|---|---|
| src/actors/provisioning/provisioner.ts | 1.12% | 100 | 0 | nearly untested |
| src/actors/provisioning/jsonl-mirror.ts | 1.41% | 100 | 0 | nearly untested |
| src/actors/provisioning/slack-server.ts | 2.41% | 100 | 0 | nearly untested |
| src/actors/provisioning/credentials-store.ts | 4.68% | 100 | 0 | token store |
| src/actors/provisioning/manifest-url.ts | 4.76% | 100 | 0 | URL parsing |
| src/actors/provisioning/role-loader.ts | 8% | 100 | 0 | role JSON loader |
| src/actors/provisioning/risk-assessor.ts | 30% | 100 | 0 | risk policy |
| src/cli/respond.ts, run-loop.ts, compromise.ts | 0% | 0 | 0 | CLI surfaces |
| src/integrations/agent-sdk/app-client.ts | 14.75% | 60 | 14.28% | Anthropic API client |
| src/integrations/agent-sdk/jsonl-mirror.ts | 1.41% | 100 | 0 | shadowed by examples |
| src/daemon/invoke-claude.ts | 15.32% | 100 | 0 | shadowed by examples |
| src/daemon/cli-renderer/claude-streaming.ts | 41.39% | 57.89% | 60% | streaming-json |
| src/runtime/actors/code-author/code-author.ts | 6.81% | 0 | 0 | inert skeleton |
| src/actors/pr-review/github.ts | 52.73% | 84.28% | 66.66% | review-API client |
| src/simulation/metrics.ts | 34.61% | 33.33% | 50% | simulation only |

Failure mode of an untested code path under autonomous load: a malformed JSON payload from claude CLI (which the parser at `claude-streaming.ts` line 200-341 is supposed to handle) hits an untested branch, the executor catches the throw at `agentic/agent-loop/structural`, the plan flips to failed, the operator gets an escalation -- BUT a path-deeper than the executor's catch (e.g., the redactor throwing on a non-string after redaction) would crash the actor and leave a half-written session atom + no atom-write of the failure. The kill-switch-tripped atom write has its own try/catch (`run-actor.ts:391-396`) but the agent-session atom write is the adapter's responsibility and not always wrapped.

## Suggested Sprint Prioritization

Three buckets, sized by effort and impact:

**S/H (small effort, high impact) -- ship next sprint:**

- **Fix the AtomStore.put() race** (Top-5 #1). Edit `atomicWriteFile` to optionally accept `{ flag: 'wx' }`; have `put()` use it. Add a regression test. ~1 day.
- **Add commit-SHA verification in the agentic executor** (Top-5 #2). One `git cat-file -e` shell-out post-run, before PR creation. ~2 days with regression test.
- **Bring `src/cli/respond.ts`, `src/cli/run-loop.ts`, `src/cli/compromise.ts` to >60% line coverage** (Top-5 #3). These are the load-bearing operator CLIs. Mock the Host, exercise the happy + error paths. ~3 days.

**M/H (medium effort, high impact) -- next sprint or two:**

- **Provisioning module triage**: decide which of the 7 provisioning files are still load-bearing. `credentials-store.ts` and `manifest-url.ts` are critical-path; the others (slack-server, jsonl-mirror) may be dead code. Either bring to coverage or remove. ~1 sprint.
- **Console: live-actor + dispatch-feed endpoints** (Section 3). Closes the #1 operator-visibility gap and is mostly read-only-projections work. ~1 sprint.
- **Decide the framework-code-mechanism-only fence on `src/external/github*`** (Top-5 #5). Either move it to `examples/external/github/` and re-export from a new `adapters/github/` package, or write a `src/external/README.md` that explicitly grants vendor-specific exception status to the GitHub-as-transport package and forbids further vendor packages. The second route is cheaper; the first route is cleaner. Operator pick. ~3 days for the second, ~2 weeks for the first.

**L/M (large effort, medium impact) -- prioritize after the above:**

- **Org-ceiling AtomStore adapter** (Section 7a). SQLite or PostgreSQL implementing the existing `AtomStore` interface + the optional `subscribe` capability. This is what unlocks 50 concurrent actors. ~2-3 sprints, but no shape changes to src/ are required.
- **Console mutation contract** (Top-5 #4). Either remove `/api/atom.propose` and route through `lag-decide`, or add a CR-equivalent code-review path before write. Operator pick.

**Top 3 to tackle next sprint, recommended:**

1. AtomStore.put() race (CRITICAL, small fix, high test ROI).
2. commit-SHA verification (MAJOR, documented gap, the substrate's threat model already names it).
3. CLI coverage (MAJOR, the cli/ surface is what an indie-floor user reaches for first; a 0%-covered cli is the fastest way to ship a regression to a new operator).

## Strengths to preserve

These are well-built and future changes should NOT regress them:

1. **The 8-interface Host contract.** `src/substrate/interface.ts` is the single best file in the repo for an external reader to start with. JSDoc is description-of-contract not description-of-implementation; the optional capability dial pattern (`AtomStoreCapabilities.hasSubscribe`) is the right way to make sub-interfaces extensible without breaking adapters. Do not allow vendor concerns or specific atom types to leak into this file.

2. **runActor's kill-switch coverage.** `src/runtime/actors/run-actor.ts:135-250` checks the kill-switch at the top of every iteration AND between every action in one iteration's proposed-actions loop, with predicate-OR-signal disjunction and richer-signal-wins attribution. This is what makes the soft-tier kill switch actually work.

3. **Policy default-deny.** `src/substrate/policy/index.ts:80-186` defaults to escalate on a missing match, with regex safety guards (length cap, anti-backtracking), specificity scoring, and tiebreaks documented. The runActor convenience-permissive-default is OPT-IN and documented.

4. **Atomic file writes.** `src/adapters/file/util.ts:21-32` writes-to-tmp + rename + tmp-cleanup on failure. The pattern is the right shape; the put() race (Finding #1) is a missing guard around an otherwise-correct primitive.

5. **The kill-switch primitive.** `src/substrate/kill-switch/index.ts` is exemplary: filesystem watch + setInterval poll fallback for FS that drop watch events, three trip paths, sentinel-filename validation against path traversal, and `unref()` on the poll timer. Do not allow this file to grow vendor concerns.

6. **The provenance chain on PR #186.** Six atoms, intact derived_from across all hops, total 23m36s wall-clock from intent to merge. The audit-grade provenance the canon promises is delivered. Preserve the discipline that produced this.

7. **The agentic executor's failure taxonomy.** `src/runtime/actor-message/agentic-code-author-executor.ts:293-344` maps every (kind x failure?.kind) combination to a stable stage string the dashboard consumes. Exhaustive switch on `result.kind`, fall-through for `'completed'` is unreachable but checked. Operators looking at a stage prefix know the substrate layer; this is the exact shape an external operator needs.

8. **Token leakage defense.** `scripts/git-as.mjs:170-280` is now correct after the PR #169 fix. The post-push remote-name-only upstream-set step plus the `extractSetUpstreamPlan` helper close the leak window completely. Do not let a future "convenience" PR re-introduce `-u` shortcuts.

9. **Test discipline.** 2,164 passing, 0 failing, on-CI on Ubuntu and Windows. The shebang-import discipline (helpers under `scripts/lib/*.mjs`, tests import from there) is the kind of small-cost-now-vs-large-cost-later choice that keeps the suite green at scale.

10. **Compatibility shims as honest one-liners.** `src/policy/index.ts:1-6`, `src/actors/actor.ts:1-5`, etc. are 1-5 lines of `export *` with a header comment naming the destination and the rationale. This is how a substrate refactor stays cheap; do not collapse the shims early -- let consumers migrate at their own pace.

---

End of audit. Total atoms inspected: ~30 from `.lag/atoms/`. Total source files read: ~25. Total LOC reviewed: ~5,000. Test runs: 1 unit + 1 coverage. Wall-clock: ~30 minutes of analysis on top of the prior context.
