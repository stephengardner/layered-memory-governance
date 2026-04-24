/**
 * Public-surface smoke tests for `package.json#files`.
 *
 * Why: `files` is the allowlist that controls what npm packs into the
 * tarball. If a referenced export/bin/main target lives in a directory
 * that is not in `files`, the package tarball is missing that content
 * and `import` / `npx` fails at install time on the consumer side.
 * Neither the subpaths smoke test (#137/#140) nor the bins smoke test
 * (#142) notice this: both exercise the working copy, not the
 * tarball. This fills the last gap in the package.json contract.
 *
 * Invariants:
 *   1. Every entry in `files` points to either a real directory or a
 *      real top-level file under the repo root.
 *   2. Every target of `main` + `types` + `exports.*.import` +
 *      `exports.*.types` + `bin.*` starts with a directory that is
 *      listed in `files`. A mis-declared exports/bin path that lives
 *      outside the files allowlist would fail here.
 *
 * Not covered here (out of scope, tracked separately):
 *   - Whether `npm pack` actually includes everything the test
 *     expects (depends on .npmignore, which can countermand `files`).
 *     A future layer could run `npm pack --dry-run --json` and
 *     assert on the tarball manifest directly.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

// npm permits several shapes under `exports.*`: a bare string shorthand
// (`"./foo": "./dist/foo.js"`), a conditions object with `import` /
// `types` / `require` / `default` / `node` keys, and nested condition
// objects. The repo currently uses the simple `{ import, types }` shape
// for every row; the test asserts that shape per row so a manifest
// evolution to string shorthand or additional conditions fails loudly
// with a dedicated assertion instead of a TypeError deep in the import
// / types probes.
type ExportsValue = string | { import?: string; types?: string };
interface PackageJson {
  files: readonly string[];
  main: string;
  types: string;
  bin: Record<string, string>;
  exports: Record<string, ExportsValue>;
}

const pkg = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'),
) as PackageJson;

/** First path segment, stripping any leading `./`. */
function firstSegment(p: string): string {
  return p.replace(/^\.\//, '').split('/')[0] ?? '';
}

describe('public surface: package.json#files', () => {
  it('declares exactly the documented set of entries', () => {
    expect([...pkg.files].sort()).toEqual([
      'LICENSE',
      'README.md',
      'bin',
      'dist',
      'docs',
      'examples',
      'scripts',
    ]);
  });

  describe.each(pkg.files)('files entry %s', (entry) => {
    it('exists on disk', () => {
      const abs = resolve(REPO_ROOT, entry);
      expect(existsSync(abs), `${entry} not found`).toBe(true);
    });
  });
});

describe('public surface: manifest targets reside inside files allowlist', () => {
  const allowedRoots = new Set(pkg.files.map(firstSegment));

  it('main target is inside files', () => {
    expect(allowedRoots.has(firstSegment(pkg.main)), pkg.main).toBe(true);
  });

  it('types target is inside files', () => {
    expect(allowedRoots.has(firstSegment(pkg.types)), pkg.types).toBe(true);
  });

  describe.each(Object.entries(pkg.bin))('bin %s', (_name, relPath) => {
    it('lives inside files', () => {
      expect(allowedRoots.has(firstSegment(relPath)), relPath).toBe(true);
    });
  });

  describe.each(Object.entries(pkg.exports))('exports %s', (key, value) => {
    it('is a conditions object (not string shorthand or unsupported shape)', () => {
      expect(
        value !== null && typeof value === 'object' && !Array.isArray(value),
        `exports["${key}"] must be a conditions object; got ${typeof value}`,
      ).toBe(true);
    });

    it('import target lives inside files', () => {
      expect(typeof value === 'object', `exports["${key}"] object shape`).toBe(true);
      const obj = value as { import?: string };
      expect(obj.import, `exports["${key}"].import missing`).toBeDefined();
      expect(allowedRoots.has(firstSegment(obj.import!)), obj.import!).toBe(true);
    });

    it('types target lives inside files', () => {
      expect(typeof value === 'object', `exports["${key}"] object shape`).toBe(true);
      const obj = value as { types?: string };
      expect(obj.types, `exports["${key}"].types missing`).toBeDefined();
      expect(allowedRoots.has(firstSegment(obj.types!)), obj.types!).toBe(true);
    });
  });
});

describe('public surface: README and LICENSE are readable at top level', () => {
  it.each(['README.md', 'LICENSE'])('%s is a file (not a directory)', (name) => {
    const abs = resolve(REPO_ROOT, name);
    expect(existsSync(abs), `${name} missing`).toBe(true);
    expect(statSync(abs).isFile(), `${name} is a file`).toBe(true);
  });
});
