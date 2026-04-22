/**
 * Render a collection of L3 atoms as a deterministic markdown section.
 *
 * Output structure:
 *   # LAG Canon
 *
 *   Auto-managed by LAG. Do not edit between the markers.
 *   Last updated: <ISO timestamp>
 *
 *   ## decisions
 *   - ... (confidence: 0.95)
 *   - ...
 *
 *   ## architecture
 *   - ...
 *
 * Sorted:
 *   - Types in a stable order (decision > preference > directive > reference > observation > ephemeral).
 *   - Within each type, atoms are sorted by confidence desc, then created_at desc for stability.
 */

import { CANON_END, CANON_START } from './section.js';
import type { Atom, AtomType } from '../types.js';

const TYPE_ORDER: ReadonlyArray<AtomType> = [
  'directive',
  'decision',
  'preference',
  'reference',
  'plan',
  'question',
  'observation',
  'ephemeral',
  // Inbox runtime types are L0/L1; the canon applier filters to L3 so
  // these never appear in CLAUDE.md. Included here for deterministic
  // ordering if a caller explicitly renders a non-L3 atom set (e.g. a
  // debugging dump or the `lag inbox` CLI).
  'actor-message',
  'actor-message-ack',
  'circuit-breaker-trip',
  'circuit-breaker-reset',
];

const TYPE_HEADINGS: Readonly<Record<AtomType, string>> = {
  directive: 'Directives',
  decision: 'Decisions',
  preference: 'Preferences',
  reference: 'References',
  plan: 'Plans',
  question: 'Questions',
  observation: 'Observations',
  ephemeral: 'Ephemeral',
  'actor-message': 'Actor Messages',
  'actor-message-ack': 'Actor Message Acks',
  'circuit-breaker-trip': 'Circuit Breaker Trips',
  'circuit-breaker-reset': 'Circuit Breaker Resets',
};

export interface RenderOptions {
  /**
   * Explicit "last updated" timestamp for the header. When omitted, derived
   * from the newest atom's last_reinforced_at so that repeated rendering of
   * the same atom set produces byte-identical output. This lets the canon
   * applier skip re-writing the target file when nothing changed.
   */
  readonly now?: string;
  /** If true, include the confidence value after each bullet. */
  readonly showConfidence?: boolean;
}

function deriveNowFromAtoms(atoms: ReadonlyArray<Atom>): string {
  let best: string | null = null;
  for (const atom of atoms) {
    if (atom.superseded_by.length > 0) continue;
    if (atom.taint !== 'clean') continue;
    if (best === null || atom.last_reinforced_at > best) best = atom.last_reinforced_at;
  }
  return best ?? '1970-01-01T00:00:00.000Z';
}

export function renderCanonMarkdown(
  atoms: ReadonlyArray<Atom>,
  options: RenderOptions = {},
): string {
  const now = options.now ?? deriveNowFromAtoms(atoms);
  const showConfidence = options.showConfidence ?? true;

  const lines: string[] = [];
  lines.push('# LAG Canon');
  lines.push('');
  lines.push(
    'Auto-managed by LAG. Do NOT edit the auto-canon section; changes will be overwritten on the next canon application.',
  );
  lines.push('');
  lines.push(`_Last updated: ${now}_`);
  lines.push('');

  // Group by type AND filter out superseded / tainted atoms. Emptiness
  // must be checked AFTER the filter: a caller can legitimately pass a
  // list where every atom is superseded, and the rendered file should
  // still show the "no canon" placeholder (not an empty body).
  const byType = new Map<AtomType, Atom[]>();
  for (const atom of atoms) {
    if (atom.superseded_by.length > 0) continue; // skip superseded
    if (atom.taint !== 'clean') continue;         // skip tainted
    const bucket = byType.get(atom.type) ?? [];
    bucket.push(atom);
    byType.set(atom.type, bucket);
  }

  if (byType.size === 0) {
    lines.push('_No canon atoms yet._');
    return lines.join('\n');
  }

  const orderedTypes: AtomType[] = [
    ...TYPE_ORDER.filter(t => byType.has(t)),
    ...Array.from(byType.keys()).filter(t => !TYPE_ORDER.includes(t)),
  ];

  for (const type of orderedTypes) {
    const group = byType.get(type);
    if (!group || group.length === 0) continue;
    const sorted = [...group].sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      if (b.created_at !== a.created_at) return b.created_at.localeCompare(a.created_at);
      // Final tie-breaker: atom id. Confidence and created_at can both
      // match across atoms (hand-authored bulk seeds, deterministic test
      // fixtures); without this, sort order is engine-defined and the
      // canon file can flip between runs, breaking the "byte-stable
      // rerender on unchanged atoms" contract that the applier's
      // skip-when-unchanged optimization relies on.
      return a.id.localeCompare(b.id);
    });
    const heading = TYPE_HEADINGS[type] ?? capitalize(type);
    lines.push(`## ${heading}`);
    lines.push('');
    for (const atom of sorted) {
      const content = escapeCanonMarkers(atom.content);
      const line = showConfidence
        ? `- ${content} _(confidence ${atom.confidence.toFixed(2)})_`
        : `- ${content}`;
      lines.push(line);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

// Prevent atom content from prematurely closing the managed canon
// section. A clean atom carrying the literal `<!-- lag:canon-end -->`
// sequence would otherwise terminate the block early, and the next
// replace pass would treat the trailing generated text as human-owned.
// Rewrite both markers into a safe literal that will never be matched
// by the section extractor. Cheap and deterministic.
function escapeCanonMarkers(s: string): string {
  return s
    .split(CANON_START)
    .join('<!-- lag:canon-start escaped -->')
    .split(CANON_END)
    .join('<!-- lag:canon-end escaped -->');
}
