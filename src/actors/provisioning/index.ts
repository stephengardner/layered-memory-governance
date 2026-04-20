/**
 * Actor provisioning subsystem (subpath: `/actors/provisioning`).
 *
 * Reads a `roles.json` schema, provisions a distinct GitHub App per
 * Actor identity, and stores per-Actor credentials locally under
 * `.lag/apps/`. Once provisioned, an Actor can authenticate as its
 * own bot identity and open PRs, leave reviews, etc. as itself.
 *
 * Subpath import:
 *
 *   import {
 *     loadRoleRegistry,
 *     provisionRole,
 *     createCredentialsStore,
 *   } from 'layered-autonomous-governance/actors/provisioning';
 */

export { loadRoleRegistry, findRole } from './role-loader.js';
export {
  roleDefinitionSchema,
  roleRegistrySchema,
  rolePermissionsSchema,
} from './schema.js';
export type {
  RoleDefinition,
  RoleRegistry,
  RolePermissions,
} from './schema.js';

export { assessRoleRisk } from './risk-assessor.js';
export type { RiskAssessment, RiskLevel } from './risk-assessor.js';

export { buildManifestUrl } from './manifest-url.js';
export type { ManifestUrlInput } from './manifest-url.js';

export { startCallbackServer } from './callback-server.js';
export type {
  CallbackServerHandle,
  CallbackResult,
  StartCallbackServerOptions,
} from './callback-server.js';

export { createCredentialsStore } from './credentials-store.js';
export type {
  AppCredentialsRecord,
  CredentialsStore,
} from './credentials-store.js';

export { provisionRole } from './provisioner.js';
export type {
  ProvisionRoleRequest,
  ProvisionOutcome,
} from './provisioner.js';
