/**
 * Pure helpers for scripts/plan-approve-telegram.mjs.
 *
 * Lives in scripts/lib/ (no shebang) so vitest+esbuild on Windows-CI
 * can import them from a .test.ts without tripping the shebang
 * loader. Same pattern as scripts/lib/git-as-set-upstream.mjs and
 * scripts/lib/cr-precheck.mjs.
 */

import { extractPlanTitleAndBody } from './plan-summary.mjs';

export const DEFAULT_TIMEOUT_MS = 600_000;
export const PLAN_SUMMARY_BODY_MAX = 600;

/**
 * Parse argv shape: `<plan-id> [--timeout ms] [--principal id]`.
 * Returns a structured object with planId, timeoutMs, principal, and
 * a help flag. Throws on unknown long-form flags so a typo
 * ('--timout') fails loud instead of silently becoming part of
 * planId. Throws on a `--timeout` / `--principal` flag without a
 * value or with a non-numeric timeout.
 */
export function parseArgs(argv) {
  const args = {
    planId: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    principal: null,
    help: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      args.help = true;
    } else if (a === '--timeout') {
      if (i + 1 >= argv.length) {
        throw new Error('missing value for --timeout');
      }
      const next = argv[++i];
      const num = Number(next);
      if (!Number.isFinite(num)) {
        throw new Error(`invalid value for --timeout: ${next}`);
      }
      args.timeoutMs = num;
    } else if (a === '--principal') {
      if (i + 1 >= argv.length) {
        throw new Error('missing value for --principal');
      }
      args.principal = String(argv[++i]).trim() || null;
    } else if (typeof a === 'string' && a.startsWith('--')) {
      throw new Error(`unknown option: ${a}`);
    } else {
      rest.push(a);
    }
  }
  args.planId = rest.join(' ').trim();
  return args;
}

/**
 * Validate the parsed args. Returns {ok: boolean, error?: string} so
 * the caller decides between a usage hint (1) and a fatal exit (1).
 */
export function validateArgs(args) {
  if (!args.planId) {
    return { ok: false, error: 'missing plan-id (positional)' };
  }
  if (
    !Number.isFinite(args.timeoutMs)
    || !Number.isInteger(args.timeoutMs)
    || args.timeoutMs <= 0
  ) {
    return { ok: false, error: '--timeout must be a positive integer (ms)' };
  }
  return { ok: true };
}

/**
 * Extract the markdown-heading title + truncated body from a plan
 * atom's content. The full body can run thousands of chars; phones
 * are not great at scrolling. We keep the first heading + ~600 chars
 * of body and signpost truncation.
 *
 * Title extraction is delegated to the shared formatter at
 * scripts/lib/plan-summary.mjs so every plan-Telegram surface
 * (approve, discuss, auto-trigger) shares one heading-detection
 * implementation. This wrapper preserves the existing
 * approve-script signature and adds the 600-char truncation that is
 * specific to the approve-script's display budget.
 */
export function formatPlanSummary(plan) {
  const { title, body } = extractPlanTitleAndBody(plan);
  const truncated =
    body.length > PLAN_SUMMARY_BODY_MAX
      ? body.slice(0, PLAN_SUMMARY_BODY_MAX) + '...(truncated)'
      : body;
  return { title, body: truncated };
}
