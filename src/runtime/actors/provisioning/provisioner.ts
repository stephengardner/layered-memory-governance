/**
 * Actor provisioning orchestrator.
 *
 * Steps, per unprovisioned role:
 *   1. Risk-assess. If high-risk, ask the operator via the provided
 *      `approveHighRisk` callback (typically a Telegram approval or a
 *      terminal prompt). If the callback rejects, skip this role.
 *   2. Start a localhost callback server bound to a random port and an
 *      unguessable state token.
 *   3. Build the GitHub App Manifest URL and hand it to the caller's
 *      `openBrowser` callback (which typically exec's `start` / `open`).
 *   4. Await the callback; exchange the returned code for App credentials.
 *   5. Write {appId, slug, owner, pem} to the credentials store.
 *   6. Optionally remind the operator to install the App on their repo.
 *
 * The orchestrator is pure business logic; all I/O is injectable so
 * tests can drive the full flow without touching the network.
 */

import { randomBytes } from 'node:crypto';
import type { RoleDefinition } from './schema.js';
import { assessRoleRisk } from './risk-assessor.js';
import type { RiskAssessment } from './risk-assessor.js';
import { startCallbackServer } from './callback-server.js';
import type { CredentialsStore } from './credentials-store.js';
import { convertManifestCode } from '../../../external/github-app/app-client.js';

export interface ProvisionRoleRequest {
  readonly role: RoleDefinition;
  readonly store: CredentialsStore;
  /**
   * Called when the role is high-risk; must resolve true to proceed,
   * false to skip. Typical impl: Telegram ask + wait for reply.
   */
  readonly approveHighRisk: (
    role: RoleDefinition,
    risk: RiskAssessment,
  ) => Promise<boolean>;
  /**
   * Called with the manifest URL so the caller can open it in a
   * browser. Most implementations run `open` / `xdg-open` / `start`.
   */
  readonly openBrowser: (url: string) => Promise<void> | void;
  /** Optional. For logging + telemetry. */
  readonly log?: (line: string) => void;
  /** Optional. For verbose progress during long waits. */
  readonly onProgress?: (stage: string) => void;
  /** Injectable transport for tests. */
  readonly fetchImpl?: typeof fetch;
  /** Callback server timeout. Default 10 min. */
  readonly timeoutMs?: number;
}

export type ProvisionOutcome =
  | { readonly kind: 'already-provisioned'; readonly role: string }
  | { readonly kind: 'skipped-by-operator'; readonly role: string; readonly reason: string }
  | { readonly kind: 'provisioned'; readonly role: string; readonly appId: number; readonly slug: string; readonly owner: string }
  | { readonly kind: 'failed'; readonly role: string; readonly error: string };

export async function provisionRole(req: ProvisionRoleRequest): Promise<ProvisionOutcome> {
  const log = req.log ?? (() => {});
  const progress = req.onProgress ?? (() => {});

  if (req.store.exists(req.role.name)) {
    log(`[${req.role.name}] already provisioned; skipping`);
    return { kind: 'already-provisioned', role: req.role.name };
  }

  const risk = assessRoleRisk(req.role);
  log(`[${req.role.name}] risk=${risk.level}${risk.reasons.length > 0 ? ': ' + risk.reasons.join(', ') : ''}`);

  if (risk.level === 'high') {
    progress('awaiting-approval');
    const ok = await req.approveHighRisk(req.role, risk);
    if (!ok) {
      return {
        kind: 'skipped-by-operator',
        role: req.role.name,
        reason: 'high-risk role approval denied',
      };
    }
  }

  const state = randomBytes(16).toString('hex');
  progress('starting-callback-server');

  // Build the manifest lazily (after the server binds and knows its
  // port) so `url` / `redirect_url` point at the actual callback URL.
  const callback = await startCallbackServer({
    expectedState: state,
    successLabel: req.role.displayName,
    buildManifestJson: (redirectUrl) => JSON.stringify({
      name: req.role.displayName,
      url: redirectUrl,
      redirect_url: redirectUrl,
      description: req.role.description,
      public: false,
      default_permissions: req.role.permissions,
      default_events: req.role.events,
    }),
    ...(req.role.organization ? { organization: req.role.organization } : {}),
    ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
  });

  log(`[${req.role.name}] callback listening at ${callback.redirectUrl}`);
  log(`[${req.role.name}] open this URL in a browser to approve:`);
  log(callback.startUrl);
  progress('opening-browser');
  try {
    await req.openBrowser(callback.startUrl);
  } catch (err) {
    log(`[${req.role.name}] openBrowser failed: ${(err as Error).message} (URL printed above)`);
  }

  progress('awaiting-callback');
  let result: { code: string; state: string };
  try {
    result = await callback.awaitCallback();
  } catch (err) {
    const msg = (err as Error).message;
    return { kind: 'failed', role: req.role.name, error: `callback: ${msg}` };
  }

  progress('exchanging-code');
  let conversion;
  try {
    conversion = await convertManifestCode(result.code, req.fetchImpl);
  } catch (err) {
    const msg = (err as Error).message;
    return { kind: 'failed', role: req.role.name, error: `conversion: ${msg}` };
  }

  progress('saving-credentials');
  try {
    await req.store.save(
      {
        role: req.role.name,
        appId: conversion.id,
        slug: conversion.slug,
        owner: conversion.owner.login,
        createdAt: new Date().toISOString(),
        description: req.role.description,
      },
      conversion.pem,
    );
  } catch (err) {
    const msg = (err as Error).message;
    return { kind: 'failed', role: req.role.name, error: `store.save: ${msg}` };
  }
  log(`[${req.role.name}] provisioned as ${conversion.slug} (app id ${conversion.id}) under ${conversion.owner.login}`);

  return {
    kind: 'provisioned',
    role: req.role.name,
    appId: conversion.id,
    slug: conversion.slug,
    owner: conversion.owner.login,
  };
}
