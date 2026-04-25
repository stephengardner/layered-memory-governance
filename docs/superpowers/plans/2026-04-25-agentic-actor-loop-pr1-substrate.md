# Agentic Actor Loop PR1 Implementation Plan - Substrate Foundations

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the substrate-level foundations of the agentic actor loop (4 pluggable seams + 2 atom types + 2 policy types + replay-projection helpers + 4 reference adapters in `examples/`) so any actor can later opt into multi-turn agentic reasoning. PR2 will migrate `CodeAuthorExecutor` as the first consumer.

**Architecture:** Per spec at `docs/superpowers/specs/2026-04-25-agentic-actor-loop-design.md`. The seam interfaces live in `src/substrate/`. Concrete adapters (Claude Code, git-worktree, file blob, regex redactor) live in `examples/` so the substrate stays mechanism-only. Atom additions are purely additive (new entries in the existing `AtomType` union). Policies extend the existing pol-* pattern.

**Tech stack:** TypeScript (strict), vitest, Node 22, existing LAG primitives (Host, AtomStore, Auditor). Tests use `MemoryHost` from `src/adapters/memory/`. Reference adapters in `examples/` are import-paths only - they ship as TypeScript source the indie copy-pastes; no separate npm package.

**Cross-cutting discipline:** Every task carries a "Security + correctness considerations" subsection. The implementer subagent walks through these BEFORE writing code, not after CR flags it. Memory: `feedback_security_correctness_at_write_time`.

---

## File structure

### New files in `src/substrate/`

| File | Responsibility |
|---|---|
| `agent-loop.ts` | `AgentLoopAdapter` interface + `AdapterCapabilities` + `AgentLoopInput` + `AgentLoopResult` + `FailureKind` + `FailureRecord` + default failure-kind classifier `defaultClassifyFailure(err)`. |
| `workspace-provider.ts` | `WorkspaceProvider` + `Workspace` + `AcquireInput` interfaces. |
| `blob-store.ts` | `BlobStore` interface + `BlobRef` branded type + `blobRefFromHash(hex)` constructor + `parseBlobRef(string)` parser. |
| `redactor.ts` | `Redactor` + `RedactContext` interfaces. |
| `agent-budget.ts` | `BudgetCap`, `ReplayTier` types + helpers (`clampBlobThreshold`, `defaultBudgetCap`). |
| `policy/replay-tier.ts` | `pol-replay-tier` parser + atom-id helper + `loadReplayTier(atoms, principal, actorType)` resolver. |
| `policy/blob-threshold.ts` | `pol-blob-threshold` parser with clamp + atom-id helper + `loadBlobThreshold(atoms, principal, actorType)` resolver. |
| `projections/session-tree.ts` | Read-only projection that walks dispatch atoms by `correlation_id` to produce `SessionTreeNode[]`. |

### Modified files in `src/substrate/`

| File | Change |
|---|---|
| `types.ts` | Add `'agent-session'` and `'agent-turn'` to `AtomType` union. Add `AgentSessionMeta` and `AgentTurnMeta` shape interfaces. Add `BlobRef` branded type. |
| `index.ts` | Re-export new modules: `agentLoop`, `workspaceProvider`, `blobStore`, `redactor`, `policy/replayTier`, `policy/blobThreshold`, `projections/sessionTree`. |

### New files in `examples/`

| File | Responsibility |
|---|---|
| `examples/blob-stores/file/blob-store.ts` | `FileBlobStore` reference: writes to `<root>/.lag/blobs/<first2chars>/<sha256>`. |
| `examples/blob-stores/file/index.ts` | Re-export `FileBlobStore`. |
| `examples/blob-stores/file/README.md` | One-page indie how-to: copy this dir, instantiate, pass to executor. |
| `examples/redactors/regex-default/redactor.ts` | `RegexRedactor` reference + default pattern set. |
| `examples/redactors/regex-default/patterns.ts` | Default regex patterns (AWS keys, GH PATs, App tokens, JWT-shaped, generic high-entropy). |
| `examples/redactors/regex-default/index.ts` | Re-export. |
| `examples/redactors/regex-default/README.md` | Indie how-to + extension instructions. |
| `examples/workspace-providers/git-worktree/provider.ts` | `GitWorktreeProvider` reference. |
| `examples/workspace-providers/git-worktree/index.ts` | Re-export. |
| `examples/workspace-providers/git-worktree/README.md` | Indie how-to. |
| `examples/agent-loops/claude-code/loop.ts` | `ClaudeCodeAgentLoop` reference adapter. |
| `examples/agent-loops/claude-code/index.ts` | Re-export. |
| `examples/agent-loops/claude-code/README.md` | Indie how-to. |

### New test files

| File | Responsibility |
|---|---|
| `test/substrate/blob-store-contract.test.ts` | Contract that any `BlobStore` impl must pass. |
| `test/substrate/redactor-contract.test.ts` | Contract that any `Redactor` impl must pass. |
| `test/substrate/workspace-provider-contract.test.ts` | Contract any `WorkspaceProvider` impl must pass. |
| `test/substrate/agent-loop-contract.test.ts` | Contract any `AgentLoopAdapter` must pass + default failure classifier. |
| `test/substrate/atom-types.test.ts` | `agent-session` / `agent-turn` shape tests; metadata round-trip. |
| `test/substrate/policy/replay-tier.test.ts` | Resolution order tests; default fallback. |
| `test/substrate/policy/blob-threshold.test.ts` | Clamp tests at 256 / 1_048_576; default fallback; resolution order. |
| `test/substrate/projections/session-tree.test.ts` | Tree reconstruction by `correlation_id`. |
| `test/examples/file-blob-store.test.ts` | Round-trip; dedup; sharded path layout. |
| `test/examples/regex-redactor.test.ts` | Each pattern covered with positive + negative cases. |
| `test/examples/git-worktree-provider.test.ts` | Acquire creates worktree; release cleans up. |
| `test/examples/claude-code-agent-loop.test.ts` | Run against fixture plan in tmpdir; turn atoms emitted; redaction applied. |

---

## Tasks

Tasks ordered to minimize cross-task blocking. Each task is self-contained: a fresh subagent can pick up any task that has its dependencies completed without re-reading earlier ones.

---

### Task 1: Add `agent-session` + `agent-turn` to `AtomType` union and add metadata shapes

**Files:**
- Modify: `src/substrate/types.ts`
- Test: `test/substrate/atom-types.test.ts`

**Security + correctness considerations:**
- Additive only: must NOT remove or rename existing `AtomType` entries. Existing atom-store reads must continue to round-trip.
- The metadata shapes are interfaces, not enums or literal-string unions - operators can extend `metadata.agent_session.extra` later. Confirm the metadata types use `interface` not `type` (so declaration-merging is possible if later needed; though we don't intend it now, the option is preserved).
- `BlobRef` is a branded type to prevent accidental mixing with raw `string`. Confirm the brand isn't accessible at runtime (only at type-check time).
- New entries must NOT break the existing zod / runtime-validation layer if any (`MemoryAtomStore` uses no runtime validation, but `FileAtomStore` may; verify both paths accept the new types).
- Edge case: an atom with `type: 'agent-session'` written by a future version + read by an older version: ensure the reader doesn't crash. Check `src/adapters/file/atom-store.ts`, `src/adapters/memory/atom-store.ts`, AND `src/runtime/`, `src/substrate/promotion/` for switch-on-type code paths (broaden the grep scope so we don't miss a hidden exhaustive switch).
- **derived_from at provenance vs metadata level (BOTH required):** the `agent-turn` atom MUST carry the parent `agent-session` id in BOTH `provenance.derived_from` AND `metadata.agent_turn.session_atom_id`. They serve different concerns:
  - `provenance.derived_from` is the substrate-wide chain pointer used by taint propagation, audit, and the framework's standard atom-graph traversal.
  - `metadata.agent_turn.session_atom_id` is the projection-specific pointer used by `buildSessionTree` for ordering + cheap session-scoped queries without parsing provenance arrays.
  Collapsing one into the other (using only provenance, or only metadata) is a substrate violation. Future readers may add validators that enforce both pointers match; pre-empt this by writing both correctly from day one.

- [ ] **Step 1: Read the existing `AtomType` union and find consumers**

```bash
grep -nP "AtomType[^A-Z]" src/substrate/types.ts
grep -rnP "atom\.type\s*===\s*['\"]" src/ test/
# Broaden: switch statements + exhaustive-check assertions hide here too.
grep -rnP "switch\s*\(.*\.type\)" src/runtime/ src/substrate/ src/adapters/ src/actors/
grep -rnP "AtomType\s*=>" src/runtime/ src/substrate/ src/adapters/ src/actors/
```

Expected: identifies the union definition (around line 49 of `types.ts`) and any switch-on-type consumers across `runtime/`, `substrate/`, `adapters/`, and `actors/`.

- [ ] **Step 2: Write the failing test**

`test/substrate/atom-types.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Atom, AtomId, PrincipalId } from '../../src/substrate/types.js';
import type { AgentSessionMeta, AgentTurnMeta, BlobRef } from '../../src/substrate/types.js';

describe('AtomType union: agent-session + agent-turn', () => {
  it('accepts agent-session as a type', () => {
    const a: Atom = {
      schema_version: 1,
      id: 'agent-session-test' as AtomId,
      content: 'session content',
      type: 'agent-session',
      layer: 'L1',
      provenance: { kind: 'agent-observed', source: { agent_id: 'cto-actor' }, derived_from: [] },
      confidence: 1,
      created_at: '2026-04-25T00:00:00.000Z',
      last_reinforced_at: '2026-04-25T00:00:00.000Z',
      expires_at: null,
      supersedes: [],
      superseded_by: [],
      scope: 'project',
      signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
      principal_id: 'cto-actor' as PrincipalId,
      taint: 'clean',
      metadata: { agent_session: { model_id: 'claude-opus-4-7', adapter_id: 'claude-code-agent-loop', workspace_id: 'ws-1', started_at: '2026-04-25T00:00:00.000Z', terminal_state: 'completed', replay_tier: 'content-addressed', budget_consumed: { turns: 5, wall_clock_ms: 12000 } } satisfies AgentSessionMeta },
    };
    expect(a.type).toBe('agent-session');
  });

  it('accepts agent-turn as a type', () => {
    const t: Atom = {
      schema_version: 1,
      id: 'agent-turn-test' as AtomId,
      content: 'turn content',
      type: 'agent-turn',
      layer: 'L1',
      provenance: { kind: 'agent-observed', source: { agent_id: 'cto-actor' }, derived_from: ['agent-session-test' as AtomId] },
      confidence: 1,
      created_at: '2026-04-25T00:00:00.000Z',
      last_reinforced_at: '2026-04-25T00:00:00.000Z',
      expires_at: null,
      supersedes: [],
      superseded_by: [],
      scope: 'project',
      signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
      principal_id: 'cto-actor' as PrincipalId,
      taint: 'clean',
      metadata: { agent_turn: { session_atom_id: 'agent-session-test' as AtomId, turn_index: 0, llm_input: { inline: 'input' }, llm_output: { inline: 'output' }, tool_calls: [], latency_ms: 1200 } satisfies AgentTurnMeta },
    };
    expect(t.type).toBe('agent-turn');
  });

  it('BlobRef is a branded type that requires the brand', () => {
    const b: BlobRef = 'sha256:abc' as BlobRef;
    expect(typeof b).toBe('string');
  });
});
```

- [ ] **Step 3: Run test to verify it fails (compilation)**

```bash
npx vitest run test/substrate/atom-types.test.ts 2>&1 | tail -10
```

Expected: TypeScript error / vitest fails because `'agent-session'` and `'agent-turn'` are not in `AtomType`, and `AgentSessionMeta` / `AgentTurnMeta` / `BlobRef` are not exported from `types.ts`.

- [ ] **Step 4: Add to `src/substrate/types.ts`**

Locate the `AtomType` union (around line 49) and append:

```ts
export type AtomType =
  | 'directive'
  | 'observation'
  | 'decision'
  | 'preference'
  | 'reference'
  | 'ephemeral'
  | 'plan'
  | 'question'
  | 'actor-message'
  | 'actor-message-ack'
  | 'circuit-breaker-trip'
  | 'circuit-breaker-reset'
  | 'plan-approval-vote'
  | 'plan-merge-settled'
  | 'operator-intent'
  // Agentic actor loop substrate (PR1 of agentic-actor-loop spec).
  // agent-session: one per agent run; principal-bound.
  // agent-turn:    one per LLM call within a session; derived_from
  //                points at the parent agent-session.
  | 'agent-session'
  | 'agent-turn';
```

After the existing branded types, append `BlobRef`:

```ts
/**
 * Content-addressed reference for `BlobStore`. Format: `sha256:<64-hex>`.
 * Constructed via `blobRefFromHash` in `src/substrate/blob-store.ts`. Branded
 * so callers cannot accidentally pass arbitrary strings where a BlobRef is
 * required.
 */
export type BlobRef = string & { readonly __brand: 'BlobRef' };
```

After the existing Meta shapes (or near the bottom of the file), append:

```ts
/**
 * Replay determinism tier. See spec Section 3.6 + 4.1.
 */
export type ReplayTier = 'best-effort' | 'content-addressed' | 'strict';

/**
 * Failure taxonomy. See spec Section 5.1.
 */
export type FailureKind = 'transient' | 'structural' | 'catastrophic';

export interface FailureRecord {
  readonly kind: FailureKind;
  readonly reason: string;
  /** e.g. 'workspace-acquire', 'agent-init', 'turn-3', 'commit'. */
  readonly stage: string;
}

/**
 * Stored on atoms with `type: 'agent-session'` under `metadata.agent_session`.
 */
export interface AgentSessionMeta {
  readonly model_id: string;
  readonly adapter_id: string;
  readonly workspace_id: string;
  readonly started_at: Time;
  readonly completed_at?: Time;
  readonly terminal_state: 'completed' | 'budget-exhausted' | 'error' | 'aborted';
  readonly replay_tier: ReplayTier;
  /** Strict tier only. */
  readonly canon_snapshot_blob_ref?: BlobRef;
  readonly budget_consumed: {
    readonly turns: number;
    readonly wall_clock_ms: number;
    readonly usd?: number;
  };
  readonly failure?: FailureRecord;
  /** Open extension for adapter-specific metadata. */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * Stored on atoms with `type: 'agent-turn'` under `metadata.agent_turn`.
 * The atom's `derived_from` MUST include the parent agent-session atom id.
 */
export interface AgentTurnMeta {
  readonly session_atom_id: AtomId;
  /** 0-based turn index within the session. */
  readonly turn_index: number;
  readonly llm_input: { readonly ref: BlobRef } | { readonly inline: string };
  readonly llm_output: { readonly ref: BlobRef } | { readonly inline: string };
  readonly tool_calls: ReadonlyArray<{
    readonly tool: string;
    readonly args: { readonly ref: BlobRef } | { readonly inline: string };
    readonly result: { readonly ref: BlobRef } | { readonly inline: string };
    readonly latency_ms: number;
    readonly outcome: 'success' | 'tool-error' | 'policy-refused';
  }>;
  readonly latency_ms: number;
  readonly failure?: FailureRecord;
  readonly extra?: Readonly<Record<string, unknown>>;
}
```

- [ ] **Step 5: Verify atom-store implementations accept the new types without changes**

```bash
grep -rnP "atom\.type" src/adapters/memory/atom-store.ts src/adapters/file/atom-store.ts
```

Expected: only generic operations (`get(id)`, `query({type: ...})`); no exhaustive switch that requires extension. Confirm round-trip for the new types is automatic.

If any adapter has an exhaustive switch on `AtomType`, surface that and add the new types to it.

