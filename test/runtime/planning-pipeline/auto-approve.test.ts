/**
 * Pipeline-stage plan auto-approval tests.
 *
 * Covers two surfaces:
 *   1. evaluatePipelinePlanAutoApproval (pure): every envelope check
 *      branch produces the right verdict shape without I/O.
 *   2. runPipelinePlanAutoApproval (host-side): the wrapper reads the
 *      gating policies, persists the plan_state transition, and logs
 *      the audit events the operator and console expect.
 *
 * Mirrors the test taxonomy in
 * test/runtime/actor-message/intent-approve.test.ts so the two flows
 * stay in lock-step on every check.
 */

import { describe, expect, it } from 'vitest';
import {
  evaluatePipelinePlanAutoApproval,
  runPipelinePlanAutoApproval,
} from '../../../src/runtime/planning-pipeline/auto-approve.js';
import { SkipReason } from '../../../src/runtime/actor-message/intent-approve.js';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../src/types.js';

// ---------------------------------------------------------------------------
// Fixtures: ISO clock, intent, plan, gating-policy atoms.
// ---------------------------------------------------------------------------

const NOW_ISO = '2026-04-30T12:00:00.000Z' as Time;
const NOW_MS = Date.parse(NOW_ISO);
const FUTURE_EXPIRY = new Date(NOW_MS + 24 * 60 * 60 * 1000).toISOString() as Time;
const PAST_EXPIRY = new Date(NOW_MS - 1).toISOString() as Time;

function intentApprovePolicyAtom(overrides: {
  allowed_sub_actors?: string[];
} = {}): Atom {
  return {
    schema_version: 1,
    id: 'pol-plan-autonomous-intent-approve' as AtomId,
    content: 'intent approve policy',
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'test', agent_id: 'test' },
      derived_from: [],
    },
    confidence: 1,
    created_at: NOW_ISO,
    last_reinforced_at: NOW_ISO,
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
    principal_id: 'operator' as PrincipalId,
    taint: 'clean',
    metadata: {
      policy: {
        subject: 'plan-autonomous-intent-approve',
        allowed_sub_actors: overrides.allowed_sub_actors ?? ['code-author', 'auditor-actor'],
      },
    },
  };
}

function intentCreationPolicyAtom(overrides: {
  allowed_principal_ids?: string[];
} = {}): Atom {
  return {
    schema_version: 1,
    id: 'pol-operator-intent-creation' as AtomId,
    content: 'intent creation policy',
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'test', agent_id: 'test' },
      derived_from: [],
    },
    confidence: 1,
    created_at: NOW_ISO,
    last_reinforced_at: NOW_ISO,
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
    principal_id: 'operator' as PrincipalId,
    taint: 'clean',
    metadata: {
      policy: {
        subject: 'operator-intent-creation',
        allowed_principal_ids: overrides.allowed_principal_ids ?? ['operator-principal'],
      },
    },
  };
}

function intentAtom(id: string, overrides: {
  principal_id?: string;
  taint?: 'clean' | 'tainted' | 'compromised';
  expires_at?: string;
  max_blast_radius?: string;
  allowed_sub_actors?: string[];
  min_plan_confidence?: number;
  envelopeMissing?: boolean;
} = {}): Atom {
  const trustEnvelope = overrides.envelopeMissing
    ? undefined
    : {
        max_blast_radius: overrides.max_blast_radius ?? 'tooling',
        min_plan_confidence: overrides.min_plan_confidence ?? 0.55,
        allowed_sub_actors: overrides.allowed_sub_actors ?? ['code-author'],
      };
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'intent body',
    type: 'operator-intent',
    layer: 'L1',
    provenance: {
      kind: 'operator-seeded',
      source: { tool: 'intend-cli' },
      derived_from: [],
    },
    confidence: 1,
    created_at: NOW_ISO,
    last_reinforced_at: NOW_ISO,
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
    principal_id: (overrides.principal_id ?? 'operator-principal') as PrincipalId,
    taint: overrides.taint ?? 'clean',
    metadata: {
      ...(trustEnvelope !== undefined ? { trust_envelope: trustEnvelope } : {}),
      expires_at: overrides.expires_at ?? FUTURE_EXPIRY,
    },
  };
}

