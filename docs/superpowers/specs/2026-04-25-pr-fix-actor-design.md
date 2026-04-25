# PrFixActor Design

**Author:** lag-ceo
**Date:** 2026-04-25
**Status:** Proposed (round 2 -- addresses spec-reviewer feedback)
**Tracks:** Section 8.3 deferred follow-up to `docs/superpowers/specs/2026-04-25-agentic-actor-loop-design.md` (the "PrLandingActor migration" line item).
**Builds on:** PR1 substrate (#166), PR2 AgenticCodeAuthorExecutor (#167), PR3 ClaudeCodeAgentLoopAdapter (#168), PR4 git-as `-u` token-leak fix (#169).

---

## 1. Goal

Ship a sibling outward Actor (`PrFixActor`) that consumes the agent-loop substrate to autonomously drive a PR through CR review feedback to a clean state. The existing `PrLandingActor` keeps its scope (classify review comments, reply, resolve nits, escalate architectural). The new `PrFixActor` adds the missing capability: when CR posts CHANGES_REQUESTED with actionable findings, dispatch the agent-loop in an isolated workspace pinned to the PR's HEAD branch, apply code fixes, push back to that same branch, verify the commit, and resolve the threads addressed.

Today's manual labor (witnessed across PRs #166-#169 in this session): operator drives PR through CR review, reads findings, dispatches an implementer subagent, pushes fixes, resolves threads, repeats until APPROVED. The migration's value: that loop becomes an autonomous actor loop, with a full audit trail in `agent-session` / `agent-turn` atoms (substrate-level, written by the adapter) plus `pr-fix-observation` atoms (actor-level orchestration, written by `PrFixActor.observe`).

Non-goals:
- Replacing `PrLandingActor`. Both actors run independently; operators choose policy per PR.
- Auto-merging an APPROVED PR. The merge gate stays operator-controlled in this PR; auto-merge is a deferred follow-up.
- CI failure auto-fix. Different problem; the agent-loop cannot reliably repair Node-version-specific or platform-specific test failures from CI logs alone.
- Fork PR support. Same restriction the existing `PrLandingActor` carries (forks get a read-only `GITHUB_TOKEN` and the workflow short-circuits).
- Wiring into CI. This PR ships the actor + driver + tests; CI integration (`pr-fix.yml` or extending `pr-landing.yml`) lands in a follow-up after operator validates dry-runs locally.

---

## 2. Architecture

```
runActor(PrFixActor, {host, principal: 'pr-fix-actor', adapter: {review, agentLoop, workspaceProvider, blobStore, redactor, ghClient}, ...budget, killSwitch, ...})
  loop until convergence or budget:
    observe   -> read PR state via PrReviewAdapter.getPrReviewStatus
                 + write a `pr-fix-observation` atom
    classify  -> 'all-clean' | 'has-findings' | 'ci-failure' | 'architectural' | 'partial'
                 -- convergence key includes literal numeric counts
                    (`pr-fix:lineN=X:bodyN=Y:cr=Z:ci=W`); no-progress halt
                    fires on key-equality with progress=false
    propose   -> 'has-findings' -> [{tool: 'agent-loop-dispatch', findings, planAtomId, headBranch}]
                 'all-clean'    -> [] (loop ends naturally)
                 'ci-failure'   -> [{tool: 'pr-escalate', reason}]
                 'architectural'-> [{tool: 'pr-escalate', reason}]
                 'partial'      -> [] (do-not-decide signal; let next iteration retry)
    apply     -> per action, return Outcome:
                 'agent-loop-dispatch' -> acquire workspace pinned to headBranch,
                                          run agent-loop, verify commit-SHA, resolve
                                          matched comments, return PrFixOutcome
                 'pr-escalate'         -> sendOperatorEscalation, return PrFixOutcome
    reflect   -> map per-iteration outcomes onto Reflection {done, progress, note}
```

**One `apply()` cycle = ONE `AgentLoopAdapter.run()` call = ONE fix attempt.** The actor's outer loop drives multiple cycles; each `run()` produces session + turn atoms via the substrate. A new `pr-fix-observation` atom on each iteration captures the higher-level orchestration.

**Sibling pattern, not extension.** `PrFixActor` and `PrLandingActor` share the `PrReviewAdapter` instance (cheap shared dep) but their actor instances are independent: separate canon policy atoms, separate kill-switch sentinel, separate budget cap.

---

## 3. Components

### 3.1 Substrate change: `WorkspaceProvider.AcquireInput.checkoutBranch?`

Today's `AcquireInput`:
```ts
export interface AcquireInput {
  readonly principal: PrincipalId;
  readonly baseRef: string;       // what the workspace branches FROM
  readonly correlationId: string;
}
```

PR-fix needs to commit ON THE PR's HEAD branch and push back, NOT branch off `main`. Add an optional field:

```ts
export interface AcquireInput {
  readonly principal: PrincipalId;
  readonly baseRef: string;
  readonly correlationId: string;
  /**
   * Optional: existing branch (local or remote) to check out in the
   * acquired workspace. When set, the provider checks out this branch
   * directly (e.g., `git worktree add <path> <branch>`) so commits go
   * on it; `baseRef` becomes the comparison baseline for diff
   * operations rather than the parent of a new branch. When unset,
   * the provider creates a new branch off `baseRef` (the existing
   * default behavior, matching PR2's AgenticCodeAuthorExecutor).
   */
  readonly checkoutBranch?: string;
}
```

Backwards-compatible additive change. Default behavior (when `checkoutBranch` is absent) is unchanged. The reference `GitWorktreeProvider` adapter (in `examples/workspace-providers/git-worktree/`) gains a small branch:

```ts
if (input.checkoutBranch !== undefined) {
  // Fetch the branch first if it isn't already local.
  await execa('git', ['fetch', 'origin', input.checkoutBranch], {cwd: <repo>}).catch(() => undefined);
  await execa('git', ['worktree', 'add', workspacePath, input.checkoutBranch], {cwd: <repo>});
} else {
  await execa('git', ['worktree', 'add', '-b', sanitizeId(input.correlationId), workspacePath, input.baseRef], {cwd: <repo>});
}
```

The substrate `Workspace` shape is unchanged: `{id, path, baseRef}`. `baseRef` keeps its meaning (the comparison baseline), so PR2's `captureArtifacts` continues to work: `git rev-parse HEAD` vs `git rev-parse <workspace.baseRef>`.

### 3.2 `PrFixActor` (`src/runtime/actors/pr-fix/pr-fix.ts`)

Implements `Actor<PrFixObservation, PrFixAction, PrFixOutcome, PrFixAdapters>`. Pure functions for `observe / classify / propose / reflect`; `apply` is async and dispatches the agent-loop.

```ts
import type { Actor, ActorContext } from '../actor.js';
import type { Classified, ProposedAction, Reflection } from '../types.js';
import type { PrIdentifier, PrReviewAdapter, ReviewComment } from '../pr-review/adapter.js';
import type { AgentLoopAdapter } from '../../../substrate/agent-loop.js';
import type { WorkspaceProvider } from '../../../substrate/workspace-provider.js';
import type { BlobStore } from '../../../substrate/blob-store.js';
import type { Redactor } from '../../../substrate/redactor.js';
import type { GhClient } from '../../../external/github/index.js';
import type { AtomId } from '../../../substrate/types.js';

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
  readonly headBranch: string;          // PR's head ref, e.g. 'feat/pr-fix-actor'
  readonly headSha: string;             // PR head commit SHA (for verification)
  readonly baseRef: string;             // PR base, e.g. 'main' (passed to provider as comparison baseline)
  readonly lineComments: ReadonlyArray<ReviewComment>;       // direct from PrReviewStatus
  readonly bodyNits: ReadonlyArray<ReviewComment>;            // direct from PrReviewStatus
  readonly submittedReviews: ReadonlyArray<SubmittedReview>;  // direct from PrReviewStatus
  readonly checkRuns: ReadonlyArray<CheckRun>;                // direct from PrReviewStatus
  readonly legacyStatuses: ReadonlyArray<LegacyStatus>;       // direct from PrReviewStatus
  readonly mergeStateStatus: string | null;                   // direct from PrReviewStatus
  readonly mergeable: boolean | null;                         // direct from PrReviewStatus
  readonly partial: boolean;                                  // direct from PrReviewStatus
  readonly observationAtomId: AtomId;
}

export type PrFixClassification = 'all-clean' | 'has-findings' | 'ci-failure' | 'architectural' | 'partial';

export type PrFixAction =
  | { readonly kind: 'agent-loop-dispatch'; readonly findings: ReadonlyArray<ReviewComment>; readonly planAtomId: AtomId; readonly headBranch: string }
  | { readonly kind: 'pr-escalate'; readonly reason: string };

export type PrFixOutcome =
  | { readonly kind: 'fix-pushed'; readonly commitSha: string; readonly resolvedCommentIds: ReadonlyArray<string>; readonly sessionAtomId: AtomId }
  | { readonly kind: 'fix-failed'; readonly stage: string; readonly reason: string; readonly sessionAtomId: AtomId | null }
  | { readonly kind: 'escalated'; readonly reason: string };
```

The class signature:
```ts
export class PrFixActor implements Actor<PrFixObservation, PrFixAction, PrFixOutcome, PrFixAdapters> {
  readonly name = 'pr-fix-actor';
  readonly version = '1';
  // observe / classify / propose / apply / reflect ...
}
```

### 3.3 `pr-fix-observation` atom

A new atom-type entry on the existing `AtomType` union: `'pr-fix-observation'`. Layer `L0`, scope `'project'`. Mirrors `pr-observation` from `PrLandingActor`.

```ts
export interface PrFixObservationMeta {
  readonly pr_owner: string;
  readonly pr_repo: string;
  readonly pr_number: number;
  readonly head_branch: string;
  readonly head_sha: string;
  readonly cr_review_states: ReadonlyArray<{ author: string; state: string; submitted_at: string }>;
  readonly merge_state_status: string | null;
  readonly mergeable: boolean | null;
  readonly line_comment_count: number;
  readonly body_nit_count: number;
  readonly check_run_failure_count: number;
  readonly legacy_status_failure_count: number;
  readonly partial: boolean;
  readonly classification: PrFixClassification;
  /** Set when classify === 'has-findings' AND apply has run; null until then. */
  readonly dispatched_session_atom_id?: AtomId;
}
```

**Atom envelope:**
- `type: 'pr-fix-observation'`
- `layer: 'L0'`
- `scope: 'project'`
- `provenance.kind: 'agent-observed'`
- `provenance.derived_from`: `[<prior-iteration-pr-fix-observation>?, <dispatched-agent-session>?]` -- chains to the previous iteration's observation (when one exists) AND to the agent-session of the prior `apply()` (when one ran). The chain lets `buildSessionTree`-style projections walk the actor's iteration history.
- `confidence: 1`
- `principal_id: 'pr-fix-actor'`
- `taint: 'clean'`
- `content`: a short prose summary like `pr-fix observation: PR #168 head=ff13530 cr=APPROVED line_comments=0 body_nits=0 classification=all-clean`

`dispatched_session_atom_id` is patched onto the observation atom AFTER `apply()` runs (via `host.atoms.update`), so a single iteration's audit trail is one observation atom that records both the input state and the dispatched session.

### 3.4 Two policy layers (CRITICAL distinction)

**Layer A: actor-level (`runActor`'s `checkToolPolicy`).** Gates the actor's own proposed actions before `apply` runs. Seeded by `scripts/bootstrap-pr-fix-canon.mjs`. Subject: `pr-fix-actor`.

| Tool name (action.tool) | Action | Rationale |
|---|---|---|
| `agent-loop-dispatch` | allow | primary job |
| `pr-escalate` | allow | for ci-failure / architectural classifications |
| `pr-thread-resolve` | allow | invoked inside `apply` after agent-loop completion |
| `pr-merge-*` | deny | merge stays operator's; auto-merge is out of scope |
| `^canon-write-l3.*` | deny | L3 promotion requires the human gate |
| `*` (catch-all) | deny | default-deny scoped to `pr-fix-actor` |

**Layer B: sub-agent-level (`AgentLoopAdapter.toolPolicy.disallowedTools`).** Forwarded to the spawned Claude inside the workspace. Distinct from Layer A because the spawned Claude operates with the lag-ceo bot's git creds and could push to arbitrary branches if not constrained.

`PrFixActor.apply()` constructs `disallowedTools` from a hard-coded floor PLUS any operator overrides:

```ts
const SUB_AGENT_DISALLOWED_FLOOR: ReadonlyArray<string> = [
  // git-level: spawn must NOT push to anything but the PR's own branch.
  // The CLI does not have direct git tools; Bash is the only path. We
  // rely on Bash's argv check + the workspace's git remote being scoped
  // to the operator's repo (via WorkspaceProvider's cred provisioning).
  // The stronger guard is the post-apply commit-SHA verification (§4.4)
  // which catches a sub-agent that pushed somewhere unexpected.
  // 
  // Tools we explicitly block at the floor:
  'WebFetch',     // no exfil to non-github hosts (the agent has the lag-ceo token)
  'WebSearch',    // not needed for CR-fix; reduces prompt-injection surface
  'NotebookEdit', // .ipynb editing not in scope
];
```

Operators can extend the floor via `PrFixActor` config (e.g., `disallowedToolsExtra: ['Bash']` for read-only diagnostic runs).

### 3.5 `scripts/bootstrap-pr-fix-canon.mjs`

Operator-seeded canon policy atoms (L3 layer, signed by operator). Mirrors `scripts/bootstrap-pr-landing-canon.mjs`. Writes the Layer A table from §3.4.

### 3.6 `scripts/run-pr-fix.mjs`

Driver script mirroring `run-pr-landing.mjs`:
- Dry-run is the DEFAULT. The agent-loop adapter still runs (so the audit trail is exercised) but the agent's `Bash` tool is rebound to a logger in dry-run mode; no `git push` occurs.
- `--live` enables real fix-and-push.
- `--max-iterations N` (default 3).
- `--max-budget-usd <usd>` per agent-loop run (default 2.0; aligns with PR2's `AgenticCodeAuthorExecutor` defaults).
- `--max-wall-clock-ms <ms>` per agent-loop run (default 600000).
- Kill-switch checks `.lag/STOP`. Touch that file to halt.

### 3.7 Tests

- `test/runtime/actors/pr-fix/pr-fix.test.ts`:
  - Unit tests for `observe / classify / propose / reflect` (each pure or stubbed).
  - Integration test on `MemoryHost` with stub `PrReviewAdapter` (canned `PrReviewStatus` shapes) + stub `AgentLoopAdapter` (returns `kind: 'completed'` with synthetic `commitSha`) + stub `WorkspaceProvider` (in-memory path, recorded `acquire` calls including `checkoutBranch`).
  - Asserts:
    - Per iteration: one `pr-fix-observation` atom written (with all fields per §3.3).
    - On `has-findings`: `apply()` calls `agentLoop.run()` with `task.targetPaths` including the PR's cited line-comment paths; passes `Layer B disallowedTools` from §3.4; asserts `WorkspaceProvider.acquire()` received `checkoutBranch === observation.headBranch`.
    - On `kind: 'completed'`: actor calls `git rev-parse HEAD` in workspace (verifies `commitSha`), THEN calls `reviewAdapter.resolveComment(pr, commentId)` for each finding the agent's `touchedPaths` matches.
    - On commit-SHA mismatch: returns `{kind: 'fix-failed', stage: 'verify-commit-sha', reason: '...'}`.
    - Convergence regression: same finding-count two iterations in a row with progress=false halts via `runActor`'s no-progress guard.

- `test/examples/workspace-providers/git-worktree-provider.test.ts` extension:
  - One new test for `acquire({checkoutBranch: 'existing-branch'})`. Sets up a real git repo in tmp dir, creates `existing-branch`, calls `acquire`, asserts the workspace's HEAD points at `existing-branch` and `git status` is clean.
  - Regression assertion: spy on the underlying execa helper (or read git's reflog) and assert that the `git worktree add` invocation did NOT include the `-b` flag when `checkoutBranch` was supplied. This pins the §3.1 substrate semantics so a future revert that re-introduces `-b` fails the test loud (would otherwise create a NEW branch off the checked-out branch and break PR-fix's "commit on the PR's HEAD" requirement).

---

## 4. Data flow

### 4.1 Observe

`PrFixActor.observe(ctx)` calls `ctx.adapters.review.getPrReviewStatus({pr})` and pulls the PR's head ref + head SHA (via the `ghClient` adapter's pulls.get if not in `PrReviewStatus`). Returns `PrFixObservation` with all fields populated direct from `PrReviewStatus` (no premature reduction).

The actor mints a `pr-fix-observation` atom (per §3.3) BEFORE returning, so the observation is in the audit trail before classify/propose run.

If `PrReviewStatus.partial === true`: the classifier returns `'partial'`, propose returns `[]`, and the next iteration retries. This is the "do not decide" signal.

### 4.2 Classify

`Actor.classify` returns `Classified<PrFixObservation>` per `src/runtime/actors/types.ts:86-92` -- `{observation, key, metadata?}`. The classification literal + counts go into `metadata` so `propose` and `reflect` can read them downstream. The `Reflection.progress` flag is computed in `reflect`, not on `classify` (per the type's own contract: `progress` is a Reflection field, not a Classified field).

```ts
async classify(obs: PrFixObservation, _ctx): Promise<Classified<PrFixObservation>> {
  if (obs.partial) {
    return {
      observation: obs,
      key: 'pr-fix:partial=true',
      metadata: { classification: 'partial' as PrFixClassification, ciFailures: 0, arch: 0 },
    };
  }
  const ciFailures = countCiFailures(obs);  // §4.2.1
  const arch = countArchitectural(obs);     // §4.2.2
  const totalFindings = obs.lineComments.length + obs.bodyNits.length;
  // Convergence key uses concrete numeric counts (interpolation, NOT
  // literal "N"). PrLandingActor uses the same pattern. Same key
  // twice with progress=false on the Reflection halts the loop via runActor.
  const key = `pr-fix:lineN=${obs.lineComments.length}:bodyN=${obs.bodyNits.length}:cr=${summarizeReviewState(obs.submittedReviews)}:ci=${ciFailures}:arch=${arch}`;
  let classification: PrFixClassification;
  if (totalFindings === 0 && ciFailures === 0 && obs.mergeStateStatus !== 'BEHIND') {
    classification = 'all-clean';
  } else if (ciFailures > 0) {
    classification = 'ci-failure';
  } else if (arch > 0) {
    classification = 'architectural';
  } else {
    classification = 'has-findings';
  }
  return {
    observation: obs,
    key,
    metadata: { classification, ciFailures, arch },
  };
}
```

Mirrors `PrLandingActor.classify`'s shape (which returns `{observation, key, metadata: {nit, suggestion, architectural, reviewerPending}}`).

#### 4.2.1 `countCiFailures`

A `CheckRun` counts as failure when `status === 'completed' && conclusion === 'failure'`. Pending check-runs (`status === 'queued' | 'in_progress'`) are NOT failures (they may resolve; classifier is conservative). `LegacyStatus` counts when `state === 'failure' || state === 'error'`. Note: CodeRabbit frequently posts a single `CodeRabbit` legacy status with state `pending` while the review is in-flight; pending is NOT a failure (it's a "do not decide" -- handled via `PrReviewStatus.partial`).

#### 4.2.2 `countArchitectural`

A `ReviewComment` is "architectural" when its body contains the case-insensitive marker `<orange-circle> Major` (CR's literal emoji marker for major-severity findings, byte sequence `\u{1F7E0} Major`) AND the substring `architectural` OR `large refactor` OR `redesign`. Both must match, to avoid misclassifying minor "this is a major usability issue" comments. Heuristic; falls back to `'has-findings'` when uncertain. The classifier's regex uses the emoji byte sequence in code; this prose paragraph names it as `<orange-circle>` to keep the spec file CI-grep-friendly.

### 4.3 Propose

```ts
propose(classified, ctx): ReadonlyArray<ProposedAction<PrFixAction>> {
  switch (classified.classification) {
    case 'all-clean':
    case 'partial':
      return [];
    case 'has-findings': {
      const findings = [...obs.lineComments, ...obs.bodyNits];
      const planAtomId = mintPlanAtomId();  // synthesized PR-fix plan atom for provenance
      return [{
        tool: 'agent-loop-dispatch',
        payload: { kind: 'agent-loop-dispatch', findings, planAtomId, headBranch: obs.headBranch },
      }];
    }
    case 'ci-failure':
    case 'architectural':
      return [{
        tool: 'pr-escalate',
        payload: { kind: 'pr-escalate', reason: classified.classification === 'ci-failure'
          ? `CI failure: ${describeCiFailures(obs)}`
          : `Architectural concern: ${describeArchitectural(obs)}` },
      }];
  }
}
```

### 4.4 Apply

For `agent-loop-dispatch`:
1. **Acquire workspace pinned to PR's HEAD branch.** Call `ctx.adapters.workspaceProvider.acquire({principal: 'pr-fix-actor', baseRef: obs.baseRef, checkoutBranch: obs.headBranch, correlationId})` (per §3.1's substrate extension).
2. **Build the `AgentTask`.**
   - `questionPrompt`: a structured CR-fix template with fenced `<cr_findings>...</cr_findings>` blocks per finding; each carries `path`, `line`, `body`. Includes guidance: "you are running on the PR's HEAD branch; commit and push to update this PR; do not create new branches."
   - `targetPaths`: union of `comment.path` across `findings` (deduped).
3. **Build `BudgetCap`** from the actor's per-iteration budget (`max_usd`, `max_turns`, `max_wall_clock_ms`).
4. **Build `ToolPolicy.disallowedTools`** = `SUB_AGENT_DISALLOWED_FLOOR` (per §3.4 Layer B) + any operator-supplied extras.
5. **Run agent-loop**: `await ctx.adapters.agentLoop.run({host, principal, workspace, task, budget, toolPolicy, redactor, blobStore, replayTier, blobThreshold, correlationId})`.
6. **Verify the commit SHA per substrate contract.** After `run()` returns:
   - If `result.kind !== 'completed'`: skip resolve, return `{kind: 'fix-failed', stage: 'agent-loop/<failure.kind>', reason: ...}`.
   - If `result.artifacts?.commitSha` is undefined: return `{kind: 'fix-failed', stage: 'agent-no-commit', reason: 'agent loop completed but did not commit'}`.
   - Run `git rev-parse HEAD` in `workspace.path` (via a small helper that wraps `execa('git', ['rev-parse', 'HEAD'], {cwd: workspace.path})` -- this is local git, NOT `ghClient`, which is a GitHub API surface). If the result does NOT equal `result.artifacts.commitSha`: return `{kind: 'fix-failed', stage: 'verify-commit-sha', reason: 'adapter-supplied SHA does not match HEAD'}`.
   - Run `git diff --name-only <baseRef>..HEAD` in `workspace.path` (same execa-helper). The set of touched paths is the basis for thread-resolution (§4.4.1).
7. **Resolve threads addressed by the fix** (§4.4.1).
8. **Always release the workspace** in a `finally`: `await ctx.adapters.workspaceProvider.release(workspace).catch(() => undefined)`.

For `pr-escalate`:
- Call `sendOperatorEscalation` (existing helper at `src/runtime/actor-message/`) with the reason + observation body. Returns `{kind: 'escalated', reason}`.

#### 4.4.1 Thread-resolution heuristic (explicit, picked decisively)

For each finding `f` in `action.findings`:
- Resolve via `reviewAdapter.resolveComment(pr, f.id)` ONLY IF `f.path` is in the touched-paths set returned by `git diff --name-only`.
- Otherwise leave the comment unresolved; the next iteration's observe will see it as still-pending.

Rationale: this is the conservative middle ground. "Resolve everything on a touched path" ignores the line specificity (a finding on line 10 may not actually have been fixed if the agent edited line 100). "Require commit-message reference" demands the agent quote thread IDs in commit messages, which is brittle. Touched-path matching is the simplest defensible rule: if the agent didn't even touch the file, the finding is definitionally not addressed; if the agent DID touch the file, the next iteration's observation re-checks (CR will re-fire if the fix didn't actually address the comment).

Trade-off documented: the actor MAY resolve a comment that's only partially fixed, and the next iteration's CR re-review re-opens it. This is acceptable; CR's re-review is the ground truth.

### 4.5 Reflect

`Actor.reflect` per `src/runtime/actors/actor.ts:109-113` is `reflect(outcomes, classified, ctx)` -- three parameters. The `classified` arg is load-bearing because reflect reads `classified.observation` to compare against post-apply state when the actor needs the prior observation snapshot for diff. We use it to make the `'all-clean'` -> `done: true` decision.

```ts
async reflect(
  outcomes: ReadonlyArray<PrFixOutcome>,
  classified: Classified<PrFixObservation>,
  _ctx: ActorContext<PrFixAdapters>,
): Promise<Reflection> {
  const meta = (classified.metadata ?? {}) as { classification?: PrFixClassification };
  const cls = meta.classification ?? 'has-findings';
  if (cls === 'all-clean') {
    return { done: true, progress: false, note: 'all clean; nothing to fix' };
  }
  if (cls === 'partial') {
    // Do-not-decide signal: PrReviewStatus snapshot was incomplete.
    // Allow runActor's outer loop to retry observe on the next iteration.
    return { done: false, progress: false, note: 'partial observation; retrying' };
  }
  const fixPushed = outcomes.some(o => o.kind === 'fix-pushed');
  const escalated = outcomes.some(o => o.kind === 'escalated');
  const failed = outcomes.some(o => o.kind === 'fix-failed');
  if (escalated) {
    return {
      done: true,
      progress: false,
      note: outcomes.find(o => o.kind === 'escalated')?.reason ?? '',
    };
  }
  if (failed) {
    return {
      done: false,
      progress: false,
      note: outcomes.find(o => o.kind === 'fix-failed')?.reason ?? '',
    };
  }
  if (fixPushed) {
    // Some fix landed. Outer loop's next observe will check whether
    // findings were actually reduced; runActor's convergence-key guard
    // halts on no-progress same-count repeats.
    return { done: false, progress: true, note: 'fix pushed; reobserving' };
  }
  return { done: false, progress: false, note: 'no progress' };
}
```

---

## 5. Error handling

| Condition | Outcome | Reflection |
|---|---|---|
| `agent-loop.run()` -> `kind: 'completed'` + valid commit + at least one path touched | `{kind: 'fix-pushed', commitSha, resolvedCommentIds}` | `{done: false, progress: true, note: 'fix pushed'}` |
| `kind: 'completed'` + no commit | `{kind: 'fix-failed', stage: 'agent-no-commit'}` | `{done: false, progress: false}` |
| `kind: 'completed'` + commit-SHA verification mismatch | `{kind: 'fix-failed', stage: 'verify-commit-sha'}` | `{done: false, progress: false}` |
| `kind: 'budget-exhausted'` | `{kind: 'fix-failed', stage: 'agent-loop/budget-exhausted'}` | `{done: false, progress: false}`; convergence-key halts after 2 iterations |
| `kind: 'error'` with `failure.kind: 'transient'` | `{kind: 'fix-failed', stage: 'agent-loop/transient'}` | `{done: false, progress: false}` (let outer loop retry) |
| `kind: 'error'` with `failure.kind: 'structural'` | `{kind: 'fix-failed', stage: 'agent-loop/structural'}` | `{done: false, progress: false}`; convergence halts |
| `kind: 'error'` with `failure.kind: 'catastrophic'` | `{kind: 'fix-failed', stage: 'agent-loop/catastrophic'}` | `{done: false, progress: false}`; runActor halts |
| `kind: 'aborted'` | propagate `AbortError` up; runActor halts | n/a |
| `classify` -> `'architectural'` | `{kind: 'escalated'}` | `{done: true, progress: false}` |
| `classify` -> `'ci-failure'` | `{kind: 'escalated'}` | `{done: true, progress: false}` |
| `classify` -> `'partial'` | n/a (no actions) | `{done: false, progress: false}`; next iteration retries observe |
| `workspaceProvider.acquire` throws | `{kind: 'fix-failed', stage: 'workspace-acquire'}` | `{done: false, progress: false}` |
| `reviewAdapter.resolveComment` throws | log + skip the resolve (the fix landed; thread state is recoverable manually); `Outcome.resolvedCommentIds` excludes the failed id | reflection unchanged |

---

## 6. Security + correctness

### 6.1 Threat model

- **Workspace credentials.** `WorkspaceProvider` provisions the workspace with the bot creds (`lag-ceo`) the agent will use to push. Cred scope is the provider's responsibility (existing PR1 contract; cred-copy already implemented in `examples/workspace-providers/git-worktree/`).
- **Two policy layers.** `runActor`'s `checkToolPolicy` (Layer A, §3.4) gates the actor's own actions; `AgentLoopAdapter.toolPolicy.disallowedTools` (Layer B) gates the sub-agent's per-tool actions inside the workspace. Both are enforced; missing either is a substrate violation.
- **Redaction is mandatory.** Every payload (CR finding text, agent prompt, tool args/results) goes through `input.redactor.redact()` BEFORE atom write. Substrate-level invariant.
- **Commit-SHA verification is mandatory.** The substrate contract says "Consumers MUST verify the commit exists in the workspace before trusting it; an adapter could in principle return a stale or fabricated SHA." `PrFixActor.apply` runs `git rev-parse HEAD` in `workspace.path` before resolving any threads. SHA mismatch returns `{kind: 'fix-failed', stage: 'verify-commit-sha'}`. This closes the gap PR2's `AgenticCodeAuthorExecutor` left open by also implementing the same verification (the executor's gap is a separate substrate-discipline finding to flag in a follow-up).
- **Convergence guard is non-negotiable.** `runActor`'s no-progress halt (same `Classified.key` two iterations in a row with `progress: false`) prevents runaway agent-loop dispatch on a finding the agent can't fix. The classifier's key uses concrete numeric counts (NOT literal "N") so the halt fires correctly.
- **Prompt-injection defense is layered.** A malicious CR finding could attempt to instruct the agent to exfil. The redactor catches secret-shaped exfil at write time; the workspace boundary catches FS exfil; the Layer-B tool-policy catches tool exfil (`WebFetch`, `WebSearch` denied at the floor); the actor's Layer-A canon policy denies `pr-merge-*` so even a fully-compromised sub-agent cannot self-merge.
- **Push target is bounded.** The sub-agent's `Bash` tool can in principle run `git push <arbitrary-url>`, but the workspace's git remote is scoped to the operator's repo (cred-copied by `WorkspaceProvider`); the bot creds only authorize pushes to that repo's branches; the post-apply `git rev-parse HEAD` verification catches the case where the agent pushed somewhere unexpected (HEAD on the workspace branch wouldn't change).

### 6.2 Substrate-contract discipline

- Every plan task carries a "Security + correctness considerations" subsection that the implementer subagent walks through BEFORE writing code, not after CR flags it. Per memory `feedback_security_correctness_at_write_time`.
- TDD strict order: failing test first per task.
- Bot-identity attribution: every commit + push via `git-as` / `gh-as` lag-ceo. NEVER bare `git push`.
- Pre-push grep for emdashes / private terms / design refs / canon-id leaks (per `feedback_pre_push_grep_checklist`).

---

## 7. Phasing

Single PR for this design. Decomposes into ~12 plan tasks:
1. Substrate change: extend `WorkspaceProvider.AcquireInput` with `checkoutBranch?` + propagate through types.
2. Reference adapter change: `examples/workspace-providers/git-worktree/` honors `checkoutBranch`.
3. Test the substrate change.
4. New atom-type entry: `'pr-fix-observation'` on the `AtomType` union; add `PrFixObservationMeta` interface.
5. `PrFixActor.observe` + `pr-fix-observation` atom write.
6. `PrFixActor.classify` (with concrete numeric counts in the convergence key + the architectural heuristic).
7. `PrFixActor.propose`.
8. `PrFixActor.apply` -- agent-loop-dispatch path: workspace acquire, agent-loop run, commit-SHA verification, thread-resolution.
9. `PrFixActor.apply` -- pr-escalate path.
10. `PrFixActor.reflect`.
11. `bootstrap-pr-fix-canon.mjs` + `run-pr-fix.mjs`.
12. E2E test on `MemoryHost` with stub adapters; pre-push validation; open PR.

**Out of scope, deferred to follow-ups:**
- CI workflow integration. Operator validates dry-runs locally first, then a separate PR adds `pr-fix.yml` (or extends `pr-landing.yml` with a sibling job).
- Auto-merge after APPROVED. Operator-gated for now; the actor's canon policy explicitly denies `pr-merge-*`.
- Fork PR support. Same restriction `PrLandingActor` already carries.
- `AgenticCodeAuthorExecutor` (PR #167) commit-SHA verification gap. Surfaced here for a separate substrate-discipline follow-up; PrFixActor implements verification correctly so PrFix's behavior is sound regardless.
- Strict replay tier (canon snapshot pinning) for `agent-session` atoms.

---

## 8. Provenance

**Canon directives this design respects:**
- `dev-substrate-not-prescription`: framework code in `src/` stays mechanism-only; the actor lives in `src/runtime/actors/pr-fix/` (consumer of the substrate). The substrate extension (§3.1) is a single optional field, additive, follows the same "concrete adapters in `examples/`" discipline.
- `simple-surface-deep-architecture`: one new actor + one new atom type + one optional substrate field; no new substrate seams.
- `dev-flag-structural-concerns-proactively`: §3.1 explicitly surfaces the substrate extension as a load-bearing change and documents WHY a checkout-existing-branch shape is required for PR-fix workflow. §6.1 calls out PR2's commit-SHA verification gap as a separate follow-up.
- `inv-provenance-every-write`: every atom carries `provenance.derived_from` (§3.3 specifies the chain for `pr-fix-observation`).
- `inv-governance-before-autonomy`: two explicit policy layers (§3.4); both are seeded by canon; neither has a default-allow.
- `dev-extreme-rigor-and-research`: this revised design covers the spec-reviewer's 10 issues with explicit picks: Reflection shape (§4.5), Outcome type (§3.2), thread-resolution heuristic (§4.4.1), commit-SHA verification (§4.4 step 6 + §6.1), `baseRef` semantics (§3.1 + §4.4 step 1), `PrReviewStatus` field shapes (§3.2 PrFixObservation, no premature reduction), convergence-key interpolation (§4.2), atom envelope (§3.3), two policy layers (§3.4), adapter method names (`resolveComment` not `resolveThread`).
- `dev-no-hacks-without-approval`: §6.1 documents every threat-model gap explicitly.
- `dev-forward-thinking-no-regrets`: substrate extension is additive; existing consumers (PrAgenticCodeAuthor) unaffected; operator policy controls rollout.

**Atoms / memory / prior PRs:**
- PRs #166, #167, #168, #169 -- this PR composes their seams.
- Existing `PrLandingActor` + `PrReviewAdapter` -- sibling pattern + shared adapter.
- Memory: `feedback_security_correctness_at_write_time`, `feedback_pre_push_grep_checklist`, `feedback_never_github_actions_as_operator`, `feedback_lint_ci_fidelity_discipline`.

---

## 9. What breaks if we revisit

- **CR's body-finding format changes** -- the architectural classifier (§4.2.2) reads CR's `🟠 Major / Architectural` markers. If CR changes the wording, the classifier's `architectural` branch falls back to `'has-findings'` (graceful degradation; the agent attempts the fix; if the fix was wrong, the next iteration's CR re-review surfaces it).
- **Agent-loop adapter contract changes** -- the actor depends on the PR1 seam. Substrate is versioned; major changes surface as TS errors, not silent drift.
- **`PrReviewAdapter` adds new finding types** -- the actor's classify defaults to `'has-findings'` when none of the explicit branches match (graceful).
- **Operator wants auto-merge** -- the `pr-merge-*` canon deny is removable per-deployment. The merge call itself is a follow-up PR.
- **`WorkspaceProvider.AcquireInput.checkoutBranch` provider doesn't support it** -- TS makes this a compile error (the field is optional in the input but required to be honored when set; reference adapter implements it; third-party providers MUST implement). Documented as a contract requirement on the substrate.
