/**
 * ObsidianVaultSource unit tests.
 *
 * Fixture-based: vault laid out in a temp dir per test. Covers:
 *   - Happy path: single note -> one L0 atom with correct provenance.
 *   - Frontmatter parsing: keys land in metadata, arrays handled,
 *     quoted values stripped.
 *   - Path filter: only matching subdirs ingested.
 *   - Tag filter: only notes with all required tags ingested.
 *   - Dedup: two identical-body notes collapse to one atom.
 *   - Hidden files and .obsidian/ config dir skipped.
 *   - Missing dir -> error, no throw.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import {
  ObsidianVaultSource,
  parseNote,
} from '../../src/ingestion/obsidian.js';
import type { PrincipalId } from '../../src/substrate/types.js';

const principalId = 'obsidian-test' as PrincipalId;

let vault: string;

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), 'lag-obs-'));
});
afterEach(async () => {
  try { await rm(vault, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('parseNote', () => {
  it('returns the whole text as body when no frontmatter', () => {
    const r = parseNote('just a body\nmore');
    expect(r.body).toBe('just a body\nmore');
    expect(r.frontmatter).toEqual({});
  });

  it('parses scalar key/value frontmatter', () => {
    const r = parseNote('---\ntitle: Hello\nauthor: Stephen\n---\nbody text');
    expect(r.frontmatter).toEqual({ title: 'Hello', author: 'Stephen' });
    expect(r.body).toBe('body text');
  });

  it('parses array frontmatter', () => {
    const r = parseNote('---\ntags: [one, two, three]\n---\nbody');
    expect(r.frontmatter.tags).toEqual(['one', 'two', 'three']);
  });

  it('strips surrounding quotes on string values', () => {
    const r = parseNote('---\ntitle: "Quoted Title"\nalt: \'other\'\n---\n');
    expect(r.frontmatter).toEqual({ title: 'Quoted Title', alt: 'other' });
  });
});

describe('ObsidianVaultSource.ingest', () => {
  it('writes one L0 atom per note with provenance tagged obsidian', async () => {
    await writeFile(join(vault, 'a.md'), '---\ntitle: Alpha\n---\nalpha body');
    await writeFile(join(vault, 'b.md'), 'beta body');

    const host = createMemoryHost();
    const source = new ObsidianVaultSource({ dir: vault });
    const report = await source.ingest(host, { principalId });

    expect(report.sourceId).toBe('obsidian');
    expect(report.atomsWritten).toBe(2);
    expect(report.errors).toEqual([]);

    const page = await host.atoms.query({}, 10);
    expect(page.atoms.map(a => a.content).sort()).toEqual(['alpha body', 'beta body']);

    for (const atom of page.atoms) {
      expect(atom.provenance.source.tool).toBe('obsidian');
      expect(atom.provenance.source.file_path).toMatch(/\.md$/);
      expect(atom.layer).toBe('L0');
    }
  });

  it('merges frontmatter into metadata', async () => {
    await writeFile(
      join(vault, 'note.md'),
      '---\ntitle: T\ntags: [a, b]\nauthor: S\n---\nthe body',
    );
    const host = createMemoryHost();
    const source = new ObsidianVaultSource({ dir: vault });
    await source.ingest(host, { principalId });

    const page = await host.atoms.query({}, 10);
    const atom = page.atoms[0]!;
    expect(atom.metadata.title).toBe('T');
    expect(atom.metadata.tags).toEqual(['a', 'b']);
    expect(atom.metadata.author).toBe('S');
    expect(atom.metadata.source).toBe('obsidian');
    expect(atom.metadata.rel_path).toBe('note.md');
  });

  it('pathFilter narrows to matching subtrees', async () => {
    await mkdir(join(vault, 'keep'), { recursive: true });
    await mkdir(join(vault, 'skip'), { recursive: true });
    await writeFile(join(vault, 'keep', 'a.md'), 'kept content');
    await writeFile(join(vault, 'skip', 'b.md'), 'skipped content');

    const host = createMemoryHost();
    const source = new ObsidianVaultSource({
      dir: vault,
      pathFilter: ['keep/'],
    });
    const report = await source.ingest(host, { principalId });
    expect(report.atomsWritten).toBe(1);
    const page = await host.atoms.query({}, 10);
    expect(page.atoms[0]!.content).toBe('kept content');
  });

  it('requireTags filter excludes notes missing any required tag', async () => {
    await writeFile(join(vault, 'a.md'), '---\ntags: [lag, design]\n---\na body');
    await writeFile(join(vault, 'b.md'), '---\ntags: [design]\n---\nb body');
    await writeFile(join(vault, 'c.md'), 'no frontmatter at all');

    const host = createMemoryHost();
    const source = new ObsidianVaultSource({
      dir: vault,
      requireTags: ['lag'],
    });
    const report = await source.ingest(host, { principalId });
    expect(report.atomsWritten).toBe(1);
    const page = await host.atoms.query({}, 10);
    expect(page.atoms[0]!.content).toBe('a body');
  });

  it('dedup: two notes with identical bodies collapse to one atom', async () => {
    await writeFile(join(vault, 'one.md'), 'same content');
    await writeFile(join(vault, 'two.md'), 'same content');
    const host = createMemoryHost();
    const source = new ObsidianVaultSource({ dir: vault });
    const report = await source.ingest(host, { principalId });
    expect(report.atomsWritten).toBe(1);
    expect(report.atomsSkipped).toBe(1);
  });

  it('skips hidden files and .obsidian config dir', async () => {
    await mkdir(join(vault, '.obsidian'), { recursive: true });
    await writeFile(join(vault, '.obsidian', 'settings.md'), 'should skip');
    await writeFile(join(vault, '.hidden.md'), 'should also skip');
    await writeFile(join(vault, 'visible.md'), 'include me');

    const host = createMemoryHost();
    const source = new ObsidianVaultSource({ dir: vault });
    const report = await source.ingest(host, { principalId });
    expect(report.atomsWritten).toBe(1);
    const page = await host.atoms.query({}, 10);
    expect(page.atoms[0]!.content).toBe('include me');
  });

  it('reports error (not throw) when dir does not exist', async () => {
    const host = createMemoryHost();
    const source = new ObsidianVaultSource({ dir: join(vault, 'does-not-exist') });
    const report = await source.ingest(host, { principalId });
    expect(report.atomsWritten).toBe(0);
    expect(report.errors[0]).toContain('Cannot read dir');
  });

  it('idempotent: second ingest writes 0', async () => {
    await writeFile(join(vault, 'n.md'), 'stable content');
    const host = createMemoryHost();
    const source = new ObsidianVaultSource({ dir: vault });
    const r1 = await source.ingest(host, { principalId });
    const r2 = await source.ingest(host, { principalId });
    expect(r1.atomsWritten).toBe(1);
    expect(r2.atomsWritten).toBe(0);
    expect(r2.atomsSkipped).toBe(1);
  });
});
