/*
 * Single source of truth for atom-type -> CSS tone mapping used by
 * the activities feed (timeline dots) and the graph viewer (node
 * fills + filter chips). Extracted at N=2 callers per canon
 * `dev-extract-at-n-equals-two` so adding a new type colors both
 * surfaces in one edit instead of drifting between them.
 *
 * Coverage discipline: every type that has a labeled verb in
 * `apps/console/server/actor-activity.ts.VERB_BY_TYPE` MUST appear
 * here too, otherwise it falls through to the muted-gray default and
 * disappears in the legend. Mirrors the running-state cyan choice
 * in `features/pipelines-viewer/tones.ts` so the lifecycle family
 * reads the same color across the console.
 *
 * Family rationale (so the legend reads sensibly):
 *   - Canon writes:
 *       directive   -> --status-danger   (governance gate)
 *       decision    -> --accent          (operator-stated decision)
 *       preference  -> --status-warning  (taste / dial)
 *       reference   -> --status-success  (cited prior art)
 *       observation -> --text-muted      (ambient note)
 *       question    -> --text-tertiary   (open thread)
 *   - Operator + plan family (accent track):
 *       operator-intent      -> --accent-active  (planning seed, emphasis)
 *       plan                 -> --accent-active
 *       plan-merge-settled   -> --accent-active
 *       actor-message        -> --accent-hover
 *       actor-message-ack    -> --accent-hover
 *   - Lifecycle / observability (info cyan, "in flight"):
 *       pipeline, pipeline-stage-event, pipeline-resume,
 *       brainstorm-output, spec-output, dispatch-record,
 *       agent-session, agent-turn -> --status-info
 *   - Review + findings:
 *       pipeline-audit-finding -> --status-warning
 *       review-report          -> --status-warning
 *       pipeline-failed        -> --status-danger
 */

export const ATOM_TYPE_TONE: Readonly<Record<string, string>> = Object.freeze({
  directive: 'var(--status-danger)',
  decision: 'var(--accent)',
  preference: 'var(--status-warning)',
  reference: 'var(--status-success)',
  observation: 'var(--text-muted)',
  question: 'var(--text-tertiary)',
  'actor-message': 'var(--accent-hover)',
  'actor-message-ack': 'var(--accent-hover)',
  plan: 'var(--accent-active)',
  'plan-merge-settled': 'var(--accent-active)',
  'operator-intent': 'var(--accent-active)',
  pipeline: 'var(--status-info)',
  'pipeline-stage-event': 'var(--status-info)',
  'pipeline-resume': 'var(--status-info)',
  'pipeline-audit-finding': 'var(--status-warning)',
  'pipeline-failed': 'var(--status-danger)',
  'brainstorm-output': 'var(--status-info)',
  'spec-output': 'var(--status-info)',
  'review-report': 'var(--status-warning)',
  'dispatch-record': 'var(--status-info)',
  'agent-session': 'var(--status-info)',
  'agent-turn': 'var(--status-info)',
});

/** Fallback tone for unknown atom types (drift / new substrate types). */
export const ATOM_TYPE_TONE_FALLBACK = 'var(--text-muted)';

/**
 * Resolve an atom type to its semantic-token tone string.
 *
 * Returns the fallback (`--text-muted`) for unknown types so a freshly
 * shipped substrate type renders as muted gray rather than throwing or
 * leaving a dot unstyled. New types should be added to ATOM_TYPE_TONE
 * (and to GraphView's ALL_KINDS list) as they land.
 */
export function atomTypeTone(type: string | null | undefined): string {
  if (typeof type !== 'string' || type.length === 0) {
    return ATOM_TYPE_TONE_FALLBACK;
  }
  return ATOM_TYPE_TONE[type] ?? ATOM_TYPE_TONE_FALLBACK;
}

/*
 * Filterable atom kinds. Mirrors the keys of ATOM_TYPE_TONE so every
 * colored type is also exposed as a filter chip. Consumed by GraphView
 * for the toolbar filter row; ActivitiesView does not currently expose
 * a filter UI but reads from the same tone map so the surfaces stay
 * coherent.
 */
export const ATOM_TYPE_KINDS: ReadonlyArray<string> = Object.freeze([
  'directive',
  'decision',
  'preference',
  'reference',
  'observation',
  'question',
  'actor-message',
  'actor-message-ack',
  'plan',
  'plan-merge-settled',
  'operator-intent',
  'pipeline',
  'pipeline-stage-event',
  'pipeline-resume',
  'pipeline-audit-finding',
  'pipeline-failed',
  'brainstorm-output',
  'spec-output',
  'review-report',
  'dispatch-record',
  'agent-session',
  'agent-turn',
]);
