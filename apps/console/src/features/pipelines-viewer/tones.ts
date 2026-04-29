/*
 * Single source of truth for pipeline_state -> CSS tone mapping.
 *
 * Mirrors `features/plan-state/tones.ts` shape: a const map per
 * canonical state, a fallback tone when the substrate adds a state
 * the console hasn't mirrored yet, and a `planStateTone`-style
 * resolver that accepts free-form input.
 *
 * Token discipline: every tone resolves to a semantic token defined
 * in `src/tokens/tokens.css`. No hex, no hardcoded color.
 *
 * The five canonical pipeline states (per the substrate
 * `PIPELINE_STATE_VALUES` in `src/runtime/planning-pipeline/atom-shapes.ts`):
 *   pending      -> awaiting first stage
 *   running      -> a stage is in flight
 *   hil-paused   -> a stage hit a HIL gate
 *   completed    -> terminal success
 *   failed       -> terminal failure
 *
 * Plus stage-state tones (per-stage rollup state from
 * `pipelines-types.ts.PipelineStageState`):
 *   pending | running | paused | succeeded | failed
 *
 * Each pipeline + stage state must be visually distinguishable from
 * its neighbors so an operator can read the timeline at a glance.
 * Pause maps to the warning token on both surfaces because the HIL
 * pause is the only state that draws operator attention without
 * being terminal.
 */

export type PipelineStateName =
  | 'pending'
  | 'running'
  | 'hil-paused'
  | 'completed'
  | 'failed';

export const PIPELINE_STATE_TONE: Readonly<Record<PipelineStateName, string>> = Object.freeze({
  pending: 'var(--text-tertiary)',
  running: 'var(--status-info)',
  'hil-paused': 'var(--status-warning)',
  completed: 'var(--status-success)',
  failed: 'var(--status-danger)',
});

export function pipelineStateTone(state: string | null | undefined): string {
  if (typeof state !== 'string' || state.length === 0) {
    return 'var(--text-secondary)';
  }
  return (PIPELINE_STATE_TONE as Record<string, string>)[state] ?? 'var(--text-secondary)';
}

export type StageStateName =
  | 'pending'
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'failed';

export const STAGE_STATE_TONE: Readonly<Record<StageStateName, string>> = Object.freeze({
  pending: 'var(--text-tertiary)',
  running: 'var(--status-info)',
  paused: 'var(--status-warning)',
  succeeded: 'var(--status-success)',
  failed: 'var(--status-danger)',
});

export function stageStateTone(state: string | null | undefined): string {
  if (typeof state !== 'string' || state.length === 0) {
    return 'var(--text-secondary)';
  }
  return (STAGE_STATE_TONE as Record<string, string>)[state] ?? 'var(--text-secondary)';
}

/*
 * Severity tone map for audit findings. Mirrors the substrate
 * severity vocabulary verbatim. Major maps to warning (not danger)
 * so the page does not read as a sea of red when most findings are
 * non-critical.
 */
export const FINDING_SEVERITY_TONE: Readonly<Record<'critical' | 'major' | 'minor', string>>
  = Object.freeze({
    critical: 'var(--status-danger)',
    major: 'var(--status-warning)',
    minor: 'var(--text-tertiary)',
  });

export function findingSeverityTone(
  severity: string | null | undefined,
): string {
  if (severity === 'critical' || severity === 'major' || severity === 'minor') {
    return FINDING_SEVERITY_TONE[severity];
  }
  return 'var(--text-secondary)';
}
