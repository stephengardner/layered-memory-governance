import { describe, expect, it } from 'vitest';
import {
  pipelineStagePrincipalSkillBundle,
  _pipelineStagePrincipalSkillBundleMapForTests,
} from './pipeline-stage-skill-resolver';
import {
  PIPELINE_STAGE_NAMES,
  bindingForStage,
} from '../../../examples/planning-stages/lib/stage-mapping';

/*
 * Coverage for the inverted pipeline-stage principal -> skill-bundle
 * resolver. Tests are pinned against the forward STAGE_TABLE in
 * examples/planning-stages/lib/stage-mapping.ts so a future edit to the
 * table that adds, renames, or re-points a stage produces a single
 * test failure here rather than silent drift.
 */
describe('pipelineStagePrincipalSkillBundle', () => {
  it('resolves the brainstorm-actor principal to the brainstorming bundle', () => {
    expect(pipelineStagePrincipalSkillBundle('brainstorm-actor')).toBe('brainstorming');
  });

  it('resolves the spec-author principal to the writing-clearly bundle', () => {
    expect(pipelineStagePrincipalSkillBundle('spec-author')).toBe('writing-clearly');
  });

  it('resolves the plan-author principal to the writing-plans bundle', () => {
    expect(pipelineStagePrincipalSkillBundle('plan-author')).toBe('writing-plans');
  });

  it('resolves the pipeline-auditor principal to the review-discipline bundle', () => {
    expect(pipelineStagePrincipalSkillBundle('pipeline-auditor')).toBe('review-discipline');
  });

  it('resolves the plan-dispatcher principal to the dispatch-discipline bundle', () => {
    expect(pipelineStagePrincipalSkillBundle('plan-dispatcher')).toBe('dispatch-discipline');
  });

  it('returns null for principals outside the pipeline-stage set', () => {
    /*
     * A non-pipeline principal (cto-actor, code-author, apex-agent,
     * lag-ceo, etc.) MUST resolve to null so the route handler falls
     * through to the per-principal `.claude/skills/<id>/SKILL.md`
     * lookup. Mis-routing a non-pipeline principal into the bundle
     * branch would surface a SkillBundleNotFoundError as a 500 rather
     * than the existing actor-skill-debt empty-state.
     */
    expect(pipelineStagePrincipalSkillBundle('cto-actor')).toBeNull();
    expect(pipelineStagePrincipalSkillBundle('code-author')).toBeNull();
    expect(pipelineStagePrincipalSkillBundle('apex-agent')).toBeNull();
    expect(pipelineStagePrincipalSkillBundle('lag-ceo')).toBeNull();
  });

  it('returns null for the empty string', () => {
    expect(pipelineStagePrincipalSkillBundle('')).toBeNull();
  });

  it('matches the forward STAGE_TABLE entry-for-entry', () => {
    /*
     * Parity test: for every canonical pipeline-stage name, the
     * resolver MUST produce a (principalId -> skillBundle) entry that
     * agrees with `bindingForStage(stageName)`. A future edit that
     * renames a principal or swaps a bundle in the forward table fails
     * this assertion without needing per-stage updates above (those
     * stay as named-and-pinned safety nets for the indie-floor 5).
     */
    const map = _pipelineStagePrincipalSkillBundleMapForTests();
    for (const stageName of PIPELINE_STAGE_NAMES) {
      const binding = bindingForStage(stageName);
      expect(binding, `binding for ${stageName}`).not.toBeNull();
      if (binding === null) continue;
      expect(map.get(binding.principalId)).toBe(binding.skillBundle);
    }
    /*
     * Cardinality pin: the inverted map size matches the canonical
     * stage count so a future stage added to STAGE_TABLE (without an
     * edit to CANONICAL_STAGES in the resolver) surfaces here.
     */
    expect(map.size).toBe(PIPELINE_STAGE_NAMES.length);
  });
});
