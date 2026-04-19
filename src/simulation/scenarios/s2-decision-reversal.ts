/**
 * Scenario 2: decision reversal via AUTOMATIC arbitration.
 *
 * Mirrors the scenario-1 reversal pattern but WITHOUT scripted supersession.
 * The conflict is detected by the arbitration system and resolved via the
 * source-rank rule (user-directive > agent-observed at the same layer).
 *
 * Ticks:
 *   1. Agent observes (L1, agent-observed, conf=0.5): "we use Redux for state".
 *   2. User directive (L1, user-directive, conf=0.9): "we moved to Zustand, retire Redux".
 *      Arbitration runs against tick-1. Source-rank resolves: tick 2 wins.
 *
 * Checkpoints at tick 2:
 *   C1: "state management library" -> top hit should be tick-2 (non-superseded).
 *
 * Supersession:
 *   S1: tick-1 should be marked superseded_by tick-2 via arbitration.
 *
 * Test setup must pre-register the LLM detector response (semantic conflict).
 */

import type { Scenario } from '../types.js';

export const scenarioS2: Scenario = {
  name: 's2-decision-reversal',
  description:
    'Two conflicting atoms (agent-observation vs user-directive) without ' +
    'scripted supersession. Arbitration detects semantic conflict, source-rank ' +
    'decides user-directive wins, loser is auto-marked superseded.',
  events: [
    {
      tick: 1,
      label: 'obs-redux',
      worldUpdate: {
        factId: 'state-lib',
        factValue: 'redux',
      },
      agentWrite: {
        content:
          'We use Redux for state management across the the example portal. ' +
          'The pattern has been in place for multiple sprints.',
        type: 'observation',
        confidence: 0.5,
        supersedesIds: [],
      },
      arbitration: null,
    },
    {
      tick: 2,
      label: 'dir-zustand',
      worldUpdate: {
        factId: 'state-lib',
        factValue: 'zustand',
      },
      agentWrite: {
        content:
          'User directive: we migrated to Zustand for state management. ' +
          'Retire Redux; it is no longer the canonical choice.',
        type: 'directive',
        confidence: 0.9,
        supersedesIds: [],
      },
      arbitration: {
        againstLabel: 'obs-redux',
      },
    },
  ],
  checkpoints: [
    {
      atTick: 2,
      query: 'state management library directive',
      expectedTopHitLabel: 'dir-zustand',
      expectedWorldFact: {
        id: 'state-lib',
        value: 'zustand',
      },
    },
  ],
  supersessionChecks: [
    {
      atTick: 2,
      label: 'obs-redux',
      shouldBeSupersededBy: 'dir-zustand',
    },
  ],
};
