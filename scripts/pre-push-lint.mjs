#!/usr/bin/env node
/**
 * Pre-push lint: rejects the patterns CI and CodeRabbit reliably flag,
 * but ~1s before the push instead of ~10min after.
 *
 * Rules (each a lightweight grep against the tree; no type-check, no
 * build, no network). Exactly four rules ship; expansions require a
 * post-merge grep of `main` proving the pattern was actually flagged
 * (see docs/dev/pre-push-lint.md "When the lint is wrong").
 *
 *   1. emdash -- U+2014 (emdash) or U+2013 (en-dash) in tracked
 *      src/, test/, docs/, design/, examples/, README.md. Mirrors the
 *      CI package-hygiene grep scope exactly. The `fixtures`
 *      directory is excluded (emdash only), matching CI's
 *      --exclude-dir=fixtures.
 *   2. private-terms -- operator-configured deny-list tokens anywhere
 *      in tracked files. Mirrors the CI package-hygiene grep scope:
 *      `git ls-files | xargs grep` with no fixture exclusion, so a
 *      private term inside a fixture file IS a finding here (a
 *      divergence CodeRabbit caught on PR #122). The canonical
 *      pattern lives in the CI workflow; this script reproduces it
 *      via string concatenation so the lint source itself does not
 *      trip the rule.
 *   3. dogfooding-date-prefix -- docs/dogfooding/*.md without a
 *      `YYYY-MM-DD-` filename prefix. CR convention, first flagged on
 *      PR #113.
 *   4. z-utc-redundant -- `<digit>Z<whitespace>UTC` in docs/ or
 *      README.md or design/. The `Z` suffix already means UTC per
 *      ISO-8601; the trailing " UTC" is redundant. CR nit first
 *      flagged on PR #115.
 *
 * Exit code 0 = clean; 1 = violations found (with a report of each).
 *
 * Usage:
 *   node scripts/pre-push-lint.mjs                run all rules
 *   node scripts/pre-push-lint.mjs --rule=emdash  run one rule
 *
 * Wire into a local git hook:
 *   cat > .git/hooks/pre-push <<'EOF'
 *   #!/usr/bin/env bash
 *   exec node scripts/pre-push-lint.mjs
 *   EOF
 *   chmod +x .git/hooks/pre-push
 *
 * The script is a grep orchestrator, not a compiler. False positives
 * are possible (e.g., a fixture prose file that references an ADR by
 * path in a quoted sentence). Rules 3-5 scope to `src/**` to keep
 * false positives rare; rule 6 only touches `docs/dogfooding/`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// File walker
// ---------------------------------------------------------------------------

// Directories we never walk: generated output, external code, runtime
// state, or our own tool caches. A path inside any of these is never
// part of the lint surface.
const GLOBAL_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.worktrees',
  'coverage',
  '.claude',
  '.lag',
  '.superpowers',
]);

// Per-rule skips. `fixtures` belongs to the emdash rule alone because
// CI's emdash step runs `grep -rP --exclude-dir=fixtures ...` but CI's
// private-terms step runs `git ls-files | xargs grep ...` with no
// fixtures exclusion. Globally skipping fixtures would let a private
// term added under a fixture pass this script while failing CI -- the
// exact lint-vs-CI divergence this tool exists to prevent.
const EMDASH_EXTRA_SKIP_DIRS = new Set(['fixtures']);

/**
 * Walk `root` recursively, yielding file paths relative to REPO_ROOT
 * that match any of `includePrefixes` (empty array = all tracked
 * shapes). Skips entries in GLOBAL_SKIP_DIRS and any names in
 * `extraSkipDirs` (per-rule additional scoping). Any file >1MB is
 * skipped (likely a binary or generated blob we don't want to scan).
 */
