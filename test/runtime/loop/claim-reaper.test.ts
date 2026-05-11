/**
 * Plan Tasks 14, 15, 16: claim reaper substrate tests.
 *
 * Covers the three logical phases of `src/runtime/loop/claim-reaper.ts`:
 *
 *   - Phase A (detectStalledClaims): the five stall predicates in
 *     spec Section 7 -- past deadline, pending grace, executing
 *     session-finalized debounce, attesting grace clock, attesting
 *     verifier-failure cap.
 *   - Phase B (drainStalledQueue + recoverStalledClaim): the cap-
 *     exceeded escalation path (claim-escalated atom + claim-stuck
 *     Notifier event + abandoned terminal), the atomic recovery-step
 *     (recovery_attempts increment + budget_tier ladder + token rotation
 *     + deadline extension + verifier_failure_count reset + state ->
 *     executing), and the dispatch fan-out (pending-state fresh respawn,
 *     first-recovery resume attempt, subsequent fresh respawn).
 *   - `runClaimReaperTick`: the orchestrator that gates both phases
 *     behind a STOP-sentinel check + halts cleanly when active.
 *
 * Tests use the memory host (`createMemoryHost`) so the reaper exercises
 * the substrate's real `AtomStore` semantics without spinning up a real
 * file host. The contract module's preceding behavior (dispatchSubAgent
 * writes a work-claim atom in `executing` state after invoking the
 * adapter once) is mocked by writing the work-claim atom directly via
 * `host.atoms.put` so each test pins the state-of-interest deterministi-
 * cally rather than threading the contract module just to seed the
 * setup.
 */

import { describe, expect, it, vi } from 'vitest';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import {
  detectStalledClaims,
  drainStalledQueue,
  recoverStalledClaim,
  runClaimReaperTick,
} from '../../../src/runtime/loop/claim-reaper.js';
import type {
  AgentLoopAdapter,
  AgentLoopInput,
  AgentLoopResult,
} from '../../../src/substrate/agent-loop.js';
import type {
  Atom,
  AtomId,
  ClaimEscalatedMeta,
  ClaimStalledMeta,
  ClaimState,
  PrincipalId,
  Time,
  WorkClaimMeta,
} from '../../../src/substrate/types.js';

const NOW = '2026-05-11T12:00:00.000Z' as Time;

// Reaper-config policy kinds the reaper reads at tick time. Each test
// seeds the subset the path under exercise needs; missing policies make
// the reader throw `missing-canon-policy`, surfacing config gaps loudly.
const POL_REAPER_CADENCE = 'claim-reaper-cadence-ms';
const POL_RECOVERY_MAX = 'claim-recovery-max-attempts';
const POL_DEADLINE_EXT = 'claim-recovery-deadline-extension-ms';
const POL_ATTESTING_GRACE = 'claim-attesting-grace-ms';
const POL_PENDING_GRACE = 'claim-pending-grace-ms';
const POL_SESSION_GRACE = 'claim-session-post-finalize-grace-ms';
const POL_VERIFIER_CAP = 'claim-verifier-failure-cap';

function mkPolicyAtom(kind: string, value: number, id?: string): Atom {
  return {
    schema_version: 1,
    id: (id ?? `pol-${kind}`) as AtomId,
    content: `reaper-policy ${kind}`,
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { agent_id: 'operator' },
      derived_from: [],
    },
    confidence: 1,
    created_at: NOW,
    last_reinforced_at: NOW,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'verified',
      last_validated_at: null,
    },
    principal_id: 'operator' as PrincipalId,
    taint: 'clean',
    metadata: { policy: { kind, value } },
  };
}

function mkBudgetTierAtom(tier: string, maxUsd: number): Atom {
  return {
    schema_version: 1,
    id: `pol-claim-budget-tier-${tier}` as AtomId,
    content: `budget-tier ${tier}`,
    // Canonical seed shape: type='directive' so the budget-tier resolver's
    // forgery-containment gate accepts it. Mirrors bootstrap policyAtom.
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { agent_id: 'operator' },
      derived_from: [],
    },
    confidence: 1,
    created_at: NOW,
    last_reinforced_at: NOW,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'verified',
      last_validated_at: null,
    },
    principal_id: 'operator' as PrincipalId,
    taint: 'clean',
    metadata: {
      policy: {
        kind: 'claim-budget-tier',
        tier,
        max_budget_usd: maxUsd,
      },
    },
  };
}

/**
 * Seed the full Phase A policy set (5 numeric atoms a stall detection
 * pass reads). Tests that exercise Phase B add the recovery + deadline-
 * extension atoms on top.
 */
