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
