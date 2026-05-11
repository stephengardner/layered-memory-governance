import { describe, it, expect } from 'vitest';
import {
  buildOperatorIntentAtom,
  computeExpiresAt,
  isPrincipalAllowedToFileIntent,
  validateFileIntentInput,
  type FileIntentArgs,
} from './file-intent';

/*
 * Unit tests for the file-intent helpers. Pure: every test feeds raw
 * inputs and asserts on the wire shape; no I/O, no globals, no time.
 * Mirrors the test pattern in `intent-outcome.test.ts`,
 * `pipelines.test.ts`, `security.test.ts`.
 *
 * Coverage focus:
 *   - validateFileIntentInput pins the exact 400-mapping each malformed
 *     input produces, so the route layer's error responses stay stable
 *     for downstream clients (the form's inline-error renderer).
 *   - buildOperatorIntentAtom asserts every load-bearing field
 *     (provenance.derived_from, trust_envelope, layer, taint) so the
 *     autonomous-intent approval tick treats Console-filed atoms the
 *     same as CLI-filed atoms.
 *   - isPrincipalAllowedToFileIntent walks each fail-closed branch
 *     (no atom; tainted atom; superseded; wrong subject; missing
 *     allowlist field).
 */

const REFERENCE_NOW = new Date('2026-05-11T12:00:00.000Z');

function validArgs(overrides: Partial<FileIntentArgs> = {}): FileIntentArgs {
  return {
    request: 'Add a TODO badge to the plans header',
    scope: 'tooling',
    blastRadius: 'tooling',
    subActors: ['code-author'],
    minConfidence: 0.75,
    expiresIn: '24h',
    trigger: false,
    ...overrides,
  };
}

