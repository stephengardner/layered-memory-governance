/**
 * Canon-md: read, generate, and write the bracketed canon section in a
 * target CLAUDE.md (or any markdown) file.
 *
 * Usage:
 *   const mgr = new CanonMdManager({ filePath: '/path/CLAUDE.md' });
 *   const atoms = (await host.atoms.query({ layer: ['L3'] }, 1000)).atoms;
 *   const result = await mgr.applyCanon(atoms);
 *   if (result.changed) console.log(`wrote ${atoms.length} atoms to ${filePath}`);
 */

import type { Atom } from '../types.js';
import { renderCanonMarkdown, type RenderOptions } from './generator.js';
import {
  CANON_END,
  CANON_START,
  readFileOrEmpty,
  readSection,
  replaceSection,
  writeSection,
  type CanonSectionWriteResult,
} from './section.js';

export interface CanonMdManagerOptions {
  readonly filePath: string;
}

export class CanonMdManager {
  constructor(private readonly options: CanonMdManagerOptions) {}

  get filePath(): string {
    return this.options.filePath;
  }

  async readFull(): Promise<string> {
    return readFileOrEmpty(this.options.filePath);
  }

  async readSection(): Promise<string> {
    return readSection(this.options.filePath);
  }

  /**
   * Render the atoms as markdown and write them into the bracketed section.
   * Returns a diff summary.
   */
  async applyCanon(
    atoms: ReadonlyArray<Atom>,
    renderOptions: RenderOptions = {},
  ): Promise<CanonSectionWriteResult> {
    const rendered = renderCanonMarkdown(atoms, renderOptions);
    return writeSection(this.options.filePath, rendered);
  }

  /**
   * Dry-run: compute what the file WOULD look like after applying the atoms,
   * without writing.
   */
  async previewCanon(
    atoms: ReadonlyArray<Atom>,
    renderOptions: RenderOptions = {},
  ): Promise<{ before: string; after: string; changed: boolean }> {
    const rendered = renderCanonMarkdown(atoms, renderOptions);
    const before = await this.readFull();
    const after = replaceSection(before, rendered);
    return { before, after, changed: before !== after };
  }
}

export {
  CANON_END,
  CANON_START,
  extractSection,
  readFileOrEmpty,
  readSection,
  replaceSection,
  writeSection,
} from './section.js';
export { renderCanonMarkdown } from './generator.js';
export type { CanonSectionWriteResult } from './section.js';
export type { RenderOptions } from './generator.js';