async function seedPhaseAPolicies(host: ReturnType<typeof createMemoryHost>): Promise<void> {
  await host.atoms.put(mkPolicyAtom(POL_REAPER_CADENCE, 60_000));
  await host.atoms.put(mkPolicyAtom(POL_PENDING_GRACE, 60_000));
  await host.atoms.put(mkPolicyAtom(POL_SESSION_GRACE, 30_000));
  await host.atoms.put(mkPolicyAtom(POL_ATTESTING_GRACE, 300_000));
  await host.atoms.put(mkPolicyAtom(POL_VERIFIER_CAP, 3));
}

async function seedPhaseBPolicies(host: ReturnType<typeof createMemoryHost>): Promise<void> {
  await host.atoms.put(mkPolicyAtom(POL_RECOVERY_MAX, 3));
  await host.atoms.put(mkPolicyAtom(POL_DEADLINE_EXT, 1_800_000));
  // Budget tier ladder.
  await host.atoms.put(mkBudgetTierAtom('default', 2));
  await host.atoms.put(mkBudgetTierAtom('raised', 5));
  await host.atoms.put(mkBudgetTierAtom('max', 10));
}

async function seedAllPolicies(host: ReturnType<typeof createMemoryHost>): Promise<void> {
  await seedPhaseAPolicies(host);
  await seedPhaseBPolicies(host);
}

async function seedPrincipal(host: ReturnType<typeof createMemoryHost>, id: string): Promise<void> {
  await host.principals.put({
    id: id as PrincipalId,
    name: id,
    role: 'agent',
    permitted_scopes: { read: ['project'], write: ['project'] },
    permitted_layers: { read: ['L0', 'L1', 'L2', 'L3'], write: ['L0'] },
    goals: [],
    constraints: [],
    active: true,
    compromised_at: null,
    signed_by: null,
    created_at: NOW,
  });
}

/**
 * Write a work-claim atom directly so Phase A / Phase B tests pin the
 * state-of-interest without threading the full dispatchSubAgent flow.
 * The shape mirrors what dispatchSubAgent writes on the happy path.
 */
async function putWorkClaim(
  host: ReturnType<typeof createMemoryHost>,
  options: {
    claimId: string;
    claimState: ClaimState;
    createdAt: Time;
    deadline: Time;
    sessionIds?: ReadonlyArray<string>;
    lastAttestationRejectedAt?: Time | null;
    latestSessionFinalizedAt?: Time | null;
    verifierFailureCount?: number;
    recoveryAttempts?: number;
    budgetTier?: string;
    callerPrincipalId?: string;
  },
): Promise<void> {
  const caller = options.callerPrincipalId ?? 'code-author';
  const meta: WorkClaimMeta = {
    claim_id: options.claimId,
    claim_secret_token: 'A'.repeat(43),
    dispatched_principal_id: caller as PrincipalId,
    brief: {
      prompt: 'fix the bug',
      expected_terminal: {
        kind: 'plan',
        identifier: 'plan-target-1',
        terminal_states: ['succeeded'],
      },
      deadline_ts: options.deadline,
    },
    claim_state: options.claimState,
    budget_tier: options.budgetTier ?? 'default',
    recovery_attempts: options.recoveryAttempts ?? 0,
    verifier_failure_count: options.verifierFailureCount ?? 0,
    parent_claim_id: null,
    session_atom_ids: (options.sessionIds ?? []).map(s => s as AtomId),
    last_attestation_rejected_at: options.lastAttestationRejectedAt ?? null,
    latest_session_finalized_at: options.latestSessionFinalizedAt ?? null,
  };
  await host.atoms.put({
    schema_version: 1,
    id: options.claimId as AtomId,
    content: `claim ${options.claimId}`,
    type: 'work-claim',
    layer: 'L0',
    provenance: {
      kind: 'agent-inferred',
      source: { agent_id: caller },
      derived_from: [],
    },
    confidence: 1,
    created_at: options.createdAt,
    last_reinforced_at: options.createdAt,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: caller as PrincipalId,
    taint: 'clean',
    metadata: { work_claim: meta },
  });
}

/**
 * Seed an agent-session atom referenced by `claim.session_atom_ids` so
 * Phase A condition #3 can read its finalized state. The reaper looks at
 * the claim's `latest_session_finalized_at` for the debounce; the session
 * atom itself is referenced for the `every session has terminal_state`
 * check. Test bodies can set the finalized timestamp on the claim
 * directly.
 */
