#!/usr/bin/env node
// Deployment-side wrapper for the compiled CLI. The bin layer is the
// composition root where vendor-specific seams (today: the
// PR-observation refresher) are wired into the framework's
// generic CLI module. Keeping this file outside `dist/` keeps
// framework code mechanism-only: src/ never imports a concrete
// vendor adapter; the bin script does the wiring.
//
// Depends on `npm run build` producing dist/cli/run-loop.js
// (configured in tsconfig).
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runLoopMain } from '../dist/cli/run-loop.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REFRESHER_HELPER = resolve(HERE, '..', 'scripts', 'lib', 'pr-observation-refresher.mjs');

/**
 * Build the PR-observation refresher by dynamic-importing the
 * companion helper at scripts/lib/pr-observation-refresher.mjs. The
 * helper shells out to scripts/run-pr-landing.mjs, which is the
 * deployment-side GitHub-shaped concern. Returns null when the
 * helper cannot be resolved (e.g. an out-of-tree build that did not
 * ship `scripts/`); the refresh pass then silent-skips per the
 * LoopRunner contract.
 *
 * pathToFileURL is Windows-safe: a bare path with a `C:` drive
 * letter would otherwise be interpreted as a URL scheme by the ESM
 * dynamic-import resolver.
 */
async function prObservationRefresherFactory() {
  try {
    const mod = await import(pathToFileURL(REFRESHER_HELPER).href);
    if (typeof mod.createPrLandingObserveRefresher !== 'function') {
      console.error(
        `[plan-obs-refresh] WARN: refresher helper at ${REFRESHER_HELPER} did not `
          + 'export createPrLandingObserveRefresher; refresh pass will silent-skip.',
      );
      return null;
    }
    return mod.createPrLandingObserveRefresher();
  } catch (err) {
    console.error(
      `[plan-obs-refresh] WARN: could not load refresher helper at ${REFRESHER_HELPER}: `
        + `${err instanceof Error ? err.message : String(err)}; refresh pass will silent-skip.`,
    );
    return null;
  }
}

const exitCode = await runLoopMain({
  prObservationRefresherFactory,
}).catch((err) => {
  console.error('fatal:', err instanceof Error ? (err.stack ?? err.message) : String(err));
  return 2;
});
if (exitCode !== 0) process.exit(exitCode);
