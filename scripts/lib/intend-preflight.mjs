// scripts/lib/intend-preflight.mjs - pure helpers for the intent pre-flight
// validator. Zero imports from src/, dist/, .lag/. Stateless pure functions
// only; the caller injects fs + repoRoot so unit tests pin behavior without
// touching the real filesystem.
//
// Why pre-flight: the CTO + brainstorm + spec pipeline stages have NO Read
// access at draft-time (their tool policy denies Bash/Edit/Write/WebFetch;
// Read/Grep/Glob are allowed but the LLM stages run as single-shot judgments
// without a tool loop today). An intent that cites a non-existent path is
// drafted-from-imagination from the first stage onward. The session pattern
// (Claude Code dispatching a sub-agent) avoids this because the dispatcher
// pre-greps; the pipeline needs the equivalent gate, applied at the only
// point the operator's authored intent text crosses from terminal to atom
// store. Halting BEFORE the atom write means a typo-fix is two seconds of
// re-typing instead of five minutes of brainstorm + spec budget burned at
// the spec-stage's critical-audit-finding.
//
// Conservative bias on false positives: a missed false positive (path that
// looks unreachable but is fine) wastes operator time re-running with
// --force-paths; a missed false negative (real bad path slipping through)
// re-fires the original gap. We err toward halting when in doubt.

import { access } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';

/**
 * Filesystem-shaped token regex. Captures groups like
 * `apps/console/README.md` and bare filenames like `README.md` ONLY when
 * paired with a known file extension. The leading lookbehind `(?<![A-Za-z0-9_/\\.])` blocks
 * matches that begin adjacent to a word char, slash, dot, or backslash --
 * stops `1.2.3` (version strings) and `prefix.txt` (within an identifier
 * shape) from anchoring at the wrong boundary.
 *
 * NOT a pure import from src/runtime/planning-pipeline/extract-body-paths.ts
 * because the preflight runs from the deployment shell (scripts/) with zero
 * imports from src/dist/.lag/. Per the substrate-not-prescription canon,
 * deployment scripts have a one-way border with src/. Drift between the two
 * regexes is a future-debug surface; the parity is covered by the test corpus
 * here (preflight rejects what the schema's extractor would) until we lift a
 * shared scripts/lib helper that both can import. Conservative + concrete:
 * extending the regex requires the test corpus update too, which is the right
 * cost to avoid silent drift.
 *
 * Path extensions (intentionally narrower than the schema's full list): the
 * preflight is a CITATION-shape check, not an emission-shape check. Operator-
 * authored intent prose can reference any source-tree path the brainstorm/
 * spec stage might ground its citations against; the extension set covers
 * source code (ts/tsx/js/jsx/mjs/cjs), config (json/yml/yaml/toml/cfg/ini),
 * markdown/docs (md), shell (sh), and stylesheets (css/scss). Less-common
 * shapes (Python, Go, Rust) are intentionally not in the preflight extractor
 * because LAG itself is TS/JS/MDX-shaped today; an operator referring to a
 * .py file would need --force-paths and the parser's narrow list stops false
 * positives on extension-shaped tokens in prose (`.com`, `.org`, `.dev`,
 * `1.0.0`). Extending the list is one of the obvious follow-up axes.
 */
const PATH_EXT = 'md|ts|tsx|js|jsx|mjs|cjs|json|yml|yaml|toml|cfg|ini|css|scss|html|sh';

function buildPathTokenRegex() {
  return new RegExp(
    `(?<![A-Za-z0-9_\\/.])([A-Za-z0-9_\\-.]+(?:\\/[A-Za-z0-9_\\-.]+)*\\.(?:${PATH_EXT}))(?![A-Za-z0-9])`,
    'g',
  );
}

/**
 * Repo-root bare-filename allowlist. Bare filenames (no `/` in the captured
 * token) almost always indicate either (a) one of these well-known top-level
 * files, in which case the preflight checks `<repoRoot>/<filename>`; or (b) a
 * leaf-only path the operator should disambiguate (`add header.spec.ts` --
 * which `header.spec.ts`?). We allow the well-known set and otherwise pass-
 * through; the existence check resolves against repo root regardless.
 *
 * Intentionally tighter than src/runtime/planning-pipeline/extract-body-paths.ts's
 * version (which has 20+ entries) because the preflight runs over operator
 * prose, not LLM-emitted plan bodies. Prose references to `pnpm-lock.yaml`
 * or `Dockerfile` are rare and a false-positive here is a low-friction
 * --force-paths bypass; the smaller set keeps the preflight conservative.
 */
const REPO_ROOT_BARE_ALLOWLIST = new Set([
  'README.md',
  'package.json',
  'package-lock.json',
  'CLAUDE.md',
  'LICENSE',
  'CHANGELOG.md',
  '.gitignore',
  '.gitattributes',
  '.env',
  '.env.example',
  '.env.local',
  '.editorconfig',
]);

