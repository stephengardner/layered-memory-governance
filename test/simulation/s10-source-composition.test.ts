/**
 * Scenario s10: SessionSource composition.
 *
 * Proves that LAG can be kicked off from multiple sources in one
 * bootstrap pass, with content-hash dedup collapsing overlap. The
 * autonomous-org story says: you bring whatever prior history you
 * have (transcripts + vault notes + palace + git commits + ...) and
 * LAG's substrate unifies them.
 *
 * V1 ships two sources (Fresh + ClaudeCodeTranscriptSource), so the
 * composition we prove here is:
 *   1. FreshSource followed by ClaudeCodeTranscriptSource => atoms only
 *      from the Claude Code transcript.
 *   2. Two back-to-back ClaudeCodeTranscriptSource passes over the same
 *      directory => dedup, second pass writes zero.
 *   3. Two ClaudeCodeTranscriptSource instances over DIFFERENT
 *      directories with overlapping content => dedup still collapses.
 *
 * Adding a third source (Obsidian, ChromaDB) would replicate the
 * same test shape with no framework changes; that's the Phase 40
 * design guarantee.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import {
  ClaudeCodeTranscriptSource,
  FreshSource,
} from '../../src/sources/index.js';
import type { PrincipalId } from '../../src/substrate/types.js';

const principalId = 'source-compose' as PrincipalId;

function jsonl(...events: Array<Record<string, unknown>>): string {
  return events.map(e => JSON.stringify(e)).join('\n') + '\n';
}

let dirA: string;
let dirB: string;

beforeEach(async () => {
  dirA = await mkdtemp(join(tmpdir(), 'lag-s10-a-'));
  dirB = await mkdtemp(join(tmpdir(), 'lag-s10-b-'));
});

afterEach(async () => {
  try { await rm(dirA, { recursive: true, force: true }); } catch { /* ignore */ }
  try { await rm(dirB, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('s10: SessionSource composition', () => {
  it('Fresh + ClaudeCode yields only the Claude Code atoms', async () => {
    const content = jsonl(
      { type: 'user', message: { role: 'user', content: 'shape test' } },
    );
    await writeFile(join(dirA, 's.jsonl'), content);

    const host = createMemoryHost();
    const fresh = new FreshSource();
    const cc = new ClaudeCodeTranscriptSource({ dir: dirA });

    const r1 = await fresh.ingest(host, { principalId });
    const r2 = await cc.ingest(host, { principalId });

    expect(r1.atomsWritten).toBe(0);
    expect(r2.atomsWritten).toBe(1);
    const all = await host.atoms.query({}, 10);
    expect(all.atoms).toHaveLength(1);
  });

  it('Same dir ingested twice => dedup; second pass writes 0', async () => {
    const content = jsonl(
      { type: 'user', message: { role: 'user', content: 'same claim' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'an answer' }] } },
    );
    await writeFile(join(dirA, 's.jsonl'), content);

    const host = createMemoryHost();
    const cc = new ClaudeCodeTranscriptSource({ dir: dirA });

    const r1 = await cc.ingest(host, { principalId });
    const r2 = await cc.ingest(host, { principalId });

    expect(r1.atomsWritten).toBe(2);
    expect(r1.atomsSkipped).toBe(0);
    expect(r2.atomsWritten).toBe(0);
    expect(r2.atomsSkipped).toBe(2);

    // Exactly two atoms in the store.
    const all = await host.atoms.query({}, 10);
    expect(all.atoms).toHaveLength(2);
  });

  it('Two dirs with overlapping content => content-hash dedup still collapses', async () => {
    const shared = jsonl(
      { type: 'user', message: { role: 'user', content: 'shared claim across dirs' } },
    );
    const uniqueB = jsonl(
      { type: 'user', message: { role: 'user', content: 'unique to dir B' } },
    );
    await writeFile(join(dirA, 's.jsonl'), shared);
    await writeFile(join(dirB, 's.jsonl'), shared + uniqueB);

    const host = createMemoryHost();
    const sourceA = new ClaudeCodeTranscriptSource({ dir: dirA });
    const sourceB = new ClaudeCodeTranscriptSource({ dir: dirB });

    const rA = await sourceA.ingest(host, { principalId });
    const rB = await sourceB.ingest(host, { principalId });

    expect(rA.atomsWritten).toBe(1);
    expect(rB.atomsWritten).toBe(1); // only the unique message
    expect(rB.atomsSkipped).toBe(1); // shared content deduped

    const all = await host.atoms.query({}, 10);
    expect(all.atoms).toHaveLength(2);
  });

  it('Provenance preserves which source produced each atom', async () => {
    const content = jsonl(
      { type: 'user', message: { role: 'user', content: 'trace this' } },
    );
    await writeFile(join(dirA, 's.jsonl'), content);

    const host = createMemoryHost();
    const cc = new ClaudeCodeTranscriptSource({ dir: dirA });
    await cc.ingest(host, { principalId });

    const all = await host.atoms.query({}, 10);
    expect(all.atoms[0]!.provenance.source.tool).toBe('claude-code');
  });
});