describe('validateFileIntentInput', () => {
  it('accepts a fully-populated valid body', () => {
    const res = validateFileIntentInput({
      request: 'Add a TODO badge to the plans header',
      scope: 'tooling',
      blast_radius: 'tooling',
      sub_actors: ['code-author'],
      min_confidence: 0.8,
      expires_in: '4h',
      trigger: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect(res.args.request).toBe('Add a TODO badge to the plans header');
    expect(res.args.scope).toBe('tooling');
    expect(res.args.blastRadius).toBe('tooling');
    expect(res.args.subActors).toEqual(['code-author']);
    expect(res.args.minConfidence).toBe(0.8);
    expect(res.args.expiresIn).toBe('4h');
    expect(res.args.trigger).toBe(true);
  });

  it('trims the request string and defaults optional fields', () => {
    const res = validateFileIntentInput({
      request: '  add  TODO badge  ',
      scope: 'tooling',
      blast_radius: 'tooling',
      sub_actors: ['code-author'],
    });
    if (!res.ok) throw new Error('expected ok');
    expect(res.args.request).toBe('add  TODO badge');
    expect(res.args.minConfidence).toBe(0.75);
    expect(res.args.expiresIn).toBe('24h');
    expect(res.args.trigger).toBe(false);
  });

  it('rejects non-object body with field=body', () => {
    const res = validateFileIntentInput(null);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected fail');
    expect(res.field).toBe('body');
  });

  it('rejects missing request with field=request', () => {
    const res = validateFileIntentInput({ scope: 'tooling', blast_radius: 'tooling', sub_actors: ['code-author'] });
    if (res.ok) throw new Error('expected fail');
    expect(res.field).toBe('request');
  });

  it('rejects whitespace-only request', () => {
    const res = validateFileIntentInput({
      request: '   ',
      scope: 'tooling',
      blast_radius: 'tooling',
      sub_actors: ['code-author'],
    });
    if (res.ok) throw new Error('expected fail');
    expect(res.field).toBe('request');
  });

  it('rejects unknown scope value', () => {
    const res = validateFileIntentInput({
      request: 'ok',
      scope: 'not-a-scope',
      blast_radius: 'tooling',
      sub_actors: ['code-author'],
    });
    if (res.ok) throw new Error('expected fail');
    expect(res.field).toBe('scope');
  });

  it('rejects unknown blast_radius value', () => {
    const res = validateFileIntentInput({
      request: 'ok',
      scope: 'tooling',
      blast_radius: 'not-a-radius',
      sub_actors: ['code-author'],
    });
    if (res.ok) throw new Error('expected fail');
    expect(res.field).toBe('blast_radius');
  });

  it('rejects empty sub_actors array', () => {
    const res = validateFileIntentInput({
      request: 'ok',
      scope: 'tooling',
      blast_radius: 'tooling',
      sub_actors: [],
    });
    if (res.ok) throw new Error('expected fail');
    expect(res.field).toBe('sub_actors');
  });

  it('rejects sub_actor entry outside the v1 allowlist', () => {
    const res = validateFileIntentInput({
      request: 'ok',
      scope: 'tooling',
      blast_radius: 'tooling',
      sub_actors: ['code-author', 'rogue-actor'],
    });
    if (res.ok) throw new Error('expected fail');
    expect(res.field).toBe('sub_actors');
  });

  it('rejects min_confidence out of range', () => {
    for (const bad of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const res = validateFileIntentInput({
        request: 'ok',
        scope: 'tooling',
        blast_radius: 'tooling',
        sub_actors: ['code-author'],
        min_confidence: bad,
      });
      if (res.ok) throw new Error(`expected fail for ${bad}`);
      expect(res.field).toBe('min_confidence');
    }
  });

  it('rejects expires_in with bad pattern', () => {
    const res = validateFileIntentInput({
      request: 'ok',
      scope: 'tooling',
      blast_radius: 'tooling',
      sub_actors: ['code-author'],
      expires_in: '2 days',
    });
    if (res.ok) throw new Error('expected fail');
    expect(res.field).toBe('expires_in');
  });

  it('rejects expires_in above 72h safety cap', () => {
    const res = validateFileIntentInput({
      request: 'ok',
      scope: 'tooling',
      blast_radius: 'tooling',
      sub_actors: ['code-author'],
      expires_in: '73h',
    });
    if (res.ok) throw new Error('expected fail');
    expect(res.field).toBe('expires_in');
  });

  it('rejects non-boolean trigger value', () => {
    const res = validateFileIntentInput({
      request: 'ok',
      scope: 'tooling',
      blast_radius: 'tooling',
      sub_actors: ['code-author'],
      trigger: 'yes',
    });
    if (res.ok) throw new Error('expected fail');
    expect(res.field).toBe('trigger');
  });
});

describe('computeExpiresAt', () => {
  it('produces an ISO timestamp NOW + Nh for hour-shaped input', () => {
    const iso = computeExpiresAt('4h', REFERENCE_NOW);
    expect(iso).toBe('2026-05-11T16:00:00.000Z');
  });

  it('produces an ISO timestamp NOW + Nm for minute-shaped input', () => {
    const iso = computeExpiresAt('90m', REFERENCE_NOW);
    expect(iso).toBe('2026-05-11T13:30:00.000Z');
  });

  it('throws on malformed input', () => {
    expect(() => computeExpiresAt('2 days', REFERENCE_NOW)).toThrow();
  });

  it('throws when above the 72h safety cap', () => {
    expect(() => computeExpiresAt('100h', REFERENCE_NOW)).toThrow();
  });
});

describe('buildOperatorIntentAtom', () => {
  it('produces an atom with the canonical shape', () => {
    const atom = buildOperatorIntentAtom({
      args: validArgs(),
      operatorPrincipalId: 'apex-agent',
      now: REFERENCE_NOW,
      nonce: 'abc123',
    });
    expect(atom.id).toMatch(/^intent-abc123-2026-05-11T12-00-00-000Z$/);
    expect(atom.type).toBe('operator-intent');
    expect(atom.layer).toBe('L1');
    expect(atom.principal_id).toBe('apex-agent');
    expect(atom.provenance.kind).toBe('operator-seeded');
    expect(atom.provenance.source.tool).toBe('lag-console-file-intent');
    expect(atom.provenance.derived_from).toEqual([]);
    expect(atom.scope).toBe('tooling');
    expect(atom.content).toBe('Add a TODO badge to the plans header');
    expect(atom.taint).toBe('clean');
    expect(atom.signals.validation_status).toBe('unchecked');
  });

  it('embeds the full trust envelope', () => {
    const atom = buildOperatorIntentAtom({
      args: validArgs({
        blastRadius: 'framework',
        subActors: ['code-author', 'auditor-actor'],
        minConfidence: 0.9,
      }),
      operatorPrincipalId: 'apex-agent',
      now: REFERENCE_NOW,
      nonce: 'abc123',
    });
    expect(atom.metadata.trust_envelope.max_blast_radius).toBe('framework');
    expect(atom.metadata.trust_envelope.max_plans).toBe(5);
    expect(atom.metadata.trust_envelope.min_plan_confidence).toBe(0.9);
    expect(atom.metadata.trust_envelope.allowed_sub_actors).toEqual(['code-author', 'auditor-actor']);
    expect(atom.metadata.trust_envelope.require_ci_green).toBe(true);
    expect(atom.metadata.trust_envelope.require_cr_approve).toBe(true);
    expect(atom.metadata.trust_envelope.require_auditor_observation).toBe(true);
  });

  it('writes expires_at into metadata, not the envelope expires_at slot', () => {
    // Match `scripts/lib/intend.mjs#buildIntentAtom`: top-level
    // `expires_at: null` plus `metadata.expires_at: <iso>`. The
    // intent-approve tick reads from metadata, not the envelope.
    const atom = buildOperatorIntentAtom({
      args: validArgs({ expiresIn: '1h' }),
      operatorPrincipalId: 'apex-agent',
      now: REFERENCE_NOW,
      nonce: 'abc123',
    });
    expect(atom.expires_at).toBeNull();
    expect(atom.metadata.expires_at).toBe('2026-05-11T13:00:00.000Z');
  });

  it('throws when operatorPrincipalId is missing', () => {
    expect(() => buildOperatorIntentAtom({
      args: validArgs(),
      operatorPrincipalId: '',
      now: REFERENCE_NOW,
      nonce: 'abc',
    })).toThrow();
  });

  it('throws when nonce is missing', () => {
    expect(() => buildOperatorIntentAtom({
      args: validArgs(),
      operatorPrincipalId: 'apex-agent',
      now: REFERENCE_NOW,
      nonce: '',
    })).toThrow();
  });
});

describe('isPrincipalAllowedToFileIntent', () => {
  function policyAtom(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'pol-operator-intent-creation',
      type: 'directive',
      layer: 'L3',
      taint: 'clean',
      superseded_by: [],
      metadata: {
        policy: {
          subject: 'operator-intent-creation',
          allowed_principal_ids: ['apex-agent'],
        },
      },
      ...overrides,
    };
  }

  it('returns true when the principal is in the allowlist', () => {
    expect(isPrincipalAllowedToFileIntent([policyAtom()], 'apex-agent')).toBe(true);
  });

  it('returns false when the principal is absent from a matching policy', () => {
    expect(isPrincipalAllowedToFileIntent([policyAtom()], 'rogue-actor')).toBe(false);
  });

  it('fails-closed when canon has no policy atom (empty list)', () => {
    expect(isPrincipalAllowedToFileIntent([], 'apex-agent')).toBe(false);
  });

  it('skips non-directive atoms', () => {
    const a = policyAtom({ type: 'observation' });
    expect(isPrincipalAllowedToFileIntent([a], 'apex-agent')).toBe(false);
  });

  it('skips atoms not at layer L3', () => {
    const a = policyAtom({ layer: 'L0' });
    expect(isPrincipalAllowedToFileIntent([a], 'apex-agent')).toBe(false);
  });

  it('skips tainted atoms', () => {
    const a = policyAtom({ taint: 'compromised' });
    expect(isPrincipalAllowedToFileIntent([a], 'apex-agent')).toBe(false);
  });

  it('skips superseded atoms', () => {
    const a = policyAtom({ superseded_by: ['pol-newer'] });
    expect(isPrincipalAllowedToFileIntent([a], 'apex-agent')).toBe(false);
  });

  it('skips atoms whose policy.subject does not match', () => {
    const a = policyAtom({
      metadata: { policy: { subject: 'something-else', allowed_principal_ids: ['apex-agent'] } },
    });
    expect(isPrincipalAllowedToFileIntent([a], 'apex-agent')).toBe(false);
  });

  it('skips atoms missing metadata.policy', () => {
    const a = policyAtom({ metadata: {} });
    expect(isPrincipalAllowedToFileIntent([a], 'apex-agent')).toBe(false);
  });

  it('skips atoms whose allowed_principal_ids is not an array', () => {
    const a = policyAtom({
      metadata: { policy: { subject: 'operator-intent-creation', allowed_principal_ids: 'apex-agent' } },
    });
    expect(isPrincipalAllowedToFileIntent([a], 'apex-agent')).toBe(false);
  });

  it('treats missing taint as clean (omitted means clean)', () => {
    const a = policyAtom();
    delete (a as Record<string, unknown>).taint;
    expect(isPrincipalAllowedToFileIntent([a], 'apex-agent')).toBe(true);
  });
});