const REPO_ROOT_BARE_PATTERNS = [
  /^tsconfig(?:\.[a-zA-Z0-9_-]+)?\.json$/,
  /^vite\.config\.(?:[mc]?[jt]s)$/,
  /^vitest\.config\.(?:[mc]?[jt]s)$/,
  /^playwright\.config\.(?:[mc]?[jt]s)$/,
  /^\.env\.[a-zA-Z0-9_-]+$/,
];

/**
 * Return true when a bare filename is a well-known top-level file we should
 * resolve at repo root. Bare names that are NOT in the allowlist still pass
 * through (caller resolves them at repo root regardless); the allowlist is
 * a positive signal that the path is intended to be at the root.
 */
export function isRepoRootBareName(name) {
  if (REPO_ROOT_BARE_ALLOWLIST.has(name)) return true;
  for (const re of REPO_ROOT_BARE_PATTERNS) {
    if (re.test(name)) return true;
  }
  return false;
}

/**
 * Verb heuristic: when a line in the request body says "create" / "new" /
 * "add" near a path token, the operator is declaring an intent to CREATE
 * that file, not citing an existing one. Skipping the check for that path
 * avoids false-positives on a legitimate "add new file foo/bar.ts" request.
 *
 * Conservative: the check looks for the verbs on the SAME line as the path.
 * Multi-line requests where the verb is two paragraphs above the path will
 * still trigger the preflight; the operator's recourse is --force-paths.
 * Anchoring to the line scope keeps the heuristic local and predictable.
 *
 * Exported for direct unit testing. The caller treats a true return as
 * "skip this path's existence check" rather than "fail the preflight".
 */
export function lineDeclaresCreateIntent(line) {
  // Word-boundary matched verbs so 'created', 'adding', 'creates' all match,
  // but 'newsletter', 'address', 'broadcast' (containing 'add' as a substring)
  // do not. Case-insensitive because operator prose is mixed-case.
  return /\b(?:create(?:s|d|ing)?|new(?:ly)?|add(?:s|ed|ing)?|introduce(?:s|d|ing)?|generate(?:s|d|ing)?)\b/i
    .test(line);
}

/**
 * Filter that rejects path-token captures that are actually parts of URLs.
 * The regex captures `example.com/foo.html` as a path-shaped token, but the
 * leading `https://example.com/` context means it's a URL not a repo path.
 * We check the captured token's surrounding 8 chars (left of match) for an
 * `://` substring: a URL match is preceded by `https://` or `http://` or any
 * scheme-shape; a real path match has whitespace, punctuation, or start-of-
 * line. The 8-char window covers `http://` (7 chars) and any reasonable
 * scheme prefix.
 *
 * Why not strip URLs at extraction time: the regex's negative lookbehind
 * already blocks adjacency to `/` and `.`, which catches most URL fragments.
 * This is a belt-and-suspenders second filter for cases where the URL ends
 * mid-line and the path-shape extends past the scheme (e.g. an absolute URL
 * with a query string).
 */
function isUrlContext(text, matchIndex) {
  const start = Math.max(0, matchIndex - 8);
  const slice = text.slice(start, matchIndex);
  return slice.includes('://');
}

/**
 * Extract path-shaped tokens from the request body. Returns an array of
 * { token, line, lineNumber, matchIndex } objects so the caller can apply
 * the create-verb heuristic against the originating line and surface a
 * line-anchored error message.
 *
 * Deduplicated by (token, line) so a single citation surfaces once even if
 * the regex's loop sees it twice (it shouldn't with the lookbehind, but the
 * dedupe is cheap insurance).
 */
