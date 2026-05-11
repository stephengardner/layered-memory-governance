import { describe, expect, it } from 'vitest';
import type {
  Atom,
  AtomId,
  AtomType,
  PrincipalId,
  WorkClaimMeta,
  ClaimAttestationAcceptedMeta,
  ClaimAttestationRejectedMeta,
  ClaimStalledMeta,
  ClaimEscalatedMeta,
  ClaimState,
  AttestationRejectionReason,
} from '../../src/substrate/types.js';

/*
 * Task 1 of the zero-failure sub-agent substrate plan. The codebase
 * models atoms as a single Atom interface with metadata typed via
 * exported Meta interfaces (precedent: AgentSessionMeta + AgentTurnMeta
 * on src/substrate/types.ts; see test/substrate/atom-types.test.ts).
 * This test asserts:
 *
 *   1. An Atom with type='work-claim' and metadata.work_claim: WorkClaimMeta
 *      typechecks.
 *   2. The ClaimState union has exactly six closed string literals.
 *   3. The four attestation/lifecycle atom-type literals are accepted
 *      members of AtomType.
 *   4. The AttestationRejectionReason union has all ten reasons.
 */
describe('WorkClaimAtom shape', () => {
  it('accepts a structurally-valid work-claim atom', () => {
    const meta: WorkClaimMeta = {
      claim_id: 'work-claim-abc123',
      claim_secret_token: 'A'.repeat(43),
      dispatched_principal_id: 'code-author' as PrincipalId,
      brief: {
        prompt: 'fix the bug',
        expected_terminal: {
          kind: 'pr',
          identifier: '999',
          terminal_states: ['MERGED'],
        },
        deadline_ts: '2026-05-11T04:00:00.000Z',
      },
      claim_state: 'pending',
      budget_tier: 'default',
      recovery_attempts: 0,
      verifier_failure_count: 0,
      parent_claim_id: null,
      session_atom_ids: [],
      last_attestation_rejected_at: null,
      latest_session_finalized_at: null,
    };
    const atom: Atom = {
      schema_version: 1,
      id: 'work-claim-abc123' as AtomId,
      type: 'work-claim',
      layer: 'L0',
      principal_id: 'cto-actor' as PrincipalId,
      content: 'drive PR #999 to MERGED',
      confidence: 1.0,
      created_at: '2026-05-11T02:00:00.000Z',
      last_reinforced_at: '2026-05-11T02:00:00.000Z',
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
      taint: 'clean',
      provenance: {
        kind: 'agent-observed',
        source: { agent_id: 'cto-actor' },
        derived_from: ['intent-foo' as AtomId],
      },
      metadata: { work_claim: meta },
    };
    expect(atom.type).toBe('work-claim');
    expect((atom.metadata.work_claim as WorkClaimMeta).claim_state).toBe('pending');
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

  it('exposes the four attestation/lifecycle atom-type literals', () => {
    const accepted: AtomType = 'claim-attestation-accepted';
    const rejected: AtomType = 'claim-attestation-rejected';
    const stalled: AtomType = 'claim-stalled';
    const escalated: AtomType = 'claim-escalated';
    expect([accepted, rejected, stalled, escalated]).toHaveLength(4);
  });

  it('exposes the ten attestation rejection reasons', () => {
    const reasons: AttestationRejectionReason[] = [
      'stop-sentinel',
      'claim-not-found',
      'claim-already-terminal',
      'token-mismatch',
      'principal-mismatch',
      'identifier-mismatch',
      'kind-mismatch',
      'ground-truth-mismatch',
      'verifier-error',
      'verifier-timeout',
    ];
    expect(reasons).toHaveLength(10);
  });

  it('typechecks each attestation/lifecycle metadata shape', () => {
    const accepted: ClaimAttestationAcceptedMeta = {
      claim_id: 'work-claim-abc123',
      observed_state: 'MERGED',
      verified_at: '2026-05-11T03:00:00.000Z',
    };
    const rejected: ClaimAttestationRejectedMeta = {
      claim_id: 'work-claim-abc123',
      reason: 'token-mismatch',
    };
    const stalled: ClaimStalledMeta = {
      claim_id: 'work-claim-abc123',
      reason: 'deadline-expired',
      recovery_attempts_at_stall: 1,
      verifier_failure_count_at_stall: 0,
    };
    const escalated: ClaimEscalatedMeta = {
      claim_id: 'work-claim-abc123',
      failure_reasons: ['recovery-cap-reached'],
      session_atom_ids: ['agent-session-1' as AtomId],
    };
    expect(accepted.claim_id).toBe('work-claim-abc123');
    expect(rejected.reason).toBe('token-mismatch');
    expect(stalled.recovery_attempts_at_stall).toBe(1);
    expect(escalated.failure_reasons).toHaveLength(1);
  });
});
