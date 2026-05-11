/**
 * End-to-end test: full claim-contract attest cycle against the real PR
 * verifier with the GitHub HTTP boundary mocked.
 *
 * The substrate under test:
 *   - `dispatchSubAgent` (Task 11): mints the work-claim atom, runs the
 *     six pre-dispatch gates, invokes the adapter stub, flips the claim
 *     to `executing`.
 *   - `markClaimComplete` (Task 12): runs the nine attestation gates,
 *     dispatches the real `pr` verifier, branches on the verifier's
 *     observed state.
 *
 * What is NOT mocked: the contract layer, the verifier registry, the
 * real `verifyPrTerminal` handler, the memory-host AtomStore, or any
 * intermediate substrate code. The ONLY mock is the HTTP boundary
 * `globalThis.fetch`, which the PR verifier falls through to when no
 * explicit `ctx.fetchImpl` override is supplied. Stubbing the global
 * fetch (rather than monkey-patching the verifier or hot-swapping a
 * registry entry) exercises the exact production code path the
 * verifier takes inside `markClaimComplete`'s `dispatchVerifier` call.
 *
 * Scenarios:
 *   1. Accepted: fetch returns `{ state: 'MERGED' }` -> verifier ok=true
 *      -> claim flips to `complete`, `claim-attestation-accepted` atom
 *      written with provenance chain back to the claim.
 *   2. Ground-truth-mismatch: fetch returns `{ state: 'OPEN' }` -> verifier
 *      ok=false -> `claim-attestation-rejected` atom with reason
 *      `ground-truth-mismatch` and `observed_state='OPEN'`, claim stays
 *      `attesting`, `verifier_failure_count` is 0 (mismatch is signal,
 *      not infrastructure failure).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import type {
  Atom,
  AtomId,
  ClaimAttestationAcceptedMeta,
  ClaimAttestationRejectedMeta,
  PrincipalId,
  Time,
  WorkClaimMeta,
} from '../../src/substrate/types.js';

const NOW = '2026-05-10T12:00:00.000Z' as Time;
const PR_NUMBER = '999';
const APEX_PRINCIPAL = 'apex-agent';

/**
 * Build a minimal `Response`-shaped object suitable for the PR verifier's
 * `fetchImpl` contract. The verifier reads `response.status`,
 * `response.ok`, and calls `response.json()`; nothing else. Inlining the
 * factory here (rather than reaching for `test/fixtures/github-mock.ts`,
 * which does not exist in this branch) keeps the test self-contained
 * per the Task 20 brief.
 */
function mockResponse(body: Record<string, unknown>, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    // The rest of the Response surface is unused by `verifyPrTerminal`;
    // cast keeps TypeScript happy without dragging in undici types.
  } as unknown as Response;
}

/**
 * Recording adapter stub. The contract layer requires an `AgentLoopAdapter`
 * be invoked between the `pending` and `executing` claim transitions; the
 * stub records the input it saw so the test can prove the substrate
 * actually drove the adapter (rather than silently skipping it). The
 * stub does NOT write session/turn atoms because Task 20 focuses on the
 * attest cycle, not on agent-loop atom shape.
 */
function recordingAdapter(): AgentLoopAdapter & { calls: AgentLoopInput[] } {
  const calls: AgentLoopInput[] = [];
  return {
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
        sessionAtomId: 'agent-session-e2e-stub' as AtomId,
        turnAtomIds: [],
      };
    },
  };
}

/**
 * Seed the apex-agent principal so the dispatch caller-identity gate
 * (Gate 2) passes and the same principal can attest at
 * `markClaimComplete` time (Gate 5 principal match).
 */
