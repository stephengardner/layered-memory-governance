/**
 * Context assembler: turn the `.lag/` state into the system prompt for a
 * single daemon turn.
 *
 * Default policy: inject CANON verbatim (what the user and author agreed
 * is settled), plus the top-K semantic-search hits (L1 and L2 only, not
 * L0 raw noise) for the user's message. Bounded by character budget so
 * prompts do not explode.
 */

import { readFile } from 'node:fs/promises';
import type { Host } from '../substrate/interface.js';
import type { Atom, AtomFilter } from '../substrate/types.js';

export interface AssembleContextOptions {
  /** Path to the canon file to inject (typically `.lag/../CLAUDE.md`). */
  readonly canonFilePath: string;
  /** How many semantic-search hits to include. Default 10. */
  readonly k?: number;
  /** Max total characters in the assembled prompt. Default 16000. */
  readonly maxChars?: number;
  /** Layers to include in retrieval. Default ['L1', 'L2']. */
  readonly retrievalLayers?: ReadonlyArray<'L0' | 'L1' | 'L2' | 'L3'>;
}

export interface AssembledContext {
  readonly prompt: string;
  readonly canonIncluded: boolean;
  readonly atomsIncluded: number;
  readonly totalChars: number;
}

export async function assembleContext(
  host: Host,
  userMessage: string,
  options: AssembleContextOptions,
): Promise<AssembledContext> {
  const k = options.k ?? 10;
  const maxChars = options.maxChars ?? 16_000;
  const retrievalLayers = options.retrievalLayers ?? ['L1', 'L2'];

  const sections: string[] = [];
  let canonText = '';
  try {
    canonText = await readFile(options.canonFilePath, 'utf8');
  } catch {
    // Canon file may not exist yet. That's fine; just skip the block.
  }

  if (canonText.length > 0) {
    sections.push('CANON (authoritative, do not contradict):');
    sections.push(canonText);
    sections.push('');
  }

  const filter: AtomFilter = { layer: retrievalLayers };
  const hits = await host.atoms.search(userMessage, k, filter);
  const atomsIncluded: string[] = [];
  if (hits.length > 0) {
    sections.push(`RECENT RELEVANT MEMORY (top-${hits.length}, ranked by semantic match):`);
    for (const hit of hits) {
      const line = formatAtomLine(hit.atom, hit.score);
      atomsIncluded.push(line);
      sections.push(line);
    }
    sections.push('');
  }

  sections.push('End of CANON and MEMORY context. Respond to the user message conversationally.');

  // Budget enforcement: if we blew through, truncate the memory section
  // first (canon is load-bearing; memory is "nice to have").
  let prompt = sections.join('\n');
  if (prompt.length > maxChars && atomsIncluded.length > 0) {
    // Rebuild with fewer atoms until we fit.
    for (let keep = atomsIncluded.length - 1; keep >= 0; keep--) {
      const reduced: string[] = [];
      if (canonText.length > 0) {
        reduced.push('CANON (authoritative, do not contradict):');
        reduced.push(canonText);
        reduced.push('');
      }
      if (keep > 0) {
        reduced.push(`RECENT RELEVANT MEMORY (top-${keep}, ranked by semantic match):`);
        for (let i = 0; i < keep; i++) reduced.push(atomsIncluded[i]!);
        reduced.push('');
      }
      reduced.push('End of CANON and MEMORY context. Respond to the user message conversationally.');
      prompt = reduced.join('\n');
      if (prompt.length <= maxChars) break;
    }
  }
  // Final hard truncate if canon alone is too big.
  if (prompt.length > maxChars) {
    prompt = prompt.slice(0, maxChars - 80) + '\n\n[context truncated to fit budget]';
  }

  return {
    prompt,
    canonIncluded: canonText.length > 0,
    atomsIncluded: atomsIncluded.length,
    totalChars: prompt.length,
  };
}

function formatAtomLine(atom: Atom, score: number): string {
  const tag = `[${atom.layer}/${atom.type}@${atom.confidence.toFixed(2)}]`;
  const body = atom.content.length > 300 ? atom.content.slice(0, 300) + '...' : atom.content;
  return `  ${tag} ${body} (score=${score.toFixed(2)})`;
}
