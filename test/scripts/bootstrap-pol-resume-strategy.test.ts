/**
 * Drift tests for scripts/bootstrap-pol-resume-strategy.mjs.
 *
 * The POLICIES array (built via buildPolicies) seeds the L3 directive
 * atom `pol-resume-strategy-pr-fix-actor` whose runtime behavior is
 * consumed by `wrapAgentLoopAdapterIfEnabled` in
 * `examples/agent-loops/resume-author/registry.ts` and validated
 * against `resumeStrategyPolicySchema` (Zod) at canon-read time.
 * Keeping seed and registry validator in sync is load-bearing: a
 * deployment that runs this seed must produce a payload the registry
 * accepts; a silent divergence (e.g. seed adds a `kill_switch` field
 * the schema rejects) means the policy the operator thinks they have
 * differs from what runs.
 *
 * These tests lock the two together. A drift is a test failure, not a
 * silent runtime surprise.
 *
 * Covers:
 *   - buildPolicies returns the expected stable set of ids.
 *   - pol-resume-strategy-pr-fix-actor.content matches the schema.
 *   - The seeded `enabled: true` matches PR #171's hard-coded posture.
 *   - policyAtom() shape is a well-formed L3 directive.
 *   - File-host round-trip (put + get) preserves every field.
 *   - Idempotency: the same buildPolicies output is byte-identical
 *     across calls (no Date.now() / Math.random() leakage).
 *   - First-write writes the atom; second-write with same shape is a
 *     no-op (idempotency); writes with drifted shape fail loud.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildPolicies,
  diffPolicyAtom,
  policyAtom,
} from '../../scripts/lib/resume-strategy-canon-policies.mjs';
import { resumeStrategyPolicySchema } from '../../examples/agent-loops/resume-author/registry.js';
import { createFileHost } from '../../src/adapters/file/index.js';

const OP = 'test-operator';

/**
 * Helper: spin up a temp-dir + file-host, run the test body, and
 * unconditionally clean up the temp dir. Three test bodies share the
 * same mkdtempSync + createFileHost + rmSync scaffolding; extracting
 * at N=2 per `dev-extract-helpers-at-n-2` keeps each test focused on
 * its own put/get/assert sequence rather than the boilerplate.
 */
async function withTempFileHost(
  fn: (host: Awaited<ReturnType<typeof createFileHost>>) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lag-bootstrap-resume-strategy-'));
  try {
    const host = await createFileHost({ rootDir: dir });
    await fn(host);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('bootstrap-pol-resume-strategy POLICIES', () => {
  it('returns the expected stable set of policy ids', () => {
    const policies = buildPolicies(OP);
    const ids = policies.map((p: { id: string }) => p.id).sort();
    // v1 minimal seed: pr-fix-actor only (cto-actor + code-author
    // ship absent per spec section 5.2).
    expect(ids).toEqual(['pol-resume-strategy-pr-fix-actor']);
  });

  it('pol-resume-strategy-pr-fix-actor.content satisfies the Zod schema', () => {
    // Drift guard: if buildPolicies produces a content shape the
    // registry's Zod schema rejects, the bootstrap would write an
    // atom that the consumer would treat as malformed (fail-closed
    // -> fresh-spawn). This test catches that mismatch before
    // landing.
    const policies = buildPolicies(OP);
    const spec = policies.find(
      (p: { id: string }) => p.id === 'pol-resume-strategy-pr-fix-actor',
    );
    expect(spec).toBeDefined();
    const content = (spec! as { content: unknown }).content;
    const parsed = resumeStrategyPolicySchema.safeParse(content);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.enabled).toBe(true);
      expect(parsed.data.max_stale_hours).toBe(8);
      expect(parsed.data.fresh_spawn_kinds).toEqual([
        'budget-exhausted',
        'stale-window-exceeded',
        'workspace-unrecoverable',
        'operator-reset',
      ]);
    }
  });

  it('pol-resume-strategy-pr-fix-actor preserves PR #171 behavior (enabled=true, 8h window)', () => {
    // Per spec section 11.3 acceptance: the seed mirrors
    // run-pr-fix.mjs + SameMachineCliResumeStrategy(maxStaleHours: 8).
    // Removing the seeded atom flips PR-fix back to fresh-spawn; the
    // seeded posture is "resume on with PR #171's window."
    const policies = buildPolicies(OP);
    const spec = policies.find(
      (p: { id: string }) => p.id === 'pol-resume-strategy-pr-fix-actor',
    );
    expect(spec).toBeDefined();
    const content = (spec! as { content: { enabled: boolean; max_stale_hours: number } }).content;
    expect(content.enabled).toBe(true);
    expect(content.max_stale_hours).toBe(8);
  });

  it('policyAtom emits a well-formed L3 directive with metadata.policy.subject and content', () => {
    const policies = buildPolicies(OP);
    const spec = policies[0]!;
    const atom = policyAtom(spec, OP);
    expect(atom.id).toBe('pol-resume-strategy-pr-fix-actor');
    expect(atom.type).toBe('directive');
    expect(atom.layer).toBe('L3');
    expect(atom.principal_id).toBe(OP);
    expect(atom.taint).toBe('clean');
    expect(atom.scope).toBe('project');
    expect(atom.confidence).toBe(1.0);
    expect(atom.supersedes).toEqual([]);
    expect(atom.superseded_by).toEqual([]);
    expect(atom.provenance.kind).toBe('operator-seeded');
    const meta = atom.metadata as {
      policy: {
        subject: string;
        principal_id: string;
        content: { enabled: boolean; max_stale_hours: number };
      };
    };
    expect(meta.policy.subject).toBe('resume-strategy');
    expect(meta.policy.principal_id).toBe('pr-fix-actor');
    expect(meta.policy.content.enabled).toBe(true);
    expect(meta.policy.content.max_stale_hours).toBe(8);
  });

  it('rebuild is byte-identical (deterministic, no Date.now / Math.random leakage)', () => {
    const a = policyAtom(buildPolicies(OP)[0]!, OP);
    const b = policyAtom(buildPolicies(OP)[0]!, OP);
    expect(a).toEqual(b);
  });
});

