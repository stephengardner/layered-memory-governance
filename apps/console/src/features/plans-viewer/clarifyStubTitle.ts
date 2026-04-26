/*
 * Clarify-stub plan-title normalizer.
 *
 * When the LLM-backed planning judgment fails (budget, turn cap, parse,
 * etc.) the planning actor mints a stub plan whose title prefix is
 * `Clarify: cannot draft a grounded plan (...)`. Today the parenthetical
 * embeds the raw Claude CLI stdout — including a multi-hundred-character
 * JSON envelope — which renders as a wall of text in the Plans grid and
 * makes the surface look broken. We do not want to suppress these stubs
 * (they are real governance evidence of substrate health) and we do not
 * want to rewrite atoms after the fact (atom-store remains the canonical
 * store). The fix is a pure render-time projection: detect the prefix,
 * pull the embedded `subtype` out of the stdout fragment, and surface a
 * short canonical label. The full original title is returned alongside so
 * callers can keep it accessible (native title attribute, expand panel).
 *
 * Returning `null` for non-matching titles lets the caller fall through
 * to whatever rendering it already does — no behavioural change for
 * non-clarify plans.
 */

const CLARIFY_PREFIX = 'Clarify: cannot draft a grounded plan';
const SUBTYPE_RE = /"subtype"\s*:\s*"(error_[a-z0-9_]+)"/;

const SUBTYPE_LABELS: Readonly<Record<string, string>> = {
  error_max_budget_usd: 'budget exceeded',
  error_max_turns: 'turn cap',
};

export interface ClarifyStubTitle {
  /**
   * Short canonical label safe to render in a card title slot.
   * Always begins with `Clarify: LLM draft failed`; a parenthesised
   * suffix may follow when a known error subtype is recognised
   * (e.g. `Clarify: LLM draft failed (budget exceeded)`). Parens
   * over emdash to keep the surface ASCII-clean for
   * `scripts/pre-push-lint.mjs`.
   */
  readonly label: string;
  /**
   * The original raw title verbatim. Callers should preserve this in a
   * native `title` tooltip and an expand affordance so the operator can
   * still inspect the underlying stdout when triaging.
   */
  readonly raw: string;
}

/**
 * Detect a clarify-stub plan title and return a clean short label plus
 * the raw original. Returns `null` for any title that does not begin
 * with the clarify-stub prefix.
 *
 * Pure function — no I/O, no module-scope mutation, deterministic on
 * the same input string.
 */
export function formatClarifyStubTitle(raw: string): ClarifyStubTitle | null {
  if (typeof raw !== 'string' || !raw.startsWith(CLARIFY_PREFIX)) return null;
  const match = raw.match(SUBTYPE_RE);
  const subtype = match?.[1];
  const suffix = subtype ? SUBTYPE_LABELS[subtype] : undefined;
  // Repository hygiene rejects both emdashes (U+2014) and en-dashes
  // (U+2013) under scripts/pre-push-lint.mjs. The CPO spec referenced an
  // emdash separator, but to keep the surface ASCII-clean and consistent
  // with the rest of `apps/console/src/`, we use a parenthesised suffix
  // when a known subtype is recognised. Reads naturally, no Unicode.
  const label = suffix
    ? `Clarify: LLM draft failed (${suffix})`
    : 'Clarify: LLM draft failed';
  return { label, raw };
}
