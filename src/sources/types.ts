/**
 * SessionSource: pluggable kick-off adapter.
 *
 * LAG's `.lag/` state has to come from somewhere. A SessionSource
 * produces atoms from a specific kind of external input (Claude Code
 * transcripts, ChromaDB-backed palace, an Obsidian vault, Slack export,
 * Git history, etc). Each source is independent; multiple can compose
 * in one bootstrap pass. Content-hash dedup in the AtomStore means
 * overlap between sources collapses naturally.
 *
 * Design intent: adding a new source is a PR (new file implementing
 * SessionSource), not an architecture change.
 *
 * Example composition:
 *
 *   const fresh   = new FreshSource();
 *   const claude  = new ClaudeCodeTranscriptSource({ dir: '.claude/projects/x' });
 *
 *   for (const s of [fresh, claude]) {
 *     await s.ingest(host, { principalId: 'root' });
 *   }
 */

import type { Host } from '../substrate/interface.js';
import type { AtomId, Layer, PrincipalId, Scope } from '../substrate/types.js';

export interface IngestOptions {
  /** Principal that authored the ingested atoms. */
  readonly principalId: PrincipalId;
  /** Scope for ingested atoms. Default 'project'. */
  readonly scope?: Scope;
  /**
   * Target layer for ingested atoms. Default 'L0' because source
   * material is untouched input; L1 extraction happens later via
   * the promotion engine or an explicit claim-extraction pass.
   */
  readonly layer?: Layer;
  /** Hard cap on atoms written per ingest() call. Default 10_000. */
  readonly maxAtoms?: number;
  /**
   * If true, the source reports what it WOULD write but does not
   * actually persist. Useful for previewing a bootstrap.
   */
  readonly dryRun?: boolean;
}

export interface IngestReport {
  /** Stable id of the source that produced this report. */
  readonly sourceId: string;
  /** Atoms successfully written to the host. */
  readonly atomsWritten: number;
  /**
   * Atoms skipped because they already exist in the host (content-
   * hash dedup), the input was empty, or the shape did not match
   * this source's expected format.
   */
  readonly atomsSkipped: number;
  /** Hard errors hit during ingest (fatal or per-record). */
  readonly errors: ReadonlyArray<string>;
  /** A few sample ids for human scanning; not exhaustive. */
  readonly sampleAtomIds: ReadonlyArray<AtomId>;
  /** Optional source-specific diagnostic blob. */
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface SessionSource {
  /** Stable id (e.g. 'claude-code', 'obsidian'). Used in reports and provenance. */
  readonly id: string;
  /** One-line human description. */
  readonly description: string;
  /**
   * Ingest this source into the given host. Must be idempotent: a
   * second call on the same input produces zero new atoms (content-
   * hash dedup at the AtomStore layer handles this automatically for
   * text inputs that produce identical content).
   */
  ingest(host: Host, options: IngestOptions): Promise<IngestReport>;
}
