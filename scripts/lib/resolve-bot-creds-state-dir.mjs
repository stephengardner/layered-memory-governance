// Walk-up resolver for the `.lag` state directory that holds bot creds.
//
// Why this exists
// ---------------
// Bot-identity wrappers (scripts/gh-as.mjs, scripts/git-as.mjs,
// scripts/gh-token-for.mjs) load App credentials from
// `<stateDir>/apps/<role>.json` plus `<stateDir>/apps/keys/
// <role>.pem`. The stateDir is computed via `resolveStateDir`,
// which honors `LAG_STATE_DIR` or defaults to `<repoRoot>/.lag`.
// That covers the indie default and the org-ceiling env-override
// path, but it does NOT cover a third case: an agent-dispatched
// worktree.
//
// When a sub-agent harness creates a fresh worktree (e.g. at
// `<primaryRepo>/.claude/worktrees/agent-<id>/`) without copying
// `.lag/apps/`, the wrapper's resolved stateDir for that worktree
// is the worktree itself, but the worktree has no creds in it. The
// wrapper exits with "no credentials for role '<role>'" before the
// sub-agent can take a single bot-attributed action. The workaround
// until now has been a manual `cp -r` baked into every dispatch
// prompt -- a per-flow rule rather than a substrate-enforced
// behaviour.
//
// The fix is structural: when `LAG_STATE_DIR` is NOT set AND the
// resolved stateDir does not contain `apps/<role>.json`, walk up
// parent directories until a `.lag` directory holding creds for
// THIS role is found, or until the filesystem root is reached. The
// primary checkout (one level above `.claude/worktrees/`) almost
// always has the creds; finding them there means a sub-agent
// worktree inherits the parent's identity without any manual copy.
//
// Indie default unchanged
// -----------------------
// A solo developer running with `.lag/apps/` directly inside the
// repo root resolves on the FIRST candidate (no walk-up). The
// behaviour matches the pre-fix path.
//
// Org-ceiling override unchanged
// ------------------------------
// `LAG_STATE_DIR=...` is an explicit operator override; walk-up
// skips entirely and the supplied path is returned as-is. The
// downstream loader then fails loudly if the override points at a
// directory without creds, which is the right semantic ("operator
// said use this path; this path is wrong").
//
// Fallback on no hit
// ------------------
// When walk-up reaches the filesystem root without finding the
// role's creds, the resolver returns the original (un-walked)
// stateDir so the downstream "no credentials for role '<role>'"
// error still points the operator at the conventional location.
//
// Security
// --------
// Role names are validated against the same `SAFE_ROLE_NAME` regex
// the credentials-store enforces. Names containing `/`, `..`, `\`,
// or path separators are rejected loudly rather than allowed to
// traverse the filesystem.

import path from 'node:path';
import { existsSync } from 'node:fs';

// Mirrors SAFE_ROLE_NAME in
// src/runtime/actors/provisioning/credentials-store.ts. Duplicated
// (rather than imported) because this helper is a thin .mjs that
// runs before dist/ is loaded and must stay zero-dep.
const SAFE_ROLE_NAME = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

/**
 * Validate a role name against the same regex
 * `credentials-store.assertSafeRole` enforces. Throws on any name
 * that could traverse outside the apps directory.
 */
export function assertSafeRoleForResolution(role) {
  if (typeof role !== 'string' || !SAFE_ROLE_NAME.test(role)) {
    throw new Error(
      `resolve-bot-creds-state-dir: unsafe role name ${JSON.stringify(role)} `
      + `(must match ${SAFE_ROLE_NAME})`,
    );
  }
}

/**
 * Resolve the `.lag` state directory containing
 * `apps/<role>.json` + `apps/keys/<role>.pem`, with a walk-up
 * fallback when the conventional path is missing.
 *
 * Composition with `resolveStateDir`:
 *   - When `LAG_STATE_DIR` is set, `resolveStateDir` already
 *     returned an explicit operator-chosen path. This helper
 *     respects that override and does NOT walk up.
 *   - When `LAG_STATE_DIR` is unset, the supplied stateDir is the
 *     conventional `<repoRoot>/.lag`. If that path lacks
 *     `apps/<role>.json`, walk up parent directories to find the
 *     nearest ancestor whose `.lag/apps/<role>.json` exists.
 *
 * @param {string} stateDir - the conventional state dir
 *   (typically the return value of `resolveStateDir(repoRoot)`).
 * @param {string} role - the role name (validated).
 * @param {object} [opts]
 * @param {string} [opts.env] - the `LAG_STATE_DIR` env value to
 *   consider an operator override. When non-empty, walk-up is
 *   skipped. Defaults to `process.env.LAG_STATE_DIR`.
 * @returns {string} absolute path to the resolved `.lag` directory.
 */
export function resolveBotCredsStateDir(stateDir, role, opts = {}) {
  assertSafeRoleForResolution(role);
  if (typeof stateDir !== 'string' || stateDir.length === 0) {
    throw new Error(
      'resolve-bot-creds-state-dir: stateDir must be a non-empty string',
    );
  }
  const envValue = opts.env !== undefined ? opts.env : process.env.LAG_STATE_DIR;
  // Operator override is binding; do not silently traverse.
  if (typeof envValue === 'string' && envValue.length > 0) {
    return stateDir;
  }
  // First-hit short-circuit: if the supplied stateDir already has
  // creds for this role, return it without any walk-up traversal.
  if (existsSync(path.join(stateDir, 'apps', `${role}.json`))) {
    return stateDir;
  }
  // Walk up. The starting directory for the walk is the PARENT of
  // the supplied stateDir, treated as a `.lag/` directory: we look
  // for `<parentDir>/.lag/apps/<role>.json` at each level. Stop on
  // filesystem-root fixed point.
  let dir = path.dirname(stateDir);
  while (true) {
    const candidate = path.join(dir, '.lag', 'apps', `${role}.json`);
    if (existsSync(candidate)) {
      return path.join(dir, '.lag');
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      // No hit; return the original stateDir so the downstream
      // loader produces a conventional-path error message.
      return stateDir;
    }
    dir = parent;
  }
}
