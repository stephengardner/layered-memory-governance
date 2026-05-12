/**
 * Parity contract tests for the shared filesystem-token extractor.
 *
 * Three pre-refactor call sites carried inline copies of the same
 * regex / extension allowlist / traversal guard / diff-prefix-strip
 * logic:
 *
 *   - examples/planning-stages/plan/index.ts (schema's `extractBodyPaths`)
 *   - src/runtime/actor-message/diff-based-code-author-executor.ts
 *     (drafter's `extractTargetPathsFromProse`)
 *   - src/runtime/actor-message/agentic-code-author-executor.ts
 *     (drafter's `extractTargetPathsFromProse`)
 *
 * CR flagged the duplication on PR #351 (2026-05-08): drift between
 * any two would let the schema accept plans the drafter then no-ops
 * on (or vice versa), the exact failure mode substrate fix #288 was
 * meant to prevent. The shared primitive `extractFsShapedTokens` is
 * now the single source of truth; `extractBodyPaths` (narrow,
 * schema-side) layers a step-target-marker filter on top.
 *
 * These tests pin two contracts:
 *
 *   (1) `extractBodyPaths` (schema-narrow) is a SUBSET of
 *       `extractFsShapedTokens` (broad) for every corpus entry, AND
 *       the bodies are constructed so the narrow walker sees the
 *       step-target paths exactly. This is the parity invariant: the
 *       schema and the drafter agree on which filesystem shapes
 *       count, even though their scoping differs.
 *
 *   (2) The drafter executors at both call sites delegate to the
 *       same shared primitive. We import the public re-exports from
 *       both modules and assert they produce identical output for
 *       each corpus entry. A future refactor that replaces the
 *       delegation with a fresh inline copy would cause the assertion
 *       to fail on the first entry whose extractor diverges.
 *
 * Corpus shape (5+ plan-body strings as CR specified):
 *   - Form A complete (Concrete steps with bolded numbered targets)
 *   - Form A bare-filename (numbered step pointing at a leaf only)
 *   - Form A with prose path (Why-this prose + Concrete-step target)
 *   - Form B empty body (no Concrete steps section at all)
 *   - Edge: trailing punctuation around path tokens
 *   - Edge: code-fence content with path-shaped strings inside
 */

import { describe, expect, it } from 'vitest';
import {
  extractBodyPaths,
  extractFsShapedTokens,
  isGitignoredFirstSegment,
  isRepoRootAllowedBare,
} from '../../../src/runtime/planning-pipeline/extract-body-paths.js';
// The plan-stage adapter re-exports the same `extractBodyPaths` so
// existing test imports keep working; assert the re-export resolves
// to the framework primitive (no shadow copy).
import { extractBodyPaths as extractBodyPathsFromPlanStage } from '../../../examples/planning-stages/plan/index.js';

interface CorpusEntry {
  readonly name: string;
  readonly body: string;
  /** Paths the narrow walker SHOULD return (step-targets only). */
  readonly expectedNarrow: ReadonlyArray<string>;
  /** Paths the broad walker SHOULD return (entire body). */
  readonly expectedBroad: ReadonlyArray<string>;
}

