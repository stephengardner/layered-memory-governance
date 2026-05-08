/**
 * Shared filesystem-token extractor for the planning pipeline.
 *
 * Two call sites depend on the same regex + extension allowlist +
 * diff-prefix-strip logic:
 *
 *   - The plan-stage zod schema's `target_paths` completeness fence.
 *     Narrowed to only walk step-target marker lines so prose-only
 *     path mentions (read-only context references) do NOT inflate the
 *     required set.
 *
 *   - The diff-based + agentic CodeAuthorExecutors' fallback when
 *     `plan.metadata.target_paths` is missing entirely. Walks the
 *     plan content as freeform prose to discover paths the drafter
 *     should scope to.
 *
 * The shared primitive here is the single source of truth for the
 * low-level token shape (regex + extension allowlist + traversal
 * guard + diff-prefix strip); per-call-site helpers add scoping
 * concerns (narrow walk vs. broad walk) on top. Without sharing,
 * drift between the schema regex and the executors' inline regexes
 * would let the schema accept plans the drafters then no-op on (or
 * vice versa).
 *
 * Why this lives under src/runtime/planning-pipeline/ rather than in
 * examples/: framework code MUST NOT import from examples/, while
 * examples/ adapters MAY import from src/. Lifting the shared
 * primitive into the framework is the only direction that satisfies
 * both invariants.
 */

/**
 * Extension allowlist for the body-path completeness check. Mirrors
 * the prior inline allowlists across all three call sites. Deliberately
 * excludes extensions that show up in prose for non-path reasons
 * (`.com`, `.org`, `.net`, version strings); the allowlist is the
 * single source of truth.
 */
const PATH_EXT_ALLOWLIST =
  'md|ts|tsx|js|jsx|mjs|cjs|json|yml|yaml|toml|css|scss|html|sh|py|go|rs|java|kt|rb|ex|exs';

/**
 * Regex matching a filesystem-shaped token bounded by a true prose
 * boundary, with a known text/code extension. The leading lookbehind
 * `(?<![A-Za-z0-9_\\/.])` blocks matches that begin adjacent to a
 * word char, `/`, or `.` so traversal-shaped fragments never match.
 * Path segments are zero-or-more so a top-level filename in prose
 * (`update README.md`) is recognised; any filesystem shape with `/`
 * separators is also recognised.
 *
 * Constructed fresh per call to avoid the global-flag `lastIndex`
 * stateful-cursor pitfall: a stateful regex shared across calls
 * carries lastIndex between executions and produces wrong results on
 * re-entry. A local instance per call is correctness over a
 * micro-optimisation.
 */
function buildBodyPathRegex(): RegExp {
  // Leading char class allows `.` so dot-prefixed paths like
  // `.github/workflows/ci.yml`, `.eslintrc.cjs`, `.changeset/foo.md`
  // are extracted. The negative lookbehind still blocks matches
  // adjacent to a word char or `/`; a leading dot is allowed at the
  // start of a token because the lookbehind is anchored to the
  // PRECEDING char, not the captured first char.
  return new RegExp(
    `(?<![A-Za-z0-9_\\/])([.A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\\/[A-Za-z0-9_.-]+)*\\.(?:${PATH_EXT_ALLOWLIST}))\\b`,
    'g',
  );
}

/**
 * Strip a unified-diff `a/` or `b/` prefix when the remaining string
 * still contains a `/` separator. Keeps a legitimate top-level
 * directory named `a` or `b` (e.g. `a/index.md`) from being collapsed
 * to a leaf-only path. Mirrors git semantics: an embedded diff hunk
 * naming `a/foo.ts` and `b/foo.ts` should fold to the bare `foo.ts`
 * so the drafter's path-scope check aligns with the actual diff
 * target.
 */
function stripDiffPrefix(path: string): string {
  const isDiffPrefix = path.startsWith('a/') || path.startsWith('b/');
  if (!isDiffPrefix) return path;
  const stripped = path.slice(2);
  return stripped.includes('/') ? stripped : path;
}

/**
 * Reject paths whose segments contain `..` or `.` traversal markers.
 * Defense-in-depth: even though the lookbehind blocks fragments
 * starting adjacent to `.`, a multi-segment traversal could still
 * appear (`a/../b.ts`). The traversal guard is the third independent
 * line of defence (lookbehind + per-segment guard + reader sandbox).
 */
function hasTraversalSegment(path: string): boolean {
  for (const seg of path.split('/')) {
    if (seg === '..' || seg === '.') return true;
  }
  return false;
}

