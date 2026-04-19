/**
 * Scenario 3: end-to-end promotion through the driver.
 *
 * Three distinct agent principals each observe the same fact at L1 with
 * conf=0.8. At tick 4 the driver runs a promotion pass targeting L2. With
 * DEFAULT_THRESHOLDS (L2 = {minConfidence: 0.7, minConsensus: 2, requireValidation: false}),
 * the promotion should succeed: a new atom lands at L2, the representative
 * L1 atom is superseded, audit records a 'promotion.applied' entry.
 *
 * Contrast with scenarios 1 (scripted supersession) and 2 (auto-arbitration
 * supersession). Scenario 3 exercises consensus-driven promotion.
 */

import type { Scenario } from '../types.js';

export const scenarioS3: Scenario = {
  name: 's3-promotion',
  description:
    'Three distinct agents each observe "we use Postgres" at L1. A promotion ' +
    'pass at tick 4 elevates the consensus to L2 with canon-promoted provenance.',
  events: [
    {
      tick: 1,
      label: 'obs-alice',
      worldUpdate: {
        factId: 'canonical-db',
        factValue: 'postgres',
      },
      agentWrite: {
        content: 'We use Postgres as the canonical production database.',
        type: 'observation',
        confidence: 0.8,
        supersedesIds: [],
        principalId: 'alice',
      },
    },
    {
      tick: 2,
      label: 'obs-bob',
      worldUpdate: null,
      agentWrite: {
        content: 'we use postgres as the canonical production database',
        type: 'observation',
        confidence: 0.8,
        supersedesIds: [],
        principalId: 'bob',
      },
    },
    {
      tick: 3,
      label: 'obs-carol',
      worldUpdate: null,
      agentWrite: {
        content: 'WE USE POSTGRES AS THE CANONICAL PRODUCTION DATABASE!',
        type: 'observation',
        confidence: 0.8,
        supersedesIds: [],
        principalId: 'carol',
      },
    },
    {
      tick: 4,
      label: 'promotion-pass',
      worldUpdate: null,
      agentWrite: null,
      promotion: {
        targetLayer: 'L2',
      },
    },
  ],
  checkpoints: [
    {
      atTick: 4,
      query: 'canonical production database postgres',
      // After promotion, the new L2 atom should outrank any remaining L1
      // siblings. Either the L2 atom OR one of the unsuperseded L1 siblings
      // could be the top hit; we accept either via a label check below
      // in the test. For the scenario-driver checkpoint, we expect a
      // matching atom to exist; label matching is done in the specific test.
      expectedTopHitLabel: 'obs-alice',
      expectedWorldFact: { id: 'canonical-db', value: 'postgres' },
    },
  ],
  supersessionChecks: [],
};
