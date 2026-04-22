/**
 * Bracketed-section manager for a target CLAUDE.md (or any markdown file).
 *
 * LAG writes a single auto-managed section delimited by HTML-comment markers.
 * Human edits outside the markers are preserved verbatim; edits INSIDE the
 * markers are overwritten by the next canon application.
 *
 * If the markers are missing, `writeSection()` appends a fresh bracketed
 * block at the end of the file (creating the file if necessary).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { ensureDir } from '../../adapters/file/util.js';
import { dirname } from 'node:path';

export const CANON_START = '<!-- lag:canon-start -->';
export const CANON_END = '<!-- lag:canon-end -->';

export interface CanonSectionWriteResult {
  readonly before: string;
  readonly after: string;
  readonly changed: boolean;
}

/**
 * Return the full file text, creating it empty if missing.
 */
export async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return '';
    throw err;
  }
}

/**
 * Extract the content currently inside the bracketed section. Returns the
 * empty string if markers are missing or empty. Does NOT include the marker
 * lines themselves. Trailing whitespace on the extracted content is trimmed.
 */
export function extractSection(fileText: string): string {
  const startIdx = fileText.indexOf(CANON_START);
  if (startIdx < 0) return '';
  const contentStart = startIdx + CANON_START.length;
  const endIdx = fileText.indexOf(CANON_END, contentStart);
  if (endIdx < 0) return '';
  return fileText.slice(contentStart, endIdx).trim();
}

/**
 * Replace the bracketed-section content. If markers are absent, append
 * a fresh block (with a blank line before it for readability). Preserves
 * all other file text verbatim.
 */
export function replaceSection(fileText: string, newContent: string): string {
  const startIdx = fileText.indexOf(CANON_START);
  const endIdx = fileText.indexOf(CANON_END);
  const block =
    CANON_START + '\n' + newContent.trim() + '\n' + CANON_END;

  if (startIdx >= 0 && endIdx > startIdx) {
    const blockEnd = endIdx + CANON_END.length;
    return fileText.slice(0, startIdx) + block + fileText.slice(blockEnd);
  }
  // Markers missing: append. Add a separator if the existing text lacks
  // trailing whitespace and is non-empty.
  if (fileText.length === 0) return block + '\n';
  const needsNewline = !fileText.endsWith('\n');
  return fileText + (needsNewline ? '\n\n' : '\n') + block + '\n';
}

/**
 * Write the bracketed section to disk. Creates parent directories and the
 * file if absent. Returns before/after snapshots plus a `changed` flag
 * (false when the new content equals the existing section).
 */
export async function writeSection(
  filePath: string,
  newContent: string,
): Promise<CanonSectionWriteResult> {
  const before = await readFileOrEmpty(filePath);
  const trimmedNew = newContent.trim();
  const after = replaceSection(before, trimmedNew);
  // `changed` must reflect the ACTUAL write, not a section-only compare.
  // A missing file or missing section with empty rendered content would
  // otherwise return changed=false while the block/marker gets created.
  // Consumers (audit, reinforcement, reflection hooks) rely on this flag
  // to know whether a canon write happened.
  const changed = after !== before;
  if (changed) {
    await ensureDir(dirname(filePath));
    await writeFile(filePath, after, 'utf8');
  }
  return { before, after, changed };
}

/**
 * Read the current bracketed-section content from disk.
 */
export async function readSection(filePath: string): Promise<string> {
  const text = await readFileOrEmpty(filePath);
  return extractSection(text);
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === 'ENOENT'
  );
}