/**
 * Walk a string and return the deduplicated, order-stable set of
 * filesystem-shaped tokens it mentions. The shared low-level primitive
 * used by both the schema-narrow walker (extractBodyPaths) and the
 * drafter-broad walker (extractTargetPathsFromProse). The list is
 * order-stable to first occurrence so callers depending on
 * deterministic DATA-hash behaviour in fixtures see a stable order.
 *
 * Path-traversal-safe: `..` / `.` segments are dropped; the lookbehind
 * blocks fragments adjacent to a word char / slash / dot.
 *
 * Diff-prefix-aware: `a/foo.ts` and `b/foo.ts` fold to `foo.ts` when
 * the stripped path still contains a `/`, mirroring git semantics for
 * embedded diff hunks.
 */
export function extractFsShapedTokens(text: string): ReadonlyArray<string> {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = buildBodyPathRegex();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const captured = m[1];
    if (captured === undefined) continue;
    const folded = stripDiffPrefix(captured);
    if (hasTraversalSegment(folded)) continue;
    if (!seen.has(folded)) {
      seen.add(folded);
      out.push(folded);
    }
  }
  return out;
}

/**
 * Pattern matching the start of a "Concrete steps" entry in a plan
 * body:
 *
 *   1. **<exact action>** - <file path>:<line range if known>
 *   2. **<exact action>** - ...
 *
 * Anchored at start-of-line, optional leading whitespace, an integer
 * step number, dot, whitespace, bolded action label, separator dash
 * surrounded by whitespace. Captures everything AFTER the dash on the
 * same line (the step body's first line) so the narrow walker scans
 * only the path target, not the entire surrounding markdown body
 * (Why this, alternatives_rejected prose, code-fence content, etc.).
 *
 * Deliberately conservative: a step line that lacks the bolded action
 * label or the dash separator is treated as prose and skipped. The
 * adapter-side guidance enforces the marker shape; plans that drift
 * from it produce no schema-flagged paths and the schema lets such
 * bodies through without a false-positive completeness check.
 */
const STEP_TARGET_LINE_RE = /^[ \t]*\d+\.[ \t]+\*\*[^*\n]+\*\*[ \t]+-[ \t]+(.+)$/gm;

/**
 * Walk a plan body's "Concrete steps" entries and return the set of
 * filesystem-shaped tokens declared as step targets, deduplicated and
 * order-stable to first occurrence.
 *
 * NARROW vs BROAD: paths in step-target position (the bolded numbered
 * step pattern) are the plan's deliverables; paths in surrounding
 * prose (Why this, context paragraphs, alternatives_rejected reasons)
 * are read-only context references that are NOT deliverables. The
 * schema's target_paths completeness fence MUST NOT flag prose-only
 * mentions, or it generates a false-positive friction the adapter-
 * side guidance explicitly contradicts. This narrow walker scans ONLY
 * the step-target lines so the schema fences exactly the deliverable
 * set.
 *
 * The broad walker `extractFsShapedTokens` remains the right primitive
 * for the drafter's fallback when `meta.target_paths` is unset and the
 * plan content is freeform prose without the step-bolded shape.
 *
 * Exported for the parity test that walks the same shape independently
 * across the three call sites that touched the same regex pre-refactor;
 * the schema's planEntrySchema refinement uses this helper.
 */
export function extractBodyPaths(body: string): ReadonlyArray<string> {
  const seen = new Set<string>();
  const out: string[] = [];
  // Walk every matching step-target line in the body, then run the
  // broad token extractor on the captured tail (everything after the
  // dash separator). Local regex per call to avoid global-flag
  // lastIndex carryover; STEP_TARGET_LINE_RE itself is constructed
  // with the multiline + global flags above, but reset before each
  // call so re-entry on a fresh body starts at offset 0.
  STEP_TARGET_LINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STEP_TARGET_LINE_RE.exec(body)) !== null) {
    const tail = m[1];
    if (tail === undefined) continue;
    for (const path of extractFsShapedTokens(tail)) {
      if (!seen.has(path)) {
        seen.add(path);
        out.push(path);
      }
    }
  }
  return out;
}

/**
 * Re-export of `stripDiffPrefix` so callers that need to compare a
 * declared `target_paths` entry against a body-extracted path under
 * the same diff-prefix-stripping semantics can do so without
 * re-implementing the helper. Used by the schema refinement to fold
 * a `target_paths` entry of `a/foo.ts` to the bare `foo.ts` when
 * comparing against the body-extracted set.
 */
export { stripDiffPrefix };
