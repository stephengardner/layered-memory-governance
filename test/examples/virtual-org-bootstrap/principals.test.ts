/**
 * Seed principal JSON validation.
 *
 * The five seed principals (CTO, CEO, Code Author, Reviewer, QA) plus
 * their signing root (helix-root) form the initial authority chain for
 * a virtual-org deliberation. Every file must:
 *   - Parse as JSON.
 *   - Match the core Principal interface (id, name, role, permitted_*,
 *     goals, constraints, active, compromised_at, signed_by, created_at).
 *   - Declare a `model` field for agent-process dispatch.
 *   - Form a valid signing chain; every non-root signed_by must resolve
 *     to another principal in the same seed bundle.
 *   - Respect the spec's per-role authority: code-author / reviewer / qa
 *     cannot write above L1.
 *
 * Running the full set through one parse pass is the cheapest seed-time
 * guard; the boot script otherwise discovers a shape mismatch at agent
 * launch, which is a slower feedback loop.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { Layer, Principal, Scope } from '../../../src/substrate/types.js';

// ---------------------------------------------------------------------------
// Load + shape-check helpers
// ---------------------------------------------------------------------------

const PRINCIPALS_DIR = fileURLToPath(
  new URL('../../../src/examples/virtual-org-bootstrap/principals/', import.meta.url),
);

interface SeedPrincipal extends Principal {
  readonly model: string;
}

function loadSeed(file: string): SeedPrincipal {
  const raw = readFileSync(join(PRINCIPALS_DIR, file), 'utf8');
  return JSON.parse(raw) as SeedPrincipal;
}

function loadAll(): ReadonlyArray<SeedPrincipal> {
  return readdirSync(PRINCIPALS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map(loadSeed);
}

const ALLOWED_LAYERS: ReadonlySet<Layer> = new Set(['L0', 'L1', 'L2', 'L3']);
const ALLOWED_SCOPES: ReadonlySet<Scope> = new Set([
  'session',
  'project',
  'user',
  'global',
]);

function assertPrincipalShape(p: SeedPrincipal): void {
  expect(typeof p.id).toBe('string');
  expect(p.id.length).toBeGreaterThan(0);
  expect(typeof p.name).toBe('string');
  expect(typeof p.role).toBe('string');
  expect(typeof p.model).toBe('string');
  expect(p.model.length).toBeGreaterThan(0);
  expect(typeof p.active).toBe('boolean');
  expect(p.signed_by === null || typeof p.signed_by === 'string').toBe(true);
  expect(p.compromised_at).toBeNull();
  expect(typeof p.created_at).toBe('string');

  for (const layer of p.permitted_layers.read) expect(ALLOWED_LAYERS.has(layer)).toBe(true);
  for (const layer of p.permitted_layers.write) expect(ALLOWED_LAYERS.has(layer)).toBe(true);
  for (const scope of p.permitted_scopes.read) expect(ALLOWED_SCOPES.has(scope)).toBe(true);
  for (const scope of p.permitted_scopes.write) expect(ALLOWED_SCOPES.has(scope)).toBe(true);

  expect(Array.isArray(p.goals)).toBe(true);
  expect(p.goals.length).toBeGreaterThan(0);
  expect(Array.isArray(p.constraints)).toBe(true);
  expect(p.constraints.length).toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('virtual-org-bootstrap seed principals', () => {
  const seeds = loadAll();

  it('loads all 6 expected principal files', () => {
    const ids = seeds.map((s) => s.id).sort();
    expect(ids).toEqual([
      'helix-root',
      'vo-ceo',
      'vo-code-author',
      'vo-cto',
      'vo-qa',
      'vo-reviewer',
    ]);
  });

  it.each(seeds.map((s) => [s.id, s] as const))(
    '%s matches the Principal shape',
    (_id, seed) => {
      assertPrincipalShape(seed);
    },
  );

  it('every non-root signed_by resolves to a seed principal', () => {
    const byId = new Map(seeds.map((s) => [s.id, s]));
    for (const seed of seeds) {
      if (seed.signed_by === null) continue;
      expect(byId.has(seed.signed_by)).toBe(true);
    }
  });

  it('exactly one seed has signed_by=null (the root)', () => {
    const roots = seeds.filter((s) => s.signed_by === null);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.id).toBe('helix-root');
  });

  it('code-author, reviewer, and qa have write ceilings at L1 or below', () => {
    const restricted = seeds.filter(
      (s) => s.role === 'code-author' || s.role === 'reviewer' || s.role === 'qa',
    );
    expect(restricted).toHaveLength(3);
    for (const seed of restricted) {
      const writes = seed.permitted_layers.write;
      for (const layer of writes) {
        expect(layer === 'L0' || layer === 'L1').toBe(true);
      }
    }
  });

  it('every seed declares claude-opus-4-7 as its model', () => {
    for (const seed of seeds) {
      expect(seed.model).toBe('claude-opus-4-7');
    }
  });

  it('CTO and CEO sign under helix-root', () => {
    const byId = new Map(seeds.map((s) => [s.id, s]));
    expect(byId.get('vo-cto')!.signed_by).toBe('helix-root');
    expect(byId.get('vo-ceo')!.signed_by).toBe('helix-root');
  });

  it('code-author, reviewer, qa sign under the CTO', () => {
    const byId = new Map(seeds.map((s) => [s.id, s]));
    expect(byId.get('vo-code-author')!.signed_by).toBe('vo-cto');
    expect(byId.get('vo-reviewer')!.signed_by).toBe('vo-cto');
    expect(byId.get('vo-qa')!.signed_by).toBe('vo-cto');
  });
});
