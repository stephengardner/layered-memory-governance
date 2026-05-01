/**
 * PR-observation refresher: deployment-side adapter that the
 * approval-cycle's runPlanObservationRefreshTick uses to write a fresh
 * observation atom when the existing one is stale.
 *
 * Spawns `node scripts/run-pr-landing.mjs --observe-only --live` for
 * each (pr, plan_id) the tick surfaces. The framework module
 * src/runtime/plans/pr-observation-refresh.ts stays mechanism-only;
 * this module carries the GitHub-shaped concern (process spawn, repo
 * checkout, gh auth) per the substrate-not-prescription canon.
 *
 * Best-effort: spawn failures bubble as a rejected Promise; the tick
 * counts them as skipped['refresh-failed'] and moves on.
 *
 * The validateRefreshArgs guard is exported so tests can pin the input
 * contract without spawning a child process.
 */
import { execa } from 'execa';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_PR_LANDING = resolve(HERE, '..', 'run-pr-landing.mjs');

/**
 * Loud validation guard. Returns true on success; throws Error with a
 * descriptive message on any malformed input. Exported so unit tests
 * can pin the contract without spawning a subprocess.
 *
 * @param {unknown} args
 * @returns {true}
 */
export function validateRefreshArgs(args) {
  if (!args || typeof args !== 'object') {
    throw new Error('refresh: args must be an object');
  }
  const { pr, plan_id } = args;
  if (!pr || typeof pr !== 'object') {
    throw new Error('refresh: args.pr must be an object {owner, repo, number}');
  }
  if (typeof pr.owner !== 'string' || pr.owner.length === 0) {
    throw new Error('refresh: pr.owner must be a non-empty string');
  }
  if (typeof pr.repo !== 'string' || pr.repo.length === 0) {
    throw new Error('refresh: pr.repo must be a non-empty string');
  }
  if (
    typeof pr.number !== 'number'
    || !Number.isFinite(pr.number)
    || !Number.isInteger(pr.number)
    || pr.number <= 0
  ) {
    throw new Error(`refresh: pr.number must be a positive integer (got ${String(pr.number)})`);
  }
  if (typeof plan_id !== 'string' || plan_id.length === 0) {
    throw new Error('refresh: plan_id must be a non-empty string');
  }
  return true;
}

/**
 * Build the {@link PrObservationRefresher} adapter that the framework
 * tick consumes. Per-call spawn timeout is bounded (default 90s) so a
 * single stuck call does not block the whole approval-cycle pass.
 *
 * @param {{
 *   readonly repoRoot?: string,
 *   readonly timeoutMs?: number,
 * }} [options]
 */
export function createPrLandingObserveRefresher(options = {}) {
  const repoRoot = options.repoRoot ?? resolve(HERE, '..', '..');
  const timeoutMs = options.timeoutMs ?? 90_000;
  return {
    /**
     * @param {{ pr: { owner: string, repo: string, number: number }, plan_id: string }} args
     */
    async refresh(args) {
      validateRefreshArgs(args);
      const { pr, plan_id } = args;
      await execa('node', [
        RUN_PR_LANDING,
        '--pr', String(pr.number),
        '--owner', pr.owner,
        '--repo', pr.repo,
        '--observe-only',
        '--live',
        '--plan-id', plan_id,
      ], { cwd: repoRoot, timeout: timeoutMs, stdio: 'inherit' });
    },
  };
}
