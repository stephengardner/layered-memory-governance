import { describe, it, expect } from 'vitest';
import { prettyState, stateTone } from './IntentOutcomeCard';
import type { IntentOutcomeState } from '@/services/pipelines.service';

/*
 * Unit tests for the pure helpers exported from IntentOutcomeCard.
 *
 * The vitest suite runs under `environment: 'node'` (vitest.config.ts);
 * adding jsdom + a DOM testing harness purely to exercise this card's
 * branches would inflate CI install-time without buying coverage the
 * server-side synthesizer test + the (forthcoming) Playwright e2e
 * spec do not already capture.
 *
 * The Playwright spec under tests/e2e/ covers the full live-DOM path
 * (loading state, error state, fulfilled-state render, polling
 * cadence). These unit tests pin the pure resolvers (state -> tone
 * token, state -> human label) so a typo in the kebab-case prefix
 * does not silently mismap an outcome to the wrong color or label.
 */

const ALL_STATES: ReadonlyArray<IntentOutcomeState> = [
  'intent-fulfilled',
  'intent-dispatched-pending-review',
  'intent-dispatched-observation-stale',
  'intent-dispatch-failed',
  'intent-paused',
  'intent-running',
  'intent-abandoned',
  'intent-unknown',
];

describe('prettyState', () => {
  it('returns a non-empty human-friendly label for every canonical state', () => {
    for (const state of ALL_STATES) {
      const label = prettyState(state);
      expect(label.length).toBeGreaterThan(0);
      // Operator-facing label should NOT contain the kebab-case prefix.
      expect(label).not.toContain('intent-');
    }
  });

  it('maps fulfilled to "Fulfilled"', () => {
    expect(prettyState('intent-fulfilled')).toBe('Fulfilled');
  });

  it('maps dispatched-pending-review to a sentence-cased phrase', () => {
    expect(prettyState('intent-dispatched-pending-review')).toMatch(/^Dispatched/);
    expect(prettyState('intent-dispatched-pending-review')).toMatch(/pending review/);
  });

  it('maps dispatch-failed to "Dispatch failed"', () => {
    expect(prettyState('intent-dispatch-failed')).toBe('Dispatch failed');
  });

  it('maps dispatched-observation-stale to a stale-flavored phrase', () => {
    // Substrate gap (2026-05-11): a stale pr-observation atom should
    // surface to the operator as a stale-flavored label so the
    // headline matches the row's actual ambiguity (could be fulfilled,
    // could still be open -- the observation just hasn't refreshed).
    const label = prettyState('intent-dispatched-observation-stale');
    expect(label).toMatch(/stale/i);
    expect(label).not.toContain('intent-');
  });

  it('maps unknown / future state values to "Unknown"', () => {
    /*
     * The function is exhaustive over the IntentOutcomeState union but
     * keep a fallback path so a future server-side state addition
     * doesn't crash the card on a freshly-deployed backend before the
     * client has been updated.
     */
    expect(prettyState('intent-unknown')).toBe('Unknown');
    expect(prettyState('not-a-real-state' as IntentOutcomeState)).toBe('Unknown');
  });
});

describe('stateTone', () => {
  it('returns a non-empty tone token for every canonical state', () => {
    for (const state of ALL_STATES) {
      const tone = stateTone(state);
      expect(tone.length).toBeGreaterThan(0);
    }
  });

  it('maps fulfilled to success (green-coded)', () => {
    expect(stateTone('intent-fulfilled')).toBe('success');
  });

  it('maps dispatch-failed to danger (red-coded)', () => {
    expect(stateTone('intent-dispatch-failed')).toBe('danger');
  });

  it('maps paused to warning (HIL-pause is not terminal failure)', () => {
    expect(stateTone('intent-paused')).toBe('warning');
  });

  it('maps running + dispatched-pending-review to info (mid-flight)', () => {
    expect(stateTone('intent-running')).toBe('info');
    expect(stateTone('intent-dispatched-pending-review')).toBe('info');
  });

  it('maps dispatched-observation-stale to warning (operator notices, not panics)', () => {
    // The stale-observation row is a warning, not a danger: the
    // underlying state may still resolve to merged once the refresh
    // tick lands a fresh atom (or the backfill heal script runs).
    expect(stateTone('intent-dispatched-observation-stale')).toBe('warning');
  });

  it('maps abandoned to muted (terminal but not red)', () => {
    /*
     * Abandoned is a no-op ending: the operator's authorization
     * expired or was withdrawn. Coloring it red would conflate it
     * with dispatch-failed, which is a substrate-side failure mode
     * the operator should debug. Muted keeps the tone deliberately
     * understated.
     */
    expect(stateTone('intent-abandoned')).toBe('muted');
  });

  it('falls back to muted for an unknown state', () => {
    expect(stateTone('not-a-state' as IntentOutcomeState)).toBe('muted');
  });
});
