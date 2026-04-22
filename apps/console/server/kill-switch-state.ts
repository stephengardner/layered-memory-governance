/*
 * Pure helpers for the kill-switch state handler. Extracted from
 * server/index.ts so the unit tests (server/kill-switch.test.ts)
 * can import them without triggering the server.listen + file-
 * watcher side effects the entrypoint module carries.
 *
 * Runtime parity: server/index.ts imports from this module and
 * uses the same exported helper for its load path, so the test
 * and the real handler agree by construction.
 */

/*
 * Validate + clamp a candidate autonomyDial to the documented [0..1]
 * range. Returns the sanitized number if the input is a bona fide,
 * finite number (clamped to the legal range). Returns `null` on any
 * other input — NaN, Infinity, strings, objects, nullish — signalling
 * "malformed payload" to the caller.
 *
 * This helper is deliberately NOT fail-open: the kill-switch is a
 * safety primitive, and a present-but-corrupt state file should NOT
 * be interpreted as "fully autonomous" (which is what a silent
 * fallback to 1 would do). The caller distinguishes:
 *   - file absent  → default to 1 (no tier active)
 *   - file malformed → fail closed (0, fully gated)
 *   - file valid    → pass through the sanitized dial
 * That split lives at the call site, not here. `parseAutonomyDial`
 * only answers "is this a well-formed number in range? if so, here
 * it is; if not, null."
 */
export function parseAutonomyDial(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