async function putAgentSession(
  host: ReturnType<typeof createMemoryHost>,
  id: string,
  finalized: boolean,
): Promise<void> {
  await host.atoms.put({
    schema_version: 1,
    id: id as AtomId,
    content: `session ${id}`,
    type: 'agent-session',
    layer: 'L0',
    provenance: {
      kind: 'agent-inferred',
      source: { agent_id: 'code-author' },
      derived_from: [],
    },
    confidence: 1,
    created_at: NOW,
    last_reinforced_at: NOW,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: 'code-author' as PrincipalId,
    taint: 'clean',
    metadata: {
      agent_session: {
        terminal_state: finalized ? 'completed' : 'in-flight',
        started_at: NOW,
      },
    },
  });
}

function mkAdapter(): AgentLoopAdapter & { calls: AgentLoopInput[] } {
  const calls: AgentLoopInput[] = [];
  const adapter: AgentLoopAdapter & { calls: AgentLoopInput[] } = {
    calls,
    capabilities: {
      tracks_cost: false,
      supports_signal: false,
      classify_failure: () => 'structural' as const,
    },
    async run(input: AgentLoopInput): Promise<AgentLoopResult> {
      calls.push(input);
      return {
        kind: 'completed',
        sessionAtomId: ('agent-session-recovery-' + calls.length) as AtomId,
        turnAtomIds: [],
      };
    },
  };
  return adapter;
}

// ---------------------------------------------------------------------------
// Phase A: detectStalledClaims
// ---------------------------------------------------------------------------

