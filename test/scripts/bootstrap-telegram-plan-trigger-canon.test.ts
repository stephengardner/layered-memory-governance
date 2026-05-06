/**
 * Drift tests for scripts/bootstrap-telegram-plan-trigger-canon.mjs.
 *
 * The POLICIES array (built via buildPolicies) seeds the L3 directive
 * atom `pol-telegram-plan-trigger-principals-default` whose runtime
 * behavior is consumed by `readPlanTriggerAllowlist` in
 * src/runtime/loop/telegram-plan-trigger-allowlist.ts and
 * fall-through-validated against `DEFAULT_PRINCIPAL_ALLOWLIST` in
 * the same module. Keeping seed and runtime fallback in sync is
 * load-bearing: a deployment that never runs the bootstrap gets the
 * runtime fallback at every tick, and a silent divergence means the
 * policy the operator thinks they have differs from what runs.
 *
 * These tests lock the two together. A drift is a test failure, not
 * a silent runtime surprise. Mirrors test/scripts/bootstrap-reaper-
 * canon.test.ts.
 */

import { describe, expect, it } from 'vitest';

import {
  buildPolicies,
  policyAtom,
} from '../../scripts/lib/telegram-plan-trigger-canon-policies.mjs';
import { DEFAULT_PRINCIPAL_ALLOWLIST } from '../../src/runtime/loop/telegram-plan-trigger-allowlist.js';

const OP = 'test-operator';

describe('bootstrap-telegram-plan-trigger-canon POLICIES', () => {
  it('returns the expected stable set of policy ids', () => {
    const policies = buildPolicies(OP);
    const ids = policies.map((p: { id: string }) => p.id).sort();
    expect(ids).toEqual(['pol-telegram-plan-trigger-principals-default']);
  });

  it('default principal_ids match DEFAULT_PRINCIPAL_ALLOWLIST exactly', () => {
    // Drift guard: if someone edits buildPolicies OR
    // DEFAULT_PRINCIPAL_ALLOWLIST in isolation, this test catches it
    // before a tenant's runtime diverges from their seeded canon.
    const policies = buildPolicies(OP);
    const spec = policies.find(
      (p: { id: string }) => p.id === 'pol-telegram-plan-trigger-principals-default',
    );
    expect(spec).toBeDefined();
    expect(spec!.subject).toBe('telegram-plan-trigger-principals');
    const fields = spec!.fields as { principal_ids: ReadonlyArray<string> };
    expect(fields.principal_ids).toEqual([...DEFAULT_PRINCIPAL_ALLOWLIST]);
  });

  it('policyAtom shape is a well-formed L3 directive with metadata.policy', () => {
    const policies = buildPolicies(OP);
    const spec = policies[0]!;
    const atom = policyAtom(spec, OP);
    expect(atom.id).toBe('pol-telegram-plan-trigger-principals-default');
    expect(atom.type).toBe('directive');
    expect(atom.layer).toBe('L3');
    expect(atom.principal_id).toBe(OP);
    expect(atom.taint).toBe('clean');
    expect(atom.scope).toBe('project');
    expect(atom.confidence).toBe(1.0);
    expect(atom.supersedes).toEqual([]);
    expect(atom.superseded_by).toEqual([]);
    expect(atom.provenance.kind).toBe('operator-seeded');
    // Pin the full integrity surface (provenance.source +
    // derived_from) so a re-attribution under unchanged policy
    // fields is still flagged as drift. The bootstrap's
    // diffPolicyAtom compares the same surfaces; this test pins
    // the seed end of that comparison so the seed and the diff
    // logic cannot drift apart silently.
    expect(JSON.stringify(atom.provenance.source)).toBe(
      JSON.stringify({
        session_id: 'bootstrap-telegram-plan-trigger',
        agent_id: 'bootstrap',
      }),
    );
    expect(atom.provenance.derived_from).toEqual([]);
    const meta = atom.metadata as {
      policy: { subject: string; principal_ids: ReadonlyArray<string> };
    };
    expect(meta.policy.subject).toBe('telegram-plan-trigger-principals');
    expect(meta.policy.principal_ids).toEqual([...DEFAULT_PRINCIPAL_ALLOWLIST]);
  });
});
