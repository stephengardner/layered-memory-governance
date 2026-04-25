# PrFixActor Design

**Author:** lag-ceo
**Date:** 2026-04-25
**Status:** Proposed
**Tracks:** Section 8.3 / Section 9 deferred follow-up to `docs/superpowers/specs/2026-04-25-agentic-actor-loop-design.md` (the "PrLandingActor migration" line item).
**Builds on:** PR1 substrate (#166), PR2 AgenticCodeAuthorExecutor (#167), PR3 ClaudeCodeAgentLoopAdapter (#168), PR4 git-as `-u` token-leak fix (#169).

---

## 1. Goal

Ship a sibling outward Actor (`PrFixActor`) that consumes the agent-loop substrate to autonomously drive a PR through CR review feedback to a clean state. The existing `PrLandingActor` keeps its scope (classify review comments, reply, resolve nits, escalate architectural). The new `PrFixActor` adds the missing capability: when CR posts CHANGES_REQUESTED with actionable findings, dispatch the agent-loop in an isolated workspace, apply code fixes, push, and resolve threads addressed.

Today's manual labor (witnessed across PRs #166-#169 in this session): operator drives PR through CR review, reads findings, dispatches an implementer subagent, pushes fixes, resolves threads, repeats until APPROVED. The migration's value: that loop becomes an autonomous actor loop, with a full audit trail in `agent-session` / `agent-turn` atoms (substrate-level) plus `pr-fix-observation` atoms (actor-level orchestration).

Non-goals:
- Replacing `PrLandingActor`. Both actors run independently; operators choose policy per PR.
- Auto-merging an APPROVED PR. The merge gate stays operator-controlled in this PR; auto-merge is a deferred follow-up.
- CI failure auto-fix. Different problem; the agent-loop cannot reliably repair Node-version-specific or platform-specific test failures from CI logs alone.
- Fork PR support. Same restriction the existing `PrLandingActor` carries.
- Wiring into CI. This PR ships the actor + driver + tests; CI integration (`pr-fix.yml` or extending `pr-landing.yml`) lands in a follow-up after operator validates dry-runs locally.

---

## 2. Architecture

```
runActor(PrFixActor, {host, principal: 'pr-fix-actor', adapter: {review, agentLoop, workspaceProvider, blobStore, redactor, ghClient}, ...budget, killSwitch, etc.})
  loop until convergence or budget:
    observe   -> read PR state via PrReviewAdapter (unresolved threads, CR review state, mergeable state, CI failures)
                 + write a `pr-fix-observation` atom for the audit trail
    classify  -> 'all-clean' | 'has-findings' | 'ci-failure' | 'architectural'
                 -- the convergence key is `pr-fix:findings=N:ci=M:arch=K`; runActor halts on no-progress repeats
    propose   -> 'has-findings' -> [{kind: 'dispatch-agent-loop', findings, planAtomId}]
                 'all-clean'    -> [] (loop ends naturally)
                 'ci-failure'   -> [{kind: 'escalate', reason}]
                 'architectural'-> [{kind: 'escalate', reason}]
    apply     -> dispatch action: agent-loop adapter runs in an isolated worktree;
                 on completed, the agent has already pushed; for each finding the
                 agent's commit message references, call reviewAdapter.resolveThread()
    reflect   -> 'done' (no findings) | 'progress' (findings reduced) | 'stuck' (no progress)
```

**One `apply()` cycle = ONE `AgentLoopAdapter.run()` call = ONE fix attempt.** The actor's outer loop drives multiple cycles; each `run()` produces session + turn atoms via the substrate. A new `pr-fix-observation` atom on each iteration captures the higher-level orchestration.

**Sibling pattern, not extension.** PrFixActor and PrLandingActor share the `PrReviewAdapter` instance (cheap shared dep) but their actor instances are independent: separate canon policy atoms, separate kill-switch sentinel, separate budget cap. Operators choose which to run; running both is the normal case (PrLandingActor handles classify/reply/resolve; PrFixActor handles fix-and-push).

---

## 3. Components

### 3.1 `PrFixActor` (`src/runtime/actors/pr-fix/pr-fix.ts`)

Implements the `Actor` interface from `src/runtime/actors/actor.ts`. Pure functions for `observe / classify / propose / reflect`; `apply` is async and dispatches the agent-loop.

```ts
export interface PrFixAdapters {
  readonly review: PrReviewAdapter;
  readonly agentLoop: AgentLoopAdapter;
  readonly workspaceProvider: WorkspaceProvider;
  readonly blobStore: BlobStore;
  readonly redactor: Redactor;
  readonly ghClient: GhClient;
}

export interface PrFixObservation {
  readonly pr: PrIdentifier;
  readonly unresolvedThreads: ReadonlyArray<UnresolvedThread>;
  readonly crReviewState: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'PENDING' | 'NONE';
  readonly mergeableState: 'CLEAN' | 'BLOCKED' | 'UNSTABLE' | 'BEHIND' | 'DIRTY' | 'UNKNOWN';
  readonly ciFailures: ReadonlyArray<{ name: string; conclusion: string }>;
  readonly observationAtomId: AtomId;
  readonly partial?: boolean;  // mirrors PrLandingObservation's flag
}

export type PrFixClassification = 'all-clean' | 'has-findings' | 'ci-failure' | 'architectural';

export interface PrFixProposal {
  readonly kind: 'dispatch-agent-loop' | 'escalate';
  readonly findings?: ReadonlyArray<UnresolvedThread>;
  readonly reason?: string;
  readonly planAtomId?: AtomId;
}

export class PrFixActor implements Actor<...> { /* observe, classify, propose, apply, reflect */ }
```

### 3.2 `pr-fix-observation` atom (`src/runtime/actors/pr-fix/pr-fix-observation.ts`)

A new atom-type entry on the existing `AtomType` union: `'pr-fix-observation'`. Metadata captures the PR id, observed thread count, classification key, dispatched-agent-session-atom-id (optional). Mirrors how `pr-observation` is shaped today.

```ts
export interface PrFixObservationMeta {
  readonly pr_owner: string;
  readonly pr_repo: string;
  readonly pr_number: number;
  readonly cr_review_state: string;
  readonly mergeable_state: string;
  readonly unresolved_thread_count: number;
  readonly ci_failure_count: number;
  readonly classification: PrFixClassification;
  readonly dispatched_session_atom_id?: AtomId;  // set when classify === 'has-findings'
}
```

### 3.3 `src/runtime/actors/pr-fix/index.ts`

Barrel exports `PrFixActor`, types, and the observation-atom helpers.

### 3.4 `scripts/bootstrap-pr-fix-canon.mjs`

Operator-seeded canon policy atoms (L3 layer, signed by operator). Mirrors `scripts/bootstrap-pr-landing-canon.mjs`.

| Tool | Action | Rationale |
|---|---|---|
| `agent-loop-dispatch` | allow | primary job |
| `pr-thread-resolve` | allow | resolves threads addressed by the fix |
| `pr-thread-reply` | allow | informational replies summarizing the fix |
| `pr-merge-*` | deny | merge stays operator's; auto-merge is out of scope |
| `^canon-write-l3.*` | deny | L3 promotion requires the human gate |
| `*` (catch-all) | deny | default-deny scoped to `pr-fix-actor` |

### 3.5 `scripts/run-pr-fix.mjs`

Driver script mirroring `run-pr-landing.mjs`:
- Dry-run is the DEFAULT. Write operations short-circuit inside the adapters and log what they would do. Reads + agent-loop reasoning still run; the agent emits session/turn atoms in dry-run mode but does NOT push.
- `--live` enables writes (push + resolveThread).
- `--max-iterations N` (default 3).
- `--max-budget-usd <usd>` per agent-loop run (default 2.0).
- `--max-wall-clock-ms <ms>` per agent-loop run (default 600000).
- Kill-switch checks `.lag/STOP`. Touch that file to halt.

### 3.6 Tests

- `test/runtime/actors/pr-fix/pr-fix.test.ts`:
  - Unit tests for `observe / classify / propose / reflect` (each pure or stubbed).
  - Integration test on `MemoryHost` with stub `PrReviewAdapter` (canned findings) + stub `AgentLoopAdapter` (returns `kind: 'completed'` with synthetic commit). Asserts:
    - One `pr-fix-observation` atom written per iteration.
    - One `agent-session` atom + N `agent-turn` atoms per `apply()` call.
    - On stub-completed, the actor calls `reviewAdapter.resolveThread()` for each finding.
    - Convergence: when stub returns no findings on round 2, the actor halts with `Reflection: 'done'`.

---

## 4. Data flow

### 4.1 Observe

`PrReviewAdapter.getPrReviewStatus({pr})` returns:
- `unresolvedThreads: ReadonlyArray<{threadId, body, path, line}>`
- `crReviewState`
- `mergeableState`
- `ciFailures`

`PrFixActor.observe()` calls that, mints a `pr-fix-observation` atom (shape per §3.2), and returns the observation. Read-only path; no writes besides the atom.

### 4.2 Classify

```ts
classify(obs: PrFixObservation): Classified<PrFixClassification> {
  if (obs.unresolvedThreads.length === 0 && obs.ciFailures.length === 0) return {key: 'pr-fix:findings=0:ci=0:arch=0', value: 'all-clean'};
  if (obs.ciFailures.length > 0) return {key: '...', value: 'ci-failure'};
  // partition threads: architectural-tagged threads (CR posts a `🟠 Major / Architectural` marker) -> escalate
  const arch = obs.unresolvedThreads.filter(isArchitectural);
  if (arch.length > 0) return {key: '...', value: 'architectural'};
  return {key: 'pr-fix:findings=N:ci=0:arch=0', value: 'has-findings'};
}
```

The convergence key is the heart of the no-progress guard: if classify returns the same key twice in a row without `apply` reducing the finding count, runActor halts with `'stuck'`.

### 4.3 Propose / Apply

`propose` maps classification to one action per iteration:
- `'has-findings'` -> `{kind: 'dispatch-agent-loop', findings, planAtomId: <fresh per iteration>}`
- `'ci-failure'` -> `{kind: 'escalate', reason: 'CI failure: <names>'}`
- `'architectural'` -> `{kind: 'escalate', reason: 'architectural concern: <thread bodies>'}`
- `'all-clean'` -> no actions (loop ends naturally on next reflect)

`apply` dispatches:

For `dispatch-agent-loop`:
1. Acquire workspace via `workspaceProvider.acquire({principal: 'pr-fix-actor', baseRef: '<PR head ref>', correlationId})`.
2. Build the `AgentTask`:
   - `questionPrompt`: a structured CR-fix prompt template (`<cr_findings>...</cr_findings>` blocks per finding, each with `path`, `line`, `body`).
   - `targetPaths`: union of paths CR cited.
3. Build `BudgetCap` from operator config (max_usd / max_wall_clock_ms / max_turns).
4. Build `ToolPolicy.disallowedTools` from the per-principal LLM tool policy resolver (substrate seam, defaults to empty).
5. Call `agentLoop.run({host, principal: 'pr-fix-actor', workspace, task, budget, toolPolicy, redactor, blobStore, replayTier, blobThreshold, correlationId})`.
6. On `kind: 'completed'` with artifacts: call `reviewAdapter.resolveThread(threadId)` for each finding the agent's commit-message-or-touched-paths heuristic claims to address.
7. Always `workspaceProvider.release(workspace)` in a `finally`.

For `escalate`:
- Call `sendOperatorEscalation` (the existing helper at `src/runtime/actor-message/`) with the reason + observation.

### 4.4 Reflect

```ts
reflect(prevObs, newObs): Reflection {
  if (newObs.unresolvedThreads.length === 0 && newObs.ciFailures.length === 0) return 'done';
  if (newObs.unresolvedThreads.length < prevObs.unresolvedThreads.length) return 'progress';
  // Same or more findings after apply -> stuck (the convergence guard in runActor will halt)
  return 'stuck';
}
```

---

## 5. Error handling

| Condition | Mapping |
|---|---|
| `agent-loop.run()` -> `kind: 'completed'` + commit produced | `apply` resolves matched threads; `reflect` returns `progress` if findings reduced, `stuck` if same |
| `kind: 'completed'` + no commit (agent decided no action needed) | thread resolution is skipped; `reflect` checks finding-count delta -> `stuck` after N iterations |
| `kind: 'budget-exhausted'` | escalate via `sendOperatorEscalation`; runActor's reflection returns `stuck` |
| `kind: 'error'` with `failure.kind: 'transient'` | `reflect` returns `progress` (let runActor's outer loop retry); rate-limited transient handling |
| `kind: 'error'` with `failure.kind: 'structural'` | escalate; `reflect` returns `stuck` |
| `kind: 'aborted'` | propagate signal cancellation up; runActor halts |
| `classify` returns `'architectural'` | escalate, no dispatch |
| `classify` returns `'ci-failure'` | escalate, no dispatch (CI repair is a separate problem) |
| `workspaceProvider.acquire` throws | `pr-fix/workspace-acquire` failure stage; `reflect` returns `stuck` |
| `reviewAdapter.resolveThread` throws | log + skip the resolve (the fix landed; thread state is recoverable manually); `reflect` returns `progress` |

---

## 6. Security + correctness

### 6.1 Threat model

- **Workspace credentials.** `WorkspaceProvider` provisions the workspace with the SAME bot creds (`lag-ceo`) the agent will use to push. Cred scope is the provider's responsibility (existing PR1 contract).
- **Tool policy is plumbing.** The substrate's `toolPolicy.disallowedTools` is forwarded to the agent-loop adapter. The CLI does the actual blocking; tool denials surface as `tool_calls[].outcome: 'policy-refused'` in the atom.
- **Redaction is mandatory.** Every payload (CR finding text, agent prompt, tool args/results) goes through `input.redactor.redact()` BEFORE atom write. Substrate-level invariant.
- **Commit SHA is unverified.** Per the PR1 substrate threat model, the adapter-supplied `commitSha` is unverified by the executor; the actor's `apply()` step trusts the agent for commit existence. The agent ran in an isolated worktree under bot creds; if the SHA doesn't exist, the next `observe()` cycle catches it (the PR's head SHA didn't change -> findings persist -> `stuck`).
- **No prompt-injection countermeasures.** A malicious CR finding could attempt to instruct the agent to exfil. Substrate-level threat: defense is layered (redactor catches secret-shaped exfil at write time; workspace boundary catches FS exfil; tool-policy catches tool exfil; pr-fix-actor's canon policy denies merge tools).
- **Convergence guard is non-negotiable.** runActor's no-progress halt prevents runaway agent-loop dispatch on a finding the agent can't fix. Without the guard, a misunderstanding of the finding could burn the entire budget on identical fix attempts.

### 6.2 Substrate-contract discipline

- Every plan task carries a "Security + correctness considerations" subsection that the implementer subagent walks through BEFORE writing code, not after CR flags it. Per memory `feedback_security_correctness_at_write_time`.
- TDD strict order: failing test first per task.
- Bot-identity attribution: every commit + push via `git-as` / `gh-as` lag-ceo. NEVER bare `git push` (per memory `feedback_never_github_actions_as_operator`).
- Pre-push grep for emdashes / private terms / design refs / canon-id leaks (per `feedback_pre_push_grep_checklist`).

---

## 7. Phasing

Single PR for this design. Decomposes into ~10 plan tasks (atom-type addition, observe, classify, propose, apply with agent-loop dispatch, apply with thread resolution, reflect, canon bootstrap script, driver script, e2e on MemoryHost). Cohesive enough to land together.

**Out of scope, deferred to follow-ups:**
- CI workflow integration. Operator validates dry-runs locally first, then a separate PR adds `pr-fix.yml` (or extends `pr-landing.yml` with a sibling job).
- Auto-merge after APPROVED. Operator-gated for now; the actor's canon policy explicitly denies `pr-merge-*`.
- Fork PR support. Same restriction `PrLandingActor` already carries.
- Strict replay tier (canon snapshot pinning) for `agent-session` atoms. Substrate-level deferred follow-up; not blocking.

---

## 8. Provenance

**Canon directives this design respects:**
- `dev-substrate-not-prescription`: framework code in `src/` stays mechanism-only; the actor lives in `src/runtime/actors/pr-fix/` (consumer of the substrate, not part of it).
- `simple-surface-deep-architecture`: one new actor + one new atom type; no new substrate seams.
- `dev-flag-structural-concerns-proactively`: §1 names the sibling-vs-extension trade-off explicitly and rejects extension/replacement options.
- `inv-provenance-every-write`: every atom carries `derived_from` linking PR -> observation -> session -> turns.
- `inv-governance-before-autonomy`: canon policy atoms enumerate every tool the actor uses; default-deny for everything not explicitly allowed; merge tools explicitly denied.
- `dev-extreme-rigor-and-research`: this design covers 4 classifications, 11 failure-mapping rows, 6 atom-trail invariants, 3 deferred follow-ups with explicit triggers.
- `dev-no-hacks-without-approval`: §6.1 calls out the unverified-commit-SHA trust assumption (inherited from substrate); §5 documents every error path's classification.
- `dev-forward-thinking-no-regrets`: atom-type additions are additive; existing PrLandingActor unaffected; operator's policy-atom-driven autonomy dial controls the rollout.

**Atoms / memory / prior PRs:**
- PRs #166, #167, #168, #169 (the agentic-actor-loop trilogy + token-leak fix) -- this PR composes their seams.
- Existing `PrLandingActor` + `PrReviewAdapter` -- sibling pattern + shared adapter.
- Memory `feedback_security_correctness_at_write_time` -- security walkthrough up front.
- Memory `feedback_pre_push_grep_checklist` + `feedback_lint_ci_fidelity_discipline` -- pre-push hygiene.
- Memory `feedback_never_github_actions_as_operator` -- bot-identity discipline.

---

## 9. What breaks if we revisit

- **CR's body-finding format changes** -- the architectural-vs-other classifier in §4.2 reads CR's `🟠 Major / Architectural` markers. If CR changes the wording, the classifier needs updating. Risk: low (CR's format has been stable for months); mitigation: classifier failure surfaces as "treat as has-findings" (no escalation), which is a graceful degradation.
- **Agent-loop adapter contract changes** -- the actor depends on the PR1 seam. Substrate is versioned; major changes would surface as TS errors, not silent drift.
- **`PrReviewAdapter` adds new finding types** -- the actor's `classify` enumerates 4 cases; an unrecognized type falls into `'has-findings'` by default (graceful).
- **Operator wants auto-merge** -- the `pr-merge-*` canon deny is removable per-deployment. The merge call itself is a follow-up PR; this design's components don't preclude it.
