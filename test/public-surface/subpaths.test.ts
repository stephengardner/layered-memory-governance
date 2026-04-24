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
 * Shape (table-driven on purpose):
 *   Each row is one subpath barrel. The three invariants per row are
 *   identical, so adding the remaining subpaths (`/adapters/*`,
 *   `/actors/{code-author,pr-review,planning,provisioning}`,
 *   `/actor-message*`, `/external/github*`, `/lifecycle`) in a follow-up
 *   PR is a one-line row addition, not another copy of a describe block.
 *   Keeping the scaffold in place from row 1 means the follow-up lands
 *   as pure data, not refactor.
 *
 * Invariants per subpath:
 *   1. Shim equivalence: the compat shim at `src/<subpath>` (what the
 *      package.json `exports` map resolves to via `dist/<subpath>`) must
 *      export the same key set as the real runtime barrel at
 *      `src/runtime/<subpath>`. Catches a mis-targeted re-export path
 *      that TypeScript would not flag at runtime.
 *   2. Surface pin: `Object.keys` equals the documented allowlist.
 *      Adding or removing an export requires updating this test on
 *      purpose; silent expansion of the public surface is rejected.
 *   3. Callability: every documented value is `typeof === 'function'`
 *      (classes and functions both). Optional `classes` list also
 *      asserts `.prototype` is defined, so a class-became-undefined
 *      regression cannot pass.
 *
 * Type exports are intentionally not asserted here: types erase at
 * runtime. They are covered at compile time by `tsc --noEmit`.
 */

import { describe, expect, it } from 'vitest';
import * as actorsShim from '../../src/actors/index.js';
import * as actorsReal from '../../src/runtime/actors/index.js';
import * as prLandingShim from '../../src/actors/pr-landing/index.js';
import * as prLandingReal from '../../src/runtime/actors/pr-landing/index.js';

interface SubpathCase {
  readonly subpath: string;
  readonly shim: Record<string, unknown>;
  readonly real: Record<string, unknown>;
  readonly expected: readonly string[];
  readonly classes?: readonly string[];
}

const cases: readonly SubpathCase[] = [
  {
    subpath: '/actors',
    shim: actorsShim,
    real: actorsReal,
    expected: ['runActor'],
  },
  {
    subpath: '/actors/pr-landing',
    shim: prLandingShim,
    real: prLandingReal,
    expected: [
      'PrLandingActor',
      'mkPrObservationAtom',
      'mkPrObservationAtomId',
      'mkPrObservationFailedAtom',
      'renderPrObservationBody',
    ],
    classes: ['PrLandingActor'],
  },
];

describe.each(cases)('public surface: $subpath subpath', ({ shim, real, expected, classes }) => {
  it('shim re-exports exactly the real barrel', () => {
    expect(Object.keys(shim).sort()).toEqual(Object.keys(real).sort());
  });

  it('exports exactly the documented value surface', () => {
    expect(Object.keys(shim).sort()).toEqual([...expected].sort());
  });

  it('every documented value is a callable function', () => {
    for (const name of expected) {
      expect(typeof shim[name], `${name} typeof`).toBe('function');
    }
  });

  if (classes && classes.length > 0) {
    it('every documented class has a prototype', () => {
      for (const name of classes) {
        const cls = shim[name] as { prototype?: unknown } | undefined;
        expect(cls, `${name} is defined`).toBeDefined();
        expect(cls?.prototype, `${name}.prototype`).toBeDefined();
      }
    });
  }
});
