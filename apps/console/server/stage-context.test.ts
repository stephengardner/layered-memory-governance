import { describe, it, expect } from 'vitest';
import {
  EMPTY_STAGE_CONTEXT,
  buildCanonAtRuntime,
  buildStageContext,
  buildUpstreamChain,
  previewContent,
  type StageContextAtom,
} from './stage-context';

/*
 * Pure-function tests for the stage-context projection. The HTTP
 * route handler at /api/atoms.stage-context wraps `buildStageContext`,
 * so covering the helper here covers the full data path without
 * standing up a TCP socket. Tests fix the upstream atom map + the
 * soul resolver so behavior is deterministic regardless of plugin
 * cache or vendored-skill state.
 */

function atom(partial: Partial<StageContextAtom> & { id: string; type: string }): StageContextAtom {
  return {
    content: '',
    metadata: {},
    provenance: { derived_from: [] },
    created_at: '2026-05-01T00:00:00.000Z',
    ...partial,
  };
}

function makeLookup(atoms: ReadonlyArray<StageContextAtom>): (id: string) => StageContextAtom | null {
  const byId = new Map<string, StageContextAtom>();
  for (const a of atoms) byId.set(a.id, a);
  return (id) => byId.get(id) ?? null;
}

describe('previewContent', () => {
  it('returns empty string for empty input', () => {
    expect(previewContent('')).toBe('');
    expect(previewContent('   \n\n  ')).toBe('');
  });

  it('collapses whitespace and trims', () => {
    expect(previewContent('  foo\n\nbar  ')).toBe('foo bar');
  });

  it('clips long content with an ellipsis', () => {
    const long = 'a'.repeat(500);
    const out = previewContent(long);
    expect(out.length).toBe(240);
    expect(out.endsWith('\u2026')).toBe(true);
  });

  it('returns short content unchanged', () => {
    expect(previewContent('short')).toBe('short');
  });
});

