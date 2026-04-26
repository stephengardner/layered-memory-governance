/*
 * Single source of truth for plan_state -> CSS tone mapping.
 *
 * Imported by: PlansView, PlanLifecycleView, e2e tests. The map was
 * previously duplicated across two component files with a doc-comment
 * begging for it to drift; CR rightly flagged that as a DRY violation.
 *
 * Token discipline: every tone resolves to a semantic token defined
 * in `src/tokens/tokens.css`. No hex, no hardcoded color.
 *
 * `approved` and `succeeded` SHOULD NOT collapse onto the same tone:
 * the former is "we let it run" and the latter is "it ran and the
 * result is good." Painting them identical green misleads the
 * operator into reading approved as terminal.
 */

/*
 * Console-local union of plan_state values the UI knows how to render.
 * Mirrors the runtime PlanState union (`src/substrate/types.ts`) plus
 * three cross-flow markers that surface in the same pill.
 *
 * We mirror instead of importing the substrate union directly because
 * the console layer must not pull from `src/` (substrate purity);
 * that import would also tie console releases to substrate release
 * cadence, which is a coupling we deliberately avoid. The trade-off
 * is a CI-time risk that the substrate adds a state without the
 * console mirror following — `planStateTone()` falls back to a
 * neutral tone in that case so the pill stays visible (never
 * invisible) and the e2e regression spec asserts every union member
 * resolves to a non-fallback tone, so a missed mirror fails the
 * `state-pill-tones.spec.ts` suite at PR time.
 *
 * Per-flow source (each non-canonical-PlanState marker cites its
 * producer):
 *   draft    -> Question/Proposal flows that haven't crossed into
 *               PlanState yet (services/questions.service.ts)
 *   pending  -> dispatch-in-flight signal from PR observation atoms
 *               before plan_state resolves (services/plan-lifecycle
 *               .service.ts)
 *   rejected -> arbitration outcomes from policy gates that veto a
 *               plan before it can transition to `executing`
 *               (substrate arbitration; surfaced via plan_state alias)
 */
export type PlanStateName =
  | 'proposed'
  | 'approved'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'abandoned'
  | 'draft'
  | 'pending'
  | 'rejected';

export const PLAN_STATE_TONE: Readonly<Record<PlanStateName, string>> = Object.freeze({
  proposed: 'var(--accent)',
  draft: 'var(--text-tertiary)',
  pending: 'var(--status-warning)',
  approved: 'var(--accent-active)',
  rejected: 'var(--status-danger)',
  executing: 'var(--status-info)',
  succeeded: 'var(--status-success)',
  failed: 'var(--status-danger)',
  abandoned: 'var(--text-tertiary)',
});

/*
 * Resolve the CSS tone for a `plan_state` value. Returns the configured
 * tone for known states; falls back to `--text-secondary` for unknown
 * or empty states so a typo or new substrate state doesn't render the
 * pill invisible. The resolver accepts `string | null | undefined`
 * (not `PlanStateName`) because the API surface returns plan_state as
 * a free-form string and we want the UI to stay live across substrate
 * vocabulary changes rather than throw.
 */
export function planStateTone(state: string | null | undefined): string {
  if (typeof state !== 'string' || state.length === 0) {
    return 'var(--text-secondary)';
  }
  return (PLAN_STATE_TONE as Record<string, string>)[state] ?? 'var(--text-secondary)';
}
