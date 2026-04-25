# Agentic Actor Loop PR2 Implementation Plan - AgenticCodeAuthorExecutor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land `AgenticCodeAuthorExecutor` as the first consumer of the agentic-actor-loop substrate (PR1, merged at `02589d1`). The new executor composes `WorkspaceProvider` + `AgentLoopAdapter` + `Redactor` + `BlobStore` + the two policy resolvers and produces a PR end-to-end. The existing diff-based executor is preserved (renamed + aliased) so no consumer breaks.

**Architecture:** `AgenticCodeAuthorExecutor` implements the same `CodeAuthorExecutor` interface (`src/runtime/actor-message/code-author-invoker.ts:124`) so the invoker is unchanged. It acquires an isolated workspace, runs an agent loop inside it, harvests the resulting commit SHA + branch, and creates a PR via the existing `GhClient`. Failures map onto the existing `CodeAuthorExecutorFailure` shape so observation atoms remain uniform across the diff-based and agentic paths.

**Tech stack:** TypeScript (strict), vitest, Node 22, the substrate seams shipped in PR1 (`AgentLoopAdapter`, `WorkspaceProvider`, `BlobStore`, `Redactor`, `clampBlobThreshold`, `loadReplayTier`, `loadBlobThreshold`).

**Cross-cutting discipline:** every task carries a "Security + correctness considerations" subsection. The implementer subagent walks through these BEFORE writing code, not after CR flags it. Memory: `feedback_security_correctness_at_write_time`.

**Branch:** create a fresh branch `pr2/agentic-code-author-executor` off `main` when implementation starts. Do NOT stack on the merged PR1 branch. All commits via `node scripts/git-as.mjs lag-ceo`. NO `-u` on push.

---

## File structure

### New files

| File | Responsibility |
|---|---|
| `src/runtime/actor-message/agentic-code-author-executor.ts` | New executor: `AgenticExecutorConfig` interface + `buildAgenticCodeAuthorExecutor(config)` factory composing the agentic-loop seam. |
| `test/runtime/actor-message/agentic-code-author-executor.test.ts` | Unit tests for the executor in isolation: success path, failure mapping per `FailureKind`, signal-cancel, workspace cleanup-on-error. |
| `test/e2e/agentic-actor-loop-chain.test.ts` | End-to-end test: full chain (plan atom -> dispatch -> agentic executor -> stub agent loop -> stub git client -> stub gh client -> CodeAuthorExecutorSuccess) on `MemoryHost`. Validates atom emission shape, session-tree projection round-trip, and observation-atom payload. |

### Modified files

| File | Change |
|---|---|
| `src/runtime/actor-message/code-author-executor-default.ts` | RENAMED to `diff-based-code-author-executor.ts`. Symbol renamed: `buildDefaultCodeAuthorExecutor` -> `buildDiffBasedCodeAuthorExecutor`; `DefaultExecutorConfig` -> `DiffBasedExecutorConfig`. JSDoc updated to call out the diff-based vs agentic distinction. |
| `src/runtime/actor-message/code-author-executor-default.ts` (NEW thin shim) | Re-exports `buildDefaultCodeAuthorExecutor` (deprecated alias) and `DefaultExecutorConfig` (deprecated alias) forwarding to the new symbols. JSDoc carries `@deprecated` and the renamed-to target. Will be removed in the release after. |
| `src/runtime/actor-message/index.ts` | Add `agentic-code-author-executor` to the barrel; preserve existing `code-author-executor-default` export. |

### Test files (existing) potentially needing updates

| File | Change |
|---|---|
| `test/actor-message/code-author-executor-default.test.ts` | If imports point at `buildDefaultCodeAuthorExecutor`, update to import the new name (or rely on the alias). Verify rename did not break existing tests. |
| Any test that imports `DefaultExecutorConfig` | Same: rename or rely on alias. |

---

## Tasks

Each task is implementer-subagent-sized and follows TDD strict order.

---

### Task 1: Rename diff-based executor + ship back-compat alias

**Files:**
- Rename via git: `src/runtime/actor-message/code-author-executor-default.ts` -> `src/runtime/actor-message/diff-based-code-author-executor.ts`.
- Modify (inside the renamed file): update `buildDefaultCodeAuthorExecutor` -> `buildDiffBasedCodeAuthorExecutor`, `DefaultExecutorConfig` -> `DiffBasedExecutorConfig`. Update JSDoc.
- Create (new alias shim): `src/runtime/actor-message/code-author-executor-default.ts` (the OLD path, but now a thin shim).
- Modify: any tests importing the old symbols - update to the new import path / new names, OR confirm the back-compat alias path resolves.

**Security + correctness considerations:**
- Atomic rename via `git mv` so blame history is preserved (don't `cp` + `delete`).
- Back-compat alias MUST re-export the EXACT same symbols (build factory, config type) so consumers don't see a behavioural change. Mismatch here is a silent incident.
- The `@deprecated` tag in JSDoc MUST name the migration target so editors / TS tooling surface the warning at consumer call-sites.
- Test coverage: at least one test imports via the alias path to prove it still resolves.

- [ ] **Step 1: git-rename the old file**

```bash
node scripts/git-as.mjs lag-ceo mv src/runtime/actor-message/code-author-executor-default.ts src/runtime/actor-message/diff-based-code-author-executor.ts
```

If `git-as` doesn't support `mv`, use plain `git mv` (it's a local-only operation, no remote auth needed):

```bash
git mv src/runtime/actor-message/code-author-executor-default.ts src/runtime/actor-message/diff-based-code-author-executor.ts
```

- [ ] **Step 2: Rename symbols inside the new file**

In `src/runtime/actor-message/diff-based-code-author-executor.ts`:
- Rename `export interface DefaultExecutorConfig` -> `export interface DiffBasedExecutorConfig`.
- Rename `export function buildDefaultCodeAuthorExecutor` -> `export function buildDiffBasedCodeAuthorExecutor`.
- Update the constructor parameter type from `DefaultExecutorConfig` to `DiffBasedExecutorConfig`.
- Update the file's top-level JSDoc to clarify "diff-based" lineage:

```
/**
 * Diff-based CodeAuthorExecutor: composes drafter + git-ops + pr-creation
 * into a single execute() call. The drafter emits a unified diff in one
 * LLM call; the executor applies it via git apply, commits, pushes, and
 * opens a PR.
 *
 * For multi-turn agentic execution (LLM iterates with real tools in an
 * isolated workspace), see `agentic-code-author-executor.ts`.
 *
 * Stage map (each fails closed with a typed stage name on the error
 * return path so the observation atom records precisely where the
 * chain stopped):
 *   - drafter        LLM-backed diff generation
 *   - apply-branch   git fetch + apply + commit + push
 *   - pr-creation    GitHub pulls POST
 */
```

- [ ] **Step 3: Create the back-compat shim**

Create `src/runtime/actor-message/code-author-executor-default.ts`:

```ts
/**
 * Deprecated back-compat shim for the diff-based executor.
 *
 * @deprecated Import from `./diff-based-code-author-executor.js` instead.
 *   `buildDefaultCodeAuthorExecutor` -> `buildDiffBasedCodeAuthorExecutor`,
 *   `DefaultExecutorConfig` -> `DiffBasedExecutorConfig`.
 *   This shim is preserved for one minor release and will be removed in
 *   the release after.
 */

export {
  buildDiffBasedCodeAuthorExecutor as buildDefaultCodeAuthorExecutor,
  type DiffBasedExecutorConfig as DefaultExecutorConfig,
} from './diff-based-code-author-executor.js';
```

- [ ] **Step 4: Update existing tests + imports**

Find every consumer of the old names:

```bash
grep -rnP "buildDefaultCodeAuthorExecutor|DefaultExecutorConfig" src/ test/ --include='*.ts'
```

Migrate each call-site to the new name + path. Do NOT rely on the back-compat alias inside our own codebase (the alias is for downstream consumers, not us). A small carve-out: ONE test file should keep importing via the alias path to prove the shim still resolves.

For example, edit `test/actor-message/code-author-executor-default.test.ts` to import from `../../src/runtime/actor-message/diff-based-code-author-executor.js` and use the new symbol names. Add a separate small test (`test/runtime/actor-message/back-compat-alias.test.ts`) that imports via the OLD path to verify the alias resolves at module-load time:

```ts
import { describe, it, expect } from 'vitest';
import * as oldPath from '../../src/runtime/actor-message/code-author-executor-default.js';

describe('code-author-executor-default back-compat shim', () => {
  it('exposes buildDefaultCodeAuthorExecutor', () => {
    expect(typeof oldPath.buildDefaultCodeAuthorExecutor).toBe('function');
  });
});
```