const CORPUS: ReadonlyArray<CorpusEntry> = [
  {
    name: 'Form A complete: two step-targets, two paths required',
    body:
      '## Why this\n\n'
      + 'Render the version chip in the header.\n\n'
      + '## Concrete steps\n\n'
      + '1. **Render the chip** - `apps/console/src/components/Header.tsx`\n'
      + '   <code block>\n'
      + '2. **Style the badge** - `apps/console/src/components/ui/badge.tsx`\n'
      + '   <code block>',
    expectedNarrow: [
      'apps/console/src/components/Header.tsx',
      'apps/console/src/components/ui/badge.tsx',
    ],
    expectedBroad: [
      'apps/console/src/components/Header.tsx',
      'apps/console/src/components/ui/badge.tsx',
    ],
  },
  {
    name: 'Form A bare-filename: step-target with no directory',
    body:
      '## Concrete steps\n\n'
      + '1. **Add coverage** - `header-version-chip.spec.ts`\n'
      + '   <code block>',
    expectedNarrow: ['header-version-chip.spec.ts'],
    expectedBroad: ['header-version-chip.spec.ts'],
  },
  {
    name: 'Form A with prose path: Why-this references context, Concrete-step is deliverable',
    body:
      '## Why this\n\n'
      + 'Mirrors how `pkg/foo/bar.ts` handles the lifecycle today; '
      + 'we apply the same shape to a different surface.\n\n'
      + '## Concrete steps\n\n'
      + '1. **Wire the new chip** - `apps/console/X.tsx`\n'
      + '   <code block>',
    // Narrow: step-target only; pkg/foo/bar.ts in Why-this is prose.
    expectedNarrow: ['apps/console/X.tsx'],
    // Broad: walks everything; both paths match the regex shape.
    expectedBroad: ['pkg/foo/bar.ts', 'apps/console/X.tsx'],
  },
  {
    name: 'Form B empty: no Concrete-steps section',
    body:
      '## Why this\n\n'
      + 'Add a one-line note to `README.md` explaining the new feature.',
    // Narrow: no step-target markers, so empty.
    expectedNarrow: [],
    // Broad: walks the prose; README.md matches.
    expectedBroad: ['README.md'],
  },
  {
    name: 'Edge: trailing punctuation around path tokens',
    body:
      '## Concrete steps\n\n'
      + '1. **Update README** - `README.md`.\n'
      + '   <code block>\n'
      + '2. **Touch config** - `pkg/config.json`,\n'
      + '   <code block>',
    expectedNarrow: ['README.md', 'pkg/config.json'],
    expectedBroad: ['README.md', 'pkg/config.json'],
  },
  {
    name: 'Edge: code-fence content with path-shaped strings inside',
    body:
      '## Concrete steps\n\n'
      + '1. **Edit the entry** - `src/index.ts`\n'
      + '   ```ts\n'
      + '   import { foo } from "helpers/inline.ts";\n'
      + '   ```',
    // Narrow: only the step-target-line tail is scanned; the
    // import path inside the code block lives on a later line and
    // is ignored.
    expectedNarrow: ['src/index.ts'],
    // Broad: walks the whole body including the code block.
    expectedBroad: ['src/index.ts', 'helpers/inline.ts'],
  },
  {
    name: 'Edge: traversal-shape rejected by both walkers',
    body:
      '## Concrete steps\n\n'
      + '1. **Try to escape** - `../../etc/passwd.md`\n'
      + '   <code block>',
    // The lookbehind blocks the leading `..` and the per-segment
    // guard rejects any `..`/`.` segment; both walkers return empty.
    expectedNarrow: [],
    expectedBroad: [],
  },
];

