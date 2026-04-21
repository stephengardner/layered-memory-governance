/**
 * ObsidianVaultSource.
 *
 * Reads a directory of markdown files (an Obsidian vault or any flat/
 * nested `.md` corpus). Each note becomes one L0 atom:
 *   - content: the note body (with YAML frontmatter stripped)
 *   - provenance.source.tool: 'obsidian'
 *   - provenance.source.file_path: the relative path to the note
 *   - metadata: parsed frontmatter key/values + the note's basename
 *
 * Second SessionSource implementation (after ClaudeCodeTranscriptSource).
 * Exists to validate the pluggability claim: adding a source is a new
 * file implementing the interface, nothing else. Scenario s12 proves
 * two sources compose into one `.lag/` via content-hash dedup.
 *
 * Scope choices, intentional:
 *   - YAML frontmatter is parsed (simple line-based parser; no external
 *     yaml dep). Keys land in atom.metadata. Unknown shapes degrade to
 *     string values.
 *   - Markdown body is preserved verbatim (no rendering, no link
 *     resolution). Governance operates on the text; rendering is the
 *     consumer's job later.
 *   - Hidden files (leading `.`) and files under `.obsidian/` config
 *     dirs are skipped so the source does not pull in vault settings.
 *   - Subdirectories are scanned recursively.
 *
 * Dedup: atom id is `obsidian-<contentHash(body)>`; two notes with
 * identical body (rare but possible) collide and the second is a
 * dedup write, same as the Claude Code source pattern.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { ConflictError } from '../substrate/errors.js';
import type { Host } from '../substrate/interface.js';
import type {
  Atom,
  AtomId,
  Layer,
  PrincipalId,
  Scope,
  Time,
} from '../substrate/types.js';
import type {
  IngestOptions,
  IngestReport,
  SessionSource,
} from './types.js';

export interface ObsidianVaultSourceOptions {
  /** Absolute path to the vault root directory. */
  readonly dir: string;
  /**
   * If set, only notes whose relative path starts with any of these
   * prefixes are ingested. Useful to scope a large vault to a folder.
   */
  readonly pathFilter?: ReadonlyArray<string>;
  /**
   * If set, only notes whose frontmatter contains ALL of these tags
   * are ingested. `tags` field in frontmatter is expected to be an
   * array or a comma-separated string.
   */
  readonly requireTags?: ReadonlyArray<string>;
  /** Max chars per note body before truncation. Default 16000. */
  readonly maxChars?: number;
}

interface ParsedNote {
  readonly body: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
}

export class ObsidianVaultSource implements SessionSource {
  readonly id = 'obsidian';
  readonly description: string;
  private readonly dir: string;
  private readonly pathFilter: ReadonlyArray<string> | null;
  private readonly requireTags: ReadonlyArray<string> | null;
  private readonly maxChars: number;

  constructor(options: ObsidianVaultSourceOptions) {
    this.dir = options.dir;
    this.pathFilter = options.pathFilter && options.pathFilter.length > 0
      ? options.pathFilter
      : null;
    this.requireTags = options.requireTags && options.requireTags.length > 0
      ? options.requireTags
      : null;
    this.maxChars = options.maxChars ?? 16_000;
    this.description = `Obsidian vault at ${this.dir}`;
  }

