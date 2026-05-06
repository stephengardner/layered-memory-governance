import { describe, it, expect } from 'vitest';
import { classifyPrincipal, type PrincipalClassifierInput } from './principal-classifier';

/*
 * Unit coverage for the principal-skill empty-state classifier. Each
 * test pins one branch of the decision tree against a hand-built
 * projection so the classifier contract stays stable independent of
 * the upstream principal record shape. Boundary cases live alongside
 * the happy path so a future refactor that reorders the checks gets
 * caught (e.g. dropping the apex-dominates-hasSkill rule).
 *
 * Real-world principals exercised explicitly:
 *   - apex-agent (role='apex', signs apex-agent's children) -> authority-root
 *   - claude-agent (role='agent', signs 10 children) -> authority-anchor
 *   - cto-actor (role='agent', leaf, has SKILL.md) -> actor-with-skill
 *   - code-author (role='agent', leaf, no SKILL.md) -> actor-skill-debt
 */

const baseLeaf: PrincipalClassifierInput = {
  role: 'agent',
  hasChildren: false,
  hasSkill: false,
};

describe('classifyPrincipal', () => {
  describe('authority-root', () => {
    it('returns authority-root for role===apex (apex-agent)', () => {
      expect(classifyPrincipal({
        role: 'apex',
        hasChildren: true,
        hasSkill: false,
      })).toBe('authority-root');
    });

    it('treats apex as authority-root even when hasSkill is true', () => {
      /*
       * Authority dominates skill-presence. An apex-role principal
       * that happens to carry a SKILL.md is still the authority root;
       * the skill presence does not reclassify it as a leaf actor.
       * This rule keeps the empty-state copy semantically honest:
       * apex never reads as "missing a playbook".
       */
      expect(classifyPrincipal({
        role: 'apex',
        hasChildren: false,
        hasSkill: true,
      })).toBe('authority-root');
    });

    it('treats apex as authority-root when no children are signed', () => {
      /*
       * Authority-root is identified by role alone, not by
       * hasChildren. A fresh-install repo where the apex has not yet
       * signed any agent principals still classifies the apex as the
       * authority root.
       */
      expect(classifyPrincipal({
        role: 'apex',
        hasChildren: false,
        hasSkill: false,
      })).toBe('authority-root');
    });
  });

  describe('authority-anchor', () => {
    it('returns authority-anchor for role===agent + hasChildren (claude-agent)', () => {
      expect(classifyPrincipal({
        role: 'agent',
        hasChildren: true,
        hasSkill: false,
      })).toBe('authority-anchor');
    });

    it('treats anchor as authority-anchor even when hasSkill is true', () => {
      /*
       * An anchor that ships with a SKILL.md is still semantically an
       * anchor; the empty-state copy intent is "this principal does
       * not own a playbook by design". hasChildren is the load-bearing
       * signal that the principal is a trust-relay layer rather than
       * a leaf actor.
       */
      expect(classifyPrincipal({
        role: 'agent',
        hasChildren: true,
        hasSkill: true,
      })).toBe('authority-anchor');
    });
  });

  describe('actor-with-skill', () => {
    it('returns actor-with-skill for a leaf agent with SKILL.md (cto-actor)', () => {
      expect(classifyPrincipal({
        ...baseLeaf,
        hasSkill: true,
      })).toBe('actor-with-skill');
    });
  });

  describe('actor-skill-debt', () => {
    it('returns actor-skill-debt for a leaf agent with no SKILL.md (code-author)', () => {
      expect(classifyPrincipal(baseLeaf)).toBe('actor-skill-debt');
    });

    it('returns actor-skill-debt for role===agent with no children and no skill', () => {
      /*
       * Boundary: a leaf agent must NOT classify as authority-anchor.
       * If a future refactor drops the hasChildren check, this test
       * catches the regression because the leaf would fall into the
       * anchor branch on the role match alone.
       */
      expect(classifyPrincipal({
        role: 'agent',
        hasChildren: false,
        hasSkill: false,
      })).toBe('actor-skill-debt');
    });

    it('returns actor-skill-debt for role===human (no human branch yet)', () => {
      /*
       * `human` is a canonical role the classifier knows about (see the
       * principal-classifier.ts comment listing apex/agent/human/...).
       * The classifier deliberately has no human-specific branch today,
       * so a role===human principal falls through to the default
       * skill-debt arm. This is intentional fallback rather than an
       * "unrecognized role" surprise: until a human-specific empty-state
       * copy is authored, "no playbook authored" is more honest than a
       * by-design framing we cannot prove. Pinning the behaviour here
       * makes a future addition of a human branch a deliberate edit
       * rather than a silent regression.
       */
      expect(classifyPrincipal({
        role: 'human',
        hasChildren: false,
        hasSkill: false,
      })).toBe('actor-skill-debt');
    });

    it('returns actor-skill-debt when role is undefined', () => {
      /*
       * A principal record loaded from disk without a role field is
       * treated as a leaf actor with skill debt rather than crashing
       * the endpoint. The narrowing must be total.
       */
      expect(classifyPrincipal({
        role: undefined,
        hasChildren: false,
        hasSkill: false,
      })).toBe('actor-skill-debt');
    });
  });

  describe('discriminator combinations', () => {
    it('apex with hasChildren resolves to authority-root, not authority-anchor', () => {
      /*
       * Order-of-checks pinpoint: even though role===apex AND
       * hasChildren===true could match both rule 1 (role==='apex')
       * and rule 2 (role==='agent' AND hasChildren), rule 1 fires
       * first because role===apex never satisfies role==='agent'.
       * This test pins that ordering.
       */
      expect(classifyPrincipal({
        role: 'apex',
        hasChildren: true,
        hasSkill: false,
      })).toBe('authority-root');
    });

    it('agent with no children but hasSkill resolves to actor-with-skill', () => {
      /*
       * Order-of-checks: rule 2 fails (no children), rule 3 matches.
       * Confirms a leaf agent with a skill is classified by skill
       * presence, not by hasChildren default.
       */
      expect(classifyPrincipal({
        role: 'agent',
        hasChildren: false,
        hasSkill: true,
      })).toBe('actor-with-skill');
    });
  });
});
