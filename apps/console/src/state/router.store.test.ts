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

  });

  describe('atom-detail (pipeline stage outputs)', () => {
    /*
     * Stage-output atoms are pipeline descendants persisted per-stage
     * by the deep planning pipeline. Each is a first-class atom with
     * a rich type-specific renderer in the atom-detail viewer; the
     * activity-feed focus mode would collapse the body to a one-line
     * preview and hide the structured view (open questions,
     * alternatives, audit findings, ...). Per operator directive
     * 2026-05-01 ("we want to actually be able to see the full atom
     * details when we click on it") these route to /atom/<id>.
     *
     * Table-driven so adding the next stage-output prefix is one
     * line of data.
     */
    it.each([
      ['brainstorm-output-*', 'brainstorm-output-abc-2026-04-30T01-00-00-000Z'],
      ['spec-output-*', 'spec-output-xyz-2026-04-30T01-00-00-000Z'],
      ['review-report-*', 'review-report-abc-2026-04-30T01-00-00-000Z'],
      ['dispatch-record-*', 'dispatch-record-abc-2026-04-30T01-00-00-000Z'],
    ])('routes %s stage-output atoms to /atom/<id>', (_label, atomId) => {
      expect(routeForAtomId(atomId)).toBe('atom');
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

  });

  describe('atom-detail (generic fallback)', () => {
    it('routes unknown ids to the generic atom-detail viewer', () => {
      // Default behaviour for any id whose prefix is not one of the
      // known buckets above. Replaces the old 'canon' fallback so a
      // non-canon atom (plan-* settlement, observation-*, agent-turn-*,
      // spec-output-*, etc.) always lands on a meaningful page. The
      // generic atom-detail viewer renders the full atom shape with
      // type-specific renderers for the high-volume types and a
      // generic fallback for unknown types.
      expect(routeForAtomId('mystery-atom-2026-04-26')).toBe('atom');
    });

    it('routes brainstorm-* root prefixes to atom-detail', () => {
      // A plain `brainstorm-` (without `-output-`) doesn't match the
      // pipeline-descendant list or any canon prefix; it lands on the
      // generic detail page where the brainstorm-output renderer (or
      // generic fallback for non-output variants) renders it.
      expect(routeForAtomId('brainstorm-2026-05-01')).toBe('atom');
    });

    it('routes auditor-plan-check-* (verdict observations) to atom-detail', () => {
      // verdict atoms are typed `observation` with metadata.kind=
      // 'auditor-plan-check'; their id starts with `auditor-plan-check-`
      // which doesn't match any canon prefix. Generic detail viewer
      // dispatches to the auditor-plan-check renderer based on the
      // atom's metadata.kind, not its id prefix.
      expect(routeForAtomId('auditor-plan-check-some-plan-2026-05-01')).toBe('atom');
    });

    it('routes operator-intent-* to atom-detail', () => {
      // operator-intent atoms carry the trust_envelope shape; the
      // generic atom-detail viewer dispatches to the operator-intent
      // renderer. Note: short-form `intent-*` ids route to activities
      // per the existing ACTIVITY_PREFIXES branch above.
      expect(routeForAtomId('operator-intent-canon-scout-1777358233934')).toBe('atom');
    });

    it('routes a bare `spec-output` id (without trailing dash) to atom-detail via fallback', () => {
      // The PIPELINE_STAGE_OUTPUT_PREFIXES list matches `'spec-output-'`,
      // so an id without the trailing dash does not match that prefix
      // and falls through to the generic fallback. (Both paths end at
      // /atom/<id>, but the test pins the fallback path explicitly so a
      // future re-shuffle of the prefix lists doesn't silently re-route.)
      expect(routeForAtomId('spec-output')).toBe('atom');
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