describe('buildUpstreamChain', () => {
  it('returns empty chain when the atom has no derived_from', () => {
    const seed = atom({ id: 'seed-1', type: 'plan' });
    const chain = buildUpstreamChain(seed, makeLookup([]));
    expect(chain).toEqual([]);
  });

  it('walks derived_from once and projects {id, type, content_preview}', () => {
    const intent = atom({
      id: 'intent-1',
      type: 'operator-intent',
      content: 'seed intent body',
      created_at: '2026-05-01T00:00:00.000Z',
    });
    const brainstorm = atom({
      id: 'brainstorm-1',
      type: 'brainstorm-output',
      content: 'open questions ...',
      provenance: { derived_from: ['intent-1'] },
      created_at: '2026-05-01T00:01:00.000Z',
    });
    const seed = atom({
      id: 'plan-1',
      type: 'plan',
      content: 'plan body',
      provenance: { derived_from: ['brainstorm-1'] },
      created_at: '2026-05-01T00:02:00.000Z',
    });

    const chain = buildUpstreamChain(seed, makeLookup([intent, brainstorm, seed]));
    expect(chain.map((c) => c.id)).toEqual(['intent-1', 'brainstorm-1']);
    expect(chain[0]).toEqual({
      id: 'intent-1',
      type: 'operator-intent',
      content_preview: 'seed intent body',
    });
  });

  it('dedupes diamond-shaped chains so a shared ancestor appears once', () => {
    const intent = atom({ id: 'intent-1', type: 'operator-intent', created_at: '2026-05-01T00:00:00.000Z' });
    const brainstorm = atom({
      id: 'brainstorm-1',
      type: 'brainstorm-output',
      provenance: { derived_from: ['intent-1'] },
      created_at: '2026-05-01T00:01:00.000Z',
    });
    const spec = atom({
      id: 'spec-1',
      type: 'spec-output',
      provenance: { derived_from: ['intent-1', 'brainstorm-1'] },
      created_at: '2026-05-01T00:02:00.000Z',
    });
    const plan = atom({
      id: 'plan-1',
      type: 'plan',
      provenance: { derived_from: ['spec-1', 'brainstorm-1'] },
      created_at: '2026-05-01T00:03:00.000Z',
    });

    const chain = buildUpstreamChain(plan, makeLookup([intent, brainstorm, spec, plan]));
    expect(chain.map((c) => c.id)).toEqual(['intent-1', 'brainstorm-1', 'spec-1']);
  });

  it('is cycle-safe: a self-referential derived_from does not infinite-loop', () => {
    const seed = atom({
      id: 'plan-1',
      type: 'plan',
      provenance: { derived_from: ['plan-1', 'intent-1'] },
    });
    const intent = atom({ id: 'intent-1', type: 'operator-intent' });
    const chain = buildUpstreamChain(seed, makeLookup([seed, intent]));
    expect(chain.map((c) => c.id)).toEqual(['intent-1']);
  });

  it('respects maxDepth so a runaway chain does not exhaust the lookup', () => {
    const root = atom({ id: 'a-0', type: 'observation', created_at: '2026-05-01T00:00:00.000Z' });
    const a1 = atom({
      id: 'a-1',
      type: 'observation',
      provenance: { derived_from: ['a-0'] },
      created_at: '2026-05-01T00:01:00.000Z',
    });
    const a2 = atom({
      id: 'a-2',
      type: 'observation',
      provenance: { derived_from: ['a-1'] },
      created_at: '2026-05-01T00:02:00.000Z',
    });
    const a3 = atom({
      id: 'a-3',
      type: 'observation',
      provenance: { derived_from: ['a-2'] },
      created_at: '2026-05-01T00:03:00.000Z',
    });
    const seed = atom({
      id: 'seed',
      type: 'plan',
      provenance: { derived_from: ['a-3'] },
      created_at: '2026-05-01T00:04:00.000Z',
    });
    const chain = buildUpstreamChain(seed, makeLookup([root, a1, a2, a3, seed]), { maxDepth: 2 });
    // depth=0 is seed; depth=1 = a-3; depth=2 = a-2. a-1, a-0 trimmed.
    expect(chain.map((c) => c.id)).toEqual(['a-2', 'a-3']);
  });

  it('skips unknown ancestor ids silently', () => {
    const seed = atom({
      id: 'plan-1',
      type: 'plan',
      provenance: { derived_from: ['intent-known', 'intent-missing'] },
    });
    const intent = atom({ id: 'intent-known', type: 'operator-intent' });
    const chain = buildUpstreamChain(seed, makeLookup([seed, intent]));
    expect(chain.map((c) => c.id)).toEqual(['intent-known']);
  });

  it('orders entries earliest -> latest by created_at', () => {
    const seed = atom({
      id: 'seed',
      type: 'plan',
      provenance: { derived_from: ['a', 'b'] },
      created_at: '2026-05-01T00:10:00.000Z',
    });
    const aLater = atom({ id: 'a', type: 'spec-output', created_at: '2026-05-01T00:05:00.000Z' });
    const bEarlier = atom({ id: 'b', type: 'brainstorm-output', created_at: '2026-05-01T00:03:00.000Z' });
    const chain = buildUpstreamChain(seed, makeLookup([seed, aLater, bEarlier]));
    expect(chain.map((c) => c.id)).toEqual(['b', 'a']);
  });
});

