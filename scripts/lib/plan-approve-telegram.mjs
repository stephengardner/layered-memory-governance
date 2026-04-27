/**
 * Pure helpers for scripts/plan-approve-telegram.mjs.
 *
 * Lives in scripts/lib/ (no shebang) so vitest+esbuild on Windows-CI
 * can import them from a .test.ts without tripping the shebang
 * loader. Same pattern as scripts/lib/git-as-set-upstream.mjs and
 * scripts/lib/cr-precheck.mjs.
 */

export const DEFAULT_TIMEOUT_MS = 600_000;
export const PLAN_SUMMARY_BODY_MAX = 600;

/**
 * Parse argv shape: `<plan-id> [--timeout ms]`. Returns a structured
 * object with planId, timeoutMs, and a help flag. Pure function;
 * caller validates numeric bounds.
 */
export function parseArgs(argv) {
  const args = {
    planId: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--timeout' && i + 1 < argv.length) {
      args.timeoutMs = Number(argv[++i]);
    } else if (a === '-h' || a === '--help') {
      args.help = true;
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
 */
export function formatPlanSummary(plan) {
  const content = String(plan?.content ?? '');
  const lines = content.split('\n');
  let titleLine = '';
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#{1,3}\s+(.+)$/);
    if (m) {
      titleLine = m[1].trim();
      bodyStart = i + 1;
      break;
    }
  }
  const body = lines.slice(bodyStart).join('\n').trim();
  const truncated =
    body.length > PLAN_SUMMARY_BODY_MAX
      ? body.slice(0, PLAN_SUMMARY_BODY_MAX) + '...(truncated)'
      : body;
  const fallbackTitle = plan?.id ? `(no title - id ${plan.id})` : '(no title)';
  return { title: titleLine || fallbackTitle, body: truncated };
}
