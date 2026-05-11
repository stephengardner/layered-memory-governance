/**
 * Pure helpers extracted from PipelineErrorBlock.tsx for vitest
 * coverage. The component itself is tested at the DOM level via the
 * Playwright e2e spec (`tests/e2e/pipeline-error-state.spec.ts`);
 * these helpers are the small piece of logic that lives independent
 * of the DOM and where a regression would silently mis-render the
 * block tone or storage key.
 *
 * Co-located with the component file for discoverability per the
 * apps/console folder-grouping rule (`src/features/<feature>/`).
 */

import type {
  PipelineErrorCategory,
  PipelineErrorSeverity,
} from '@/services/pipelines.service';

/**
 * Map a severity bucket to the semantic-token name the block uses for
 * the border / background tone. Keeping the mapping here means a
 * future deployment that swaps the token set only edits this file +
 * the CSS module; the component stays unchanged.
 */
export function severityToToneToken(severity: PipelineErrorSeverity): string {
  switch (severity) {
    case 'critical': return 'var(--status-danger)';
    case 'warning': return 'var(--status-warning)';
    case 'info': return 'var(--status-info)';
  }
}

/**
 * Storage key for the block's expanded/collapsed preference. Scoped
 * per pipeline so a closed pipeline does not affect a newly-opened
 * one. The exact format is the load-bearing piece a reload depends
 * on; renaming silently breaks restoration for every operator who
 * had collapsed blocks before the version bump.
 */
export function errorBlockExpansionStorageKey(pipelineId: string): string {
  return `pipeline.error-block-expanded.${pipelineId}`;
}

/**
 * Default-expanded normalizer. An undefined key means the operator
 * has never collapsed for this pipeline; default to open so the
 * error block is impossible to miss on first encounter. Strict
 * `!== false` means a corrupted entry (string 'false', 0/1, JSON
 * object) reads as expanded -- the default-loud posture is the
 * safer fallback for a surface whose entire purpose is to flag a
 * pipeline that the operator should act on.
 */
export function normalizeErrorBlockExpanded(value: unknown): boolean {
  return value !== false;
}

/**
 * Categories whose render uses the danger-warning iconography (vs
 * the generic AlertTriangle). The block's icon resolver branches on
 * this set; centralizing the membership here lets a future category
 * land alongside its icon choice in one place.
 */
const SHIELD_CATEGORIES: ReadonlySet<PipelineErrorCategory> = new Set([
  'critical-audit-finding',
  'plan-author-confabulation',
]);

const FILE_WARN_CATEGORIES: ReadonlySet<PipelineErrorCategory> = new Set([
  'schema-mismatch',
  'stage-output-persist-failed',
]);

export function categoryIconKind(
  category: PipelineErrorCategory | null,
):
  | 'stop-circle'
  | 'skull'
  | 'shield-alert'
  | 'file-warning'
  | 'alert-triangle' {
  if (category === 'kill-switch-halted') return 'stop-circle';
  if (category === 'operator-abandoned') return 'skull';
  if (category && SHIELD_CATEGORIES.has(category)) return 'shield-alert';
  if (category && FILE_WARN_CATEGORIES.has(category)) return 'file-warning';
  return 'alert-triangle';
}