describe('detectStalledClaims (Phase A)', () => {
  it('flags claims whose deadline has passed regardless of state', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedPhaseAPolicies(host);
    await putWorkClaim(host, {
      claimId: 'wc-past-deadline',
      claimState: 'executing',
      createdAt: '2026-05-11T11:00:00.000Z' as Time,
      // Deadline already past as of NOW.
      deadline: '2026-05-11T11:30:00.000Z' as Time,
    });
    const stalled = await detectStalledClaims(host);
    expect(stalled.map(a => a.id)).toContain('wc-past-deadline');
    // The claim_state should have been flipped to 'stalled' AND a
    // claim-stalled audit atom should have been written.
    const atom = await host.atoms.get('wc-past-deadline' as AtomId);
    expect((atom!.metadata.work_claim as WorkClaimMeta).claim_state).toBe('stalled');
    const stallAtoms = (await host.atoms.query({ type: ['claim-stalled'] }, 100)).atoms;
    expect(stallAtoms.length).toBeGreaterThan(0);
    const stallMeta = stallAtoms[0]!.metadata.claim_stall as ClaimStalledMeta;
    expect(stallMeta.claim_id).toBe('wc-past-deadline');
    expect(stallMeta.reason).toMatch(/deadline-passed|past-deadline/);
  });

  it('flags pending claims that have exceeded the pending grace window', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedPhaseAPolicies(host);
    // created 5 minutes ago; pending grace is 60s default.
    await putWorkClaim(host, {
      claimId: 'wc-pending-stale',
      claimState: 'pending',
      createdAt: '2026-05-11T11:55:00.000Z' as Time,
      deadline: '2026-05-12T00:00:00.000Z' as Time,
    });
    const stalled = await detectStalledClaims(host);
    expect(stalled.map(a => a.id)).toContain('wc-pending-stale');
    const stallAtoms = (await host.atoms.query({ type: ['claim-stalled'] }, 100)).atoms;
    expect(stallAtoms[0]!.metadata.claim_stall).toMatchObject({
      claim_id: 'wc-pending-stale',
    });
  });

  it('does NOT flag pending claims that are still within the pending grace window', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedPhaseAPolicies(host);
    // created 10s ago; pending grace is 60s default.
    await putWorkClaim(host, {
      claimId: 'wc-pending-fresh',
      claimState: 'pending',
      createdAt: '2026-05-11T11:59:50.000Z' as Time,
      deadline: '2026-05-12T00:00:00.000Z' as Time,
    });
    const stalled = await detectStalledClaims(host);
    expect(stalled.map(a => a.id)).not.toContain('wc-pending-fresh');
  });

  it('does NOT flag executing claim stalled when latest_session_finalized_at is null', async () => {
    // Debounce edge case: no session has finalized yet, so the
    // "session finalized AND past grace" condition cannot trigger.
    const host = createMemoryHost({ clockStart: NOW });
    await seedPhaseAPolicies(host);
    await putAgentSession(host, 'sess-1', false);
    await putWorkClaim(host, {
      claimId: 'wc-no-finalized',
      claimState: 'executing',
      createdAt: '2026-05-11T10:00:00.000Z' as Time,
      deadline: '2026-05-12T00:00:00.000Z' as Time,
      sessionIds: ['sess-1'],
      latestSessionFinalizedAt: null,
    });
    const stalled = await detectStalledClaims(host);
    expect(stalled.map(a => a.id)).not.toContain('wc-no-finalized');
  });

  it('does NOT flag executing claim stalled when latest_session_finalized_at is within the 30s grace', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedPhaseAPolicies(host);
    await putAgentSession(host, 'sess-2', true);
    // finalized 10s ago, well within 30s grace.
    await putWorkClaim(host, {
      claimId: 'wc-recently-finalized',
      claimState: 'executing',
      createdAt: '2026-05-11T10:00:00.000Z' as Time,
      deadline: '2026-05-12T00:00:00.000Z' as Time,
      sessionIds: ['sess-2'],
      latestSessionFinalizedAt: '2026-05-11T11:59:50.000Z' as Time,
    });
    const stalled = await detectStalledClaims(host);
    expect(stalled.map(a => a.id)).not.toContain('wc-recently-finalized');
  });

  it('DOES flag executing claim stalled when latest_session_finalized_at exceeded the 30s grace', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedPhaseAPolicies(host);
    await putAgentSession(host, 'sess-3', true);
    // finalized 60s ago, past the 30s default grace.
    await putWorkClaim(host, {
      claimId: 'wc-finalized-stale',
      claimState: 'executing',
      createdAt: '2026-05-11T10:00:00.000Z' as Time,
      deadline: '2026-05-12T00:00:00.000Z' as Time,
      sessionIds: ['sess-3'],
      latestSessionFinalizedAt: '2026-05-11T11:59:00.000Z' as Time,
    });
    const stalled = await detectStalledClaims(host);
    expect(stalled.map(a => a.id)).toContain('wc-finalized-stale');
  });

  it('flags attesting claims whose last_attestation_rejected_at exceeded the 5 min grace', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedPhaseAPolicies(host);
    // rejected 10 minutes ago; grace is 300s = 5 minutes.
    await putWorkClaim(host, {
      claimId: 'wc-attesting-stale',
      claimState: 'attesting',
      createdAt: '2026-05-11T10:00:00.000Z' as Time,
      deadline: '2026-05-12T00:00:00.000Z' as Time,
      lastAttestationRejectedAt: '2026-05-11T11:50:00.000Z' as Time,
    });
    const stalled = await detectStalledClaims(host);
    expect(stalled.map(a => a.id)).toContain('wc-attesting-stale');
  });

  it('flags attesting claims whose verifier_failure_count is at or above the cap', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedPhaseAPolicies(host);
    await putWorkClaim(host, {
      claimId: 'wc-verifier-cap',
      claimState: 'attesting',
      createdAt: '2026-05-11T10:00:00.000Z' as Time,
      deadline: '2026-05-12T00:00:00.000Z' as Time,
      verifierFailureCount: 3,
    });
    const stalled = await detectStalledClaims(host);
    expect(stalled.map(a => a.id)).toContain('wc-verifier-cap');
    const stallAtoms = (await host.atoms.query({ type: ['claim-stalled'] }, 100)).atoms;
    expect(stallAtoms[0]!.metadata.claim_stall).toMatchObject({
      claim_id: 'wc-verifier-cap',
      verifier_failure_count_at_stall: 3,
    });
  });

  it('does not double-flag a claim that is already in stalled state', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedPhaseAPolicies(host);
    await putWorkClaim(host, {
      claimId: 'wc-already-stalled',
      claimState: 'stalled',
      createdAt: '2026-05-11T10:00:00.000Z' as Time,
      deadline: '2026-05-11T11:30:00.000Z' as Time,
    });
    const stalled = await detectStalledClaims(host);
    expect(stalled.map(a => a.id)).not.toContain('wc-already-stalled');
  });

  it('does not flag terminal claims (complete/abandoned)', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedPhaseAPolicies(host);
    await putWorkClaim(host, {
      claimId: 'wc-complete',
      claimState: 'complete',
      createdAt: '2026-05-11T10:00:00.000Z' as Time,
      deadline: '2026-05-11T11:30:00.000Z' as Time,
    });
    await putWorkClaim(host, {
      claimId: 'wc-abandoned',
      claimState: 'abandoned',
      createdAt: '2026-05-11T10:00:00.000Z' as Time,
      deadline: '2026-05-11T11:30:00.000Z' as Time,
    });
    const stalled = await detectStalledClaims(host);
    const ids = stalled.map(a => a.id);
    expect(ids).not.toContain('wc-complete');
    expect(ids).not.toContain('wc-abandoned');
  });
});

// ---------------------------------------------------------------------------
// Phase B: drainStalledQueue + recoverStalledClaim
// ---------------------------------------------------------------------------

