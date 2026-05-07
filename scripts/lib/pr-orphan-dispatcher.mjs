/**
 * Orphan-PR dispatcher: deployment-side adapter that the orphan-
 * reconcile tick uses to spawn a fresh driver sub-agent for an
 * orphaned PR.
 *
 * Substrate purity: the framework module
 * `src/runtime/plans/pr-orphan-reconcile.ts` stays mechanism-only;
 * this module shells out to `scripts/run-pr-fix.mjs` (the canonical
 * PR-fix flow that drives an open PR through CR cycles to merged
 * state). A different deployment with a different driver flow swaps
 * in their own dispatcher without changing the framework contract.
 *
 * Best-effort: spawn failures bubble as a rejected Promise; the
 * orphan tick records the failure on the orphan-detected atom's
 * metadata and does not block subsequent ticks.
 *
 * Bot identity: routed through the dispatching role's git-as / gh-as
 * shims so all GitHub API calls are attributed to the bot, never
 * the operator.
 */
import { execa } from 'execa';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_PR_FIX = resolve(HERE, '..', 'run-pr-fix.mjs');

/**
 * Validate dispatch args. Exported for test pinning.
 *
 * @param {unknown} args
 * @returns {true}
 */
export function validateDispatchArgs(args) {
  if (!args || typeof args !== 'object') {
    throw new Error('dispatch: args must be an object');
  }
  const { pr, orphan_atom_id, orphan_reason } = args;
  if (!pr || typeof pr !== 'object') {
    throw new Error('dispatch: args.pr must be an object {owner, repo, number}');
  }
  if (typeof pr.owner !== 'string' || pr.owner.length === 0) {
    throw new Error('dispatch: pr.owner must be a non-empty string');
  }
  if (typeof pr.repo !== 'string' || pr.repo.length === 0) {
    throw new Error('dispatch: pr.repo must be a non-empty string');
  }
  if (
    typeof pr.number !== 'number'
    || !Number.isFinite(pr.number)
    || !Number.isInteger(pr.number)
    || pr.number <= 0
  ) {
    throw new Error(`dispatch: pr.number must be a positive integer (got ${String(pr.number)})`);
  }
  if (typeof orphan_atom_id !== 'string' || orphan_atom_id.length === 0) {
    throw new Error('dispatch: orphan_atom_id must be a non-empty string');
  }
  if (typeof orphan_reason !== 'string' || orphan_reason.length === 0) {
    throw new Error('dispatch: orphan_reason must be a non-empty string');
  }
  return true;
}

/**
 * Build the {@link OrphanPrDispatcher} adapter that the framework
 * tick consumes. Per-call spawn timeout is bounded (default 30min) so
 * a single stuck driver sub-agent does not block the whole orphan
 * reconcile pass; a sub-agent that genuinely needs longer drives a
 * dedicated session, not the dispatch call here.
 *
 * @param {{
 *   readonly repoRoot?: string,
 *   readonly timeoutMs?: number,
 *   readonly extraArgs?: ReadonlyArray<string>,
 * }} [options]
 */
export function createPrFixOrphanDispatcher(options = {}) {
  const repoRoot = options.repoRoot ?? resolve(HERE, '..', '..');
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1_000;
  const extraArgs = options.extraArgs ?? [];
  return {
    /**
     * @param {{
     *   pr: { owner: string, repo: string, number: number },
     *   orphan_atom_id: string,
     *   orphan_reason: string,
     *   prior_claim: unknown,
     * }} args
     */
    async dispatch(args) {
      validateDispatchArgs(args);
      const { pr, orphan_atom_id, orphan_reason } = args;
      // run-pr-fix.mjs drives the PR through one fix-cycle. The
      // orphan_atom_id + orphan_reason are forwarded as env vars and
      // run-pr-fix.mjs reads them at startup, threading them onto
      // PrFixActor's `originContext` option. The first observation
      // atom the actor writes chains via `provenance.derived_from`
      // back to the orphan-detected atom and stores the reason on
      // `metadata.extra.dispatch_origin`, so the audit trail reads
      // end-to-end (orphan-detected -> pr-fix observation -> session
      // -> fix-push) without a side-channel scan.
      await execa(
        'node',
        [
          RUN_PR_FIX,
          '--pr', String(pr.number),
          '--owner', pr.owner,
          '--repo', pr.repo,
          ...extraArgs,
        ],
        {
          cwd: repoRoot,
          timeout: timeoutMs,
          stdio: 'inherit',
          env: {
            ...process.env,
            LAG_PR_ORPHAN_ATOM_ID: orphan_atom_id,
            LAG_PR_ORPHAN_REASON: orphan_reason,
          },
        },
      );
    },
  };
}
