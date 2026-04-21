/**
 * GitLogSource: third pluggable SessionSource.
 *
 * Reads a repository's git commit history and writes each commit as
 * one L0 atom. Validates the SessionSource interface holds for a
 * THIRD implementation (after Claude Code transcripts and Obsidian
 * vaults). Zero surprise: new file, new source kind, no core changes.
 *
 * Each atom:
 *   - content: the commit message (subject + body), plus a short
 *     prefix identifying the SHA and author.
 *   - provenance.source.tool: 'git-log'
 *   - provenance.source.file_path: the repo path (for debugging)
 *   - metadata: { sha, author, email, date, subject, files_changed? }
 *
 * Spawns `git log --pretty=format:...` directly via execa; no external
 * deps. Respects max-atoms cap. Idempotent via commit-sha-based atom
 * ids: re-ingesting the same repo writes 0 new atoms.
 *
 * Scope choices:
 *   - Reads the commit MESSAGE, not the patch. Governance ingests
 *     intent (what the author said), not code changes (those are in
 *     the tree). Message-only is also much smaller per atom.
 *   - Default `maxCommits: 1000` so a large repo does not flood L0.
 *     Use `since: 'YYYY-MM-DD'` to window-narrow.
 *   - Skips merge commits by default (usually noise; opt in via
 *     `includeMerges: true`).
 */

import { execa } from 'execa';
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

export interface GitLogSourceOptions {
  /** Absolute path to a git working tree. */
  readonly dir: string;
  /** Max commits to read. Default 1000. */
  readonly maxCommits?: number;
  /** Pass as `git log --since <value>`. */
  readonly since?: string;
  /** Pass as `git log --until <value>`. */
  readonly until?: string;
  /** Include merge commits. Default false. */
  readonly includeMerges?: boolean;
  /** Max chars per commit message (longer is truncated). Default 8000. */
  readonly maxChars?: number;
  /** Path to the git binary. Default 'git' on PATH. */
  readonly gitPath?: string;
}

interface ParsedCommit {
  readonly sha: string;
  readonly author: string;
  readonly email: string;
  readonly date: string; // ISO
  readonly subject: string;
  readonly body: string;
}

// Multi-char separators so any commit-message contents pass through
// cleanly. NUL (\x00) would be ideal but execa rejects NUL in args.
// These sequences are vanishingly unlikely to appear in real commit
// subjects or bodies.
const RS = '@@@LAG-RECORD@@@';
const FS = '@@@LAG-FIELD@@@';
const PRETTY = ['%H', '%an', '%ae', '%aI', '%s', '%b'].join(FS) + RS;

export class GitLogSource implements SessionSource {
  readonly id = 'git-log';
  readonly description: string;

  private readonly dir: string;
  private readonly maxCommits: number;
  private readonly since?: string;
  private readonly until?: string;
  private readonly includeMerges: boolean;
  private readonly maxChars: number;
  private readonly gitPath: string;

  constructor(options: GitLogSourceOptions) {
    this.dir = options.dir;
    this.maxCommits = options.maxCommits ?? 1000;
    if (options.since !== undefined) this.since = options.since;
    if (options.until !== undefined) this.until = options.until;
    this.includeMerges = options.includeMerges ?? false;
    this.maxChars = options.maxChars ?? 8000;
    this.gitPath = options.gitPath ?? 'git';
    this.description = `Git log at ${this.dir}`;
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
    let commitsScanned = 0;

    let commits: ParsedCommit[];
    try {
      commits = await this.readCommits();
    } catch (err) {
      return {
        sourceId: this.id,
        atomsWritten: 0,
        atomsSkipped: 0,
        errors: [`git log failed at ${this.dir}: ${describe(err)}`],
        sampleAtomIds: [],
      };
    }

    for (const commit of commits) {
      commitsScanned += 1;
      if (atomsWritten >= maxAtoms) break;
      const rawBody = [
        `${commit.sha.slice(0, 12)} by ${commit.author} on ${commit.date.slice(0, 10)}`,
        commit.subject,
        commit.body.trim(),
      ].filter((s) => s && s.length > 0).join('\n\n');
      const content = rawBody.length > this.maxChars
        ? rawBody.slice(0, this.maxChars) + '...[truncated]'
        : rawBody;

      // Atom id: `git-log-<sha-prefix>`. Same commit on re-ingest
      // collides and skips.
      const atomId = `git-log-${commit.sha.slice(0, 16)}` as AtomId;
      const existing = await host.atoms.get(atomId);
      if (existing) {
        atomsSkipped += 1;
        continue;
      }

      const now = host.clock.now() as Time;
      const atom: Atom = {
        schema_version: 1,
        id: atomId,
        content,
        type: 'observation',
        layer,
        provenance: {
          kind: 'agent-observed',
          source: {
            tool: 'git-log',
            file_path: this.dir,
          },
          derived_from: [],
        },
        confidence: 0.7,
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
          source: 'git-log',
          sha: commit.sha,
          short_sha: commit.sha.slice(0, 12),
          author: commit.author,
          email: commit.email,
          commit_date: commit.date,
          subject: commit.subject,
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
        commitsScanned,
        dryRun,
      },
    };
  }

  private async readCommits(): Promise<ParsedCommit[]> {
    // Guard: verify the dir IS the top of a git work-tree. Without this,
    // git walks up to a parent .git and silently pulls in commits from
    // the outer repo, which is worse than failing loudly.
    const ceiling = `GIT_CEILING_DIRECTORIES=${this.dir}`;
    const preCheck = await execa(this.gitPath, ['-C', this.dir, 'rev-parse', '--show-toplevel'], {
      reject: false,
      timeout: 10_000,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: this.dir + '/..' },
    });
    if (preCheck.exitCode !== 0) {
      throw new Error(
        `${this.dir} is not a git work-tree: ${(preCheck.stderr ?? '').slice(0, 200)}`,
      );
    }

    const args = [
      '-C',
      this.dir,
      'log',
      `--pretty=format:${PRETTY}`,
      `-n`,
      String(this.maxCommits),
    ];
    if (!this.includeMerges) args.push('--no-merges');
    if (this.since) args.push(`--since=${this.since}`);
    if (this.until) args.push(`--until=${this.until}`);

    const result = await execa(this.gitPath, args, {
      reject: false,
      stripFinalNewline: true,
      timeout: 30_000,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: this.dir + '/..' },
    });
    // Silence unused var warning when ceiling is not otherwise logged.
    void ceiling;

    if (result.exitCode !== 0) {
      throw new Error(
        `git exit ${result.exitCode}: ${(result.stderr ?? '').slice(0, 300)}`,
      );
    }

    return parseGitLog(result.stdout ?? '');
  }
}

/**
 * Pure parser for git log output produced with our PRETTY format.
 * Exported for unit tests.
 */
export function parseGitLog(raw: string): ParsedCommit[] {
  if (!raw) return [];
  const records = raw.split(RS).map((r) => r.trim()).filter((r) => r.length > 0);
  const commits: ParsedCommit[] = [];
  for (const record of records) {
    const parts = record.split(FS);
    if (parts.length < 5) continue;
    commits.push({
      sha: (parts[0] ?? '').trim(),
      author: (parts[1] ?? '').trim(),
      email: (parts[2] ?? '').trim(),
      date: (parts[3] ?? '').trim(),
      subject: (parts[4] ?? '').trim(),
      body: (parts[5] ?? '').trim(),
    });
  }
  return commits;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