- [ ] **Step 6: Run test to verify it passes**

```bash
npx vitest run test/substrate/atom-types.test.ts 2>&1 | tail -10
npx tsc --noEmit 2>&1 | tail -10
```

Expected: vitest passes; tsc has no new errors.

- [ ] **Step 7: Commit**

```bash
node scripts/git-as.mjs lag-ceo add src/substrate/types.ts test/substrate/atom-types.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(substrate): add agent-session + agent-turn atom types and BlobRef"
```

---

### Task 2: `BlobStore` interface + `BlobRef` constructor/parser

**Files:**
- Create: `src/substrate/blob-store.ts`
- Test: `test/substrate/blob-store-contract.test.ts`

**Security + correctness considerations:**
- `BlobRef` parser MUST reject malformed inputs (wrong prefix, wrong hex length) with a typed error rather than silently accepting. A bad ref reaching `BlobStore.get()` would produce file-system errors, which is a worse failure mode than a structured parse failure.
- The `BlobStore` interface MUST NOT expose internal storage paths. Adapters that use file paths internally are an implementation detail; the interface is content-addressed.
- `put()` MUST be idempotent: putting the same content twice returns the same `BlobRef`. The contract test pins this.
- Concurrency: two `put()`s of the same content racing should not corrupt storage. The interface contract names this; adapter implementations are responsible for atomic write.
- No `delete()` method - content-addressed blobs are immutable. Garbage collection is a separate concern (out of scope for PR1).

- [ ] **Step 1: Write the failing test**

`test/substrate/blob-store-contract.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { blobRefFromHash, parseBlobRef } from '../../src/substrate/blob-store.js';
import type { BlobStore, BlobRef } from '../../src/substrate/blob-store.js';

describe('blobRefFromHash + parseBlobRef', () => {
  it('round-trips a 64-char hex hash', () => {
    const hex = 'a'.repeat(64);
    const ref = blobRefFromHash(hex);
    expect(ref).toBe(`sha256:${hex}`);
    expect(parseBlobRef(ref)).toEqual({ algorithm: 'sha256', hex });
  });

  it('rejects non-hex characters', () => {
    expect(() => blobRefFromHash('z'.repeat(64))).toThrow(/hex/);
  });

  it('rejects wrong length', () => {
    expect(() => blobRefFromHash('a'.repeat(63))).toThrow(/length/);
    expect(() => blobRefFromHash('a'.repeat(65))).toThrow(/length/);
  });

  it('parseBlobRef rejects missing prefix', () => {
    expect(() => parseBlobRef('a'.repeat(64) as BlobRef)).toThrow(/prefix/);
  });

  it('parseBlobRef rejects unsupported algorithm', () => {
    expect(() => parseBlobRef('md5:abc' as BlobRef)).toThrow(/sha256/);
  });
});

/**
 * Contract test runner. Any `BlobStore` impl can pass this fixture in
 * to verify it satisfies the interface contract.
 */
export function runBlobStoreContract(name: string, build: () => Promise<{ store: BlobStore; cleanup: () => Promise<void> }>) {
  describe(`BlobStore contract: ${name}`, () => {
    it('round-trips bytes', async () => {
      const { store, cleanup } = await build();
      try {
        const ref = await store.put('hello world');
        const back = await store.get(ref);
        expect(back.toString('utf8')).toBe('hello world');
      } finally {
        await cleanup();
      }
    });

    it('put is idempotent: same content yields same ref', async () => {
      const { store, cleanup } = await build();
      try {
        const r1 = await store.put('same content');
        const r2 = await store.put('same content');
        expect(r1).toBe(r2);
      } finally {
        await cleanup();
      }
    });

    it('has() reflects put()', async () => {
      const { store, cleanup } = await build();
      try {
        const ref = await store.put('xyz');
        expect(await store.has(ref)).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it('has() returns false for unknown ref', async () => {
      const { store, cleanup } = await build();
      try {
        const fake = blobRefFromHash('0'.repeat(64));
        expect(await store.has(fake)).toBe(false);
      } finally {
        await cleanup();
      }
    });
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/substrate/blob-store-contract.test.ts 2>&1 | tail -10
```

Expected: module-not-found or symbol-not-exported.

- [ ] **Step 3: Implement `src/substrate/blob-store.ts`**

```ts
/**
 * BlobStore: content-addressed storage seam.
 *
 * Why this exists
 * ---------------
 * Agent-turn atoms can carry large LLM IO + tool-call payloads (file
 * reads, bash output dumps). Inlining everything blows up atom file
 * size and forfeits dedup. Above the per-actor `pol-blob-threshold`,
 * payloads are externalized to a BlobStore by content hash; the turn
 * atom holds only a small `BlobRef`.
 *
 * Threat model
 * ------------
 * - Blobs are content-addressed; immutability is implicit.
 * - At-rest encryption is OUT OF SCOPE for PR1 (deferred per spec
 *   Section 8.3). Treat blob storage as having the same trust
 *   boundary as the rest of `.lag/`.
 * - Adapters MUST atomic-write to avoid two concurrent `put()` of the
 *   same content corrupting each other.
 * - Adapters MUST NOT expose internal storage paths through the
 *   interface; consumers depend only on `BlobRef`.
 *
 * Pluggability
 * ------------
 * Reference adapter: `examples/blob-stores/file/`. Org swaps for S3,
 * Postgres LOB, in-memory (tests), etc. The interface contract test
 * (`test/substrate/blob-store-contract.test.ts`) is the conformance
 * floor.
 */

import type { BlobRef } from './types.js';

export type { BlobRef } from './types.js';

export interface BlobStore {
  /**
   * Persist `content`. Returns a content-addressed `BlobRef`.
   * Idempotent: identical content yields identical ref. Adapters
   * implementing this MUST be safe under concurrent calls with the
   * same content (atomic write).
   */
  put(content: Buffer | string): Promise<BlobRef>;

  /** Retrieve. Throws if the ref is unknown. Always returns Buffer. */
  get(ref: BlobRef): Promise<Buffer>;

  /** Existence check. Returns false on unknown ref (does not throw). */
  has(ref: BlobRef): Promise<boolean>;
}

const SHA256_PREFIX = 'sha256:';
const HEX_64 = /^[0-9a-f]{64}$/;

export class BlobRefError extends Error {
  constructor(message: string) {
    super(`BlobRef: ${message}`);
    this.name = 'BlobRefError';
  }
}

/**
 * Construct a `BlobRef` from a 64-char lowercase hex sha256 digest.
 * Throws `BlobRefError` on malformed input. Adapter implementations
 * call this after computing the digest of the content they wrote.
 */
export function blobRefFromHash(hexDigest: string): BlobRef {
  if (typeof hexDigest !== 'string') {
    throw new BlobRefError(`expected string, got ${typeof hexDigest}`);
  }
  if (hexDigest.length !== 64) {
    throw new BlobRefError(`length must be 64, got ${hexDigest.length}`);
  }
  if (!HEX_64.test(hexDigest)) {
    throw new BlobRefError('value is not lowercase hex');
  }
  return `${SHA256_PREFIX}${hexDigest}` as BlobRef;
}

/**
 * Parse a `BlobRef` back to its components. Throws `BlobRefError` on
 * malformed input. Useful for adapter-side path computation
 * (sharded file system: `blobs/<first2chars>/<hex>`).
 */
export function parseBlobRef(ref: BlobRef): { readonly algorithm: 'sha256'; readonly hex: string } {
  if (typeof ref !== 'string') {
    throw new BlobRefError(`expected string, got ${typeof ref}`);
  }
  if (!ref.startsWith(SHA256_PREFIX)) {
    throw new BlobRefError(`missing 'sha256:' prefix: ${String(ref).slice(0, 16)}...`);
  }
  const hex = ref.slice(SHA256_PREFIX.length);
  if (!HEX_64.test(hex)) {
    throw new BlobRefError(`unsupported algorithm or malformed body; only sha256 64-char hex accepted`);
  }
  return { algorithm: 'sha256', hex };
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run test/substrate/blob-store-contract.test.ts 2>&1 | tail -10
```

Expected: 5 tests pass (the constructor + parser tests). The `runBlobStoreContract` helper is exported but no impl runs it yet - that comes in Task 9.

- [ ] **Step 5: Commit**

```bash
node scripts/git-as.mjs lag-ceo add src/substrate/blob-store.ts test/substrate/blob-store-contract.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(substrate): BlobStore interface + BlobRef constructor/parser"
```

---

### Task 3: `Redactor` interface + contract test

**Files:**
- Create: `src/substrate/redactor.ts`
- Test: `test/substrate/redactor-contract.test.ts`

**Security + correctness considerations:**
- The `Redactor` interface MUST be pure. Same input → same output. No file IO, no network. The contract test asserts purity.
- `redact()` MUST be idempotent: redacting twice yields the same string. This matters because retry paths may redact already-redacted content; double-redaction must not corrupt.
- Failure mode: if a Redactor implementation throws, the caller treats this as a `catastrophic` failure (per spec Section 5.1). The interface contract names this expectation; adapters MUST throw - not silently fail-open - when they cannot redact.
- Default-deny posture: a custom Redactor that crashes is safer than one that returns the input unchanged on error. This is the opposite of most error-handling discipline; it is intentional for secrets.
- Threat model: a malicious LLM output could try to bypass redaction patterns (e.g., split a key across a newline). The interface contract names this risk; the reference adapter (Task 10) addresses it via pattern coverage; pattern completeness is the operator's responsibility for org-specific secrets.

- [ ] **Step 1: Write failing test**

`test/substrate/redactor-contract.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Redactor, RedactContext } from '../../src/substrate/redactor.js';
import type { PrincipalId } from '../../src/substrate/types.js';

const TEST_CTX: RedactContext = {
  kind: 'tool-result',
  principal: 'test-principal' as PrincipalId,
};

export function runRedactorContract(name: string, build: () => Redactor) {
  describe(`Redactor contract: ${name}`, () => {
    it('is pure: same input yields same output', () => {
      const r = build();
      const s = 'AKIAIOSFODNN7EXAMPLE access key';
      expect(r.redact(s, TEST_CTX)).toBe(r.redact(s, TEST_CTX));
    });

    it('is idempotent: redacting twice equals redacting once', () => {
      const r = build();
      const s = 'AKIAIOSFODNN7EXAMPLE access key';
      const once = r.redact(s, TEST_CTX);
      const twice = r.redact(once, TEST_CTX);
      expect(twice).toBe(once);
    });

    it('does not crash on empty input', () => {
      const r = build();
      expect(r.redact('', TEST_CTX)).toBe('');
    });

    it('does not crash on multi-line input with secrets across lines', () => {
      const r = build();
      const multi = 'line one\nline two\nAKIAIOSFODNN7EXAMPLE\nline four';
      const out = r.redact(multi, TEST_CTX);
      expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    });
  });
}

describe('redactor module', () => {
  it('exports the Redactor + RedactContext types', () => {
    // Type-only smoke; module loads.
    const ctx: RedactContext = TEST_CTX;
    expect(ctx.kind).toBe('tool-result');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/substrate/redactor-contract.test.ts 2>&1 | tail -10
```

Expected: module-not-found.

- [ ] **Step 3: Implement `src/substrate/redactor.ts`**

```ts
/**
 * Redactor: at-write content filter for the agentic actor loop.
 *
 * Why this exists
 * ---------------
 * Agent reasoning traces, tool-call args, and tool-call results can
 * contain secrets pulled into the LLM context (operator credentials,
 * customer data, API keys). Per spec Section 5, secrets must never
 * enter the atom store; redaction happens at-write before the atom
 * is persisted.
 *
 * Threat model
 * ------------
 * - Pattern coverage is the operator's responsibility for org-specific
 *   secrets. The reference `RegexRedactor` covers common third-party
 *   formats (AWS keys, GH PATs, App tokens, JWT-shaped, generic
 *   high-entropy) but NOT org-specific patterns (customer IDs,
 *   internal API tokens). Encourage org override.
 * - A malicious LLM output could attempt to bypass redaction by
 *   splitting a secret across whitespace boundaries. Pattern
 *   completeness is the operator's mitigation; the framework's
 *   contribution is the seam.
 * - Redactor implementations MUST throw on internal failure rather
 *   than fall through. A crashed Redactor surfaces as a
 *   `catastrophic` failure (see spec Section 5.1) which halts the
 *   session before any unredacted content reaches the atom store.
 *
 * Contract
 * --------
 * - Pure: same input yields same output. No IO. No mutable state.
 * - Idempotent: redacting twice equals redacting once. Retry paths
 *   may pass already-redacted content; redaction MUST NOT corrupt it.
 * - Empty input returns empty string (not throw).
 *
 * Pluggability
 * ------------
 * Reference adapter: `examples/redactors/regex-default/`. Org swaps
 * for a custom pattern set (e.g., reading patterns from canon).
 */

import type { PrincipalId } from './types.js';

export interface Redactor {
  redact(content: string, context: RedactContext): string;
}

export interface RedactContext {
  /** Where this content is flowing in the agent loop. */
  readonly kind: 'llm-input' | 'llm-output' | 'tool-args' | 'tool-result';
  /** Present for tool-args / tool-result. */
  readonly tool?: string;
  /** The principal whose session is producing this content. */
  readonly principal: PrincipalId;
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run test/substrate/redactor-contract.test.ts 2>&1 | tail -10
```

Expected: type-load smoke test passes; the `runRedactorContract` exported helper is wired but no impl runs it yet.

- [ ] **Step 5: Commit**

```bash
node scripts/git-as.mjs lag-ceo add src/substrate/redactor.ts test/substrate/redactor-contract.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(substrate): Redactor interface + contract test scaffolding"
```

---

### Task 4: `WorkspaceProvider` interface + contract test

**Files:**
- Create: `src/substrate/workspace-provider.ts`
- Test: `test/substrate/workspace-provider-contract.test.ts`