describe('buildCanonAtRuntime', () => {
  it('prefers metadata.canon_directives_applied when present', () => {
    const directive = atom({
      id: 'dev-foo',
      type: 'directive',
      content: 'directive body',
    });
    const policy = atom({
      id: 'pol-llm-tool-policy-brainstorm-actor',
      type: 'directive',
      content: 'policy body',
    });
    const out = buildCanonAtRuntime(
      { canon_directives_applied: ['dev-foo'] },
      'brainstorm-actor',
      makeLookup([directive, policy]),
    );
    expect(out).toEqual([
      {
        id: 'dev-foo',
        type: 'directive',
        content_preview: 'directive body',
        source: 'metadata',
      },
    ]);
  });

  it('dedupes ids inside metadata.canon_directives_applied', () => {
    const directive = atom({ id: 'dev-foo', type: 'directive' });
    const out = buildCanonAtRuntime(
      { canon_directives_applied: ['dev-foo', 'dev-foo'] },
      'brainstorm-actor',
      makeLookup([directive]),
    );
    expect(out).toHaveLength(1);
  });

  it('falls back to pol-llm-tool-policy-<principal> when metadata is empty', () => {
    const policy = atom({
      id: 'pol-llm-tool-policy-brainstorm-actor',
      type: 'directive',
      content: 'tool policy',
    });
    const out = buildCanonAtRuntime(undefined, 'brainstorm-actor', makeLookup([policy]));
    expect(out).toEqual([
      {
        id: 'pol-llm-tool-policy-brainstorm-actor',
        type: 'directive',
        content_preview: 'tool policy',
        source: 'policy',
      },
    ]);
  });

  it('returns empty list when neither metadata nor the policy atom resolves', () => {
    const out = buildCanonAtRuntime(undefined, 'unknown-actor', makeLookup([]));
    expect(out).toEqual([]);
  });

  it('returns empty (no policy fallback) when canon_directives_applied is present but all ids are unresolvable', () => {
    // Contract: when the stage stamped explicit ids onto the atom,
    // those ids are authoritative -- if every one fails to resolve at
    // render-time, the panel renders an empty canon list rather than
    // silently falling back to the per-principal policy. The metadata
    // path and the policy path are mutually exclusive: metadata-present
    // means the runner already decided the relevant set, even if the
    // referenced atom has since been pruned. Falling through to policy
    // would lie to the operator about which directives actually
    // governed the stage.
    const policy = atom({
      id: 'pol-llm-tool-policy-brainstorm-actor',
      type: 'directive',
      content: 'policy body',
    });
    const out = buildCanonAtRuntime(
      { canon_directives_applied: ['pruned-directive-id'] },
      'brainstorm-actor',
      makeLookup([policy]),
    );
    expect(out).toEqual([]);
  });

  /*
   * Dual-principal lookup: stage-mapping principal + atom's
   * principal_id. The atom's principal_id is the truer signal because
   * the substrate persisted it; the stage-mapping principal stays in
   * the union as a backstop for atoms that lack a principal_id (e.g.
   * tests, fixtures, single-shot adapters). Operator value pin: 'a
   * plan atom showing the canon that ACTUALLY bound the LLM, not the
   * canon the table CLAIMS bound it'.
   */
  it('unions atom.principal_id with the stage-mapping principal so plan atoms surface the runner principal policy', () => {
    // Pipeline-emitted plan atom carries principal_id=cto-actor (the
    // pipeline-runner principal in src/runtime/planning-pipeline/runner.ts
    // persistStageOutput). The stage-mapping table claims plan-author.
    // pol-llm-tool-policy-plan-author DOES NOT EXIST in canon (only the
    // six stage principals carry tool policies). pol-llm-tool-policy-cto-actor
    // exists. The dual-principal lookup must surface the cto-actor policy.
    const ctoPolicy = atom({
      id: 'pol-llm-tool-policy-cto-actor',
      type: 'directive',
      content: 'cto-actor tool deny-list',
    });
    const out = buildCanonAtRuntime(
      undefined,
      'plan-author',
      makeLookup([ctoPolicy]),
      'cto-actor',
    );
    expect(out).toEqual([
      {
        id: 'pol-llm-tool-policy-cto-actor',
        type: 'directive',
        content_preview: 'cto-actor tool deny-list',
        source: 'policy',
      },
    ]);
  });

  it('returns BOTH policies when both stage-mapping and atom principals resolve', () => {
    // When both pol-llm-tool-policy-<stage-mapping> AND
    // pol-llm-tool-policy-<atom-principal> are present, surface both.
    // Operator wants the FULL canon picture, not a single policy.
    const planAuthorPolicy = atom({
      id: 'pol-llm-tool-policy-plan-author',
      type: 'directive',
      content: 'plan-author policy',
    });
    const ctoPolicy = atom({
      id: 'pol-llm-tool-policy-cto-actor',
      type: 'directive',
      content: 'cto-actor policy',
    });
    const out = buildCanonAtRuntime(
      undefined,
      'plan-author',
      makeLookup([planAuthorPolicy, ctoPolicy]),
      'cto-actor',
    );
    expect(out.map((e) => e.id).sort()).toEqual([
      'pol-llm-tool-policy-cto-actor',
      'pol-llm-tool-policy-plan-author',
    ]);
    for (const entry of out) {
      expect(entry.source).toBe('policy');
    }
  });

  it('dedupes when stage-mapping and atom principals are identical', () => {
    // brainstorm-output atoms typically have principal_id=brainstorm-actor
    // (single-shot path) -- the stage-mapping principal and the atom
    // principal coincide. The result must not contain a duplicate.
    const policy = atom({
      id: 'pol-llm-tool-policy-brainstorm-actor',
      type: 'directive',
      content: 'brainstorm-actor policy',
    });
    const out = buildCanonAtRuntime(
      undefined,
      'brainstorm-actor',
      makeLookup([policy]),
      'brainstorm-actor',
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe('pol-llm-tool-policy-brainstorm-actor');
  });

  it('falls back to stage-mapping principal only when atomPrincipalId is omitted', () => {
    // Legacy-caller compatibility: tests that build the request without
    // an atom principal continue to work unchanged. The new fourth arg
    // is optional.
    const policy = atom({
      id: 'pol-llm-tool-policy-spec-author',
      type: 'directive',
      content: 'spec policy',
    });
    const out = buildCanonAtRuntime(undefined, 'spec-author', makeLookup([policy]));
    expect(out.map((e) => e.id)).toEqual(['pol-llm-tool-policy-spec-author']);
  });

  it('skips empty / whitespace-only principal candidates so pol-llm-tool-policy- never appears in the lookup', () => {
    // Defensive: a malformed upstream that surfaces an empty principal
    // string must NOT compose `pol-llm-tool-policy-` (which is a real
    // but mostly-empty atom-id prefix). Stage-mapping is the only
    // populated principal here; the empty atom principal is filtered.
    const policy = atom({
      id: 'pol-llm-tool-policy-cto-actor',
      type: 'directive',
      content: 'cto policy',
    });
    const out = buildCanonAtRuntime(
      undefined,
      'cto-actor',
      makeLookup([policy]),
      '   ',
    );
    expect(out.map((e) => e.id)).toEqual(['pol-llm-tool-policy-cto-actor']);
  });

  it('metadata.canon_directives_applied takes precedence over the dual-principal fallback', () => {
    // When the substrate has stamped canon_directives_applied (Phase 2),
    // the dual-principal fallback is NOT consulted. Stamped metadata
    // is write-time evidence; the union path is inference. Mixing them
    // would lie about which directives actually governed the run.
    const stamped = atom({
      id: 'dev-foo',
      type: 'directive',
      content: 'stamped directive',
    });
    const stagePolicy = atom({
      id: 'pol-llm-tool-policy-plan-author',
      type: 'directive',
      content: 'should not appear',
    });
    const atomPolicy = atom({
      id: 'pol-llm-tool-policy-cto-actor',
      type: 'directive',
      content: 'should not appear',
    });
    const out = buildCanonAtRuntime(
      { canon_directives_applied: ['dev-foo'] },
      'plan-author',
      makeLookup([stamped, stagePolicy, atomPolicy]),
      'cto-actor',
    );
    expect(out.map((e) => e.id)).toEqual(['dev-foo']);
    expect(out[0]?.source).toBe('metadata');
  });

  /*
   * Tier-2 source-precedence: metadata.tool_policy_principal_id.
   * The substrate stamps this ONLY when the canonical
   * pol-llm-tool-policy-<P> atom was loaded for the run (override-bound
   * runs are stamped with tool_policy_source='override' instead). When
   * present, this resolves to the stamped-principal's policy atom with
   * source='metadata' and the dual-principal inference is skipped --
   * the substrate already told us exactly which atom bound the LLM.
   */
  it('uses metadata.tool_policy_principal_id when present (skips inference)', () => {
    const stampedPolicy = atom({
      id: 'pol-llm-tool-policy-cto-actor',
      type: 'directive',
      content: 'cto policy body',
    });
    const stagePolicy = atom({
      id: 'pol-llm-tool-policy-plan-author',
      type: 'directive',
      content: 'should not appear (stamped wins)',
    });
    const out = buildCanonAtRuntime(
      { tool_policy_principal_id: 'cto-actor' },
      'plan-author',
      makeLookup([stampedPolicy, stagePolicy]),
      'plan-author',
    );
    expect(out).toEqual([
      {
        id: 'pol-llm-tool-policy-cto-actor',
        type: 'directive',
        content_preview: 'cto policy body',
        source: 'metadata',
      },
    ]);
  });

  it('falls through to inference when metadata.tool_policy_principal_id is whitespace-only', () => {
    // Defensive trim mirrors the dual-principal candidate filter so a
    // malformed stamp cannot compose `pol-llm-tool-policy-` (an
    // empty-suffix lookup that resolves to nothing) and surface a
    // never-resolving entry as 'metadata-bound'.
    const policy = atom({
      id: 'pol-llm-tool-policy-cto-actor',
      type: 'directive',
      content: 'cto policy',
    });
    const out = buildCanonAtRuntime(
      { tool_policy_principal_id: '   ' },
      'plan-author',
      makeLookup([policy]),
      'cto-actor',
    );
    // Falls through to dual-principal inference and resolves cto-actor
    // via the atom-principal path. Source is 'policy' because we used
    // inference, not the stamp.
    expect(out.map((e) => e.id)).toEqual(['pol-llm-tool-policy-cto-actor']);
    expect(out[0]?.source).toBe('policy');
  });

  it('canon_directives_applied still wins over tool_policy_principal_id when both are stamped', () => {
    // Both metadata stamps may co-exist; the explicit applied-list is
    // strictly stronger evidence than the policy principal alone (the
    // applied list IS the resolved canon, not just the bag's source).
    const stamped = atom({ id: 'dev-foo', type: 'directive', content: 'foo' });
    const policy = atom({
      id: 'pol-llm-tool-policy-cto-actor',
      type: 'directive',
      content: 'cto policy',
    });
    const out = buildCanonAtRuntime(
      {
        canon_directives_applied: ['dev-foo'],
        tool_policy_principal_id: 'cto-actor',
      },
      'plan-author',
      makeLookup([stamped, policy]),
    );
    expect(out.map((e) => e.id)).toEqual(['dev-foo']);
    expect(out[0]?.source).toBe('metadata');
  });
});

describe('buildStageContext', () => {
  it('returns EMPTY_STAGE_CONTEXT for non-pipeline atoms', async () => {
    const seed = atom({ id: 'obs-1', type: 'observation' });
    const out = await buildStageContext(seed, makeLookup([seed]));
    expect(out).toEqual(EMPTY_STAGE_CONTEXT);
  });

  it('returns full context for a brainstorm-output atom', async () => {
    const intent = atom({
      id: 'intent-1',
      type: 'operator-intent',
      content: 'seed intent',
      created_at: '2026-05-01T00:00:00.000Z',
    });
    const seed = atom({
      id: 'brainstorm-1',
      type: 'brainstorm-output',
      content: 'questions ...',
      metadata: { stage_name: 'brainstorm-stage', pipeline_id: 'pipeline-x' },
      provenance: { derived_from: ['intent-1'] },
      created_at: '2026-05-01T00:01:00.000Z',
    });
    const out = await buildStageContext(seed, makeLookup([intent, seed]), {
      resolveBundle: async () => '# Brainstorming skill\nbody',
    });
    expect(out.stage).toBe('brainstorm-stage');
    expect(out.principal_id).toBe('brainstorm-actor');
    expect(out.skill_bundle).toBe('brainstorming');
    expect(out.soul).toContain('Brainstorming skill');
    expect(out.upstream_chain.map((c) => c.id)).toEqual(['intent-1']);
    expect(out.canon_at_runtime).toEqual([]);
  });

  it('returns null soul when the resolver fails (no 500)', async () => {
    const seed = atom({
      id: 'plan-1',
      type: 'plan',
      metadata: { stage_name: 'plan-stage', pipeline_id: 'pipeline-x' },
    });
    const out = await buildStageContext(seed, makeLookup([seed]), {
      resolveBundle: async () => {
        throw new Error('plugin cache offline + vendored missing');
      },
    });
    expect(out.stage).toBe('plan-stage');
    expect(out.soul).toBeNull();
  });

  it('falls back to type-based stage inference when metadata.stage_name is absent', async () => {
    const seed = atom({
      id: 'spec-1',
      type: 'spec-output',
      metadata: { pipeline_id: 'pipeline-x' },
      content: 'spec body',
    });
    const out = await buildStageContext(seed, makeLookup([seed]), {
      resolveBundle: async () => '# Writing-clearly skill',
    });
    expect(out.stage).toBe('spec-stage');
    expect(out.principal_id).toBe('spec-author');
    expect(out.skill_bundle).toBe('writing-clearly');
  });

  it('returns EMPTY_STAGE_CONTEXT for a manually-authored plan (no pipeline_id)', async () => {
    const seed = atom({
      id: 'plan-manual',
      type: 'plan',
      metadata: { title: 'manual plan' },
    });
    const out = await buildStageContext(seed, makeLookup([seed]));
    expect(out).toEqual(EMPTY_STAGE_CONTEXT);
  });

  it('surfaces canon-at-runtime via the policy fallback when metadata is missing', async () => {
    const policy = atom({
      id: 'pol-llm-tool-policy-spec-author',
      type: 'directive',
      content: 'spec author tool deny-list',
    });
    const seed = atom({
      id: 'spec-1',
      type: 'spec-output',
      metadata: { pipeline_id: 'pipeline-x' },
    });
    const out = await buildStageContext(seed, makeLookup([seed, policy]), {
      resolveBundle: async () => null,
    });
    expect(out.canon_at_runtime).toEqual([
      {
        id: 'pol-llm-tool-policy-spec-author',
        type: 'directive',
        content_preview: 'spec author tool deny-list',
        source: 'policy',
      },
    ]);
  });

  it('passes the maxDepth option through to the chain walker', async () => {
    const a = atom({ id: 'a', type: 'observation', created_at: '2026-05-01T00:00:00.000Z' });
    const b = atom({
      id: 'b',
      type: 'observation',
      provenance: { derived_from: ['a'] },
      created_at: '2026-05-01T00:01:00.000Z',
    });
    const c = atom({
      id: 'c',
      type: 'observation',
      provenance: { derived_from: ['b'] },
      created_at: '2026-05-01T00:02:00.000Z',
    });
    const seed = atom({
      id: 'brainstorm-1',
      type: 'brainstorm-output',
      metadata: { pipeline_id: 'pipeline-x' },
      provenance: { derived_from: ['c'] },
      created_at: '2026-05-01T00:03:00.000Z',
    });
    const out = await buildStageContext(seed, makeLookup([a, b, c, seed]), {
      resolveBundle: async () => null,
      maxDepth: 1,
    });
    // depth 1 includes c; depth 2 would include b; depth 3 would include a.
    expect(out.upstream_chain.map((e) => e.id)).toEqual(['c']);
  });

  /*
   * End-to-end coverage of the dual-principal lookup at the top-level
   * buildStageContext entrypoint. Documents the full data path the
   * /api/atoms.stage-context route exercises: a pipeline-emitted plan
   * atom carries principal_id=cto-actor (substrate-persisted), the
   * stage-mapping table claims plan-author, and the panel must surface
   * pol-llm-tool-policy-cto-actor (the policy that ACTUALLY bound the
   * LLM) rather than rendering empty because pol-llm-tool-policy-plan-author
   * does not exist.
   */
  it('forwards atom.principal_id to the canon-at-runtime fallback so plan atoms surface the runner-principal policy', async () => {
    const ctoPolicy = atom({
      id: 'pol-llm-tool-policy-cto-actor',
      type: 'directive',
      content: 'cto-actor tool deny-list',
    });
    const seed = atom({
      id: 'plan-1',
      type: 'plan',
      metadata: { stage_name: 'plan-stage', pipeline_id: 'pipeline-x' },
      principal_id: 'cto-actor',
    });
    const out = await buildStageContext(seed, makeLookup([seed, ctoPolicy]), {
      resolveBundle: async () => null,
    });
    expect(out.stage).toBe('plan-stage');
    // The header still surfaces the stage-mapping principal so the
    // panel labels the stage role consistently.
    expect(out.principal_id).toBe('plan-author');
    expect(out.canon_at_runtime).toEqual([
      {
        id: 'pol-llm-tool-policy-cto-actor',
        type: 'directive',
        content_preview: 'cto-actor tool deny-list',
        source: 'policy',
      },
    ]);
  });

  /*
   * Phase 2 contract: the substrate's run-stage-agent-loop helper stamps
   * canon_directives_applied + tool_policy_principal_id onto the
   * stage-output atom's metadata. When the stamped metadata is present,
   * buildStageContext returns those entries with source=metadata and
   * skips the dual-principal fallback.
   */
  it('returns metadata-sourced canon entries when the substrate has stamped canon_directives_applied', async () => {
    const directive = atom({
      id: 'dev-extreme-rigor-and-research',
      type: 'directive',
      content: 'rigor directive body',
    });
    const stagePolicy = atom({
      id: 'pol-llm-tool-policy-plan-author',
      type: 'directive',
      content: 'should not appear (metadata wins)',
    });
    const seed = atom({
      id: 'plan-2',
      type: 'plan',
      metadata: {
        stage_name: 'plan-stage',
        pipeline_id: 'pipeline-x',
        canon_directives_applied: ['dev-extreme-rigor-and-research'],
        tool_policy_principal_id: 'cto-actor',
      },
      principal_id: 'cto-actor',
    });
    const out = await buildStageContext(seed, makeLookup([seed, directive, stagePolicy]), {
      resolveBundle: async () => null,
    });
    expect(out.canon_at_runtime).toEqual([
      {
        id: 'dev-extreme-rigor-and-research',
        type: 'directive',
        content_preview: 'rigor directive body',
        source: 'metadata',
      },
    ]);
  });
});
