/**
 * Plan Task 11: dispatchSubAgent substrate tests.
 *
 * Covers the six pre-dispatch gates (STOP, unknown-caller,
 * unknown-terminal-kind, deadline-already-past, unknown-budget-tier,
 * large-prompt blob spill) plus the happy path (work-claim atom written
 * as `pending`, transitioned to `executing` after the adapter is
 * invoked, return shape).
 *
 * Mirrors the work-claim atom shape established in
 * `test/substrate/work-claim-types.test.ts` and the policy-resolver
 * shape established in `test/substrate/policy/claim-budget-tier.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import {
  dispatchSubAgent,
  markClaimComplete,
} from '../../src/substrate/claim-contract.js';
import type {
  AgentLoopAdapter,
  AgentLoopInput,
  AgentLoopResult,
} from '../../src/substrate/agent-loop.js';
import { verifierRegistry } from '../../src/substrate/claim-verifiers/index.js';
import type {
  Atom,
  AtomId,
  AttestationRejectionReason,
  ClaimAttestationAcceptedMeta,
  ClaimAttestationRejectedMeta,
  PrincipalId,
  Time,
  WorkClaimBrief,
  WorkClaimMeta,
} from '../../src/substrate/types.js';

const NOW = '2026-05-10T12:00:00.000Z' as Time;

function mkBudgetTierAtom(tier: string, maxUsd: number): Atom {
  return {
    schema_version: 1,
    id: `pol-claim-budget-tier-${tier}` as AtomId,
    content: `budget-tier ${tier}`,
    type: 'preference',
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

async function seedCallerPrincipal(host: ReturnType<typeof createMemoryHost>, id: string): Promise<void> {
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

function mkAdapter(
  result: Partial<AgentLoopResult> = {},
): AgentLoopAdapter & { calls: AgentLoopInput[] } {
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
        kind: result.kind ?? 'completed',
        sessionAtomId: result.sessionAtomId ?? ('agent-session-stub' as AtomId),
        turnAtomIds: result.turnAtomIds ?? [],
        ...(result.failure ? { failure: result.failure } : {}),
        ...(result.artifacts ? { artifacts: result.artifacts } : {}),
      };
    },
  };
  return adapter;
}

function mkBrief(overrides: Partial<WorkClaimBrief> = {}): WorkClaimBrief {
  return {
    prompt: 'fix the bug in handler X',
    expected_terminal: {
      kind: 'pr',
      identifier: '999',
      terminal_states: ['MERGED'],
    },
    deadline_ts: '2026-05-11T00:00:00.000Z' as Time,
    ...overrides,
  };
}

describe('dispatchSubAgent', () => {
  it('throws stop-sentinel-active when the STOP predicate returns true', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedCallerPrincipal(host, 'code-author');
    await host.atoms.put(mkBudgetTierAtom('default', 2));
    const adapter = mkAdapter();
    await expect(
      dispatchSubAgent(
        {
          brief: mkBrief(),
          caller_principal_id: 'code-author',
          agent_loop_adapter: adapter,
          // Inject a STOP predicate so the test does not depend on
          // a real `.lag/STOP` file existing in the worktree.
          stopSentinel: () => true,
        },
        host,
      ),
    ).rejects.toThrow(/stop-sentinel-active/);
    // No work-claim atom should have been written.
    const all = await host.atoms.query({ type: ['work-claim'] }, 10);
    expect(all.atoms).toHaveLength(0);
  });

  it('throws unknown-caller when caller_principal_id does not resolve', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await host.atoms.put(mkBudgetTierAtom('default', 2));
    const adapter = mkAdapter();
    await expect(
      dispatchSubAgent(
        {
          brief: mkBrief(),
          caller_principal_id: 'never-seeded',
          agent_loop_adapter: adapter,
          stopSentinel: () => false,
        },
        host,
      ),
    ).rejects.toThrow(/unknown-caller/);
  });

  it('throws unknown-terminal-kind when the verifier is not registered', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedCallerPrincipal(host, 'code-author');
    await host.atoms.put(mkBudgetTierAtom('default', 2));
    const adapter = mkAdapter();
    await expect(
      dispatchSubAgent(
        {
          brief: mkBrief({
            expected_terminal: {
              kind: 'terraform-apply',
              identifier: 'stack/prod',
              terminal_states: ['APPLIED'],
            },
          }),
          caller_principal_id: 'code-author',
          agent_loop_adapter: adapter,
          stopSentinel: () => false,
        },
        host,
      ),
    ).rejects.toThrow(/unknown-terminal-kind/);
  });

  it('throws deadline-already-past when deadline_ts is in the past', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedCallerPrincipal(host, 'code-author');
    await host.atoms.put(mkBudgetTierAtom('default', 2));
    const adapter = mkAdapter();
    await expect(
      dispatchSubAgent(
        {
          brief: mkBrief({
            // 1 day before NOW
            deadline_ts: '2026-05-09T00:00:00.000Z' as Time,
          }),
          caller_principal_id: 'code-author',
          agent_loop_adapter: adapter,
          stopSentinel: () => false,
        },
        host,
      ),
    ).rejects.toThrow(/deadline-already-past/);
  });

  it('throws unknown-budget-tier when the canon policy is missing', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedCallerPrincipal(host, 'code-author');
    // No budget-tier atom seeded.
    const adapter = mkAdapter();
    await expect(
      dispatchSubAgent(
        {
          brief: mkBrief(),
          caller_principal_id: 'code-author',
          agent_loop_adapter: adapter,
          stopSentinel: () => false,
        },
        host,
      ),
    ).rejects.toThrow(/unknown-budget-tier/);
  });

  it('spills prompt > 16 KiB to BlobStore when one is supplied and stores prompt_blob_ref', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedCallerPrincipal(host, 'code-author');
    await host.atoms.put(mkBudgetTierAtom('default', 2));
    const adapter = mkAdapter();
    const blobPuts: Array<Buffer | string> = [];
    const blobStore = {
      put: vi.fn(async (content: Buffer | string) => {
        blobPuts.push(content);
        return 'sha256:'.concat('a'.repeat(64)) as ReturnType<
          typeof Buffer.prototype.toString
        > as never;
      }),
      get: vi.fn(async () => Buffer.from('')),
      has: vi.fn(async () => true),
      describeStorage: () => ({ kind: 'local-file' as const, rootPath: '/tmp' }),
    };
    const bigPrompt = 'x'.repeat(20_000);
    const { claim_id } = await dispatchSubAgent(
      {
        brief: mkBrief({ prompt: bigPrompt }),
        caller_principal_id: 'code-author',
        agent_loop_adapter: adapter,
        stopSentinel: () => false,
        blobStore: blobStore as never,
      },
      host,
    );
    const atom = await host.atoms.get(claim_id as AtomId);
    expect(atom).not.toBeNull();
    const meta = atom!.metadata.work_claim as WorkClaimMeta;
    expect(meta.brief.prompt_blob_ref).toMatch(/^sha256:/);
    expect(blobStore.put).toHaveBeenCalledTimes(1);
  });

  it('keeps a large prompt inline when no BlobStore is supplied (documented fallback)', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedCallerPrincipal(host, 'code-author');
    await host.atoms.put(mkBudgetTierAtom('default', 2));
    const adapter = mkAdapter();
    const bigPrompt = 'y'.repeat(20_000);
    const { claim_id } = await dispatchSubAgent(
      {
        brief: mkBrief({ prompt: bigPrompt }),
        caller_principal_id: 'code-author',
        agent_loop_adapter: adapter,
        stopSentinel: () => false,
      },
      host,
    );
    const atom = await host.atoms.get(claim_id as AtomId);
    expect(atom).not.toBeNull();
    const meta = atom!.metadata.work_claim as WorkClaimMeta;
    expect(meta.brief.prompt).toBe(bigPrompt);
    expect(meta.brief.prompt_blob_ref).toBeUndefined();
  });

  it('writes a work-claim atom in pending state, invokes the adapter, then transitions to executing', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedCallerPrincipal(host, 'code-author');
    await host.atoms.put(mkBudgetTierAtom('default', 2));

    // Capture the claim state seen by the adapter at invocation time so
    // the test can prove the substrate writes `pending` BEFORE invoking
    // the adapter (the substrate's audit-trail contract).
    let stateAtAdapterCall: string | null = null;
    const adapter: AgentLoopAdapter = {
      capabilities: {
        tracks_cost: false,
        supports_signal: false,
        classify_failure: () => 'structural' as const,
      },
      run: async (input: AgentLoopInput) => {
        // Read the just-written claim from the host.
        const page = await host.atoms.query({ type: ['work-claim'] }, 10);
        const claim = page.atoms[0]!;
        stateAtAdapterCall = (claim.metadata.work_claim as WorkClaimMeta).claim_state;
        return {
          kind: 'completed' as const,
          sessionAtomId: 'agent-session-1' as AtomId,
          turnAtomIds: [],
        };
      },
    };

    const result = await dispatchSubAgent(
      {
        brief: mkBrief(),
        caller_principal_id: 'code-author',
        agent_loop_adapter: adapter,
        stopSentinel: () => false,
      },
      host,
    );

    expect(stateAtAdapterCall).toBe('pending');

    const atom = await host.atoms.get(result.claim_id as AtomId);
    expect(atom).not.toBeNull();
    const meta = atom!.metadata.work_claim as WorkClaimMeta;
    expect(meta.claim_state).toBe('executing');
    expect(meta.recovery_attempts).toBe(0);
    expect(meta.verifier_failure_count).toBe(0);
    expect(meta.parent_claim_id).toBeNull();
    expect(meta.session_atom_ids).toEqual([]);
    expect(meta.last_attestation_rejected_at).toBeNull();
    expect(meta.latest_session_finalized_at).toBeNull();
    expect(meta.dispatched_principal_id).toBe('code-author');
    expect(meta.budget_tier).toBe('default');
    expect(atom!.type).toBe('work-claim');
    expect(atom!.layer).toBe('L0');
  });

  it('returns claim_id + claim_secret_token + claim_handle with read/settled', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedCallerPrincipal(host, 'code-author');
    await host.atoms.put(mkBudgetTierAtom('default', 2));
    const adapter = mkAdapter();
    const out = await dispatchSubAgent(
      {
        brief: mkBrief(),
        caller_principal_id: 'code-author',
        agent_loop_adapter: adapter,
        stopSentinel: () => false,
      },
      host,
    );
    expect(typeof out.claim_id).toBe('string');
    expect(out.claim_id.length).toBeGreaterThan(0);
    expect(typeof out.claim_secret_token).toBe('string');
    // base64url 43+ chars
    expect(out.claim_secret_token).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(typeof out.claim_handle.read).toBe('function');
    expect(typeof out.claim_handle.settled).toBe('function');
    const meta = await out.claim_handle.read();
    expect(meta.claim_id).toBe(out.claim_id);
    expect(meta.claim_state).toBe('executing');
  });

  it('threads parent_claim_id into provenance.derived_from + metadata', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedCallerPrincipal(host, 'code-author');
    await host.atoms.put(mkBudgetTierAtom('default', 2));
    const adapter = mkAdapter();
    const parentId = 'work-claim-parent-xyz';
    const out = await dispatchSubAgent(
      {
        brief: mkBrief(),
        caller_principal_id: 'code-author',
        agent_loop_adapter: adapter,
        parent_claim_id: parentId,
        stopSentinel: () => false,
      },
      host,
    );
    const atom = await host.atoms.get(out.claim_id as AtomId);
    expect(atom).not.toBeNull();
    const meta = atom!.metadata.work_claim as WorkClaimMeta;
    expect(meta.parent_claim_id).toBe(parentId);
    expect(atom!.provenance.derived_from).toContain(parentId as AtomId);
  });

  it('invokes the adapter with the prompt prefixed by the WORK_CLAIM_CONTEXT preamble (claim_id + token + caller + expected_terminal + deadline)', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedCallerPrincipal(host, 'code-author');
    await host.atoms.put(mkBudgetTierAtom('default', 2));
    const adapter = mkAdapter();
    const brief = mkBrief({ prompt: 'fix the thing' });
    const out = await dispatchSubAgent(
      {
        brief,
        caller_principal_id: 'code-author',
        agent_loop_adapter: adapter,
        stopSentinel: () => false,
      },
      host,
    );
    expect(adapter.calls).toHaveLength(1);
    const promptSeen = adapter.calls[0]!.task.questionPrompt ?? '';
    expect(promptSeen).toContain(`claim_id:${out.claim_id}`);
    expect(promptSeen).toContain(`claim_secret_token:${out.claim_secret_token}`);
    expect(promptSeen).toContain(`caller_principal_id:code-author`);
    expect(promptSeen).toContain(`expected_terminal:`);
    expect(promptSeen).toContain(`deadline:${brief.deadline_ts}`);
    expect(promptSeen).toContain('fix the thing');
  });
});

// ---------------------------------------------------------------------------
// Plan Task 12: markClaimComplete substrate tests.
//
// Covers the nine validation gates per spec Section 6 step 9 (STOP, claim
// lookup, post-terminal state guard, token match, principal match,
// identifier match, kind match, transition to attesting, verifier dispatch)
// plus the verifier-failure-cap path (3 consecutive timeouts -> stalled)
// plus the post-terminal misbehavior Notifier assertion.
//
// Tests use the `plan` verifier (registered for kind='plan') because it is
// an AtomStore lookup -- the test seeds a `plan` atom with a controlled
// `plan_state` to drive ok/mismatch outcomes deterministically. The
// verifier-timeout + verifier-error paths swap in a test-only registry
// entry via `verifierRegistry.set(kind, handler)` so the timeout / throw
// can be exercised without monkey-patching the contract module.
// ---------------------------------------------------------------------------

const VERIFIER_TIMEOUT_KIND = 'timeout-test-kind';
const VERIFIER_ERROR_KIND = 'error-test-kind';

/**
 * Seed the 8 reaper-config policy atoms a markClaimComplete call needs to
 * resolve at runtime (only `verifier-timeout-ms` and `verifier-failure-cap`
 * are read by Task 12 today, but seeding the full set is cheap and matches
 * what a real deployment looks like).
 */