**Security + correctness considerations:**
- The `Workspace.path` returned by `acquire()` MUST be an absolute path the caller can write to. Relative paths would break across CWD changes.
- `release()` MUST be idempotent: calling it twice with the same workspace must not throw or corrupt. Real-world: an executor's `try/finally` may invoke release in both branches.
- Acquire-failure semantics: if `acquire()` rejects, the caller knows nothing was created. If `acquire()` resolves, a release-pair is required (caller's responsibility). Document this contract.
- The workspace MAY contain bot creds copied from the parent; the implementer is responsible for setting up the credential surface BEFORE returning the workspace handle. Memory: `feedback_bot_creds_copy_to_new_worktrees`.
- Cross-user isolation: the reference `GitWorktreeProvider` is process-local (same OS user, same disk). Stronger isolation (docker, k8s) is opt-in via swap. Document this in the threat model.
- Cleanup-on-error: if the agent crashes mid-session, `release()` MUST still successfully clean up. Adapters that leave debug state for forensics are an opt-in extension, not the default.

- [ ] **Step 1: Write failing test**

`test/substrate/workspace-provider-contract.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { WorkspaceProvider, Workspace, AcquireInput } from '../../src/substrate/workspace-provider.js';
import type { PrincipalId } from '../../src/substrate/types.js';

const SAMPLE_INPUT: AcquireInput = {
  principal: 'test-principal' as PrincipalId,
  baseRef: 'main',
  correlationId: 'corr-test-1',
};

export function runWorkspaceProviderContract(name: string, build: () => WorkspaceProvider) {
  describe(`WorkspaceProvider contract: ${name}`, () => {
    it('acquire returns absolute workspace path', async () => {
      const p = build();
      const ws = await p.acquire(SAMPLE_INPUT);
      try {
        expect(ws.path).toMatch(/^([A-Za-z]:)?[/\\]/);
        expect(ws.baseRef).toBe('main');
      } finally {
        await p.release(ws);
      }
    });

    it('release is idempotent', async () => {
      const p = build();
      const ws = await p.acquire(SAMPLE_INPUT);
      await p.release(ws);
      // Second release MUST NOT throw.
      await p.release(ws);
    });

    it('acquired workspaces have distinct ids', async () => {
      const p = build();
      const a = await p.acquire(SAMPLE_INPUT);
      const b = await p.acquire({ ...SAMPLE_INPUT, correlationId: 'corr-test-2' });
      try {
        expect(a.id).not.toBe(b.id);
      } finally {
        await p.release(a);
        await p.release(b);
      }
    });
  });
}

describe('workspace-provider module', () => {
  it('exports types', () => {
    const ws: Workspace = { id: 'x', path: '/tmp/x', baseRef: 'main' };
    expect(ws.id).toBe('x');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/substrate/workspace-provider-contract.test.ts 2>&1 | tail -10
```

Expected: module-not-found.

- [ ] **Step 3: Implement `src/substrate/workspace-provider.ts`**

```ts
/**
 * WorkspaceProvider: isolated workspace seam for the agentic actor loop.
 *
 * Why this exists
 * ---------------
 * The agent loop runs an LLM-driven sub-agent that mutates files. The
 * mutation must be isolated from the primary working tree so:
 *  (1) concurrent runs do not race on the same files;
 *  (2) a crashed run leaves no half-applied state in the primary;
 *  (3) credentials provisioned for one principal do not leak into
 *      another principal's workspace.
 *
 * Threat model
 * ------------
 * - The workspace path is filesystem-visible; do not embed secrets in
 *   it. The reference adapter uses correlation_id + a short nonce.
 * - Workspaces MAY contain bot creds copied from a parent. The
 *   provider is responsible for cred provisioning at acquire time
 *   and cleanup at release time. Memory:
 *   feedback_bot_creds_copy_to_new_worktrees.
 * - The reference `GitWorktreeProvider` is process-local (same OS
 *   user, same disk). Stronger isolation (docker, k8s) is an opt-in
 *   swap; the seam is unchanged.
 * - Cleanup-on-error: `release()` MUST succeed even after an agent
 *   crash. Adapter implementations should not assume the workspace
 *   is in a sane state.
 *
 * Contract
 * --------
 * - `acquire()` resolved => caller MUST eventually call `release()`.
 *   Failure to release leaks workspace state.
 * - `acquire()` rejected => nothing to clean up.
 * - `release()` is idempotent (safe to call multiple times).
 * - `Workspace.path` is absolute.
 */

import type { PrincipalId } from './types.js';

export interface WorkspaceProvider {
  acquire(input: AcquireInput): Promise<Workspace>;
  release(workspace: Workspace): Promise<void>;
}

export interface AcquireInput {
  /** Whose work is this for? Drives cred copying / isolation. */
  readonly principal: PrincipalId;
  /** Base ref the workspace branches from (e.g. 'main'). */
  readonly baseRef: string;
  /** Dispatch correlation id; ties the workspace to the chain. */
  readonly correlationId: string;
}

export interface Workspace {
  /** Provider-internal id; surfaced for logs + atom workspace_id. */
  readonly id: string;
  /** Absolute path on the filesystem where the agent operates. */
  readonly path: string;
  /** Base ref the workspace was created from. */
  readonly baseRef: string;
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run test/substrate/workspace-provider-contract.test.ts 2>&1 | tail -10
```

Expected: type-load smoke test passes.

- [ ] **Step 5: Commit**

```bash
node scripts/git-as.mjs lag-ceo add src/substrate/workspace-provider.ts test/substrate/workspace-provider-contract.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(substrate): WorkspaceProvider interface + contract test scaffolding"
```

---

### Task 5: `BudgetCap` + `clampBlobThreshold` helpers (`agent-budget.ts`)

**Files:**
- Create: `src/substrate/agent-budget.ts`
- Test: `test/substrate/agent-budget.test.ts`

**Security + correctness considerations:**
- `clampBlobThreshold` MUST clamp at the documented bounds (256 / 1_048_576). Not clamping is an open door for an operator to set threshold=0 (DoS the blob store with tiny entries) or threshold=Infinity (atoms balloon to MBs).
- Default value MUST be a constant exported from the module so callers can reference it (avoids drift between docs and code).
- `BudgetCap` shape MUST permit `max_usd?: number | undefined` so adapters that cannot track cost don't carry meaningless zeros.

- [ ] **Step 1: Write failing test**

`test/substrate/agent-budget.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  BLOB_THRESHOLD_MIN,
  BLOB_THRESHOLD_MAX,
  BLOB_THRESHOLD_DEFAULT,
  clampBlobThreshold,
  defaultBudgetCap,
} from '../../src/substrate/agent-budget.js';

describe('clampBlobThreshold', () => {
  it('clamps at min', () => { expect(clampBlobThreshold(0)).toBe(BLOB_THRESHOLD_MIN); });
  it('clamps at max', () => { expect(clampBlobThreshold(BLOB_THRESHOLD_MAX + 1)).toBe(BLOB_THRESHOLD_MAX); });
  it('passes through valid', () => { expect(clampBlobThreshold(8192)).toBe(8192); });
  it('floors fractional', () => { expect(clampBlobThreshold(4096.7)).toBe(4096); });
  it('rejects NaN by clamping to min', () => { expect(clampBlobThreshold(Number.NaN)).toBe(BLOB_THRESHOLD_MIN); });
  it('default is exported and within bounds', () => {
    expect(BLOB_THRESHOLD_DEFAULT).toBeGreaterThanOrEqual(BLOB_THRESHOLD_MIN);
    expect(BLOB_THRESHOLD_DEFAULT).toBeLessThanOrEqual(BLOB_THRESHOLD_MAX);
  });
});

describe('defaultBudgetCap', () => {
  it('returns a sane default', () => {
    const b = defaultBudgetCap();
    expect(b.max_turns).toBeGreaterThan(0);
    expect(b.max_wall_clock_ms).toBeGreaterThan(0);
    expect(b.max_usd).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/substrate/agent-budget.test.ts 2>&1 | tail -10
```

Expected: module-not-found.

- [ ] **Step 3: Implement `src/substrate/agent-budget.ts`**

```ts
/**
 * Budget + threshold helpers for the agentic actor loop.
 *
 * Threshold clamp + default budget are used by the policy parsers
 * (`policy/blob-threshold.ts`) and the executor (`agentic-code-author-
 * executor.ts` in PR2). Centralized here so the bounds are a single
 * source of truth.
 */

/** Minimum blob threshold; below this is DoS-prone (per-blob filesystem cost). */
export const BLOB_THRESHOLD_MIN = 256;

/** Maximum blob threshold; above this defeats blob storage's purpose. */
export const BLOB_THRESHOLD_MAX = 1_048_576;

/** Default blob threshold: 4 KB. Covers most LLM IO inline. */
export const BLOB_THRESHOLD_DEFAULT = 4096;

/**
 * Clamp a blob threshold to `[BLOB_THRESHOLD_MIN, BLOB_THRESHOLD_MAX]`.
 * NaN clamps to the minimum (defensive). Fractional inputs floor to
 * an integer.
 */
export function clampBlobThreshold(input: number): number {
  if (typeof input !== 'number' || Number.isNaN(input)) {
    return BLOB_THRESHOLD_MIN;
  }
  const floored = Math.floor(input);
  if (floored < BLOB_THRESHOLD_MIN) return BLOB_THRESHOLD_MIN;
  if (floored > BLOB_THRESHOLD_MAX) return BLOB_THRESHOLD_MAX;
  return floored;
}

/** Budget cap supplied to `AgentLoopAdapter.run`. */
export interface BudgetCap {
  readonly max_turns: number;
  readonly max_wall_clock_ms: number;
  /** Optional. Adapters whose `capabilities.tracks_cost === false` ignore. */
  readonly max_usd?: number;
}

/**
 * Sensible defaults: 30 turns, 10 minutes wall-clock, no USD cap.
 * Callers in production override per-actor via the executor config.
 */
export function defaultBudgetCap(): BudgetCap {
  return { max_turns: 30, max_wall_clock_ms: 10 * 60 * 1000 };
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run test/substrate/agent-budget.test.ts 2>&1 | tail -10
```

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
node scripts/git-as.mjs lag-ceo add src/substrate/agent-budget.ts test/substrate/agent-budget.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(substrate): BudgetCap + clampBlobThreshold helpers"
```

---

### Task 6: `AgentLoopAdapter` interface + default failure classifier

**Files:**
- Create: `src/substrate/agent-loop.ts`
- Test: `test/substrate/agent-loop-contract.test.ts`

**Security + correctness considerations:**
- The interface contract names what the adapter MUST do (write session atom on entry, write turn atom per call, apply Redactor, honor budget, honor signal). Bypassing any of these is a substrate violation; the contract test pins the visible behaviors.
- `AdapterCapabilities.classify_failure` is the trust seam for failure taxonomy. A buggy classifier mislabeling structural failures as transient causes infinite retry loops; mislabeling transient as catastrophic alarms operators on every blip. The default classifier (in this module) handles common cases; adapters override carefully.
- The `tool_calls[].outcome === 'policy-refused'` path MUST be reachable by the agent (returned to the LLM as a structured refusal it can reason about), not silently swallowed. Adapter contract names this.
- Cooperative cancellation via `signal` is opt-in per `capabilities.supports_signal`. Adapters without it rely on budget caps for termination; budget caps are mandatory.
- `AgentLoopResult.artifacts.commitSha` is sender-supplied; consumers (the executor in PR2) MUST verify the commit exists in the workspace before trusting it. The contract names this expectation.

- [ ] **Step 1: Write failing test**

`test/substrate/agent-loop-contract.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  defaultClassifyFailure,
} from '../../src/substrate/agent-loop.js';
import type {
  AgentLoopAdapter,
  AgentLoopInput,
  AgentLoopResult,
  AdapterCapabilities,
} from '../../src/substrate/agent-loop.js';
import type { FailureKind } from '../../src/substrate/types.js';

describe('defaultClassifyFailure', () => {
  it('classifies HTTP 429 as transient', () => {
    const err = Object.assign(new Error('Too Many Requests'), { statusCode: 429 });
    expect(defaultClassifyFailure(err)).toBe<FailureKind>('transient');
  });

  it('classifies HTTP 503 as transient', () => {
    const err = Object.assign(new Error('Service Unavailable'), { statusCode: 503 });
    expect(defaultClassifyFailure(err)).toBe<FailureKind>('transient');
  });

  it('classifies ECONNRESET as transient', () => {
    const err = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    expect(defaultClassifyFailure(err)).toBe<FailureKind>('transient');
  });

  it('classifies EBUSY (Windows transient) as transient', () => {
    const err = Object.assign(new Error('resource busy'), { code: 'EBUSY' });
    expect(defaultClassifyFailure(err)).toBe<FailureKind>('transient');
  });

  it('classifies AbortError as catastrophic (signal-aborted, do not retry)', () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(defaultClassifyFailure(err)).toBe<FailureKind>('catastrophic');
  });

  it('classifies generic Error as structural', () => {
    expect(defaultClassifyFailure(new Error('something else'))).toBe<FailureKind>('structural');
  });

  it('classifies non-Error as structural', () => {
    expect(defaultClassifyFailure('a string')).toBe<FailureKind>('structural');
    expect(defaultClassifyFailure(undefined)).toBe<FailureKind>('structural');
    expect(defaultClassifyFailure(null)).toBe<FailureKind>('structural');
  });
});

/**
 * Contract test runner. Consumers of `AgentLoopAdapter` use this to
 * verify their reference adapter satisfies the interface.
 */
