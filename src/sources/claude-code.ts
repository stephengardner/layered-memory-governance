/**
 * ClaudeCodeTranscriptSource.
 *
 * Reads a Claude Code project transcript directory (typically
 * `~/.claude/projects/<sanitized-path>/*.jsonl`) and writes each
 * conversational message as an L0 atom. The transcript becomes a
 * seed corpus that LAG's promotion engine can later lift to L1, L2,
 * and (with human approval) L3 canon.
 *
 * Scope choices, intentional:
 *   - User messages: captured.
 *   - Assistant TEXT blocks: captured (filtered out: thinking,
 *     tool_use, tool_result blocks).
 *   - Other event types (queue-operation, ai-title, attachment,
 *     system, direct, last-prompt, thinking, message wrapper, ...):
 *     skipped. Those are operational, not conversational, and would
 *     flood the store with noise at this stage.
 *
 * Dedup: atom ids are `<source_id>:<contentHash(text)>`, so re-
 * ingesting the same transcript produces zero new atoms.
 *
 * Provenance tagging:
 *   - `source.tool = 'claude-code'`
 *   - `source.session_id = <sessionId from jsonl or filename>`
 *   - `source.file_path = <transcript filename>`
 *   - `provenance.kind = 'user-directive' | 'agent-observed'`
 *
 * Cost: zero LLM calls. Ingestion is pure JSONL parsing + atom
 * writes. Claim extraction (turning L0 transcripts into L1 atoms)
 * is a separate promotion concern.
 */

import { readdir, readFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
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

export interface ClaudeCodeTranscriptSourceOptions {
  /** Directory containing one or more `*.jsonl` transcript files. */
  readonly dir: string;
  /**
   * Max characters per atom. Messages longer than this are truncated
   * (suffix `...[truncated]`). Default 8000 chars, which holds a full
   * long answer without spamming the store with multi-kilobyte blobs.
   */
  readonly maxChars?: number;
  /**
   * If set, only transcripts whose filename starts with any of these
   * substrings are ingested. Useful when a projects directory has many
   * sessions and you only want a subset.
   */
  readonly sessionFilter?: ReadonlyArray<string>;
}

interface ParsedMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly timestamp: Time | null;
  readonly sessionId: string | null;
  readonly uuid: string | null;
}

export class ClaudeCodeTranscriptSource implements SessionSource {
  readonly id = 'claude-code';
  readonly description: string;

  private readonly dir: string;
  private readonly maxChars: number;
  private readonly sessionFilter: ReadonlyArray<string> | null;

  constructor(options: ClaudeCodeTranscriptSourceOptions) {
    this.dir = options.dir;
    this.maxChars = options.maxChars ?? 8000;
    this.sessionFilter = options.sessionFilter && options.sessionFilter.length > 0
      ? options.sessionFilter
      : null;
    this.description = `Claude Code transcripts at ${this.dir}`;
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
    let messagesParsed = 0;

    let files: string[];
    try {
      files = await this.listTranscripts();
    } catch (err) {
      return {
        sourceId: this.id,
        atomsWritten: 0,
        atomsSkipped: 0,
        errors: [`Cannot read dir ${this.dir}: ${describe(err)}`],
        sampleAtomIds: [],
      };
    }

    for (const file of files) {
      filesScanned += 1;
      if (atomsWritten >= maxAtoms) break;
      let content: string;
      try {
        content = await readFile(file, 'utf8');
      } catch (err) {
        errors.push(`Read ${basename(file)}: ${describe(err)}`);
        continue;
      }

      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        if (atomsWritten >= maxAtoms) break;
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: ParsedMessage | null;
        try {
          parsed = parseLine(trimmed, basename(file));
        } catch (err) {
          errors.push(`Parse ${basename(file)}: ${describe(err)}`);
          continue;
        }
        if (!parsed) continue;
        messagesParsed += 1;

        const truncated = parsed.text.length > this.maxChars
          ? parsed.text.slice(0, this.maxChars) + '...[truncated]'
          : parsed.text;

        const atomId = atomIdFor(this.id, truncated, host) as AtomId;
        const existing = await host.atoms.get(atomId);
        if (existing) {
          atomsSkipped += 1;
          continue;
        }

        const atom = buildAtom({
          id: atomId,
          content: truncated,
          role: parsed.role,
          timestamp: parsed.timestamp,
          sessionId: parsed.sessionId,
          filename: basename(file),
          principalId: options.principalId,
          scope,
          layer,
        });

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
            errors.push(`Write ${String(atomId)}: ${describe(err)}`);
          }
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
        messagesParsed,
        dryRun,
      },
    };
  }

  private async listTranscripts(): Promise<string[]> {
    const entries = await readdir(this.dir);
    return entries
      .filter(name => name.endsWith('.jsonl'))
      .filter(name => {
        if (!this.sessionFilter) return true;
        return this.sessionFilter.some(prefix => name.startsWith(prefix));
      })
      .map(name => resolve(this.dir, name));
  }
}

// ---- Pure helpers ----------------------------------------------------------

/**
 * Parse one JSONL line into a normalized message. Returns null if the
 * line is not a conversational message (user text or assistant text).
 * Throws on malformed JSON so the caller can record an error.
 */
export function parseLine(line: string, filename: string): ParsedMessage | null {
  const obj = JSON.parse(line) as Record<string, unknown>;
  const type = obj.type as string | undefined;
  const timestamp = (obj.timestamp as Time | undefined) ?? null;
  const sessionId = (obj.sessionId as string | undefined)
    ?? filename.replace(/\.jsonl$/, '');
  const uuid = (obj.uuid as string | undefined) ?? null;

  if (type === 'user') {
    const message = obj.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (typeof content === 'string' && content.trim().length > 0) {
      return { role: 'user', text: content, timestamp, sessionId, uuid };
    }
    return null;
  }

  if (type === 'assistant') {
    const message = obj.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) return null;
    // Concatenate all 'text' blocks. Skip thinking, tool_use, tool_result.
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0) {
        parts.push(b.text);
      }
    }
    if (parts.length === 0) return null;
    return {
      role: 'assistant',
      text: parts.join('\n\n'),
      timestamp,
      sessionId,
      uuid,
    };
  }

  return null;
}

function buildAtom(args: {
  readonly id: AtomId;
  readonly content: string;
  readonly role: 'user' | 'assistant';
  readonly timestamp: Time | null;
  readonly sessionId: string | null;
  readonly filename: string;
  readonly principalId: PrincipalId;
  readonly scope: Scope;
  readonly layer: Layer;
}): Atom {
  const ts = args.timestamp ?? ('1970-01-01T00:00:00.000Z' as Time);
  return {
    schema_version: 1,
    id: args.id,
    content: args.content,
    type: 'observation',
    layer: args.layer,
    provenance: {
      kind: args.role === 'user' ? 'user-directive' : 'agent-observed',
      source: {
        tool: 'claude-code',
        session_id: args.sessionId ?? args.filename,
        file_path: args.filename,
      },
      derived_from: [],
    },
    confidence: 0.5,
    created_at: ts,
    last_reinforced_at: ts,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: args.scope,
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: args.principalId,
    taint: 'clean',
    metadata: { role: args.role, session_id: args.sessionId ?? args.filename },
  };
}

function atomIdFor(sourceId: string, content: string, host: Host): string {
  // Use '-' separator, not ':'; colons are illegal in filenames on Windows.
  return `${sourceId}-${host.atoms.contentHash(content).slice(0, 16)}`;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
