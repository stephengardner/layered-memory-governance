/**
 * Tests for the shared canon-policy readers in
 * `src/runtime/loop/canon-policy-cadence.ts`.
 *
 * The numeric reader (`readNumericCanonPolicy`) is already exercised
 * end-to-end via the four sibling readers that consume it
 * (approval-cycle-interval, pr-observation-freshness, reaper-ttls,
 * pr-orphan-cadence). This file covers the boolean reader
 * (`readBooleanCanonPolicy`) directly because it lacks a numeric
 * sibling: the indie-floor's first boolean knob (loop-pass posture
 * defaults) is the only consumer at landing time, and a malformed
 * value must fall back to the supplied default without coercing a
 * runtime boolean to truthy garbage.
 *
 * Shape: mirrors readNumericCanonPolicy's contract -- walk L3
 * directives, filter taint='clean' + non-superseded, match
 * metadata.policy.subject, read the named field with a back-compat
 * `value` alias, fall through to the default on any malformed or
 * absent payload. No sentinel handling because a boolean has no
 * "disabled / never fire" equivalent of POSITIVE_INFINITY.
 */

import { describe, expect, it } from 'vitest';

import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import { readBooleanCanonPolicy } from '../../../src/runtime/loop/canon-policy-cadence.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../src/types.js';

const NOW = '2026-05-10T00:00:00.000Z' as Time;

function policyAtom(id: string, subject: string, payload: Record<string, unknown>): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'policy',
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { agent_id: 'bootstrap' },
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
    principal_id: 'apex-agent' as PrincipalId,
    taint: 'clean',
    metadata: {
      policy: { subject, ...payload },
    },
  };
}

const SUBJECT = 'loop-pass-pr-observation-refresh-default';
const FIELD = 'enabled';

describe('readBooleanCanonPolicy', () => {
  it('returns the fallback when no canon atom exists', async () => {
    const host = createMemoryHost();
    expect(
      await readBooleanCanonPolicy(host, {
        subject: SUBJECT,
        fieldName: FIELD,
        fallback: true,
      }),
    ).toBe(true);
    expect(
      await readBooleanCanonPolicy(host, {
        subject: SUBJECT,
        fieldName: FIELD,
        fallback: false,
      }),
    ).toBe(false);
  });

  it('returns the configured value when the policy atom exists and enabled=true', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-bool-true', SUBJECT, { enabled: true }));
    expect(
      await readBooleanCanonPolicy(host, {
        subject: SUBJECT,
        fieldName: FIELD,
        fallback: false,
      }),
    ).toBe(true);
  });

  it('returns the configured value when the policy atom exists and enabled=false', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-bool-false', SUBJECT, { enabled: false }));
    expect(
      await readBooleanCanonPolicy(host, {
        subject: SUBJECT,
        fieldName: FIELD,
        fallback: true,
      }),
    ).toBe(false);
  });

  it('falls back to default when the field is a string', async () => {
    // Malformed payload (the operator typed "true" instead of true).
    // Coercing a string to boolean via Boolean('false') would return
    // true (truthy), silently lying to the loop. Fall back instead.
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-bool-string', SUBJECT, { enabled: 'true' }),
    );
    expect(
      await readBooleanCanonPolicy(host, {
        subject: SUBJECT,
        fieldName: FIELD,
        fallback: false,
      }),
    ).toBe(false);
  });

  it('falls back to default when the field is a number', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-bool-num', SUBJECT, { enabled: 1 }));
    expect(
      await readBooleanCanonPolicy(host, {
        subject: SUBJECT,
        fieldName: FIELD,
        fallback: false,
      }),
    ).toBe(false);
  });

  it('falls back to default when the field is missing', async () => {
    const host = createMemoryHost();
    // Subject matches but the field is absent.
    await host.atoms.put(policyAtom('pol-bool-missing-field', SUBJECT, {}));
    expect(
      await readBooleanCanonPolicy(host, {
        subject: SUBJECT,
        fieldName: FIELD,
        fallback: true,
      }),
    ).toBe(true);
  });

  it('back-compat reads the legacy `value` field', async () => {
    // Mirrors readNumericCanonPolicy's back-compat read so a
    // bootstrap snapshot in the older shape stays usable while the
    // named-field shape is canonical going forward.
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-bool-legacy', SUBJECT, { value: true }));
    expect(
      await readBooleanCanonPolicy(host, {
        subject: SUBJECT,
        fieldName: FIELD,
        fallback: false,
      }),
    ).toBe(true);
  });

  it('ignores tainted canon atoms', async () => {
    const host = createMemoryHost();
    const a = policyAtom('pol-bool-tainted', SUBJECT, { enabled: false });
    await host.atoms.put({ ...a, taint: 'tainted' });
    expect(
      await readBooleanCanonPolicy(host, {
        subject: SUBJECT,
        fieldName: FIELD,
        fallback: true,
      }),
    ).toBe(true);
  });

  it('ignores superseded canon atoms', async () => {
    const host = createMemoryHost();
    const a = policyAtom('pol-bool-superseded', SUBJECT, { enabled: false });
    await host.atoms.put({ ...a, superseded_by: ['pol-bool-newer' as AtomId] });
    expect(
      await readBooleanCanonPolicy(host, {
        subject: SUBJECT,
        fieldName: FIELD,
        fallback: true,
      }),
    ).toBe(true);
  });

  it('skips atoms whose policy.subject does not match', async () => {
    const host = createMemoryHost();
    const unrelated: Atom = policyAtom('pol-other-subject', 'unrelated-subject', {
      enabled: false,
    });
    await host.atoms.put(unrelated);
    expect(
      await readBooleanCanonPolicy(host, {
        subject: SUBJECT,
        fieldName: FIELD,
        fallback: true,
      }),
    ).toBe(true);
  });
});
