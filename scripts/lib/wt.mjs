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
      if (line.startsWith('worktree ')) rec.path = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) rec.head = line.slice('HEAD '.length);
      else if (line.startsWith('branch ')) rec.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
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
  if (now - lastCommitMs > thresholdMs) reasons.push('no commits for 14+ days');
  if (now - notesMtimeMs > thresholdMs) reasons.push('NOTES.md untouched for 14+ days');
  if (branchMerged) reasons.push('branch merged to main');
  if (prClosed) reasons.push('PR closed');
  return { stale: reasons.length > 0, reasons };
}

const PACKAGE_MANAGERS = [
  { file: 'package.json', tool: 'npm', install: 'npm install' },
  { file: 'Cargo.toml', tool: 'cargo', install: 'cargo build' },
  { file: 'pyproject.toml', tool: 'poetry', install: 'poetry install' },
  { file: 'go.mod', tool: 'go', install: 'go mod download' },
];

/**
 * Auto-detect package manager from root directory files.
 * Returns { tool, install } on match, null if none found.
 * Prefers first match in precedence order: npm > cargo > poetry > go.
 */
export function detectPackageManager(rootFiles) {
  const set = new Set(rootFiles);
  for (const pm of PACKAGE_MANAGERS) {
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
