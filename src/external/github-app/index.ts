/**
 * GitHub App integration (subpath: `/external/github-app`).
 *
 * Separate from `/external/github` (which wraps the `gh` CLI for user-
 * scoped calls) because App-scoped auth is a different identity model:
 *   - JWT signed by App private key -> installation access token
 *   - Calls are attributed to the App bot (e.g. `lag-cto-agent[bot]`)
 *   - Per-Actor credential isolation
 *
 * Zero-dep: JWT signed via `node:crypto`, transport via `fetch`.
 */

export {
  createAppJwt,
  fetchInstallationToken,
  InstallationTokenCache,
} from './app-auth.js';
export type { AppAuthOptions, InstallationToken } from './app-auth.js';

export {
  convertManifestCode,
  listAppInstallations,
  createAppAuthedFetch,
  openPullRequest,
  upsertFile,
  createBranch,
  getBranchSha,
} from './app-client.js';
export type {
  AppAuthedFetch,
  AppInstallation,
  AppManifestConversionResult,
} from './app-client.js';

export { createAppBackedGhClient } from './gh-client-adapter.js';
export type { AppBackedGhClientOptions } from './gh-client-adapter.js';
