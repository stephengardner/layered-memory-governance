/**
 * Shared metadata-readers for the projection helper modules.
 *
 * The projection helpers (`pipelines.ts`, `pipeline-lifecycle.ts`,
 * `plan-state-lifecycle.ts`, `resume-audit.ts`) each open by parsing
 * the same `metadata: Record<string, unknown>` shape with identical
 * guard logic. Per canon `dev-extract-at-n=2`, the duplicated
 * functions live here so a future projection module imports them
 * rather than copy-pasting a fifth instance.
 *
 * Scoping rule: this module ships ONLY the readers whose contract is
 * identical across the consuming projections:
 *   - readString   : string | null
 *   - readObject   : Readonly<Record<string, unknown>> | null
 *
 * `readNumber` is intentionally NOT here because the projection
 * helpers disagree on the fallback shape (some return `0`, some
 * return `null`). Lifting them here would require either picking a
 * winner (a behavioral change in the modules I don't pick) or
 * shipping two flavors with confusable names. Each module continues
 * to define its own `readNumber` until those contracts agree; an
 * extraction at that point is a follow-up, not part of this PR.
 *
 * Pure: no I/O, no globals, no time. Importable from the browser
 * bundle (it's used by code that downcasts atoms anyway), but in
 * practice only the server-side projection modules import it today.
 */

/**
 * Coerce an unknown metadata value to a non-empty string, or null.
 * Mirrors the existing reader copies in pipelines.ts /
 * plan-state-lifecycle.ts / pipeline-lifecycle.ts / resume-audit.ts.
 */
export function readString(
  meta: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const v = meta[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Coerce an unknown metadata value to a plain object, or null. Arrays
 * fail the guard because consumers typically branch on object-shape
 * vs array-shape and a leaked array would break field-access code.
 */
export function readObject(
  meta: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> | null {
  const v = meta[key];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return v as Readonly<Record<string, unknown>>;
}
