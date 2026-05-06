/**
 * Pure plan-summary formatter shared by every plan-Telegram surface
 * (approve, discuss, and the LoopRunner notify-pass adapter).
 *
 * Extraction contract: the plan's `content` field is markdown. The
 * first line matching /^#{1,3}\s+(.+)$/ supplies the title; the rest
 * (after that line) is the body. The formatter does NOT truncate --
 * truncation is a per-consumer concern (plan-approve uses a 600-char
 * preview, the auto-trigger Telegram message uses a 3000-char body
 * cap, plan-discuss uses the full body).
 *
 * Pure function: no I/O, no side effects, no env reads. The return
 * shape is stable across all consumers, which is what makes the DRY
 * extraction worthwhile -- each call site can rely on identical
 * heading-detection semantics regardless of how it then renders the
 * text.
 *
 * Lives in scripts/lib/ (no shebang) so vitest+esbuild on Windows-CI
 * can import it from a .test.ts without tripping the shebang loader.
 * Same pattern as scripts/lib/plan-approve-telegram.mjs and
 * scripts/lib/cr-precheck.mjs.
 */

/**
 * @typedef {Object} PlanLike
 * @property {string} [id]
 * @property {string|null} [content]
 */

/**
 * Extract title + body from a plan-shaped object.
 *
 * @param {PlanLike|null|undefined} plan
 * @returns {{ title: string; body: string }}
 */
export function extractPlanTitleAndBody(plan) {
  const id = plan && typeof plan.id === 'string' ? plan.id : null;
  // Defensive String() so a malformed atom (number, undefined, null)
  // does not crash the formatter; the caller may be running this on
  // an atom from disk whose schema-version drift produced an unusual
  // shape.
  const content = plan && plan.content != null ? String(plan.content) : '';
  const lines = content.split('\n');
  let title = '';
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#{1,3}\s+(.+)$/);
    if (m) {
      title = m[1].trim();
      bodyStart = i + 1;
      break;
    }
  }
  // No truncation: callers do their own. Trim the body so leading +
  // trailing blank lines (which the markdown heading often leaves
  // behind) do not pollute the consumer's display.
  const body = lines.slice(bodyStart).join('\n').trim();
  const fallbackTitle = id ? `(no title - id ${id})` : '(no title)';
  return { title: title || fallbackTitle, body };
}
