/**
 * Build a GitHub App Manifest URL.
 *
 * This is the URL the operator visits in a browser to approve creation
 * of the App under their account or organization. On approval, GitHub
 * POSTs to `redirect_url` with `?code=<code>&state=<state>` which
 * LAG's callback server intercepts. Docs:
 * https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
 *
 * Pure function; no I/O. Unit tests cover:
 *   - owner-less URL targets /settings/apps/new (personal account)
 *   - owner-set URL targets /organizations/<owner>/settings/apps/new
 *   - manifest object contains declared permissions and events
 *   - state is passed through unchanged
 */

import type { RoleDefinition } from './schema.js';

export interface ManifestUrlInput {
  readonly role: RoleDefinition;
  /** Base URL the operator will click on. Usually https://github.com */
  readonly githubBaseUrl?: string;
  /** Opaque token returned by GitHub on the callback for correlation. */
  readonly state: string;
  /** Where GitHub redirects after the operator approves the App. */
  readonly redirectUrl: string;
  /**
   * Whether the App should be created under a personal account (undef)
   * or a GitHub organization. For personal accounts leave undef and
   * GitHub creates the App under whoever is logged in at approval time.
   * For orgs, pass the org slug; `role.organization` is the authoritative
   * hint and this parameter overrides it when supplied.
   */
  readonly organization?: string;
  /** Setup URL shown post-install; optional. Defaults to redirectUrl. */
  readonly setupUrl?: string;
}

export function buildManifestUrl(input: ManifestUrlInput): string {
  const base = input.githubBaseUrl ?? 'https://github.com';
  // Only an explicit `organization` routes to the org-scoped creation
  // URL. For personal accounts, GitHub creates the App under whoever
  // is logged in to /settings/apps/new; `role.organization` is the
  // only authoritative hint.
  const org = input.organization ?? input.role.organization;

  const manifest = {
    name: input.role.displayName,
    url: input.setupUrl ?? input.redirectUrl,
    redirect_url: input.redirectUrl,
    description: input.role.description,
    public: false,
    default_permissions: input.role.permissions,
    default_events: input.role.events,
  };

  const path = org
    ? `/organizations/${encodeURIComponent(org)}/settings/apps/new`
    : `/settings/apps/new`;
  const params = new URLSearchParams({
    state: input.state,
    manifest: JSON.stringify(manifest),
  });
  return `${base}${path}?${params.toString()}`;
}
