# PrFixActor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a sibling outward Actor (`PrFixActor`) that consumes the agent-loop substrate (PR #166) to autonomously drive a PR through CR review feedback to a clean state. Replaces today's hand-rolled CR-fix loop with a real actor + audit trail in `agent-session` / `agent-turn` atoms.

**Architecture:** New actor at `src/runtime/actors/pr-fix/` composing `PrReviewAdapter` + `AgentLoopAdapter` + `WorkspaceProvider` + `BlobStore` + `Redactor`. Adds one optional substrate field (`AcquireInput.checkoutBranch?`) so the workspace can pin to the PR's HEAD branch (commits land on it; pushed back to update the PR). New atom type `pr-fix-observation` records each iteration. Two policy layers: `runActor`'s `checkToolPolicy` for actor actions + `AgentLoopAdapter.toolPolicy.disallowedTools` for the spawned sub-agent.

**Tech Stack:** Node.js, TypeScript, `execa`, `vitest`. Substrate types from `src/substrate/`. Existing `PrReviewAdapter` from PR #167. Existing `ClaudeCodeAgentLoopAdapter` from PR #168. Existing `git-as.mjs` (token-leak fix from PR #169).

**Spec source of truth:** `docs/superpowers/specs/2026-04-25-pr-fix-actor-design.md` (committed at `6ad7c7b`).

**Branch:** `feat/pr-fix-actor` (off main; spec already committed).

**Discipline:** Every task carries a "Security + correctness considerations" subsection. Walk through it BEFORE writing code, not after CR flags it (per memory `feedback_security_correctness_at_write_time`). Same discipline as PRs #166-#168.

---

## File structure

**Substrate (small additive change):**
- Modify: `src/substrate/workspace-provider.ts` -- add `checkoutBranch?: string` to `AcquireInput`.

**Reference adapter:**
- Modify: `examples/workspace-providers/git-worktree/index.ts` (or split file in same dir) -- honor `checkoutBranch`.
- Modify: `test/examples/git-worktree-provider.test.ts` -- new test for `acquire({checkoutBranch})`.

**Atom types:**
- Modify: `src/substrate/types.ts` -- add `'pr-fix-observation'` to the `AtomType` union; add `PrFixObservationMeta` interface.

**Actor:**
- Create: `src/runtime/actors/pr-fix/types.ts` -- `PrFixObservation`, `PrFixClassification`, `PrFixAction`, `PrFixOutcome`, `PrFixAdapters`.
- Create: `src/runtime/actors/pr-fix/pr-fix-observation.ts` -- atom helpers (`mkPrFixObservationAtom`, `patchDispatchedSession`, `renderObservationContent`).
- Create: `src/runtime/actors/pr-fix/pr-fix.ts` -- the actor class (observe/classify/propose/apply/reflect).
- Create: `src/runtime/actors/pr-fix/index.ts` -- barrel.
- Create: `test/runtime/actors/pr-fix/pr-fix.test.ts` -- unit + integration tests.

**Scripts:**
- Create: `scripts/bootstrap-pr-fix-canon.mjs` -- operator-seeded Layer-A policy atoms.
- Create: `scripts/run-pr-fix.mjs` -- driver mirroring `run-pr-landing.mjs`.
- Create: `test/scripts/bootstrap-pr-fix-canon.test.ts` -- (deferred; if time permits, otherwise skip and verify by running the script).

---

## Task 1: Substrate -- extend `WorkspaceProvider.AcquireInput.checkoutBranch?`

**Files:**
- Modify: `src/substrate/workspace-provider.ts`
- Test: `test/substrate/workspace-provider.test.ts`

**Security + correctness considerations:**
- Additive optional field; backwards-compatible for every existing consumer.
- Documenting the contract: when `checkoutBranch` is set, the provider checks out an EXISTING branch in the workspace (no `-b`). When unset, behavior is unchanged: the provider creates a new branch off `baseRef`.
- `Workspace.baseRef` keeps its meaning (comparison baseline). Verifying-commit consumers (PR2's `captureArtifacts`, this PR's commit-SHA verification) continue to work without change.
- Prototype-pollution / argv-injection: no change. The branch name flows into provider-internal git argv eventually; the provider's existing input sanitization (per PR1) carries through.

- [ ] **Step 1: Add the failing test**

Append to `test/substrate/workspace-provider.test.ts`:

```ts
it('AcquireInput accepts optional checkoutBranch', () => {
  const input: AcquireInput = {
    principal: 'p' as PrincipalId,
    baseRef: 'main',
    correlationId: 'corr-1',
    checkoutBranch: 'feat/x',
  };
  expect(input.checkoutBranch).toBe('feat/x');
});

it('AcquireInput.checkoutBranch is optional', () => {
  const input: AcquireInput = {
    principal: 'p' as PrincipalId,
    baseRef: 'main',
    correlationId: 'corr-1',
  };
  expect(input.checkoutBranch).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail (compile error: unknown field)**

Run: `npx vitest run test/substrate/workspace-provider.test.ts`
Expected: FAIL with TS error about `checkoutBranch`.

- [ ] **Step 3: Add the field to `AcquireInput`**

In `src/substrate/workspace-provider.ts`, extend `AcquireInput`:

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
   * default, matching PR2's AgenticCodeAuthorExecutor flow).
   *
   * Providers that do not support checking out an existing branch MUST
   * throw with a recognizable error rather than silently fall through
   * to baseRef behavior; that would let a caller think it got the
   * pinned branch when it did not.
   */
  readonly checkoutBranch?: string;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/substrate/workspace-provider.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
node scripts/git-as.mjs lag-ceo add src/substrate/workspace-provider.ts test/substrate/workspace-provider.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(substrate): WorkspaceProvider.AcquireInput.checkoutBranch? optional field"
```