export function extractCitedPaths(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  const out = [];
  const seen = new Set();
  let lineStart = 0;
  for (let lineNumber = 1; lineNumber <= lines.length; lineNumber += 1) {
    const line = lines[lineNumber - 1] ?? '';
    const re = buildPathTokenRegex();
    let m;
    while ((m = re.exec(line)) !== null) {
      const token = m[1];
      if (token === undefined) continue;
      // Filter URL context (https://example.com/foo.html etc).
      if (isUrlContext(line, m.index)) continue;
      const key = `${lineNumber}:${token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ token, line, lineNumber, matchIndex: lineStart + m.index });
    }
    lineStart += line.length + 1;
  }
  return out;
}

/**
 * Resolve a captured path against repo root. Bare filenames (no `/`)
 * resolve at the root regardless of whether they appear in the allowlist;
 * the allowlist informs whether the resolution is high-confidence. Slashed
 * paths resolve relative to the root as written.
 *
 * Returns the absolute path the existence check will probe.
 */
export function resolveCitedPath(token, repoRoot) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('resolveCitedPath: token must be a non-empty string');
  }
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new Error('resolveCitedPath: repoRoot must be a non-empty string');
  }
  return resolvePath(repoRoot, token);
}

/**
 * Async validator. Walks the request body, extracts path tokens, applies the
 * verb heuristic, and probes each remaining path against the filesystem via
 * `fs.access`. Returns `{ ok: true }` when every cited path exists OR is
 * skipped by the verb heuristic; `{ ok: false, missing: [...] }` when one or
 * more cited paths do not exist (and the create-intent heuristic did not
 * skip them).
 *
 * The `forcePaths` option emits warnings for missing paths but still returns
 * `{ ok: true }`; documented as the operator-facing "I know this path is new"
 * bypass. The `skipPreflight` option returns `{ ok: true }` without any
 * filesystem access; the caller documents this as the pure-bypass for cases
 * where the preflight is wrong.
 *
 * fs.access (not fs.stat) is the cheapest existence check and never throws
 * on permissions-mode mismatches when the default `mode` (F_OK) is used.
 * The Promise rejects with ENOENT when the path does not exist; we catch
 * and treat that as the missing case. Any other rejection (EACCES, EBUSY)
 * is propagated so the operator sees a real OS error instead of a silent
 * miss.
 *
 * Pure-function shape: caller passes { request, repoRoot, forcePaths,
 * skipPreflight, fsAccess }. The `fsAccess` injection point lets tests
 * stub the filesystem without touching node:fs/promises; the default is
 * the real one. Mirrors the spawn-node validator's "pure helper, optional
 * injection" shape so the unit tests can pin paths byte-for-byte.
 */
export async function runPreflight(opts) {
  const {
    request,
    repoRoot,
    forcePaths = false,
    skipPreflight = false,
    fsAccess = access,
  } = opts;
  if (typeof request !== 'string') {
    throw new Error('runPreflight: request must be a string');
  }
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new Error('runPreflight: repoRoot must be a non-empty string');
  }
  if (skipPreflight) {
    return { ok: true, skipped: true, warnings: [] };
  }
  const cited = extractCitedPaths(request);
  const missing = [];
  const checked = [];
  for (const { token, line, lineNumber } of cited) {
    // Verb heuristic: when the same line mentions create/new/add, skip the
    // existence check. The operator is declaring an intent to create the
    // file, not asserting it exists. False-positive bias is on halt-then-
    // bypass; the heuristic SHOULD be slightly conservative.
    if (lineDeclaresCreateIntent(line)) {
      checked.push({ token, line, lineNumber, status: 'skipped-create-intent' });
      continue;
    }
    const absolute = resolveCitedPath(token, repoRoot);
    try {
      await fsAccess(absolute);
      checked.push({ token, line, lineNumber, status: 'exists', absolute });
    } catch (err) {
      // Treat any access failure as "not reachable from operator's terminal";
      // the structured error captures the OS code for debugging when the
      // missing case is a permissions issue rather than a typo.
      const errCode = err && typeof err === 'object' && 'code' in err
        ? String(err.code)
        : 'EUNKNOWN';
      missing.push({ token, line, lineNumber, absolute, errCode });
    }
  }
  if (missing.length === 0) {
    return { ok: true, checked, warnings: [] };
  }
  if (forcePaths) {
    // forcePaths bypass: convert the would-be failure into warnings so the
    // operator sees what slipped past and the audit trail captures the
    // intentional override.
    return {
      ok: true,
      forced: true,
      checked,
      warnings: missing.map(m => ({
        token: m.token,
        line: m.line,
        lineNumber: m.lineNumber,
        absolute: m.absolute,
        errCode: m.errCode,
      })),
    };
  }
  return { ok: false, missing, checked };
}

/**
 * Build the structured human-readable error message the CLI prints on
 * preflight failure. Exported so tests pin the wording and so the
 * substrate-deep pipeline (if it ever wraps intend.mjs programmatically)
 * has access to the canonical format.
 *
 * One block per missing path: token, line, line-number, OS error code.
 * Trailing instructions describe both bypass mechanisms (--force-paths
 * for genuine create-intents and --skip-preflight for an operator
 * judgment that the preflight is wrong).
 */
export function formatPreflightError(missing) {
  if (!Array.isArray(missing) || missing.length === 0) {
    throw new Error('formatPreflightError: missing must be a non-empty array');
  }
  const lines = [
    '[intend] pre-flight FAILED: request body cites the following paths that do not exist at repo root:',
  ];
  for (const m of missing) {
    lines.push(
      `  - ${m.token} (line ${m.lineNumber}: ${m.errCode === 'ENOENT' ? 'no such file or directory' : `fs.access error ${m.errCode}`})`,
    );
  }
  lines.push(
    '',
    'Either correct the path in the request, use --force-paths to bypass this check for legitimate CREATE intents',
    '(substrate-purity warning: the pipeline will still halt at spec-stage on unreachable cites unless those',
    'paths exist when the spec stage runs), or use --skip-preflight to bypass entirely.',
  );
  return lines.join('\n');
}