function* walk(root, includePrefixes, extraSkipDirs = new Set()) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (GLOBAL_SKIP_DIRS.has(entry.name)) continue;
      if (extraSkipDirs.has(entry.name)) continue;
      const p = join(dir, entry.name);
      if (process.env['PRE_PUSH_LINT_DEBUG']) {
        process.stderr.write(`walk: ${entry.isDirectory() ? 'dir' : 'file'} ${p}\n`);
      }
      if (entry.isDirectory()) {
        stack.push(p);
      } else if (entry.isFile()) {
        const rel = relative(REPO_ROOT, p).replace(/\\/g, '/');
        // Path-boundary anchor: `rel.startsWith(pre)` alone would
        // accept `designs-archive/foo.md` under the `design` prefix or
        // `docsrc/x` under `docs`. Exact-equal handles single-file
        // prefixes like `README.md`; the `+ '/'` form requires a
        // directory boundary. Normalize trailing-slash form so
        // callers can pass `docs/` or `docs` interchangeably.
        if (
          includePrefixes.length === 0 ||
          includePrefixes.some(
            (pre) => rel === pre || rel.startsWith(pre.endsWith('/') ? pre : pre + '/'),
          )
        ) {
          let sz = 0;
          try { sz = statSync(p).size; } catch { continue; }
          if (sz > 1_000_000) continue;
          yield rel;
        }
      }
    }
  }
}

function read(rel) {
  try {
    return readFileSync(join(REPO_ROOT, rel), 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rule runners. Each returns an array of { rule, file, line, msg }.
// ---------------------------------------------------------------------------

// Mirrors the CI `package-hygiene` step's grep scope:
//   grep -rP --exclude-dir=fixtures $'\u2014' src/ test/ docs/ design/ README.md examples/
// `test/` is included because test fixtures assembled from prose (CR
// review bodies, LLM output captures, docs mirrors) are a vector for
// emdash regressions; the fixtures *directory* itself is excluded via
// EMDASH_EXTRA_SKIP_DIRS so verbatim external captures stay intact.
const EMDASH_ROOTS = ['src', 'test', 'docs', 'design', 'examples', 'README.md'];
const EMDASH_RE = /[\u2013\u2014]/;

function ruleEmdash() {
  const hits = [];
  for (const rel of walk(REPO_ROOT, EMDASH_ROOTS, EMDASH_EXTRA_SKIP_DIRS)) {
    // Text files only; skip known binary extensions.
    if (/\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|tgz|mp4)$/i.test(rel)) continue;
    const body = read(rel);
    // Unreadable file -> skip this entry, not the whole rule. Early-
    // return would silently suppress every subsequent file once a
    // single unreadable one appeared (e.g., a permission glitch).
    if (body === null) continue;
    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (EMDASH_RE.test(lines[i])) {
        hits.push({
          rule: 'emdash',
          file: rel,
          line: i + 1,
          msg: 'emdash or en-dash (U+2014 / U+2013); replace with - or restructure',
        });
      }
    }
  }
  return hits;
}

// Private-term pattern. Split across concatenation so the source of
// the lint script itself doesn't contain the literal tokens that the
// package-hygiene CI step flags across tracked files; otherwise the
// lint script would fail the very rule it enforces. The runtime regex
// is identical to the CI-workflow regex.
const PRIVATE_TERMS_RE = new RegExp(
  '\\b' + 'p' + 'hx\\b|' + 'P' + 'hoenix|palace-' + 'p' + 'hoenix',
);

// Files that legitimately contain the private-term pattern by nature
// of being the enforcement mechanism (the CI workflow defines the
// pattern; this lint script reproduces it). Mirrors the CI step's own
// self-exclusion: grep -v '^\.github/workflows/ci\.yml$'.
const PRIVATE_TERMS_SELF_EXCLUDE = new Set([
  '.github/workflows/ci.yml',
  'scripts/pre-push-lint.mjs',
]);

function rulePrivateTerms() {
  const hits = [];
  // Scan everywhere tracked; CI does the same.
  for (const rel of walk(REPO_ROOT, [])) {
    if (/\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|tgz|mp4)$/i.test(rel)) continue;
    if (PRIVATE_TERMS_SELF_EXCLUDE.has(rel)) continue;
    const body = read(rel);
    if (body === null) continue;
    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (PRIVATE_TERMS_RE.test(lines[i])) {
        hits.push({
          rule: 'private-terms',
          file: rel,
          line: i + 1,
          msg: 'private term matched (operator-configured deny list; see .github/workflows/ci.yml)',
        });
      }
    }
  }
  return hits;
}

