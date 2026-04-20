/**
 * Schema for declaring Actor identities on GitHub.
 *
 * A `RoleDefinition` names an Actor and declares the permissions it
 * needs. Permissions map 1:1 onto GitHub App permission keys; see
 * https://docs.github.com/en/rest/apps/permissions for the canonical
 * list. We surface only the subset our actors realistically need.
 *
 * The schema is intentionally small. Higher-level concerns (who can
 * create a role, how approvals flow) live elsewhere in LAG.
 */

import { z } from 'zod';

const permissionLevelSchema = z.enum(['read', 'write', 'admin']);

export const rolePermissionsSchema = z
  .object({
    contents: permissionLevelSchema.optional(),
    pull_requests: permissionLevelSchema.optional(),
    issues: permissionLevelSchema.optional(),
    metadata: permissionLevelSchema.optional(),
    checks: permissionLevelSchema.optional(),
    actions: permissionLevelSchema.optional(),
    statuses: permissionLevelSchema.optional(),
    discussions: permissionLevelSchema.optional(),
    workflows: permissionLevelSchema.optional(),
    administration: permissionLevelSchema.optional(),
  })
  .strict();

export const roleDefinitionSchema = z
  .object({
    /** Slug used for file names, URL state, and the App's default name. */
    name: z
      .string()
      .min(3)
      .max(60)
      .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, {
        message: 'name must be lower-kebab-case (a-z, 0-9, hyphens)',
      }),
    /** Human-readable label shown on GitHub and in approval messages. */
    displayName: z.string().min(3).max(80),
    /** One-sentence description; shown on the App creation screen. */
    description: z.string().min(10).max(240),
    /**
     * Owner slug the App will be created under. Typically a user login
     * (e.g. `stephengardner`) for personal accounts or an org login for
     * organizations. Defaults to the operator's personal account.
     */
    owner: z.string().min(1).optional(),
    /** GitHub App permissions requested for this role. */
    permissions: rolePermissionsSchema,
    /** Optional webhook events the App subscribes to (mostly unused today). */
    events: z.array(z.string()).default([]),
  })
  .strict();

export const roleRegistrySchema = z
  .object({
    version: z.literal(1),
    actors: z.array(roleDefinitionSchema).min(1),
  })
  .strict();

export type RolePermissions = z.infer<typeof rolePermissionsSchema>;
export type RoleDefinition = z.infer<typeof roleDefinitionSchema>;
export type RoleRegistry = z.infer<typeof roleRegistrySchema>;