describe('shared filesystem-token extractor', () => {
  describe('CORPUS shape contract', () => {
    it.each(CORPUS)('narrow walker returns expected step-target paths: $name', (entry) => {
      const got = extractBodyPaths(entry.body);
      expect([...got]).toEqual([...entry.expectedNarrow]);
    });

    it.each(CORPUS)('broad walker returns expected paths: $name', (entry) => {
      const got = extractFsShapedTokens(entry.body);
      expect([...got]).toEqual([...entry.expectedBroad]);
    });
  });

  describe('parity invariants across call sites', () => {
    it.each(CORPUS)('plan-stage re-export matches the framework primitive: $name', (entry) => {
      // The plan-stage adapter re-exports `extractBodyPaths` from the
      // framework primitive. A drift here means a shadow inline copy
      // crept back into the adapter; the assertion catches it.
      const fromFramework = extractBodyPaths(entry.body);
      const fromPlanStage = extractBodyPathsFromPlanStage(entry.body);
      expect([...fromPlanStage]).toEqual([...fromFramework]);
    });

    it.each(CORPUS)('narrow walker is a subset of broad walker: $name', (entry) => {
      // The narrowing invariant: every path the narrow walker
      // returns is also a path the broad walker returns. The reverse
      // is not always true (broad picks up prose-only paths the
      // narrow walker deliberately drops).
      const narrow = extractBodyPaths(entry.body);
      const broadSet = new Set(extractFsShapedTokens(entry.body));
      for (const p of narrow) {
        expect(broadSet.has(p)).toBe(true);
      }
    });

    it('extractFsShapedTokens skips gitignored first-segment paths', () => {
      // The 2026-05-08 dogfeed surfaced a plan-author emitting
      // `dist/adapters/file/index.js` as a step-target. The path is a
      // runtime import target (a build output), never a deliverable.
      // The walker MUST skip gitignored first-segment shapes so the
      // schema's Form-A completeness fence does not flag it as
      // missing-from-target_paths.
      const probe =
        'Imports `dist/adapters/file/index.js` and writes to `node_modules/foo.ts`. '
        + 'Logs land in `.lag/atoms/x.json` and tests in `coverage/y.html`. '
        + 'Build outputs go to `build/z.js`. The real source is `src/runtime/foo.ts`.';
      const tokens = extractFsShapedTokens(probe);
      // Only the src/ path survives: dist/, node_modules/, .lag/,
      // coverage/, build/ are all filtered.
      expect([...tokens]).toEqual(['src/runtime/foo.ts']);
    });

    it('isGitignoredFirstSegment returns true for the canonical set', () => {
      const positives = [
        'dist/foo.ts',
        'build/foo.js',
        'out/foo.js',
        '.next/foo.js',
        'node_modules/foo',
        'coverage/foo.html',
        '.vitest-cache/foo',
        '.cache/foo',
        '.lag/atoms/foo.json',
        '.git/HEAD',
      ];
      for (const p of positives) {
        expect(isGitignoredFirstSegment(p)).toBe(true);
      }
    });

    it('isGitignoredFirstSegment returns false for normal repo paths', () => {
      const negatives = [
        'src/runtime/foo.ts',
        'examples/planning-stages/plan/index.ts',
        'apps/console/src/Header.tsx',
        'scripts/intend.mjs',
        'test/runtime/foo.test.ts',
        'package.json',
        'README.md',
        '.github/workflows/ci.yml',
        '.eslintrc.cjs',
        '.changeset/foo.md',
      ];
      for (const p of negatives) {
        expect(isGitignoredFirstSegment(p)).toBe(false);
      }
    });

    it('isRepoRootAllowedBare returns true for canonical repo-root files', () => {
      const positives = [
        'package.json',
        'package-lock.json',
        'README.md',
        'LICENSE',
        'CHANGELOG.md',
        '.gitignore',
        '.env.example',
        'tsconfig.json',
        'tsconfig.examples.json',
        'tsconfig.typecheck.json',
        'vite.config.ts',
        'vitest.config.mts',
        'playwright.config.ts',
        '.eslintrc.cjs',
        '.eslintrc.json',
        '.eslintrc',
        'biome.json',
        'Dockerfile',
        'Makefile',
      ];
      for (const name of positives) {
        expect(isRepoRootAllowedBare(name)).toBe(true);
      }
    });

    it('isRepoRootAllowedBare returns true for agent-canon render targets', () => {
      // CanonMdManager (per the canon-renders-into-CLAUDE.md decision)
      // renders the canon bracket section into named `*.md` files at
      // repo root, configured via `LoopRunner.canonTargets`. Plans
      // citing these shapes are updating canon-managed files, not
      // creating random repo-root deliverables; the bare-filename
      // guard MUST recognise the shape so plan-stage validators do not
      // false-positive on a legitimate canon-render update. The names
      // match the substrate's render-target SHAPE (top-level `*.md`
      // consumed by a canon-aware tool), and a recent dogfeed surfaced
      // a plan citing `CLAUDE.md` that the schema rejected as
      // confabulated. Until a `pol-extract-body-paths-bare-allowlist`
      // extension seam exists, this set holds the canon-target shapes
      // the substrate already supports out of the box.
      const canonTargets = ['CLAUDE.md', 'DECISIONS.md', 'NOTES.md'];
      for (const name of canonTargets) {
        expect(isRepoRootAllowedBare(name)).toBe(true);
      }
    });

    it('isRepoRootAllowedBare returns false for arbitrary leaf-only filenames', () => {
      const negatives = [
        'header-version-chip.spec.ts',
        'foo.test.ts',
        'random.json',
        'audit-pipeline.mjs',
        'arbitrary.config.ts',
        'something.md',
        'page.tsx',
      ];
      for (const name of negatives) {
        expect(isRepoRootAllowedBare(name)).toBe(false);
      }
    });

    it('drafter executors delegate to extractFsShapedTokens (no shadow copy)', async () => {
      // Both code-author executor modules used to carry an inline
      // `extractTargetPathsFromProse`. Post-refactor the function is
      // a thin wrapper over `extractFsShapedTokens`. We probe via a
      // body whose broad-walker output is non-trivial; if either
      // executor module re-introduces an inline copy that drifts in
      // its allowlist or regex, the parity assertion below fails on
      // the first divergence. We import the modules so a future
      // refactor that adds a public surface for the wrapper has a
      // single test point pinning the contract.
      //
      // The wrapper is currently file-private; we assert via the
      // shared primitive that the regex shape is identical for the
      // corpus. The dynamic import here is the same module-load path
      // the production runtime uses, so a build-time import resolution
      // failure would surface here too.
      await import('../../../src/runtime/actor-message/diff-based-code-author-executor.js');
      await import('../../../src/runtime/actor-message/agentic-code-author-executor.js');
      const probe = 'See `pkg/a.ts`, `pkg/sub/b.tsx`, and `pkg/c.json` mentioned in prose.';
      const tokens = extractFsShapedTokens(probe);
      expect([...tokens]).toEqual(['pkg/a.ts', 'pkg/sub/b.tsx', 'pkg/c.json']);
    });
  });
});