---

## Task 2: Reference adapter -- `git-worktree` honors `checkoutBranch`

**Files:**
- Modify: `examples/workspace-providers/git-worktree/` (find the adapter file; likely `index.ts` or `git-worktree-provider.ts`)
- Modify: `test/examples/git-worktree-provider.test.ts`

**Security + correctness considerations:**
- The check-out-existing branch path MUST not silently `git fetch` adversarial refs. Use `git fetch origin <branch>` and let it fail-fast when the branch doesn't exist remotely OR locally; do NOT fall back to baseRef silently.
- Cred-copy step (per memory `feedback_bot_creds_copy_to_new_worktrees`) MUST happen on this code path too. The new branch in the workspace pushes back via the same bot creds; missing the cred-copy would surface as auth failures at push time.
- The branch-name input flows into argv. execa with array-form args prevents shell injection. Branch names CAN contain `/` (`feat/x`) and `.` (`v1.2`); reject only `..` segments and absolute paths.
- A branch that exists ONLY remotely needs `git fetch origin <branch>:<branch>` followed by `git worktree add <path> <branch>`; that's two execa calls but matches existing patterns.

- [ ] **Step 1: Add the failing test**

Append to `test/examples/git-worktree-provider.test.ts`:

```ts
describe('GitWorktreeProvider checkoutBranch', () => {
  it('checks out an existing local branch (does NOT pass -b to worktree add)', async () => {
    // Set up: create a real git repo with branch 'feat/x' present.
    const dir = await mkdtemp(join(tmpdir(), 'lag-checkout-'));
    await execa('git', ['init', '-b', 'main'], { cwd: dir });
    await execa('git', ['config', 'user.email', 't@e.com'], { cwd: dir });
    await execa('git', ['config', 'user.name', 'Test'], { cwd: dir });
    await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    await writeFile(join(dir, 'a.md'), 'a\n');
    await execa('git', ['add', '.'], { cwd: dir });
    await execa('git', ['commit', '-m', 'initial'], { cwd: dir });
    await execa('git', ['branch', 'feat/x'], { cwd: dir });

    // Spy on the execa wrapper used by the provider so we can read argv.
    const calls: Array<{ args: ReadonlyArray<string> }> = [];
    const provider = createGitWorktreeProvider({
      repoDir: dir,
      execImpl: ((async (_bin: string, args: ReadonlyArray<string>, opts: unknown) => {
        calls.push({ args: args.slice() });
        // Dispatch back to real execa so the worktree actually gets created.
        return execa('git', args, opts as unknown as undefined);
      }) as never),
      // ... cred-copy stubs etc.
    });
    const ws = await provider.acquire({
      principal: 'p' as PrincipalId,
      baseRef: 'main',
      correlationId: 'corr-1',
      checkoutBranch: 'feat/x',
    });
    try {
      // Assert worktree HEAD is on the existing branch
      const r = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ws.path });
      expect(r.stdout.trim()).toBe('feat/x');
      // Regression assertion: worktree add MUST NOT have used -b
      const addCalls = calls.filter(c => c.args[0] === 'worktree' && c.args[1] === 'add');
      for (const c of addCalls) {
        expect(c.args).not.toContain('-b');
      }
    } finally {
      await provider.release(ws);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/examples/git-worktree-provider.test.ts`