function planAtom(id: string, intentId: string, overrides: {
  plan_state?: Atom['plan_state'];
  confidence?: number;
  sub_actor?: string;
  implied_blast_radius?: string;
  tainted?: boolean;
  delegationMissing?: boolean;
} = {}): Atom {
  const delegation = overrides.delegationMissing
    ? undefined
    : {
        sub_actor_principal_id: overrides.sub_actor ?? 'code-author',
        implied_blast_radius: overrides.implied_blast_radius ?? 'tooling',
        reason: 'delegated to code-author',
      };
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'plan body',
    type: 'plan',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: 'cto-actor', tool: 'planning-pipeline' },
      derived_from: [intentId as AtomId],
    },
    confidence: overrides.confidence ?? 0.80,
    created_at: NOW_ISO,
    last_reinforced_at: NOW_ISO,
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
    principal_id: 'cto-actor' as PrincipalId,
    taint: overrides.tainted ? 'tainted' : 'clean',
    plan_state: overrides.plan_state ?? 'proposed',
    metadata: {
      title: 'test plan',
      ...(delegation !== undefined ? { delegation } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// evaluatePipelinePlanAutoApproval: pure verdict tests
// ---------------------------------------------------------------------------

const HAPPY_INTENT_APPROVE_POLICY = {
  allowed_sub_actors: ['code-author', 'auditor-actor'],
  atomId: 'pol-plan-autonomous-intent-approve',
} as const;

const HAPPY_INTENT_CREATION_POLICY = {
  allowed_principal_ids: ['operator-principal'],
} as const;

describe('evaluatePipelinePlanAutoApproval (pure)', () => {
  it('returns approved on a fresh intent + matching envelope + matching delegation', () => {
    const intent = intentAtom('intent-1');
    const plan = planAtom('plan-1', 'intent-1', { confidence: 0.80 });
    const verdict = evaluatePipelinePlanAutoApproval({
      plan,
      intent,
      intentApprovePolicy: HAPPY_INTENT_APPROVE_POLICY,
      intentCreationPolicy: HAPPY_INTENT_CREATION_POLICY,
      nowMs: NOW_MS,
    });
    expect(verdict.kind).toBe('approved');
    if (verdict.kind === 'approved') {
      expect(verdict.intentId).toBe('intent-1');
      expect(verdict.policyAtomId).toBe('pol-plan-autonomous-intent-approve');
    }
  });

  it('returns not-eligible when the plan has no operator-intent in provenance', () => {
    const plan = planAtom('plan-1', 'intent-1');
    const verdict = evaluatePipelinePlanAutoApproval({
      plan,
      intent: null,
      intentApprovePolicy: HAPPY_INTENT_APPROVE_POLICY,
      intentCreationPolicy: HAPPY_INTENT_CREATION_POLICY,
      nowMs: NOW_MS,
    });
    expect(verdict.kind).toBe('not-eligible');
  });

  it('rejects a tainted intent', () => {
    const intent = intentAtom('intent-1', { taint: 'tainted' });
    const plan = planAtom('plan-1', 'intent-1');
    const verdict = evaluatePipelinePlanAutoApproval({
      plan,
      intent,
      intentApprovePolicy: HAPPY_INTENT_APPROVE_POLICY,
      intentCreationPolicy: HAPPY_INTENT_CREATION_POLICY,
      nowMs: NOW_MS,
    });
    expect(verdict.kind).toBe('rejected');
    if (verdict.kind === 'rejected') {
      expect(verdict.reason).toBe('tainted-intent');
    }
  });

  it('rejects an expired intent', () => {
    const intent = intentAtom('intent-1', { expires_at: PAST_EXPIRY });
    const plan = planAtom('plan-1', 'intent-1');
    const verdict = evaluatePipelinePlanAutoApproval({
      plan,
      intent,
      intentApprovePolicy: HAPPY_INTENT_APPROVE_POLICY,
      intentCreationPolicy: HAPPY_INTENT_CREATION_POLICY,
      nowMs: NOW_MS,
    });
    expect(verdict.kind).toBe('rejected');
    if (verdict.kind === 'rejected') {
      expect(verdict.reason).toBe('expired-intent');
    }
  });

  it('does NOT reject when intent has no expires_at metadata (permissive parity with intent-approve.ts)', () => {
    // Regression: PR #256 originally fail-closed on missing expires_at,
    // but the canonical single-pass check in intent-approve.ts treats
    // missing expires_at as fresh (only rejects when the string parses
    // as a past timestamp). Operator-intent atoms shipped without
    // metadata.expires_at must be honored by both paths or the
    // substrate splits (dogfeed-5 finding 2026-04-30).
    const intentNoExpiry: Atom = {
      ...intentAtom('intent-1'),
      metadata: {
        trust_envelope: {
          max_blast_radius: 'tooling',
          min_plan_confidence: 0.55,
          allowed_sub_actors: ['code-author'],
        },
        // Note: NO expires_at field
      },
    };
    const plan = planAtom('plan-1', 'intent-1');
    const verdict = evaluatePipelinePlanAutoApproval({
      plan,
      intent: intentNoExpiry,
      intentApprovePolicy: HAPPY_INTENT_APPROVE_POLICY,
      intentCreationPolicy: HAPPY_INTENT_CREATION_POLICY,
      nowMs: NOW_MS,
    });
    // Should pass the expiry gate and proceed to the envelope checks.
    // With the happy fixtures (allowed_sub_actors: ['code-author'],
    // matching delegation), the verdict should be 'approved'.
    expect(verdict.kind).toBe('approved');
  });

  it('does NOT reject when intent has malformed expires_at (permissive parity)', () => {
    // Regression: a non-parseable expires_at string yields Date.parse
    // -> NaN; the canonical check in intent-approve.ts (Date.parse(s) <
    // nowMs) is false for NaN, so the intent is treated as fresh. The
    // pipeline path must match this semantic so no operator-intent atom
    // is rejected on one path but accepted on the other.
    const intentBadExpiry: Atom = {
      ...intentAtom('intent-1'),
      metadata: {
        trust_envelope: {
          max_blast_radius: 'tooling',
          min_plan_confidence: 0.55,
          allowed_sub_actors: ['code-author'],
        },
        expires_at: 'not-a-date',
      },
    };
    const plan = planAtom('plan-1', 'intent-1');
    const verdict = evaluatePipelinePlanAutoApproval({
      plan,
      intent: intentBadExpiry,
      intentApprovePolicy: HAPPY_INTENT_APPROVE_POLICY,
      intentCreationPolicy: HAPPY_INTENT_CREATION_POLICY,
      nowMs: NOW_MS,
    });
    expect(verdict.kind).toBe('approved');
  });

  it('does NOT reject when intent.metadata.expires_at is null (permissive parity)', () => {
    // Regression: explicit null was the original divergence symptom in
    // dogfeed-5: operator-intent atoms whose metadata had expires_at
    // omitted (which serializes as undefined / absent key) flowed
    // cleanly through single-pass but were rejected by the pipeline.
    // typeof null === 'object', so the typeof-string guard suffices.
    const intentNullExpiry: Atom = {
      ...intentAtom('intent-1'),
      metadata: {
        trust_envelope: {
          max_blast_radius: 'tooling',
          min_plan_confidence: 0.55,
          allowed_sub_actors: ['code-author'],
        },
        expires_at: null,
      },
    };
    const plan = planAtom('plan-1', 'intent-1');
    const verdict = evaluatePipelinePlanAutoApproval({
      plan,
      intent: intentNullExpiry,
      intentApprovePolicy: HAPPY_INTENT_APPROVE_POLICY,
      intentCreationPolicy: HAPPY_INTENT_CREATION_POLICY,
      nowMs: NOW_MS,
    });
    expect(verdict.kind).toBe('approved');
  });

  it('rejects an intent from a non-whitelisted principal', () => {
    const intent = intentAtom('intent-1', { principal_id: 'rogue-bot' });
    const plan = planAtom('plan-1', 'intent-1');
    const verdict = evaluatePipelinePlanAutoApproval({
      plan,
      intent,
      intentApprovePolicy: HAPPY_INTENT_APPROVE_POLICY,
      intentCreationPolicy: HAPPY_INTENT_CREATION_POLICY,
      nowMs: NOW_MS,
    });
    expect(verdict.kind).toBe('rejected');
    if (verdict.kind === 'rejected') {
      expect(verdict.reason).toBe('principal-not-whitelisted');
    }
  });

  it('rejects an intent atom of the wrong type', () => {
    const intent: Atom = {
      ...intentAtom('intent-1'),
      type: 'observation',
    };
    const plan = planAtom('plan-1', 'intent-1');
    const verdict = evaluatePipelinePlanAutoApproval({
      plan,
      intent,
      intentApprovePolicy: HAPPY_INTENT_APPROVE_POLICY,
      intentCreationPolicy: HAPPY_INTENT_CREATION_POLICY,
      nowMs: NOW_MS,
    });
    expect(verdict.kind).toBe('rejected');
    if (verdict.kind === 'rejected') {
      expect(verdict.reason).toBe('intent-missing-or-wrong-type');
    }
  });

  it('skips when the intent has no trust_envelope', () => {
    const intent = intentAtom('intent-1', { envelopeMissing: true });
    const plan = planAtom('plan-1', 'intent-1');
    const verdict = evaluatePipelinePlanAutoApproval({
      plan,
      intent,
      intentApprovePolicy: HAPPY_INTENT_APPROVE_POLICY,
      intentCreationPolicy: HAPPY_INTENT_CREATION_POLICY,
      nowMs: NOW_MS,
    });
    expect(verdict.kind).toBe('skipped');
    if (verdict.kind === 'skipped') {
      expect(verdict.reason).toBe(SkipReason.MISSING_TRUST_ENVELOPE);
    }
  });

  it('skips when the plan confidence is below envelope.min_plan_confidence', () => {
    const intent = intentAtom('intent-1', { min_plan_confidence: 0.75 });
    const plan = planAtom('plan-1', 'intent-1', { confidence: 0.60 });
    const verdict = evaluatePipelinePlanAutoApproval({
      plan,
      intent,
      intentApprovePolicy: HAPPY_INTENT_APPROVE_POLICY,
      intentCreationPolicy: HAPPY_INTENT_CREATION_POLICY,
      nowMs: NOW_MS,
    });
    expect(verdict.kind).toBe('skipped');
    if (verdict.kind === 'skipped') {
      expect(verdict.reason).toBe(SkipReason.BELOW_MIN_CONFIDENCE);
      expect(verdict.details['plan_confidence']).toBe(0.60);
      expect(verdict.details['envelope_min_confidence']).toBe(0.75);
    }
  });

  it('skips when the plan has no delegation block', () => {
    const intent = intentAtom('intent-1');
    const plan = planAtom('plan-1', 'intent-1', { delegationMissing: true });
    const verdict = evaluatePipelinePlanAutoApproval({
      plan,
      intent,
      intentApprovePolicy: HAPPY_INTENT_APPROVE_POLICY,
      intentCreationPolicy: HAPPY_INTENT_CREATION_POLICY,
      nowMs: NOW_MS,
    });
    expect(verdict.kind).toBe('skipped');
    if (verdict.kind === 'skipped') {
      expect(verdict.reason).toBe(SkipReason.NO_DELEGATION);
    }
  });

  it('skips when the sub-actor is not in envelope.allowed_sub_actors', () => {
    const intent = intentAtom('intent-1', { allowed_sub_actors: ['auditor-actor'] });
    const plan = planAtom('plan-1', 'intent-1', { sub_actor: 'code-author' });
    const verdict = evaluatePipelinePlanAutoApproval({
      plan,
      intent,
      intentApprovePolicy: HAPPY_INTENT_APPROVE_POLICY,
      intentCreationPolicy: HAPPY_INTENT_CREATION_POLICY,
      nowMs: NOW_MS,
    });
    expect(verdict.kind).toBe('skipped');
    if (verdict.kind === 'skipped') {
      expect(verdict.reason).toBe(SkipReason.SUB_ACTOR_NOT_ALLOWED);
      expect(verdict.details['plan_sub_actor']).toBe('code-author');
    }
  });

  it('skips when the implied_blast_radius is unknown', () => {
    const intent = intentAtom('intent-1');
    const plan = planAtom('plan-1', 'intent-1', { implied_blast_radius: 'stratospheric' });
    const verdict = evaluatePipelinePlanAutoApproval({
      plan,
      intent,
      intentApprovePolicy: HAPPY_INTENT_APPROVE_POLICY,
      intentCreationPolicy: HAPPY_INTENT_CREATION_POLICY,
      nowMs: NOW_MS,
    });
    expect(verdict.kind).toBe('skipped');
    if (verdict.kind === 'skipped') {
      expect(verdict.reason).toBe(SkipReason.RADIUS_UNKNOWN);
    }
  });

  it('skips when the envelope max_blast_radius is unknown', () => {
    const intent = intentAtom('intent-1', { max_blast_radius: 'galactic' });
    const plan = planAtom('plan-1', 'intent-1');
    const verdict = evaluatePipelinePlanAutoApproval({
      plan,
      intent,
      intentApprovePolicy: HAPPY_INTENT_APPROVE_POLICY,
      intentCreationPolicy: HAPPY_INTENT_CREATION_POLICY,
      nowMs: NOW_MS,
    });
    expect(verdict.kind).toBe('skipped');
    if (verdict.kind === 'skipped') {
      expect(verdict.reason).toBe(SkipReason.DELEGATION_RADIUS_UNKNOWN);
    }
  });

  it('skips when plan radius exceeds envelope max_blast_radius', () => {
    const intent = intentAtom('intent-1', { max_blast_radius: 'tooling' });
    const plan = planAtom('plan-1', 'intent-1', { implied_blast_radius: 'framework' });
    const verdict = evaluatePipelinePlanAutoApproval({
      plan,
      intent,
      intentApprovePolicy: HAPPY_INTENT_APPROVE_POLICY,
      intentCreationPolicy: HAPPY_INTENT_CREATION_POLICY,
      nowMs: NOW_MS,
    });
    expect(verdict.kind).toBe('skipped');
    if (verdict.kind === 'skipped') {
      expect(verdict.reason).toBe(SkipReason.DELEGATION_RADIUS_EXCEEDS_ENVELOPE);
    }
  });

  it('rejects when the intent-approve policy atom is missing (atomId === null)', () => {
    const intent = intentAtom('intent-1');
    const plan = planAtom('plan-1', 'intent-1');
    const verdict = evaluatePipelinePlanAutoApproval({
      plan,
      intent,
      intentApprovePolicy: { allowed_sub_actors: ['code-author'], atomId: null },
      intentCreationPolicy: HAPPY_INTENT_CREATION_POLICY,
      nowMs: NOW_MS,
    });
    expect(verdict.kind).toBe('rejected');
    if (verdict.kind === 'rejected') {
      expect(verdict.reason).toBe('intent-missing-or-wrong-type');
    }
  });

  it('skips when the sub-actor is not in the policy allowlist (org-wide ceiling)', () => {
    // Envelope allows code-author, but org-wide policy only allows auditor-actor
    const intent = intentAtom('intent-1', { allowed_sub_actors: ['code-author'] });
    const plan = planAtom('plan-1', 'intent-1', { sub_actor: 'code-author' });
    const verdict = evaluatePipelinePlanAutoApproval({
      plan,
      intent,
      intentApprovePolicy: {
        allowed_sub_actors: ['auditor-actor'],
        atomId: 'pol-plan-autonomous-intent-approve',
      },
      intentCreationPolicy: HAPPY_INTENT_CREATION_POLICY,
      nowMs: NOW_MS,
    });
    expect(verdict.kind).toBe('skipped');
    if (verdict.kind === 'skipped') {
      expect(verdict.reason).toBe(SkipReason.SUB_ACTOR_NOT_ALLOWED);
      expect(verdict.details['policy_allowed_sub_actors']).toEqual(['auditor-actor']);
    }
  });

  it('rejects prototype-chain radius keys (Object.hasOwn guard)', () => {
    const intent = intentAtom('intent-1');
    // Prototype-chain key: 'toString' is on Object.prototype but not own
    const plan = planAtom('plan-1', 'intent-1', { implied_blast_radius: 'toString' });
    const verdict = evaluatePipelinePlanAutoApproval({
      plan,
      intent,
      intentApprovePolicy: HAPPY_INTENT_APPROVE_POLICY,
      intentCreationPolicy: HAPPY_INTENT_CREATION_POLICY,
      nowMs: NOW_MS,
    });
    expect(verdict.kind).toBe('skipped');
    if (verdict.kind === 'skipped') {
      expect(verdict.reason).toBe(SkipReason.RADIUS_UNKNOWN);
    }
  });

  // -------------------------------------------------------------------------
  // Byte-for-byte parity with intent-approve.ts expiry semantics.
  //
  // The canonical single-pass tick at
  // src/runtime/actor-message/intent-approve.ts uses:
  //
  //   const expiresRaw = (intent.metadata as Record<string, unknown>)
  //     ?.expires_at;
  //   if (typeof expiresRaw === 'string' && Date.parse(expiresRaw) < nowMs) {
  //     rejected++;
  //     continue;
  //   }
  //
  // The deep-pipeline path MUST behave identically on every (expiresRaw,
  // nowMs) pair so an operator-intent atom is never accepted by one
  // path and rejected by the other (substrate divergence). This table
  // pins the truth values; any future drift trips here.
  // -------------------------------------------------------------------------
  describe('expiry-semantic parity with intent-approve.ts', () => {
    const expiryParityTable: ReadonlyArray<{
      readonly label: string;
      readonly expires_at: unknown;
      readonly expectsRejection: boolean;
    }> = [
      // Past timestamp: rejected on both paths.
      { label: 'past ISO timestamp string', expires_at: PAST_EXPIRY, expectsRejection: true },
      // Future timestamp: accepted on both paths.
      { label: 'future ISO timestamp string', expires_at: FUTURE_EXPIRY, expectsRejection: false },
      // Field missing: typeof undefined !== 'string' -> permissive on both.
      { label: 'undefined (field absent)', expires_at: undefined, expectsRejection: false },
      // Explicit null: typeof null !== 'string' -> permissive on both.
      { label: 'null', expires_at: null, expectsRejection: false },
      // Non-string scalar: typeof number !== 'string' -> permissive on both.
      { label: 'number (non-string scalar)', expires_at: 0, expectsRejection: false },
      // Malformed string: Date.parse -> NaN; NaN < nowMs is false -> permissive on both.
      { label: 'malformed string', expires_at: 'not-a-date', expectsRejection: false },
      // Empty string: Date.parse -> NaN -> permissive on both.
      { label: 'empty string', expires_at: '', expectsRejection: false },
    ];

    for (const row of expiryParityTable) {
      it(`mirrors intent-approve.ts on ${row.label}`, () => {
        const intent: Atom = {
          ...intentAtom('intent-1'),
          metadata: {
            trust_envelope: {
              max_blast_radius: 'tooling',
              min_plan_confidence: 0.55,
              allowed_sub_actors: ['code-author'],
            },
            ...(row.expires_at === undefined ? {} : { expires_at: row.expires_at }),
          },
        };
        const plan = planAtom('plan-1', 'intent-1');
        const verdict = evaluatePipelinePlanAutoApproval({
          plan,
          intent,
          intentApprovePolicy: HAPPY_INTENT_APPROVE_POLICY,
          intentCreationPolicy: HAPPY_INTENT_CREATION_POLICY,
          nowMs: NOW_MS,
        });
        if (row.expectsRejection) {
          expect(verdict.kind).toBe('rejected');
          if (verdict.kind === 'rejected') {
            expect(verdict.reason).toBe('expired-intent');
          }
        } else {
          // Permissive path: must NOT be 'rejected' with reason
          // 'expired-intent'. The exact downstream verdict is
          // 'approved' under the happy fixtures.
          expect(verdict.kind).toBe('approved');
        }
      });
    }
  });
});

// ---------------------------------------------------------------------------
// runPipelinePlanAutoApproval: host-side wrapper tests
// ---------------------------------------------------------------------------

describe('runPipelinePlanAutoApproval', () => {
  it('approves a plan whose envelope matches and stamps approval metadata', async () => {
    const host = createMemoryHost();
    await host.atoms.put(intentApprovePolicyAtom());
    await host.atoms.put(intentCreationPolicyAtom());
    await host.atoms.put(intentAtom('intent-1'));
    await host.atoms.put(planAtom('plan-1', 'intent-1', { confidence: 0.80 }));

    const result = await runPipelinePlanAutoApproval(
      host,
      ['plan-1' as AtomId],
      { now: () => NOW_ISO },
    );
    expect(result.considered).toBe(1);
    expect(result.approved).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.rejected).toBe(0);
    expect(result.notEligible).toBe(0);

    const plan = await host.atoms.get('plan-1' as AtomId);
    expect(plan?.plan_state).toBe('approved');
    const meta = plan?.metadata as Record<string, unknown>;
    expect(meta['approved_via']).toBe('pol-plan-autonomous-intent-approve');
    expect(meta['approved_intent_id']).toBe('intent-1');
    expect(typeof meta['approved_at']).toBe('string');

    const events = await host.auditor.query({ kind: ['plan.approved-by-intent'] }, 10);
    expect(events.length).toBe(1);
    expect(events[0]?.details['plan_id']).toBe('plan-1');
    expect(events[0]?.details['source']).toBe('planning-pipeline');
  });

  it('halts on kill-switch trip without approving anything', async () => {
    const host = createMemoryHost();
    await host.atoms.put(intentApprovePolicyAtom());
    await host.atoms.put(intentCreationPolicyAtom());
    await host.atoms.put(intentAtom('intent-1'));
    await host.atoms.put(planAtom('plan-1', 'intent-1'));

    host.scheduler.kill();

    const result = await runPipelinePlanAutoApproval(
      host,
      ['plan-1' as AtomId],
      { now: () => NOW_ISO },
    );
    expect(result.approved).toBe(0);
    expect(result.considered).toBe(0);

    const plan = await host.atoms.get('plan-1' as AtomId);
    expect(plan?.plan_state).toBe('proposed');
  });

  it('returns notEligible when the policy atom is absent (fail-closed)', async () => {
    const host = createMemoryHost();
    // No intentApprovePolicyAtom -> empty allowlist -> short-circuit
    await host.atoms.put(intentCreationPolicyAtom());
    await host.atoms.put(intentAtom('intent-1'));
    await host.atoms.put(planAtom('plan-1', 'intent-1'));

    const result = await runPipelinePlanAutoApproval(
      host,
      ['plan-1' as AtomId],
      { now: () => NOW_ISO },
    );
    expect(result.considered).toBe(1);
    expect(result.notEligible).toBe(1);
    expect(result.approved).toBe(0);

    const plan = await host.atoms.get('plan-1' as AtomId);
    expect(plan?.plan_state).toBe('proposed');
  });

  it('returns notEligible when the policy allowlist is empty (fail-closed)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(intentApprovePolicyAtom({ allowed_sub_actors: [] }));
    await host.atoms.put(intentCreationPolicyAtom());
    await host.atoms.put(intentAtom('intent-1'));
    await host.atoms.put(planAtom('plan-1', 'intent-1'));

    const result = await runPipelinePlanAutoApproval(
      host,
      ['plan-1' as AtomId],
      { now: () => NOW_ISO },
    );
    expect(result.considered).toBe(1);
    expect(result.notEligible).toBe(1);
    expect(result.approved).toBe(0);

    const plan = await host.atoms.get('plan-1' as AtomId);
    expect(plan?.plan_state).toBe('proposed');
  });

  it('logs a skip event when the envelope mismatches and leaves the plan proposed', async () => {
    const host = createMemoryHost();
    await host.atoms.put(intentApprovePolicyAtom());
    await host.atoms.put(intentCreationPolicyAtom());
    await host.atoms.put(intentAtom('intent-1', { min_plan_confidence: 0.95 }));
    await host.atoms.put(planAtom('plan-1', 'intent-1', { confidence: 0.50 }));

    const result = await runPipelinePlanAutoApproval(
      host,
      ['plan-1' as AtomId],
      { now: () => NOW_ISO },
    );
    expect(result.skipped).toBe(1);
    expect(result.approved).toBe(0);

    const plan = await host.atoms.get('plan-1' as AtomId);
    expect(plan?.plan_state).toBe('proposed');

    const events = await host.auditor.query({ kind: ['plan.skipped-by-intent'] }, 10);
    expect(events.length).toBe(1);
    expect(events[0]?.details['reason']).toBe(SkipReason.BELOW_MIN_CONFIDENCE);
    expect(events[0]?.details['source']).toBe('planning-pipeline');
  });

  it('logs a reject event for an expired intent', async () => {
    const host = createMemoryHost();
    await host.atoms.put(intentApprovePolicyAtom());
    await host.atoms.put(intentCreationPolicyAtom());
    await host.atoms.put(intentAtom('intent-1', { expires_at: PAST_EXPIRY }));
    await host.atoms.put(planAtom('plan-1', 'intent-1'));

    const result = await runPipelinePlanAutoApproval(
      host,
      ['plan-1' as AtomId],
      { now: () => NOW_ISO },
    );
    expect(result.rejected).toBe(1);
    expect(result.approved).toBe(0);

    const plan = await host.atoms.get('plan-1' as AtomId);
    expect(plan?.plan_state).toBe('proposed');

    const events = await host.auditor.query({ kind: ['plan.rejected-by-intent'] }, 10);
    expect(events.length).toBe(1);
    expect(events[0]?.details['reason']).toBe('expired-intent');
  });

  it('treats a plan without an operator-intent in provenance as not-eligible (silent)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(intentApprovePolicyAtom());
    await host.atoms.put(intentCreationPolicyAtom());
    // Plan exists but its derived_from cites no operator-intent atom.
    const plan: Atom = {
      ...planAtom('plan-1', 'intent-1'),
      provenance: {
        kind: 'agent-observed',
        source: { agent_id: 'cto-actor', tool: 'planning-pipeline' },
        derived_from: ['dev-canon-foo' as AtomId],
      },
    };
    await host.atoms.put(plan);

    const result = await runPipelinePlanAutoApproval(
      host,
      ['plan-1' as AtomId],
      { now: () => NOW_ISO },
    );
    expect(result.notEligible).toBe(1);
    expect(result.approved).toBe(0);

    // No audit events: not-eligible plans are silent (matches intent-approve.ts).
    const events = await host.auditor.query(
      { kind: ['plan.skipped-by-intent', 'plan.rejected-by-intent', 'plan.approved-by-intent'] },
      10,
    );
    expect(events.length).toBe(0);
  });

  it('returns zero counts on an empty input list', async () => {
    const host = createMemoryHost();
    await host.atoms.put(intentApprovePolicyAtom());
    await host.atoms.put(intentCreationPolicyAtom());
    const result = await runPipelinePlanAutoApproval(host, [], { now: () => NOW_ISO });
    expect(result).toEqual({
      considered: 0,
      approved: 0,
      skipped: 0,
      rejected: 0,
      notEligible: 0,
    });
  });

  it('counts a missing plan atom as not-eligible (claim-before-mutate guard)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(intentApprovePolicyAtom());
    await host.atoms.put(intentCreationPolicyAtom());
    // Plan id passed in but never persisted.
    const result = await runPipelinePlanAutoApproval(
      host,
      ['plan-ghost' as AtomId],
      { now: () => NOW_ISO },
    );
    expect(result.notEligible).toBe(1);
    expect(result.approved).toBe(0);
  });

  it('counts an already-approved plan as not-eligible (idempotent re-run)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(intentApprovePolicyAtom());
    await host.atoms.put(intentCreationPolicyAtom());
    await host.atoms.put(intentAtom('intent-1'));
    await host.atoms.put(planAtom('plan-1', 'intent-1', { plan_state: 'approved' }));

    const result = await runPipelinePlanAutoApproval(
      host,
      ['plan-1' as AtomId],
      { now: () => NOW_ISO },
    );
    expect(result.notEligible).toBe(1);
    expect(result.approved).toBe(0);
  });

  it('does not approve a plan superseded between candidate-pickup and the claim read', async () => {
    const host = createMemoryHost();
    await host.atoms.put(intentApprovePolicyAtom());
    await host.atoms.put(intentCreationPolicyAtom());
    await host.atoms.put(intentAtom('intent-1'));
    // Pre-supersede the plan: a peer revoked it before this tick ran.
    // The claim read MUST notice and skip rather than revive the
    // revoked atom by stamping plan_state='approved'.
    await host.atoms.put({
      ...planAtom('plan-1', 'intent-1'),
      superseded_by: ['plan-2' as AtomId],
    });

    const result = await runPipelinePlanAutoApproval(
      host,
      ['plan-1' as AtomId],
      { now: () => NOW_ISO },
    );
    // Initial filter catches the supersession at first read; it counts
    // as notEligible. The second-read guard at claim time backstops the
    // race window; this test exercises the upfront filter, and the
    // claim-time guard is exercised by the runner integration tests
    // (the substrate cannot create a real pickup-then-supersede race
    // without an external concurrent writer).
    expect(result.notEligible).toBe(1);
    expect(result.approved).toBe(0);

    const plan = await host.atoms.get('plan-1' as AtomId);
    expect(plan?.plan_state).toBe('proposed');
  });

  it('approves multiple plans in a single call', async () => {
    const host = createMemoryHost();
    await host.atoms.put(intentApprovePolicyAtom());
    await host.atoms.put(intentCreationPolicyAtom());
    await host.atoms.put(intentAtom('intent-1'));
    await host.atoms.put(planAtom('plan-1', 'intent-1'));
    await host.atoms.put(planAtom('plan-2', 'intent-1'));
    await host.atoms.put(planAtom('plan-3', 'intent-1'));

    const result = await runPipelinePlanAutoApproval(
      host,
      ['plan-1' as AtomId, 'plan-2' as AtomId, 'plan-3' as AtomId],
      { now: () => NOW_ISO },
    );
    expect(result.considered).toBe(3);
    expect(result.approved).toBe(3);

    for (const id of ['plan-1', 'plan-2', 'plan-3']) {
      const plan = await host.atoms.get(id as AtomId);
      expect(plan?.plan_state).toBe('approved');
    }
  });
});
