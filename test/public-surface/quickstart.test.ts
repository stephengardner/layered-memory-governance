/**
 * Public-surface smoke test for `examples/quickstart.mjs`.
 *
 * Why: the README cites `node examples/quickstart.mjs` as the 90-line
 * on-ramp for new adopters. It spins up a memory-backed Host, seeds
 * three atoms from three principals, searches them, runs a promotion
 * pass, and prints state + audit log. If that script ever breaks,
 * the first-impression path for an adopter is broken.
 *
 * No other test in this repo exercises the quickstart end-to-end:
 * vitest suites import modules directly; this one spawns the built
 * artifact like a consumer would.
 *
 * Invariants:
 *   1. `node examples/quickstart.mjs` exits 0.
 *   2. Output contains the final success sentinel "Quickstart OK.".
 *
 * The test skips gracefully if `dist/` is missing, matching the
 * README instruction sequence `npm install && npm run build && node
 * examples/quickstart.mjs`. CI runs `npm run build` before `npm
 * test`, so the skip only fires on a manual run before a first
 * build.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const DIST_ENTRY = resolve(REPO_ROOT, 'dist', 'index.js');
const QUICKSTART = resolve(REPO_ROOT, 'examples', 'quickstart.mjs');

describe('public surface: examples/quickstart.mjs', () => {
  it('exits 0 and prints the success sentinel', { timeout: 30_000 }, () => {
    if (!existsSync(DIST_ENTRY)) {
      console.warn(`dist/ missing at ${DIST_ENTRY}; skipping quickstart smoke`);
      return;
    }
    const result = spawnSync('node', [QUICKSTART], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 25_000,
    });
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('Quickstart OK.');
  });
});
