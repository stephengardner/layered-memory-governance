/**
 * CanonMdManager.renderFor - principal-scoped canon rendering.
 *
 * The existing `applyCanon` renders a global canon section. The virtual
 * org gives each principal its own CLAUDE.md; `renderFor` filters the
 * atom set to what the principal is permitted to see (per
 * `permitted_layers.read`), optionally biases by role-scoped tags, and
 * prepends a principal header (id, role, goals, constraints).
 *
 * Tests:
 *   - L3 always renders regardless of role-tag filter (constitutional).
 *   - Atoms whose layer is not in `permitted_layers.read` are excluded.
 *   - Role-tag filter keeps only atoms whose `metadata.tags` intersect
 *     the configured list; L3 bypasses this.
 *   - Principal header contains id, role, goals, constraints.
 *   - When no atoms survive the filter, output still contains the
 *     principal header and the "No canon atoms yet" placeholder.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CanonMdManager } from '../../../src/substrate/canon-md/index.js';
import { renderForPrincipal } from '../../../src/substrate/canon-md/render-for.js';
import { samplePrincipal, sampleAtom } from '../../fixtures.js';
import type { Principal } from '../../../src/substrate/types.js';

function ctoPrincipal(): Principal {
  return samplePrincipal({
    role: 'cto',
    name: 'Virtual Org CTO',
    goals: [
      'Uphold architecture and security invariants',
      'Detect structural concerns proactively',
    ],
    constraints: ['No self-approval of own decisions'],
    permitted_layers: {
      read: ['L1', 'L2', 'L3'],
      write: ['L1', 'L2'],
    },
  });
}

describe('renderForPrincipal (pure)', () => {
  it('includes principal header with id, role, goals, constraints', () => {
    const principal = ctoPrincipal();
    const out = renderForPrincipal({ principal, atoms: [] });
    expect(out).toContain(principal.id);
    expect(out).toContain('cto');
    expect(out).toContain('Uphold architecture and security invariants');
    expect(out).toContain('No self-approval of own decisions');
  });

  it('renders placeholder when no atoms survive filtering', () => {
    const principal = ctoPrincipal();
    const out = renderForPrincipal({ principal, atoms: [] });
    expect(out).toContain('No canon atoms yet');
  });

  it('excludes atoms whose layer is not in permitted_layers.read', () => {
    const principal = samplePrincipal({
      role: 'qa',
      permitted_layers: { read: ['L0'], write: [] },
    });
    const l0 = sampleAtom({ layer: 'L0', content: 'l0-visible' });
    const l3 = sampleAtom({ layer: 'L3', content: 'l3-hidden' });
    const out = renderForPrincipal({ principal, atoms: [l0, l3] });
    expect(out).toContain('l0-visible');
    expect(out).not.toContain('l3-hidden');
  });

  it('L3 atoms always render even without a role-tag match', () => {
    const principal = ctoPrincipal();
    const l3 = sampleAtom({
      layer: 'L3',
      content: 'always-render-l3',
      metadata: { tags: ['unrelated-role'] },
    });
    const out = renderForPrincipal({
      principal,
      atoms: [l3],
      roleTagFilter: { cto: ['security', 'architecture', 'reliability'] },
    });
    expect(out).toContain('always-render-l3');
  });

  it('role-tag filter excludes non-L3 atoms without a matching tag', () => {
    const principal = ctoPrincipal();
    const matching = sampleAtom({
      layer: 'L2',
      content: 'matching-tag-atom',
      metadata: { tags: ['security'] },
    });
    const unrelated = sampleAtom({
      layer: 'L2',
      content: 'unrelated-tag-atom',
      metadata: { tags: ['product'] },
    });
    const out = renderForPrincipal({
      principal,
      atoms: [matching, unrelated],
      roleTagFilter: { cto: ['security', 'architecture', 'reliability'] },
    });
    expect(out).toContain('matching-tag-atom');
    expect(out).not.toContain('unrelated-tag-atom');
  });

  it('role-tag filter with no matching entry for role includes all permitted atoms', () => {
    const principal = samplePrincipal({
      role: 'custom-role',
      permitted_layers: { read: ['L1', 'L2', 'L3'], write: [] },
    });
    const atom = sampleAtom({ layer: 'L2', content: 'included-for-unfiltered' });
    const out = renderForPrincipal({
      principal,
      atoms: [atom],
      roleTagFilter: { cto: ['security'] },
    });
    expect(out).toContain('included-for-unfiltered');
  });

  it('atoms with no tags metadata pass through when no role-tag filter is set', () => {
    const principal = ctoPrincipal();
    const atom = sampleAtom({ layer: 'L2', content: 'untagged-kept' });
    const out = renderForPrincipal({ principal, atoms: [atom] });
    expect(out).toContain('untagged-kept');
  });

  it('respects principal.signed_by in header when present', () => {
    const principal = samplePrincipal({
      role: 'reviewer',
      signed_by: 'vo-cto' as Principal['signed_by'],
    });
    const out = renderForPrincipal({ principal, atoms: [] });
    expect(out).toContain('vo-cto');
  });
});

describe('CanonMdManager.renderFor', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lag-renderfor-'));
    filePath = join(tmpDir, 'CLAUDE.md');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes a principal-scoped section to the target file', async () => {
    const mgr = new CanonMdManager({ filePath });
    const principal = ctoPrincipal();
    const atom = sampleAtom({ layer: 'L3', content: 'rendered-via-manager' });
    const result = await mgr.renderFor({ principal, atoms: [atom] });
    expect(result.changed).toBe(true);
    const on_disk = await readFile(filePath, 'utf8');
    expect(on_disk).toContain(principal.id);
    expect(on_disk).toContain('rendered-via-manager');
  });
});
