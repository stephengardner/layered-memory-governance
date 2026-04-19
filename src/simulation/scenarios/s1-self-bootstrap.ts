/**
 * Scenario 1: self-bootstrap.
 *
 * Scripts the canonical "user said X, pushed back, framework decided Y"
 * reversal pattern, modeled on the actual Stop-hook-error discussion from
 * the LAG design conversation.
 *
 * Ticks:
 *   1. Agent observes: Stop hook "error" display is the intended save trigger.
 *      World: stop-hook-display = "intentional-save-trigger"
 *   2. Agent observes: PreCompact hook decision:block is terminal (unrelated
 *      context, used to test retrieval does not false-match).
 *   3. User directive: "Stop hook error" display is a literal problem.
 *      World: stop-hook-display = "user-rejects-error-display"
 *   4. Agent decides: hook_stop returns {} pass-through; saves happen via
 *      background palace mine. SUPERSEDES tick-1 atom.
 *      World: stop-hook-display = "pass-through-no-error-display"
 *
 * Checkpoints at tick 4:
 *   C1: "what does hook_stop do now" -> top hit should be tick-4 (decision).
 *   C2: "what is the user's position on the Stop hook error display"
 *       -> top hit should be tick-3 (directive).
 *
 * Supersession:
 *   S1: tick-1 atom should be marked superseded_by tick-4 atom.
 *
 * If any of these fail, the memory adapter + scenario-driver pipeline has a
 * bug. This is the canonical V0 acceptance test.
 */

import type { Scenario } from '../types.js';

export const scenarioS1: Scenario = {
  name: 's1-self-bootstrap',
  description:
    'Stop-hook error display: agent initially records it as intended, user ' +
    'rejects, decision reverses with supersession. Tests the core ' +
    'observation -> directive -> decision-with-supersession flow.',
  events: [
    {
      tick: 1,
      label: 'obs-display-is-intended',
      worldUpdate: {
        factId: 'stop-hook-display',
        factValue: 'intentional-save-trigger',
      },
      arbitration: null,
      agentWrite: {
        content:
          'The Claude Code Stop hook displays "Stop hook error" which is the intended ' +
          'save-trigger mechanism; Claude is re-prompted with the save instruction.',
        type: 'observation',
        supersedesIds: [],
      },
    },
    {
      tick: 2,
      label: 'obs-precompact-terminal',
      worldUpdate: null,
      arbitration: null,
      agentWrite: {
        content:
          'PreCompact hook decision:"block" is terminal in Claude Code, unlike ' +
          'Stop hooks: it errors /compact outright rather than re-prompting.',
        type: 'observation',
        supersedesIds: [],
      },
    },
    {
      tick: 3,
      label: 'user-directive-no-error',
      worldUpdate: {
        factId: 'stop-hook-display',
        factValue: 'user-rejects-error-display',
      },
      arbitration: null,
      agentWrite: {
        content:
          'User directive: the "Stop hook error" display is a literal problem ' +
          'and must be removed while preserving automatic saves.',
        type: 'directive',
        supersedesIds: [],
      },
    },
    {
      tick: 4,
      label: 'decision-pass-through',
      worldUpdate: {
        factId: 'stop-hook-display',
        factValue: 'pass-through-no-error-display',
      },
      arbitration: null,
      agentWrite: {
        content:
          'hook_stop now returns {} pass-through; no more "Stop hook error" display. ' +
          'Saves happen via background palace mine on the transcript parent directory.',
        type: 'decision',
        confidence: 0.9,
        supersedesIds: ['obs-display-is-intended'],
      },
    },
  ],
  checkpoints: [
    {
      atTick: 4,
      query: 'what does hook_stop do now',
      expectedTopHitLabel: 'decision-pass-through',
      expectedWorldFact: {
        id: 'stop-hook-display',
        value: 'pass-through-no-error-display',
      },
    },
    {
      atTick: 4,
      // "directive" is the lexically-distinguishing term; the decision atom
      // does not use that word. Tests that type-specific retrieval works.
      query: 'user directive about Stop hook',
      expectedTopHitLabel: 'user-directive-no-error',
    },
  ],
  supersessionChecks: [
    {
      atTick: 4,
      label: 'obs-display-is-intended',
      shouldBeSupersededBy: 'decision-pass-through',
    },
  ],
};
