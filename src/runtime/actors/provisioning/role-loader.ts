/**
 * Loads and validates a RoleRegistry from disk.
 *
 * Convention: `<project>/roles.json` holds the declaration. We support
 * JSON only for v1 to keep the dep footprint at zero; a YAML loader
 * can be added behind a flag later without changing the call sites.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { roleRegistrySchema } from './schema.js';
import type { RoleDefinition, RoleRegistry } from './schema.js';

export async function loadRoleRegistry(path: string): Promise<RoleRegistry> {
  if (!existsSync(path)) {
    throw new Error(`roles file not found: ${path}`);
  }
  const raw = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`roles file is not valid JSON: ${path} (${msg})`);
  }
  const result = roleRegistrySchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`roles file schema validation failed:\n${issues}`);
  }
  return result.data;
}

export function findRole(registry: RoleRegistry, name: string): RoleDefinition | null {
  return registry.actors.find((a) => a.name === name) ?? null;
}
