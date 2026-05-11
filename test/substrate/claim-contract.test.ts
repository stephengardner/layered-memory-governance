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
import { dispatchSubAgent } from '../../src/substrate/claim-contract.js';
import type {
  AgentLoopAdapter,
  AgentLoopInput,
  AgentLoopResult,
} from '../../src/substrate/agent-loop.js';
import type {
  Atom,
  AtomId,
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
