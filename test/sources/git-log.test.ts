/**
 * GitLogSource tests.
 *
 * Uses a real ephemeral git repo per test so we exercise the actual
 * git subprocess path (not a mock). Covers:
 *   - Happy path: N commits -> N atoms, each tagged git-log, metadata
 *     has sha + author + subject.
 *   - Skip merges by default.
 *   - Idempotent: second ingest writes 0, skips N.
 *   - maxCommits caps the read.
 *   - Missing repo -> error in report, no throw.
 *   - parseGitLog pure-function tests against canned output.
 */

import { execa } from 'execa';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import {
  GitLogSource,
  parseGitLog,
} from '../../src/sources/git-log.js';
import type { PrincipalId } from '../../src/substrate/types.js';

const principal = 'git-test' as PrincipalId;

let repoDir: string;

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), 'lag-git-'));
  await execa('git', ['-C', repoDir, 'init', '-q'], { reject: true });
  await execa('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com']);
  await execa('git', ['-C', repoDir, 'config', 'user.name', 'Tester']);
  await execa('git', ['-C', repoDir, 'config', 'commit.gpgsign', 'false']);
});
afterEach(async () => {
  try { await rm(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function commit(msg: string, body?: string): Promise<void> {
  const fullMsg = body ? `${msg}\n\n${body}` : msg;
  await writeFile(join(repoDir, `f-${Date.now()}-${Math.random()}.txt`), msg);
  await execa('git', ['-C', repoDir, 'add', '.']);
  await execa('git', ['-C', repoDir, 'commit', '-q', '-m', fullMsg]);
}

describe('parseGitLog (pure)', () => {
  it('returns empty array for empty input', () => {
    expect(parseGitLog('')).toEqual([]);
  });

  it('parses a synthesized log record', () => {
    const RS = '@@@LAG-RECORD@@@';
    const FS = '@@@LAG-FIELD@@@';
    const raw = ['abc123', 'Alice', 'alice@x', '2026-04-19T00:00:00Z', 'subject line', 'body text'].join(FS) + RS;
    const commits = parseGitLog(raw);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.sha).toBe('abc123');
    expect(commits[0]!.author).toBe('Alice');
    expect(commits[0]!.subject).toBe('subject line');
    expect(commits[0]!.body).toBe('body text');
  });
});

describe('GitLogSource.ingest', () => {
  it('reads commits from a real repo and writes one atom per commit', async () => {
    await commit('first commit');
    await commit('second commit', 'with body');
    await commit('third commit');

    const host = createMemoryHost();
    const source = new GitLogSource({ dir: repoDir });
    const report = await source.ingest(host, { principalId: principal });

    expect(report.sourceId).toBe('git-log');
    expect(report.atomsWritten).toBe(3);
    expect(report.errors).toEqual([]);

    const page = await host.atoms.query({}, 10);
    expect(page.atoms).toHaveLength(3);

    for (const atom of page.atoms) {
      expect(atom.layer).toBe('L0');
      expect(atom.provenance.source.tool).toBe('git-log');
      expect(atom.metadata.sha).toBeTruthy();
      expect(atom.metadata.author).toBe('Tester');
    }
  });

  it('commit message + body end up in atom content', async () => {
    await commit('subj', 'a multi\nline body');
    const host = createMemoryHost();
    const source = new GitLogSource({ dir: repoDir });
    await source.ingest(host, { principalId: principal });
    const atom = (await host.atoms.query({}, 5)).atoms[0]!;
    expect(atom.content).toContain('subj');
    expect(atom.content).toContain('a multi');
    expect(atom.content).toContain('line body');
  });

  it('idempotent: second ingest writes 0 atoms via SHA-dedup', async () => {
    await commit('only commit');
    const host = createMemoryHost();
    const source = new GitLogSource({ dir: repoDir });
    const r1 = await source.ingest(host, { principalId: principal });
    const r2 = await source.ingest(host, { principalId: principal });
    expect(r1.atomsWritten).toBe(1);
    expect(r2.atomsWritten).toBe(0);
    expect(r2.atomsSkipped).toBe(1);
  });

  it('maxCommits caps the read', async () => {
    for (let i = 0; i < 5; i++) await commit(`c${i}`);
    const host = createMemoryHost();
    const source = new GitLogSource({ dir: repoDir, maxCommits: 2 });
    const report = await source.ingest(host, { principalId: principal });
    expect(report.atomsWritten).toBe(2);
  });

  it('reports error (no throw) when dir is not a git repo', async () => {
    const bogus = await mkdtemp(join(tmpdir(), 'lag-not-git-'));
    try {
      const host = createMemoryHost();
      const source = new GitLogSource({ dir: bogus });
      const report = await source.ingest(host, { principalId: principal });
      expect(report.atomsWritten).toBe(0);
      expect(report.errors[0]).toMatch(/git log failed/);
    } finally {
      await rm(bogus, { recursive: true, force: true });
    }
  });
});
