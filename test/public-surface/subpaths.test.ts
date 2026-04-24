/**
 * Public-surface smoke tests for /actors and /actors/pr-landing subpaths.
 *
 * Why: package.json exports promises these subpaths to external consumers.
 * Each barrel documents a specific value + type surface. A silent
 * regression (barrel drift, renamed export, shim re-exporting the wrong
 * path) would break downstream imports at install time but pass every
 * other test in this repo, which exercises modules by their internal
 * paths. This smoke guards the public contract.
 *
 * Strategy:
 *   1. Import from the shim path (src/actors/...), which is what the
 *      `exports` map points at via dist/actors/..., and also from the
 *      real runtime path (src/runtime/actors/...). Assert the shim key
 *      set equals the real key set so shim drift fails the test.
 *   2. Pin the exact documented value surface of each barrel. Adding
 *      or removing an export requires updating this test on purpose;
 *      silent expansion of the public surface is rejected.
 *   3. For each documented value, assert `typeof === 'function'` so a
 *      class → named-export-of-undefined regression cannot pass.
 *
 * Type exports are intentionally not asserted here: they are erased at
 * runtime. They are covered at compile time by `tsc --noEmit`.
 */

import { describe, expect, it } from 'vitest';
import * as actorsShim from '../../src/actors/index.js';
import * as actorsReal from '../../src/runtime/actors/index.js';
import * as prLandingShim from '../../src/actors/pr-landing/index.js';
import * as prLandingReal from '../../src/runtime/actors/pr-landing/index.js';

describe('public surface: /actors subpath', () => {
  it('shim re-exports exactly the real actors barrel', () => {
    expect(Object.keys(actorsShim).sort()).toEqual(
      Object.keys(actorsReal).sort(),
    );
  });

  it('exports exactly the documented value surface', () => {
    expect(Object.keys(actorsShim).sort()).toEqual(['runActor']);
  });

  it('runActor is a callable function', () => {
    expect(typeof actorsShim.runActor).toBe('function');
  });
});

describe('public surface: /actors/pr-landing subpath', () => {
  it('shim re-exports exactly the real pr-landing barrel', () => {
    expect(Object.keys(prLandingShim).sort()).toEqual(
      Object.keys(prLandingReal).sort(),
    );
  });

  it('exports exactly the documented value surface', () => {
    expect(Object.keys(prLandingShim).sort()).toEqual([
      'PrLandingActor',
      'mkPrObservationAtom',
      'mkPrObservationAtomId',
      'mkPrObservationFailedAtom',
      'renderPrObservationBody',
    ]);
  });

  it('PrLandingActor is a constructable class', () => {
    expect(typeof prLandingShim.PrLandingActor).toBe('function');
    expect(prLandingShim.PrLandingActor.prototype).toBeDefined();
  });

  it('pr-observation helpers are callable functions', () => {
    expect(typeof prLandingShim.mkPrObservationAtom).toBe('function');
    expect(typeof prLandingShim.mkPrObservationAtomId).toBe('function');
    expect(typeof prLandingShim.mkPrObservationFailedAtom).toBe('function');
    expect(typeof prLandingShim.renderPrObservationBody).toBe('function');
  });
});
