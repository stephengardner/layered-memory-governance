import path from 'node:path';

/**
 * Resolve the LAG state directory.
 *
 * Honors LAG_STATE_DIR env var when set; otherwise falls back to
 * <repoRoot>/.lag. Mirrors the env-aware shape used in the codebase
 * so every bootstrap, runner, and helper converges on one resolution.
 *
 * Indie-floor default (env unset) keeps the in-repo .lag/ path that
 * a solo developer expects. Org-ceiling deployments point every
 * subprocess at the same shared dir by setting LAG_STATE_DIR once.
 *
 * Empty-string LAG_STATE_DIR is treated as unset (typical shell-export
 * accident shape: `LAG_STATE_DIR= node scripts/...`).
 */
export function resolveStateDir(repoRoot) {
  const envValue = process.env.LAG_STATE_DIR;
  if (typeof envValue === 'string' && envValue.length > 0) {
    return path.resolve(envValue);
  }
  return path.join(repoRoot, '.lag');
}
