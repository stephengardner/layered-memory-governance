// scripts/lib/wt.mjs - pure helpers for scripts/wt.mjs.
// Zero imports from src/, dist/, or .lag/ (enforced by wt.portability.test.ts in a later task).

/**
 * Validate a worktree slug. Returns { ok: true, slug } on success (with
 * normalized form) or { ok: false, reason } on failure.
 *
 * Rules:
 *   - 1-40 chars
 *   - lowercase after normalization
 *   - only [a-z0-9-]
 *   - no leading/trailing dash
 */
export function validateSlug(input) {
  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, reason: 'slug is required' };
  }
  const normalized = input.toLowerCase();
  if (normalized.length > 40) {
    return { ok: false, reason: `slug too long (${normalized.length} > 40 chars)` };
  }
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(normalized)) {
    return {
      ok: false,
      reason: 'slug must be [a-z0-9-], no leading/trailing dash, no spaces or slashes',
    };
  }
  return { ok: true, slug: normalized };
}

/**
 * Parse `git worktree list --porcelain` output.
 * Returns array of { path, head, branch, detached } records.
 */
export function parseGitWorktreeList(output) {
  const blocks = output.split(/\r?\n\r?\n/).map(b => b.trim()).filter(Boolean);
  return blocks.map((block) => {
    const rec = { path: null, head: null, branch: null, detached: false };
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) rec.path = line.slice('worktree '.length).trim();
      else if (line.startsWith('HEAD ')) rec.head = line.slice('HEAD '.length).trim();
      else if (line.startsWith('branch ')) rec.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
      else if (line === 'detached') rec.detached = true;
    }
    return rec;
  });
}

/**
 * Decide whether a worktree is "active" based on injected signals.
 * Pure function: caller does the filesystem reads.
 *
 * Used by `wt new` and `wt list` to warn before creating a new worktree
 * on the same branch / slug, or before proposing to remove a worktree
 * someone else is mid-work in.
 */
export function detectActivity({
  headMtimeMs,
  indexMtimeMs,
  hasLockfile,
  dirty,
  now,
  windowMs,
}) {
  const reasons = [];
  if (now - headMtimeMs < windowMs) reasons.push('HEAD moved within activity window');
  if (now - indexMtimeMs < windowMs) reasons.push('index touched within activity window');
  if (hasLockfile) reasons.push('git lockfile present');
  if (dirty) reasons.push('uncommitted changes');
  return { active: reasons.length > 0, reasons };
}

/**
 * Detect whether a worktree is "stale" based on time and merge signals.
 * Pure function: caller resolves branch merge state, PR closed state, etc.
 *
 * Used by `wt list` and `wt clean` to identify candidates for removal.
 */
export function detectStale({
  lastCommitMs,
  notesMtimeMs,
  branchMerged,
  prClosed,
  now,
  thresholdMs,
}) {
  const reasons = [];
  // Reason strings reflect the actual threshold passed in so an operator
  // setting WT_STALE_DAYS=7 sees "7+ days", not a hardcoded "14+". Use
  // ceil so a sub-day threshold rounds up to 1 and the user-facing
  // message always has a concrete integer.
  const days = Math.max(1, Math.ceil(thresholdMs / (24 * 60 * 60 * 1000)));
  if (now - lastCommitMs > thresholdMs) reasons.push(`no commits for ${days}+ days`);
  if (now - notesMtimeMs > thresholdMs) reasons.push(`NOTES.md untouched for ${days}+ days`);
  if (branchMerged) reasons.push('branch merged to main');
  if (prClosed) reasons.push('PR closed');
  return { stale: reasons.length > 0, reasons };
}

/**
 * Lockfile precedence: the presence of a non-npm lockfile is a strong
 * signal that running `npm install` would clobber the team's actual
 * package-manager state. Ordered most-specific first so Bun (bun.lockb)
 * wins over pnpm when both somehow exist.
 */
const LOCKFILES = [
  { file: 'bun.lockb', tool: 'bun', install: 'bun install' },
  { file: 'pnpm-lock.yaml', tool: 'pnpm', install: 'pnpm install' },
  { file: 'yarn.lock', tool: 'yarn', install: 'yarn install' },
  { file: 'package-lock.json', tool: 'npm', install: 'npm install' },
];

