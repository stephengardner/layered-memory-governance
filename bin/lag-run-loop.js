#!/usr/bin/env node
// Deployment-side wrapper for the compiled CLI. The bin layer is the
// composition root where vendor-specific seams (the PR-observation
// refresher, the open-PR source, the orphan dispatcher) are wired
// into the framework's generic CLI module. Keeping this file outside
// `dist/` keeps framework code mechanism-only: src/ never imports a
// concrete vendor adapter; the bin script does the wiring.
//
// Depends on `npm run build` producing dist/cli/run-loop.js
// (configured in tsconfig).
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execa } from 'execa';
import { runLoopMain } from '../dist/cli/run-loop.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REFRESHER_HELPER = resolve(HERE, '..', 'scripts', 'lib', 'pr-observation-refresher.mjs');
const NOTIFIER_HELPER = resolve(HERE, '..', 'scripts', 'lib', 'telegram-plan-trigger.mjs');
const ORPHAN_SOURCE_HELPER = resolve(HERE, '..', 'scripts', 'lib', 'pr-orphan-source-gh.mjs');
const ORPHAN_DISPATCHER_HELPER = resolve(HERE, '..', 'scripts', 'lib', 'pr-orphan-dispatcher.mjs');

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

/**
 * Build the plan-proposal notifier by dynamic-importing the
 * companion helper at scripts/lib/telegram-plan-trigger.mjs. The
 * helper reads TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID from env;
 * returns null when either is missing so the framework silent-skips
 * per the LoopRunner contract. An out-of-tree build that did not
 * ship `scripts/` (or a deployment without env config) lands on the
 * silent-skip path naturally.
 */
async function planProposalNotifierFactory() {
  try {
    const mod = await import(pathToFileURL(NOTIFIER_HELPER).href);
    if (typeof mod.createTelegramPlanProposalNotifier !== 'function') {
      console.error(
        `[plan-proposal-notify] WARN: notifier helper at ${NOTIFIER_HELPER} did not `
          + 'export createTelegramPlanProposalNotifier; notify pass will silent-skip.',
      );
      return null;
    }
    return mod.createTelegramPlanProposalNotifier();
  } catch (err) {
    console.error(
      `[plan-proposal-notify] WARN: could not load notifier helper at ${NOTIFIER_HELPER}: `
        + `${err instanceof Error ? err.message : String(err)}; notify pass will silent-skip.`,
    );
    return null;
  }
}

/**
 * Resolve the (owner, repo) from the GH_REPO env var or `gh repo
 * view`. Mirrors the resolveOwnerRepo pattern in
 * scripts/invokers/autonomous-dispatch.mjs so the orphan reconcile
 * pass and the dispatch invoker share one canonical resolution
 * shape.
 */
async function resolveOwnerRepo() {
  const slug = process.env.GH_REPO;
  if (typeof slug === 'string' && slug.length > 0) {
    const parts = slug.trim().split('/');
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { owner: parts[0], repo: parts[1] };
    }
  }
  // Fall through to `gh repo view`. Reject:false suppresses non-zero
  // exits but execa still throws ENOENT when gh is missing; both
  // produce a null return that turns the orphan pass into silent-
  // skip per the LoopRunner contract.
  try {
    const result = await execa('gh', ['repo', 'view', '--json', 'owner,name'], { reject: false });
    if (result.exitCode !== 0) return null;
    const parsed = JSON.parse(result.stdout);
    if (!parsed?.owner?.login || !parsed?.name) return null;
    return { owner: parsed.owner.login, repo: parsed.name };
  } catch {
    return null;
  }
}

/**
 * Build the open-PR source by dynamic-importing the companion helper
 * at scripts/lib/pr-orphan-source-gh.mjs. The helper shells out to
 * gh-as.mjs <role> to query the GitHub GraphQL API for currently-
 * open PRs and their last-activity timestamps.
 */
async function prOpenPrSourceFactory() {
  const ownerRepo = await resolveOwnerRepo();
  if (ownerRepo === null) {
    console.error(
      '[pr-orphan-reconcile] WARN: could not resolve owner/repo for orphan source. '
        + 'Set GH_REPO=owner/repo or run from a directory where `gh repo view` works. '
        + 'Pass will silent-skip.',
    );
    return null;
  }
  try {
    const mod = await import(pathToFileURL(ORPHAN_SOURCE_HELPER).href);
    if (typeof mod.createGhOpenPrSource !== 'function') {
      console.error(
        `[pr-orphan-reconcile] WARN: open-PR source helper at ${ORPHAN_SOURCE_HELPER} did not `
          + 'export createGhOpenPrSource; pass will silent-skip.',
      );
      return null;
    }
    return mod.createGhOpenPrSource({ owner: ownerRepo.owner, repo: ownerRepo.repo });
  } catch (err) {
    console.error(
      `[pr-orphan-reconcile] WARN: could not load open-PR source helper at ${ORPHAN_SOURCE_HELPER}: `
        + `${err instanceof Error ? err.message : String(err)}; pass will silent-skip.`,
    );
    return null;
  }
}

/**
 * Build the orphan dispatcher by dynamic-importing
 * scripts/lib/pr-orphan-dispatcher.mjs. Default impl shells out to
 * run-pr-fix.mjs. A deployment that wants a different driver-flow
 * (different sub-agent, different fix loop) replaces this factory.
 */
async function prOrphanDispatcherFactory() {
  try {
    const mod = await import(pathToFileURL(ORPHAN_DISPATCHER_HELPER).href);
    if (typeof mod.createPrFixOrphanDispatcher !== 'function') {
      console.error(
        `[pr-orphan-reconcile] WARN: dispatcher helper at ${ORPHAN_DISPATCHER_HELPER} did not `
          + 'export createPrFixOrphanDispatcher; pass will silent-skip.',
      );
      return null;
    }
    return mod.createPrFixOrphanDispatcher();
  } catch (err) {
    console.error(
      `[pr-orphan-reconcile] WARN: could not load dispatcher helper at ${ORPHAN_DISPATCHER_HELPER}: `
        + `${err instanceof Error ? err.message : String(err)}; pass will silent-skip.`,
    );
    return null;
  }
}

const exitCode = await runLoopMain({
  prObservationRefresherFactory,
  planProposalNotifierFactory,
  prOpenPrSourceFactory,
  prOrphanDispatcherFactory,
}).catch((err) => {
  console.error('fatal:', err instanceof Error ? (err.stack ?? err.message) : String(err));
  return 2;
});
if (exitCode !== 0) process.exit(exitCode);
