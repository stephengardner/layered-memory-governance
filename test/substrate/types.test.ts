import { describe, expect, it } from 'vitest';
import type { AtomType } from '../../src/substrate/types.js';

/*
 * Task 1 scope is union-membership only. Shape-level coverage (zod
 * schemas, atom-builder helpers, structural rejection cases) lands in
 * Task 2 via test/runtime/planning-pipeline/atom-shapes.test.ts. The
 * test below confirms the typechecker accepts each new literal as a
 * valid AtomType; the runtime length assertion is a tripwire so a
 * future deletion from the array is loud rather than silent.
 */
describe('AtomType union (planning-pipeline extension)', () => {
  it('accepts the six new pipeline atom types', () => {
    const types: AtomType[] = [
      'spec',
      'pipeline',
      'pipeline-stage-event',
      'pipeline-audit-finding',
      'pipeline-failed',
      'pipeline-resume',
    ];
    expect(types.length).toBe(6);
  });
});