describe('drainStalledQueue + recoverStalledClaim (Phase B)', () => {
  it('escalates and abandons when recovery_attempts >= cap', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedAllPolicies(host);
    await seedPrincipal(host, 'code-author');
    await putWorkClaim(host, {
      claimId: 'wc-cap',
      claimState: 'stalled',
      createdAt: '2026-05-11T10:00:00.000Z' as Time,
      deadline: '2026-05-12T00:00:00.000Z' as Time,
      recoveryAttempts: 3,
    });
    const adapter = mkAdapter();
    const result = await drainStalledQueue(host, {
      stopSentinel: () => false,
      buildAdapter: () => adapter,
    });
    expect(result.escalated).toBe(1);
    expect(result.recovered).toBe(0);
    const atom = await host.atoms.get('wc-cap' as AtomId);
    expect((atom!.metadata.work_claim as WorkClaimMeta).claim_state).toBe('abandoned');
    // Audit + notifier signals.
    const escAtoms = (await host.atoms.query({ type: ['claim-escalated'] }, 100)).atoms;
    expect(escAtoms.length).toBe(1);
    expect((escAtoms[0]!.metadata.claim_escalation as ClaimEscalatedMeta).claim_id).toBe('wc-cap');
    // Adapter must NOT have been invoked on the abandon path.
    expect(adapter.calls.length).toBe(0);
  });

  it('rotates token, increments attempts, bumps tier, extends deadline, resets failure count, flips state on recovery', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedAllPolicies(host);
    await seedPrincipal(host, 'code-author');
    const oldDeadline = '2026-05-11T11:00:00.000Z' as Time;
    await putWorkClaim(host, {
      claimId: 'wc-recover',
      claimState: 'stalled',
      createdAt: '2026-05-11T10:00:00.000Z' as Time,
      deadline: oldDeadline,
      recoveryAttempts: 0,
      verifierFailureCount: 2,
      budgetTier: 'default',
      sessionIds: [],
    });
    const adapter = mkAdapter();
    const before = (await host.atoms.get('wc-recover' as AtomId))!;
    const oldToken = (before.metadata.work_claim as WorkClaimMeta).claim_secret_token;
    const result = await drainStalledQueue(host, {
      stopSentinel: () => false,
      buildAdapter: () => adapter,
    });
    expect(result.recovered).toBe(1);
    expect(result.escalated).toBe(0);
    const after = (await host.atoms.get('wc-recover' as AtomId))!;
    const meta = after.metadata.work_claim as WorkClaimMeta;
    expect(meta.claim_state).toBe('executing');
    expect(meta.recovery_attempts).toBe(1);
    expect(meta.budget_tier).toBe('raised'); // default -> raised
    expect(meta.verifier_failure_count).toBe(0);
    // Token rotated.
    expect(meta.claim_secret_token).not.toBe(oldToken);
    expect(meta.claim_secret_token).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    // Deadline extended to NOW + 30 min (the test extension default).
    expect(Date.parse(meta.brief.deadline_ts)).toBeGreaterThan(Date.parse(oldDeadline));
    expect(Date.parse(meta.brief.deadline_ts)).toBeGreaterThanOrEqual(
      Date.parse(NOW) + 1_800_000,
    );
    // Adapter dispatched.
    expect(adapter.calls.length).toBe(1);
  });

  it('bumps budget_tier per ladder: default->raised->max->max (saturates)', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedAllPolicies(host);
    await seedPrincipal(host, 'code-author');
    // First recovery: raised
    await putWorkClaim(host, {
      claimId: 'wc-tier-1',
      claimState: 'stalled',
      createdAt: '2026-05-11T10:00:00.000Z' as Time,
      deadline: '2026-05-12T00:00:00.000Z' as Time,
      recoveryAttempts: 0,
      budgetTier: 'raised',
    });
    // Second recovery: max
    await putWorkClaim(host, {
      claimId: 'wc-tier-2',
      claimState: 'stalled',
      createdAt: '2026-05-11T10:00:00.000Z' as Time,
      deadline: '2026-05-12T00:00:00.000Z' as Time,
      recoveryAttempts: 0,
      budgetTier: 'max',
    });
    const adapter = mkAdapter();
    await drainStalledQueue(host, {
      stopSentinel: () => false,
      buildAdapter: () => adapter,
    });
    const t1 = (await host.atoms.get('wc-tier-1' as AtomId))!.metadata.work_claim as WorkClaimMeta;
    const t2 = (await host.atoms.get('wc-tier-2' as AtomId))!.metadata.work_claim as WorkClaimMeta;
    expect(t1.budget_tier).toBe('max');
    expect(t2.budget_tier).toBe('max'); // saturates at max
  });

  it('pending-state stall (no sessions) recovers via fresh respawn without attempting resume', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedAllPolicies(host);
    await seedPrincipal(host, 'code-author');
    await putWorkClaim(host, {
      claimId: 'wc-pending-recover',
      claimState: 'stalled',
      createdAt: '2026-05-11T10:00:00.000Z' as Time,
      deadline: '2026-05-12T00:00:00.000Z' as Time,
      recoveryAttempts: 0,
      sessionIds: [],
    });
    const adapter = mkAdapter();
    const resumeAttempts: number[] = [];
    const resumeAdapter: AgentLoopAdapter = {
      capabilities: adapter.capabilities,
      run: async (input: AgentLoopInput) => {
        resumeAttempts.push(1);
        return {
          kind: 'completed',
          sessionAtomId: 'agent-session-resumed' as AtomId,
          turnAtomIds: [],
        };
      },
    };
    const result = await drainStalledQueue(host, {
      stopSentinel: () => false,
      buildAdapter: () => adapter,
      resumeAdapter,
    });
    expect(result.recovered).toBe(1);
    // Resume must NOT be attempted on a pending-state stall (no session
    // history to resume from); fresh adapter is the only path used.
    expect(resumeAttempts.length).toBe(0);
    expect(adapter.calls.length).toBe(1);
  });

  it('first recovery with existing session attempts resume path', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedAllPolicies(host);
    await seedPrincipal(host, 'code-author');
    await putAgentSession(host, 'sess-prior', true);
    await putWorkClaim(host, {
      claimId: 'wc-resume',
      claimState: 'stalled',
      createdAt: '2026-05-11T10:00:00.000Z' as Time,
      deadline: '2026-05-12T00:00:00.000Z' as Time,
      recoveryAttempts: 0,
      sessionIds: ['sess-prior'],
      latestSessionFinalizedAt: '2026-05-11T11:59:00.000Z' as Time,
    });
    const adapter = mkAdapter();
    const resumeCalls: AgentLoopInput[] = [];
    const resumeAdapter: AgentLoopAdapter = {
      capabilities: adapter.capabilities,
      run: async (input: AgentLoopInput) => {
        resumeCalls.push(input);
        return {
          kind: 'completed',
          sessionAtomId: 'agent-session-resumed' as AtomId,
          turnAtomIds: [],
        };
      },
    };
    const result = await drainStalledQueue(host, {
      stopSentinel: () => false,
      buildAdapter: () => adapter,
      resumeAdapter,
    });
    expect(result.recovered).toBe(1);
    // Resume adapter chosen (first recovery + session present).
    expect(resumeCalls.length).toBe(1);
    // The resume invocation must thread the NEW token via the prompt
    // RECOVERY UPDATE preamble so the resumed agent picks it up.
    const promptSeen = resumeCalls[0]!.task.questionPrompt ?? '';
    expect(promptSeen).toMatch(/RECOVERY UPDATE/);
    // The new token is in the recovery preamble.
    const after = (await host.atoms.get('wc-resume' as AtomId))!.metadata.work_claim as WorkClaimMeta;
    expect(promptSeen).toContain(after.claim_secret_token);
  });

  it('second-or-later recovery with session takes fresh respawn (not resume)', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedAllPolicies(host);
    await seedPrincipal(host, 'code-author');
    await putAgentSession(host, 'sess-prior-2', true);
    await putWorkClaim(host, {
      claimId: 'wc-fresh',
      claimState: 'stalled',
      createdAt: '2026-05-11T10:00:00.000Z' as Time,
      deadline: '2026-05-12T00:00:00.000Z' as Time,
      // already recovered once; this is the second recovery so fresh
      // respawn is the path.
      recoveryAttempts: 1,
      sessionIds: ['sess-prior-2'],
      latestSessionFinalizedAt: '2026-05-11T11:59:00.000Z' as Time,
    });
    const adapter = mkAdapter();
    const resumeCalls: AgentLoopInput[] = [];
    const resumeAdapter: AgentLoopAdapter = {
      capabilities: adapter.capabilities,
      run: async (input: AgentLoopInput) => {
        resumeCalls.push(input);
        return {
          kind: 'completed',
          sessionAtomId: 'agent-session-resumed' as AtomId,
          turnAtomIds: [],
        };
      },
    };
    const result = await drainStalledQueue(host, {
      stopSentinel: () => false,
      buildAdapter: () => adapter,
      resumeAdapter,
    });
    expect(result.recovered).toBe(1);
    expect(resumeCalls.length).toBe(0);
    expect(adapter.calls.length).toBe(1);
  });

  it('concurrent reaper: two ticks racing on the same claim only recover once', async () => {
    // Memory adapter has no version field, so we emulate the optimistic
    // version check by checking the claim state right before the put.
    // Both reaper invocations see state='stalled' at scan time. The
    // first invocation transitions; the second invocation re-reads
    // before applying its put and sees state='executing' and skips.
    const host = createMemoryHost({ clockStart: NOW });
    await seedAllPolicies(host);
    await seedPrincipal(host, 'code-author');
    await putWorkClaim(host, {
      claimId: 'wc-race',
      claimState: 'stalled',
      createdAt: '2026-05-11T10:00:00.000Z' as Time,
      deadline: '2026-05-12T00:00:00.000Z' as Time,
      recoveryAttempts: 0,
    });
    const adapterA = mkAdapter();
    const adapterB = mkAdapter();
    // Run two reaper invocations concurrently. The implementation must
    // re-read the claim state immediately before the recovery-step put
    // and skip when the state is no longer 'stalled'.
    const [resA, resB] = await Promise.all([
      drainStalledQueue(host, {
        stopSentinel: () => false,
        buildAdapter: () => adapterA,
      }),
      drainStalledQueue(host, {
        stopSentinel: () => false,
        buildAdapter: () => adapterB,
      }),
    ]);
    const totalRecovered = resA.recovered + resB.recovered;
    const totalAdapterCalls = adapterA.calls.length + adapterB.calls.length;
    // Only one of the two reapers recovered the claim.
    expect(totalRecovered).toBe(1);
    expect(totalAdapterCalls).toBe(1);
    // Claim is in 'executing' state with recovery_attempts == 1.
    const after = (await host.atoms.get('wc-race' as AtomId))!.metadata.work_claim as WorkClaimMeta;
    expect(after.claim_state).toBe('executing');
    expect(after.recovery_attempts).toBe(1);
  });

  it('appends new session id to claim.session_atom_ids after dispatch', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedAllPolicies(host);
    await seedPrincipal(host, 'code-author');
    await putWorkClaim(host, {
      claimId: 'wc-session-append',
      claimState: 'stalled',
      createdAt: '2026-05-11T10:00:00.000Z' as Time,
      deadline: '2026-05-12T00:00:00.000Z' as Time,
      recoveryAttempts: 0,
      sessionIds: [],
    });
    const adapter: AgentLoopAdapter = {
      capabilities: {
        tracks_cost: false,
        supports_signal: false,
        classify_failure: () => 'structural' as const,
      },
      run: async () => ({
        kind: 'completed',
        sessionAtomId: 'agent-session-new-1' as AtomId,
        turnAtomIds: [],
      }),
    };
    await drainStalledQueue(host, {
      stopSentinel: () => false,
      buildAdapter: () => adapter,
    });
    const after = (await host.atoms.get('wc-session-append' as AtomId))!.metadata.work_claim as WorkClaimMeta;
    expect(after.session_atom_ids).toContain('agent-session-new-1' as AtomId);
  });

  it('claim-stuck Notifier event payload on escalation', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedAllPolicies(host);
    await seedPrincipal(host, 'code-author');
    await putWorkClaim(host, {
      claimId: 'wc-stuck',
      claimState: 'stalled',
      createdAt: '2026-05-11T10:00:00.000Z' as Time,
      deadline: '2026-05-12T00:00:00.000Z' as Time,
      recoveryAttempts: 3,
    });
    const telegraphSpy = vi.spyOn(host.notifier, 'telegraph');
    const adapter = mkAdapter();
    await drainStalledQueue(host, {
      stopSentinel: () => false,
      buildAdapter: () => adapter,
    });
    expect(telegraphSpy).toHaveBeenCalled();
    const eventArg = telegraphSpy.mock.calls[0]![0];
    expect(eventArg.kind).toBe('claim-stuck');
    expect(eventArg.payload).toMatchObject({
      claim_id: 'wc-stuck',
      recovery_attempts: 3,
    });
  });
});

