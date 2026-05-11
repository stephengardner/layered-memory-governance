# Zero-Failure Sub-Agent Substrate -- PR1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task includes a `canon-audit` step per canon `dev-implementation-canon-audit-loop`.

**Goal:** Land the foundational substrate primitives of the zero-failure sub-agent system: a `work-claim` atom type, a token-and-principal-bound `dispatchSubAgent` / `markClaimComplete` contract, four reference verifier handlers, a two-phase claim reaper with bounded tiered recovery, nine canon policy atoms, and PreToolUse + redactor hardening. No principal-side wiring lands in PR1; legacy direct-dispatch paths continue to work unchanged.

**Architecture:** All new code is additive under `src/substrate/claim-contract.ts`, `src/substrate/claim-verifiers/`, and `src/runtime/loop/claim-reaper.ts`. Atoms persist via existing `AtomStore.put` with optimistic version checks (PR #197). Canon policies resolve via existing `kind`+`scope` arbitration (never by atom id). PR1 ships the mechanism only; PR2 wires it into `LoopRunner`; PR3-7 migrate the 5 LAG principals one at a time.

**Tech Stack:** TypeScript, Node.js crypto (`randomBytes`), zod for runtime schemas, vitest. No new dependencies.

**Spec source:** `docs/superpowers/specs/2026-05-10-zero-failure-sub-agent-substrate.md` (merged in PR #391, commit `2790d67`, 2026-05-11). All design decisions, alternatives_rejected, threat model rows, and PR1 acceptance criteria are normative.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/atoms/types.ts` (modify) | Add `WorkClaimAtom`, `ClaimState`, `BudgetTier`, attestation-result atom types. Additive only. |
| `src/substrate/claim-contract.ts` (new, ~280 LOC) | `dispatchSubAgent`, `markClaimComplete`, `ClaimHandle`, token helpers, verifier dispatcher. Mechanism-only; no principal names. |
| `src/substrate/claim-verifiers/index.ts` (new, ~40 LOC) | Registry + dispatch by `terminal_kind`. |
| `src/substrate/claim-verifiers/pr.ts` (new, ~50 LOC) | GitHub PR state verifier via `gh-as.mjs` shim. |
| `src/substrate/claim-verifiers/plan.ts` (new, ~30 LOC) | AtomStore plan-id lookup. |
| `src/substrate/claim-verifiers/task.ts` (new, ~30 LOC) | TaskList lookup. |
| `src/substrate/claim-verifiers/research-atom.ts` (new, ~30 LOC) | AtomStore atom-id lookup. |
| `src/substrate/policies/claim-budget-tier.ts` (new, ~40 LOC) | Tier resolution via canon-policy kind lookup. |
| `src/substrate/policies/claim-reaper-config.ts` (new, ~60 LOC) | Cadence + grace + cap + extension policy readers. |
| `src/runtime/loop/claim-reaper.ts` (new, ~250 LOC) | `runClaimReaperTick`, `detectStalledClaims`, `drainStalledQueue`, `recoverStalledClaim`. |
| `.claude/hooks/enforce-claim-atom-writers.mjs` (new, ~80 LOC) | PreToolUse hook rejecting sub-agent principal writes of claim-lifecycle atoms. |
| `src/redactors/default-patterns.ts` (modify) | Add `CLAIM_SECRET_TOKEN_PATTERN` to default redactor set. |
| `bootstrap/canon/pol-claim-*.json` (new, 11 files for PR1) | 3 budget-tier atoms (default/raised/max) + 8 numeric-config atoms (cadence, recovery-max, deadline-extension, attesting-grace, pending-grace, verifier-timeout, verifier-failure-cap, session-post-finalize-grace). The `pol-loop-pass-claim-reaper-default.json` is deferred to PR2 per spec Section 13. |
| `bootstrap/bootstrap-claim-contract-canon.mjs` (new, ~60 LOC) | One-shot script to seed the 9 atoms. |
| `test/substrate/claim-contract.test.ts` (new, ~600 LOC) | Lifecycle, attestation, token, principal, deadline tests. |
| `test/substrate/claim-verifiers.test.ts` (new, ~200 LOC) | Each verifier handler accept + ground-truth-mismatch paths. |
| `test/runtime/loop/claim-reaper.test.ts` (new, ~400 LOC) | Phase A, Phase B, recovery ladder, STOP, concurrent locks. |
| `test/hooks/enforce-claim-atom-writers.test.ts` (new, ~100 LOC) | Hook accept + reject paths. |
| `test/fixtures/github-mock.ts` (modify or extend) | Real-PR fixture for e2e. |
| `test/e2e/claim-contract-e2e.test.ts` (new, ~150 LOC) | Real-PR fixture e2e. |

Total estimate: ~2,400 LOC across ~17 new files + 3 modifications, with ~1,450 LOC of test code (60% test density).

---

## Cross-cutting Disciplines (apply to every task)

These do not become separate tasks. They are gates inside every substantive task.

1. **TDD.** Write the failing test first, run to fail, implement, run to pass, then proceed.
2. **No em dashes.** All commit messages, comments, JSDoc, doc strings use ASCII only (`-` or `--`). Verify with `git diff | grep -P '\x{2014}'` returning empty before commit.
3. **Canon-audit (per `dev-implementation-canon-audit-loop`).** Between "tests pass" and "commit", dispatch a canon-compliance auditor subagent with: (a) `CLAUDE.md` + relevant `.lag/atoms/`, (b) the plan task text, (c) the diff produced, (d) the spec Section 11 threat model when the task touches `markClaimComplete`, the verifier dispatcher, the redactor regex, or the PreToolUse hook. Auditor returns Approved or Issues Found; iterate until Approved.
4. **Security + correctness considerations.** Each task carries a Security + correctness subsection walked through BEFORE writing the failing test.
5. **Bot identity for git.** Commits via `node ../../scripts/git-as.mjs lag-ceo commit ...` (NEVER bare `git commit`). Push via `node ../../scripts/git-as.mjs lag-ceo push origin feat/impl-claim-contract-substrate` (NO `-u` flag per `feedback_git_as_minus_u_leaks_token`).
6. **Pre-push grep checklist** (per `feedback_pre_push_grep_checklist`): em dashes, private terms (`.github/workflows/ci.yml` list), design/ADR refs in src/, canon ids in src/ JSDoc. Run once before the final push.

---

## Task 1: WorkClaimAtom type + lifecycle state union + attestation atom types

**Files:**
- Modify: `src/atoms/types.ts` (additive, append after existing atom-type discriminants)
- Test: `test/atoms/types.test.ts` (add a `describe('WorkClaimAtom shape')` block)

**Security + correctness considerations:**
- `claim_secret_token` is a string field at `metadata.work_claim.claim_secret_token`; document via JSDoc that it MUST be redacted from any persisted log or atom-derived string. (Enforcement lands in Task 16.)
- `claim_state` is a closed string-literal union; mistyping a state in implementation code surfaces as a TypeScript error.
- `budget_tier` is `string` (open-extensible per spec Section 5); runtime validation happens at `dispatchSubAgent` step 5 (Task 10).

- [ ] **Step 1: Write the failing test**

```ts
// test/atoms/types.test.ts (add to existing file)
import { describe, expect, it } from 'vitest';
import type {
  WorkClaimAtom,
  ClaimAttestationAcceptedAtom,
  ClaimAttestationRejectedAtom,
  ClaimStalledAtom,
  ClaimEscalatedAtom,
  ClaimState,
} from '../../src/atoms/types.js';

describe('WorkClaimAtom shape', () => {
  it('accepts a structurally-valid claim atom', () => {
    const atom: WorkClaimAtom = {
      id: 'work-claim-abc123',
      type: 'work-claim',
      layer: 'L0',
      principal_id: 'cto-actor',
      content: 'drive PR #999 to MERGED',
      confidence: 1.0,
      created_at: '2026-05-11T02:00:00Z',
      provenance: {
        kind: 'machine-dispatched',
        derived_from: ['intent-foo'],
        source_chain: [],
      },
      metadata: {
        work_claim: {
          claim_id: 'work-claim-abc123',
          claim_secret_token: 'A'.repeat(43),
          dispatched_principal_id: 'code-author',
          brief: {
            prompt: 'fix the bug',
            expected_terminal: {
              kind: 'pr',
              identifier: '999',
              terminal_states: ['MERGED'],
            },
            deadline_ts: '2026-05-11T04:00:00Z',
          },
          claim_state: 'pending',
          budget_tier: 'default',
          recovery_attempts: 0,
          verifier_failure_count: 0,
          parent_claim_id: null,
          session_atom_ids: [],
          last_attestation_rejected_at: null,
          latest_session_finalized_at: null,
        },
      },
    };
    expect(atom.type).toBe('work-claim');
    expect(atom.metadata.work_claim.claim_state).toBe('pending');
  });

  it('exhaustively types the ClaimState union', () => {
    const states: ClaimState[] = [
      'pending',
      'executing',
      'attesting',
      'complete',
      'stalled',
      'abandoned',
    ];
    expect(states).toHaveLength(6);
  });

  it('exposes the four attestation/lifecycle atom types', () => {
    const accepted: ClaimAttestationAcceptedAtom['type'] = 'claim-attestation-accepted';
    const rejected: ClaimAttestationRejectedAtom['type'] = 'claim-attestation-rejected';
    const stalled: ClaimStalledAtom['type'] = 'claim-stalled';
    const escalated: ClaimEscalatedAtom['type'] = 'claim-escalated';
    expect([accepted, rejected, stalled, escalated]).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/atoms/types.test.ts -t 'WorkClaimAtom shape'`
Expected: FAIL with "Cannot find name 'WorkClaimAtom'" / "Module has no exported member 'ClaimState'".

- [ ] **Step 3: Implement the types**

Append to `src/atoms/types.ts`:

```ts
export type ClaimState =
  | 'pending'
  | 'executing'
  | 'attesting'
  | 'complete'
  | 'stalled'
  | 'abandoned';

export interface WorkClaimBrief {
  prompt: string;
  prompt_blob_ref?: string;
  expected_terminal: {
    kind: 'pr' | 'plan' | 'task' | 'research-atom' | string;
    identifier: string;
    terminal_states: string[];
  };
  deadline_ts: string;
}

export interface WorkClaimAtom extends AtomBase {
  type: 'work-claim';
  layer: 'L0';
  metadata: {
    work_claim: {
      claim_id: string;
      claim_secret_token: string;
      dispatched_principal_id: string;
      brief: WorkClaimBrief;
      claim_state: ClaimState;
      budget_tier: string;
      recovery_attempts: number;
      verifier_failure_count: number;
      parent_claim_id: string | null;
      session_atom_ids: string[];
      last_attestation_rejected_at: string | null;
      latest_session_finalized_at: string | null;
    };
  };
}

export type AttestationRejectionReason =
  | 'stop-sentinel'
  | 'claim-not-found'
  | 'claim-already-terminal'
  | 'token-mismatch'
  | 'principal-mismatch'
  | 'identifier-mismatch'
  | 'kind-mismatch'
  | 'ground-truth-mismatch'
  | 'verifier-error'
  | 'verifier-timeout';

export interface ClaimAttestationAcceptedAtom extends AtomBase {
  type: 'claim-attestation-accepted';
  layer: 'L0';
  metadata: {
    claim_attestation: {
      claim_id: string;
      observed_state: string;
      verified_at: string;
    };
  };
}

export interface ClaimAttestationRejectedAtom extends AtomBase {
  type: 'claim-attestation-rejected';
  layer: 'L0';
  metadata: {
    claim_attestation: {
      claim_id: string;
      reason: AttestationRejectionReason;
      observed_state?: string;
      error?: string;
    };
  };
}

export interface ClaimStalledAtom extends AtomBase {
  type: 'claim-stalled';
  layer: 'L0';
  metadata: {
    claim_stall: {
      claim_id: string;
      reason: string;
      recovery_attempts_at_stall: number;
      verifier_failure_count_at_stall: number;
    };
  };
}

export interface ClaimEscalatedAtom extends AtomBase {
  type: 'claim-escalated';
  layer: 'L0';
  metadata: {
    claim_escalation: {
      claim_id: string;
      failure_reasons: string[];
      session_atom_ids: string[];
    };
  };
}
```

Update the union of all atom types (search for the existing `Atom` discriminated union) to include the five new types.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/atoms/types.test.ts -t 'WorkClaimAtom shape'`
Expected: PASS (3 tests).

- [ ] **Step 5: Canon-audit**

Dispatch canon-compliance auditor subagent with: CLAUDE.md, this task text, the diff. Auditor checks: are the new types mechanism-only (no principal-id strings)? Does JSDoc avoid canon ids? Does the `claim_secret_token` field have a JSDoc warning about redaction? Iterate until Approved.

- [ ] **Step 6: Commit**

```bash
node ../../scripts/git-as.mjs lag-ceo add src/atoms/types.ts test/atoms/types.test.ts
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(atoms): add work-claim + attestation + lifecycle atom types"
```

---

## Task 2: Budget tier resolution helper

**Files:**
- Create: `src/substrate/policies/claim-budget-tier.ts`
- Test: `test/substrate/policies/claim-budget-tier.test.ts`

**Security + correctness considerations:**
- Tier lookup must use `kind: 'claim-budget-tier'` + `tier: <string>` per spec Section 5; never look up by atom id (would break the substrate purity rule).
- Missing tier MUST throw a recognizable error rather than fall back to a default; silent fallback could open a budget-bypass vector.
- Resolver is pure: no atom writes, no side effects beyond CanonStore reads.

- [ ] **Step 1: Write the failing test**

```ts
// test/substrate/policies/claim-budget-tier.test.ts
import { describe, expect, it } from 'vitest';
import { resolveBudgetTier } from '../../../src/substrate/policies/claim-budget-tier.js';
import { makeMemoryHost } from '../../helpers/memory-host.js';

describe('resolveBudgetTier', () => {
  it('resolves default/raised/max to canon-policy max_budget_usd', async () => {
    const host = await makeMemoryHost();
    await host.canonStore.put({
      id: 'pol-claim-budget-tier-default',
      type: 'policy',
      layer: 'L3',
      principal_id: 'apex-agent',
      content: 'default tier',
      confidence: 1.0,
      created_at: '2026-05-11T00:00:00Z',
      provenance: { kind: 'human-asserted', derived_from: [], source_chain: [] },
      metadata: { policy: { kind: 'claim-budget-tier', tier: 'default', max_budget_usd: 2.00 } },
    });
    const usd = await resolveBudgetTier('default', host);
    expect(usd).toBe(2.00);
  });

  it('throws unknown-budget-tier when no matching policy exists', async () => {
    const host = await makeMemoryHost();
    await expect(resolveBudgetTier('nonexistent', host)).rejects.toThrow(/unknown-budget-tier/);
  });

  it('honors a custom org-ceiling tier via canon-policy add', async () => {
    const host = await makeMemoryHost();
    await host.canonStore.put({
      id: 'pol-claim-budget-tier-emergency',
      type: 'policy',
      layer: 'L3',
      principal_id: 'org-budget-policy',
      content: 'emergency tier',
      confidence: 1.0,
      created_at: '2026-05-11T00:00:00Z',
      provenance: { kind: 'human-asserted', derived_from: [], source_chain: [] },
      metadata: { policy: { kind: 'claim-budget-tier', tier: 'emergency', max_budget_usd: 100.00 } },
    });
    const usd = await resolveBudgetTier('emergency', host);
    expect(usd).toBe(100.00);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/substrate/policies/claim-budget-tier.test.ts`
Expected: FAIL with "Cannot find module '.../claim-budget-tier.js'".

- [ ] **Step 3: Implement**

```ts
// src/substrate/policies/claim-budget-tier.ts
import type { Host } from '../host.js';

/**
 * Resolve a budget tier name to the canon-policy max_budget_usd.
 *
 * Lookup is by kind + tier (never by atom id), so org-ceiling deployments
 * may add new tiers by writing higher-priority policy atoms with the
 * same kind. Missing tier is a hard error: silent fallback would open
 * a budget-bypass surface where a typo'd tier silently runs uncapped.
 */
export async function resolveBudgetTier(tier: string, host: Host): Promise<number> {
  const policies = await host.canonStore.findByKind('claim-budget-tier');
  const match = policies.find(
    (atom) => (atom.metadata as any)?.policy?.tier === tier,
  );
  if (!match) {
    throw new Error(`unknown-budget-tier: ${tier}`);
  }
  const usd = (match.metadata as any)?.policy?.max_budget_usd;
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) {
    throw new Error(`invalid-budget-tier-config: ${tier}`);
  }
  return usd;
}
```

If `CanonStore` lacks `findByKind`, add it as a thin filter on `list()` keyed on `metadata.policy.kind` in the same file or in a small helper; document the addition in the diff.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/substrate/policies/claim-budget-tier.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Canon-audit + commit** (same pattern as Task 1)

```bash
node ../../scripts/git-as.mjs lag-ceo add src/substrate/policies/claim-budget-tier.ts test/substrate/policies/claim-budget-tier.test.ts
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(substrate): add resolveBudgetTier canon-policy reader"
```

---

## Task 3: Reaper config policy readers (cadence, grace, cap, extension, timeout)

**Files:**
- Create: `src/substrate/policies/claim-reaper-config.ts`
- Test: `test/substrate/policies/claim-reaper-config.test.ts`

**Security + correctness considerations:**
- All 8 numeric policies (cadence, grace x 2, cap x 2, extension, timeout, finalize-grace) must fail-closed when their canon policy is missing. A missing policy in production is a deployment error, not a "use default" surface.
- Each reader returns a typed `number`; runtime validates it's a finite positive number.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import {
  resolveReaperCadenceMs,
  resolveRecoveryMaxAttempts,
  resolveRecoveryDeadlineExtensionMs,
  resolveAttestingGraceMs,
  resolvePendingGraceMs,
  resolveVerifierTimeoutMs,
  resolveVerifierFailureCap,
  resolveSessionPostFinalizeGraceMs,
} from '../../../src/substrate/policies/claim-reaper-config.js';
import { makeMemoryHost } from '../../helpers/memory-host.js';

describe('claim-reaper-config readers', () => {
  it('reads each of the 8 numeric policies by kind', async () => {
    const host = await makeMemoryHost();
    const policies: Array<[string, string, number]> = [
      ['pol-claim-reaper-cadence-ms', 'claim-reaper-cadence-ms', 60_000],
      ['pol-claim-recovery-max-attempts', 'claim-recovery-max-attempts', 3],
      ['pol-claim-recovery-deadline-extension-ms', 'claim-recovery-deadline-extension-ms', 1_800_000],
      ['pol-claim-attesting-grace-ms', 'claim-attesting-grace-ms', 300_000],
      ['pol-claim-pending-grace-ms', 'claim-pending-grace-ms', 60_000],
      ['pol-claim-verifier-timeout-ms', 'claim-verifier-timeout-ms', 30_000],
      ['pol-claim-verifier-failure-cap', 'claim-verifier-failure-cap', 3],
      ['pol-claim-session-post-finalize-grace-ms', 'claim-session-post-finalize-grace-ms', 30_000],
    ];
    for (const [id, kind, value] of policies) {
      await host.canonStore.put({
        id, type: 'policy', layer: 'L3', principal_id: 'apex-agent',
        content: kind, confidence: 1.0, created_at: '2026-05-11T00:00:00Z',
        provenance: { kind: 'human-asserted', derived_from: [], source_chain: [] },
        metadata: { policy: { kind, value } },
      } as any);
    }
    expect(await resolveReaperCadenceMs(host)).toBe(60_000);
    expect(await resolveRecoveryMaxAttempts(host)).toBe(3);
    expect(await resolveRecoveryDeadlineExtensionMs(host)).toBe(1_800_000);
    expect(await resolveAttestingGraceMs(host)).toBe(300_000);
    expect(await resolvePendingGraceMs(host)).toBe(60_000);
    expect(await resolveVerifierTimeoutMs(host)).toBe(30_000);
    expect(await resolveVerifierFailureCap(host)).toBe(3);
    expect(await resolveSessionPostFinalizeGraceMs(host)).toBe(30_000);
  });

  it('throws on missing policy', async () => {
    const host = await makeMemoryHost();
    await expect(resolveReaperCadenceMs(host)).rejects.toThrow(/missing-canon-policy/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails.** Expected: `Cannot find module`.

- [ ] **Step 3: Implement** -- eight `resolveX` functions following the same pattern (find policy by kind, validate numeric, fail-closed). Extract a small `readNumericKind(host, kind)` private helper to avoid duplication (per canon `dev-code-duplication-extract-at-n-2`).

- [ ] **Step 4: Run test, pass.**

- [ ] **Step 5: Canon-audit + commit.**

```bash
node ../../scripts/git-as.mjs lag-ceo add src/substrate/policies/claim-reaper-config.ts test/substrate/policies/claim-reaper-config.test.ts
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(substrate): add claim-reaper-config policy readers"
```

---

## Task 4: ClaimVerifier interface + VerifierResult type

**Files:**
- Create: `src/substrate/claim-verifiers/types.ts`
- Test: `test/substrate/claim-verifiers/types.test.ts`

**Security + correctness considerations:**
- `VerifierResult.ok=true` means the verifier observed the work-item in an expected terminal state; this is the load-bearing claim that flips a claim to `complete`. Wrong implementations risk a false-accept (substrate honors a false attestation).
- Verifier handlers MUST be pure with respect to the substrate's AtomStore -- they query ground truth from external/authoritative sources, NOT from atoms whose write could be forged.

- [ ] **Step 1: Write failing test** for the type shape (compile-time, plus an example implementation conforming).

```ts
import { describe, expect, it } from 'vitest';
import type { ClaimVerifier, VerifierResult, VerifierContext } from '../../../src/substrate/claim-verifiers/types.js';

describe('ClaimVerifier shape', () => {
  it('compiles as a function returning a Promise<VerifierResult>', async () => {
    const stub: ClaimVerifier = async (
      _id: string,
      _expected: string[],
      _ctx: VerifierContext,
    ): Promise<VerifierResult> => ({ ok: true, observed_state: 'MERGED' });
    const r = await stub('1', ['MERGED'], {} as VerifierContext);
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Implement** types in `src/substrate/claim-verifiers/types.ts`:

```ts
import type { Host } from '../host.js';

export interface VerifierResult {
  ok: boolean;
  observed_state: string;
}

export interface VerifierContext {
  host: Host;
}

export type ClaimVerifier = (
  identifier: string,
  expectedStates: string[],
  ctx: VerifierContext,
) => Promise<VerifierResult>;
```

- [ ] **Step 3-5: Test passes, canon-audit, commit.**

```bash
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(substrate): add ClaimVerifier interface + VerifierResult type"
```

---

## Task 5: PR verifier handler (GitHub API)

**Files:**
- Create: `src/substrate/claim-verifiers/pr.ts`
- Test: `test/substrate/claim-verifiers/pr.test.ts`

**Security + correctness considerations:**
- Use the existing `gh-as.mjs` bot-identity wrapper for the GitHub API call; never bare `gh` or `fetch` with raw token (per canon `dev-bot-identity-attribution`).
- A 404 response from GitHub means the PR does not exist (claim is malformed); return `ok: false, observed_state: 'NOT_FOUND'`.
- A 5xx response or network error must `throw` (caller's `markClaimComplete` step 9 maps throw to `verifier-error`).
- Compare GitHub's `state` field (`OPEN | CLOSED | MERGED`) against `expectedStates` exactly; case-sensitive.

- [ ] **Step 1: Failing test** with a mocked fetch returning `{ state: 'MERGED' }` for a known PR and `{ state: 'OPEN' }` otherwise.

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { verifyPrTerminal } from '../../../src/substrate/claim-verifiers/pr.js';

describe('verifyPrTerminal', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns ok=true when PR state matches one of expected', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ state: 'MERGED' }),
    });
    const result = await verifyPrTerminal('999', ['MERGED'], { host: {} as any, fetchImpl: mockFetch as any });
    expect(result).toEqual({ ok: true, observed_state: 'MERGED' });
  });

  it('returns ok=false with observed_state when PR is not in expected states', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ state: 'OPEN' }),
    });
    const result = await verifyPrTerminal('999', ['MERGED'], { host: {} as any, fetchImpl: mockFetch as any });
    expect(result).toEqual({ ok: false, observed_state: 'OPEN' });
  });

  it('returns ok=false NOT_FOUND on 404', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 404 });
    const result = await verifyPrTerminal('999', ['MERGED'], { host: {} as any, fetchImpl: mockFetch as any });
    expect(result).toEqual({ ok: false, observed_state: 'NOT_FOUND' });
  });

  it('throws on 5xx', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 });
    await expect(
      verifyPrTerminal('999', ['MERGED'], { host: {} as any, fetchImpl: mockFetch as any }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run, FAIL.**

- [ ] **Step 3: Implement** `src/substrate/claim-verifiers/pr.ts`. Take `fetchImpl` as an injected dependency (default: a function that shells out to `gh-as.mjs lag-ceo api`). Returns `{ ok, observed_state }` or throws on 5xx.

- [ ] **Step 4: Pass.**

- [ ] **Step 5: Canon-audit** (with spec Section 11 threat model: "Compromised sub-agent attests 'complete' with falsified observed state -- verifier MUST query authoritative source").

- [ ] **Step 6: Commit.**

```bash
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(substrate): add PR verifier (GitHub API via gh-as)"
```

---

## Task 6: Plan verifier handler (AtomStore lookup)

**Files:**
- Create: `src/substrate/claim-verifiers/plan.ts`
- Test: `test/substrate/claim-verifiers/plan.test.ts`

**Security + correctness considerations:**
- Plan atoms live in AtomStore; the plan-state lookup is `host.atomStore.get(identifier)?.plan_state`.
- Missing plan returns `ok: false, observed_state: 'NOT_FOUND'`.
- AtomStore read errors `throw`.

- [ ] **Steps 1-5:** Same TDD shape as Task 5. Test against `host.atomStore.get` mocks returning plans with various plan_state values.

```bash
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(substrate): add plan verifier (AtomStore lookup)"
```

---

## Task 7: Task verifier handler (TaskList lookup)

**Files:**
- Create: `src/substrate/claim-verifiers/task.ts`
- Test: `test/substrate/claim-verifiers/task.test.ts`

**Security + correctness considerations:**
- LAG's TaskList is read via `host.taskList.get(id)` (existing seam from prior PRs); returns `{ status }`.
- Status comparison is case-sensitive against `expectedStates` (typically `['completed']`).

- [ ] **Steps 1-5:** TDD with TaskList mock.

```bash
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(substrate): add task verifier (TaskList lookup)"
```

---

## Task 8: Research-atom verifier handler

**Files:**
- Create: `src/substrate/claim-verifiers/research-atom.ts`
- Test: `test/substrate/claim-verifiers/research-atom.test.ts`

**Security + correctness considerations:**
- Research-atom verifier checks `host.atomStore.get(atomId)?.metadata?.research?.status` against expected states (default: `['published']`).
- Generic atom lookup; reuses the same `NOT_FOUND` semantic.

- [ ] **Steps 1-5:** TDD with AtomStore mock.

```bash
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(substrate): add research-atom verifier"
```

---

## Task 9: Verifier registry + dispatcher

**Files:**
- Create: `src/substrate/claim-verifiers/index.ts`
- Test: `test/substrate/claim-verifiers/index.test.ts`

**Security + correctness considerations:**
- Registry is a `Map<string, ClaimVerifier>` keyed on `terminal_kind`. Unknown kind throws `unknown-terminal-kind`.
- Dispatcher wraps the verifier call in `Promise.race` against a configurable timeout (the timeout itself is read at the contract layer in Task 11; the dispatcher just provides the entry point).
- Adding a new kind is a 1-line registry edit (per spec Section 5 "Adding a new terminal kind").

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { verifierRegistry, dispatchVerifier } from '../../../src/substrate/claim-verifiers/index.js';

describe('verifier registry', () => {
  it('exposes the four shipping verifiers', () => {
    expect(verifierRegistry.has('pr')).toBe(true);
    expect(verifierRegistry.has('plan')).toBe(true);
    expect(verifierRegistry.has('task')).toBe(true);
    expect(verifierRegistry.has('research-atom')).toBe(true);
  });
  it('throws unknown-terminal-kind for an unregistered kind', async () => {
    await expect(
      dispatchVerifier('terraform-apply', 'id', ['ok'], {} as any),
    ).rejects.toThrow(/unknown-terminal-kind/);
  });
});
```

- [ ] **Steps 2-5:** Implement the registry, hand back the four exported handlers. Commit.

```bash
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(substrate): add verifier registry + dispatcher"
```

---

## Task 10: claim-secret-token helpers

**Files:**
- Create: `src/substrate/claim-token.ts`
- Test: `test/substrate/claim-token.test.ts`

**Security + correctness considerations:**
- Token generation: `crypto.randomBytes(32).toString('base64url')` -- 256 bits, URL-safe encoding, no padding.
- Constant-time comparison: use `crypto.timingSafeEqual` after converting strings to Buffers of equal length; reject lengths-mismatch FIRST with `false`.
- Token rotation is a separate `rotateToken` helper that returns a fresh 32-byte token; same generator.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { generateClaimToken, rotateClaimToken, constantTimeEqual } from '../../src/substrate/claim-token.js';

describe('claim-secret-token helpers', () => {
  it('generates a 43+ char base64url token', () => {
    const t = generateClaimToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43,}$/);
  });
  it('rotateClaimToken returns a distinct token', () => {
    const a = generateClaimToken();
    const b = rotateClaimToken();
    expect(a).not.toBe(b);
  });
  it('constantTimeEqual returns true on match, false on mismatch, false on length mismatch', () => {
    const t = generateClaimToken();
    expect(constantTimeEqual(t, t)).toBe(true);
    expect(constantTimeEqual(t, generateClaimToken())).toBe(false);
    expect(constantTimeEqual(t, t.slice(0, -1))).toBe(false);
  });
});
```

- [ ] **Step 2: FAIL.** **Step 3: Implement** using `crypto.randomBytes` and `crypto.timingSafeEqual`. **Step 4: PASS.** **Step 5: Canon-audit** (with spec Section 11 threat-model rows on token forgery). **Step 6: Commit.**

```bash
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(substrate): add claim-secret-token generate/rotate/compare helpers"
```

---

## Task 11: dispatchSubAgent (validation gates + atom write + adapter invoke)

**Files:**
- Create: `src/substrate/claim-contract.ts` (initial -- only `dispatchSubAgent` in this task; `markClaimComplete` in Task 12)
- Test: `test/substrate/claim-contract.test.ts` (initial -- `describe('dispatchSubAgent')`)

**Security + correctness considerations:**
- STOP check at top of function (per spec Section 10): if `.lag/STOP` active, throw `stop-sentinel-active`. No atom write.
- Caller-identity check: `caller_principal_id` must resolve in `host.principalStore`. Throw `unknown-caller`.
- Verifier-kind check: `brief.expected_terminal.kind` must have a registered verifier.
- Deadline future-dated: `parseISO(brief.deadline_ts) > host.clock.now()`. Throw `deadline-already-past`.
- Budget tier resolution: via Task 2's `resolveBudgetTier`. Throw `unknown-budget-tier` on miss.
- Prompt size: `> 16_384` chars spills to BlobStore via `host.blobStore.put`. Token is generated via Task 10 helpers. The work-claim atom is written first (state=`pending`), then the adapter is invoked, then claim_state is flipped to `executing` via atomic-version-checked `put`.
- All atom writes use `provenance.kind: 'machine-dispatched'`. The work-claim atom's `provenance.derived_from` is `[parent_claim_id ?? caller_seed_intent_id]` (caller passes a `seed_intent_id` via DispatchSubAgentInput; defaults to the caller's last operator-intent atom in the call site). `provenance.source_chain` is inherited from the caller per existing atom-write pattern. Every subsequent attestation atom carries `provenance.derived_from: [claim_id]`.

- [ ] **Step 1: Write the failing test** covering all 6 pre-dispatch gates + the happy path.

```ts
describe('dispatchSubAgent', () => {
  it('throws stop-sentinel-active when .lag/STOP is set', async () => { /* ... */ });
  it('throws unknown-caller when caller_principal_id does not resolve', async () => { /* ... */ });
  it('throws unknown-terminal-kind when verifier is not registered', async () => { /* ... */ });
  it('throws deadline-already-past when deadline_ts is in the past', async () => { /* ... */ });
  it('throws unknown-budget-tier when canon policy is missing', async () => { /* ... */ });
  it('spills prompt > 16 KB to BlobStore and stores BlobRef', async () => { /* ... */ });
  it('writes work-claim atom with state pending then transitions to executing', async () => { /* ... */ });
  it('returns claim_id + claim_secret_token + claim_handle', async () => { /* ... */ });
});
```

- [ ] **Step 2: Run, FAIL.**

- [ ] **Step 3: Implement** `dispatchSubAgent` in `src/substrate/claim-contract.ts` per spec Section 6.

- [ ] **Step 4: Run, PASS** (8 tests).

- [ ] **Step 5: Canon-audit** with spec Section 11 threat model (focus on past-deadline + caller-identity + budget-tier rows).

- [ ] **Step 6: Commit.**

```bash
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(substrate): add dispatchSubAgent (validation gates + atom write + adapter invoke)"
```

---

## Task 12: markClaimComplete (validation gates + verifier dispatch)

**Files:**
- Modify: `src/substrate/claim-contract.ts` (add `markClaimComplete`)
- Test: `test/substrate/claim-contract.test.ts` (add `describe('markClaimComplete')`)

**Security + correctness considerations:**

9 validation gates in this exact order per spec Section 6 step 9 (subagent MUST NOT reorder or skip):

1. **STOP check.** `.lag/STOP` active? Write `claim-attestation-rejected` with reason `stop-sentinel`; return `{ accepted: false, reason: "stop-sentinel" }`. Audit trail captures attempts during STOP.
2. **Claim lookup.** AtomStore.get(claim_id) returns null? `claim-not-found`.
3. **State guard.** `claim.metadata.work_claim.claim_state` not in `{executing, attesting}`? If `complete` or `abandoned` → write `claim-attestation-rejected` with reason `claim-already-terminal` AND send `principal-misbehavior` actor-message via `host.notifier.telegraph`.
4. **Token match.** Use `crypto.timingSafeEqual` after converting both tokens to Buffers of equal length; reject length-mismatch FIRST with `false` (no throw). Mismatch → `claim-attestation-rejected` reason `token-mismatch`.
5. **Principal match.** `caller_principal_id !== claim.metadata.work_claim.dispatched_principal_id`? `claim-attestation-rejected` reason `principal-mismatch`.
6. **Identifier match.** `attestation.terminal_identifier !== claim.metadata.work_claim.brief.expected_terminal.identifier`? `claim-attestation-rejected` reason `identifier-mismatch`.
7. **Kind match.** `attestation.terminal_kind !== claim.metadata.work_claim.brief.expected_terminal.kind`? `claim-attestation-rejected` reason `kind-mismatch`.
8. **Transition to attesting.** Atomic-version-checked put: claim_state -> `attesting`.
9. **Verifier dispatch.** `Promise.race(verifier(...), timeout(pol-claim-verifier-timeout-ms))`:
   - ok=true: `claim-attestation-accepted` + flip state `complete` + reset `verifier_failure_count` to 0 in same atomic put.
   - ok=false: `claim-attestation-rejected` reason `ground-truth-mismatch`; state stays `attesting`; set `last_attestation_rejected_at`; `verifier_failure_count` NOT incremented.
   - throw: `claim-attestation-rejected` reason `verifier-error`; `verifier_failure_count++`; if `>= pol-claim-verifier-failure-cap` flip state to `stalled` directly.
   - timeout: same as throw but reason `verifier-timeout`.

Every rejection writes a `claim-attestation-rejected` atom with `provenance.derived_from: [claim_id]`.
- On `ok: true`, the same atomic put writes `claim-attestation-accepted`, flips state to `complete`, AND resets `verifier_failure_count` to 0 (per spec v4 fix).
- On `ok: false` (ground-truth-mismatch), state stays `attesting`, `last_attestation_rejected_at` is set, `verifier_failure_count` is NOT incremented (mismatch is signal, not infrastructure failure).
- On throw/timeout, state stays `attesting`, `last_attestation_rejected_at` is set, `verifier_failure_count++`. If count >= cap, flip state straight to `stalled`.
- Every rejection writes a `claim-attestation-rejected` atom with `provenance.derived_from: [claim_id]`.
- Post-terminal attest writes `claim-attestation-rejected` AND sends `principal-misbehavior` actor-message via `host.notifier`.

- [ ] **Step 1: Write failing tests** covering each of the 10 rejection reasons + happy path + post-terminal misbehavior path. Include the explicit Notifier assertion:

```ts
it('rejects post-terminal attest AND fires principal-misbehavior actor-message', async () => {
  // ... setup: claim already complete
  const notifierSpy = vi.spyOn(host.notifier, 'telegraph');
  const result = await markClaimComplete({ claim_id, claim_secret_token, caller_principal_id, attestation }, host);
  expect(result).toEqual({ accepted: false, reason: 'claim-already-terminal' });
  expect(notifierSpy).toHaveBeenCalledWith(expect.objectContaining({
    kind: 'principal-misbehavior',
    payload: expect.objectContaining({ claim_id, caller_principal_id }),
  }));
});

it('writes claim-attestation-rejected with provenance.derived_from=[claim_id] on every rejection path', async () => {
  // ... run each of the 10 rejection paths, assert atom written with chain
  const rejections = await host.atomStore.find({ type: 'claim-attestation-rejected' });
  for (const atom of rejections) {
    expect(atom.provenance.derived_from).toContain(claim_id);
  }
});
```

- [ ] **Steps 2-6:** TDD cycle + canon-audit with full spec Section 11 threat model + commit.

```bash
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(substrate): add markClaimComplete (9 validation gates + verifier dispatch)"
```

---

## Task 13: Contract surface brief prepending

**Files:**
- Modify: `src/substrate/claim-contract.ts` (add `buildWorkClaimContextPreamble`)
- Test: `test/substrate/claim-contract.test.ts` (add `describe('contract surface')`)

**Security + correctness considerations:**
- Preamble carries `claim_secret_token` in plaintext to the sub-agent. The sub-agent's redactor (Task 16) strips it from any persisted agent-turn atom.
- Preamble shape is the spec Section 6 literal text; agents are instructed not to paraphrase.

- [ ] **Steps 1-6:** TDD + canon-audit + commit.

```bash
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(substrate): add buildWorkClaimContextPreamble"
```

---

## Task 14: detectStalledClaims (Phase A of reaper)

**Files:**
- Create: `src/runtime/loop/claim-reaper.ts` (initial -- only `detectStalledClaims` in this task)
- Test: `test/runtime/loop/claim-reaper.test.ts`

**Security + correctness considerations:**
- Phase A is read-mostly: it queries open claims and writes only `claim-stalled` + atomic-version-checked transition to `stalled`. No adapter dispatch.
- Stall conditions are the 5 enumerated in spec Section 7 Phase A. Each is a pure predicate against the claim's metadata + canon-policy.
- Atomic-version-check failure on `put` is a no-op (another reaper handled it); not an error.

- [ ] **Step 1: Failing test** covering each of the 5 stall conditions + the session-finalize debounce + deadline-passed + verifier-failure-cap. Explicit edge cases for the debounce:

```ts
it('does NOT flag executing claim stalled when latest_session_finalized_at is null (no session has finalized yet)', async () => {
  // claim with all sessions still in-flight -> not stalled
});
it('does NOT flag executing claim stalled when latest_session_finalized_at is 10s ago (within 30s grace)', async () => { });
it('DOES flag executing claim stalled when latest_session_finalized_at is 60s ago (past grace)', async () => { });
```

- [ ] **Steps 2-6:** TDD + canon-audit + commit.

```bash
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(substrate): add detectStalledClaims (Phase A of claim reaper)"
```

---

## Task 15: drainStalledQueue + recoverStalledClaim (Phase B)

**Files:**
- Modify: `src/runtime/loop/claim-reaper.ts` (add `drainStalledQueue` + `recoverStalledClaim`)
- Test: `test/runtime/loop/claim-reaper.test.ts` (add `describe('Phase B')`)

**Security + correctness considerations:**
- Recovery decision tree: cap check first, then resume (attempts=0 + session exists), then fresh respawn fallback. After cap, escalate via Notifier + flip claim to `abandoned`.
- Atomic recovery-step put MUST: increment recovery_attempts, bump budget_tier, rotate `claim_secret_token` (per spec v3 fix), extend `deadline_ts` (per spec v3 fix), reset `verifier_failure_count` to 0, flip state to `executing`. ALL in one optimistic-version-checked `put`. Concurrent reaper sees version-conflict and skips.
- Resume path threads the NEW token via a `RECOVERY UPDATE` preamble injected through `ResumeAuthorAgentLoopAdapter.preamble?` (per spec v4 fix).
- Pending-state stall (session_atom_ids empty) skips resume; fresh respawn only.

- [ ] **Step 1: Failing test** covering each of the 4 recovery paths (resume happy, resume-fallback-to-fresh, fresh, escalation-at-N=3) + pending-state stall + token rotation + deadline extension + concurrent-reaper race.

- [ ] **Steps 2-6:** TDD + canon-audit (with spec Section 11 row 2: "Zombie sub-agent from prior recovery attempt") + commit.

```bash
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(substrate): add drainStalledQueue + recoverStalledClaim (Phase B + tiered recovery)"
```

---

## Task 16: runClaimReaperTick orchestration + STOP integration

**Files:**
- Modify: `src/runtime/loop/claim-reaper.ts` (add `runClaimReaperTick`)
- Test: `test/runtime/loop/claim-reaper.test.ts` (add `describe('runClaimReaperTick')`)

**Security + correctness considerations:**
- STOP check at the top of tick: if active, return `{ halted: true }` without scanning. In-flight recovery completes its atom writes; no new recovery dispatches.
- Phase A and Phase B both run every tick, decoupled (Phase B re-queries `state='stalled'` so it can pick up Phase A's transitions in the same tick OR a future tick).

- [ ] **Steps 1-6:** TDD + canon-audit + commit.

```bash
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(substrate): add runClaimReaperTick orchestration + STOP integration"
```

---

## Task 17: PreToolUse hook to enforce substrate-only claim-lifecycle writes

**Files:**
- Create: `.claude/hooks/enforce-claim-atom-writers.mjs`
- Test: `test/hooks/enforce-claim-atom-writers.test.ts`

**Security + correctness considerations:**
- Hook intercepts `AtomStore.put` calls at PreToolUse time per canon `dev-attribution-hooks-cover-all-tool-paths`.
- Allowlist: `apex-agent` (substrate principal). Reject all other principals attempting to write `claim-attestation-*`, `claim-stalled`, or `claim-escalated` atoms.
- Reject with a clear diagnostic so the operator sees the bypass attempt in the activity feed.
- Per spec Section 11 row 11: this is the primary gate against the routine sub-agent bypass; in-process forgery from a compromised contract module is a Tier 1 compromise outside this spec's threat boundary (mitigated by STOP + medium-tier kill switch).

- [ ] **Step 1: Failing test**

```ts
describe('enforce-claim-atom-writers PreToolUse hook', () => {
  it('allows apex-agent to write claim-attestation-accepted', async () => { /* ... */ });
  it('rejects code-author writing claim-attestation-accepted', async () => { /* ... */ });
  it('rejects code-author writing claim-stalled', async () => { /* ... */ });
  it('rejects cto-actor writing claim-escalated', async () => { /* ... */ });
  it('allows code-author writing other atom types (e.g. plan)', async () => { /* ... */ });
});
```

- [ ] **Steps 2-6:** TDD + canon-audit (spec Section 11 row 11) + commit.

```bash
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(hooks): enforce substrate-only writes for claim-lifecycle atoms"
```

---

## Task 18: Redactor pattern for claim_secret_token

**Files:**
- Modify: `src/redactors/default-patterns.ts` (add `CLAIM_SECRET_TOKEN_PATTERN`)
- Test: `test/redactors/claim-secret-token.test.ts`

**Security + correctness considerations:**
- Pattern matches both `claim_secret_token:\s*[A-Za-z0-9_-]{43,}` (labeled form) AND a standalone 43+ char base64url string in `llm_input` / `llm_output` / tool-call args.
- Trade-off: standalone-string redaction will false-positive on SHA-256 hashes, JWT signatures, git commit SHAs in some encodings. Acceptable per spec Section 11 (token leak is unrecoverable; false-positive redaction of legitimate strings is recoverable).
- Redaction replaces matched text with `[REDACTED:CLAIM_TOKEN]`.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { redactDefault, redactAgentTurnAtom } from '../../src/redactors/default-patterns.js';

describe('CLAIM_SECRET_TOKEN_PATTERN', () => {
  it('strips labeled tokens', () => {
    const token = 'A'.repeat(43);
    const input = `before claim_secret_token: ${token} after`;
    expect(redactDefault(input)).toContain('[REDACTED:CLAIM_TOKEN]');
    expect(redactDefault(input)).not.toContain(token);
  });
  it('strips standalone 43+ char base64url strings', () => {
    const token = 'A'.repeat(43);
    expect(redactDefault(`stray ${token} loose`)).toContain('[REDACTED:CLAIM_TOKEN]');
  });
  it('does not redact strings shorter than 43 chars', () => {
    const short = 'A'.repeat(42);
    expect(redactDefault(short)).toBe(short);
  });
  it('strips token from agent-turn atom llm_input/llm_output/tool_calls', () => {
    const token = 'B'.repeat(43);
    const atom = {
      type: 'agent-turn',
      metadata: {
        agent_turn: {
          llm_input: `here is the token ${token}`,
          llm_output: `received claim_secret_token: ${token}`,
          tool_calls: [{ name: 'echo', args: { msg: token } }],
        },
      },
    };
    const redacted = redactAgentTurnAtom(atom);
    expect(redacted.metadata.agent_turn.llm_input).not.toContain(token);
    expect(redacted.metadata.agent_turn.llm_output).not.toContain(token);
    expect(JSON.stringify(redacted.metadata.agent_turn.tool_calls)).not.toContain(token);
  });
  it('documents the false-positive trade: SHA-256 hex (64 chars) and JWT signatures are redacted', () => {
    const sha256 = 'a'.repeat(64);
    expect(redactDefault(sha256)).toContain('[REDACTED:CLAIM_TOKEN]');
    // acceptable trade per spec Section 11; this test exists to document the choice, not to celebrate it.
  });
});
```

- [ ] **Steps 2-6:** TDD + canon-audit + commit.

```bash
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(redactors): add claim_secret_token pattern to default set"
```

---

## Task 19: Eleven canon policy atoms + bootstrap script (PR1 set; pol-loop-pass-claim-reaper-default deferred to PR2)

**Files:**
- Create: `bootstrap/canon/pol-claim-budget-tier-default.json`
- Create: `bootstrap/canon/pol-claim-budget-tier-raised.json`
- Create: `bootstrap/canon/pol-claim-budget-tier-max.json`
- Create: `bootstrap/canon/pol-claim-reaper-cadence-ms.json`
- Create: `bootstrap/canon/pol-claim-recovery-max-attempts.json`
- Create: `bootstrap/canon/pol-claim-recovery-deadline-extension-ms.json`
- Create: `bootstrap/canon/pol-claim-attesting-grace-ms.json`
- Create: `bootstrap/canon/pol-claim-pending-grace-ms.json`
- Create: `bootstrap/canon/pol-claim-verifier-timeout-ms.json`
- Create: `bootstrap/canon/pol-claim-verifier-failure-cap.json`
- Create: `bootstrap/canon/pol-claim-session-post-finalize-grace-ms.json`
- Create: `bootstrap/bootstrap-claim-contract-canon.mjs`
- Test: `test/bootstrap/claim-contract-canon.test.mjs`

Note: PR1 ships 11 atoms total = 3 budget-tier atoms + 8 numeric-config atoms. The 12th atom (`pol-loop-pass-claim-reaper-default.json`) is deferred to PR2 per spec Section 13 because it gates LoopRunner wiring which is not part of PR1.

**Security + correctness considerations:**
- Each atom's `principal_id: 'apex-agent'`, `layer: 'L3'`, `confidence: 1.0`.
- `provenance.kind: 'human-asserted'` since the operator's act of merging PR1 IS the human-assertion.
- Bootstrap script is idempotent: re-running on a deployment that already has the atoms is a no-op (per existing bootstrap patterns).
- Values match spec Section 9 defaults exactly: $2 / $5 / $10 for budget; 60_000 / 3 / 1_800_000 / 300_000 / 60_000 / 30_000 / 3 / 30_000 for the numeric policies.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { execSync } from 'child_process';
import { existsSync } from 'fs';

describe('bootstrap-claim-contract-canon', () => {
  it('writes 11 policy atoms with expected defaults', () => {
    execSync('node bootstrap/bootstrap-claim-contract-canon.mjs --dry-run', { stdio: 'inherit' });
    const expected = [
      'bootstrap/canon/pol-claim-budget-tier-default.json',
      'bootstrap/canon/pol-claim-budget-tier-raised.json',
      'bootstrap/canon/pol-claim-budget-tier-max.json',
      'bootstrap/canon/pol-claim-reaper-cadence-ms.json',
      'bootstrap/canon/pol-claim-recovery-max-attempts.json',
      'bootstrap/canon/pol-claim-recovery-deadline-extension-ms.json',
      'bootstrap/canon/pol-claim-attesting-grace-ms.json',
      'bootstrap/canon/pol-claim-pending-grace-ms.json',
      'bootstrap/canon/pol-claim-verifier-timeout-ms.json',
      'bootstrap/canon/pol-claim-verifier-failure-cap.json',
      'bootstrap/canon/pol-claim-session-post-finalize-grace-ms.json',
    ];
    for (const path of expected) {
      expect(existsSync(path)).toBe(true);
    }
  });
});
```

- [ ] **Steps 2-6:** Write atoms with the exact spec defaults. Bootstrap script. Test passes. Canon-audit + commit. Add idempotency test:

```ts
it('is idempotent: running bootstrap twice produces no version bump on second run', async () => {
  await execSync('node bootstrap/bootstrap-claim-contract-canon.mjs');
  const firstVersions = await readAtomVersions();
  await execSync('node bootstrap/bootstrap-claim-contract-canon.mjs');
  const secondVersions = await readAtomVersions();
  expect(secondVersions).toEqual(firstVersions);
});
```

```bash
node ../../scripts/git-as.mjs lag-ceo add bootstrap/canon/pol-claim-*.json bootstrap/bootstrap-claim-contract-canon.mjs test/bootstrap/claim-contract-canon.test.mjs
node ../../scripts/git-as.mjs lag-ceo commit -m "feat(canon): seed 12 claim-contract policy atoms + bootstrap script"
```

---

## Task 20: Real-PR fixture e2e test

**Files:**
- Modify: `test/fixtures/github-mock.ts` (extend if needed)
- Create: `test/e2e/claim-contract-e2e.test.ts`

**Security + correctness considerations:**
- E2E covers the full attest cycle: `dispatchSubAgent` → simulated agent loop (skipped, we just call `markClaimComplete` directly) → verifier hits the fake GitHub fixture → claim flips to `complete`.
- Also covers the ground-truth-mismatch path: fixture returns `OPEN`, attestation rejected with `ground-truth-mismatch`, claim stays `attesting`.
- Validates the full atom chain landed: work-claim + claim-attestation-accepted (or -rejected) + provenance.derived_from linked.

- [ ] **Step 1: Failing test** with the e2e scenarios; assert full atom chain landed:

```ts
it('end-to-end: dispatch -> attest accept -> complete', async () => {
  const { claim_id, claim_secret_token } = await dispatchSubAgent(...);
  await markClaimComplete({ claim_id, claim_secret_token, caller_principal_id: 'code-author', attestation: { terminal_kind: 'pr', terminal_identifier: '999', observed_state: 'MERGED' } }, host);
  const claim = await host.atomStore.get(claim_id);
  expect(claim.metadata.work_claim.claim_state).toBe('complete');
  const acceptedAtom = (await host.atomStore.find({ type: 'claim-attestation-accepted' }))[0];
  expect(acceptedAtom.provenance.derived_from).toContain(claim_id);
});
it('end-to-end: dispatch -> attest mismatch -> stays attesting', async () => {
  // fixture returns OPEN; assert rejected atom + claim still attesting
});
```

- [ ] **Steps 2-6:** TDD (test exists; just runs against the now-complete substrate from tasks 1-19). Canon-audit + commit.

```bash
node ../../scripts/git-as.mjs lag-ceo commit -m "test(substrate): add real-PR fixture e2e for claim contract"
```

---

## Task 21: Pre-push validation + open PR

**Files:**
- No new files; validation gate only.

**Security + correctness considerations:**
- Final integration check across all changes.
- cr-precheck must report 0 critical / 0 major before push.
- LAG-auditor + canon-compliance auditor on the full PR diff (not just the last task).

- [ ] **Step 1: Typecheck**

```bash
npm run typecheck
```
Expected: 0 errors.

- [ ] **Step 2: Full test run**

```bash
npm run test
```
Expected: all tests pass; total count >= 50 new tests added in this PR.

- [ ] **Step 3: Pre-push grep checklist** (per `feedback_pre_push_grep_checklist`)

```bash
git diff origin/main...HEAD | grep -P '\x{2014}' && echo "EM DASH FOUND" || echo "ok"
git diff origin/main...HEAD -- 'src/**' | grep -E 'design/|adr-|inv-|dev-|pol-' && echo "CANON ID IN SRC" || echo "ok"
git diff origin/main...HEAD | grep -iE 'co-authored-by:.*(claude|anthropic)' && echo "CLAUDE ATTRIBUTION" || echo "ok"
```

Each: empty (echo "ok"). If any prints a finding, fix it before continuing.

- [ ] **Step 4: cr-precheck**

```bash
node scripts/cr-precheck.mjs
```
Expected: 0 critical, 0 major findings. Address any before push.

- [ ] **Step 5: Final canon-audit on the full PR diff**

Dispatch canon-compliance auditor with the full `git diff origin/main...HEAD` as context. Verify substrate purity across all 21 task commits.

- [ ] **Step 6: Push + open PR**

```bash
node ../../scripts/git-as.mjs lag-ceo push origin feat/impl-claim-contract-substrate
node ../../scripts/gh-as.mjs lag-ceo pr create --base main --head feat/impl-claim-contract-substrate \
  --title "feat(substrate): work-claim contract + reaper + verifiers (PR1 of zero-failure substrate)" \
  --body "$(cat <<'EOF'
## Summary

Implements PR1 of the zero-failure sub-agent substrate per spec `docs/superpowers/specs/2026-05-10-zero-failure-sub-agent-substrate.md` (merged in PR #391).

Ships the foundational primitives:
- `work-claim` atom type + lifecycle states + 4 attestation/lifecycle atom types
- `dispatchSubAgent` + `markClaimComplete` with token-and-principal binding
- 4 reference verifier handlers (pr, plan, task, research-atom) + registry
- Two-phase claim reaper (detect + recover) with bounded tiered recovery
- 12 canon policy atoms with spec-mandated defaults
- PreToolUse hook + redactor pattern for substrate purity

NOT YET WIRED into LoopRunner; that is PR2. Legacy direct-dispatch paths continue to work.

## Test plan

- [x] 50+ new tests covering lifecycle, attestation, recovery, STOP, concurrency
- [x] Real-PR fixture e2e
- [x] cr-precheck 0/0 before push
- [x] LAG-auditor + canon-compliance auditor approved
EOF
)"
```

- [ ] **Step 7: Drive to merge** per canon `dev-sub-agent-pr-driver-responsibility`. Address any CR findings via fix-commits; resolve outdated threads via `node scripts/resolve-outdated-threads.mjs <PR>` after each fix-push; trigger CR re-review via `node scripts/cr-trigger.mjs <PR>` if `LAG_OPS_PAT` is set, else empty-commit nudge. Merge via `node scripts/gh-as.mjs lag-ceo pr merge <PR> --squash --delete-branch` once `mergeStateStatus=CLEAN` AND `reviewDecision=APPROVED`.

---

## Risk register

- **AtomStore version-check semantics** (per PR #197 fix): all transitions on `work-claim` atoms MUST use the optimistic version-check API; test coverage for concurrent-reaper races is the load-bearing verification. If `AtomStore.put` doesn't expose version checks at the API surface today, fix it as a prerequisite sub-task before Task 14.
- **CanonStore.findByKind**: if not present today, add as a thin helper in Task 2. Cite the addition in the PR body.
- **TaskList host seam**: if `host.taskList` is not a standard sub-interface today, Task 7's task verifier may need to use a different lookup mechanism; the spec calls TaskList canonical, so verify before implementation. Fall back to a `host.atomStore.get('task-' + id)` shape if TaskList is not a Host sub-interface.
- **Redactor false-positive on SHA-256**: the standalone 43+ char regex matches SHA-256 hex (64 chars) and JWT signatures. Acceptable trade per spec, but tests should explicitly assert one false-positive case to document the trade.
- **PreToolUse hook lookup**: the hook reads `principal_id` from the calling context. If the hook context doesn't expose principal at PreToolUse time, fall back to an `AtomStore.put` middleware in `claim-contract.ts` itself that calls the substrate's authorized writer path.

## Acceptance criteria (mirror of spec Section 16)

A passing PR1 must satisfy ALL of:

- All 21 tasks committed individually
- `npm run typecheck` clean
- `npm run test` clean with >= 50 new tests
- Pre-push grep checklist clean
- `node scripts/cr-precheck.mjs` reports 0 critical / 0 major
- Real-PR fixture e2e present and passing
- LAG-auditor + canon-compliance auditor approve the full diff
- CR-clean after one round (target; up to 2 rounds acceptable)
- PR title is Conventional Commits per canon `dev-pr-title-conventional-commits`
- No em dashes anywhere in the diff
- No principal names hardcoded in src/ (substrate purity)
- No canon ids in src/ JSDoc (doc-prose OK)
