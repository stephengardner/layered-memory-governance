import { describe, it, expect } from 'vitest';
import { routeForAtomId } from './router.store';

/*
 * Pure-function coverage for the atom-id -> view router. The function
 * is the click-target gateway for every clickable atom reference in
 * the console (activity feed, hover cards, atom-ref components), so a
 * dead-end mapping for a real atom-id prefix immediately surfaces as
 * "click does nothing" in the UI.
 */

describe('routeForAtomId', () => {
  describe('plans', () => {
    it('routes plain plan-* ids to the plans view', () => {
      expect(routeForAtomId('plan-2026-04-26-some-plan')).toBe('plans');
      expect(routeForAtomId('plan-cto-actor-research-overflow-2026-04-26T11-00-00-000Z')).toBe('plans');
    });

    it('routes plan-merge-settled-* ids to activities (settlement records, not plans)', () => {
      expect(routeForAtomId('plan-merge-settled-2026-04-26-pr-228')).toBe('activities');
    });
  });

  describe('activities', () => {
    it('routes op-action-* ids to activities', () => {
      expect(routeForAtomId('op-action-lag-ceo-1777302525883-70331e6a')).toBe('activities');
    });

    it('routes ama-* ids to activities', () => {
      expect(routeForAtomId('ama-audit-reply-self-audit-1776704837062-1776705188889')).toBe('activities');
    });

    it('routes pr-observation-* ids to activities', () => {
      expect(routeForAtomId('pr-observation-228-2026-04-26T11-00-00-000Z')).toBe('activities');
    });

    it('routes intent-* ids to activities', () => {
      expect(routeForAtomId('intent-operator-2026-04-26-some-intent')).toBe('activities');
    });

    it('routes q-* (question/deliberation) ids to activities', () => {
      // Without this branch, q-* atoms fell through to 'canon' and
      // produced an empty focus-mode page in the canon view because
      // the canon list is filtered to canon atom types.
      expect(routeForAtomId('q-10be84a49c4b530b-2026-04-26T09-17-47-639Z')).toBe('activities');
      expect(routeForAtomId('q-9d7166ce95959515-2026-04-24T22-54-23-498Z')).toBe('activities');
    });

    it('routes pipeline-stage-event-* descendants to activities (not pipelines)', () => {
      // The pipelines.detail endpoint does an exact-match lookup on
      // root pipeline atoms. Routing a descendant id to /pipelines/<id>
      // would return 404 because descendants are not in pipelinesById.
      // Activities focus-mode handles arbitrary ids, so descendants
      // route there until the detail handler resolves descendants to
      // their parent pipeline.
      expect(routeForAtomId('pipeline-stage-event-abc-2026-04-26T01-00-00-000Z')).toBe('activities');
    });

    it('routes pipeline-audit-finding-* descendants to activities', () => {
      expect(routeForAtomId('pipeline-audit-finding-xyz-2026-04-26T01-00-00-000Z')).toBe('activities');
    });

    it('routes pipeline-failed-* descendants to activities', () => {
      expect(routeForAtomId('pipeline-failed-abc-2026-04-26T01-00-00-000Z')).toBe('activities');
    });

    it('routes pipeline-resume-* descendants to activities', () => {
      expect(routeForAtomId('pipeline-resume-abc-2026-04-26T01-00-00-000Z')).toBe('activities');
    });

    // Stage-output atoms are pipeline descendants persisted per-stage
    // by the deep planning pipeline (see PR #252). Without explicit
    // routing they fall through to canon and dead-end in focus mode
    // because the canon list is filtered to canon atom types. Table-
    // driven so adding the next descendant prefix is one line of data.
    it.each([
      ['brainstorm-output-*', 'brainstorm-output-abc-2026-04-30T01-00-00-000Z'],
      ['spec-output-*', 'spec-output-xyz-2026-04-30T01-00-00-000Z'],
      ['review-report-*', 'review-report-abc-2026-04-30T01-00-00-000Z'],
      ['dispatch-record-*', 'dispatch-record-abc-2026-04-30T01-00-00-000Z'],
    ])('routes %s stage-output atoms to activities', (_label, atomId) => {
      expect(routeForAtomId(atomId)).toBe('activities');
    });
  });

  describe('canon (default)', () => {
    it('routes architecture atoms to canon', () => {
      expect(routeForAtomId('arch-atomstore-source-of-truth')).toBe('canon');
    });

    it('routes directive atoms to canon', () => {
      expect(routeForAtomId('dev-mobile-first-and-mobile-tested')).toBe('canon');
      expect(routeForAtomId('dev-canon-strategic-not-tactical')).toBe('canon');
    });

    it('routes invariant atoms to canon', () => {
      expect(routeForAtomId('inv-l3-requires-human')).toBe('canon');
    });

    it('routes policy atoms to canon', () => {
      expect(routeForAtomId('pol-cto-plan-approve-denied')).toBe('canon');
    });

    it('routes decision atoms to canon', () => {
      expect(routeForAtomId('dec-kill-switch-design-first')).toBe('canon');
    });

    it('routes preference atoms to canon', () => {
      expect(routeForAtomId('pref-l3-threshold-default')).toBe('canon');
    });

    it('routes reference atoms to canon', () => {
      expect(routeForAtomId('ref-target-architecture')).toBe('canon');
    });

    it('routes unknown ids to canon (fallback)', () => {
      // The fallback is intentionally 'canon' for now; unknown atom
      // types are most likely future canon prefixes. If a non-canon
      // class becomes prominent enough to dead-end clicks, add an
      // explicit branch above (mirroring how q-* was added 2026-04-27).
      expect(routeForAtomId('mystery-atom-2026-04-26')).toBe('canon');
    });
  });

  describe('pipelines', () => {
    it('routes root pipeline-* ids (not descendants) to the pipelines view', () => {
      // Root pipeline atom ids look like `pipeline-<correlation-id>`.
      // The detail handler exact-matches these in `index.pipelinesById`,
      // so the route lands on a real drill-in.
      expect(routeForAtomId('pipeline-abc123')).toBe('pipelines');
      expect(routeForAtomId('pipeline-2026-04-26-deep-plan-run')).toBe('pipelines');
    });
  });

  describe('order sensitivity', () => {
    it('plan-merge-settled wins against the generic plan- prefix', () => {
      // If the generic `plan-` check ran first, settlement records
      // would route to /plans/<id> and rendered nothing because
      // they're not plan documents.
      const id = 'plan-merge-settled-2026-04-26-pr-228';
      expect(routeForAtomId(id)).toBe('activities');
      expect(routeForAtomId(id)).not.toBe('plans');
    });

    it('pipeline descendants win against the generic pipeline- prefix', () => {
      // If the generic `pipeline-` check ran first, descendant atoms
      // would route to /pipelines/<id> and 404 against the detail
      // endpoint because descendants are not root atoms.
      const id = 'pipeline-stage-event-abc-2026-04-26T01-00-00-000Z';
      expect(routeForAtomId(id)).toBe('activities');
      expect(routeForAtomId(id)).not.toBe('pipelines');
    });
  });
});