/**
 * Non-JS manifest fallbacks. These do not collide with a package.json,
 * so a package.json that also has (e.g.) a pyproject.toml still routes
 * to npm (the JS lockfile / packageManager / package.json path takes
 * priority in detectPackageManager).
 */
const NON_JS_MANIFESTS = [
  { file: 'Cargo.toml', tool: 'cargo', install: 'cargo build' },
  { file: 'pyproject.toml', tool: 'poetry', install: 'poetry install' },
  { file: 'go.mod', tool: 'go', install: 'go mod download' },
];

/**
 * Auto-detect package manager from root directory files + optional
 * package.json content.
 *
 * Priority:
 *   1. Lockfile presence (bun.lockb > pnpm-lock.yaml > yarn.lock >
 *      package-lock.json) - strongest signal of the team's actual tool.
 *   2. `packageManager` field in package.json (Corepack convention) -
 *      authoritative when declared, and lockfile-free repos use it.
 *   3. package.json without either of the above - fall back to npm.
 *   4. Non-JS manifest (Cargo.toml / pyproject.toml / go.mod).
 *
 * The old behavior (unconditional `npm install` on any package.json)
 * silently rewrote the lockfile of pnpm/yarn/bun repos, swapping
 * dependency resolutions. CR #128 flagged this as an adoption blocker
 * for any small/mid team outside this repo.
 *
 * @param rootFiles - file names present at the worktree root.
 * @param packageJsonContent - optional string contents of package.json,
 *   parsed to read `packageManager`. When undefined or unparseable,
 *   priority 2 is skipped.
 * @returns { tool, install } on match, null if none found.
 */
export function detectPackageManager(rootFiles, packageJsonContent) {
  const set = new Set(rootFiles);

  // 1. Lockfile wins: it names the tool the team actually uses.
  for (const lf of LOCKFILES) {
    if (set.has(lf.file)) return { tool: lf.tool, install: lf.install };
  }

  // 2. Corepack `packageManager` field. Only consulted if a
  //    package.json exists.
  if (set.has('package.json') && typeof packageJsonContent === 'string') {
    try {
      const pkg = JSON.parse(packageJsonContent);
      const pm = typeof pkg.packageManager === 'string' ? pkg.packageManager : null;
      if (pm) {
        // Corepack format is `<tool>@<version>[+<hash>]`; we only
        // need the tool name. Fall back to npm on unrecognized tool
        // rather than silently skip, since an unknown string is still
        // stronger signal than absence of it.
        const tool = pm.split('@')[0];
        if (tool === 'pnpm') return { tool: 'pnpm', install: 'pnpm install' };
        if (tool === 'yarn') return { tool: 'yarn', install: 'yarn install' };
        if (tool === 'bun') return { tool: 'bun', install: 'bun install' };
        if (tool === 'npm') return { tool: 'npm', install: 'npm install' };
      }
    } catch {
      // Malformed package.json - fall through to priority 3.
    }
  }

  // 3. Plain package.json with no other signal - npm is the safe
  //    default (npm ships with Node, so it is always available).
  if (set.has('package.json')) {
    return { tool: 'npm', install: 'npm install' };
  }

  // 4. Non-JS manifests.
  for (const pm of NON_JS_MANIFESTS) {
    if (set.has(pm.file)) return { tool: pm.tool, install: pm.install };
  }
  return null;
}

/**
 * Render the NOTES.md skeleton for a new worktree.
 * Returns a markdown template with placeholders filled in.
 */
export function renderNotesSkeleton({ slug, baseLabel, baseSha }) {
  return `# ${slug}

**Intent** (1 line: what this worktree exists to do)
**Branched off:** ${baseLabel} @ ${baseSha}
**PR:** (pending)

## Open threads
- [ ] (what's in flight)

## Decisions this worktree
- (record non-obvious choices as you make them)

## Next pick-up
If a fresh agent opens this worktree: (first action)
`;
}