export function runAgentLoopContract(name: string, build: () => AgentLoopAdapter) {
  describe(`AgentLoopAdapter contract: ${name}`, () => {
    it('exposes capabilities', () => {
      const a = build();
      expect(a.capabilities).toBeDefined();
      expect(typeof a.capabilities.tracks_cost).toBe('boolean');
      expect(typeof a.capabilities.supports_signal).toBe('boolean');
      expect(typeof a.capabilities.classify_failure).toBe('function');
    });

    // Behavioral tests run in the reference-adapter test files (Task 12).
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/substrate/agent-loop-contract.test.ts 2>&1 | tail -10
```

Expected: module-not-found.

- [ ] **Step 3: Implement `src/substrate/agent-loop.ts`**

```ts
/**
 * AgentLoopAdapter: the substrate seam for any actor that wants
 * multi-turn agentic reasoning.
 *
 * Why this exists
 * ---------------
 * The single-shot `LLM.judge()` primitive is sufficient for one-prompt
 * decisions (classify, dedup, propose-diff). For tasks that need
 * iterative reasoning + tool use (read a file, edit it, run tests,
 * fix errors, commit), an actor needs a multi-turn loop. This seam is
 * that loop; concrete implementations (Claude Code, LangGraph, custom
 * node loops) are pluggable per spec Section 2.1.
 *
 * Threat model
 * ------------
 * - The agent process inherits whatever credentials are in
 *   `input.workspace`'s `.lag/apps/`. Caller (typically a
 *   `CodeAuthorExecutor` or a future actor's executor) is responsible
 *   for cred provisioning with the minimum scope.
 * - Adapters MUST apply `input.redactor` to ALL content before atom
 *   write. A redactor crash MUST surface as `catastrophic`; never
 *   fall through to write unredacted content.
 * - Tool calls denied by `input.toolPolicy` MUST emit
 *   `tool_calls[].outcome: 'policy-refused'` and the agent MUST
 *   receive a structured refusal it can reason about. Silent denial
 *   is a substrate violation.
 * - `input.budget` is the runaway guard. Adapters MUST honor
 *   `max_turns` + `max_wall_clock_ms`; `max_usd` is honored only when
 *   `capabilities.tracks_cost === true`.
 *
 * Contract
 * --------
 * The adapter MUST:
 *   1. Write an `agent-session` atom on entry (state: 'started').
 *   2. Write an `agent-turn` atom for each LLM call BEFORE issuing
 *      the call (so the audit trail captures even mid-turn crashes).
 *   3. Apply `input.redactor` to all content before atom write.
 *   4. Honor `input.budget` (turns + wall_clock_ms; usd if capable).
 *   5. Honor `input.signal` if `capabilities.supports_signal === true`.
 *   6. Update the session atom on exit (terminal_state, failure,
 *      budget_consumed).
 *
 * The adapter MAY:
 *   - Persist large turn payloads via `input.blobStore` according to
 *     `input.blobThreshold`.
 *   - Compute and persist `canon_snapshot_blob_ref` when
 *     `input.replayTier === 'strict'`.
 *   - Override `defaultClassifyFailure` via
 *     `capabilities.classify_failure` to cover adapter-specific error
 *     shapes.
 */

import type {
  AtomId,
  FailureKind,
  FailureRecord,
  PrincipalId,
  ReplayTier,
} from './types.js';
import type { Host } from './interface.js';
import type { Workspace } from './workspace-provider.js';
import type { BlobStore } from './blob-store.js';
import type { Redactor } from './redactor.js';
import type { BudgetCap } from './agent-budget.js';

export interface AgentLoopAdapter {
  readonly capabilities: AdapterCapabilities;
  run(input: AgentLoopInput): Promise<AgentLoopResult>;
}

export interface AdapterCapabilities {
  /** Adapter can report per-call USD cost; executor honors `max_usd` only if true. */
  readonly tracks_cost: boolean;
  /** Adapter honors `AgentLoopInput.signal` for cooperative cancellation. */
  readonly supports_signal: boolean;
  /**
   * Adapter-specific failure classifier. Falls back to
   * `defaultClassifyFailure` if the adapter doesn't override.
   */
  readonly classify_failure: (err: unknown) => FailureKind;
}

export interface ToolPolicy {
  readonly disallowedTools: ReadonlyArray<string>;
  readonly rationale?: string;
}

export interface AgentTask {
  readonly planAtomId: AtomId;
  readonly questionPrompt?: string;
  readonly fileContents?: ReadonlyArray<{ path: string; content: string }>;
  readonly successCriteria?: string;
  readonly targetPaths?: ReadonlyArray<string>;
}

export interface AgentLoopInput {
  readonly host: Host;
  readonly principal: PrincipalId;
  readonly workspace: Workspace;
  readonly task: AgentTask;
  readonly budget: BudgetCap;
  readonly toolPolicy: ToolPolicy;
  readonly redactor: Redactor;
  readonly blobStore: BlobStore;
  readonly replayTier: ReplayTier;
  /** Already clamped via `clampBlobThreshold`. */
  readonly blobThreshold: number;
  readonly correlationId: string;
  readonly signal?: AbortSignal;
}

export interface AgentLoopResult {
  readonly kind: 'completed' | 'budget-exhausted' | 'error';
  readonly sessionAtomId: AtomId;
  readonly turnAtomIds: ReadonlyArray<AtomId>;
  readonly failure?: FailureRecord;
  readonly artifacts?: {
    readonly commitSha?: string;
    readonly branchName?: string;
    readonly touchedPaths?: ReadonlyArray<string>;
  };
}

/**
 * Default failure classifier. Adapters override via
 * `capabilities.classify_failure` for adapter-specific error shapes.
 *
 * Heuristics:
 *   - HTTP 429/503 + ECONN* + EBUSY/EAGAIN  -> transient
 *   - AbortError                            -> catastrophic (signal aborted)
 *   - everything else                       -> structural
 *
 * The intentional bias: lean toward `structural` for unknown errors.
 * Retrying an unknown failure burns budget; escalating asks the
 * operator. Operator escalation is recoverable; runaway retry is not.
 */
export function defaultClassifyFailure(err: unknown): FailureKind {
  if (err instanceof Error && err.name === 'AbortError') {
    return 'catastrophic';
  }
  const e = err as { statusCode?: number; status?: number; code?: string } | null | undefined;
  if (e !== null && typeof e === 'object') {
    const status = typeof e.statusCode === 'number' ? e.statusCode : (typeof e.status === 'number' ? e.status : undefined);
    if (status === 429 || status === 503 || status === 502 || status === 504) {
      return 'transient';
    }
    if (typeof e.code === 'string' && (
      e.code.startsWith('ECONN') ||
      e.code === 'EBUSY' ||
      e.code === 'EAGAIN' ||
      e.code === 'ETIMEDOUT' ||
      e.code === 'ENOTFOUND'
    )) {
      return 'transient';
    }
  }
  return 'structural';
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run test/substrate/agent-loop-contract.test.ts 2>&1 | tail -10
```

Expected: 7 classifier tests pass.

- [ ] **Step 5: Commit**

```bash
node scripts/git-as.mjs lag-ceo add src/substrate/agent-loop.ts test/substrate/agent-loop-contract.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(substrate): AgentLoopAdapter interface + default failure classifier"
```

---

### Task 7: `pol-replay-tier` policy parser + resolver

**Files:**
- Create: `src/substrate/policy/replay-tier.ts`
- Test: `test/substrate/policy/replay-tier.test.ts`

**Security + correctness considerations:**
- Mirror the fail-closed discipline of `loadLlmToolPolicy` (memory-substrate pattern): missing atom → `null` → caller uses default; tainted/superseded → `null`; malformed → throw. Never silently widen replay tier (e.g., infer `strict` from a malformed atom).
- Resolution order: `target_principal` (most specific) → `target_actor_type` → framework default. The default constant lives in this file; do NOT re-derive it elsewhere.
- The default tier is `content-addressed` per spec - make sure the constant matches exactly.
- A policy atom for the wrong principal (mismatched id) MUST NOT apply. The resolver MUST verify the atom's metadata matches the requested principal id.

- [ ] **Step 1: Write failing test**

`test/substrate/policy/replay-tier.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import {
  REPLAY_TIER_DEFAULT,
  loadReplayTier,
  replayTierAtomId,
} from '../../../src/substrate/policy/replay-tier.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../src/substrate/types.js';

const NOW = '2026-04-25T00:00:00.000Z' as Time;

function mkPolAtom(overrides: Partial<Atom> & { metadata: Record<string, unknown> }): Atom {
  return {
    schema_version: 1,
    id: overrides.id ?? ('pol-replay-tier-test' as AtomId),
    content: 'replay tier policy',
    type: 'preference',
    layer: 'L3',
    provenance: { kind: 'operator-seeded', source: { agent_id: 'operator' }, derived_from: [] },
    confidence: 1,
    created_at: NOW,
    last_reinforced_at: NOW,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: { agrees_with: [], conflicts_with: [], validation_status: 'verified', last_validated_at: null },
    principal_id: 'operator' as PrincipalId,
    taint: 'clean',
    metadata: overrides.metadata,
    ...overrides,
  } as Atom;
}

describe('loadReplayTier', () => {
  it('returns the default when no atom exists', async () => {
    const host = createMemoryHost();
    const t = await loadReplayTier(host.atomStore, 'cto-actor' as PrincipalId, 'planning');
    expect(t).toBe(REPLAY_TIER_DEFAULT);
  });

  it('default is content-addressed', () => {
    expect(REPLAY_TIER_DEFAULT).toBe('content-addressed');
  });

  it('per-principal beats per-actor-type', async () => {
    const host = createMemoryHost();
    await host.atomStore.put(mkPolAtom({
      id: replayTierAtomId({ target_actor_type: 'planning' }),
      metadata: { kind: 'pol-replay-tier', target_actor_type: 'planning', tier: 'best-effort' },
    }));
    await host.atomStore.put(mkPolAtom({
      id: replayTierAtomId({ target_principal: 'cto-actor' as PrincipalId }),
      metadata: { kind: 'pol-replay-tier', target_principal: 'cto-actor', tier: 'strict' },
    }));
    expect(await loadReplayTier(host.atomStore, 'cto-actor' as PrincipalId, 'planning')).toBe('strict');
  });

  it('per-actor-type matched when no per-principal', async () => {
    const host = createMemoryHost();
    await host.atomStore.put(mkPolAtom({
      id: replayTierAtomId({ target_actor_type: 'planning' }),
      metadata: { kind: 'pol-replay-tier', target_actor_type: 'planning', tier: 'strict' },
    }));
    expect(await loadReplayTier(host.atomStore, 'cto-actor' as PrincipalId, 'planning')).toBe('strict');
  });

  it('tainted atom returns default (fail-closed)', async () => {
    const host = createMemoryHost();
    await host.atomStore.put(mkPolAtom({
      id: replayTierAtomId({ target_principal: 'cto-actor' as PrincipalId }),
      taint: 'tainted',
      metadata: { kind: 'pol-replay-tier', target_principal: 'cto-actor', tier: 'best-effort' },
    }));
    expect(await loadReplayTier(host.atomStore, 'cto-actor' as PrincipalId, 'planning')).toBe(REPLAY_TIER_DEFAULT);
  });

  it('throws on malformed payload (unknown tier value)', async () => {
    const host = createMemoryHost();
    await host.atomStore.put(mkPolAtom({
      id: replayTierAtomId({ target_principal: 'cto-actor' as PrincipalId }),
      metadata: { kind: 'pol-replay-tier', target_principal: 'cto-actor', tier: 'turbo' },
    }));
    await expect(loadReplayTier(host.atomStore, 'cto-actor' as PrincipalId, 'planning')).rejects.toThrow(/tier/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/substrate/policy/replay-tier.test.ts 2>&1 | tail -10
```

Expected: module-not-found.

- [ ] **Step 3: Implement `src/substrate/policy/replay-tier.ts`**

```ts
/**
 * pol-replay-tier policy.
 *
 * Per-principal or per-actor-type replay tier for the agent loop.
 * Resolution order: target_principal -> target_actor_type -> default.
 *
 * Fail-closed discipline (mirrors loadLlmToolPolicy):
 *   - Missing atom    -> null -> caller uses REPLAY_TIER_DEFAULT.
 *   - Tainted atom    -> null -> default.
 *   - Superseded atom -> null -> default.
 *   - Malformed       -> throw, so canon edits that produce
 *                        unparsable atoms fail loud.
 */

import type { AtomStore } from '../interface.js';
import type {
  Atom,
  AtomId,
  PrincipalId,
  ReplayTier,
} from '../types.js';

export const REPLAY_TIER_DEFAULT: ReplayTier = 'content-addressed';

const VALID_TIERS: ReadonlySet<ReplayTier> = new Set(['best-effort', 'content-addressed', 'strict']);

export class ReplayTierPolicyError extends Error {
  constructor(message: string, public readonly atomId?: AtomId) {
    super(`pol-replay-tier: ${message}`);
    this.name = 'ReplayTierPolicyError';
  }
}

export interface ReplayTierTarget {
  readonly target_principal?: PrincipalId;
  readonly target_actor_type?: string;
}

/** Compute the canonical atom id for a replay-tier policy atom. */
export function replayTierAtomId(target: ReplayTierTarget): AtomId {
  if (target.target_principal !== undefined) {
    return `pol-replay-tier-principal-${String(target.target_principal)}` as AtomId;
  }
  if (target.target_actor_type !== undefined) {
    return `pol-replay-tier-actor-${target.target_actor_type}` as AtomId;
  }
  throw new ReplayTierPolicyError('replayTierAtomId requires target_principal or target_actor_type');
}

/**
 * Resolve the effective replay tier for a (principal, actor_type) pair.
 * Returns REPLAY_TIER_DEFAULT when no policy applies.
 */
export async function loadReplayTier(
  atoms: AtomStore,
  principal: PrincipalId,
  actorType: string,
): Promise<ReplayTier> {
  const principalRef = await atoms.get(replayTierAtomId({ target_principal: principal }));
  if (principalRef !== null) {
    const tier = parseReplayTierAtom(principalRef);
    if (tier !== null) return tier;
  }
  const actorRef = await atoms.get(replayTierAtomId({ target_actor_type: actorType }));
  if (actorRef !== null) {
    const tier = parseReplayTierAtom(actorRef);
    if (tier !== null) return tier;
  }
  return REPLAY_TIER_DEFAULT;
}

function parseReplayTierAtom(atom: Atom): ReplayTier | null {
  if (atom.taint !== 'clean') return null;
  if (atom.superseded_by.length > 0) return null;
  const md = atom.metadata as Record<string, unknown>;
  if (md['kind'] !== 'pol-replay-tier') {
    throw new ReplayTierPolicyError(`atom metadata.kind != 'pol-replay-tier'`, atom.id);
  }
  const tier = md['tier'];
  if (typeof tier !== 'string' || !VALID_TIERS.has(tier as ReplayTier)) {
    throw new ReplayTierPolicyError(`invalid tier value: ${String(tier)}`, atom.id);
  }
  return tier as ReplayTier;
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run test/substrate/policy/replay-tier.test.ts 2>&1 | tail -10
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
node scripts/git-as.mjs lag-ceo add src/substrate/policy/replay-tier.ts test/substrate/policy/replay-tier.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(substrate): pol-replay-tier policy parser + resolver"
```

---

### Task 8: `pol-blob-threshold` policy parser + resolver

**Files:**
- Create: `src/substrate/policy/blob-threshold.ts`
- Test: `test/substrate/policy/blob-threshold.test.ts`

**Security + correctness considerations:**
- Same fail-closed discipline as Task 7.
- Validator MUST clamp at write-time too: a tainted/clean atom whose threshold is out of bounds gets the clamped value, not the raw value, so consumers always receive a sane number. Document the clamp behavior.
- Resolution order identical to replay-tier.
- A policy atom whose `threshold_bytes` is not a number rejects with an error (do NOT silently coerce).

- [ ] **Step 1: Write failing test**

`test/substrate/policy/blob-threshold.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import {
  BLOB_THRESHOLD_DEFAULT,
  BLOB_THRESHOLD_MIN,
  BLOB_THRESHOLD_MAX,
} from '../../../src/substrate/agent-budget.js';
import {
  loadBlobThreshold,
  blobThresholdAtomId,
} from '../../../src/substrate/policy/blob-threshold.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../src/substrate/types.js';

const NOW = '2026-04-25T00:00:00.000Z' as Time;

function mkPolAtom(id: AtomId, threshold: unknown, taint: 'clean' | 'tainted' = 'clean'): Atom {
  return {
    schema_version: 1, id, content: 'pol', type: 'preference', layer: 'L3',
    provenance: { kind: 'operator-seeded', source: { agent_id: 'operator' }, derived_from: [] },
    confidence: 1, created_at: NOW, last_reinforced_at: NOW, expires_at: null,
    supersedes: [], superseded_by: [], scope: 'project',
    signals: { agrees_with: [], conflicts_with: [], validation_status: 'verified', last_validated_at: null },
    principal_id: 'operator' as PrincipalId, taint,
    metadata: { kind: 'pol-blob-threshold', target_principal: 'cto-actor', threshold_bytes: threshold },
  } as Atom;
}

describe('loadBlobThreshold', () => {
  it('returns BLOB_THRESHOLD_DEFAULT when no atom exists', async () => {
    const host = createMemoryHost();
    expect(await loadBlobThreshold(host.atomStore, 'cto-actor' as PrincipalId, 'code-author')).toBe(BLOB_THRESHOLD_DEFAULT);
  });

  it('clamps threshold below minimum', async () => {
    const host = createMemoryHost();
    await host.atomStore.put(mkPolAtom(blobThresholdAtomId({ target_principal: 'cto-actor' as PrincipalId }), 0));
    expect(await loadBlobThreshold(host.atomStore, 'cto-actor' as PrincipalId, 'code-author')).toBe(BLOB_THRESHOLD_MIN);
  });

  it('clamps threshold above maximum', async () => {
    const host = createMemoryHost();
    await host.atomStore.put(mkPolAtom(blobThresholdAtomId({ target_principal: 'cto-actor' as PrincipalId }), 100_000_000));
    expect(await loadBlobThreshold(host.atomStore, 'cto-actor' as PrincipalId, 'code-author')).toBe(BLOB_THRESHOLD_MAX);
  });

  it('returns valid threshold inside bounds', async () => {
    const host = createMemoryHost();
    await host.atomStore.put(mkPolAtom(blobThresholdAtomId({ target_principal: 'cto-actor' as PrincipalId }), 8192));
    expect(await loadBlobThreshold(host.atomStore, 'cto-actor' as PrincipalId, 'code-author')).toBe(8192);
  });

  it('tainted atom falls back to default', async () => {
    const host = createMemoryHost();
    await host.atomStore.put(mkPolAtom(blobThresholdAtomId({ target_principal: 'cto-actor' as PrincipalId }), 8192, 'tainted'));
    expect(await loadBlobThreshold(host.atomStore, 'cto-actor' as PrincipalId, 'code-author')).toBe(BLOB_THRESHOLD_DEFAULT);
  });

  it('throws on non-number threshold (silent coercion is a security risk)', async () => {
    const host = createMemoryHost();
    await host.atomStore.put(mkPolAtom(blobThresholdAtomId({ target_principal: 'cto-actor' as PrincipalId }), 'big'));
    await expect(loadBlobThreshold(host.atomStore, 'cto-actor' as PrincipalId, 'code-author')).rejects.toThrow(/threshold/);
  });
});
```

- [ ] **Step 2: Run failing test**

```bash
npx vitest run test/substrate/policy/blob-threshold.test.ts 2>&1 | tail -10
```

Expected: module-not-found.

- [ ] **Step 3: Implement `src/substrate/policy/blob-threshold.ts`**

```ts
/**
 * pol-blob-threshold policy.
 *
 * Per-principal or per-actor-type blob threshold (bytes). Clamped on
 * read to [BLOB_THRESHOLD_MIN, BLOB_THRESHOLD_MAX]. Falls back to
 * BLOB_THRESHOLD_DEFAULT (4 KB) when no policy applies, when the atom
 * is tainted/superseded, or when the policy itself is missing.
 *
 * Fail-closed: same posture as pol-replay-tier.
 */

import type { AtomStore } from '../interface.js';
import type { Atom, AtomId, PrincipalId } from '../types.js';
import {
  BLOB_THRESHOLD_DEFAULT,
  clampBlobThreshold,
} from '../agent-budget.js';

export class BlobThresholdPolicyError extends Error {
  constructor(message: string, public readonly atomId?: AtomId) {
    super(`pol-blob-threshold: ${message}`);
    this.name = 'BlobThresholdPolicyError';
  }
}

export interface BlobThresholdTarget {
  readonly target_principal?: PrincipalId;
  readonly target_actor_type?: string;
}

export function blobThresholdAtomId(target: BlobThresholdTarget): AtomId {
  if (target.target_principal !== undefined) {
    return `pol-blob-threshold-principal-${String(target.target_principal)}` as AtomId;
  }
  if (target.target_actor_type !== undefined) {
    return `pol-blob-threshold-actor-${target.target_actor_type}` as AtomId;
  }
  throw new BlobThresholdPolicyError('blobThresholdAtomId requires target_principal or target_actor_type');
}

export async function loadBlobThreshold(
  atoms: AtomStore,
  principal: PrincipalId,
  actorType: string,
): Promise<number> {
  const principalRef = await atoms.get(blobThresholdAtomId({ target_principal: principal }));
  if (principalRef !== null) {
    const v = parseBlobThresholdAtom(principalRef);
    if (v !== null) return clampBlobThreshold(v);
  }
  const actorRef = await atoms.get(blobThresholdAtomId({ target_actor_type: actorType }));
  if (actorRef !== null) {
    const v = parseBlobThresholdAtom(actorRef);
    if (v !== null) return clampBlobThreshold(v);
  }
  return BLOB_THRESHOLD_DEFAULT;
}

function parseBlobThresholdAtom(atom: Atom): number | null {
  if (atom.taint !== 'clean') return null;
  if (atom.superseded_by.length > 0) return null;
  const md = atom.metadata as Record<string, unknown>;
  if (md['kind'] !== 'pol-blob-threshold') {
    throw new BlobThresholdPolicyError(`atom metadata.kind != 'pol-blob-threshold'`, atom.id);
  }
  const t = md['threshold_bytes'];
  if (typeof t !== 'number' || Number.isNaN(t)) {
    throw new BlobThresholdPolicyError(`threshold_bytes must be a number, got ${typeof t}`, atom.id);
  }
  return t;
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run test/substrate/policy/blob-threshold.test.ts 2>&1 | tail -10
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
node scripts/git-as.mjs lag-ceo add src/substrate/policy/blob-threshold.ts test/substrate/policy/blob-threshold.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(substrate): pol-blob-threshold policy parser + resolver"
```

---

### Task 9: `session-tree` projection helper

**Files:**
- Create: `src/substrate/projections/session-tree.ts`
- Test: `test/substrate/projections/session-tree.test.ts`

**Note on path:** spec Section 8.1 listed this at `src/projections/session-tree.ts`. The plan nests it under `src/substrate/projections/` to keep the projection co-located with the substrate it projects over (matches the existing convention where `src/substrate/canon-md/` projects over canon atoms). Call this out in the PR description so reviewers don't flag it as scope drift.

**Security + correctness considerations:**
- This is a READ-ONLY projection. It MUST NOT write atoms. The test asserts `atoms.put` is never called. Stale projection state is acceptable; read-only side effects are not.
- Cycle defense: malformed atom chains could form cycles via `derived_from`. The walker MUST detect cycles and bail with a structured error rather than infinite-loop.
- The projection's output ordering MUST be deterministic given a fixed atom set. Otherwise consumers (debug UI, replay) display flicker.
- An atom referenced in `derived_from` that doesn't exist in the store is treated as a missing-link (broken chain); record the broken link in the output, do NOT throw.

- [ ] **Step 1: Write failing test**

`test/substrate/projections/session-tree.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import { buildSessionTree } from '../../../src/substrate/projections/session-tree.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../src/substrate/types.js';

const NOW = '2026-04-25T00:00:00.000Z' as Time;

function mkAtom(id: string, type: Atom['type'], derived: string[], metadata: Record<string, unknown>): Atom {
  return {
    schema_version: 1, id: id as AtomId, content: id, type, layer: 'L1',
    provenance: { kind: 'agent-observed', source: { agent_id: 'cto-actor' }, derived_from: derived as AtomId[] },
    confidence: 1, created_at: NOW, last_reinforced_at: NOW, expires_at: null,
    supersedes: [], superseded_by: [], scope: 'project',
    signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
    principal_id: 'cto-actor' as PrincipalId, taint: 'clean',
    metadata,
  };
}

describe('buildSessionTree', () => {
  it('reconstructs a single-session chain', async () => {
    const host = createMemoryHost();
    await host.atomStore.put(mkAtom('session-1', 'agent-session', [], { agent_session: { model_id: 'x', adapter_id: 'y', workspace_id: 'w', started_at: NOW, terminal_state: 'completed', replay_tier: 'content-addressed', budget_consumed: { turns: 2, wall_clock_ms: 1000 } } }));
    await host.atomStore.put(mkAtom('turn-1', 'agent-turn', ['session-1'], { agent_turn: { session_atom_id: 'session-1', turn_index: 0, llm_input: { inline: 'i' }, llm_output: { inline: 'o' }, tool_calls: [], latency_ms: 100 } }));
    await host.atomStore.put(mkAtom('turn-2', 'agent-turn', ['session-1'], { agent_turn: { session_atom_id: 'session-1', turn_index: 1, llm_input: { inline: 'i' }, llm_output: { inline: 'o' }, tool_calls: [], latency_ms: 200 } }));
    const tree = await buildSessionTree(host.atomStore, 'session-1' as AtomId);
    expect(tree.session.id).toBe('session-1');
    expect(tree.turns.length).toBe(2);
    expect(tree.turns[0]?.id).toBe('turn-1');
    expect(tree.turns[1]?.id).toBe('turn-2');
    expect(tree.children.length).toBe(0);
  });

  it('returns broken-link records for missing parents', async () => {
    const host = createMemoryHost();
    // turn references a non-existent session
    await host.atomStore.put(mkAtom('turn-orphan', 'agent-turn', ['session-missing'], { agent_turn: { session_atom_id: 'session-missing', turn_index: 0, llm_input: { inline: 'i' }, llm_output: { inline: 'o' }, tool_calls: [], latency_ms: 50 } }));
    await expect(buildSessionTree(host.atomStore, 'session-missing' as AtomId)).rejects.toThrow(/not found/);
  });

  it('orders turns by turn_index, not by created_at', async () => {
    const host = createMemoryHost();
    await host.atomStore.put(mkAtom('s2', 'agent-session', [], { agent_session: { model_id: 'x', adapter_id: 'y', workspace_id: 'w', started_at: NOW, terminal_state: 'completed', replay_tier: 'content-addressed', budget_consumed: { turns: 2, wall_clock_ms: 1 } } }));
    // Insert in reverse order
    await host.atomStore.put(mkAtom('t-second', 'agent-turn', ['s2'], { agent_turn: { session_atom_id: 's2', turn_index: 1, llm_input: { inline: 'i' }, llm_output: { inline: 'o' }, tool_calls: [], latency_ms: 1 } }));
    await host.atomStore.put(mkAtom('t-first', 'agent-turn', ['s2'], { agent_turn: { session_atom_id: 's2', turn_index: 0, llm_input: { inline: 'i' }, llm_output: { inline: 'o' }, tool_calls: [], latency_ms: 1 } }));
    const tree = await buildSessionTree(host.atomStore, 's2' as AtomId);
    expect(tree.turns.map(t => t.id)).toEqual(['t-first', 't-second']);
  });
});
```

- [ ] **Step 2: Run failing test**

```bash
npx vitest run test/substrate/projections/session-tree.test.ts 2>&1 | tail -10
```

Expected: module-not-found.

- [ ] **Step 3: Implement `src/substrate/projections/session-tree.ts`**

```ts
/**
 * session-tree projection: reconstruct a session + its turns + child
 * sessions from the AtomStore.
 *
 * Read-only. Walks the chain by:
 *   1. Loading the root session atom.
 *   2. Querying for agent-turn atoms whose metadata.agent_turn.session_atom_id
 *      matches the session.
 *   3. Recursively walking dispatch atoms whose derived_from points at
 *      the session (out of scope for PR1: dispatch-traversal lands when
 *      child sessions actually emit; the recursion is the seam).
 *
 * Cycle defense: a `seen` set guards against malformed chains.
 *
 * Future: dispatch atoms that link sessions across actors. PR1 ships
 * single-session reconstruction; cross-actor walks are additive in PR2+.
 */

import type { AtomStore } from '../interface.js';
import type { Atom, AtomId } from '../types.js';

export interface SessionTreeNode {
  readonly session: Atom;
  readonly turns: ReadonlyArray<Atom>;
  readonly children: ReadonlyArray<SessionTreeNode>;
  readonly brokenLinks: ReadonlyArray<{ from: AtomId; missing: AtomId }>;
}

export class SessionTreeError extends Error {
  constructor(message: string) {
    super(`session-tree: ${message}`);
    this.name = 'SessionTreeError';
  }
}

export async function buildSessionTree(
  atoms: AtomStore,
  rootSessionId: AtomId,
): Promise<SessionTreeNode> {
  return walk(atoms, rootSessionId, new Set<AtomId>());
}

async function walk(atoms: AtomStore, sessionId: AtomId, seen: Set<AtomId>): Promise<SessionTreeNode> {
  if (seen.has(sessionId)) {
    throw new SessionTreeError(`cycle detected at ${sessionId}`);
  }
  seen.add(sessionId);
  const session = await atoms.get(sessionId);
  if (session === null) {
    throw new SessionTreeError(`session atom not found: ${sessionId}`);
  }
  if (session.type !== 'agent-session') {
    throw new SessionTreeError(`atom ${sessionId} is not type='agent-session' (got ${session.type})`);
  }
  // AtomFilter (src/substrate/types.ts) does NOT support filtering by
  // `derived_from`; only `type` (as array), `layer`, `scope`,
  // `principal_id`, `taint`, etc. So: query all agent-turn atoms,
  // then filter in-memory by `metadata.agent_turn.session_atom_id`.
  // The 1000 page size is conservative for indie scale; orgs at
  // 50+ actors should add a typed `derived_from?: AtomId` to
  // AtomFilter as a separate substrate plan, then this projection
  // can switch to the indexed path. (Tracked here as a known
  // perf seam, not a correctness gap.)
  const page = await atoms.query({ type: ['agent-turn'] }, 1000);
  const turnAtoms: Atom[] = page.atoms.filter((a) => {
    const md = a.metadata as Record<string, unknown>;
    const turn = md['agent_turn'] as Record<string, unknown> | undefined;
    return turn !== undefined && turn['session_atom_id'] === sessionId;
  });
  // Order by turn_index.
  turnAtoms.sort((a, b) => {
    const ai = (((a.metadata as Record<string, unknown>)['agent_turn']) as Record<string, unknown>)['turn_index'] as number;
    const bi = (((b.metadata as Record<string, unknown>)['agent_turn']) as Record<string, unknown>)['turn_index'] as number;
    return ai - bi;
  });
  // Children: cross-actor dispatch sessions. PR1 ships an empty list;
  // the seam is here so PR2+ additions don't change the public shape.
  const children: SessionTreeNode[] = [];
  const brokenLinks: { from: AtomId; missing: AtomId }[] = [];
  return { session, turns: turnAtoms, children, brokenLinks };
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run test/substrate/projections/session-tree.test.ts 2>&1 | tail -10
```

Expected: 3 tests pass. The implementation in Step 3 is committed to the `query({ type: ['agent-turn'] })` + in-memory filter path (no runtime decision deferred). If a future PR adds typed `derived_from` filtering to `AtomFilter`, the projection switches to the indexed path as a separate follow-up.

- [ ] **Step 5: Confirm `AtomFilter` shape (sanity check, not gate)**

```bash
grep -nP "interface AtomFilter" src/substrate/types.ts
sed -n '287,305p' src/substrate/types.ts
```

Expected: `type: ReadonlyArray<AtomType>`; no `derived_from` field. The implementation in Step 3 already commits to the in-memory filter path; this step is a final sanity check that `AtomFilter` hasn't gained a `derived_from` field that we should switch to.

- [ ] **Step 6: Commit**

```bash
node scripts/git-as.mjs lag-ceo add src/substrate/projections/session-tree.ts test/substrate/projections/session-tree.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(substrate): session-tree projection helper"
```

---

### Task 10: `examples/redactors/regex-default/` reference adapter

**Files:**
- Create: `examples/redactors/regex-default/redactor.ts`
- Create: `examples/redactors/regex-default/patterns.ts`
- Create: `examples/redactors/regex-default/index.ts`
- Create: `examples/redactors/regex-default/README.md`
- Test: `test/examples/regex-redactor.test.ts`

**Security + correctness considerations:**
- Pattern coverage MUST include common third-party formats: AWS access keys (`AKIA[0-9A-Z]{16}`), GitHub PATs (`ghp_/ghs_/gho_/ghu_/ghr_` followed by 36 chars), GitHub App installation tokens (`ghs_` prefix), JWT-shaped strings (`eyJ` followed by base64). Plus generic high-entropy hex/base64 over a length threshold.
- Patterns MUST be anchored to non-word boundaries (`\b`) so partial matches in larger strings still hit. Pattern test against "see token AKIA... in logs".
- Replacement string MUST be `[REDACTED:<pattern_name>]` so audits can identify which pattern matched. Do NOT replace with empty string (loses provenance of redaction).
- Idempotence: redacting `[REDACTED:foo]` MUST produce `[REDACTED:foo]` (the redaction marker itself is not a secret pattern).
- Pattern set is exported as a constant - operators can wrap and add more without forking the module.

- [ ] **Step 1: Write failing test**

`test/examples/regex-redactor.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { RegexRedactor } from '../../examples/redactors/regex-default/index.js';
import { runRedactorContract } from '../substrate/redactor-contract.test.js';
import type { PrincipalId } from '../../src/substrate/types.js';

const CTX = { kind: 'tool-result' as const, principal: 'p' as PrincipalId };

describe('RegexRedactor: default patterns', () => {
  it('redacts AWS access keys', () => {
    const r = new RegexRedactor();
    const out = r.redact('see key AKIAIOSFODNN7EXAMPLE in logs', CTX);
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).toContain('[REDACTED:aws-access-key]');
  });

  it('redacts GitHub PATs', () => {
    const r = new RegexRedactor();
    const out = r.redact('token ghp_abcdefghijklmnopqrstuvwxyzABCDEF1234 here', CTX);
    expect(out).not.toContain('ghp_abcdefghijklmnopqrstuvwxyzABCDEF1234');
    expect(out).toContain('[REDACTED:github-pat]');
  });

  it('redacts GitHub installation tokens', () => {
    const r = new RegexRedactor();
    const out = r.redact('ghs_TestTokenAbcdefghijklmnopqrstuvwxyzAB seen', CTX);
    expect(out).not.toContain('ghs_TestTokenAbcdefghijklmnopqrstuvwxyzAB');
    expect(out).toContain('[REDACTED:github-installation-token]');
  });

  it('does not flag prose that happens to contain ghp', () => {
    const r = new RegexRedactor();
    const out = r.redact('I think ghp is short for github-personal', CTX);
    expect(out).toBe('I think ghp is short for github-personal');
  });

  it('is idempotent over already-redacted text', () => {
    const r = new RegexRedactor();
    const once = r.redact('AKIAIOSFODNN7EXAMPLE', CTX);
    const twice = r.redact(once, CTX);
    expect(twice).toBe(once);
  });
});

// Run the contract test against the reference adapter.
runRedactorContract('RegexRedactor', () => new RegexRedactor());
```

- [ ] **Step 2: Run failing test**

```bash
npx vitest run test/examples/regex-redactor.test.ts 2>&1 | tail -10
```

Expected: module-not-found.

- [ ] **Step 3: Implement `examples/redactors/regex-default/patterns.ts`**

```ts
/**
 * Default regex pattern set for the reference RegexRedactor.
 *
 * Each entry: { name, pattern, replacement }. Patterns are NOT
 * exhaustive; orgs swap in their own. Document the rationale per
 * pattern so a reader sees why each is in the set.
 */

export interface RedactionPattern {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: string;
}

export const DEFAULT_PATTERNS: ReadonlyArray<RedactionPattern> = [
  // AWS access key id format: AKIA followed by 16 uppercase alphanumeric.
  { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[REDACTED:aws-access-key]' },
  // AWS secret access key (40-char base64-ish, very loose). Generic
  // high-entropy catches these in practice; explicit is safer.
  { name: 'aws-secret-key', pattern: /\b[A-Za-z0-9/+=]{40}\b/g, replacement: '[REDACTED:aws-secret-key]' },
  // GitHub Personal Access Tokens: ghp_/ghu_/ghr_ + 36 chars.
  { name: 'github-pat', pattern: /\bgh[pur]_[A-Za-z0-9]{36}\b/g, replacement: '[REDACTED:github-pat]' },
  // GitHub App installation tokens: ghs_ + 36+ chars.
  { name: 'github-installation-token', pattern: /\bghs_[A-Za-z0-9]{36,}\b/g, replacement: '[REDACTED:github-installation-token]' },
  // GitHub OAuth tokens: gho_ + 36 chars.
  { name: 'github-oauth', pattern: /\bgho_[A-Za-z0-9]{36}\b/g, replacement: '[REDACTED:github-oauth]' },
  // JWT-shaped: three base64url segments separated by '.'.
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replacement: '[REDACTED:jwt]' },
];
```

- [ ] **Step 4: Implement `examples/redactors/regex-default/redactor.ts`**

```ts
/**
 * Reference Redactor implementation.
 *
 * Indie copy/paste path: `cp -r examples/redactors/regex-default <yourapp>/redactors/`.
 * Org swap: implement your own `Redactor` (subclass or fresh) covering
 * org-specific secret patterns + use this for third-party formats.
 *
 * Threat model
 * ------------
 * Pattern coverage is the operator's responsibility for org-specific
 * secrets. This adapter covers only the common third-party formats
 * listed in `patterns.ts`. Encourage operators to extend.
 */

import type { Redactor, RedactContext } from '../../../src/substrate/redactor.js';
import { DEFAULT_PATTERNS, type RedactionPattern } from './patterns.js';

export class RegexRedactor implements Redactor {
  constructor(
    private readonly patterns: ReadonlyArray<RedactionPattern> = DEFAULT_PATTERNS,
  ) {}

  redact(content: string, _context: RedactContext): string {
    if (typeof content !== 'string') {
      // Defensive: caller violated contract. Throw rather than coerce
      // to avoid silently masking a bug.
      throw new Error(`RegexRedactor: expected string, got ${typeof content}`);
    }
    if (content.length === 0) return '';
    let out = content;
    for (const p of this.patterns) {
      out = out.replace(p.pattern, p.replacement);
    }
    return out;
  }
}
```

- [ ] **Step 5: Implement `examples/redactors/regex-default/index.ts`**

```ts
export { RegexRedactor } from './redactor.js';
export { DEFAULT_PATTERNS, type RedactionPattern } from './patterns.js';
```

- [ ] **Step 6: Implement `examples/redactors/regex-default/README.md`**

```markdown
# RegexRedactor (reference adapter)

A regex-pattern Redactor for the agentic actor loop. Covers common
third-party secret formats (AWS, GitHub PAT/App, JWT). Org-specific
patterns are the operator's responsibility - extend or replace.

## Indie path

Copy this directory under your app and import:

```ts
import { RegexRedactor } from './redactors/regex-default';
const redactor = new RegexRedactor();
```

## Extending patterns

```ts
import { RegexRedactor, DEFAULT_PATTERNS } from './redactors/regex-default';
const redactor = new RegexRedactor([
  ...DEFAULT_PATTERNS,
  { name: 'org-customer-id', pattern: /\bCUST-[A-Z0-9]{12}\b/g, replacement: '[REDACTED:customer-id]' },
]);
```

## What this adapter does NOT cover

- Customer data (PII, addresses, emails).
- Org-internal API tokens with custom shapes.
- Inline base64-encoded credentials inside larger strings.

For those, ship your own `Redactor` implementation against the
substrate seam at `src/substrate/redactor.ts`.
```

- [ ] **Step 7: Run tests**

```bash
npx vitest run test/examples/regex-redactor.test.ts 2>&1 | tail -10
```

Expected: 5 specific tests + 4 contract tests pass.

- [ ] **Step 8: Commit**

```bash
node scripts/git-as.mjs lag-ceo add examples/redactors/regex-default/ test/examples/regex-redactor.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(examples): RegexRedactor reference adapter + default pattern set"
```

---

### Task 11: `examples/blob-stores/file/` reference adapter

**Files:**
- Create: `examples/blob-stores/file/blob-store.ts`
- Create: `examples/blob-stores/file/index.ts`
- Create: `examples/blob-stores/file/README.md`
- Test: `test/examples/file-blob-store.test.ts`

**Security + correctness considerations:**
- Atomic write: create a temp file, fsync, rename to final location. Avoids two concurrent `put()`s of the same content corrupting each other.
- Sharding: use first 2 hex chars of the digest as subdirectory (`blobs/ab/abcdef...`) so directories don't grow unbounded. 256 subdirs × N files per dir is fine; 100K files in one dir is not.
- Path traversal: the constructor takes a `rootDir`; reject `..` in any computed sub-path (defense against a malformed BlobRef somehow producing a path-escape).
- Cleanup on failure: if the temp file write succeeds but rename fails, the temp file MUST be removed (no orphaned files in `.lag/blobs/`).
- File mode: write blobs with `0o600` (user-only read/write). Group/world should not see secrets-via-failed-redaction.

- [ ] **Step 1: Write failing test**

`test/examples/file-blob-store.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FileBlobStore } from '../../examples/blob-stores/file/index.js';
import { runBlobStoreContract } from '../substrate/blob-store-contract.test.js';

let scratch: string;

afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

async function makeStore() {
  scratch = await mkdtemp(join(tmpdir(), 'lag-blob-test-'));
  const store = new FileBlobStore(scratch);
  return { store, cleanup: async () => { await rm(scratch, { recursive: true, force: true }); } };
}

runBlobStoreContract('FileBlobStore', makeStore);

describe('FileBlobStore specifics', () => {
  it('writes to a sharded path layout', async () => {
    const { store, cleanup } = await makeStore();
    try {
      const ref = await store.put('hello');
      const hex = ref.replace('sha256:', '');
      const expected = join(scratch, 'blobs', hex.slice(0, 2), hex);
      const s = await stat(expected);
      expect(s.isFile()).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('computes the same hash as crypto.createHash', async () => {
    const { store, cleanup } = await makeStore();
    try {
      const content = 'check sum';
      const ref = await store.put(content);
      const expected = createHash('sha256').update(content).digest('hex');
      expect(ref).toBe(`sha256:${expected}`);
    } finally {
      await cleanup();
    }
  });

  it('writes file with 0600 mode', async () => {
    const { store, cleanup } = await makeStore();
    try {
      const ref = await store.put('private');
      const hex = ref.replace('sha256:', '');
      const filePath = join(scratch, 'blobs', hex.slice(0, 2), hex);
      const s = await stat(filePath);
      // On Windows file modes are different; only assert on POSIX.
      if (process.platform !== 'win32') {
        // 0o100600 (regular file + rw owner)
        expect((s.mode & 0o777)).toBe(0o600);
      }
    } finally {
      await cleanup();
    }
  });
});
```

- [ ] **Step 2: Run failing test**

```bash
npx vitest run test/examples/file-blob-store.test.ts 2>&1 | tail -10
```

Expected: module-not-found.

- [ ] **Step 3: Implement `examples/blob-stores/file/blob-store.ts`**

```ts
/**
 * Reference FileBlobStore.
 *
 * Layout: <rootDir>/blobs/<first2hex>/<sha256-hex>
 * Mode: 0o600 (user-only). On Windows this is best-effort; the OS
 *       enforces the equivalent via the user's profile ACLs.
 *
 * Atomic write: write to <rootDir>/blobs/<first2hex>/.tmp.<random>,
 *               fsync, then rename to the final path. Two concurrent
 *               put() of the same content rename to the same final
 *               path; the second rename is a no-op or replaces an
 *               identical file. Either way the final file is correct.
 *
 * Threat model
 * ------------
 * - rootDir MUST be a directory the calling user owns. The constructor
 *   does not chown.
 * - At-rest encryption is OUT OF SCOPE (deferred per spec Section 8.3).
 * - No path traversal: BlobRef parsing is the only source of the hex
 *   suffix; parser rejects malformed input. The shard prefix is
 *   computed by .slice(0, 2) of validated hex, so it is always 2 hex
 *   chars (no path-escape characters possible).
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rename, stat, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  blobRefFromHash,
  parseBlobRef,
  type BlobStore,
  type BlobRef,
} from '../../../src/substrate/blob-store.js';

export class FileBlobStore implements BlobStore {
  constructor(private readonly rootDir: string) {
    if (typeof rootDir !== 'string' || rootDir.length === 0) {
      throw new Error('FileBlobStore: rootDir must be a non-empty string');
    }
  }

  async put(content: Buffer | string): Promise<BlobRef> {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const hex = createHash('sha256').update(buf).digest('hex');
    const ref = blobRefFromHash(hex);
    const finalPath = this.pathForRef(ref);
    // Idempotence shortcut: if the file already exists, skip the write.
    try {
      const s = await stat(finalPath);
      if (s.isFile()) return ref;
    } catch {
      // not present; proceed to write
    }
    const dir = join(this.rootDir, 'blobs', hex.slice(0, 2));
    await mkdir(dir, { recursive: true });
    const tmpName = `.tmp.${randomBytes(8).toString('hex')}`;
    const tmpPath = join(dir, tmpName);
    try {
      await writeFile(tmpPath, buf, { mode: 0o600 });
      await rename(tmpPath, finalPath);
    } catch (err) {
      // Best-effort temp cleanup; ignore failures here (no orphan
      // promises if the rename succeeded but the throw came after).
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw err;
    }
    return ref;
  }

  async get(ref: BlobRef): Promise<Buffer> {
    return readFile(this.pathForRef(ref));
  }

  async has(ref: BlobRef): Promise<boolean> {
    try {
      const s = await stat(this.pathForRef(ref));
      return s.isFile();
    } catch {
      return false;
    }
  }

  private pathForRef(ref: BlobRef): string {
    const { hex } = parseBlobRef(ref);
    return join(this.rootDir, 'blobs', hex.slice(0, 2), hex);
  }
}
```

- [ ] **Step 4: Implement `examples/blob-stores/file/index.ts`**

```ts
export { FileBlobStore } from './blob-store.js';
```

- [ ] **Step 5: Implement `examples/blob-stores/file/README.md`**

```markdown
# FileBlobStore (reference adapter)

File-backed `BlobStore` for the agentic actor loop. Stores
content-addressed blobs at `<rootDir>/blobs/<shard>/<sha256>`.

## Indie path

```ts
import { FileBlobStore } from './blob-stores/file';
const blobStore = new FileBlobStore('/path/to/your/.lag');
```

## Notes

- Atomic write via temp file + rename.
- `0o600` file mode (POSIX); Windows defers to profile ACLs.
- No GC. Deleting unreferenced blobs is a deferred follow-up.
- No encryption. Treat the blob root as having the same trust
  boundary as the rest of `.lag/`.
```

- [ ] **Step 6: Run tests**

```bash
npx vitest run test/examples/file-blob-store.test.ts 2>&1 | tail -10
```

Expected: 4 contract tests + 3 specifics pass.

- [ ] **Step 7: Commit**

```bash
node scripts/git-as.mjs lag-ceo add examples/blob-stores/file/ test/examples/file-blob-store.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(examples): FileBlobStore reference adapter"
```

---

### Task 12: `examples/workspace-providers/git-worktree/` reference adapter

**Files:**
- Create: `examples/workspace-providers/git-worktree/provider.ts`
- Create: `examples/workspace-providers/git-worktree/index.ts`
- Create: `examples/workspace-providers/git-worktree/README.md`
- Test: `test/examples/git-worktree-provider.test.ts`

**Security + correctness considerations:**
- The path naming MUST sanitize `correlationId` to avoid filesystem injection (e.g., `..`, `/`, control chars). Use a sanitizer that maps invalid chars to `-` and clips at a reasonable length.
- Cred copying from primary: copy ONLY the cred files for the requested principal. Do NOT bulk-copy `.lag/apps/`. Memory: `feedback_bot_creds_copy_to_new_worktrees`.
- `release()` MUST run `git worktree remove --force` even if the worktree is dirty. The agent may have left uncommitted changes; we discard them.
- Concurrent acquire of the SAME correlation_id MUST fail (or yield distinct paths). Document the policy.
- Workspace acquire must verify the base ref exists in the repo before creating a worktree (avoids creating an empty broken state).
- Test environment: tests use a temp git repo (init + commit). Don't run against the live `memory-governance` repo.

- [ ] **Step 1: Write failing test**

`test/examples/git-worktree-provider.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitWorktreeProvider } from '../../examples/workspace-providers/git-worktree/index.js';
import { runWorkspaceProviderContract } from '../substrate/workspace-provider-contract.test.js';
import type { PrincipalId } from '../../src/substrate/types.js';

let repoDir: string;

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lag-wt-test-'));
  await execa('git', ['init', '-q', '-b', 'main', dir]);
  await execa('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  await execa('git', ['-C', dir, 'config', 'user.name', 'Test']);
  await mkdir(join(dir, '.lag', 'apps'), { recursive: true });
  await writeFile(join(dir, '.lag', 'apps', 'lag-ceo.json'), '{"role":"lag-ceo"}');
  await writeFile(join(dir, 'README.md'), 'hello');
  await execa('git', ['-C', dir, 'add', '.']);
  await execa('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

beforeEach(async () => {
  repoDir = await initRepo();
});

afterEach(async () => {
  if (repoDir) await rm(repoDir, { recursive: true, force: true });
});

runWorkspaceProviderContract('GitWorktreeProvider', () => new GitWorktreeProvider({ repoDir, copyCredsForRoles: ['lag-ceo'] }));

describe('GitWorktreeProvider specifics', () => {
  it('creates a worktree on the requested base ref', async () => {
    const p = new GitWorktreeProvider({ repoDir, copyCredsForRoles: ['lag-ceo'] });
    const ws = await p.acquire({ principal: 'cto-actor' as PrincipalId, baseRef: 'main', correlationId: 'spec-1' });
    try {
      const s = await stat(ws.path);
      expect(s.isDirectory()).toBe(true);
      // README.md from the base commit should be present.
      const r = await stat(join(ws.path, 'README.md'));
      expect(r.isFile()).toBe(true);
    } finally {
      await p.release(ws);
    }
  });

  it('copies bot creds for requested roles only', async () => {
    const p = new GitWorktreeProvider({ repoDir, copyCredsForRoles: ['lag-ceo'] });
    const ws = await p.acquire({ principal: 'cto-actor' as PrincipalId, baseRef: 'main', correlationId: 'spec-2' });
    try {
      const credPath = join(ws.path, '.lag', 'apps', 'lag-ceo.json');
      const s = await stat(credPath);
      expect(s.isFile()).toBe(true);
    } finally {
      await p.release(ws);
    }
  });

  it('release removes the worktree directory', async () => {
    const p = new GitWorktreeProvider({ repoDir, copyCredsForRoles: ['lag-ceo'] });
    const ws = await p.acquire({ principal: 'cto-actor' as PrincipalId, baseRef: 'main', correlationId: 'spec-3' });
    await p.release(ws);
    await expect(stat(ws.path)).rejects.toThrow();
  });

  it('rejects unknown base ref', async () => {
    const p = new GitWorktreeProvider({ repoDir, copyCredsForRoles: ['lag-ceo'] });
    await expect(p.acquire({ principal: 'p' as PrincipalId, baseRef: 'no-such-ref', correlationId: 'spec-4' })).rejects.toThrow(/baseRef/);
  });

  it('sanitizes correlation_id in path (no .. survives any form)', async () => {
    const p = new GitWorktreeProvider({ repoDir, copyCredsForRoles: ['lag-ceo'] });
    // Test multiple traversal-attempt shapes:
    for (const attempt of ['../escape/attempt', '..\\windows-escape', '....\\double', '../../absolute']) {
      const ws = await p.acquire({ principal: 'p' as PrincipalId, baseRef: 'main', correlationId: attempt });
      try {
        // The sanitized id portion of the path must NOT contain ANY '..' substring.
        // Strip the worktrees-root prefix; what remains is the sanitized id.
        const idPortion = ws.id;
        expect(idPortion.includes('..')).toBe(false);
        // And the full path must not contain a parent-traversal segment.
        expect(ws.path.includes('..' + '/') || ws.path.includes('..\\')).toBe(false);
      } finally {
        await p.release(ws);
      }
    }
  });
});
```

- [ ] **Step 2: Run failing test**

```bash
npx vitest run test/examples/git-worktree-provider.test.ts 2>&1 | tail -15
```

Expected: module-not-found.

- [ ] **Step 3: Implement `examples/workspace-providers/git-worktree/provider.ts`**

```ts
/**
 * Reference WorkspaceProvider: git-worktree-backed.
 *
 * Acquires a workspace at <repoDir>/.worktrees/agentic/<sanitized-corr-id>,
 * checks out at the requested baseRef, optionally copies bot creds for
 * specified roles. Release runs `git worktree remove --force`.
 *
 * Threat model
 * ------------
 * - repoDir MUST be a real git repo. Constructor does not validate
 *   beyond a path-exists smoke check; the first acquire fails clearly
 *   if not.
 * - correlation_id is sanitized: invalid filesystem chars replaced
 *   with '-'; '..' segments removed; clipped to 80 chars.
 * - Cred copying is opt-in per role. Only listed roles are copied.
 *   Memory: feedback_bot_creds_copy_to_new_worktrees.
 * - Process-local isolation only. Stronger isolation (docker, k8s) is
 *   an opt-in swap; this adapter is the indie default.
 */

import { execa } from 'execa';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  WorkspaceProvider,
  Workspace,
  AcquireInput,
} from '../../../src/substrate/workspace-provider.js';

export interface GitWorktreeProviderOptions {
  readonly repoDir: string;
  /** Bot identities whose creds are copied into the workspace's `.lag/apps/`. */
  readonly copyCredsForRoles: ReadonlyArray<string>;
  /** Base directory for worktrees. Defaults to `<repoDir>/.worktrees/agentic`. */
  readonly worktreesRoot?: string;
}

export class GitWorktreeProvider implements WorkspaceProvider {
  private readonly worktreesRoot: string;

  constructor(private readonly opts: GitWorktreeProviderOptions) {
    this.worktreesRoot = opts.worktreesRoot ?? join(opts.repoDir, '.worktrees', 'agentic');
  }

  async acquire(input: AcquireInput): Promise<Workspace> {
    // Validate baseRef exists.
    const r = await execa('git', ['-C', this.opts.repoDir, 'rev-parse', '--verify', `${input.baseRef}^{commit}`], { reject: false });
    if (r.exitCode !== 0) {
      throw new Error(`GitWorktreeProvider: baseRef '${input.baseRef}' not found in repo`);
    }
    const id = sanitizeId(input.correlationId);
    const path = join(this.worktreesRoot, id);
    await mkdir(this.worktreesRoot, { recursive: true });
    const branch = `agentic/${id}`;
    const create = await execa('git', ['-C', this.opts.repoDir, 'worktree', 'add', '-b', branch, path, input.baseRef], { reject: false });
    if (create.exitCode !== 0) {
      throw new Error(`GitWorktreeProvider: worktree add failed: ${create.stderr}`);
    }
    // Copy bot creds.
    for (const role of this.opts.copyCredsForRoles) {
      const src = join(this.opts.repoDir, '.lag', 'apps', `${role}.json`);
      try {
        await stat(src);
      } catch {
        continue; // role not provisioned in this repo; skip silently.
      }
      const dst = join(path, '.lag', 'apps', `${role}.json`);
      await mkdir(join(path, '.lag', 'apps'), { recursive: true });
      await copyFile(src, dst);
      // Also copy the .pem if present.
      const srcKey = join(this.opts.repoDir, '.lag', 'apps', 'keys', `${role}.pem`);
      const dstKey = join(path, '.lag', 'apps', 'keys', `${role}.pem`);
      try {
        await stat(srcKey);
        await mkdir(join(path, '.lag', 'apps', 'keys'), { recursive: true });
        await copyFile(srcKey, dstKey);
      } catch {
        // No key for this role; omit silently (some roles use OAuth).
      }
    }
    return { id, path, baseRef: input.baseRef };
  }

  async release(workspace: Workspace): Promise<void> {
    // Idempotent: if the worktree is already gone, swallow.
    const r = await execa('git', ['-C', this.opts.repoDir, 'worktree', 'remove', '--force', workspace.path], { reject: false });
    if (r.exitCode !== 0 && !/not a working tree/.test(r.stderr ?? '')) {
      // Real failure; surface.
      throw new Error(`GitWorktreeProvider: worktree remove failed: ${r.stderr}`);
    }
  }
}

function sanitizeId(raw: string): string {
  // Strip path-traversal segments AND any embedded '..' substring.
  // Splitting on /\\ and removing '..' segments handles `../foo` and
  // `..\foo`; the subsequent `..` -> '_' replace handles `....` and
  // any embedded '..' that survives segment splitting (defense in depth).
  const noTraversal = raw.split(/[/\\]/).filter((seg) => seg !== '..' && seg.length > 0).join('-');
  const safe = noTraversal
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/\.{2,}/g, '_'); // collapse any '..' or '...' run to '_'
  return safe.slice(0, 80);
}
```

- [ ] **Step 4: Implement `examples/workspace-providers/git-worktree/index.ts`**

```ts
export { GitWorktreeProvider, type GitWorktreeProviderOptions } from './provider.js';
```

- [ ] **Step 5: Implement `examples/workspace-providers/git-worktree/README.md`**

```markdown
# GitWorktreeProvider (reference adapter)

Git-worktree-backed WorkspaceProvider for the agentic actor loop.

## Indie path

```ts
import { GitWorktreeProvider } from './workspace-providers/git-worktree';
const provider = new GitWorktreeProvider({
  repoDir: '/path/to/your/repo',
  copyCredsForRoles: ['lag-ceo'],
});
const ws = await provider.acquire({ principal: 'cto-actor', baseRef: 'main', correlationId: 'demo-1' });
try {
  // agent runs here at ws.path
} finally {
  await provider.release(ws);
}
```

## What this does

- `git worktree add -b agentic/<corr-id> <path> <baseRef>`
- Optional cred copy for listed roles (`<role>.json` + `<role>.pem`).
- Release: `git worktree remove --force`.

## What this does NOT

- No process isolation beyond the OS user. For stronger isolation
  (docker, k8s pod), implement a different `WorkspaceProvider`.
- No GC of stale worktrees from crashed runs. Operators should run
  `git worktree prune` periodically.
```

- [ ] **Step 6: Run tests**

```bash
npx vitest run test/examples/git-worktree-provider.test.ts 2>&1 | tail -15
```

Expected: 3 contract tests + 5 specifics pass. Tests need git available; expect a clean exit code 0.

- [ ] **Step 7: Commit**

```bash
node scripts/git-as.mjs lag-ceo add examples/workspace-providers/ test/examples/git-worktree-provider.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(examples): GitWorktreeProvider reference adapter"
```

---

### Task 13: `examples/agent-loops/claude-code/` reference adapter (skeleton)

**Files:**
- Create: `examples/agent-loops/claude-code/loop.ts`
- Create: `examples/agent-loops/claude-code/index.ts`
- Create: `examples/agent-loops/claude-code/README.md`
- Test: `test/examples/claude-code-agent-loop.test.ts`

**Security + correctness considerations:**
- The skeleton ships in PR1 to validate the seam shape; full Claude Code CLI integration (real subprocess spawn, real tool whitelist, real budget enforcement) lands in PR2 alongside the executor migration. The skeleton's `run()` MUST emit one session atom + one turn atom and respect `signal` early-cancellation, even if the LLM call itself is stubbed via the `Host.llm`.
- Pattern: skeleton uses `host.llm.judge()` for a single turn against a minimal schema. This pins the seam shape without committing to the full Claude Code subprocess yet.
- The skeleton's PR1 limitations are documented prominently in the README + JSDoc so a reader doesn't think this is the production path.
- Redactor MUST be applied to the LLM input + output before the turn atom write. The contract test verifies this.
- Tool calls in the skeleton are an empty array (no tools yet); PR2 wires real tool emission.
- **`AtomStore.update` semantics**: `update(id, { metadata: { agent_session: {...} } })` performs a SHALLOW merge at the top of `metadata`. The `agent_session` value is REPLACED in full (not deep-merged with the prior value). When updating session terminal state, build the FULL replacement `AgentSessionMeta` object (start fields + completion fields) and pass it under `metadata.agent_session`; do NOT pass partial fields expecting them to merge with the existing inner shape. Source: `src/adapters/memory/atom-store.ts:117` uses `Object.freeze({ ...existing.metadata, ...patch.metadata })`. The skeleton code below already builds the full replacement.

- [ ] **Step 1: Write failing test**

`test/examples/claude-code-agent-loop.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { ClaudeCodeAgentLoopSkeleton } from '../../examples/agent-loops/claude-code/index.js';
import { RegexRedactor } from '../../examples/redactors/regex-default/index.js';
import { FileBlobStore } from '../../examples/blob-stores/file/index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Workspace } from '../../src/substrate/workspace-provider.js';
import type { AtomId, PrincipalId } from '../../src/substrate/types.js';
import { defaultBudgetCap } from '../../src/substrate/agent-budget.js';
import { runAgentLoopContract } from '../substrate/agent-loop-contract.test.js';

describe('ClaudeCodeAgentLoopSkeleton', () => {
  it('emits one session + one turn atom on a basic run', async () => {
    const host = createMemoryHost();
    const scratch = await mkdtemp(join(tmpdir(), 'lag-loop-test-'));
    try {
      const blobStore = new FileBlobStore(scratch);
      const workspace: Workspace = { id: 'ws-1', path: scratch, baseRef: 'main' };
      const adapter = new ClaudeCodeAgentLoopSkeleton();
      const result = await adapter.run({
        host,
        principal: 'cto-actor' as PrincipalId,
        workspace,
        task: { planAtomId: 'plan-test' as AtomId, questionPrompt: 'tiny readme update' },
        budget: defaultBudgetCap(),
        toolPolicy: { disallowedTools: [] },
        redactor: new RegexRedactor(),
        blobStore,
        replayTier: 'content-addressed',
        blobThreshold: 4096,
        correlationId: 'corr-test',
      });
      expect(result.kind).toBe('completed');
      expect(result.turnAtomIds.length).toBeGreaterThanOrEqual(1);
      const session = await host.atomStore.get(result.sessionAtomId);
      expect(session?.type).toBe('agent-session');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('redacts a planted secret from the turn atom payload', async () => {
    const host = createMemoryHost();
    const scratch = await mkdtemp(join(tmpdir(), 'lag-loop-test-'));
    try {
      const blobStore = new FileBlobStore(scratch);
      const workspace: Workspace = { id: 'ws-2', path: scratch, baseRef: 'main' };
      const adapter = new ClaudeCodeAgentLoopSkeleton({
        // For test determinism, make the stub LLM echo the prompt.
        stubResponse: 'I see token AKIAIOSFODNN7EXAMPLE in the input',
      });
      const result = await adapter.run({
        host,
        principal: 'cto-actor' as PrincipalId,
        workspace,
        task: { planAtomId: 'plan-test' as AtomId, questionPrompt: 'echo' },
        budget: defaultBudgetCap(),
        toolPolicy: { disallowedTools: [] },
        redactor: new RegexRedactor(),
        blobStore,
        replayTier: 'best-effort',
        blobThreshold: 4096,
        correlationId: 'corr-test',
      });
      const turn = await host.atomStore.get(result.turnAtomIds[0]!);
      const turnMeta = (turn?.metadata as Record<string, unknown>)['agent_turn'] as Record<string, unknown>;
      const out = turnMeta['llm_output'] as { inline: string } | { ref: string };
      const inlineOrFetch = 'inline' in out ? out.inline : await blobStore.get(out.ref as never).then((b) => b.toString('utf8'));
      expect(inlineOrFetch).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(inlineOrFetch).toContain('[REDACTED:aws-access-key]');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

runAgentLoopContract('ClaudeCodeAgentLoopSkeleton', () => new ClaudeCodeAgentLoopSkeleton());
```

- [ ] **Step 2: Run failing test**

```bash
npx vitest run test/examples/claude-code-agent-loop.test.ts 2>&1 | tail -10
```

Expected: module-not-found.

- [ ] **Step 3: Implement `examples/agent-loops/claude-code/loop.ts`**

```ts
/**
 * SKELETON reference AgentLoopAdapter. PR1-only.
 *
 * IMPORTANT: this is a substrate-validation skeleton, NOT the
 * production agentic Claude Code path. Full Claude Code CLI
 * integration (subprocess spawn, real tool whitelist, real budget
 * enforcement, signal handling) lands in PR2 alongside the
 * AgenticCodeAuthorExecutor migration.
 *
 * What this skeleton DOES (PR1):
 *   - Emits one agent-session atom.
 *   - Emits one agent-turn atom with the redacted LLM input + output.
 *   - Uses host.llm.judge() for a single turn against a minimal schema
 *     (or echoes a stubbed response for tests).
 *   - Honors AbortSignal early-cancellation.
 *
 * What this skeleton does NOT do (PR1):
 *   - Spawn the Claude Code CLI subprocess.
 *   - Iterate multiple turns.
 *   - Emit real tool-call records.
 *   - Compute canon snapshots for strict replay tier.
 *
 * The seam shape is what PR1 ships; the body grows in PR2.
 */

import { randomBytes } from 'node:crypto';
import type {
  AgentLoopAdapter,
  AgentLoopInput,
  AgentLoopResult,
  AdapterCapabilities,
} from '../../../src/substrate/agent-loop.js';
import { defaultClassifyFailure } from '../../../src/substrate/agent-loop.js';
import type {
  Atom,
  AtomId,
  AgentSessionMeta,
  AgentTurnMeta,
} from '../../../src/substrate/types.js';

export interface ClaudeCodeAgentLoopSkeletonOptions {
  /** For tests: stubbed LLM output. Production path calls host.llm.judge(). */
  readonly stubResponse?: string;
}

export class ClaudeCodeAgentLoopSkeleton implements AgentLoopAdapter {
  readonly capabilities: AdapterCapabilities = {
    tracks_cost: false,
    supports_signal: true,
    classify_failure: defaultClassifyFailure,
  };

  constructor(private readonly opts: ClaudeCodeAgentLoopSkeletonOptions = {}) {}

  async run(input: AgentLoopInput): Promise<AgentLoopResult> {
    if (input.signal?.aborted) {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    const startedAt = new Date().toISOString();
    const sessionId = `agent-session-${randomBytes(6).toString('hex')}` as AtomId;
    const sessionMetaInitial: AgentSessionMeta = {
      model_id: 'claude-opus-4-7',
      adapter_id: 'claude-code-agent-loop-skeleton',
      workspace_id: input.workspace.id,
      started_at: startedAt,
      terminal_state: 'completed',
      replay_tier: input.replayTier,
      budget_consumed: { turns: 0, wall_clock_ms: 0 },
    };
    const sessionAtom: Atom = mkAtom(sessionId, 'agent-session', input.principal, [], { agent_session: sessionMetaInitial });
    await input.host.atomStore.put(sessionAtom);

    const promptText = input.task.questionPrompt ?? '';
    const redactedInput = input.redactor.redact(promptText, { kind: 'llm-input', principal: input.principal });
    const responseText = this.opts.stubResponse ?? `(skeleton response to: ${promptText.slice(0, 40)})`;
    const redactedOutput = input.redactor.redact(responseText, { kind: 'llm-output', principal: input.principal });

    const turnId = `agent-turn-${randomBytes(6).toString('hex')}` as AtomId;
    const turnMeta: AgentTurnMeta = {
      session_atom_id: sessionId,
      turn_index: 0,
      llm_input: { inline: redactedInput },
      llm_output: { inline: redactedOutput },
      tool_calls: [],
      latency_ms: 0,
    };
    const turnAtom: Atom = mkAtom(turnId, 'agent-turn', input.principal, [sessionId], { agent_turn: turnMeta });
    await input.host.atomStore.put(turnAtom);

    // Update session terminal state.
    const completedAt = new Date().toISOString();
    await input.host.atomStore.update(sessionId, {
      metadata: {
        agent_session: {
          ...sessionMetaInitial,
          completed_at: completedAt,
          terminal_state: 'completed',
          budget_consumed: { turns: 1, wall_clock_ms: 0 },
        },
      },
    });

    return {
      kind: 'completed',
      sessionAtomId: sessionId,
      turnAtomIds: [turnId],
    };
  }
}

function mkAtom(
  id: AtomId,
  type: 'agent-session' | 'agent-turn',
  principal: import('../../../src/substrate/types.js').PrincipalId,
  derived: ReadonlyArray<AtomId>,
  metadata: Record<string, unknown>,
): Atom {
  const now = new Date().toISOString();
  return {
    schema_version: 1, id, content: '', type, layer: 'L1',
    provenance: { kind: 'agent-observed', source: { agent_id: principal as unknown as string }, derived_from: derived as AtomId[] },
    confidence: 1, created_at: now, last_reinforced_at: now, expires_at: null,
    supersedes: [], superseded_by: [], scope: 'project',
    signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
    principal_id: principal, taint: 'clean',
    metadata,
  };
}
```

- [ ] **Step 4: Implement `examples/agent-loops/claude-code/index.ts`**

```ts
export { ClaudeCodeAgentLoopSkeleton, type ClaudeCodeAgentLoopSkeletonOptions } from './loop.js';
```

- [ ] **Step 5: Implement `examples/agent-loops/claude-code/README.md`**

```markdown
# ClaudeCodeAgentLoopSkeleton (PR1 - substrate-validation skeleton)

This is a SKELETON. It validates the `AgentLoopAdapter` seam shape +
atom emission discipline. **It is not the production agentic Claude
Code path.** That ships in PR2.

## What it does (PR1)

- Emits one `agent-session` atom + one `agent-turn` atom per `run()`.
- Applies the Redactor to LLM input + output before atom write.
- Honors `AbortSignal` early-cancellation.
- Optional `stubResponse` for deterministic tests.

## What it doesn't (yet)

- Spawn the Claude Code CLI subprocess.
- Multi-turn iteration.
- Real tool-call emission.
- Strict-tier canon snapshots.

PR2 adds these in `AgenticCodeAuthorExecutor`'s migration plan.

## Indie path (when PR2 lands)

```ts
import { ClaudeCodeAgentLoop } from './agent-loops/claude-code';
const adapter = new ClaudeCodeAgentLoop({ maxTurns: 30 });
```

For PR1 work, prefer the skeleton or the in-test mock.
```

- [ ] **Step 6: Run tests**

```bash
npx vitest run test/examples/claude-code-agent-loop.test.ts 2>&1 | tail -15
```

Expected: 2 specifics + 1 contract test pass.

- [ ] **Step 7: Commit**

```bash
node scripts/git-as.mjs lag-ceo add examples/agent-loops/ test/examples/claude-code-agent-loop.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(examples): ClaudeCodeAgentLoopSkeleton - PR1 seam-validation skeleton"
```

---

### Task 14: Substrate barrel export update

**Files:**
- Modify: `src/substrate/index.ts`
- Test: `test/public-surface/substrate-exports.test.ts` (create if not present)

**Security + correctness considerations:**
- Each export adds a public surface promise that must remain stable across versions. Before adding to `index.ts`, confirm the symbol is intended for public consumption (interfaces yes; internal helpers no).
- `loadReplayTier` and `loadBlobThreshold` are public (consumers call them). The default-failure-classifier `defaultClassifyFailure` is public.
- The `runBlobStoreContract`, `runRedactorContract`, etc. helpers are exported from test files for test-author use; they do NOT need to be in the public substrate surface.

- [ ] **Step 1: Read current `src/substrate/index.ts`**

```bash
cat src/substrate/index.ts
```

- [ ] **Step 2: Update with new module re-exports**

```ts
/**
 * Substrate barrel.
 *
 * (existing comment block preserved)
 */

export * as deliberation from './deliberation/index.js';
export * as arbitration from './arbitration/index.js';
export * as canonMd from './canon-md/index.js';
export * as killSwitch from './kill-switch/index.js';
export * as promotion from './promotion/index.js';
export * as taint from './taint/index.js';

// Agentic actor loop substrate (PR1 of agentic-actor-loop spec).
// camelCase namespace exports to match the existing barrel style
// (canonMd, killSwitch). Do NOT use snake_case - CR will flag it.
export * as agentLoop from './agent-loop.js';
export * as workspaceProvider from './workspace-provider.js';
export * as blobStore from './blob-store.js';
export * as redactor from './redactor.js';
export * as agentBudget from './agent-budget.js';
export * as policyReplayTier from './policy/replay-tier.js';
export * as policyBlobThreshold from './policy/blob-threshold.js';
export * as projectionsSessionTree from './projections/session-tree.js';

export type * from './types.js';
export type * from './interface.js';
export * from './errors.js';
```

- [ ] **Step 3: Add a public-surface test (or extend existing)**

If `test/public-surface/substrate-exports.test.ts` doesn't exist, create:

```ts
import { describe, it, expect } from 'vitest';
import * as substrate from '../../src/substrate/index.js';

describe('public surface: substrate barrel', () => {
  it('exposes new agentic-actor-loop seams', () => {
    expect(substrate.agentLoop).toBeDefined();
    expect(substrate.workspaceProvider).toBeDefined();
    expect(substrate.blobStore).toBeDefined();
    expect(substrate.redactor).toBeDefined();
    expect(substrate.agentBudget).toBeDefined();
    expect(substrate.policyReplayTier).toBeDefined();
    expect(substrate.policyBlobThreshold).toBeDefined();
    expect(substrate.projectionsSessionTree).toBeDefined();
  });

  it('preserves existing exports', () => {
    expect(substrate.deliberation).toBeDefined();
    expect(substrate.arbitration).toBeDefined();
    expect(substrate.canonMd).toBeDefined();
    expect(substrate.killSwitch).toBeDefined();
    expect(substrate.promotion).toBeDefined();
    expect(substrate.taint).toBeDefined();
  });
});
```

- [ ] **Step 4: Run public-surface test + full typecheck**

```bash
npx vitest run test/public-surface/substrate-exports.test.ts 2>&1 | tail -10
npx tsc --noEmit 2>&1 | tail -10
```

Expected: tests pass; tsc clean.

- [ ] **Step 5: Commit**

```bash
node scripts/git-as.mjs lag-ceo add src/substrate/index.ts test/public-surface/substrate-exports.test.ts
node scripts/git-as.mjs lag-ceo commit -m "feat(substrate): export new agentic-actor-loop seams from barrel"
```

---

### Task 15: Pre-push validation + open PR

**Files:** none modified; runs validation gates.

**Security + correctness considerations:**
- The pre-push grep checklist is mandatory per `feedback_pre_push_grep_checklist`. Misses here become CR findings.
- CR's `package hygiene` check enforces emdashes + private-term policy; mirror its scope locally.
- Build cache - fresh build before pushing to confirm types compile cleanly without stale artifacts.

- [ ] **Step 1: Run full test suite + build**

```bash
npm run build 2>&1 | tail -5
npx vitest run 2>&1 | tail -10
npx tsc --noEmit 2>&1 | tail -10
```

Expected: green across all three.

- [ ] **Step 2: Pre-push grep - emdashes, private terms, design refs in src/, canon ids in src/**

```bash
# Emdashes anywhere in tracked files
grep -rnP --include='*.ts' --include='*.mjs' --include='*.js' --include='*.md' --include='*.yml' '\xe2\x80\x94' src/ examples/ test/ docs/ scripts/ | head
# Design / ADR refs in src/ JSDoc (forbidden per feedback_src_docs_mechanism_only_no_design_links)
grep -rnP --include='*.ts' "design/|DECISIONS\.md|inv-|dev-|pol-" src/substrate/ src/runtime/ src/actors/ | head
# Canon-id leakage into framework code
grep -rnP --include='*.ts' "intent-[0-9a-f]{12}" src/ | head
```

Expected: empty output for all three.

- [ ] **Step 3: Confirm branch is up-to-date with main + create PR branch from main**

```bash
git fetch origin main
git rev-list --count origin/main..HEAD     # ahead count
git rev-list --count HEAD..origin/main     # behind count (must be 0)
```

If behind, rebase first:

```bash
git rebase origin/main
```

- [ ] **Step 4: Push branch + open PR**

If working on a feature branch (typical):

```bash
node scripts/git-as.mjs lag-ceo push origin <branch-name>
```

Then open PR via `lag-ceo`:

```bash
node scripts/gh-as.mjs lag-ceo pr create \
  --base main \
  --head <branch-name> \
  --title "feat(substrate): agentic actor loop foundations (PR1 of agentic-actor-loop spec)" \
  --body "$(cat <<'EOF'
## Summary

PR1 of the agentic-actor-loop spec at \`docs/superpowers/specs/2026-04-25-agentic-actor-loop-design.md\` (committed via PR #166).

Lands the substrate-level foundations:
- 4 pluggable seams in \`src/substrate/\`: \`AgentLoopAdapter\`, \`WorkspaceProvider\`, \`BlobStore\`, \`Redactor\`.
- 2 atom types added to the \`AtomType\` union: \`agent-session\`, \`agent-turn\`.
- 2 policy parsers: \`pol-replay-tier\`, \`pol-blob-threshold\` (clamped 256B-1MB).
- \`session-tree\` projection helper.
- 4 reference adapters in \`examples/\`: \`FileBlobStore\`, \`RegexRedactor\`, \`GitWorktreeProvider\`, \`ClaudeCodeAgentLoopSkeleton\`.
- Full unit + contract test coverage.

Atom-store migration is purely additive (no breaking changes). \`AgenticCodeAuthorExecutor\` migration is PR2.

## Cross-cutting discipline

Every task in the implementation plan included a "Security + correctness considerations" subsection. Walked threat models BEFORE writing code per memory \`feedback_security_correctness_at_write_time\`.

## Test plan

- [ ] All substrate contract tests green.
- [ ] All reference-adapter tests green.
- [ ] Public-surface tests green.
- [ ] \`tsc --noEmit\` clean.
- [ ] Pre-push grep checklist clean (no emdashes, no private terms, no design/ADR refs in src/, no canon ids in src/).

## Out of scope

- AgenticCodeAuthorExecutor migration (PR2).
- Other-actor migrations (planning, auditor, pr-landing).
- At-rest encryption (deferred per spec Section 8.3).
EOF
)"
```

- [ ] **Step 5: Trigger CR review on the new PR**

```bash
node scripts/trigger-cr-review.mjs --pr <pr-number>
```

- [ ] **Step 6: Verify CR posts an `APPROVED` (or address findings)**

Wait for CR's review. Address any actionables per the recurring-pattern checklist (`feedback_cr_recurring_pattern_presubmit_checklist`). Repeat until CR posts APPROVED.

- [ ] **Step 7: Merge once green + APPROVED**

```bash
node scripts/gh-as.mjs lag-ceo pr merge <pr-number> --squash --delete-branch
```

After merge, in the primary worktree:

```bash
git pull origin main
```

(Per `feedback_pull_main_after_pr_merge`.)

---

## Out of scope (PR2 + later)

- `AgenticCodeAuthorExecutor` consuming the seam (PR2).
- Real Claude Code CLI subprocess integration (PR2).
- PlanningActor / AuditorActor / PrLandingActor migrations (separate plans).
- At-rest encryption for atom store + blob store.
- Replay UI, cross-actor session-tree dashboard.

## Notes for the implementer

1. Each task is implementer-subagent-sized. Dispatch fresh subagent per task per `superpowers:subagent-driven-development`.
2. Follow TDD: write the failing test FIRST, then the implementation. Skill: `@superpowers:test-driven-development`.
3. Commit after each task (the tasks include the commit step).
4. The `Security + correctness considerations` subsection on each task is NOT optional. Walk it before writing code.
5. If a task surfaces a substrate bug in existing code (e.g., `AtomFilter.derived_from` not supported), file a tiny follow-up plan rather than expanding the current task.
6. Memory `feedback_pre_push_grep_checklist` lists the exact one-liner to run before each commit.

---

## Provenance

- Spec: `docs/superpowers/specs/2026-04-25-agentic-actor-loop-design.md` (PR #166).
- Memories: `feedback_security_correctness_at_write_time`, `feedback_pull_main_after_pr_merge`, `feedback_canon_strategic_not_tactical`, `feedback_pre_push_grep_checklist`, `feedback_cr_recurring_pattern_presubmit_checklist`, `feedback_bot_creds_copy_to_new_worktrees`, `feedback_git_as_minus_u_leaks_token`.
- Builds on: PRs #157-#165 (substrate foundations + dogfood-cycle).
