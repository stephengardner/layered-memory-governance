/**
 * Classifies a RoleDefinition's permission ask as low- or high-risk.
 *
 * Philosophy: anything that can silently mutate the repo without a
 * subsequent review step counts as high-risk and requires explicit
 * operator approval before LAG opens the App creation browser window.
 * Read-only roles auto-provision after a courtesy Telegram heads-up.
 *
 * This is the first line of defense against a rogue or typo'd role
 * definition getting a write-capable bot identity by accident.
 */

import type { RoleDefinition, RolePermissions } from './schema.js';

export type RiskLevel = 'low' | 'high';

export interface RiskAssessment {
  readonly level: RiskLevel;
  readonly reasons: ReadonlyArray<string>;
  /** The specific permissions that triggered the risk classification. */
  readonly triggers: ReadonlyArray<{ readonly key: string; readonly level: string }>;
}

/**
 * Permissions that mutate repository state. Write or admin on any of
 * these makes the role high-risk.
 */
const MUTATING_KEYS: ReadonlyArray<keyof RolePermissions> = [
  'contents',
  'pull_requests',
  'issues',
  'checks',
  'actions',
  'statuses',
  'discussions',
  'workflows',
  'administration',
];

export function assessRoleRisk(role: RoleDefinition): RiskAssessment {
  const triggers: Array<{ key: string; level: string }> = [];
  const reasons: string[] = [];

  for (const key of MUTATING_KEYS) {
    const level = role.permissions[key];
    if (level === 'write' || level === 'admin') {
      triggers.push({ key, level });
    }
  }

  if (role.permissions.administration === 'admin') {
    reasons.push('administration:admin grants repo-management access');
  } else if (role.permissions.administration === 'write') {
    reasons.push('administration:write grants branch-protection control');
  }

  if (role.permissions.contents === 'write') {
    reasons.push('contents:write allows direct commits and file changes');
  }

  if (role.permissions.workflows === 'write') {
    reasons.push('workflows:write can modify CI pipelines');
  }

  if (triggers.length > 0 && reasons.length === 0) {
    reasons.push(`${triggers.length} write-level permission(s) requested`);
  }

  return {
    level: triggers.length > 0 ? 'high' : 'low',
    reasons,
    triggers,
  };
}
