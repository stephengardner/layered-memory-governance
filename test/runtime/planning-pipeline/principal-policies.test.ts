/**
 * Per-principal LLM tool-policy precursor for the deep-planning pipeline.
 *
 * Tasks 7-11 of the deep-planning-pipeline plan introduce five LLM-backed
 * principals (brainstorm-actor, spec-author, plan-author, pipeline-auditor,
 * plan-dispatcher).
 * Each must resolve a non-fallback policy via loadLlmToolPolicy() so the
 * stage adapters' host.llm.judge calls inherit the correct read-only
 * deny-list. Without the precursor, calls fall through to the deny-all
 * fallback and the stage tests cannot pass.
 *
 * This test pins the bootstrap output shape: it imports the policy list
 * from the bootstrap-shared lib, builds each policy atom, persists it
 * into a memory host, and asserts the resolver returns the canonical
 * eleven-tool deny-list with Read/Grep/Glob allowed by omission.
 */

import { describe, expect, it } from 'vitest';
import {
  PLANNING_PIPELINE_POLICIES,
  buildPolicyAtom,
  READ_ONLY_DENY,
} from '../../../scripts/lib/planning-pipeline-principals.mjs';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import {
  loadLlmToolPolicy,
  llmToolPolicyAtomId,
} from '../../../src/llm-tool-policy.js';
import type { Atom, PrincipalId } from '../../../src/types.js';

const NEW_PRINCIPALS = [
  'brainstorm-actor',
  'spec-author',
  'plan-author',
  'pipeline-auditor',
  'plan-dispatcher',
] as const;

const OPERATOR_ID = 'apex-agent';

describe('planning-pipeline principal tool policies', () => {
  it('exports a policy entry for each of the four new principals', () => {
    const ids = PLANNING_PIPELINE_POLICIES.map((p: { principalId: string }) => p.principalId);
    for (const principal of NEW_PRINCIPALS) {
      expect(ids).toContain(principal);
    }
  });

  it.each(NEW_PRINCIPALS)('resolves a non-fallback policy for %s', async (principal) => {
    const host = createMemoryHost();
    const spec = PLANNING_PIPELINE_POLICIES.find(
      (p: { principalId: string }) => p.principalId === principal,
    );
    expect(spec, `policy spec for ${principal}`).toBeDefined();
    const atom = buildPolicyAtom(spec, OPERATOR_ID) as Atom;
    await host.atoms.put(atom);

    const policy = await loadLlmToolPolicy(host.atoms, principal as PrincipalId);
    expect(policy).not.toBeNull();
    expect(policy!.principalId).toBe(principal);
    expect(policy!.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write']));
    expect(policy!.disallowedTools).not.toContain('Read');
    expect(policy!.disallowedTools).not.toContain('Grep');
    expect(policy!.disallowedTools).not.toContain('Glob');
    // Pin the canonical eleven-tool deny-list shape so a future drift in
    // READ_ONLY_DENY surfaces here rather than only at policy-resolution
    // time downstream.
    expect([...policy!.disallowedTools].sort()).toEqual([...READ_ONLY_DENY].sort());
  });

  it('writes the canonical pol-llm-tool-policy-<principal-id> atom id', () => {
    for (const principal of NEW_PRINCIPALS) {
      const spec = PLANNING_PIPELINE_POLICIES.find(
        (p: { principalId: string }) => p.principalId === principal,
      );
      const atom = buildPolicyAtom(spec, OPERATOR_ID) as Atom;
      expect(atom.id).toBe(llmToolPolicyAtomId(principal as PrincipalId));
    }
  });
});