describe('bootstrap-pol-resume-strategy idempotency (smoke)', () => {
  it('writing then diffing the new policy against a fresh host is in-sync', () => withTempFileHost(async (host) => {
    // Smoke: the policyAtom output must match itself through a
    // put/get round-trip via the file-backed host. If the file
    // adapter's serialization drops a field (e.g. nested
    // metadata.policy.content), the get returns a different shape
    // and this test fails.
    const policies = buildPolicies(OP);
    const spec = policies[0]!;
    const expected = policyAtom(spec, OP);
    await host.atoms.put(expected);

    const stored = await host.atoms.get(expected.id);
    expect(stored).not.toBeNull();
    // Compare the fields the bootstrap diffPolicyAtom() checks.
    expect(stored!.type).toBe(expected.type);
    expect(stored!.layer).toBe(expected.layer);
    expect(stored!.principal_id).toBe(expected.principal_id);
    expect(stored!.metadata.policy).toEqual(expected.metadata.policy);

    // The schema-validated content shape must survive the round-trip;
    // the registry reads metadata.policy.content via the Zod
    // schema, so a serialization drop here would make the runtime
    // fail-closed silently.
    const storedContent = (stored!.metadata as { policy: { content: unknown } }).policy.content;
    const parsed = resumeStrategyPolicySchema.safeParse(storedContent);
    expect(parsed.success).toBe(true);

    // diffPolicyAtom against the round-tripped atom returns []: the
    // stored shape exactly matches the seeded shape (no drift).
    expect(diffPolicyAtom(stored!, expected)).toEqual([]);
  }));

  it('first run writes the atom; second run with same shape is a no-op', () => withTempFileHost(async (host) => {
    // Idempotency: a re-run after a successful first run must NOT
    // throw, must NOT write a duplicate atom (file-host put on
    // existing id throws ConflictError, which would surface here),
    // and must surface "already in sync" via the existing-atom
    // check. We simulate the bootstrap's main() loop here without
    // spawning a child Node process.
    const policies = buildPolicies(OP);
    const spec = policies[0]!;
    const expected = policyAtom(spec, OP);

    // First run.
    const firstExisting = await host.atoms.get(expected.id);
    expect(firstExisting).toBeNull();
    await host.atoms.put(expected);

    // Second run: get returns the stored atom, and content matches.
    const secondExisting = await host.atoms.get(expected.id);
    expect(secondExisting).not.toBeNull();
    expect(secondExisting!.metadata.policy).toEqual(expected.metadata.policy);
    // diffPolicyAtom returns [] for the second-run case (the
    // bootstrap script's main() loop reads this empty list as
    // "already in sync").
    expect(diffPolicyAtom(secondExisting!, expected)).toEqual([]);
  }));

  it('drift detection: diffPolicyAtom surfaces a non-empty diff for drifted content', () => withTempFileHost(async (host) => {
    // Exercise the drift-detection arm of main() directly: plant a
    // drifted atom in the host, then assert diffPolicyAtom (the
    // function the bootstrap script's main() loop calls) returns a
    // non-empty diff list. Without this, the test would only verify
    // the file host's round-trip behavior; importing the actual
    // diffPolicyAtom and asserting on its output ties the test to
    // the real drift-detection contract.
    const policies = buildPolicies(OP);
    const spec = policies[0]!;
    const expected = policyAtom(spec, OP);

    // Plant a drifted atom: same id, different enabled flag.
    const drifted = {
      ...expected,
      metadata: {
        ...expected.metadata,
        policy: {
          ...(expected.metadata as { policy: Record<string, unknown> }).policy,
          content: {
            enabled: false,
            max_stale_hours: 8,
            fresh_spawn_kinds: [
              'budget-exhausted',
              'stale-window-exceeded',
              'workspace-unrecoverable',
              'operator-reset',
            ],
          },
        },
      },
    };
    await host.atoms.put(drifted);

    const stored = await host.atoms.get(expected.id);
    expect(stored).not.toBeNull();

    // The drift detector returns a non-empty list for a content
    // mismatch. Specifically, the policy.content key differs
    // (stored has enabled=false, expected has enabled=true) so the
    // diff must mention that key.
    const diffs = diffPolicyAtom(stored!, expected);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.some((d: string) => d.includes('policy.content'))).toBe(true);
  }));
});
