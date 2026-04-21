/**
 * Unit tests for loadLlmToolPolicy.
 *
 * Fail-closed discipline matters here: the loader resolves tool
 * permissions for an LLM-backed actor, and returning the wrong
 * answer silently is exactly the class of drift LAG is written to
 * prevent. Cover the four axes the loader checks (presence, taint,
 * supersession, malformed payload) plus the happy path.
 */

import { describe, expect, it } from 'vitest';
import {
  llmToolPolicyAtomId,
  loadLlmToolPolicy,
  LlmToolPolicyError,
  LLM_TOOL_POLICY_PREFIX,
} from '../src/llm-tool-policy.js';
import type { AtomStore } from '../src/interface.js';
import type { Atom, AtomId, PrincipalId, Time } from '../src/types.js';

const PRINCIPAL = 'cto-actor' as PrincipalId;
const BOOT_TIME = '2026-04-21T00:00:00.000Z' as Time;

function mkPolicyAtom(policy: Record<string, unknown>, overrides: Partial<Atom> = {}): Atom {
  return {
    schema_version: 1,
    id: llmToolPolicyAtomId(PRINCIPAL),
    content: 'llm tool policy test',
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'test', agent_id: 'test' },
      derived_from: [],
    },
    confidence: 1,
    created_at: BOOT_TIME,
    last_reinforced_at: BOOT_TIME,
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
    principal_id: 'stephen-human' as PrincipalId,
    taint: 'clean',
    metadata: { policy },
    ...overrides,
  };
}

function mockAtomStore(atomsById: Map<string, Atom>): AtomStore {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async get(id: AtomId): Promise<Atom | null> {
      return atomsById.get(String(id)) ?? null;
    },
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    async put() { /* stub */ },
    async query() { return []; },
    async capabilities() { return { exactMatch: true, prefixScan: false, vectorSearch: false }; },
    async updateConfidence() { /* noop */ },
    async markTainted() { /* noop */ },
    async supersede() { /* noop */ },
  } as unknown as AtomStore;
}

describe('llmToolPolicyAtomId', () => {
  it('matches the canonical prefix + principal id', () => {
    expect(llmToolPolicyAtomId(PRINCIPAL)).toBe(`${LLM_TOOL_POLICY_PREFIX}cto-actor`);
    expect(llmToolPolicyAtomId('any-principal')).toBe(`${LLM_TOOL_POLICY_PREFIX}any-principal`);
  });
});

