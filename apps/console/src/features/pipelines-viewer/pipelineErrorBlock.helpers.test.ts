import { describe, it, expect } from 'vitest';
import {
  categoryIconKind,
  errorBlockExpansionStorageKey,
  normalizeErrorBlockExpanded,
  severityToToneToken,
} from './pipelineErrorBlock.helpers';
import type {
  PipelineErrorCategory,
  PipelineErrorSeverity,
} from '@/services/pipelines.service';

/*
 * Unit tests for the PipelineErrorBlock pure helpers.
 *
 * The component itself runs through the Playwright e2e spec; these
 * tests cover the pure-logic seams that survive a DOM rewrite:
 *   - severity -> token mapping (a misspelled token name renders
 *     transparent and silently breaks the surface tone)
 *   - storage key format (renaming silently drops every operator's
 *     persisted preference)
 *   - default-expanded normalization (a corrupted storage value must
 *     read as expanded so the loud surface never goes silent)
 *   - category -> icon kind (a missing branch falls back to the
 *     generic AlertTriangle, never crashes the surface)
 */

const ALL_SEVERITIES: ReadonlyArray<PipelineErrorSeverity> = [
  'critical',
  'warning',
  'info',
];

const ALL_CATEGORIES: ReadonlyArray<PipelineErrorCategory> = [
  'budget-exceeded',
  'pipeline-cost-overflow',
  'schema-mismatch',
  'critical-audit-finding',
  'plan-author-confabulation',
  'unknown-stage',
  'kill-switch-halted',
  'operator-abandoned',
  'stage-output-persist-failed',
  'stage-threw',
  'uncategorized',
];

describe('severityToToneToken', () => {
  it('returns a non-empty CSS variable for every severity', () => {
    for (const severity of ALL_SEVERITIES) {
      const tone = severityToToneToken(severity);
      expect(tone.length).toBeGreaterThan(0);
      expect(tone).toMatch(/^var\(/);
    }
  });

  it('maps critical to the danger token', () => {
    expect(severityToToneToken('critical')).toBe('var(--status-danger)');
  });

  it('maps warning to the warning token', () => {
    expect(severityToToneToken('warning')).toBe('var(--status-warning)');
  });

  it('maps info to the info token', () => {
    expect(severityToToneToken('info')).toBe('var(--status-info)');
  });
});

describe('errorBlockExpansionStorageKey', () => {
  it('returns a key that includes the pipeline id', () => {
    const key = errorBlockExpansionStorageKey('pipeline-1');
    expect(key).toContain('pipeline-1');
  });

  it('uses the load-bearing pipeline.error-block-expanded prefix', () => {
    expect(errorBlockExpansionStorageKey('p')).toBe('pipeline.error-block-expanded.p');
  });

  it('scopes the key per pipeline so two ids do not collide', () => {
    const a = errorBlockExpansionStorageKey('a');
    const b = errorBlockExpansionStorageKey('b');
    expect(a).not.toBe(b);
  });
});

describe('normalizeErrorBlockExpanded', () => {
  it('returns true for an undefined value (never-collapsed default)', () => {
    expect(normalizeErrorBlockExpanded(undefined)).toBe(true);
  });

  it('returns false ONLY for the literal false', () => {
    expect(normalizeErrorBlockExpanded(false)).toBe(false);
  });

  it('returns true for true', () => {
    expect(normalizeErrorBlockExpanded(true)).toBe(true);
  });

  it('returns true for a corrupted string', () => {
    expect(normalizeErrorBlockExpanded('false')).toBe(true);
  });

  it('returns true for null', () => {
    expect(normalizeErrorBlockExpanded(null)).toBe(true);
  });

  it('returns true for a JSON object', () => {
    expect(normalizeErrorBlockExpanded({ collapsed: true })).toBe(true);
  });
});

describe('categoryIconKind', () => {
  it('maps every canonical category to a non-empty kind', () => {
    for (const category of ALL_CATEGORIES) {
      const kind = categoryIconKind(category);
      expect(kind.length).toBeGreaterThan(0);
    }
  });

  it('maps kill-switch-halted to stop-circle', () => {
    expect(categoryIconKind('kill-switch-halted')).toBe('stop-circle');
  });

  it('maps operator-abandoned to skull', () => {
    expect(categoryIconKind('operator-abandoned')).toBe('skull');
  });

  it('maps critical-audit-finding to shield-alert', () => {
    expect(categoryIconKind('critical-audit-finding')).toBe('shield-alert');
  });

  it('maps plan-author-confabulation to shield-alert', () => {
    expect(categoryIconKind('plan-author-confabulation')).toBe('shield-alert');
  });

  it('maps schema-mismatch to file-warning', () => {
    expect(categoryIconKind('schema-mismatch')).toBe('file-warning');
  });

  it('maps stage-output-persist-failed to file-warning', () => {
    expect(categoryIconKind('stage-output-persist-failed')).toBe('file-warning');
  });

  it('maps budget-exceeded to alert-triangle (generic)', () => {
    expect(categoryIconKind('budget-exceeded')).toBe('alert-triangle');
  });

  it('maps a null category to alert-triangle', () => {
    expect(categoryIconKind(null)).toBe('alert-triangle');
  });

  it('maps unknown future categories to alert-triangle', () => {
    expect(categoryIconKind('not-a-real-category' as PipelineErrorCategory)).toBe('alert-triangle');
  });
});