Expected: FAIL (provider doesn't honor `checkoutBranch` yet).

- [ ] **Step 3: Implement `checkoutBranch` handling in the provider**

In the provider's `acquire()` method, branch on `input.checkoutBranch`:

```ts
async acquire(input: AcquireInput): Promise<Workspace> {
  // ... existing setup: workspacePath, sanitizeId, cred-copy ...
  if (input.checkoutBranch !== undefined && input.checkoutBranch.length > 0) {
    // Reject obviously bogus branch names (defense-in-depth; execa array
    // form already prevents shell injection).
    if (input.checkoutBranch.includes('..')) {
      throw new Error(`checkoutBranch must not contain '..': ${input.checkoutBranch}`);
    }
    // Try to fetch first so a branch present only on origin still works.
    // Failure is non-fatal: a fully-local branch will still resolve.
    await this.execImpl('git', ['fetch', 'origin', input.checkoutBranch], { cwd: this.repoDir, reject: false });
    // Worktree add WITHOUT -b: this checks out an existing branch in
    // the workspace path. The branch name itself becomes the workspace's
    // current branch.
    await this.execImpl('git', ['worktree', 'add', workspacePath, input.checkoutBranch], { cwd: this.repoDir });
  } else {
    // Existing default: create a new branch off baseRef.
    await this.execImpl('git', ['worktree', 'add', '-b', sanitizeId(input.correlationId), workspacePath, input.baseRef], { cwd: this.repoDir });
  }
  // ... existing cred-copy step ...
  return { id: workspaceId, path: workspacePath, baseRef: input.baseRef };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/examples/git-worktree-provider.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
node scripts/git-as.mjs lag-ceo add examples/workspace-providers/git-worktree/ test/examples/git-worktree-provider.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(workspace-providers/git-worktree): honor AcquireInput.checkoutBranch"
```

---

## Task 3: Add `pr-fix-observation` atom type

**Files:**
- Modify: `src/substrate/types.ts`
- Test: `test/substrate/types.test.ts` (or add a focused atom-type test)

**Security + correctness considerations:**
- Additive entry on the discriminated union; downstream code in projections / arbitration / decay machinery already handles unknown-to-them types via the same fall-through pattern as PR1's `agent-session` / `agent-turn`.
- Metadata shape uses `Readonly<Record<string, unknown>>` for the `extra` slot so adapter-specific fields can be carried without forking the type.
- `dispatched_session_atom_id` is optional. The actor patches it onto the atom AFTER `apply()` runs (via `host.atoms.update`); the initial atom written in `observe()` does not have it set.

- [ ] **Step 1: Write the failing test**

In `test/substrate/types.test.ts` (or a new test):

```ts
import { describe, it, expect } from 'vitest';
import type { AtomType, PrFixObservationMeta } from '../../src/substrate/types.js';

describe('pr-fix-observation atom type', () => {
  it('appears in AtomType union', () => {
    const t: AtomType = 'pr-fix-observation';
    expect(t).toBe('pr-fix-observation');
  });

  it('PrFixObservationMeta has the expected shape', () => {
    const meta: PrFixObservationMeta = {
      pr_owner: 'o', pr_repo: 'r', pr_number: 1,
      head_branch: 'feat/x', head_sha: 'abc',
      cr_review_states: [],
      merge_state_status: null, mergeable: null,
      line_comment_count: 0, body_nit_count: 0,
      check_run_failure_count: 0, legacy_status_failure_count: 0,
      partial: false, classification: 'all-clean',
    };
    expect(meta.classification).toBe('all-clean');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/substrate/types.test.ts`
Expected: FAIL (type/symbol not exported).

- [ ] **Step 3: Add `pr-fix-observation` to `AtomType` + `PrFixObservationMeta` interface**

In `src/substrate/types.ts`, locate the `AtomType` union and add `'pr-fix-observation'`. Add the metadata interface near the existing `AgentSessionMeta` / `AgentTurnMeta` definitions:

```ts
export interface PrFixObservationMeta {
  readonly pr_owner: string;
  readonly pr_repo: string;
  readonly pr_number: number;
  readonly head_branch: string;
  readonly head_sha: string;
  readonly cr_review_states: ReadonlyArray<{ readonly author: string; readonly state: string; readonly submitted_at: string }>;
  readonly merge_state_status: string | null;
  readonly mergeable: boolean | null;
  readonly line_comment_count: number;
  readonly body_nit_count: number;
  readonly check_run_failure_count: number;
  readonly legacy_status_failure_count: number;
  readonly partial: boolean;
  readonly classification: 'all-clean' | 'has-findings' | 'ci-failure' | 'architectural' | 'partial';
  readonly dispatched_session_atom_id?: AtomId;
  readonly extra?: Readonly<Record<string, unknown>>;
}
```

Also extend `DEFAULT_HALF_LIVES`, `TYPE_ORDER`, and `TYPE_HEADINGS` to include the new entry (mirror what PR1 did for `agent-session` / `agent-turn`). Find the existing entries via grep.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/substrate/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
node scripts/git-as.mjs lag-ceo add src/substrate/types.ts test/substrate/types.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(substrate): pr-fix-observation atom type + PrFixObservationMeta"
```

---

## Task 4: Actor types

**Files:**
- Create: `src/runtime/actors/pr-fix/types.ts`

**Security + correctness considerations:**
- Discriminated unions on `PrFixAction` and `PrFixOutcome` use string literal tags so TS exhaustiveness checks catch a missing branch in `apply` / `reflect`.
- `PrFixOutcome.kind: 'fix-failed'` carries `stage: string` so the dashboard can read the failure category without a free-form string match.
- `PrFixAdapters.review` uses the existing `PrReviewAdapter` (shared with `PrLandingActor`); `agentLoop`, `workspaceProvider`, `blobStore`, `redactor` all come from the substrate.

- [ ] **Step 1: Write the failing test**

Append to `test/runtime/actors/pr-fix/pr-fix.test.ts` (create the file):

```ts
import { describe, it, expect } from 'vitest';
import type { PrFixObservation, PrFixAction, PrFixOutcome, PrFixAdapters } from '../../../../src/runtime/actors/pr-fix/types.js';
import type { AtomId } from '../../../../src/substrate/types.js';

describe('PrFixActor types', () => {
  it('PrFixAction is a discriminated union of agent-loop-dispatch / pr-escalate', () => {
    const a: PrFixAction = { kind: 'agent-loop-dispatch', findings: [], planAtomId: 'plan-x' as AtomId, headBranch: 'feat/x' };
    const b: PrFixAction = { kind: 'pr-escalate', reason: 'CI failure' };
    expect(a.kind).toBe('agent-loop-dispatch');
    expect(b.kind).toBe('pr-escalate');
  });

  it('PrFixOutcome has fix-pushed / fix-failed / escalated variants', () => {
    const a: PrFixOutcome = { kind: 'fix-pushed', commitSha: 'abc', resolvedCommentIds: [], sessionAtomId: 's1' as AtomId };
    const b: PrFixOutcome = { kind: 'fix-failed', stage: 'verify-commit-sha', reason: 'mismatch', sessionAtomId: 's1' as AtomId };
    const c: PrFixOutcome = { kind: 'escalated', reason: 'arch' };
    expect([a.kind, b.kind, c.kind]).toEqual(['fix-pushed', 'fix-failed', 'escalated']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/runtime/actors/pr-fix/pr-fix.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the types**

Create `src/runtime/actors/pr-fix/types.ts`:

```ts
import type { PrIdentifier, PrReviewAdapter, ReviewComment, SubmittedReview, CheckRun, LegacyStatus } from '../pr-review/adapter.js';
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
  readonly [k: string]: unknown;  // tolerate ActorAdapters base shape
}

export interface PrFixObservation {
  readonly pr: PrIdentifier;
  readonly headBranch: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly lineComments: ReadonlyArray<ReviewComment>;
  readonly bodyNits: ReadonlyArray<ReviewComment>;
  readonly submittedReviews: ReadonlyArray<SubmittedReview>;
  readonly checkRuns: ReadonlyArray<CheckRun>;
  readonly legacyStatuses: ReadonlyArray<LegacyStatus>;
  readonly mergeStateStatus: string | null;
  readonly mergeable: boolean | null;
  readonly partial: boolean;
  readonly observationAtomId: AtomId;
}

export type PrFixClassification = 'all-clean' | 'has-findings' | 'ci-failure' | 'architectural' | 'partial';

export type PrFixAction =
  | {
      readonly kind: 'agent-loop-dispatch';
      readonly findings: ReadonlyArray<ReviewComment>;
      readonly planAtomId: AtomId;
      readonly headBranch: string;
    }
  | {
      readonly kind: 'pr-escalate';
      readonly reason: string;
    };

export type PrFixOutcome =
  | {
      readonly kind: 'fix-pushed';
      readonly commitSha: string;
      readonly resolvedCommentIds: ReadonlyArray<string>;
      readonly sessionAtomId: AtomId;
    }
  | {
      readonly kind: 'fix-failed';
      readonly stage: string;
      readonly reason: string;
      readonly sessionAtomId: AtomId | null;
    }
  | {
      readonly kind: 'escalated';
      readonly reason: string;
    };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/runtime/actors/pr-fix/pr-fix.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
node scripts/git-as.mjs lag-ceo add src/runtime/actors/pr-fix/types.ts test/runtime/actors/pr-fix/pr-fix.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(pr-fix-actor): types module"
```

---

## Task 5: `pr-fix-observation` atom helpers

**Files:**
- Create: `src/runtime/actors/pr-fix/pr-fix-observation.ts`
- Modify: `test/runtime/actors/pr-fix/pr-fix.test.ts`

**Security + correctness considerations:**
- Atom envelope MUST set `principal_id: 'pr-fix-actor'` so the audit trail correctly attributes to the actor's principal.
- `provenance.derived_from` chain MUST include the prior-iteration's observation when one exists. The function takes `priorObservationAtomId?` and threads it.
- `content` body is a short prose summary; redaction is NOT applied here because the atom records OBSERVATION state, which is structurally fixed (CR review states, counts) and not LLM-derived. If a finding's body contains a secret, it lives only in CR's atom-store-external surface; `pr-fix-observation` doesn't carry the body text.

- [ ] **Step 1: Write failing test**

Append to `test/runtime/actors/pr-fix/pr-fix.test.ts`:

```ts
describe('mkPrFixObservationAtom', () => {
  it('builds an L0 agent-observed atom with the expected metadata + chain', () => {
    const atom = mkPrFixObservationAtom({
      principal: 'pr-fix-actor' as PrincipalId,
      observationId: 'pr-fix-obs-1' as AtomId,
      meta: { /* ... full PrFixObservationMeta ... */ },
      priorObservationAtomId: 'pr-fix-obs-0' as AtomId,
      dispatchedSessionAtomId: undefined,
      now: '2026-04-25T00:00:00.000Z',
    });
    expect(atom.type).toBe('pr-fix-observation');
    expect(atom.layer).toBe('L0');
    expect(atom.scope).toBe('project');
    expect(atom.principal_id).toBe('pr-fix-actor');
    expect(atom.provenance.derived_from).toContain('pr-fix-obs-0');
  });
});
```

- [ ] **Step 2: Run + verify fail.**

- [ ] **Step 3: Implement**

Create `src/runtime/actors/pr-fix/pr-fix-observation.ts`:

```ts
import type { Atom, AtomId, PrincipalId, PrFixObservationMeta } from '../../../substrate/types.js';

export function mkPrFixObservationAtom(input: {
  readonly principal: PrincipalId;
  readonly observationId: AtomId;
  readonly meta: PrFixObservationMeta;
  readonly priorObservationAtomId: AtomId | undefined;
  readonly dispatchedSessionAtomId: AtomId | undefined;
  readonly now: string;
}): Atom {
  const derived: AtomId[] = [];
  if (input.priorObservationAtomId !== undefined) derived.push(input.priorObservationAtomId);
  if (input.dispatchedSessionAtomId !== undefined) derived.push(input.dispatchedSessionAtomId);
  const m: PrFixObservationMeta = {
    ...input.meta,
    ...(input.dispatchedSessionAtomId !== undefined ? { dispatched_session_atom_id: input.dispatchedSessionAtomId } : {}),
  };
  return {
    schema_version: 1,
    id: input.observationId,
    content: renderObservationContent(input.meta),
    type: 'pr-fix-observation',
    layer: 'L0',
    provenance: { kind: 'agent-observed', source: { agent_id: input.principal as unknown as string }, derived_from: derived },
    confidence: 1,
    created_at: input.now,
    last_reinforced_at: input.now,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
    principal_id: input.principal,
    taint: 'clean',
    metadata: { pr_fix_observation: m },
  };
}

export function renderObservationContent(meta: PrFixObservationMeta): string {
  return `pr-fix observation: PR ${meta.pr_owner}/${meta.pr_repo}#${meta.pr_number} head=${meta.head_sha.slice(0, 7)} classification=${meta.classification} line_comments=${meta.line_comment_count} body_nits=${meta.body_nit_count}`;
}

export function mkPrFixObservationAtomId(prefix: string = 'pr-fix-obs'): AtomId {
  return `${prefix}-${Math.random().toString(36).slice(2, 14)}` as AtomId;
}
```

- [ ] **Step 4: Run + verify pass.**

- [ ] **Step 5: Commit**

```bash
node scripts/git-as.mjs lag-ceo add src/runtime/actors/pr-fix/pr-fix-observation.ts test/runtime/actors/pr-fix/pr-fix.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(pr-fix-actor): observation atom helpers"
```

---

## Task 6: `PrFixActor.observe`

**Files:**
- Modify: `src/runtime/actors/pr-fix/pr-fix.ts` (create)
- Modify: `test/runtime/actors/pr-fix/pr-fix.test.ts`

**Security + correctness considerations:**
- `observe` writes an atom BEFORE returning, so partial observations are still in the audit trail. A later iteration can examine them.
- The PR's HEAD branch + SHA are read from `ghClient` via `pulls.get`. If the API call fails, `partial: true` propagates and `classify` short-circuits to `'partial'`.
- `PrReviewStatus.partial` propagates through. Caller (classify) treats it as "do not decide".

- [ ] **Step 1: Write failing test** for `PrFixActor.observe` returning a `PrFixObservation` and writing the atom.

```ts
it('observe writes a pr-fix-observation atom with the PR state', async () => {
  const host = createMemoryHost();
  const stubReview: PrReviewAdapter = {
    listUnresolvedComments: async () => [],
    replyToComment: async () => ({ ok: true } as never),
    resolveComment: async () => undefined,
    getPrReviewStatus: async () => ({
      pr: { owner: 'o', repo: 'r', number: 1 } as never,
      mergeable: true, mergeStateStatus: 'CLEAN',
      lineComments: [], bodyNits: [], submittedReviews: [],
      checkRuns: [], legacyStatuses: [], partial: false,
    }),
  } as never;
  // ...stub ghClient, etc.
  const actor = new PrFixActor({ pr: { owner: 'o', repo: 'r', number: 1 } });
  const ctx = makeStubCtx({ host, adapters: { review: stubReview, ...stubs } });
  const obs = await actor.observe(ctx);
  expect(obs.partial).toBe(false);
  const atoms = (await host.atoms.query({ type: ['pr-fix-observation'] }, 100)).atoms;
  expect(atoms.length).toBe(1);
});
```

- [ ] **Step 2: Run + verify fail.**

- [ ] **Step 3: Implement `observe` in `pr-fix.ts`**

```ts
async observe(ctx: ActorContext<PrFixAdapters>): Promise<PrFixObservation> {
  const { review, ghClient } = ctx.adapters;
  const status = await review.getPrReviewStatus(this.pr);
  // Get head branch + SHA from gh API. ghClient.rest({op: 'pulls.get', ...}).
  const prDetails = await ghClient.rest!({ op: 'pulls.get', owner: this.pr.owner, repo: this.pr.repo, pull_number: this.pr.number } as never) as { head: { ref: string; sha: string }; base: { ref: string } };
  const obsId = mkPrFixObservationAtomId();
  const meta: PrFixObservationMeta = {
    pr_owner: this.pr.owner, pr_repo: this.pr.repo, pr_number: this.pr.number,
    head_branch: prDetails.head.ref, head_sha: prDetails.head.sha,
    cr_review_states: status.submittedReviews.map(r => ({ author: r.author, state: r.state, submitted_at: r.submittedAt })),
    merge_state_status: status.mergeStateStatus,
    mergeable: status.mergeable,
    line_comment_count: status.lineComments.length,
    body_nit_count: status.bodyNits.length,
    check_run_failure_count: status.checkRuns.filter(c => c.status === 'completed' && c.conclusion === 'failure').length,
    legacy_status_failure_count: status.legacyStatuses.filter(s => s.state === 'failure' || s.state === 'error').length,
    partial: status.partial,
    classification: 'has-findings',  // placeholder; classify replaces
  };
  const atom = mkPrFixObservationAtom({
    principal: this.principal, observationId: obsId, meta,
    priorObservationAtomId: this.lastObservationId, dispatchedSessionAtomId: undefined,
    now: new Date().toISOString(),
  });
  await ctx.host.atoms.put(atom);
  this.lastObservationId = obsId;
  return {
    pr: this.pr, headBranch: prDetails.head.ref, headSha: prDetails.head.sha, baseRef: prDetails.base.ref,
    lineComments: status.lineComments, bodyNits: status.bodyNits,
    submittedReviews: status.submittedReviews, checkRuns: status.checkRuns, legacyStatuses: status.legacyStatuses,
    mergeStateStatus: status.mergeStateStatus, mergeable: status.mergeable, partial: status.partial,
    observationAtomId: obsId,
  };
}
```

(Class skeleton: `name = 'pr-fix-actor'`, `version = '1'`, constructor `{pr}`, `lastObservationId?: AtomId`. Other lifecycle methods land in subsequent tasks.)

- [ ] **Step 4: Run + verify pass.**

- [ ] **Step 5: Commit**

```bash
node scripts/git-as.mjs lag-ceo add src/runtime/actors/pr-fix/pr-fix.ts test/runtime/actors/pr-fix/pr-fix.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(pr-fix-actor): observe + write pr-fix-observation atom"
```

---

## Task 7: `PrFixActor.classify`

**Files:**
- Modify: `src/runtime/actors/pr-fix/pr-fix.ts`
- Modify: `test/runtime/actors/pr-fix/pr-fix.test.ts`

**Security + correctness considerations:**
- The convergence key uses concrete numeric counts (interpolation, NOT literal `N`). Same key twice with `progress: false` halts the loop via `runActor`.
- The architectural-vs-other discriminator MUST default to `has-findings` when uncertain (avoid false-positive escalation; CR re-review will surface a missed-fix).
- Pending `LegacyStatus` (state `pending`) is NOT a failure (it can resolve). Pending `CheckRun` (status `queued|in_progress`) is NOT a failure. Only `completed` + `failure`/`error` count.

- [ ] **Step 1-5: Write tests + impl + commit.**

Tests cover: `'all-clean'` when zero findings + zero CI failures; `'partial'` when `obs.partial`; `'ci-failure'` when a check-run conclusion is `failure`; `'architectural'` when CR's body contains the orange-circle major marker + `architectural`; `'has-findings'` otherwise; convergence key includes all counts.

Implementation per spec §4.2 with the helper functions `countCiFailures`, `countArchitectural`, `summarizeReviewState`. Match the actual `Classified<Obs>` shape (`{observation, key, metadata}`).

```bash
node scripts/git-as.mjs lag-ceo commit -m "feat(pr-fix-actor): classify with concrete-count convergence key"
```

---

## Task 8: `PrFixActor.propose`

**Files:**
- Modify: `src/runtime/actors/pr-fix/pr-fix.ts`
- Modify: `test/runtime/actors/pr-fix/pr-fix.test.ts`

**Security + correctness considerations:**
- `tool` field on the `ProposedAction` MUST match the canon policy atom names (`agent-loop-dispatch`, `pr-escalate`). A typo here silently disables the policy gate.
- `findings` are the unresolved threads from the observation; `path` and `line` flow through unchanged for the agent's prompt + later thread-resolution heuristic.

- [ ] **Step 1-5: Write tests + impl + commit.**

Test cases: `'all-clean'` -> `[]`; `'has-findings'` -> one `agent-loop-dispatch` action with the correct findings + planAtomId + headBranch; `'ci-failure'` and `'architectural'` -> one `pr-escalate` action.

```bash
node scripts/git-as.mjs lag-ceo commit -m "feat(pr-fix-actor): propose"
```

---

## Task 9: `PrFixActor.apply` -- agent-loop-dispatch path

**Files:**
- Modify: `src/runtime/actors/pr-fix/pr-fix.ts`
- Modify: `test/runtime/actors/pr-fix/pr-fix.test.ts`

**Security + correctness considerations:**
- Workspace acquire passes `checkoutBranch: action.headBranch` so the agent commits ON the PR's HEAD branch (per substrate extension Task 1).
- After agent-loop returns `'completed'`, run `git rev-parse HEAD` in workspace and assert it matches `result.artifacts.commitSha`. Mismatch -> `{kind: 'fix-failed', stage: 'verify-commit-sha'}`. **This closes the substrate-mandated verification gap.**
- Thread-resolution uses `git diff --name-only <baseRef>..HEAD` -> the touched-paths set. For each finding `f`, resolve via `reviewAdapter.resolveComment(pr, f.id)` ONLY IF `f.path` is in the touched-paths set.
- Sub-agent `disallowedTools` includes `WebFetch`, `WebSearch`, `NotebookEdit` floor (Layer B per spec §3.4). Operators can extend via actor config.
- Workspace release runs in a `finally`. A release error MUST NOT mask the upstream success/error.

- [ ] **Step 1-5: Write tests + impl + commit.**

Tests cover: happy path (completed + commit verified + threads resolved); SHA mismatch (`fix-failed` with stage `verify-commit-sha`); no-commit case (`fix-failed` stage `agent-no-commit`); transient failure (`fix-failed` stage `agent-loop/transient`); workspace acquire failure.

Implementation per spec §4.4 + §4.4.1.

```bash
node scripts/git-as.mjs lag-ceo commit -m "feat(pr-fix-actor): apply agent-loop-dispatch with commit-SHA verification + thread resolution"
```

---

## Task 10: `PrFixActor.apply` -- pr-escalate path

**Files:**
- Modify: `src/runtime/actors/pr-fix/pr-fix.ts`
- Modify: `test/runtime/actors/pr-fix/pr-fix.test.ts`

**Security + correctness considerations:**
- Use the existing `sendOperatorEscalation` helper from `src/runtime/actor-message/`. Don't reinvent.
- Escalation reason MUST include enough context (CI failure names, architectural finding paths) so the operator can act without re-querying the PR.

- [ ] **Step 1-5: Write tests + impl + commit.** Returns `{kind: 'escalated', reason}`.

```bash
node scripts/git-as.mjs lag-ceo commit -m "feat(pr-fix-actor): apply pr-escalate path"
```

---

## Task 11: `PrFixActor.reflect`

**Files:**
- Modify: `src/runtime/actors/pr-fix/pr-fix.ts`
- Modify: `test/runtime/actors/pr-fix/pr-fix.test.ts`

**Security + correctness considerations:**
- Match the `Actor.reflect(outcomes, classified, ctx)` 3-param signature. The `classified` arg is load-bearing because reflect reads `classified.metadata.classification` to map `'all-clean'` / `'partial'` -> done states.
- Return `{done, progress, note}` matching the `Reflection` type. NOT a string.

- [ ] **Step 1-5: Write tests + impl + commit.** Implementation per spec §4.5.

Tests cover the 6 reflect outcomes: all-clean -> done:true progress:false; partial -> done:false progress:false; escalated -> done:true progress:false; failed -> done:false progress:false; fix-pushed -> done:false progress:true; empty outcomes (no actions proposed but not all-clean) -> done:false progress:false.

```bash
node scripts/git-as.mjs lag-ceo commit -m "feat(pr-fix-actor): reflect with classified-aware outcome mapping"
```

---

## Task 12: Driver script + canon bootstrap

**Files:**
- Create: `scripts/run-pr-fix.mjs`
- Create: `scripts/bootstrap-pr-fix-canon.mjs`

**Security + correctness considerations:**
- `run-pr-fix.mjs` defaults to dry-run. `--live` enables push + resolveComment.
- Kill-switch checks `.lag/STOP`. Touch that file to halt.
- Bootstrap script writes Layer-A canon policy atoms (per spec §3.4). Subject: `pr-fix-actor`. Default-deny catch-all per `dev-substrate-not-prescription` discipline.
- Both scripts go through `bot-identity` discipline -- the bootstrap script writes atoms via the operator's host (operator-attribution); the driver script's CR replies / thread-resolves go via lag-ceo's `gh-as`.

- [ ] **Step 1-5: Implement + smoke-test + commit.**

Mirror `scripts/run-pr-landing.mjs` structure. Mirror `scripts/bootstrap-pr-landing-canon.mjs` for the canon writes.

```bash
node scripts/git-as.mjs lag-ceo commit -m "feat(pr-fix-actor): driver script + canon bootstrap"
```

---

## Task 13: E2E + barrel + push + open PR + drive to merge

**Files:**
- Create: `src/runtime/actors/pr-fix/index.ts` (barrel)
- Modify: `src/runtime/actors/index.ts` (export PrFixActor)
- Modify: `test/runtime/actors/pr-fix/pr-fix.test.ts` (add full e2e on MemoryHost)

**Security + correctness considerations:**
- E2E test exercises the full chain: observe -> classify -> propose -> apply -> reflect, with stub `PrReviewAdapter` (canned `PrReviewStatus`) + stub `AgentLoopAdapter` (returns `kind: 'completed'` with synthetic `commitSha`) + stub `WorkspaceProvider` (in-memory path; records `acquire` calls including `checkoutBranch` -- regression-asserts that `checkoutBranch === observation.headBranch`).
- Pre-push grep for emdashes + private terms + design-refs in `src/` + AI-attribution leaks (per memory `feedback_pre_push_grep_checklist`).
- Push via `git-as lag-ceo` (no `-u`). Open PR via `gh-as lag-ceo`. Trigger CR. Drive findings to merge per the same pattern as PRs #166-#169.

- [ ] **Step 1: E2E test on MemoryHost.**

Asserts:
- One `pr-fix-observation` atom written per iteration.
- One `agent-session` atom + N `agent-turn` atoms per `apply()` call (via the stub adapter).
- `WorkspaceProvider.acquire()` received `checkoutBranch === observation.headBranch`.
- On `kind: 'completed'`: actor calls `git rev-parse HEAD` in workspace before resolving threads.
- On commit-SHA mismatch: `{kind: 'fix-failed', stage: 'verify-commit-sha'}`.
- Convergence regression: same finding-count two iterations in a row halts via `runActor`'s no-progress guard.

- [ ] **Step 2: Pre-push validation.**

```bash
# emdash check (matches CI scope exactly)
grep -rP --exclude-dir=fixtures --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist $'\u2014' src/ test/ docs/ examples/ README.md design/ 2>/dev/null && echo "FAIL: emdashes" || echo "OK"

# Private terms (matches CI; consult .github/workflows/ci.yml for the regex)

# AI attribution
grep -rEn 'Co-Authored-By|generated.*Claude' --include='*.ts' --include='*.md' src/ test/ docs/ examples/ 2>/dev/null && echo "FAIL: AI attribution" || echo "OK"

# Framework src/ docs purity
grep -rEn 'design/|DECISIONS\.md|\bPR1\b|\bPR2\b|\bPR3\b|\bPR4\b|\bPR5\b' src/ 2>/dev/null && echo "FAIL: PR-phase or design refs in src/" || echo "OK"
```

- [ ] **Step 3: Full build + test.**

```bash
npm run build && npm run test
```

- [ ] **Step 4: Push.**

```bash
node scripts/git-as.mjs lag-ceo push origin feat/pr-fix-actor
```

- [ ] **Step 5: Open PR.**

```bash
node scripts/gh-as.mjs lag-ceo pr create \
  --base main \
  --head feat/pr-fix-actor \
  --title "feat(pr-fix-actor): autonomous CR-fix loop consuming the agent-loop substrate" \
  --body "$(cat <<'EOF'
## Summary

PR5 of the agentic-actor-loop sequence. Sibling outward Actor that consumes the agent-loop substrate (PR #166) to autonomously drive a PR through CR review feedback to a clean state. Replaces today's hand-rolled CR-fix loop (witnessed across PRs #166-#169) with a real actor + audit trail in `agent-session` / `agent-turn` atoms.

Spec: \`docs/superpowers/specs/2026-04-25-pr-fix-actor-design.md\` (round 2; addresses 10 spec-reviewer issues with explicit picks).
Plan: \`docs/superpowers/plans/2026-04-25-pr-fix-actor.md\`.

## What ships

- Substrate change: \`WorkspaceProvider.AcquireInput.checkoutBranch?\` (additive, backwards-compatible). The reference \`GitWorktreeProvider\` honors it.
- New atom type: \`pr-fix-observation\` (L0, scope project).
- New actor: \`PrFixActor\` at \`src/runtime/actors/pr-fix/\`. Implements all 5 lifecycle methods.
- Two policy layers: runActor's checkToolPolicy (Layer A canon-seeded) + AgentLoopAdapter.toolPolicy.disallowedTools (Layer B, hardcoded floor).
- Driver script + canon bootstrap.

## Key picks

- Commit-SHA verification IN apply() (closes the substrate-mandated verification step that PR2's executor deferred).
- Thread resolution uses touched-paths heuristic: resolve only when finding's path is in \`git diff --name-only <baseRef>..HEAD\`.
- \`checkoutBranch\` substrate extension lets the workspace pin to the PR's HEAD branch so commits push back to update the PR.

## Out of scope

- CI workflow integration (separate PR after operator validates dry-runs).
- Auto-merge after APPROVED.
- Fork PR support.

## Test plan

- 1948+ existing tests still pass.
- New unit tests on observe/classify/propose/reflect.
- New e2e test on MemoryHost asserting the full chain + canonical atom shapes.
- New regression test on \`GitWorktreeProvider\` asserting \`worktree add\` does NOT use \`-b\` when \`checkoutBranch\` is supplied.
EOF
)"
```

- [ ] **Step 6: Trigger CR + drive to merge.**

Same pattern as PRs #166-#169: trigger via `node scripts/trigger-cr-review.mjs --pr <n>`; arm a Monitor; on findings, dispatch the implementer subagent for fixes; resolve threads; drive to APPROVED + merge.

- [ ] **Step 7: Pull main locally + save milestone memory.**

```bash
git checkout main
node scripts/git-as.mjs lag-ceo pull origin main
```

Save `project_pr_fix_actor_landed.md` and update `MEMORY.md` index.

---

## Notes for the implementer

1. **The substrate change in Task 1 is load-bearing.** Don't skip it; PrFixActor's commit-on-PR-HEAD requirement depends on it.
2. **The two policy layers are easy to confuse.** Layer A (canon) gates the actor's own actions; Layer B (`disallowedTools`) gates the spawned Claude's tools. Both must be enforced; the spec §3.4 has the explicit tables.
3. **Commit-SHA verification is mandatory per substrate contract.** Run `git rev-parse HEAD` in `workspace.path` and compare against `result.artifacts.commitSha` BEFORE resolving any threads. PR2's executor skipped this; we explicitly do it here. The substrate's `agent-loop.ts:31-35` documents the requirement.
4. **Thread resolution uses touched-paths.** `git diff --name-only <baseRef>..HEAD` -> the set; resolve only when finding's `path` is in the set. Conservative; CR re-review re-opens a partially-fixed thread.
5. **`Reflection` is `{done, progress, note}`, NOT a string.** Match the type from `src/runtime/actors/types.ts:98`.
6. **`Classified<Obs>` is `{observation, key, metadata}`.** The classification literal goes into `metadata.classification`, not into `Classified` directly. Match `PrLandingActor.classify`'s shape.
7. **Bot-identity discipline:** every commit `node scripts/git-as.mjs lag-ceo commit ...`; every push `node scripts/git-as.mjs lag-ceo push origin <branch>` (NO `-u` -- fixed in PR #169 but stay disciplined).
8. **Pre-push grep before EVERY push.** Catch emdashes / private terms / design-refs / AI attribution. The one-liner is in Task 13.
9. **TDD discipline:** failing test first, run-verify-fail, implement, run-verify-pass, commit. Per memory `feedback_security_correctness_at_write_time` walk through the security/correctness considerations BEFORE writing code, not after CR flags it.
10. **Frequent commits.** Each task ends with one commit. PR5 should land with ~13 commits.