describe('loadLlmToolPolicy', () => {
  const validPayload = {
    subject: 'llm-tool-policy',
    principal: 'cto-actor',
    disallowed_tools: ['Write', 'Edit', 'Bash'],
    rationale: 'Planner reads code; writes route through signed PRs.',
  };

  it('returns null when no policy atom is present (caller falls back to adapter default)', async () => {
    const atoms = new Map<string, Atom>();
    const policy = await loadLlmToolPolicy(mockAtomStore(atoms), PRINCIPAL);
    expect(policy).toBeNull();
  });

  it('parses a well-formed policy atom and returns the deny-list frozen', async () => {
    const atoms = new Map<string, Atom>([
      [llmToolPolicyAtomId(PRINCIPAL), mkPolicyAtom(validPayload)],
    ]);
    const policy = await loadLlmToolPolicy(mockAtomStore(atoms), PRINCIPAL);
    expect(policy).not.toBeNull();
    expect(policy!.principalId).toBe(PRINCIPAL);
    expect(policy!.disallowedTools).toEqual(['Write', 'Edit', 'Bash']);
    expect(policy!.rationale).toContain('signed PRs');
    // Frozen: mutation throws in strict mode, silently no-ops otherwise.
    expect(Object.isFrozen(policy!.disallowedTools)).toBe(true);
  });

  it('returns null when the atom is tainted (fail-closed to adapter default)', async () => {
    const atoms = new Map<string, Atom>([
      [llmToolPolicyAtomId(PRINCIPAL), mkPolicyAtom(validPayload, { taint: 'dirty' })],
    ]);
    const policy = await loadLlmToolPolicy(mockAtomStore(atoms), PRINCIPAL);
    expect(policy).toBeNull();
  });

  it('returns null when the atom is superseded', async () => {
    const atoms = new Map<string, Atom>([
      [llmToolPolicyAtomId(PRINCIPAL), mkPolicyAtom(validPayload, {
        superseded_by: ['pol-llm-tool-policy-cto-actor-v2' as AtomId],
      })],
    ]);
    const policy = await loadLlmToolPolicy(mockAtomStore(atoms), PRINCIPAL);
    expect(policy).toBeNull();
  });

  it('throws LlmToolPolicyError when metadata.policy is missing', async () => {
    const atoms = new Map<string, Atom>([
      [llmToolPolicyAtomId(PRINCIPAL), mkPolicyAtom({}, { metadata: {} })],
    ]);
    await expect(loadLlmToolPolicy(mockAtomStore(atoms), PRINCIPAL)).rejects.toBeInstanceOf(LlmToolPolicyError);
  });

  it('rejects a payload with the wrong subject', async () => {
    const atoms = new Map<string, Atom>([
      [llmToolPolicyAtomId(PRINCIPAL), mkPolicyAtom({
        ...validPayload,
        subject: 'something-else',
      })],
    ]);
    await expect(loadLlmToolPolicy(mockAtomStore(atoms), PRINCIPAL)).rejects.toThrow(/subject: expected "llm-tool-policy"/);
  });

  it('rejects a payload whose principal field disagrees with the lookup key', async () => {
    // A canon edit that renames a principal must update the atom's
    // metadata.principal, OR the drift check fails loud. Silent
    // re-binding of a policy to a different principal would let
    // policies re-attribute without changing the stored atom.
    const atoms = new Map<string, Atom>([
      [llmToolPolicyAtomId(PRINCIPAL), mkPolicyAtom({
        ...validPayload,
        principal: 'someone-else',
      })],
    ]);
    await expect(loadLlmToolPolicy(mockAtomStore(atoms), PRINCIPAL)).rejects.toThrow(/principal: expected/);
  });

  it('rejects non-string elements in disallowed_tools', async () => {
    const atoms = new Map<string, Atom>([
      [llmToolPolicyAtomId(PRINCIPAL), mkPolicyAtom({
        ...validPayload,
        disallowed_tools: ['Bash', 42, null] as ReadonlyArray<unknown>,
      })],
    ]);
    await expect(loadLlmToolPolicy(mockAtomStore(atoms), PRINCIPAL)).rejects.toThrow(/disallowed_tools: expected string\[\]/);
  });

  it('rejects blank string entries in disallowed_tools', async () => {
    // A blank name in the deny-list is a canon typo; it would make
    // the space-joined --disallowedTools surface contain a trailing
    // empty item whose CLI semantics are unspecified.
    const atoms = new Map<string, Atom>([
      [llmToolPolicyAtomId(PRINCIPAL), mkPolicyAtom({
        ...validPayload,
        disallowed_tools: ['Bash', '  '],
      })],
    ]);
    await expect(loadLlmToolPolicy(mockAtomStore(atoms), PRINCIPAL)).rejects.toThrow(/disallowed_tools: expected string\[\]/);
  });

  it('accepts an empty disallowed_tools array (allow-all-via-empty-deny)', async () => {
    // Zero-deny is a valid policy expression (the operator expressly
    // wants no tool restrictions for this principal). Distinct from
    // "no atom present" which is null; empty-array is the explicit
    // "everything allowed" choice.
    const atoms = new Map<string, Atom>([
      [llmToolPolicyAtomId(PRINCIPAL), mkPolicyAtom({
        ...validPayload,
        disallowed_tools: [],
      })],
    ]);
    const policy = await loadLlmToolPolicy(mockAtomStore(atoms), PRINCIPAL);
    expect(policy).not.toBeNull();
    expect(policy!.disallowedTools).toEqual([]);
  });

  it('rationale is optional; absence is not a drift', async () => {
    const { rationale: _omit, ...noRationale } = validPayload;
    void _omit;
    const atoms = new Map<string, Atom>([
      [llmToolPolicyAtomId(PRINCIPAL), mkPolicyAtom(noRationale)],
    ]);
    const policy = await loadLlmToolPolicy(mockAtomStore(atoms), PRINCIPAL);
    expect(policy).not.toBeNull();
    expect(policy!.rationale).toBeUndefined();
  });
});