  async ingest(host: Host, options: IngestOptions): Promise<IngestReport> {
    const scope: Scope = options.scope ?? 'project';
    const layer: Layer = options.layer ?? 'L0';
    const maxAtoms = options.maxAtoms ?? 10_000;
    const dryRun = options.dryRun ?? false;

    const errors: string[] = [];
    const sampleAtomIds: AtomId[] = [];
    let atomsWritten = 0;
    let atomsSkipped = 0;
    let filesScanned = 0;
    let filesMatched = 0;

    let files: string[];
    try {
      files = await listMarkdownRecursive(this.dir);
    } catch (err) {
      return {
        sourceId: this.id,
        atomsWritten: 0,
        atomsSkipped: 0,
        errors: [`Cannot read dir ${this.dir}: ${describe(err)}`],
        sampleAtomIds: [],
      };
    }

    for (const absPath of files) {
      filesScanned += 1;
      if (atomsWritten >= maxAtoms) break;

      const relPath = relative(this.dir, absPath).replace(/\\/g, '/');
      if (this.pathFilter && !this.pathFilter.some(p => relPath.startsWith(p))) {
        continue;
      }

      let raw: string;
      try {
        raw = await readFile(absPath, 'utf8');
      } catch (err) {
        errors.push(`read ${relPath}: ${describe(err)}`);
        continue;
      }

      let parsed: ParsedNote;
      try {
        parsed = parseNote(raw);
      } catch (err) {
        errors.push(`parse ${relPath}: ${describe(err)}`);
        continue;
      }

      if (this.requireTags) {
        const noteTags = extractTags(parsed.frontmatter);
        const allPresent = this.requireTags.every(t => noteTags.includes(t));
        if (!allPresent) continue;
      }

      const body = parsed.body.trim();
      if (body.length === 0) continue;
      filesMatched += 1;

      const truncated = body.length > this.maxChars
        ? body.slice(0, this.maxChars) + '...[truncated]'
        : body;

      const atomId = `obsidian-${host.atoms.contentHash(truncated).slice(0, 16)}` as AtomId;
      const existing = await host.atoms.get(atomId);
      if (existing) {
        atomsSkipped += 1;
        continue;
      }

      const now = host.clock.now() as Time;
      const atom: Atom = {
        schema_version: 1,
        id: atomId,
        content: truncated,
        type: 'observation',
        layer,
        provenance: {
          kind: 'agent-observed',
          source: {
            tool: 'obsidian',
            file_path: relPath,
          },
          derived_from: [],
        },
        confidence: 0.5,
        created_at: now,
        last_reinforced_at: now,
        expires_at: null,
        supersedes: [],
        superseded_by: [],
        scope,
        signals: {
          agrees_with: [],
          conflicts_with: [],
          validation_status: 'unchecked',
          last_validated_at: null,
        },
        principal_id: options.principalId,
        taint: 'clean',
        metadata: {
          source: 'obsidian',
          rel_path: relPath,
          ...parsed.frontmatter,
        },
      };

      if (dryRun) {
        if (sampleAtomIds.length < 5) sampleAtomIds.push(atomId);
        atomsWritten += 1;
        continue;
      }

      try {
        await host.atoms.put(atom);
        atomsWritten += 1;
        if (sampleAtomIds.length < 5) sampleAtomIds.push(atomId);
      } catch (err) {
        if (err instanceof ConflictError) {
          atomsSkipped += 1;
        } else {
          errors.push(`write ${String(atomId)}: ${describe(err)}`);
        }
      }
    }

    return {
      sourceId: this.id,
      atomsWritten,
      atomsSkipped,
      errors,
      sampleAtomIds,
      details: {
        dir: this.dir,
        filesScanned,
        filesMatched,
        dryRun,
      },
    };
  }
}

// ---- Pure helpers ----------------------------------------------------------

/**
 * Recursively list all `.md` files under `dir`, skipping hidden files
 * and the `.obsidian/` config directory.
 */
export async function listMarkdownRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  await walk(dir, out);
  return out.sort();
}

async function walk(current: string, out: string[]): Promise<void> {
  const entries = await readdir(current);
  for (const name of entries) {
    if (name.startsWith('.') && name !== '.') continue; // skip hidden + .obsidian/
    const full = join(current, name);
    let s;
    try { s = await stat(full); } catch { continue; }
    if (s.isDirectory()) {
      await walk(full, out);
    } else if (s.isFile() && name.endsWith('.md')) {
      out.push(full);
    }
  }
}

/**
 * Split a note into YAML frontmatter (parsed as key/values) and body.
 * Recognizes the standard Obsidian/Jekyll form:
 *
 *   ---
 *   key: value
 *   tags: [a, b]
 *   ---
 *   note body...
 *
 * This parser is deliberately simple: no nested structures, no
 * multi-line scalars. Complex frontmatter degrades to string values;
 * consumers that need full YAML can pre-process.
 */
export function parseNote(raw: string): ParsedNote {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { body: raw, frontmatter: Object.freeze({}) };
  const fmText = m[1] ?? '';
  const body = m[2] ?? '';
  const fm: Record<string, unknown> = {};
  for (const line of fmText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon < 1) continue;
    const key = trimmed.slice(0, colon).trim();
    let value: unknown = trimmed.slice(colon + 1).trim();
    // Arrays: [a, b, c]
    if (typeof value === 'string') {
      const arr = /^\[([\s\S]*)\]$/.exec(value);
      if (arr) {
        value = arr[1]!
          .split(',')
          .map(s => s.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean);
      } else {
        // Strip surrounding quotes.
        value = (value as string).replace(/^["']|["']$/g, '');
      }
    }
    fm[key] = value;
  }
  return { body, frontmatter: Object.freeze(fm) };
}

/**
 * Extract an array of tags from parsed frontmatter. Handles `tags: [a, b]`,
 * `tags: "a, b"`, and the singular `tag: a`.
 */
function extractTags(frontmatter: Readonly<Record<string, unknown>>): ReadonlyArray<string> {
  const raw = frontmatter.tags ?? frontmatter.tag;
  if (Array.isArray(raw)) return raw.map(String).map(s => s.replace(/^#/, ''));
  if (typeof raw === 'string') {
    return raw.split(',').map(s => s.trim().replace(/^#/, '')).filter(Boolean);
  }
  return [];
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