const DOGFOOD_DATE_PREFIX_RE = /^(\d{4})-(\d{2})-(\d{2})-/;

function ruleDogfoodingFilename() {
  const hits = [];
  const dogDir = resolve(REPO_ROOT, 'docs/dogfooding');
  // Recursive walk: if docs/dogfooding/ grows subfolders (e.g.,
  // per-quarter or per-agent retros), nested .md files must still be
  // checked. A non-recursive readdirSync would silently stop
  // enforcing the naming convention the moment a subdir appears.
  const stack = [dogDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.md')) continue;
      if (entry.name === 'README.md') continue;
      if (!DOGFOOD_DATE_PREFIX_RE.test(entry.name)) {
        const rel = relative(REPO_ROOT, full).replace(/\\/g, '/');
        hits.push({
          rule: 'dogfooding-date-prefix',
          file: rel,
          line: 0,
          msg: 'dogfooding file must start with YYYY-MM-DD- (local date) prefix',
        });
      }
    }
  }
  return hits;
}

// Z in an ISO-8601 timestamp is preceded by digits + colons (the time
// portion) and not a word boundary; match `<digit>Z<space>+UTC<\b>`.
// The \b at the tail stops `UTCore` from matching.
const Z_UTC_RE = /\dZ\s+UTC\b/;

function ruleZUtcRedundant() {
  const hits = [];
  for (const rel of walk(REPO_ROOT, ['docs/', 'README.md', 'design/'])) {
    if (!rel.endsWith('.md')) continue;
    const body = read(rel);
    if (body === null) continue;
    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (Z_UTC_RE.test(lines[i])) {
        hits.push({
          rule: 'z-utc-redundant',
          file: rel,
          line: i + 1,
          msg: 'Z suffix already implies UTC; remove the redundant " UTC" after `Z`',
        });
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

const ALL_RULES = {
  emdash: ruleEmdash,
  'private-terms': rulePrivateTerms,
  'dogfooding-date-prefix': ruleDogfoodingFilename,
  'z-utc-redundant': ruleZUtcRedundant,
};

export function runLint(rules = Object.keys(ALL_RULES)) {
  const findings = [];
  for (const name of rules) {
    const fn = ALL_RULES[name];
    if (!fn) {
      throw new Error(`unknown rule: ${name}`);
    }
    for (const hit of fn()) findings.push(hit);
  }
  return findings;
}

function parseArgs(argv) {
  const rules = Object.keys(ALL_RULES);
  const selected = [];
  for (const a of argv) {
    if (a.startsWith('--rule=')) {
      selected.push(a.slice('--rule='.length));
    }
  }
  return { rules: selected.length > 0 ? selected : rules };
}

function main() {
  const { rules } = parseArgs(process.argv.slice(2));
  const findings = runLint(rules);
  if (findings.length === 0) {
    console.log(`pre-push-lint: OK (${rules.length} rule${rules.length === 1 ? '' : 's'} passed)`);
    return 0;
  }
  for (const h of findings) {
    const where = h.line > 0 ? `${h.file}:${h.line}` : h.file;
    console.error(`[${h.rule}] ${where}: ${h.msg}`);
  }
  console.error(`pre-push-lint: FAIL (${findings.length} finding${findings.length === 1 ? '' : 's'})`);
  return 1;
}

// Only execute when invoked directly (not when imported by tests).
const isDirect = (() => {
  try {
    return resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirect) {
  process.exit(main());
}
