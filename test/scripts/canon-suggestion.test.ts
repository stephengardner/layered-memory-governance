/**
 * Unit tests for the canon-suggestion sweep + triage primitives.
 *
 * Covers the substrate-respecting shape that prevents L3 promotion
 * from leaking outside scripts/decide.mjs:
 *   - The atom builder writes type='observation' + provenance.kind=
 *     'agent-observed' + layer='L1', NEVER 'L3', NEVER
 *     'human-asserted'. A regression here would let an agent suggest
 *     into the L3 store, breaking inv-l3-requires-human.
 *   - Triage actions never auto-promote: `promote` without a
 *     derived_canon_id is phase-1 (no mutation), only phase-2 with the
 *     canon id back-filled does the metadata flip. This is the
 *     mechanism that prevents the console from short-circuiting the
 *     decide.mjs gate.
 *   - Type guard rejects atoms missing the metadata.kind discriminator
 *     so adjacent observation atoms can't be triaged.
 *
 * The same `applyTriageAction` codepath the CLI runs is exercised here
 * against MemoryHost; the CLI is a thin shell over this lib.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import {
  buildSuggestionAtom,
  validateSuggestionSpec,
  isCanonSuggestionAtom,
  filterPendingSuggestions,
  filterSuggestionsByState,
  applyTriageAction,
  buildTriagedMetadata,
  CANON_SUGGESTION_KIND,
  CANON_SUGGESTION_VALID_TYPES,
  CANON_SUGGESTION_VALID_STATES,
  CANON_SUGGESTION_ACTIONS,
  CANON_SUGGESTION_ACTION_TO_STATE,
} from '../../scripts/lib/canon-suggestion.mjs';
import type { Atom, AtomId, PrincipalId, Time } from '../../src/types.js';

const NOW = new Date('2026-04-25T15:00:00.000Z');
const NOW_ISO = NOW.toISOString();
const SCOUT = 'canon-scout-stub';
const OPERATOR = 'op-stephen';

function validSpec(overrides: Record<string, unknown> = {}) {
  return {
    suggested_id: 'dev-foo-bar',
    suggested_type: 'directive',
    proposed_content: 'When the operator says X, agents must do Y to avoid Z.',
    chat_excerpt: 'operator: please make sure agents do Y',
    confidence: 0.65,
    scout_principal_id: SCOUT,
    ...overrides,
  };
}

describe('validateSuggestionSpec', () => {
  it('accepts a well-formed spec', () => {
    const r = validateSuggestionSpec(validSpec());
    expect(r.ok).toBe(true);
  });

  it('rejects non-kebab-case suggested_id', () => {
    const r = validateSuggestionSpec(validSpec({ suggested_id: 'Dev_Foo_Bar' }));
    expect(r.ok).toBe(false);
    expect(r.errors!.some((e: string) => e.startsWith('suggested_id'))).toBe(true);
  });

  it('rejects unsupported suggested_type', () => {
    // Even if `decision` is a real canon type, the scout should never
    // suggest decisions; those carry alternatives_rejected metadata
    // that the agent cannot author. Restricting to directive/preference/
    // reference is part of the substrate discipline.
    const r = validateSuggestionSpec(validSpec({ suggested_type: 'decision' }));
    expect(r.ok).toBe(false);
    expect(r.errors!.some((e: string) => e.startsWith('suggested_type'))).toBe(true);
  });

  it('rejects too-short proposed_content', () => {
    const r = validateSuggestionSpec(validSpec({ proposed_content: 'too short' }));
    expect(r.ok).toBe(false);
    expect(r.errors!.some((e: string) => e.startsWith('proposed_content'))).toBe(true);
  });

  it('rejects out-of-range confidence', () => {
    const r1 = validateSuggestionSpec(validSpec({ confidence: 1.2 }));
    const r2 = validateSuggestionSpec(validSpec({ confidence: -0.1 }));
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
  });

  it('rejects empty chat_excerpt', () => {
    const r = validateSuggestionSpec(validSpec({ chat_excerpt: '   ' }));
    expect(r.ok).toBe(false);
    expect(r.errors!.some((e: string) => e.startsWith('chat_excerpt'))).toBe(true);
  });

  it('rejects empty scout_principal_id (substrate would lose attribution)', () => {
    const r = validateSuggestionSpec(validSpec({ scout_principal_id: '' }));
    expect(r.ok).toBe(false);
  });

  it('exposes the valid type + state vocabularies for callers', () => {
    expect(CANON_SUGGESTION_VALID_TYPES).toEqual(['directive', 'preference', 'reference']);
    expect(CANON_SUGGESTION_VALID_STATES).toEqual(['pending', 'promoted', 'dismissed', 'deferred']);
  });
});

describe('buildSuggestionAtom', () => {
  it('writes layer=L1 and type=observation, NEVER L3, NEVER directive', () => {
    // This is the substrate-discipline regression test. If this ever
    // produces type='directive' or layer='L3', an agent's suggestion
    // would land in the canon store as if the operator had asserted
    // it, breaking inv-l3-requires-human at the source.
    const atom = buildSuggestionAtom(validSpec(), { now: NOW, nonce: 'abc123' });
    expect(atom.layer).toBe('L1');
    expect(atom.type).toBe('observation');
  });

  it('stamps provenance.kind=agent-observed with the scout in the source chain', () => {
    const atom = buildSuggestionAtom(validSpec(), { now: NOW, nonce: 'abc123' });
    expect(atom.provenance.kind).toBe('agent-observed');
    expect(atom.provenance.source).toEqual({ agent_id: SCOUT, tool: 'canon-scout' });
    expect(atom.provenance.derived_from).toEqual([]);
  });

  it('stamps the canon-proposal-suggestion discriminator on metadata.kind', () => {
    const atom = buildSuggestionAtom(validSpec(), { now: NOW, nonce: 'abc123' });
    expect(atom.metadata['kind']).toBe(CANON_SUGGESTION_KIND);
    expect(atom.metadata['suggested_id']).toBe('dev-foo-bar');
    expect(atom.metadata['suggested_type']).toBe('directive');
    expect(atom.metadata['review_state']).toBe('pending');
  });

  it('produces a deterministic atom id from suggested_id + nonce', () => {
    const a = buildSuggestionAtom(validSpec(), { now: NOW, nonce: 'n1' });
    const b = buildSuggestionAtom(validSpec(), { now: NOW, nonce: 'n2' });
    expect(a.id).not.toEqual(b.id);
    expect(a.id).toMatch(/^canon-suggestion-dev-foo-bar-n1$/);
  });

  it('throws when spec is invalid', () => {
    expect(() => buildSuggestionAtom(validSpec({ confidence: 5 }), { now: NOW, nonce: 'x' })).toThrow(/invalid suggestion spec/);
  });

  it('round-trips through MemoryHost without mutation', async () => {
    const host = createMemoryHost();
    const atom = buildSuggestionAtom(validSpec(), { now: NOW, nonce: 'rt1' });
    await host.atoms.put(atom as unknown as Atom);
    const got = await host.atoms.get(atom.id as AtomId);
    expect(got).not.toBeNull();
    expect(got!.layer).toBe('L1');
    expect((got!.metadata as Record<string, unknown>)['kind']).toBe(CANON_SUGGESTION_KIND);
  });
});

describe('isCanonSuggestionAtom', () => {
  it('accepts a freshly-built suggestion', () => {
    const atom = buildSuggestionAtom(validSpec(), { now: NOW, nonce: 'g1' });
    expect(isCanonSuggestionAtom(atom)).toBe(true);
  });

  it('rejects type=directive (the operator-asserted shape)', () => {
    const atom = buildSuggestionAtom(validSpec(), { now: NOW, nonce: 'g2' });
    const tampered = { ...atom, type: 'directive' };
    expect(isCanonSuggestionAtom(tampered)).toBe(false);
  });

  it('rejects observation atoms missing metadata.kind discriminator', () => {
    const atom = buildSuggestionAtom(validSpec(), { now: NOW, nonce: 'g3' });
    const tampered = { ...atom, metadata: { ...atom.metadata, kind: 'something-else' } };
    expect(isCanonSuggestionAtom(tampered)).toBe(false);
  });

  it('rejects null / undefined / non-objects', () => {
    expect(isCanonSuggestionAtom(null)).toBe(false);
    expect(isCanonSuggestionAtom(undefined)).toBe(false);
    expect(isCanonSuggestionAtom('string')).toBe(false);
  });
});

describe('filterPendingSuggestions / filterSuggestionsByState', () => {
  it('returns only pending suggestions when filtering pending', () => {
    const a = buildSuggestionAtom(validSpec({ suggested_id: 'dev-a' }), { now: NOW, nonce: 'f1' });
    const b = buildSuggestionAtom(validSpec({ suggested_id: 'dev-b' }), { now: NOW, nonce: 'f2' });
    const dismissed = { ...b, metadata: { ...b.metadata, review_state: 'dismissed' } };
    const result = filterPendingSuggestions([a, dismissed]);
    expect(result.map((x: { id: string }) => x.id)).toEqual([a.id]);
  });

  it('filters by an explicit state', () => {
    const a = buildSuggestionAtom(validSpec({ suggested_id: 'dev-a' }), { now: NOW, nonce: 'f3' });
    const promoted = { ...a, metadata: { ...a.metadata, review_state: 'promoted' } };
    expect(filterSuggestionsByState([a, promoted], 'promoted').map((x: { id: string }) => x.id)).toEqual([promoted.id]);
  });

  it('throws on unknown state to surface a typo', () => {
    expect(() => filterSuggestionsByState([], 'nonsense')).toThrow(/unknown review_state/);
  });
});

describe('buildTriagedMetadata', () => {
  it('flips review_state and stamps actor + timestamp', () => {
    const out = buildTriagedMetadata({ kind: 'canon-proposal-suggestion', review_state: 'pending' }, 'dismissed', {
      actorId: OPERATOR,
      nowIso: NOW_ISO,
    });
    expect(out.review_state).toBe('dismissed');
    expect(out.review_state_changed_by).toBe(OPERATOR);
    expect(out.review_state_changed_at).toBe(NOW_ISO);
  });

  it('records derived_canon_id when promoting', () => {
    const out = buildTriagedMetadata({ kind: 'canon-proposal-suggestion', review_state: 'pending' }, 'promoted', {
      actorId: OPERATOR,
      nowIso: NOW_ISO,
      derivedCanonId: 'dev-foo-bar',
    });
    expect(out.derived_canon_id).toBe('dev-foo-bar');
  });

  it('throws when promoting without a derived_canon_id (the substrate gate)', () => {
    expect(() => buildTriagedMetadata({}, 'promoted', { actorId: OPERATOR, nowIso: NOW_ISO })).toThrow(/derivedCanonId/);
  });

  it('throws on unknown next-state to surface typos at the lib boundary', () => {
    expect(() => buildTriagedMetadata({}, 'nonsense', { actorId: OPERATOR, nowIso: NOW_ISO })).toThrow(/unknown review_state/);
  });
});

describe('applyTriageAction (the codepath the CLI runs)', () => {
  it('action map exposes promote/dismiss/defer', () => {
    expect(CANON_SUGGESTION_ACTIONS).toEqual(['promote', 'dismiss', 'defer']);
    expect(CANON_SUGGESTION_ACTION_TO_STATE).toEqual({
      promote: 'promoted',
      dismiss: 'dismissed',
      defer: 'deferred',
    });
  });

  it('dismiss path: writes review_state=dismissed via host.atoms.put', async () => {
    const host = createMemoryHost();
    const atom = buildSuggestionAtom(validSpec({ suggested_id: 'dev-dismiss' }), { now: NOW, nonce: 'd1' });
    await host.atoms.put(atom as unknown as Atom);
    const result = await applyTriageAction(host, atom, {
      action: 'dismiss',
      actorId: OPERATOR,
      nowIso: NOW_ISO,
      reason: 'duplicates dev-extreme-rigor-and-research',
    });
    expect(result.mutated).toBe(true);
    expect(result.awaitingDecide).toBe(false);
    const stored = await host.atoms.get(atom.id as AtomId);
    expect((stored!.metadata as Record<string, unknown>)['review_state']).toBe('dismissed');
    expect((stored!.metadata as Record<string, unknown>)['review_reason']).toBe('duplicates dev-extreme-rigor-and-research');
    expect((stored!.metadata as Record<string, unknown>)['review_state_changed_by']).toBe(OPERATOR);
  });

  it('defer path: writes review_state=deferred', async () => {
    const host = createMemoryHost();
    const atom = buildSuggestionAtom(validSpec({ suggested_id: 'dev-defer' }), { now: NOW, nonce: 'df1' });
    await host.atoms.put(atom as unknown as Atom);
    await applyTriageAction(host, atom, { action: 'defer', actorId: OPERATOR, nowIso: NOW_ISO });
    const stored = await host.atoms.get(atom.id as AtomId);
    expect((stored!.metadata as Record<string, unknown>)['review_state']).toBe('deferred');
  });

  it('promote phase-1 (no derived_canon_id): NO mutation, awaitingDecide=true', async () => {
    /*
     * This is the critical inv-l3-requires-human gate. The triage
     * action must NEVER flip review_state=promoted without a
     * derived_canon_id pointer back to a real canon atom written by
     * decide.mjs. If this test ever passes with mutated=true, the
     * console could short-circuit the human-approval gate.
     */
    const host = createMemoryHost();
    const atom = buildSuggestionAtom(validSpec({ suggested_id: 'dev-promote' }), { now: NOW, nonce: 'p1' });
    await host.atoms.put(atom as unknown as Atom);
    const result = await applyTriageAction(host, atom, {
      action: 'promote',
      actorId: OPERATOR,
      nowIso: NOW_ISO,
    });
    expect(result.mutated).toBe(false);
    expect(result.awaitingDecide).toBe(true);
    const stored = await host.atoms.get(atom.id as AtomId);
    // review_state must still be pending: phase-1 did not touch the atom.
    expect((stored!.metadata as Record<string, unknown>)['review_state']).toBe('pending');
  });

  it('promote phase-2 (with derived_canon_id): writes promoted + linkage', async () => {
    const host = createMemoryHost();
    const atom = buildSuggestionAtom(validSpec({ suggested_id: 'dev-promote-2' }), { now: NOW, nonce: 'p2' });
    await host.atoms.put(atom as unknown as Atom);
    const result = await applyTriageAction(host, atom, {
      action: 'promote',
      actorId: OPERATOR,
      nowIso: NOW_ISO,
      derivedCanonId: 'dev-promote-2',
    });
    expect(result.mutated).toBe(true);
    const stored = await host.atoms.get(atom.id as AtomId);
    const meta = stored!.metadata as Record<string, unknown>;
    expect(meta['review_state']).toBe('promoted');
    expect(meta['derived_canon_id']).toBe('dev-promote-2');
    expect(meta['review_state_changed_by']).toBe(OPERATOR);
  });

  it('refuses to triage non-suggestion atoms (the discriminator gate)', async () => {
    const host = createMemoryHost();
    const stray: Atom = {
      schema_version: 1,
      id: 'obs-stray-1' as AtomId,
      content: 'unrelated observation',
      type: 'observation',
      layer: 'L1',
      provenance: { kind: 'agent-observed', source: { agent_id: 'someone' as PrincipalId }, derived_from: [] },
      confidence: 0.5,
      created_at: NOW_ISO as Time,
      last_reinforced_at: NOW_ISO as Time,
      expires_at: null,
      supersedes: [],
      superseded_by: [],
      scope: 'project',
      signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
      principal_id: 'someone' as PrincipalId,
      taint: 'clean',
      metadata: { kind: 'unrelated-observation' },
    };
    await host.atoms.put(stray);
    await expect(
      applyTriageAction(host, stray, { action: 'dismiss', actorId: OPERATOR, nowIso: NOW_ISO }),
    ).rejects.toThrow(/canon-proposal-suggestion/);
  });

  it('refuses unknown actions to surface CLI typos', async () => {
    const host = createMemoryHost();
    const atom = buildSuggestionAtom(validSpec(), { now: NOW, nonce: 'unk' });
    await host.atoms.put(atom as unknown as Atom);
    await expect(
      applyTriageAction(host, atom, { action: 'evaporate', actorId: OPERATOR, nowIso: NOW_ISO }),
    ).rejects.toThrow(/unknown action/);
  });
});
