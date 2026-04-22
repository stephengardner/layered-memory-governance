// Shared CodeRabbit file-review-limit precheck.
//
// CodeRabbit silently skips review when a PR exceeds its file-limit
// threshold. A skipped review posts no `CodeRabbit` commit status,
// which blocks merge via required-checks with no visible failure
// until an operator opens the PR. Fail fast at PR-create time so the
// author splits before a wasted round-trip.
//
// The authoritative gate is the CI workflow step "PR under CodeRabbit
// file-review limit" (runs on every PR push); this module is the
// local fast-fail so callers don't learn about the limit from CI.

import { execaSync } from 'execa';

export const CR_FILE_LIMIT = 150;
export const CR_FILE_LIMIT_ENV = 'LAG_SKIP_CR_FILE_LIMIT';

export function isPrCreateSubcommand(args) {
  return args[0] === 'pr' && args[1] === 'create';
}

// Extract `--base <branch>` / `-B <branch>` / `--base=<branch>` from
// the argv tail. Returns null when absent so callers can default.
export function parseBaseBranch(args) {
  for (let i = 2; i < args.length; i++) {
    const a = args[i];
    if (a === '--base' || a === '-B') return args[i + 1] ?? null;
    if (a.startsWith('--base=')) return a.slice('--base='.length);
  }
  return null;
}

// Resolve the changed-file count of HEAD vs the given base branch.
// Tries `origin/<base>` first (matches CI's comparison), falls back to
// the local `<base>` ref for the pre-push case where the operator
// hasn't fetched recently. Returns `{ count, ref }` on success or
// null when no candidate ref resolves (caller decides whether to block
// or skip the precheck).
//
// Uses two-dot diff (`ref HEAD`) rather than three-dot (`ref...HEAD`).
// Three-dot resolves to `git diff $(merge-base) HEAD` - "files changed
// on HEAD since it forked from ref" - which can undercount whenever
// origin/<base> has advanced past the fork point with unrelated
// commits. Two-dot is a direct tree-vs-tree compare and matches what
// CodeRabbit loads for review AND what the CI gate (ci.yml :: PR
// under CodeRabbit file-review limit) computes. The two gates MUST
// agree on counts for the same PR; a three-dot local gate that says
// "allow" while CI says "block" (or vice versa) defeats the
// fast-fail-mirror framing.
export function countChangedFilesAgainstBase(base, deps = {}) {
  const run = deps.execaSync ?? execaSync;
  const candidates = [`origin/${base}`, base];
  for (const ref of candidates) {
    const verify = run('git', ['rev-parse', '--verify', ref], { reject: false });
    if (verify.exitCode !== 0) continue;
    const diff = run('git', ['diff', '--name-only', ref, 'HEAD'], { reject: false });
    if (diff.exitCode !== 0) continue;
    const lines = diff.stdout.split('\n').filter((l) => l.length > 0);
    return { count: lines.length, ref };
  }
  return null;
}

// Pure decision function. Returns:
//   { action: 'skip', reason }   - not a pr-create, or env bypass set
//   { action: 'allow', count, ref } - under limit
//   { action: 'block', count, ref, limit } - over limit, caller exits
//   { action: 'warn',  reason } - couldn't resolve base; caller continues
export function decideCrFileLimit(ghArgs, options = {}) {
  const env = options.env ?? process.env;
  const limit = options.limit ?? CR_FILE_LIMIT;
  const counter = options.countChangedFiles ?? countChangedFilesAgainstBase;

  if (!isPrCreateSubcommand(ghArgs)) {
    return { action: 'skip', reason: 'not-pr-create' };
  }
  if (env[CR_FILE_LIMIT_ENV] === '1') {
    return { action: 'skip', reason: 'env-bypass' };
  }
  // Assumption: this repo's default branch is `main` (see ci.yml's
  // `push: branches: [main]`). For a reusable port of this module,
  // resolve via `git symbolic-ref refs/remotes/origin/HEAD` when
  // --base is absent; that's deferred until a consumer with a
  // non-main default branch shows up.
  const base = parseBaseBranch(ghArgs) ?? 'main';
  const result = counter(base);
  if (result === null) {
    return { action: 'warn', reason: `base-ref-not-found:${base}` };
  }
  if (result.count > limit) {
    return { action: 'block', count: result.count, ref: result.ref, limit };
  }
  return { action: 'allow', count: result.count, ref: result.ref };
}
