import { describe, it, expect } from 'vitest';
import {
  ATOM_TYPE_KINDS,
  ATOM_TYPE_TONE,
  ATOM_TYPE_TONE_FALLBACK,
  atomTypeTone,
} from './tones';

/*
 * Coverage for the shared atom-type tone map consumed by both the
 * activities feed and the graph viewer. The load-bearing assertion
 * is that every type carrying a labeled verb in the actor-activity
 * server projection (VERB_BY_TYPE) also has a non-default tone here
 * -- otherwise that type renders as muted-gray and disappears in the
 * legend. The list below mirrors VERB_BY_TYPE; if a new entry lands
 * there without one here, this test fails before the regression ever
 * reaches a reviewer.
 */

const ALL_TYPED_KINDS = [
  // Canon writes
  'directive',
  'decision',
  'preference',
  'reference',
  'observation',
  'question',
  // Operator + plan family
  'operator-intent',
  'plan',
  'plan-merge-settled',
  'actor-message',
  'actor-message-ack',
  // Lifecycle / observability family (deep planning pipeline + agents)
  'pipeline',
  'pipeline-stage-event',
  'pipeline-resume',
  'brainstorm-output',
  'spec-output',
  'dispatch-record',
  'agent-session',
  'agent-turn',
  // Review + findings
  'pipeline-audit-finding',
  'review-report',
  'pipeline-failed',
] as const;

describe('ATOM_TYPE_TONE coverage', () => {
  it('covers every labeled atom type with a semantic-token tone', () => {
    for (const kind of ALL_TYPED_KINDS) {
      expect(ATOM_TYPE_TONE[kind], `missing tone for ${kind}`).toBeDefined();
      // Token discipline: every value must be a var(--*) reference.
      expect(ATOM_TYPE_TONE[kind]).toMatch(/^var\(--[a-z0-9-]+\)$/);
    }
  });

  it('keeps coherent family colors so the legend reads sensibly', () => {
    // Operator + plan family share the accent-active token.
    expect(ATOM_TYPE_TONE['operator-intent']).toBe('var(--accent-active)');
    expect(ATOM_TYPE_TONE.plan).toBe('var(--accent-active)');
    expect(ATOM_TYPE_TONE['plan-merge-settled']).toBe('var(--accent-active)');

    // actor-message + ack share the accent-hover token.
    expect(ATOM_TYPE_TONE['actor-message']).toBe('var(--accent-hover)');
    expect(ATOM_TYPE_TONE['actor-message-ack']).toBe('var(--accent-hover)');

    // Lifecycle / observability family shares status-info (matches
    // pipelineStateTone running -> --status-info).
    for (const k of [
      'pipeline',
      'pipeline-stage-event',
      'pipeline-resume',
      'brainstorm-output',
      'spec-output',
      'dispatch-record',
      'agent-session',
      'agent-turn',
    ]) {
      expect(ATOM_TYPE_TONE[k], `${k} should be info`).toBe('var(--status-info)');
    }

    // Review + findings: warning for non-terminal findings/reports,
    // danger for the terminal pipeline-failed state.
    expect(ATOM_TYPE_TONE['pipeline-audit-finding']).toBe('var(--status-warning)');
    expect(ATOM_TYPE_TONE['review-report']).toBe('var(--status-warning)');
    expect(ATOM_TYPE_TONE['pipeline-failed']).toBe('var(--status-danger)');
  });
});

describe('atomTypeTone resolver', () => {
  it('resolves known types to their semantic tone', () => {
    expect(atomTypeTone('directive')).toBe('var(--status-danger)');
    expect(atomTypeTone('decision')).toBe('var(--accent)');
    expect(atomTypeTone('pipeline')).toBe('var(--status-info)');
    expect(atomTypeTone('agent-turn')).toBe('var(--status-info)');
  });

  it('falls back to muted gray for unknown / null / empty inputs', () => {
    expect(atomTypeTone('totally-new-type')).toBe(ATOM_TYPE_TONE_FALLBACK);
    expect(atomTypeTone(null)).toBe(ATOM_TYPE_TONE_FALLBACK);
    expect(atomTypeTone(undefined)).toBe(ATOM_TYPE_TONE_FALLBACK);
    expect(atomTypeTone('')).toBe(ATOM_TYPE_TONE_FALLBACK);
  });

  it('fallback is itself a semantic-token reference', () => {
    expect(ATOM_TYPE_TONE_FALLBACK).toMatch(/^var\(--[a-z0-9-]+\)$/);
  });
});

describe('ATOM_TYPE_KINDS filter list', () => {
  it('lists every type that has a tone', () => {
    const toneKeys = new Set(Object.keys(ATOM_TYPE_TONE));
    const kindKeys = new Set(ATOM_TYPE_KINDS);
    // Symmetric coverage: every tone has a chip and every chip has a tone.
    for (const k of toneKeys) {
      expect(kindKeys.has(k), `${k} has tone but no chip`).toBe(true);
    }
    for (const k of kindKeys) {
      expect(toneKeys.has(k), `${k} has chip but no tone`).toBe(true);
    }
  });

  it('includes the new pipeline + agent kinds added 2026-04-30', () => {
    // Regression guard: 13 new types added when the pipeline + agent
    // substrate landed; the audit on 2026-04-30 found these missing
    // from both ActivitiesView and GraphView. Keep them filterable.
    const required = [
      'operator-intent',
      'actor-message-ack',
      'plan-merge-settled',
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
    ];
    for (const k of required) {
      expect(ATOM_TYPE_KINDS).toContain(k);
    }
  });
});
