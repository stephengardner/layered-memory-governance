/**
 * Principal-scoped canon rendering.
 *
 * `renderForPrincipal` filters a canon atom set to what the principal
 * is permitted to read (via `permitted_layers.read`) and, optionally,
 * biases the remainder by role-scoped tags. L3 atoms always render
 * regardless of the tag filter because L3 is the governance-substrate
 * constitution - every principal needs to see it.
 *
 * The output is a markdown string with:
 *   - A principal header (id, role, signed_by, goals, constraints).
 *   - The canon markdown body produced by the existing renderer.
 *
 * This is a pure function; file I/O is delegated to
 * `CanonMdManager.renderFor` (see index.ts).
 */

import type { Atom, Principal } from '../types.js';
import { renderCanonMarkdown, type RenderOptions } from './generator.js';

export interface RenderForOptions extends RenderOptions {
  /**
   * Optional role-to-tags mapping. When present and the principal's
   * role has an entry, non-L3 atoms are kept only if their
   * `metadata.tags` array intersects the configured tag list. L3
   * atoms are always included. If the map lacks an entry for the
   * principal's role, no tag filter applies.
   */
  readonly roleTagFilter?: Readonly<Record<string, readonly string[]>>;
}

export interface RenderForArgs extends RenderForOptions {
  readonly principal: Principal;
  readonly atoms: ReadonlyArray<Atom>;
}

export function renderForPrincipal(args: RenderForArgs): string {
  const { principal, atoms, roleTagFilter, ...renderOptions } = args;
  const permittedLayers = new Set(principal.permitted_layers.read);
  const roleTags = roleTagFilter?.[principal.role];

  const filtered = atoms.filter((a) => {
    // L3 is the constitutional layer and bypasses both the
    // permitted_layers and the role-tag filter - see the file-level
    // doc comment. The bypass MUST happen before the permitted_layers
    // check; the previous ordering silently dropped L3 atoms whenever
    // a principal's permitted_layers.read omitted L3, contradicting
    // the "every principal needs to see it" contract above.
    if (a.layer === 'L3') return true;
    if (!permittedLayers.has(a.layer)) return false;
    if (!roleTags || roleTags.length === 0) return true;
    const tags = Array.isArray(a.metadata?.['tags'])
      ? (a.metadata['tags'] as readonly unknown[]).filter(
          (t): t is string => typeof t === 'string',
        )
      : [];
    return tags.some((t) => roleTags.includes(t));
  });

  const header = renderPrincipalHeader(principal);
  const body = renderCanonMarkdown(filtered, renderOptions);
  return `${header}\n\n${body}`;
}

function renderPrincipalHeader(principal: Principal): string {
  const lines: string[] = [];
  lines.push(`# Principal: ${principal.name} (${principal.role})`);
  lines.push('');
  lines.push(`_id: ${principal.id}_`);
  if (principal.signed_by) {
    lines.push(`_signed_by: ${principal.signed_by}_`);
  }
  lines.push('');
  if (principal.goals.length > 0) {
    lines.push('## Goals');
    lines.push('');
    for (const goal of principal.goals) {
      lines.push(`- ${goal}`);
    }
    lines.push('');
  }
  if (principal.constraints.length > 0) {
    lines.push('## Constraints');
    lines.push('');
    for (const constraint of principal.constraints) {
      lines.push(`- ${constraint}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
