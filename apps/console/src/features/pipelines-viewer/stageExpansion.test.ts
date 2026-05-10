import { describe, it, expect } from 'vitest';
import {
  stageExpansionStorageKey,
  normalizeStageExpanded,
} from './stageExpansion';

/*
 * Pure-helper coverage for the per-stage expansion-state shim. The
 * shim's storage-bound read/write are thin wrappers around
 * storage.service whose contract IS the key shape + the value
 * normalization; both are pure, both are exported for unit testing.
 *
 * E2E coverage (Playwright) exercises the round-trip across reload —
 * see tests/e2e/pipeline-stage-cards-inline.spec.ts.
 */

describe('stage-expansion storage key', () => {
  it('encodes pipeline + stage in a stable shape', () => {
    /*
     * The format is the load-bearing contract: a rename here silently
     * breaks restoration for every operator who had cards expanded
     * before the version bump. A deliberate rename has to update this
     * test.
     */
    expect(stageExpansionStorageKey('pipeline-x', 'brainstorm-stage')).toBe(
      'pipeline.stage-expanded.pipeline-x.brainstorm-stage',
    );
  });

  it('scopes per-pipeline + per-stage so two pipelines never collide', () => {
    const a = stageExpansionStorageKey('pipeline-a', 'spec-stage');
    const b = stageExpansionStorageKey('pipeline-b', 'spec-stage');
    const c = stageExpansionStorageKey('pipeline-a', 'plan-stage');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('normalizeStageExpanded', () => {
  it('preserves the true case', () => {
    expect(normalizeStageExpanded(true)).toBe(true);
  });

  it('default is collapsed (false) when no value persisted', () => {
    /*
     * Collapsed-by-default keeps the existing density of the page
     * intact for first-time visitors and for any post-clear-storage
     * state. Operator opts in by clicking Expand.
     */
    expect(normalizeStageExpanded(null)).toBe(false);
    expect(normalizeStageExpanded(undefined)).toBe(false);
  });

  it('falls back to false for non-boolean values (corrupted storage)', () => {
    /*
     * Defensive against version skew: a future build that wrote a
     * different shape, a manually edited localStorage entry, an
     * accidental JSON object. The fallback keeps the surface clean
     * rather than throwing on render.
     */
    expect(normalizeStageExpanded('true')).toBe(false);
    expect(normalizeStageExpanded(1)).toBe(false);
    expect(normalizeStageExpanded(0)).toBe(false);
    expect(normalizeStageExpanded({ expanded: true })).toBe(false);
    expect(normalizeStageExpanded([])).toBe(false);
    expect(normalizeStageExpanded(false)).toBe(false);
  });
});
