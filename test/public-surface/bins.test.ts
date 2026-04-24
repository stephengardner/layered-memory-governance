/**
 * Public-surface smoke tests for `package.json#bin` entries.
 *
 * Why: the exports map is one half of what consumers install; the
 * other half is the bin map. npm creates a shim in `node_modules/.bin`
 * for every `bin` entry at install time. If a target path is wrong
 * (typo, file moved, renamed without updating the manifest) the
 * install succeeds but running `npx lag-respond` fails at exec time.
 * No other test in this repo exercises the bin surface.
 *
 * Invariants per bin:
 *   1. Target file exists under the repo root.
 *   2. First line is `#!/usr/bin/env node`. npm does not validate the
 *      shebang; a missing one would still break execution on Unix
 *      ("cannot execute binary file" / "permission denied") even
 *      though Windows is shim-based and tolerant.
 *
 * As with subpaths.test.ts, the set of declared bins is read from
 * `package.json` and compared against a pinned expected list so
 * adding a new bin without updating this test is a deliberate act.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

const pkg = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'),
) as { bin: Record<string, string> };

const EXPECTED_BINS = [
  'lag-actors',
  'lag-compromise',
  'lag-respond',
  'lag-run-loop',
  'lag-tg',
] as const;

describe('public surface: package.json#bin', () => {
  it('declares exactly the documented set of bins', () => {
    expect(Object.keys(pkg.bin).sort()).toEqual([...EXPECTED_BINS].sort());
  });

  // Drive the per-bin loop off EXPECTED_BINS so the allowlist is the
  // single contract; pkg.bin[name] is looked up inside each case and
  // asserted non-empty. A renamed bin that only shows up in pkg.bin
  // fails the allowlist test above without generating a parallel set
  // of passing tests under the unvetted name.
  describe.each(EXPECTED_BINS)('bin %s', (name) => {
    const relPath = pkg.bin[name];

    it('is declared in package.json#bin', () => {
      expect(relPath, `${name} missing from pkg.bin`).toBeTypeOf('string');
    });

    it('target file exists on disk', () => {
      const absPath = resolve(REPO_ROOT, relPath ?? '');
      expect(existsSync(absPath), `${name} -> ${relPath}`).toBe(true);
    });

    it('starts with node shebang', () => {
      // Tolerate CRLF working-copy line endings on Windows. The repo
      // blob is LF and npm packages LF, but Windows git checkout may
      // restore CR. The invariant is "first line equals the shebang",
      // not "file uses LF".
      const absPath = resolve(REPO_ROOT, relPath ?? '');
      const firstLine = readFileSync(absPath, 'utf8').split(/\r?\n/, 1)[0];
      expect(firstLine, `${name} shebang`).toBe('#!/usr/bin/env node');
    });
  });
});
