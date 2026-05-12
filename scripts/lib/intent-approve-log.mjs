/**
 * Formatters for runIntentAutoApprovePass result lines.
 *
 * Both scripts/run-cto-actor.mjs (single-pass end-of-run sweep) and
 * scripts/run-approval-cycle.mjs (daemon) render the same composite
 * log line for an intent-approve tick result: scanned + approved +
 * rejected breakdown + skipped breakdown. The two paths used to inline
 * the same formatting twice; extracting at n=2 per
 * dev-code-duplication-extract-at-n2 prevents a third site (a future
 * cpo-actor runner, an org-ceiling deployment's custom driver) from
 * copy-pasting yet again and drifting the format.
 *
 * The formatters are pure: they take a tick result and return strings.
 * No I/O, no clock dependency; tests pin the exact expected output.
 */

/**
 * Render the per-reason rejection breakdown as " rejected=N (reason1=A reason2=B)".
 * When the breakdown is empty (no rejections OR no per-reason counts),
 * returns just " rejected=N". The leading space is included so the
 * caller can concatenate the fragment directly without re-adding it.
 *
 * @param {number} rejected - Total rejection count.
 * @param {Record<string, number>} rejectedByReason - Per-reason counts.
 * @returns {string} Composite fragment, never empty.
 */
export function formatRejectedFragment(rejected, rejectedByReason) {
  const breakdown = Object.entries(rejectedByReason ?? {})
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(' ');
  if (rejected > 0 && breakdown) return ` rejected=${rejected} (${breakdown})`;
  return ` rejected=${rejected}`;
}

/**
 * Render the per-reason skip breakdown as " skipped=N (reason1=A reason2=B)".
 * When `skipped === 0` the function returns an empty string so the
 * caller's log line stays terse for clean ticks. Mirrors
 * formatRejectedFragment's leading-space contract for direct concat.
 *
 * @param {number} skipped - Total skip count.
 * @param {Record<string, number>} skippedByReason - Per-reason counts.
 * @returns {string} Composite fragment, empty when skipped===0.
 */
export function formatSkippedFragment(skipped, skippedByReason) {
  if (skipped <= 0) return '';
  const breakdown = Object.entries(skippedByReason ?? {})
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(' ');
  return ` skipped=${skipped}${breakdown ? ` (${breakdown})` : ''}`;
}

/**
 * Compose the full intent-approve tick log line minus a caller-supplied
 * prefix. Returns the trailing portion after the colon:
 *   "scanned=N approved=M rejected=R (reason=X) skipped=S (reason=Y)"
 *
 * The prefix (e.g. "[approval-cycle] intent-approve     ") is the
 * caller's concern; this helper builds the metrics-bearing tail so the
 * two consumers stay in lock-step on field order + naming.
 *
 * @param {object} result - runIntentAutoApprovePass return value.
 * @returns {string} Composite tail string for log output.
 */
export function formatIntentApproveResult(result) {
  const rejected = result?.rejected ?? 0;
  const skipped = result?.skipped ?? 0;
  const rejectedFragment = formatRejectedFragment(rejected, result?.rejectedByReason);
  const skippedFragment = formatSkippedFragment(skipped, result?.skippedByReason);
  return (
    `scanned=${result?.scanned ?? 0} approved=${result?.approved ?? 0}`
    + `${rejectedFragment}${skippedFragment}`
  );
}