// ---------------------------------------------------------------------------
// runClaimReaperTick orchestrator + STOP integration
// ---------------------------------------------------------------------------

describe('runClaimReaperTick', () => {
  it('halts at the STOP gate without running either phase', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedAllPolicies(host);
    await seedPrincipal(host, 'code-author');
    // Seed a claim that WOULD stall to prove the reaper did not scan.
    await putWorkClaim(host, {
      claimId: 'wc-stop',
      claimState: 'executing',
      createdAt: '2026-05-11T10:00:00.000Z' as Time,
      deadline: '2026-05-11T11:00:00.000Z' as Time,
    });
    const result = await runClaimReaperTick(host, {
      stopSentinel: () => true,
    });
    expect(result.halted).toBe(true);
    expect(result.reason).toMatch(/stop-sentinel/);
    // No stall transition should have landed.
    const atom = await host.atoms.get('wc-stop' as AtomId);
    expect((atom!.metadata.work_claim as WorkClaimMeta).claim_state).toBe('executing');
    const stallAtoms = (await host.atoms.query({ type: ['claim-stalled'] }, 100)).atoms;
    expect(stallAtoms.length).toBe(0);
  });

  it('runs both phases when STOP is not active and reports counts', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedAllPolicies(host);
    await seedPrincipal(host, 'code-author');
    // One claim to stall (past deadline).
    await putWorkClaim(host, {
      claimId: 'wc-stall-1',
      claimState: 'executing',
      createdAt: '2026-05-11T10:00:00.000Z' as Time,
      deadline: '2026-05-11T11:00:00.000Z' as Time,
    });
    // One claim already stalled, under cap -> recoverable.
    await putWorkClaim(host, {
      claimId: 'wc-recover-1',
      claimState: 'stalled',
      createdAt: '2026-05-11T10:00:00.000Z' as Time,
      deadline: '2026-05-12T00:00:00.000Z' as Time,
      recoveryAttempts: 0,
    });
    // One claim already stalled, at cap -> escalates.
    await putWorkClaim(host, {
      claimId: 'wc-esc-1',
      claimState: 'stalled',
      createdAt: '2026-05-11T10:00:00.000Z' as Time,
      deadline: '2026-05-12T00:00:00.000Z' as Time,
      recoveryAttempts: 3,
    });
    const adapter = mkAdapter();
    const result = await runClaimReaperTick(host, {
      stopSentinel: () => false,
      buildAdapter: () => adapter,
    });
    expect(result.halted).toBeFalsy();
    expect(result.detected).toBeGreaterThanOrEqual(1);
    // Phase B sees wc-recover-1 + wc-esc-1 + the freshly-stalled wc-
    // stall-1 (the orchestrator runs Phase A and Phase B in one tick).
    expect(result.recovered).toBeGreaterThanOrEqual(1);
    expect(result.escalated).toBeGreaterThanOrEqual(1);
  });

  it('Phase B failure on one claim does not block other claims in the queue', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedAllPolicies(host);
    await seedPrincipal(host, 'code-author');
    await putWorkClaim(host, {
      claimId: 'wc-good',
      claimState: 'stalled',
      createdAt: '2026-05-11T10:00:00.000Z' as Time,
      deadline: '2026-05-12T00:00:00.000Z' as Time,
      recoveryAttempts: 0,
    });
    await putWorkClaim(host, {
      claimId: 'wc-bad',
      claimState: 'stalled',
      createdAt: '2026-05-11T10:00:00.000Z' as Time,
      deadline: '2026-05-12T00:00:00.000Z' as Time,
      recoveryAttempts: 0,
    });
    // Adapter throws on the second invocation.
    let invokeCount = 0;
    const adapter: AgentLoopAdapter = {
      capabilities: {
        tracks_cost: false,
        supports_signal: false,
        classify_failure: () => 'structural' as const,
      },
      run: async () => {
        invokeCount++;
        if (invokeCount === 1) {
          throw new Error('adapter-blew-up');
        }
        return {
          kind: 'completed',
          sessionAtomId: ('agent-session-' + invokeCount) as AtomId,
          turnAtomIds: [],
        };
      },
    };
    const result = await drainStalledQueue(host, {
      stopSentinel: () => false,
      buildAdapter: () => adapter,
    });
    // One adapter call failed, the other succeeded; the reaper does not
    // throw on adapter failure.
    expect(result.recovered + result.escalated).toBeGreaterThanOrEqual(1);
    expect(invokeCount).toBeGreaterThanOrEqual(2);
  });

  it('recoverStalledClaim returns "skipped" when the claim state is no longer stalled', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedAllPolicies(host);
    await seedPrincipal(host, 'code-author');
    await putWorkClaim(host, {
      claimId: 'wc-not-stalled',
      claimState: 'executing',
      createdAt: '2026-05-11T10:00:00.000Z' as Time,
      deadline: '2026-05-12T00:00:00.000Z' as Time,
      recoveryAttempts: 0,
    });
    const adapter = mkAdapter();
    const atom = (await host.atoms.get('wc-not-stalled' as AtomId))!;
    const outcome = await recoverStalledClaim(atom, host, {
      stopSentinel: () => false,
      buildAdapter: () => adapter,
    });
    expect(outcome).toBe('skipped');
    expect(adapter.calls.length).toBe(0);
  });
});