(`DefaultExecutorConfig` is a type, erased at runtime; we can't assert its presence directly. The runtime function check is enough to prove the module loads.)

- [ ] **Step 5: Run tests + tsc**

```bash
npx tsc --noEmit 2>&1 | tail -10
npx vitest run test/actor-message/code-author-executor-default.test.ts test/runtime/actor-message/back-compat-alias.test.ts 2>&1 | tail -10
```

Expected: tsc clean, all tests pass.

- [ ] **Step 6: Commit**

```bash
node scripts/git-as.mjs lag-ceo add -A
node scripts/git-as.mjs lag-ceo commit -m "refactor(actor-message): rename code-author-executor-default to diff-based + back-compat alias"
```

(The `-A` is OK here because the only changes should be the rename + symbol updates + the shim file + test updates; no untracked noise should be staged. Confirm via `git status` before commit.)

---

### Task 2: `AgenticExecutorConfig` interface + builder skeleton

**Files:**
- Create: `src/runtime/actor-message/agentic-code-author-executor.ts` (interface + factory skeleton; no runtime logic yet).
- Test: `test/runtime/actor-message/agentic-code-author-executor.test.ts` (smoke test that the factory returns a `CodeAuthorExecutor` shape).

**Security + correctness considerations:**
- The config takes substrate seams as injected dependencies (`AgentLoopAdapter`, `WorkspaceProvider`, `BlobStore`, `Redactor`). It does NOT instantiate them; the operator wires them at composition time. This keeps the executor pluggable across vendor adapters.
- `actorType` is a string the operator supplies (e.g. `'code-author'`). It's consumed by the policy resolvers; misspell here -> wrong policy applies (silently). Document this clearly + verify in tests with explicit values.
- The config carries `principal` (the executor's own principal id) so policy resolution + atom signing work correctly. Mixing principal ids is a substrate violation; the test fixture uses an explicit `'agentic-code-author' as PrincipalId` cast to make this visible.
- **`host` is on the config, NOT on `inputs`.** This mirrors `DiffBasedExecutorConfig.host` (the diff-based executor's contract). The `CodeAuthorExecutor.execute()` interface takes only `{ plan, fence, correlationId, observationAtomId, signal }` (see `code-author-invoker.ts:124-141`); a `host` field on `inputs` would not compile. The factory captures `host` once at construction time; tests that need cross-host scenarios construct multiple executor instances.

- [ ] **Step 1: Write the failing smoke test**

`test/runtime/actor-message/agentic-code-author-executor.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import { buildAgenticCodeAuthorExecutor } from '../../../src/runtime/actor-message/agentic-code-author-executor.js';
import type { PrincipalId } from '../../../src/substrate/types.js';
import type { AgentLoopAdapter } from '../../../src/substrate/agent-loop.js';
import type { WorkspaceProvider } from '../../../src/substrate/workspace-provider.js';
import type { BlobStore } from '../../../src/substrate/blob-store.js';
import type { Redactor } from '../../../src/substrate/redactor.js';

describe('buildAgenticCodeAuthorExecutor', () => {
  it('returns an object with an execute() method', () => {
    const host = createMemoryHost();
    const executor = buildAgenticCodeAuthorExecutor({
      host,
      principal: 'agentic-code-author' as PrincipalId,
      actorType: 'code-author',
      agentLoop: {} as AgentLoopAdapter,
      workspaceProvider: {} as WorkspaceProvider,
      blobStore: {} as BlobStore,
      redactor: {} as Redactor,
      ghClient: {} as never,
      owner: 'o',
      repo: 'r',
      baseRef: 'main',
      model: 'claude-opus-4-7',
    });
    expect(typeof executor.execute).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/runtime/actor-message/agentic-code-author-executor.test.ts 2>&1 | tail -10
```

Expected: module-not-found.

- [ ] **Step 3: Implement the skeleton**

Create `src/runtime/actor-message/agentic-code-author-executor.ts`:

```ts
/**
 * Agentic CodeAuthorExecutor: composes the agentic-actor-loop substrate
 * (AgentLoopAdapter + WorkspaceProvider + BlobStore + Redactor + the
 * two policy resolvers) into a CodeAuthorExecutor implementation.
 *
 * For each invocation:
 *   1. Resolve `pol-replay-tier` and `pol-blob-threshold` for the
 *      executor's principal + actor-type.
 *   2. Acquire an isolated workspace via `WorkspaceProvider.acquire()`.
 *   3. Run the agent loop via `AgentLoopAdapter.run()`. The adapter
 *      writes session + turn atoms; the executor does not mint atoms
 *      itself.
 *   4. On `result.kind === 'completed'` with a `commitSha`, create a
 *      PR via the existing `GhClient`.
 *   5. Map any non-completed result onto a `CodeAuthorExecutorFailure`
 *      keyed by the underlying `FailureKind`.
 *   6. Always release the workspace (try/finally).
 *
 * Stage map (failure paths):
 *   - workspace-acquire     -> WorkspaceProvider.acquire threw
 *   - agent-loop/transient  -> adapter returned failure.kind = 'transient'
 *   - agent-loop/structural -> adapter returned failure.kind = 'structural'
 *   - agent-loop/catastrophic -> adapter returned failure.kind = 'catastrophic'
 *   - pr-creation           -> GhClient PR-create threw
 *
 * Threat model
 * ------------
 * - The executor does NOT spawn the LLM itself; it composes whatever
 *   `AgentLoopAdapter` the operator wires. Vendor lock-in is avoided.
 * - The workspace inherits whatever credentials the WorkspaceProvider
 *   provisioned. Cred scope is the provider's responsibility.
 * - The `AgentLoopResult.artifacts.commitSha` is adapter-supplied;
 *   the executor MUST verify the commit exists in the workspace before
 *   trusting it (a misbehaving adapter could fabricate a SHA). This
 *   verification ships in Task 3.
 */

import type { Atom, AtomId, PrincipalId } from '../../types.js';
import type { Host } from '../../interface.js';
import type { GhClient } from '../../external/github/index.js';
import type { CodeAuthorFence } from '../../runtime/actors/code-author/fence.js';
import type {
  AgentLoopAdapter,
} from '../../substrate/agent-loop.js';
import type { WorkspaceProvider } from '../../substrate/workspace-provider.js';
import type { BlobStore } from '../../substrate/blob-store.js';
import type { Redactor } from '../../substrate/redactor.js';
import type {
  CodeAuthorExecutor,
  CodeAuthorExecutorResult,
} from './code-author-invoker.js';

export interface AgenticExecutorConfig {
  /**
   * Substrate host the executor reads policies from + signs atoms via.
   * Captured at factory-construction time (mirrors DiffBasedExecutorConfig.host).
   * The CodeAuthorExecutor.execute() contract takes no `host` input;
   * tests that need cross-host scenarios construct multiple executor
   * instances rather than threading host through inputs.
   */
  readonly host: Host;
  /** The executor's own principal id. Drives policy resolution + atom signing. */
  readonly principal: PrincipalId;
  /** Actor-type label, e.g. 'code-author'. Drives per-actor policy resolution. */
  readonly actorType: string;
  readonly agentLoop: AgentLoopAdapter;
  readonly workspaceProvider: WorkspaceProvider;
  readonly blobStore: BlobStore;
  readonly redactor: Redactor;
  readonly ghClient: GhClient;
  readonly owner: string;
  readonly repo: string;
  /** Base ref the workspace is created off (e.g. 'main'). */
  readonly baseRef: string;
  readonly model: string;
  /** Draft PR by default; operator can flip per deployment. */
  readonly draft?: boolean;
}

export function buildAgenticCodeAuthorExecutor(
  config: AgenticExecutorConfig,
): CodeAuthorExecutor {
  return {
    async execute(_inputs): Promise<CodeAuthorExecutorResult> {
      // Skeleton: the real composition lands in Task 3.
      return {
        kind: 'error',
        stage: 'agentic/not-implemented',
        reason: 'AgenticCodeAuthorExecutor skeleton is not yet wired to the substrate seams (see Task 3 of the PR2 plan).',
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/runtime/actor-message/agentic-code-author-executor.test.ts 2>&1 | tail -10
```

Expected: 1 test passes.

- [ ] **Step 5: Commit**

```bash
node scripts/git-as.mjs lag-ceo add src/runtime/actor-message/agentic-code-author-executor.ts test/runtime/actor-message/agentic-code-author-executor.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(actor-message): AgenticCodeAuthorExecutor skeleton + config interface"
```

---

### Task 3: Wire the substrate composition

**Files:**
- Modify: `src/runtime/actor-message/agentic-code-author-executor.ts` (real composition + error mapping).
- Test: `test/runtime/actor-message/agentic-code-author-executor.test.ts` (success path + each failure path).

**Security + correctness considerations:**
- `WorkspaceProvider.acquire()` -> `AgentLoopAdapter.run()` -> `WorkspaceProvider.release()` MUST be wrapped in try/finally so a thrown agent loop never leaks a workspace.
- Failure mapping: each `AgentLoopResult.kind` (`'completed' | 'budget-exhausted' | 'error' | 'aborted'`) plus the `failure.kind` taxonomy (`transient | structural | catastrophic`) maps to a `CodeAuthorExecutorFailure` with a deterministic `stage` string. Consumers parse `stage` for analytics/dashboards; the mapping table is the contract.
- Commit-SHA verification: before creating the PR, the executor SHOULD verify the commitSha actually exists at `workspace.path`. PR2 ships the seam; the verification is opt-in via a callback (see step 3). A future hardening pass enforces it unconditionally.
- Signal propagation: `inputs.signal` from the invoker MUST be forwarded to `AgentLoopAdapter.run({signal})` so cooperative cancellation works through the chain.
- Policy resolution failures (parser throws) propagate as `agentic/policy-resolution` stage failures, NOT silently fall back to defaults. A malformed policy atom is a deployment error worth surfacing.

- [ ] **Step 1: Add failure-mapping unit tests**

Append to `test/runtime/actor-message/agentic-code-author-executor.test.ts`:

```ts
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import type { AgentLoopAdapter, AgentLoopResult, AdapterCapabilities } from '../../../src/substrate/agent-loop.js';
import { defaultClassifyFailure } from '../../../src/substrate/agent-loop.js';
import type { Workspace, WorkspaceProvider } from '../../../src/substrate/workspace-provider.js';
import type { CodeAuthorFence } from '../../../src/runtime/actors/code-author/fence.js';

const NOOP_CAPS: AdapterCapabilities = {
  tracks_cost: false,
  supports_signal: false,
  classify_failure: defaultClassifyFailure,
};

function stubWorkspaceProvider(): WorkspaceProvider {
  const ws: Workspace = { id: 'ws-test', path: '/tmp/lag-test', baseRef: 'main' };
  return {
    acquire: async () => ws,
    release: async () => undefined,
  };
}

function stubAdapter(result: AgentLoopResult): AgentLoopAdapter {
  return { capabilities: NOOP_CAPS, run: async () => result };
}

function mkPlanAtom(): Atom {
  // Minimal plan-atom fixture; the agent loop is stubbed so plan content
  // is opaque to the test. Fields satisfy the Atom contract.
  return {
    schema_version: 1, id: 'plan-test' as AtomId, content: '# test plan',
    type: 'plan', layer: 'L1',
    provenance: { kind: 'agent-observed', source: { agent_id: 'cto-actor' }, derived_from: [] },
    confidence: 1, created_at: '2026-04-25T00:00:00.000Z',
    last_reinforced_at: '2026-04-25T00:00:00.000Z',
    expires_at: null, supersedes: [], superseded_by: [], scope: 'project',
    signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
    principal_id: 'cto-actor' as PrincipalId, taint: 'clean',
    metadata: { plan_state: 'approved' },
  };
}

function mkFence(): CodeAuthorFence {
  return { max_usd_per_pr: 10, required_checks: ['Node 22 on ubuntu-latest'] };
}

describe('AgenticCodeAuthorExecutor failure mapping', () => {
  it('maps adapter "completed" with no commitSha to agentic/no-artifacts', async () => {
    const host = createMemoryHost();
    const adapter = stubAdapter({
      kind: 'completed',
      sessionAtomId: 'sess-1' as AtomId,
      turnAtomIds: ['turn-1' as AtomId],
      // artifacts.commitSha intentionally missing
    });
    const ghCalled = { count: 0 };
    const ghStub = { rest: async () => { ghCalled.count += 1; return {} as never; } } as unknown as GhClient;
    const executor = buildAgenticCodeAuthorExecutor({
      host,
      principal: 'agentic-code-author' as PrincipalId,
      actorType: 'code-author',
      agentLoop: adapter,
      workspaceProvider: stubWorkspaceProvider(),
      blobStore: {} as BlobStore,
      redactor: { redact: (s: string) => s } as Redactor,
      ghClient: ghStub,
      owner: 'o', repo: 'r', baseRef: 'main', model: 'm',
    });
    const result = await executor.execute({
      plan: mkPlanAtom(), fence: mkFence(), correlationId: 'c',
      observationAtomId: 'obs-1' as AtomId,
    });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.stage).toBe('agentic/no-artifacts');
    expect(ghCalled.count).toBe(0);
  });

  it('maps adapter failure.kind: "transient" to agentic/agent-loop/transient', async () => {
    const host = createMemoryHost();
    const adapter = stubAdapter({
      kind: 'error',
      sessionAtomId: 'sess-1' as AtomId,
      turnAtomIds: [],
      failure: { kind: 'transient', reason: 'rate limited', stage: 'turn-2' },
    });
    const executor = buildAgenticCodeAuthorExecutor({
      host,
      principal: 'agentic-code-author' as PrincipalId,
      actorType: 'code-author',
      agentLoop: adapter,
      workspaceProvider: stubWorkspaceProvider(),
      blobStore: {} as BlobStore,
      redactor: { redact: (s: string) => s } as Redactor,
      ghClient: {} as GhClient,
      owner: 'o', repo: 'r', baseRef: 'main', model: 'm',
    });
    const result = await executor.execute({
      plan: mkPlanAtom(), fence: mkFence(), correlationId: 'c',
      observationAtomId: 'obs-1' as AtomId,
    });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.stage).toBe('agentic/agent-loop/transient');
    expect(result.reason).toContain('rate limited');
  });

  it('always releases the workspace, even on adapter throw', async () => {
    const host = createMemoryHost();
    const released = { count: 0 };
    const provider: WorkspaceProvider = {
      acquire: async () => ({ id: 'ws-x', path: '/tmp/x', baseRef: 'main' }),
      release: async () => { released.count += 1; },
    };
    const throwingAdapter: AgentLoopAdapter = {
      capabilities: NOOP_CAPS,
      run: async () => { throw new Error('boom'); },
    };
    const executor = buildAgenticCodeAuthorExecutor({
      host,
      principal: 'agentic-code-author' as PrincipalId,
      actorType: 'code-author',
      agentLoop: throwingAdapter,
      workspaceProvider: provider,
      blobStore: {} as BlobStore,
      redactor: { redact: (s: string) => s } as Redactor,
      ghClient: {} as GhClient,
      owner: 'o', repo: 'r', baseRef: 'main', model: 'm',
    });
    await executor.execute({
      plan: mkPlanAtom(), fence: mkFence(), correlationId: 'c',
      observationAtomId: 'obs-1' as AtomId,
    });
    expect(released.count).toBe(1);
  });
});
```

NOTE: `host` is captured at factory-construction time via `AgenticExecutorConfig.host`, NOT via the `execute()` inputs. The `CodeAuthorExecutor.execute()` interface at `src/runtime/actor-message/code-author-invoker.ts:124-141` takes only `{ plan, fence, correlationId, observationAtomId, signal }`. This mirrors the diff-based executor's `DefaultExecutorConfig.host` shape. Reading the invoker is the FIRST thing the implementer does.

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run test/runtime/actor-message/agentic-code-author-executor.test.ts 2>&1 | tail -10
```

Expected: 3 new tests fail (the executor returns `'agentic/not-implemented'` from the skeleton).

- [ ] **Step 3: Implement the real composition**

Replace the skeleton body in `src/runtime/actor-message/agentic-code-author-executor.ts` with the full composition. The high-level shape:

```ts
async execute(inputs): Promise<CodeAuthorExecutorResult> {
  const { plan, fence, correlationId, observationAtomId, signal } = inputs;
  const { host } = config;  // host captured at factory-construction time

  // 1. Resolve policies (fail-loud on malformed; default on missing).
  let replayTier: ReplayTier;
  let blobThreshold: number;
  try {
    replayTier = await loadReplayTier(host.atoms, config.principal, config.actorType);
    blobThreshold = await loadBlobThreshold(host.atoms, config.principal, config.actorType);
  } catch (err) {
    return { kind: 'error', stage: 'agentic/policy-resolution', reason: errorMessage(err) };
  }

  // 2. Acquire workspace.
  let workspace: Workspace;
  try {
    workspace = await config.workspaceProvider.acquire({
      principal: config.principal,
      baseRef: config.baseRef,
      correlationId,
    });
  } catch (err) {
    return { kind: 'error', stage: 'agentic/workspace-acquire', reason: errorMessage(err) };
  }

  try {
    // 3. Run the agent loop.
    let agentResult: AgentLoopResult;
    try {
      agentResult = await config.agentLoop.run({
        host,
        principal: config.principal,
        workspace,
        task: extractAgentTask(plan, fence),
        budget: deriveBudget(fence),
        toolPolicy: { disallowedTools: [] },  // PR2 wires the actual policy resolution; substrate-level pol-llm-tool-policy is a separate concern.
        redactor: config.redactor,
        blobStore: config.blobStore,
        replayTier,
        blobThreshold,
        correlationId,
        signal,
      });
    } catch (err) {
      // Adapter threw rather than returning a structured failure.
      return mapAgentLoopThrow(err, config.agentLoop.capabilities.classify_failure);
    }

    // 4. Map non-completed kinds.
    if (agentResult.kind !== 'completed') {
      return mapAgentLoopResult(agentResult);
    }

    const commitSha = agentResult.artifacts?.commitSha;
    const branchName = agentResult.artifacts?.branchName;
    if (!commitSha || !branchName) {
      return { kind: 'error', stage: 'agentic/no-artifacts', reason: 'agent loop completed but did not return commitSha + branchName' };
    }

    // 5. Create PR via existing GhClient.
    try {
      const pr = await createPrViaGhClient(config, plan, observationAtomId, commitSha, branchName);
      return {
        kind: 'dispatched',
        prNumber: pr.number,
        prHtmlUrl: pr.htmlUrl,
        commitSha,
        branchName,
        totalCostUsd: 0,  // adapter-tracked cost is opt-in; default 0 when adapter doesn't report.
        modelUsed: config.model,
        confidence: 1,
        touchedPaths: agentResult.artifacts?.touchedPaths ?? [],
      };
    } catch (err) {
      return { kind: 'error', stage: 'agentic/pr-creation', reason: errorMessage(err) };
    }
  } finally {
    // 6. Always release the workspace, even on throw.
    await config.workspaceProvider.release(workspace).catch(() => undefined);
  }
}
```

Helper functions (define inside the same file):

- `extractAgentTask(plan, fence)`: builds the `AgentTask` shape expected by `AgentLoopAdapter` from the plan atom. Pulls `metadata.target_paths`, `metadata.question_prompt`, `metadata.success_criteria`. Mirror what `diff-based-code-author-executor.ts` does for these fields (the `meta = plan.metadata as Record<string, unknown>` block + downstream `extractStringArray`/`extractTargetPathsFromProse` calls) so the agentic + diff-based paths interpret plans identically.
- `deriveBudget(fence)`: `{ max_turns: defaultBudgetCap().max_turns, max_wall_clock_ms: defaultBudgetCap().max_wall_clock_ms, max_usd: fence.max_usd_per_pr }`.
- `mapAgentLoopResult(result)`: switches on `result.kind` × `result.failure?.kind`. Stage strings are the dashboard contract; the table below is exhaustive across all (kind × failure-kind) combinations.

  | `result.kind` | `failure?.kind` | `stage` | `reason` |
  |---|---|---|---|
  | `'completed'` | any | (caller short-circuits before this; unreachable) | n/a |
  | `'budget-exhausted'` | undefined | `'agentic/budget-exhausted'` | `'agent loop hit budget cap'` |
  | `'budget-exhausted'` | `'transient'` | `'agentic/budget-exhausted/transient'` | `failure.reason` |
  | `'budget-exhausted'` | `'structural'` | `'agentic/budget-exhausted/structural'` | `failure.reason` |
  | `'budget-exhausted'` | `'catastrophic'` | `'agentic/budget-exhausted/catastrophic'` | `failure.reason` |
  | `'aborted'` | undefined | `'agentic/aborted'` | `'agent loop aborted via signal'` |
  | `'aborted'` | `'transient'` | `'agentic/aborted/transient'` | `failure.reason` |
  | `'aborted'` | `'structural'` | `'agentic/aborted/structural'` | `failure.reason` |
  | `'aborted'` | `'catastrophic'` | `'agentic/aborted/catastrophic'` | `failure.reason` |
  | `'error'` | `'transient'` | `'agentic/agent-loop/transient'` | `failure.reason` |
  | `'error'` | `'structural'` | `'agentic/agent-loop/structural'` | `failure.reason` |
  | `'error'` | `'catastrophic'` | `'agentic/agent-loop/catastrophic'` | `failure.reason` |
  | `'error'` | undefined | `'agentic/agent-loop/unknown'` | `'agent loop failed without structured FailureRecord'` |

  Implementer: write a unit test that exhaustively asserts the (kind, failure?.kind) -> stage mapping for every cell of this table to pin the contract.
- `mapAgentLoopThrow(err, classifier)`: convert a thrown error to the same shape using the adapter's `classify_failure`.
- `createPrViaGhClient(config, plan, observationAtomId, commitSha, branchName)`: thin wrapper. Reuse `renderPrBody` + the gh-API call pattern from `pr-creation.ts` so the PR body shape is identical between agentic + diff-based.
- `errorMessage(err)`: `err instanceof Error ? err.message : String(err)`.

The implementer adds these helpers + the imports they require. Refer to `code-author-executor-default.ts` for the existing patterns to mirror.

- [ ] **Step 4: Run tests + tsc**

```bash
npx vitest run test/runtime/actor-message/agentic-code-author-executor.test.ts 2>&1 | tail -10
npx tsc --noEmit 2>&1 | tail -10
```

Expected: all 4 tests pass; tsc clean.

- [ ] **Step 5: Commit**

```bash
node scripts/git-as.mjs lag-ceo add src/runtime/actor-message/agentic-code-author-executor.ts test/runtime/actor-message/agentic-code-author-executor.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(actor-message): AgenticCodeAuthorExecutor wires the substrate composition"
```

---

### Task 4: End-to-end test on `MemoryHost`

**Files:**
- Create: `test/e2e/agentic-actor-loop-chain.test.ts`.

**Security + correctness considerations:**
- The e2e test stubs the AgentLoopAdapter (no real LLM), the WorkspaceProvider (in-memory path), the BlobStore (in-memory map), and the GhClient (returns a synthetic PR object). The point is to validate the COMPOSITION shape: that atoms are emitted in the right order with the right `derived_from` linkage, and that the executor returns a `CodeAuthorExecutorSuccess`.
- The test MUST validate the session-tree projection round-trips a chain. Build the chain, then call `buildSessionTree` on the resulting session atom; assert turn ordering + parent linkage.
- Real-world failure modes (mid-turn crash, signal-cancel, budget-exhausted) get one e2e test each so the failure paths through the full chain are pinned.

- [ ] **Step 1: Write the e2e test**

`test/e2e/agentic-actor-loop-chain.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { buildAgenticCodeAuthorExecutor } from '../../src/runtime/actor-message/agentic-code-author-executor.js';
import { buildSessionTree } from '../../src/substrate/projections/session-tree.js';
import { defaultClassifyFailure } from '../../src/substrate/agent-loop.js';
import type { AgentLoopAdapter, AgentLoopResult } from '../../src/substrate/agent-loop.js';
import type { Workspace, WorkspaceProvider } from '../../src/substrate/workspace-provider.js';
import type { BlobStore } from '../../src/substrate/blob-store.js';
import type { Redactor } from '../../src/substrate/redactor.js';
import type { GhClient } from '../../src/external/github/index.js';
import type { Atom, AtomId, PrincipalId } from '../../src/substrate/types.js';
import { randomBytes } from 'node:crypto';

// In-memory BlobStore stub.
function inMemoryBlobStore(): BlobStore {
  const store = new Map<string, Buffer>();
  return {
    put: async (content) => {
      const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
      // Cheap content-addressing for the stub: sha-like sum of bytes (good enough for tests).
      const ref = `sha256:${randomBytes(32).toString('hex')}`;
      store.set(ref, buf);
      return ref as never;
    },
    get: async (ref) => store.get(ref as string)!,
    has: async (ref) => store.has(ref as string),
  };
}

const NOOP_REDACTOR: Redactor = { redact: (s) => s };

// Stub adapter that emits one session + N turns + returns a commit SHA.
function stubAdapter(turnCount: number): AgentLoopAdapter {
  return {
    capabilities: { tracks_cost: false, supports_signal: true, classify_failure: defaultClassifyFailure },
    run: async (input) => {
      const sessionId = `agent-session-${randomBytes(6).toString('hex')}` as AtomId;
      const turnIds: AtomId[] = [];
      const now = new Date().toISOString();
      const sessionAtom: Atom = {
        schema_version: 1, id: sessionId, content: '', type: 'agent-session', layer: 'L1',
        provenance: { kind: 'agent-observed', source: { agent_id: input.principal as unknown as string }, derived_from: [] },
        confidence: 1, created_at: now, last_reinforced_at: now, expires_at: null,
        supersedes: [], superseded_by: [], scope: 'project',
        signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
        principal_id: input.principal, taint: 'clean',
        metadata: { agent_session: { model_id: 'stub-model', adapter_id: 'stub-adapter', workspace_id: input.workspace.id, started_at: now, terminal_state: 'completed', replay_tier: input.replayTier, budget_consumed: { turns: turnCount, wall_clock_ms: 1 } } },
      };
      await input.host.atoms.put(sessionAtom);
      for (let i = 0; i < turnCount; i++) {
        const turnId = `agent-turn-${randomBytes(6).toString('hex')}` as AtomId;
        const turnAtom: Atom = {
          schema_version: 1, id: turnId, content: '', type: 'agent-turn', layer: 'L1',
          provenance: { kind: 'agent-observed', source: { agent_id: input.principal as unknown as string }, derived_from: [sessionId] },
          confidence: 1, created_at: now, last_reinforced_at: now, expires_at: null,
          supersedes: [], superseded_by: [], scope: 'project',
          signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
          principal_id: input.principal, taint: 'clean',
          metadata: { agent_turn: { session_atom_id: sessionId, turn_index: i, llm_input: { inline: `i${i}` }, llm_output: { inline: `o${i}` }, tool_calls: [], latency_ms: 1 } },
        };
        await input.host.atoms.put(turnAtom);
        turnIds.push(turnId);
      }
      const result: AgentLoopResult = {
        kind: 'completed',
        sessionAtomId: sessionId,
        turnAtomIds: turnIds,
        artifacts: { commitSha: 'stub-sha-deadbeef', branchName: 'agentic/test-branch', touchedPaths: ['README.md'] },
      };
      return result;
    },
  };
}

const STUB_WS_PROVIDER: WorkspaceProvider = {
  acquire: async (input) => ({ id: `ws-${input.correlationId}`, path: '/tmp/stub', baseRef: input.baseRef }),
  release: async () => undefined,
};

const STUB_GH: GhClient = {
  rest: (async () => ({ number: 4242, html_url: 'https://example.test/pr/4242', url: 'https://example.test/pr/4242', node_id: 'PR_x', state: 'open' })) as never,
} as never;

describe('agentic-actor-loop end-to-end', () => {
  it('chain: plan -> agentic executor -> stub adapter -> stub gh -> dispatched success', async () => {
    const host = createMemoryHost();
    const executor = buildAgenticCodeAuthorExecutor({
      host,
      principal: 'agentic-code-author' as PrincipalId,
      actorType: 'code-author',
      agentLoop: stubAdapter(3),
      workspaceProvider: STUB_WS_PROVIDER,
      blobStore: inMemoryBlobStore(),
      redactor: NOOP_REDACTOR,
      ghClient: STUB_GH,
      owner: 'o', repo: 'r', baseRef: 'main', model: 'stub-model',
    });

    // Minimal plan atom mirroring what the dispatcher would supply.
    const plan: Atom = {
      schema_version: 1, id: 'plan-test' as AtomId, content: 'README touch-up',
      type: 'plan', layer: 'L1',
      provenance: { kind: 'agent-observed', source: { agent_id: 'cto-actor' }, derived_from: [] },
      confidence: 1, created_at: '2026-04-25T00:00:00.000Z',
      last_reinforced_at: '2026-04-25T00:00:00.000Z',
      expires_at: null, supersedes: [], superseded_by: [], scope: 'project',
      signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
      principal_id: 'cto-actor' as PrincipalId, taint: 'clean',
      metadata: { plan_state: 'approved', target_paths: ['README.md'] },
    };
    await host.atoms.put(plan);

    const result = await executor.execute({
      plan, fence: { max_usd_per_pr: 10, required_checks: [] },
      correlationId: 'corr-e2e-1',
      observationAtomId: 'obs-1' as AtomId,
    });

    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') throw new Error('unreachable');
    expect(result.prNumber).toBe(4242);
    expect(result.commitSha).toBe('stub-sha-deadbeef');
    expect(result.branchName).toBe('agentic/test-branch');

    // Validate atom emission shape.
    const sessionAtoms = (await host.atoms.query({ type: ['agent-session'] }, 100)).atoms;
    expect(sessionAtoms.length).toBe(1);
    const sessionId = sessionAtoms[0]!.id;

    const tree = await buildSessionTree(host.atoms, sessionId);
    expect(tree.session.id).toBe(sessionId);
    expect(tree.turns.length).toBe(3);
    // Turns must be ordered by turn_index 0,1,2.
    expect((((tree.turns[0]!.metadata as Record<string, unknown>)['agent_turn']) as Record<string, unknown>)['turn_index']).toBe(0);
    expect((((tree.turns[2]!.metadata as Record<string, unknown>)['agent_turn']) as Record<string, unknown>)['turn_index']).toBe(2);
  });

  it('chain: budget-exhausted result maps to CodeAuthorExecutorFailure with stage agentic/budget-exhausted', async () => {
    const host = createMemoryHost();
    const adapter: AgentLoopAdapter = {
      capabilities: { tracks_cost: false, supports_signal: false, classify_failure: defaultClassifyFailure },
      run: async (_input) => ({
        kind: 'budget-exhausted',
        sessionAtomId: 'sess-x' as AtomId,
        turnAtomIds: [],
        failure: { kind: 'structural', reason: 'turn budget hit', stage: 'turn-cap' },
      }),
    };
    const executor = buildAgenticCodeAuthorExecutor({
      host,
      principal: 'agentic-code-author' as PrincipalId,
      actorType: 'code-author',
      agentLoop: adapter,
      workspaceProvider: STUB_WS_PROVIDER,
      blobStore: inMemoryBlobStore(),
      redactor: NOOP_REDACTOR,
      ghClient: STUB_GH,
      owner: 'o', repo: 'r', baseRef: 'main', model: 'stub-model',
    });
    const plan: Atom = {
      schema_version: 1, id: 'plan-test-2' as AtomId, content: 'plan',
      type: 'plan', layer: 'L1',
      provenance: { kind: 'agent-observed', source: { agent_id: 'cto-actor' }, derived_from: [] },
      confidence: 1, created_at: '2026-04-25T00:00:00.000Z',
      last_reinforced_at: '2026-04-25T00:00:00.000Z',
      expires_at: null, supersedes: [], superseded_by: [], scope: 'project',
      signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
      principal_id: 'cto-actor' as PrincipalId, taint: 'clean',
      metadata: {},
    };
    const result = await executor.execute({
      plan, fence: { max_usd_per_pr: 10, required_checks: [] },
      correlationId: 'corr-e2e-2',
      observationAtomId: 'obs-2' as AtomId,
    });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.stage).toBe('agentic/budget-exhausted');
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run test/e2e/agentic-actor-loop-chain.test.ts 2>&1 | tail -10
npx tsc --noEmit 2>&1 | tail -10
```

Expected: 2 tests pass; tsc clean.

- [ ] **Step 3: Commit**

```bash
node scripts/git-as.mjs lag-ceo add test/e2e/agentic-actor-loop-chain.test.ts
node scripts/git-as.mjs lag-ceo commit -m "test(e2e): full chain through AgenticCodeAuthorExecutor on MemoryHost"
```

---

### Task 5: Public-surface exports (if needed)

**Files:**
- Modify: `src/runtime/actor-message/index.ts` (add `agentic-code-author-executor` to barrel; preserve `code-author-executor-default`).

**Security + correctness considerations:**
- Each export adds a public surface promise. Confirm the symbols are intended for downstream consumption (the factory + config are; internal helpers are not).
- The deprecated alias path stays exported for one minor release per spec Section 8.2.

- [ ] **Step 1: Read current barrel**

```bash
cat src/runtime/actor-message/index.ts | head -40
```

- [ ] **Step 2: Add new exports**

Append to the barrel (preserving order + style):

```ts
export {
  buildAgenticCodeAuthorExecutor,
  type AgenticExecutorConfig,
} from './agentic-code-author-executor.js';

// New name; preferred for new code.
export {
  buildDiffBasedCodeAuthorExecutor,
  type DiffBasedExecutorConfig,
} from './diff-based-code-author-executor.js';

// Deprecated back-compat alias. Will be removed in the release after.
export {
  buildDefaultCodeAuthorExecutor,
  type DefaultExecutorConfig,
} from './code-author-executor-default.js';
```

- [ ] **Step 3: Public-surface test**

If `test/public-surface/runtime-actor-message-exports.test.ts` doesn't exist, create:

```ts
import { describe, it, expect } from 'vitest';
import * as actorMessage from '../../src/runtime/actor-message/index.js';

describe('public surface: runtime/actor-message barrel', () => {
  it('exposes buildAgenticCodeAuthorExecutor', () => {
    expect(typeof actorMessage.buildAgenticCodeAuthorExecutor).toBe('function');
  });
  it('exposes buildDiffBasedCodeAuthorExecutor', () => {
    expect(typeof actorMessage.buildDiffBasedCodeAuthorExecutor).toBe('function');
  });
  it('exposes buildDefaultCodeAuthorExecutor as a deprecated alias', () => {
    expect(typeof actorMessage.buildDefaultCodeAuthorExecutor).toBe('function');
    // Both symbols should reference the same factory implementation.
    expect(actorMessage.buildDefaultCodeAuthorExecutor).toBe(actorMessage.buildDiffBasedCodeAuthorExecutor);
  });
});
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run test/public-surface/ 2>&1 | tail -10
npx tsc --noEmit 2>&1 | tail -10
```

Expected: tests pass; tsc clean.

- [ ] **Step 5: Commit**

```bash
node scripts/git-as.mjs lag-ceo add src/runtime/actor-message/index.ts test/public-surface/runtime-actor-message-exports.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(actor-message): export AgenticCodeAuthorExecutor + diff-based rename + back-compat alias"
```

---

### Task 6: Pre-push validation + open PR

**Files:** none modified; runs validation gates.

**Security + correctness considerations:**
- Pre-push grep parity with CI's `package hygiene` (must scan `src/`, `test/`, `docs/`, `examples/`, `README.md` per `feedback_lint_ci_fidelity_discipline`).
- Build cache: fresh `npm run build` confirms types compile cleanly.
- Branch must be up-to-date with `main` before opening the PR.

- [ ] **Step 1: Full validation**

```bash
npm run build 2>&1 | tail -5
npx tsc --noEmit 2>&1 | tail -5
npx vitest run 2>&1 | tail -10
```

Expected: green across all three.

- [ ] **Step 2: Pre-push grep (CI parity)**

```bash
grep -rP --exclude-dir=fixtures $'\xe2\x80\x94' src/ test/ docs/ examples/ README.md | head
grep -rnP "design/|DECISIONS\.md|spec section|inv-|dev-|pol-" src/runtime/actor-message/agentic-code-author-executor.ts | head
grep -rnP "code-author|planning executor|cto-actor" src/runtime/actor-message/agentic-code-author-executor.ts | head
```

Expected: empty for emdashes + design refs. The `code-author` token in role-name grep MAY appear (it's the actor type name, which IS the substrate-vocabulary string, not a deployment-specific role); confirm any matches are in `actorType: 'code-author'` literal usage and not JSDoc.

- [ ] **Step 3: Branch state**

```bash
git fetch origin main
git rev-list --count origin/main..HEAD
git rev-list --count HEAD..origin/main
```

If behind, rebase onto main:

```bash
git rebase origin/main
```

- [ ] **Step 4: Push**

```bash
node scripts/git-as.mjs lag-ceo push origin pr2/agentic-code-author-executor
```

- [ ] **Step 5: Open PR**

```bash
node scripts/gh-as.mjs lag-ceo pr create \
  --base main \
  --head pr2/agentic-code-author-executor \
  --title "feat(actor-message): AgenticCodeAuthorExecutor (PR2 of agentic-actor-loop)" \
  --body "$(cat <<'EOF'
## Summary

PR2 of the agentic-actor-loop spec at `docs/superpowers/specs/2026-04-25-agentic-actor-loop-design.md` (Section 8.2). Builds on PR1 substrate (#166).

Lands the first consumer of the agentic-actor-loop seam:
- `src/runtime/actor-message/agentic-code-author-executor.ts`: composes `AgentLoopAdapter` + `WorkspaceProvider` + `BlobStore` + `Redactor` + the two policy resolvers into a `CodeAuthorExecutor` implementation.
- Renames the existing `code-author-executor-default.ts` -> `diff-based-code-author-executor.ts` for clarity.
- Ships a deprecated back-compat alias at the old import path so no consumer breaks.
- Exports both flavors from the actor-message barrel.
- End-to-end test on `MemoryHost` validating the full chain with a stub adapter + stub gh client.

The diff-based path stays available; operators choose between flavors by which factory they wire into their executor config.

## Cross-cutting discipline

Every task carried a "Security + correctness considerations" subsection. Threat models walked BEFORE code per memory `feedback_security_correctness_at_write_time`.

## Test plan

- [ ] Full `vitest` suite passes.
- [ ] `tsc --noEmit` clean.
- [ ] Pre-push grep parity with CI.
- [ ] Public-surface test confirms `buildDefaultCodeAuthorExecutor` alias resolves to `buildDiffBasedCodeAuthorExecutor`.

## Out of scope

- Real Claude Code CLI subprocess integration (still skeleton-only; separate follow-up).
- Other-actor migrations (planning, auditor, pr-landing).
- At-rest encryption.

## Related

- Spec: PR #166 (`02589d1`).
- Tracks task #78.
EOF
)"
```

- [ ] **Step 6: Trigger CR review**

```bash
node scripts/trigger-cr-review.mjs --pr <pr-number>
```

- [ ] **Step 7: Drive to merge**

Wait for CR + CI. Address findings; iterate; merge when CodeRabbit status is SUCCESS + all checks green + zero unresolved threads.

After merge:

```bash
git checkout main
git pull origin main
```

(Per `feedback_pull_main_after_pr_merge`.)

---

## Out of scope (future follow-ups)

- Real Claude Code CLI integration (multi-turn subprocess + tool whitelist + cost tracking).
- PlanningActor / AuditorActor / PrLandingActor migrations to the seam.
- At-rest encryption for atom store + blob store (deferred per spec Section 8.3).
- Replay UI for the session tree.
- Cross-actor session-tree projection / dashboard.

## Notes for the implementer

1. The existing diff-based executor (`code-author-executor-default.ts` before rename) is the reference for fence handling, plan-atom metadata extraction, and PR body rendering. Mirror those patterns rather than reinvent.
2. Read `code-author-invoker.ts` lines 102-142 FIRST before writing the executor body; the `CodeAuthorExecutor.execute()` signature is the contract you must satisfy.
3. The `AgentLoopAdapter`'s `run()` returns a structured `AgentLoopResult`. Translate it deterministically; the `stage` strings the executor emits become observation-atom payloads downstream.
4. Workspace cleanup is non-negotiable. Use try/finally; the test pins this.

## Provenance

- Spec: `docs/superpowers/specs/2026-04-25-agentic-actor-loop-design.md` Section 8.2 (PR2 plan).
- PR1: #166 squash-merged at `02589d1` on 2026-04-25 10:15:27Z.
- Memories: `feedback_security_correctness_at_write_time`, `feedback_lint_ci_fidelity_discipline`, `feedback_pull_main_after_pr_merge`, `feedback_cr_recurring_pattern_presubmit_checklist`, `feedback_cr_status_requires_branch_up_to_date`, `feedback_git_as_minus_u_leaks_token`.
