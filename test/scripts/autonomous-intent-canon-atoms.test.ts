/**
 * Drift tests for scripts/lib/autonomous-intent-canon-atoms.mjs.
 *
 * The autonomous-intent approval tick (runIntentAutoApprovePass)
 * looks up policy atoms by querying type='directive' + layer='L3'
 * and reading metadata.policy.{subject, allowed_principal_ids,
 * allowed_sub_actors}. Pre-fix the bootstrap shipped 'decision'
 * atoms with the policy block hoisted under metadata.subject /
 * metadata.fields, so the tick never surfaced them and every
 * dispatch fell through the empty-allowlist fail-closed path even
 * though the bootstrap reported success.
 *
 * These tests pin the seeded shape to the fields the runtime tick
 * actually reads, so a future refactor that drifts one side stops
 * the bootstrap silently producing unreachable atoms again.
 *
 * Covers:
 *   - both pol- atoms ship as type='directive', layer='L3'.
 *   - metadata.policy.subject is set to the discriminator the tick
 *     filters on (operator-intent-creation /
 *     plan-autonomous-intent-approve).
 *   - metadata.policy.allowed_principal_ids is seeded from the
 *     operator id (not a hard-coded principal).
 *   - metadata.policy.allowed_sub_actors carries the v1 sub-actor
 *     allowlist on the approve policy.
 *   - The substrate directive (dev-autonomous-intent-substrate-shape)
 *     does not carry a policy block (policies are the two pol- atoms).
 *   - File-host round-trip preserves metadata.policy.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildAtomFromSpec,
  buildAutonomousIntentCanonAtoms,
  buildAutonomousIntentCanonSpecs,
} from '../../scripts/lib/autonomous-intent-canon-atoms.mjs';
import { createFileHost } from '../../src/adapters/file/index.js';

const OP = 'test-operator';

describe('autonomous-intent canon atom builder', () => {
  it('builds the expected stable set of atom ids', () => {
    const ids = buildAutonomousIntentCanonSpecs(OP).map((s) => s.id);
    expect(ids).toEqual([
      'pol-operator-intent-creation',
      'pol-plan-autonomous-intent-approve',
      'dev-autonomous-intent-substrate-shape',
    ]);
  });

  it('rejects an empty operator id (would otherwise seed a no-op allowlist)', () => {
    expect(() => buildAutonomousIntentCanonSpecs('')).toThrow(/operatorId/);
    expect(() => buildAutonomousIntentCanonSpecs(undefined as unknown as string)).toThrow(/operatorId/);
  });

  it('pol-operator-intent-creation: directive + L3 + metadata.policy.subject set', () => {
    const atoms = buildAutonomousIntentCanonAtoms(OP);
    const atom = atoms.find((a) => a.id === 'pol-operator-intent-creation')!;
    expect(atom).toBeDefined();
    expect(atom.type).toBe('directive');
    expect(atom.layer).toBe('L3');
    expect(atom.principal_id).toBe(OP);
    expect(atom.taint).toBe('clean');
    // The intent-approval tick filters policies on
    // metadata.policy.subject; if this drifts, every read falls
    // through the empty-allowlist fail-closed path.
    const policy = (atom.metadata as { policy: { subject: string; allowed_principal_ids: string[] } }).policy;
    expect(policy.subject).toBe('operator-intent-creation');
  });

  it('pol-operator-intent-creation: allowed_principal_ids contains the operator id (not hardcoded)', () => {
    const atoms = buildAutonomousIntentCanonAtoms('alice-operator');
    const atom = atoms.find((a) => a.id === 'pol-operator-intent-creation')!;
    const policy = (atom.metadata as { policy: { allowed_principal_ids: string[] } }).policy;
    expect(policy.allowed_principal_ids).toEqual(['alice-operator']);
  });

  it('pol-operator-intent-creation: carries max_expires_in_hours + required_trust_envelope_fields', () => {
    const atom = buildAutonomousIntentCanonAtoms(OP).find((a) => a.id === 'pol-operator-intent-creation')!;
    const policy = (atom.metadata as { policy: Record<string, unknown> }).policy;
    expect(policy.max_expires_in_hours).toBe(72);
    expect(policy.required_trust_envelope_fields).toEqual([
      'max_blast_radius',
      'allowed_sub_actors',
    ]);
  });

  it('pol-plan-autonomous-intent-approve: directive + L3 + metadata.policy.{subject, allowed_sub_actors}', () => {
    const atom = buildAutonomousIntentCanonAtoms(OP).find(
      (a) => a.id === 'pol-plan-autonomous-intent-approve',
    )!;
    expect(atom.type).toBe('directive');
    expect(atom.layer).toBe('L3');
    const policy = (atom.metadata as { policy: { subject: string; allowed_sub_actors: string[] } }).policy;
    expect(policy.subject).toBe('plan-autonomous-intent-approve');
    expect(policy.allowed_sub_actors).toEqual(['code-author', 'auditor-actor']);
  });

  it('dev-autonomous-intent-substrate-shape: directive without a metadata.policy block', () => {
    const atom = buildAutonomousIntentCanonAtoms(OP).find(
      (a) => a.id === 'dev-autonomous-intent-substrate-shape',
    )!;
    expect(atom.type).toBe('directive');
    expect(atom.layer).toBe('L3');
    // Substrate-shape directive is a behavioural rule, not a policy
    // atom; the tick does not look at it. Asserting the absence of a
    // policy key keeps a future spec rewrite from accidentally
    // turning it into a third policy atom.
    expect('policy' in (atom.metadata as Record<string, unknown>)).toBe(false);
  });

  it('every atom carries operator-seeded provenance + L3 layer', () => {
    for (const atom of buildAutonomousIntentCanonAtoms(OP)) {
      expect(atom.layer).toBe('L3');
      expect(atom.provenance.kind).toBe('operator-seeded');
      expect(atom.provenance.derived_from.length).toBeGreaterThan(0);
      expect(atom.confidence).toBe(1.0);
    }
  });

  it('buildAtomFromSpec rejects empty operator id', () => {
    const spec = buildAutonomousIntentCanonSpecs(OP)[0];
    expect(() => buildAtomFromSpec(spec, '')).toThrow(/operatorId/);
  });
});

describe('autonomous-intent canon atom file-host round trip', () => {
  it('writes the policy atom to a file host and reads metadata.policy back intact', async () => {
    // The bootstrap script's drift check walks metadata key-by-key;
    // a serialization bug in the file adapter that dropped a nested
    // key under metadata.policy would cause the next bootstrap run
    // to falsely report drift. This test catches that early.
    const dir = mkdtempSync(join(tmpdir(), 'lag-bootstrap-intent-'));
    try {
      const host = await createFileHost({ rootDir: dir });
      const expected = buildAutonomousIntentCanonAtoms(OP).find(
        (a) => a.id === 'pol-operator-intent-creation',
      )!;
      await host.atoms.put(expected);
      const stored = await host.atoms.get(expected.id);
      expect(stored).not.toBeNull();
      expect(stored!.type).toBe(expected.type);
      expect(stored!.layer).toBe(expected.layer);
      expect(stored!.metadata.policy).toEqual((expected.metadata as { policy: unknown }).policy);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
