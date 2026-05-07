/**
 * Contract test for buildCanonAtRuntimeStamp.
 *
 * The helper is the substrate-pure bag of canon-at-runtime metadata
 * that single-shot AND agentic stage adapters share. Both paths must
 * produce the same shape so the Console's canon-at-runtime projection
 * reads identically regardless of which adapter the deployment ran.
 *
 * Tests:
 *
 *   1. Default (toolPolicySource omitted -> 'policy'): the result
 *      stamps `tool_policy_source: 'policy'`,
 *      `tool_policy_principal_id: <principal>`, and
 *      `canon_directives_applied` contains the seeded
 *      pol-llm-tool-policy-<principal> id (the canon walker observes
 *      every clean L3 directive at project scope).
 *
 *   2. toolPolicySource='override': the result stamps
 *      `tool_policy_source: 'override'` and OMITS
 *      `tool_policy_principal_id` per the provenance discipline (the
 *      canonical pol-llm-tool-policy-<P> atom was NOT loaded for an
 *      override-bound run; stamping the principal id would lie about
 *      which canon atom bound the LLM).
 *
 *   3. End-to-end via runBrainstorm (single-shot): a memory host with
 *      a seeded brainstorm-actor policy atom + a clean L3 directive
 *      runs the single-shot adapter, and the returned StageOutput's
 *      extraMetadata carries the stamp keys -- proving the wiring
 *      from helper -> adapter -> StageOutput works end-to-end.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../../../src/adapters/memory/index.js';
import { buildCanonAtRuntimeStamp } from '../../../../examples/planning-stages/lib/build-canon-at-runtime-stamp.js';
import { brainstormStage } from '../../../../examples/planning-stages/brainstorm/index.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../../src/types.js';

const NOW: Time = '2026-05-06T00:00:00.000Z' as Time;

/**
 * Seed a minimal pol-llm-tool-policy-<principal> atom + one clean L3
 * directive at project scope. The canon walker in the helper picks up
 * the directive (it scans all clean, non-superseded L3 directives) and
 * the policy loader resolves the policy atom by id.
 */
async function seedCanonAndPolicy(
  host: ReturnType<typeof createMemoryHost>,
  principalId: PrincipalId,
): Promise<{ readonly directiveId: AtomId; readonly policyAtomId: AtomId }> {
  const directiveId = `dev-test-directive-${principalId}` as AtomId;
  const policyAtomId = `pol-llm-tool-policy-${principalId}` as AtomId;
  const directiveAtom: Atom = {
    schema_version: 1,
    id: directiveId,
    content: 'Test L3 directive used by the canon-at-runtime stamp helper.',
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { agent_id: 'test', session_id: 'unit-test' },
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
    metadata: {},
  };
  const policyAtom: Atom = {
    schema_version: 1,
    id: policyAtomId,
    content: `LLM tool deny-list for principal "${String(principalId)}".`,
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { agent_id: 'test', session_id: 'unit-test' },
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
      policy: {
        subject: 'llm-tool-policy',
        principal: String(principalId),
        disallowed_tools: ['Bash', 'Edit', 'Write'],
        rationale: 'unit-test rationale',
      },
    },
  };
  await host.atoms.put(directiveAtom);
  await host.atoms.put(policyAtom);
  return { directiveId, policyAtomId };
}

describe('buildCanonAtRuntimeStamp', () => {
  it('stamps policy-source by default + includes the stage principal id', async () => {
    const host = createMemoryHost();
    const principal: PrincipalId = 'brainstorm-actor' as PrincipalId;
    const { directiveId, policyAtomId } = await seedCanonAndPolicy(
      host,
      principal,
    );

    const stamp = await buildCanonAtRuntimeStamp(host, principal);

    // Provenance discipline: tool_policy_source is the load-bearing
    // discriminator the Console projection reads to decide between
    // 'this canon atom bound the run' (policy) vs 'an override bound
    // the run' (override). Default is 'policy'.
    expect(stamp.tool_policy_source).toBe('policy');
    expect(stamp.tool_policy_principal_id).toBe(String(principal));
    // The canon walker emits all clean L3 directives at project scope;
    // both seeded atoms are L3 directives so the list contains both.
    expect(Array.isArray(stamp.canon_directives_applied)).toBe(true);
    const ids = stamp.canon_directives_applied as ReadonlyArray<string>;
    expect(ids).toContain(String(directiveId));
    expect(ids).toContain(String(policyAtomId));
    // Frozen so a downstream consumer cannot mutate the stamp post-hoc.
    expect(Object.isFrozen(stamp)).toBe(true);
    expect(Object.isFrozen(stamp.canon_directives_applied)).toBe(true);
  });

  it('omits tool_policy_principal_id when source is override', async () => {
    const host = createMemoryHost();
    const principal: PrincipalId = 'brainstorm-actor' as PrincipalId;
    await seedCanonAndPolicy(host, principal);

    const stamp = await buildCanonAtRuntimeStamp(host, principal, {
      toolPolicySource: 'override',
    });

    expect(stamp.tool_policy_source).toBe('override');
    // Provenance discipline: stamping tool_policy_principal_id on an
    // override-bound run would misattribute provenance because the
    // pol-llm-tool-policy-<P> atom was NOT loaded. The field MUST be
    // absent so the Console projection renders an explicit
    // override-bound state instead of a stale principal.
    expect(stamp).not.toHaveProperty('tool_policy_principal_id');
    expect(Array.isArray(stamp.canon_directives_applied)).toBe(true);
  });

  it('runBrainstorm (single-shot) returns extraMetadata carrying the stamp', async () => {
    const host = createMemoryHost();
    const principal: PrincipalId = 'brainstorm-actor' as PrincipalId;
    await seedCanonAndPolicy(host, principal);

    // Replace host.llm.judge with a stub so the single-shot adapter
    // returns deterministic output without an LLM call.
    host.llm.judge = (async (
      _schema: unknown,
      _system: unknown,
      _data: unknown,
      _options: unknown,
    ) => {
      return {
        output: {
          open_questions: [],
          alternatives_surveyed: [],
          decision_points: [],
          cost_usd: 0,
        },
        metadata: { latency_ms: 1, cost_usd: 0 },
      };
    }) as typeof host.llm.judge;

    const out = await brainstormStage.run({
      host,
      principal,
      correlationId: 'corr-stamp-test',
      priorOutput: null,
      pipelineId: 'p-stamp-test' as AtomId,
      seedAtomIds: [],
      verifiedCitedAtomIds: [],
      verifiedSubActorPrincipalIds: [],
      operatorIntentContent: 'unit-test intent',
    });

    expect(out.extraMetadata).toBeDefined();
    expect(out.extraMetadata).toMatchObject({
      tool_policy_source: 'policy',
      tool_policy_principal_id: String(principal),
      canon_directives_applied: expect.any(Array),
    });
    const ids = (out.extraMetadata as Record<string, unknown>)
      .canon_directives_applied as ReadonlyArray<string>;
    // Both seeded L3 atoms should appear in the canon list.
    expect(ids.length).toBeGreaterThan(0);
  });
});
