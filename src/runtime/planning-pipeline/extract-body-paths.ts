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
 * First-segment names whose paths are gitignored / build-output / tool-
 * cache-shaped. Such paths are NEVER plan deliverables: they are runtime
 * import targets (`dist/...`), tool-cache (`.vitest-cache/...`), or
 * untracked workspace state (`.lag/atoms/...`). A plan that mentions
 * `dist/adapters/file/index.js` in a step-body is referencing the
 * RUNTIME target of a build output, not declaring a deliverable. Both
 * the schema-narrow walker (Form-A completeness check) and the drafter-
 * broad walker (target_paths fallback) MUST skip these so the LLM does
 * not get fenced for an "unlisted" body path that was always read-only.
 *
 * Conservative + concrete: extend only when a real dogfeed surfaces a
 * legitimate gitignored-shape that should be scoped out. The list is
 * the union of build outputs (dist, build, out, .next), dependency
 * caches (node_modules, .vitest-cache, coverage, .cache), and LAG-
 * specific transient state (.lag, .git). A first-segment match is
 * sufficient because nesting under any of these implies the same
 * read-only-import-target semantics.
 */
const GITIGNORED_FIRST_SEGMENTS: ReadonlySet<string> = new Set([
  'dist',
  'build',
  'out',
  '.next',
  'node_modules',
  'coverage',
  '.vitest-cache',
  '.cache',
  '.lag',
  '.git',
]);

/**
 * Return true when the path's first segment is gitignored / build-shape
 * / tool-cache-shape, and therefore not a plan deliverable. Exported
 * so the schema's bare-filename and Form-A guards can apply the same
 * filter the body walker uses.
 */
export function isGitignoredFirstSegment(path: string): boolean {
  const firstSeg = path.split('/')[0];
  return firstSeg !== undefined && GITIGNORED_FIRST_SEGMENTS.has(firstSeg);
}

/**
 * Repo-root bare-filename allowlist. Files in this set are well-known
 * top-level configuration / metadata files that legitimately live at
 * the repo root with no directory prefix. The plan-stage schema's
 * bare-filename guard rejects entries WITHOUT a `/` separator to stop
 * the LLM from creating files at repo root accidentally (e.g. a leaf-
 * only `header.spec.ts` would resolve to `<repoDir>/header.spec.ts`,
 * almost never the intent). But `package.json`, `README.md`, and the
 * config-file family genuinely live at repo root, so the guard would
 * false-positive on the legitimate case. Allowlisting closes the gap
 * the 2026-05-08 dogfeed surfaced when a tooling-envelope plan needed
 * to update `package.json` and the schema rejected it as bare.
 */
const REPO_ROOT_BARE_ALLOWLIST: ReadonlySet<string> = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'CLAUDE.md',
  '.gitignore',
  '.gitattributes',
  '.npmrc',
  '.nvmrc',
  '.node-version',
  '.env.example',
  '.editorconfig',
  '.prettierrc',
  '.prettierrc.json',
  '.prettierignore',
  '.dockerignore',
  'Dockerfile',
  'Makefile',
  'biome.json',
]);

/**
 * Pattern allowlist for repo-root config files whose name varies (the
 * `tsconfig.<flavor>.json` / `vite.config.<ext>` / `.eslintrc.<ext>`
 * shapes). Each pattern matches a single canonical config name; this
 * is deliberately narrow so a confused LLM emitting `random.config.ts`
 * still trips the bare-filename guard, but the legitimate
 * `tsconfig.examples.json` / `vitest.config.ts` / `.eslintrc.cjs` shapes
 * pass.
 */
const REPO_ROOT_BARE_PATTERNS: ReadonlyArray<RegExp> = [
  /^tsconfig(\.[a-zA-Z0-9_-]+)?\.json$/,
  /^vite\.config\.(?:[mc]?[jt]s)$/,
  /^vitest\.config\.(?:[mc]?[jt]s)$/,
  /^webpack\.config\.(?:[mc]?[jt]s)$/,
  /^playwright\.config\.(?:[mc]?[jt]s)$/,
  /^rollup\.config\.(?:[mc]?[jt]s)$/,
  /^esbuild\.config\.(?:[mc]?[jt]s)$/,
  /^next\.config\.(?:[mc]?[jt]s)$/,
  /^postcss\.config\.(?:[mc]?[jt]s|json)$/,
  /^tailwind\.config\.(?:[mc]?[jt]s)$/,
  /^\.eslintrc\.(?:[mc]?[jt]s|json|yml|yaml)$/,
  /^\.eslintrc$/,
];

/**
 * Return true when the bare filename is a well-known repo-root file
 * whose lack of a directory separator is legitimate. The schema's
 * bare-filename guard calls this to allow `package.json` and the
 * config-file family while still rejecting the random leaf-only
 * shape that almost always indicates a confused LLM emission.
 */
export function isRepoRootAllowedBare(name: string): boolean {
  if (REPO_ROOT_BARE_ALLOWLIST.has(name)) return true;
  for (const re of REPO_ROOT_BARE_PATTERNS) {
    if (re.test(name)) return true;
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
    // A path like `dist/adapters/file/index.js` is a runtime import
    // target, not a deliverable. Filtering at this primitive layer
    // keeps both the narrow schema walker and the broad drafter
    // walker from treating gitignored shapes as targets the LLM
    // declared.
    if (isGitignoredFirstSegment(folded)) continue;
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
