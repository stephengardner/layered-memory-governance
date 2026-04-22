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
export function countChangedFilesAgainstBase(base, deps = {}) {
  const run = deps.execaSync ?? execaSync;
  const candidates = [`origin/${base}`, base];
  for (const ref of candidates) {
    const verify = run('git', ['rev-parse', '--verify', ref], { reject: false });
    if (verify.exitCode !== 0) continue;
    const diff = run('git', ['diff', '--name-only', `${ref}...HEAD`], { reject: false });
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
