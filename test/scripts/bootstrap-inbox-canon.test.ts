/**
 * Drift tests for scripts/bootstrap-inbox-canon.mjs.
 *
 * The POLICIES array (built via buildPolicies) seeds L3 directive
 * atoms that consumers in the runtime tree fall back to when a
 * policy atom is missing. Keeping the seed and the runtime fallback
 * aligned is load-bearing: a deployment that never runs the bootstrap
 * script gets the runtime fallback at every tick, and a silent
 * divergence (e.g. seed says min_votes=2 but the runtime fallback
 * drifted to 3) means the policy the operator thinks they have
 * differs from what actually runs.
 *
 * These tests lock the two together. A drift is a test failure, not
 * a silent runtime surprise.
 *
 * Covers:
 *   - buildPolicies returns the expected stable set of ids.
 *   - pol-plan-multi-reviewer-approval: every field in policy.fields
 *     matches FALLBACK_PLAN_APPROVAL from the runtime, key-by-key.
 *   - policyAtom() shape is a well-formed L3 directive with
 *     metadata.policy.subject set correctly.
 *   - Idempotency smoke: round-tripping the policy atom through a
 *     file-backed host preserves every field.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildPolicies,
  policyAtom,
} from '../../scripts/lib/inbox-canon-policies.mjs';
import { FALLBACK_PLAN_APPROVAL } from '../../src/runtime/actor-message/plan-approval.js';
import { createFileHost } from '../../src/adapters/file/index.js';

const OP = 'test-operator';

describe('bootstrap-inbox-canon POLICIES', () => {
  it('returns the expected stable set of policy ids', () => {
    const policies = buildPolicies(OP);
    const ids = policies.map((p) => p.id).sort();
    expect(ids).toEqual([
      'pol-actor-message-circuit-breaker',
      'pol-actor-message-rate',
      'pol-circuit-breaker-reset-authority',
      'pol-inbox-ordering',
      'pol-inbox-poll-cadence',
      'pol-judgment-fallback-ladder',
      'pol-plan-auto-approve-low-stakes',
      'pol-plan-multi-reviewer-approval',
      'pol-pr-observation-freshness-threshold-ms',
    ]);
  });

  it('pol-plan-multi-reviewer-approval fields match FALLBACK_PLAN_APPROVAL exactly', () => {
    // Drift guard: if someone edits POLICIES[] OR
    // FALLBACK_PLAN_APPROVAL in isolation, this test catches it
    // before a tenant's runtime diverges from their seeded canon.
    // Every field enumerated in FALLBACK_PLAN_APPROVAL is asserted
    // against the seed; the policy.subject is also fixed to the
    // value that runPlanApprovalTick discriminates on.
    const policies = buildPolicies(OP);
    const spec = policies.find((p) => p.id === 'pol-plan-multi-reviewer-approval');
    expect(spec).toBeDefined();
    expect(spec!.subject).toBe('plan-multi-reviewer-approval');
    const fields = spec!.fields;
    expect(fields.allowed_sub_actors).toEqual([...FALLBACK_PLAN_APPROVAL.allowed_sub_actors, 'code-author']);
    // Distinct seed choice: seed widens allowlist from empty -> ['code-author'].
    // Every OTHER field must match the fallback key-by-key.
    expect(fields.min_votes).toBe(FALLBACK_PLAN_APPROVAL.min_votes);
    expect(fields.min_vote_confidence).toBe(FALLBACK_PLAN_APPROVAL.min_vote_confidence);
    expect(fields.min_plan_confidence).toBe(FALLBACK_PLAN_APPROVAL.min_plan_confidence);
    expect(fields.required_roles).toEqual([...FALLBACK_PLAN_APPROVAL.required_roles]);
    expect(fields.hard_reject_on_any_reject).toBe(FALLBACK_PLAN_APPROVAL.hard_reject_on_any_reject);
    expect(fields.max_age_ms).toBe(FALLBACK_PLAN_APPROVAL.max_age_ms);
  });

  it('policyAtom emits a well-formed L3 directive with subject in metadata.policy', () => {
    const policies = buildPolicies(OP);
    const spec = policies.find((p) => p.id === 'pol-plan-multi-reviewer-approval')!;
    const atom = policyAtom(spec, OP);
    expect(atom.type).toBe('directive');
    expect(atom.layer).toBe('L3');
    expect(atom.principal_id).toBe(OP);
    expect(atom.taint).toBe('clean');
    expect(atom.superseded_by).toEqual([]);
    expect(atom.metadata.policy.subject).toBe('plan-multi-reviewer-approval');
    // Canon directives must have content, a provenance chain, and a
    // non-null created_at; the bootstrap reason is the human-reading
    // rationale rendered into CLAUDE.md.
    expect(atom.content.length).toBeGreaterThan(50);
    expect(atom.provenance.kind).toBe('operator-seeded');
    expect(atom.created_at).toBeTruthy();
  });
});

describe('bootstrap-inbox-canon idempotency (smoke)', () => {
  it('writing then diffing the new policy against a fresh host is in-sync', async () => {
    // Smoke: the policyAtom output must match itself through a
    // put/get round-trip. This is the minimal subset of the
    // bootstrap script's main() diff check; without a full
    // LAG_OPERATOR_ID + script spawn, we verify the atom shape
    // survives the file-host write and the POLICIES payload is
    // stable between runs.
    const dir = mkdtempSync(join(tmpdir(), 'lag-bootstrap-drift-'));
    try {
      const host = await createFileHost({ rootDir: dir });
      const policies = buildPolicies(OP);
      const spec = policies.find((p) => p.id === 'pol-plan-multi-reviewer-approval')!;
      const expected = policyAtom(spec, OP);
      await host.atoms.put(expected);

      const stored = await host.atoms.get(expected.id);
      expect(stored).not.toBeNull();
      // Compare the fields the bootstrap diffPolicyAtom() checks.
      // If the stored atom's metadata.policy diverges from the
      // expected shape (e.g. a file-adapter serialization bug
      // dropped a field), this catches it.
      expect(stored!.type).toBe(expected.type);
      expect(stored!.layer).toBe(expected.layer);
      expect(stored!.principal_id).toBe(expected.principal_id);
      expect(stored!.metadata.policy).toEqual(expected.metadata.policy);

      // Rebuild from the factory; should be byte-identical to the
      // first build (deterministic, no Date.now() or Math.random()).
      const rebuilt = policyAtom(
        buildPolicies(OP).find((p) => p.id === 'pol-plan-multi-reviewer-approval')!,
        OP,
      );
      expect(rebuilt).toEqual(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