async function seedApexPrincipal(host: ReturnType<typeof createMemoryHost>): Promise<void> {
  await host.principals.put({
    id: APEX_PRINCIPAL as PrincipalId,
    name: APEX_PRINCIPAL,
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
 * Seed the budget-tier policy atom dispatch resolves at Gate 5, plus the
 * two reaper-config policies `markClaimComplete` reads at runtime
 * (`claim-verifier-timeout-ms` and `claim-verifier-failure-cap`). Lifted
 * from `test/substrate/claim-contract.test.ts` to keep the seed shape
 * aligned with the unit-test layer.
 */
async function seedPolicies(host: ReturnType<typeof createMemoryHost>): Promise<void> {
  // Budget-tier `default` for the dispatch gate.
  const budgetAtom: Atom = {
    schema_version: 1,
    id: 'pol-claim-budget-tier-default' as AtomId,
    content: 'budget-tier default',
    // Canonical seed shape: type='directive' + provenance.kind='operator-seeded'.
    // The resolver gates on both as a forgery-containment surface.
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
        tier: 'default',
        max_budget_usd: 2,
      },
    },
  };
  await host.atoms.put(budgetAtom);

  // Reaper-config policies the verifier-race in markClaimComplete reads.
  const reaperKinds: ReadonlyArray<[string, number]> = [
    ['claim-verifier-timeout-ms', 30_000],
    ['claim-verifier-failure-cap', 3],
  ];
  for (const [kind, value] of reaperKinds) {
    await host.atoms.put({
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
    });
  }
}

/**
 * Dispatch a fresh PR-kind work-claim against the seeded fixture host
 * and return the contract output. The brief targets `expected_terminal`
 * kind=`pr` so `markClaimComplete` routes through the real PR verifier.
 */
async function dispatchPrClaim(
  host: ReturnType<typeof createMemoryHost>,
): Promise<{
  readonly claim_id: string;
  readonly claim_secret_token: string;
}> {
  const adapter = recordingAdapter();
  const out = await dispatchSubAgent(
    {
      brief: {
        prompt: 'merge PR ' + PR_NUMBER,
        expected_terminal: {
          kind: 'pr',
          identifier: PR_NUMBER,
          terminal_states: ['MERGED'],
        },
        deadline_ts: '2026-05-12T00:00:00.000Z' as Time,
      },
      caller_principal_id: APEX_PRINCIPAL,
      agent_loop_adapter: adapter,
      // Inject so the gate does not depend on a real `.lag/STOP` file.
      stopSentinel: () => false,
    },
    host,
  );
  return { claim_id: out.claim_id, claim_secret_token: out.claim_secret_token };
}

describe('claim-contract end-to-end (real PR verifier + mocked fetch)', () => {
  // Save + restore the global fetch around every test so a leaked stub
  // cannot bleed across cases. `vi.stubGlobal` would do the same, but
  // an explicit save+restore is more obvious to a future reader.
  let originalFetch: typeof globalThis.fetch | undefined;
  // Save + restore GITHUB_REPOSITORY around every test. The PR verifier
  // throws when neither ctx.repo nor GITHUB_REPOSITORY is set; we
  // supply a fixture value so the verifier's URL-building path runs
  // through to the mocked fetch instead of failing at resolveRepo.
  let originalGithubRepo: string | undefined;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalGithubRepo = process.env.GITHUB_REPOSITORY;
    process.env.GITHUB_REPOSITORY = 'fixture-owner/fixture-repo';
  });
  afterEach(() => {
    if (originalFetch !== undefined) {
      globalThis.fetch = originalFetch;
    }
    if (originalGithubRepo === undefined) {
      delete process.env.GITHUB_REPOSITORY;
    } else {
      process.env.GITHUB_REPOSITORY = originalGithubRepo;
    }
    vi.restoreAllMocks();
  });

  it('accepted path: fetch -> MERGED -> claim flips to complete + accepted atom chained', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedApexPrincipal(host);
    await seedPolicies(host);

    const mockFetch = vi.fn(async () => mockResponse({ state: 'MERGED' }));
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    const { claim_id, claim_secret_token } = await dispatchPrClaim(host);

    const result = await markClaimComplete(
      {
        claim_id,
        claim_secret_token,
        caller_principal_id: APEX_PRINCIPAL,
        attestation: {
          terminal_kind: 'pr',
          terminal_identifier: PR_NUMBER,
          observed_state: 'MERGED',
        },
      },
      host,
      { stopSentinel: () => false },
    );
    expect(result).toEqual({ accepted: true });

    // The PR verifier was driven through the substrate (not a registry
    // hot-swap): exactly one HTTP call happened, against the canonical
    // GitHub pulls URL.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const fetchCall = mockFetch.mock.calls[0]!;
    expect(String(fetchCall[0])).toContain(`/pulls/${PR_NUMBER}`);

    // Claim flipped to complete + failure-count reset.
    const claim = await host.atoms.get(claim_id as AtomId);
    expect(claim).not.toBeNull();
    const meta = claim!.metadata.work_claim as WorkClaimMeta;
    expect(meta.claim_state).toBe('complete');
    expect(meta.verifier_failure_count).toBe(0);

    // Accepted atom written with provenance back to the claim.
    const accepted = await host.atoms.query({ type: ['claim-attestation-accepted'] }, 10);
    expect(accepted.atoms).toHaveLength(1);
    const acceptedAtom = accepted.atoms[0]!;
    expect(acceptedAtom.provenance.derived_from).toContain(claim_id as AtomId);
    const acceptedMeta = acceptedAtom.metadata.claim_attestation as ClaimAttestationAcceptedMeta;
    expect(acceptedMeta.claim_id).toBe(claim_id);
    expect(acceptedMeta.observed_state).toBe('MERGED');

    // No rejection atoms on the happy path.
    const rejections = await host.atoms.query({ type: ['claim-attestation-rejected'] }, 10);
    expect(rejections.atoms).toHaveLength(0);
  });

  it('ground-truth-mismatch path: fetch -> OPEN -> rejection atom written, claim stays attesting, failure_count NOT incremented', async () => {
    const host = createMemoryHost({ clockStart: NOW });
    await seedApexPrincipal(host);
    await seedPolicies(host);

    const mockFetch = vi.fn(async () => mockResponse({ state: 'OPEN' }));
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

    const { claim_id, claim_secret_token } = await dispatchPrClaim(host);

    const result = await markClaimComplete(
      {
        claim_id,
        claim_secret_token,
        caller_principal_id: APEX_PRINCIPAL,
        attestation: {
          terminal_kind: 'pr',
          terminal_identifier: PR_NUMBER,
          // The sub-agent attests MERGED, but ground truth says OPEN.
          observed_state: 'MERGED',
        },
      },
      host,
      { stopSentinel: () => false },
    );
    expect(result).toEqual({
      accepted: false,
      reason: 'ground-truth-mismatch',
      observed_state: 'OPEN',
    });

    // PR verifier ran exactly once against the canonical URL.
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Claim stays in `attesting`; ground-truth-mismatch is signal, not
    // infrastructure failure, so `verifier_failure_count` is NOT
    // incremented (per the spec Section 6 step 9 + Gate 9 contract).
    const claim = await host.atoms.get(claim_id as AtomId);
    expect(claim).not.toBeNull();
    const meta = claim!.metadata.work_claim as WorkClaimMeta;
    expect(meta.claim_state).toBe('attesting');
    expect(meta.verifier_failure_count).toBe(0);
    expect(meta.last_attestation_rejected_at).not.toBeNull();
    expect(typeof meta.last_attestation_rejected_at).toBe('string');

    // Rejection atom written with reason + observed_state + chained
    // provenance back to the claim.
    const rejections = await host.atoms.query({ type: ['claim-attestation-rejected'] }, 10);
    expect(rejections.atoms).toHaveLength(1);
    const rejectionAtom = rejections.atoms[0]!;
    expect(rejectionAtom.provenance.derived_from).toContain(claim_id as AtomId);
    const rejectionMeta = rejectionAtom.metadata.claim_attestation as ClaimAttestationRejectedMeta;
    expect(rejectionMeta.reason).toBe('ground-truth-mismatch');
    expect(rejectionMeta.observed_state).toBe('OPEN');
    expect(rejectionMeta.claim_id).toBe(claim_id);

    // No accepted atoms on the mismatch path.
    const accepted = await host.atoms.query({ type: ['claim-attestation-accepted'] }, 10);
    expect(accepted.atoms).toHaveLength(0);
  });
});
