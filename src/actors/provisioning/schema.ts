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
     * Optional. GitHub organization slug to create this App under.
     * When set, LAG routes the manifest URL to
     * /organizations/<slug>/settings/apps/new. When omitted, LAG routes
     * to /settings/apps/new which creates the App under whichever user
     * is logged in to github.com in the browser at approval time
     * (personal accounts). This field intentionally does NOT accept
     * user logins; use the logged-in-browser-user mechanism instead.
     */
    organization: z.string().min(1).optional(),
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