function mkReaperConfigAtom(kind: string, value: number): Atom {
  return {
    schema_version: 1,
    id: `pol-${kind}` as AtomId,
    content: `reaper-config ${kind}`,
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

/**
 * Seed a plan atom with a controlled plan_state so the registered
 * `plan` verifier returns ok=true / ok=false against the expected set.
 */
async function seedPlanAtom(
  host: ReturnType<typeof createMemoryHost>,
  id: string,
  planState: 'succeeded' | 'failed' | 'executing',
): Promise<void> {
  await host.atoms.put({
    schema_version: 1,
    id: id as AtomId,
    content: 'plan',
    type: 'plan',
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
    metadata: {},
    plan_state: planState,
  });
}

/**
 * Common dispatch -> work-claim setup for markClaimComplete tests. Returns
 * the dispatched output (claim_id + token + handle) for the test body to
 * use. Seeds the principal, budget tier, reaper-config policies, and the
 * target plan atom. The brief uses kind='plan' so the registered plan
 * verifier resolves it.
 */
async function setupForAttestation(options: {
  host: ReturnType<typeof createMemoryHost>;
  callerPrincipalId?: string;
  planAtomId?: string;
  planState?: 'succeeded' | 'failed' | 'executing';
  terminalKind?: string;
  expectedStates?: ReadonlyArray<string>;
}): Promise<{
  readonly claim_id: string;
  readonly claim_secret_token: string;
  readonly planAtomId: string;
  readonly terminalKind: string;
}> {
  const host = options.host;
  const caller = options.callerPrincipalId ?? 'code-author';
  const planAtomId = options.planAtomId ?? 'plan-target-1';
  const planState = options.planState ?? 'succeeded';
  const terminalKind = options.terminalKind ?? 'plan';
  const expectedStates = options.expectedStates ?? ['succeeded'];

  await seedCallerPrincipal(host, caller);
  await host.atoms.put(mkBudgetTierAtom('default', 2));
  await host.atoms.put(mkReaperConfigAtom('claim-verifier-timeout-ms', 30_000));
  await host.atoms.put(mkReaperConfigAtom('claim-verifier-failure-cap', 3));
  await seedPlanAtom(host, planAtomId, planState);

  const adapter = mkAdapter();
  const out = await dispatchSubAgent(
    {
      brief: {
        prompt: 'attest a plan',
        expected_terminal: {
          kind: terminalKind,
          identifier: planAtomId,
          terminal_states: expectedStates,
        },
        deadline_ts: '2026-05-12T00:00:00.000Z' as Time,
      },
      caller_principal_id: caller,
      agent_loop_adapter: adapter,
      stopSentinel: () => false,
    },
    host,
  );
  return {
    claim_id: out.claim_id,
    claim_secret_token: out.claim_secret_token,
    planAtomId,
    terminalKind,
  };
}

describe('markClaimComplete', () => {
  it('Gate 1: STOP sentinel active -> reason stop-sentinel + rejection atom written', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    const { claim_id, claim_secret_token, planAtomId, terminalKind } = await setupForAttestation({ host });

    const result = await markClaimComplete(
      {
        claim_id,
        claim_secret_token,
        caller_principal_id: 'code-author',
        attestation: {
          terminal_kind: terminalKind,
          terminal_identifier: planAtomId,
          observed_state: 'succeeded',
        },
      },
      host,
      { stopSentinel: () => true },
    );
    expect(result).toEqual({ accepted: false, reason: 'stop-sentinel' });

    const rejections = await host.atoms.query({ type: ['claim-attestation-rejected'] }, 10);
    expect(rejections.atoms).toHaveLength(1);
    const meta = rejections.atoms[0]!.metadata.claim_attestation as ClaimAttestationRejectedMeta;
    expect(meta.reason).toBe('stop-sentinel');
    expect(meta.claim_id).toBe(claim_id);
    expect(rejections.atoms[0]!.provenance.derived_from).toContain(claim_id as AtomId);
    expect(rejections.atoms[0]!.provenance.kind).toBe('agent-inferred');
  });

  it('Gate 2: claim-not-found -> reason claim-not-found, NO rejection atom written (no parent to chain to)', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedCallerPrincipal(host, 'code-author');

    const result = await markClaimComplete(
      {
        claim_id: 'work-claim-does-not-exist',
        claim_secret_token: 'irrelevant',
        caller_principal_id: 'code-author',
        attestation: {
          terminal_kind: 'plan',
          terminal_identifier: 'plan-x',
          observed_state: 'succeeded',
        },
      },
      host,
      { stopSentinel: () => false },
    );
    expect(result).toEqual({ accepted: false, reason: 'claim-not-found' });

    // No rejection atom because there is no claim_id to chain provenance against.
    const rejections = await host.atoms.query({ type: ['claim-attestation-rejected'] }, 10);
    expect(rejections.atoms).toHaveLength(0);
  });

  it('Gate 3: claim already complete -> reason claim-already-terminal + principal-misbehavior telegraphed', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    const { claim_id, claim_secret_token, planAtomId, terminalKind } = await setupForAttestation({ host });

    // Force the claim into a terminal state.
    const claim = await host.atoms.get(claim_id as AtomId);
    const meta = claim!.metadata.work_claim as WorkClaimMeta;
    await host.atoms.update(claim_id as AtomId, {
      metadata: {
        work_claim: { ...meta, claim_state: 'complete' },
      },
    });

    const notifierSpy = vi.spyOn(host.notifier, 'telegraph');
    const result = await markClaimComplete(
      {
        claim_id,
        claim_secret_token,
        caller_principal_id: 'code-author',
        attestation: {
          terminal_kind: terminalKind,
          terminal_identifier: planAtomId,
          observed_state: 'succeeded',
        },
      },
      host,
      { stopSentinel: () => false },
    );
    expect(result).toEqual({ accepted: false, reason: 'claim-already-terminal' });

    // Rejection atom written.
    const rejections = await host.atoms.query({ type: ['claim-attestation-rejected'] }, 10);
    expect(rejections.atoms).toHaveLength(1);
    const rejectionMeta = rejections.atoms[0]!.metadata.claim_attestation as ClaimAttestationRejectedMeta;
    expect(rejectionMeta.reason).toBe('claim-already-terminal');

    // Notifier called with principal-misbehavior.
    expect(notifierSpy).toHaveBeenCalledTimes(1);
    const firstCall = notifierSpy.mock.calls[0]!;
    expect(firstCall[0]).toEqual(
      expect.objectContaining({
        kind: 'principal-misbehavior',
        payload: expect.objectContaining({
          claim_id,
          caller_principal_id: 'code-author',
        }),
      }),
    );
  });

  it('Gate 3: claim already abandoned -> reason claim-already-terminal (mirror of complete)', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    const { claim_id, claim_secret_token, planAtomId, terminalKind } = await setupForAttestation({ host });

    const claim = await host.atoms.get(claim_id as AtomId);
    const meta = claim!.metadata.work_claim as WorkClaimMeta;
    await host.atoms.update(claim_id as AtomId, {
      metadata: {
        work_claim: { ...meta, claim_state: 'abandoned' },
      },
    });

    const result = await markClaimComplete(
      {
        claim_id,
        claim_secret_token,
        caller_principal_id: 'code-author',
        attestation: {
          terminal_kind: terminalKind,
          terminal_identifier: planAtomId,
          observed_state: 'succeeded',
        },
      },
      host,
      { stopSentinel: () => false },
    );
    expect(result).toEqual({ accepted: false, reason: 'claim-already-terminal' });
  });

  it('Gate 4: token mismatch -> reason token-mismatch + rejection atom written', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    const { claim_id, planAtomId, terminalKind } = await setupForAttestation({ host });

    const result = await markClaimComplete(
      {
        claim_id,
        // Use a same-length-prefix wrong token to guarantee a real mismatch
        // (constantTimeEqual short-circuits length mismatch to false too).
        claim_secret_token: 'this-is-not-the-real-token-xxxxxxxxxxxxxx',
        caller_principal_id: 'code-author',
        attestation: {
          terminal_kind: terminalKind,
          terminal_identifier: planAtomId,
          observed_state: 'succeeded',
        },
      },
      host,
      { stopSentinel: () => false },
    );
    expect(result).toEqual({ accepted: false, reason: 'token-mismatch' });

    const rejections = await host.atoms.query({ type: ['claim-attestation-rejected'] }, 10);
    expect(rejections.atoms).toHaveLength(1);
    const meta = rejections.atoms[0]!.metadata.claim_attestation as ClaimAttestationRejectedMeta;
    expect(meta.reason).toBe('token-mismatch');
    expect(rejections.atoms[0]!.provenance.derived_from).toContain(claim_id as AtomId);
  });

  it('Gate 5: principal mismatch -> reason principal-mismatch', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    const { claim_id, claim_secret_token, planAtomId, terminalKind } = await setupForAttestation({ host });
    // Seed a second principal so principal-existence checks (if any) pass;
    // the gate we are testing is the dispatched-principal mismatch, not
    // existence.
    await seedCallerPrincipal(host, 'other-principal');

    const result = await markClaimComplete(
      {
        claim_id,
        claim_secret_token,
        caller_principal_id: 'other-principal',
        attestation: {
          terminal_kind: terminalKind,
          terminal_identifier: planAtomId,
          observed_state: 'succeeded',
        },
      },
      host,
      { stopSentinel: () => false },
    );
    expect(result).toEqual({ accepted: false, reason: 'principal-mismatch' });

    const rejections = await host.atoms.query({ type: ['claim-attestation-rejected'] }, 10);
    expect(rejections.atoms).toHaveLength(1);
    expect((rejections.atoms[0]!.metadata.claim_attestation as ClaimAttestationRejectedMeta).reason).toBe('principal-mismatch');
  });

  it('Gate 6: identifier mismatch -> reason identifier-mismatch', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    const { claim_id, claim_secret_token, terminalKind } = await setupForAttestation({ host });

    const result = await markClaimComplete(
      {
        claim_id,
        claim_secret_token,
        caller_principal_id: 'code-author',
        attestation: {
          terminal_kind: terminalKind,
          terminal_identifier: 'plan-different-id',
          observed_state: 'succeeded',
        },
      },
      host,
      { stopSentinel: () => false },
    );
    expect(result).toEqual({ accepted: false, reason: 'identifier-mismatch' });
  });

  it('Gate 7: kind mismatch -> reason kind-mismatch', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    const { claim_id, claim_secret_token, planAtomId } = await setupForAttestation({ host });

    const result = await markClaimComplete(
      {
        claim_id,
        claim_secret_token,
        caller_principal_id: 'code-author',
        attestation: {
          terminal_kind: 'task', // brief says 'plan'
          terminal_identifier: planAtomId,
          observed_state: 'succeeded',
        },
      },
      host,
      { stopSentinel: () => false },
    );
    expect(result).toEqual({ accepted: false, reason: 'kind-mismatch' });
  });

  it('Gate 8 + 9 happy path: transition to attesting -> verifier ok=true -> accepted + flip to complete + reset failure count', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    const { claim_id, claim_secret_token, planAtomId, terminalKind } = await setupForAttestation({ host });

    const result = await markClaimComplete(
      {
        claim_id,
        claim_secret_token,
        caller_principal_id: 'code-author',
        attestation: {
          terminal_kind: terminalKind,
          terminal_identifier: planAtomId,
          observed_state: 'succeeded',
        },
      },
      host,
      { stopSentinel: () => false },
    );
    expect(result).toEqual({ accepted: true });

    const claim = await host.atoms.get(claim_id as AtomId);
    const meta = claim!.metadata.work_claim as WorkClaimMeta;
    expect(meta.claim_state).toBe('complete');
    expect(meta.verifier_failure_count).toBe(0);

    // Acceptance atom written with the verifier's observed_state.
    const accepted = await host.atoms.query({ type: ['claim-attestation-accepted'] }, 10);
    expect(accepted.atoms).toHaveLength(1);
    const acceptedMeta = accepted.atoms[0]!.metadata.claim_attestation as ClaimAttestationAcceptedMeta;
    expect(acceptedMeta.claim_id).toBe(claim_id);
    expect(acceptedMeta.observed_state).toBe('succeeded');
    expect(accepted.atoms[0]!.provenance.derived_from).toContain(claim_id as AtomId);
  });

  it('Gate 9 ok=false: ground-truth-mismatch -> rejection atom + state stays attesting + failure count NOT incremented + last_attestation_rejected_at set', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    // Seed plan in `executing` state but attest expects `succeeded`.
    const { claim_id, claim_secret_token, planAtomId, terminalKind } = await setupForAttestation({
      host,
      planState: 'executing',
    });

    const result = await markClaimComplete(
      {
        claim_id,
        claim_secret_token,
        caller_principal_id: 'code-author',
        attestation: {
          terminal_kind: terminalKind,
          terminal_identifier: planAtomId,
          observed_state: 'succeeded',
        },
      },
      host,
      { stopSentinel: () => false },
    );
    expect(result).toEqual({ accepted: false, reason: 'ground-truth-mismatch', observed_state: 'executing' });

    const claim = await host.atoms.get(claim_id as AtomId);
    const meta = claim!.metadata.work_claim as WorkClaimMeta;
    expect(meta.claim_state).toBe('attesting');
    expect(meta.verifier_failure_count).toBe(0);
    expect(meta.last_attestation_rejected_at).not.toBeNull();

    const rejections = await host.atoms.query({ type: ['claim-attestation-rejected'] }, 10);
    expect(rejections.atoms).toHaveLength(1);
    const rejectionMeta = rejections.atoms[0]!.metadata.claim_attestation as ClaimAttestationRejectedMeta;
    expect(rejectionMeta.reason).toBe('ground-truth-mismatch');
    expect(rejectionMeta.observed_state).toBe('executing');
  });

  it('Gate 9 verifier-error: handler throws -> rejection + failure_count++', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    // Register an error-throwing verifier for this test only.
    verifierRegistry.set(VERIFIER_ERROR_KIND, async () => {
      throw new Error('verifier-internal-blowup');
    });
    try {
      const { claim_id, claim_secret_token, planAtomId } = await setupForAttestation({
        host,
        terminalKind: VERIFIER_ERROR_KIND,
        expectedStates: ['DOES_NOT_MATTER'],
      });

      const result = await markClaimComplete(
        {
          claim_id,
          claim_secret_token,
          caller_principal_id: 'code-author',
          attestation: {
            terminal_kind: VERIFIER_ERROR_KIND,
            terminal_identifier: planAtomId,
            observed_state: 'DOES_NOT_MATTER',
          },
        },
        host,
        { stopSentinel: () => false },
      );
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('verifier-error');

      const claim = await host.atoms.get(claim_id as AtomId);
      const meta = claim!.metadata.work_claim as WorkClaimMeta;
      expect(meta.claim_state).toBe('attesting');
      expect(meta.verifier_failure_count).toBe(1);
      expect(meta.last_attestation_rejected_at).not.toBeNull();
    } finally {
      verifierRegistry.delete(VERIFIER_ERROR_KIND);
    }
  });

  it('Gate 9 verifier-timeout: handler exceeds timeout -> rejection + failure_count++', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    // Register a verifier that never resolves.
    verifierRegistry.set(VERIFIER_TIMEOUT_KIND, () => new Promise(() => { /* never resolves */ }));
    try {
      // Lower the timeout so the test runs in <1s.
      const { claim_id, claim_secret_token, planAtomId } = await setupForAttestation({
        host,
        terminalKind: VERIFIER_TIMEOUT_KIND,
        expectedStates: ['DOES_NOT_MATTER'],
      });
      // Override the verifier-timeout-ms policy by writing a higher-
      // priority atom with the same kind but a created_at after NOW.
      // Most-recent-wins (per the reaper-config reader contract).
      await host.atoms.put({
        ...mkReaperConfigAtom('claim-verifier-timeout-ms', 50),
        id: 'pol-claim-verifier-timeout-ms-override' as AtomId,
        created_at: '2026-05-10T12:00:01.000Z' as Time,
      });

      const result = await markClaimComplete(
        {
          claim_id,
          claim_secret_token,
          caller_principal_id: 'code-author',
          attestation: {
            terminal_kind: VERIFIER_TIMEOUT_KIND,
            terminal_identifier: planAtomId,
            observed_state: 'DOES_NOT_MATTER',
          },
        },
        host,
        { stopSentinel: () => false },
      );
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('verifier-timeout');

      const claim = await host.atoms.get(claim_id as AtomId);
      const meta = claim!.metadata.work_claim as WorkClaimMeta;
      expect(meta.claim_state).toBe('attesting');
      expect(meta.verifier_failure_count).toBe(1);
    } finally {
      verifierRegistry.delete(VERIFIER_TIMEOUT_KIND);
    }
  });

  it('Gate 9 failure cap: 3 consecutive timeouts -> state stalls', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    verifierRegistry.set(VERIFIER_TIMEOUT_KIND, () => new Promise(() => { /* never resolves */ }));
    try {
      const { claim_id, claim_secret_token, planAtomId } = await setupForAttestation({
        host,
        terminalKind: VERIFIER_TIMEOUT_KIND,
        expectedStates: ['DOES_NOT_MATTER'],
      });
      // Lower the timeout for fast test execution.
      await host.atoms.put({
        ...mkReaperConfigAtom('claim-verifier-timeout-ms', 50),
        id: 'pol-claim-verifier-timeout-ms-override' as AtomId,
        created_at: '2026-05-10T12:00:01.000Z' as Time,
      });

      const input = {
        claim_id,
        claim_secret_token,
        caller_principal_id: 'code-author',
        attestation: {
          terminal_kind: VERIFIER_TIMEOUT_KIND,
          terminal_identifier: planAtomId,
          observed_state: 'DOES_NOT_MATTER',
        },
      };

      // Three consecutive timeouts.
      await markClaimComplete(input, host, { stopSentinel: () => false });
      let meta = (await host.atoms.get(claim_id as AtomId))!.metadata.work_claim as WorkClaimMeta;
      expect(meta.verifier_failure_count).toBe(1);
      expect(meta.claim_state).toBe('attesting');

      await markClaimComplete(input, host, { stopSentinel: () => false });
      meta = (await host.atoms.get(claim_id as AtomId))!.metadata.work_claim as WorkClaimMeta;
      expect(meta.verifier_failure_count).toBe(2);
      expect(meta.claim_state).toBe('attesting');

      await markClaimComplete(input, host, { stopSentinel: () => false });
      meta = (await host.atoms.get(claim_id as AtomId))!.metadata.work_claim as WorkClaimMeta;
      expect(meta.verifier_failure_count).toBe(3);
      // At >= cap (3), state flips to stalled.
      expect(meta.claim_state).toBe('stalled');
    } finally {
      verifierRegistry.delete(VERIFIER_TIMEOUT_KIND);
    }
  });

  it('Every rejection reason flows through the rejection-atom write helper with provenance.derived_from=[claim_id]', async () => {
    // Smoke-test that the rejection-atom shape is stable across reasons.
    const host = createMemoryHost({ clockStart: NOW });
    const { claim_id, claim_secret_token, planAtomId, terminalKind } = await setupForAttestation({ host });

    // token-mismatch as the representative case (other cases are
    // exercised by the per-gate tests above; this asserts the shape).
    await markClaimComplete(
      {
        claim_id,
        claim_secret_token: 'wrong-token',
        caller_principal_id: 'code-author',
        attestation: {
          terminal_kind: terminalKind,
          terminal_identifier: planAtomId,
          observed_state: 'succeeded',
        },
      },
      host,
      { stopSentinel: () => false },
    );

    const rejections = await host.atoms.query({ type: ['claim-attestation-rejected'] }, 10);
    expect(rejections.atoms).toHaveLength(1);
    const atom = rejections.atoms[0]!;
    expect(atom.type).toBe('claim-attestation-rejected');
    expect(atom.layer).toBe('L0');
    expect(atom.provenance.kind).toBe('agent-inferred');
    expect(atom.provenance.derived_from).toEqual([claim_id]);
    const meta = atom.metadata.claim_attestation as ClaimAttestationRejectedMeta;
    expect(meta.claim_id).toBe(claim_id);
    const validReason: AttestationRejectionReason = meta.reason;
    expect(validReason).toBe('token-mismatch');
  });
});
