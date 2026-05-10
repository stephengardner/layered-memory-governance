/*
 * Pure helpers for the reaped-atom projection filter.
 *
 * The pipeline reaper (`src/runtime/plans/pipeline-reaper.ts`,
 * shipped via PR #377) marks stale pipeline / pipeline-stage / agent
 * session / agent-turn atoms with a leaf metadata write:
 *
 *   metadata: { reaped_at: <ISO>, reaped_reason: <enum-string> }
 *
 * Reaping NEVER deletes from the AtomStore (canon
 * `arch-atomstore-source-of-truth` -- atoms are append-only). It is a
 * leaf metadata mutation plus a confidence floor (0.01) so arbitration
 * and projections both deprioritize the reaped subset without a hard
 * fence. The Console projection here is the user-facing complement:
 * by default the activities feed hides reaped atoms so the timeline
 * reflects the live work, with a "Show reaped (N)" toggle for the
 * audit operator who needs the historical record.
 *
 * Design decisions baked into this module:
 *
 *   - Filter is PROJECTION-LAYER, not substrate-layer. The atom files
 *     on disk are unchanged. Single-atom reads (atoms.get,
 *     atoms.references, atoms.audit-chain) bypass this filter so a
 *     `derived_from` link still resolves to a reaped atom -- the
 *     audit chain must remain navigable per canon
 *     `dev-substrate-not-prescription`.
 *   - The filter is a pure boolean predicate so the test surface is
 *     trivial: vitest exercises the predicate without standing up
 *     an HTTP server or touching disk.
 *   - `metadata.reaped_at` is the canonical signal. We accept any
 *     truthy string (the substrate writes ISO-8601 UTC; the projection
 *     does NOT validate the format because future reaper kinds may
 *     format differently and the substrate is the authority).
 */

/**
 * Minimal atom shape this module needs. Defined locally rather than
 * imported from server/index.ts so the module stays test-isolated and
 * does not pull in HTTP/filesystem dependencies just for typing.
 */
export interface ReapedFilterAtom {
  readonly metadata?: Record<string, unknown>;
}

/**
 * True iff the atom carries the canonical reaped marker
 * (`metadata.reaped_at` set to a non-empty string).
 *
 * Defensive: rejects non-string `reaped_at` values so a stray
 * non-conformant write does not silently hide an atom. The substrate
 * conformance test (`test/conformance/shared/atoms-spec.ts`) enforces
 * the string-ISO convention; this guard is the projection-side
 * defense-in-depth.
 */
export function isReaped(atom: ReapedFilterAtom): boolean {
  const meta = atom.metadata;
  if (!meta) return false;
  const v = meta['reaped_at'];
  return typeof v === 'string' && v.length > 0;
}

/**
 * Apply the reaped-hide projection to a list of atoms.
 *
 *   - `includeReaped=false` (the default UI posture): drop atoms
 *     whose `metadata.reaped_at` is set. Returns the live + the
 *     count of reaped atoms that were filtered out, so the UI can
 *     render "Show reaped (N)".
 *   - `includeReaped=true`: pass through unchanged; the count still
 *     reports how many of the input set were reaped, for the toggle
 *     label.
 *
 * Order is preserved (this is a filter pass, not a sort). Callers
 * that need a sorted view should sort BEFORE passing in.
 */
export function applyReapedFilter<T extends ReapedFilterAtom>(
  atoms: ReadonlyArray<T>,
  includeReaped: boolean,
): { readonly atoms: ReadonlyArray<T>; readonly reaped_count: number } {
  let reapedCount = 0;
  const out: T[] = [];
  for (const a of atoms) {
    if (isReaped(a)) {
      reapedCount += 1;
      if (includeReaped) out.push(a);
    } else {
      out.push(a);
    }
  }
  return { atoms: out, reaped_count: reapedCount };
}
