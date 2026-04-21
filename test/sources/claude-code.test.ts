/**
 * ClaudeCodeTranscriptSource unit tests.
 *
 * Uses a fixture JSONL file written to a temp dir per test to avoid
 * any dependency on the author's actual transcripts. Covers:
 *   - Happy path: user + assistant messages become atoms
 *   - Skips non-conversational lines (queue-operation, thinking, etc)
 *   - Extracts only 'text' blocks from assistant content arrays
 *   - Dedup: running ingest twice writes nothing the second time
 *   - Missing directory produces an error in the report, not a throw
 *   - Dry run counts but does not persist
 *   - maxAtoms caps writes
 *   - parseLine rejects malformed or non-conversational JSON
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import {
  ClaudeCodeTranscriptSource,
  parseLine,
} from '../../src/sources/claude-code.js';
import type { PrincipalId } from '../../src/substrate/types.js';

const principalId = 'ingest-test' as PrincipalId;

/** Helper: build a JSONL fixture string. */
function jsonl(...events: Array<Record<string, unknown>>): string {
  return events.map(e => JSON.stringify(e)).join('\n') + '\n';
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lag-sources-'));
});

afterEach(async () => {
  try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('parseLine', () => {
  it('extracts user message content', () => {
    const parsed = parseLine(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hello world' },
        timestamp: '2026-04-19T00:00:00.000Z',
        sessionId: 'sess-1',
        uuid: 'u-1',
      }),
      'session-1.jsonl',
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.role).toBe('user');
    expect(parsed!.text).toBe('hello world');
    expect(parsed!.sessionId).toBe('sess-1');
  });

  it('extracts assistant text blocks, skipping thinking/tool_use', () => {
    const parsed = parseLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'private reasoning' },
            { type: 'text', text: 'first public para' },
            { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } },
            { type: 'text', text: 'second public para' },
          ],
        },
        timestamp: '2026-04-19T00:00:01.000Z',
      }),
      'session-1.jsonl',
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.role).toBe('assistant');
    expect(parsed!.text).toContain('first public para');
    expect(parsed!.text).toContain('second public para');
    expect(parsed!.text).not.toContain('private reasoning');
    expect(parsed!.text).not.toContain('Bash');
  });

  it('returns null for non-conversational event types', () => {
    const cases = ['queue-operation', 'ai-title', 'attachment', 'direct', 'last-prompt'];
    for (const type of cases) {
      expect(parseLine(JSON.stringify({ type, timestamp: 't' }), 'x.jsonl')).toBeNull();
    }
  });

  it('returns null for assistant with only non-text blocks', () => {
    const parsed = parseLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'x' },
            { type: 'tool_use', id: 'tu', name: 'Bash', input: {} },
          ],
        },
      }),
      'x.jsonl',
    );
    expect(parsed).toBeNull();
  });

  it('returns null for empty user content', () => {
    const parsed = parseLine(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '   ' },
      }),
      'x.jsonl',
    );
    expect(parsed).toBeNull();
  });
});

describe('ClaudeCodeTranscriptSource.ingest', () => {
  it('writes one atom per user + assistant message from a fixture', async () => {
    const content = jsonl(
      { type: 'user', message: { role: 'user', content: 'What is LAG?' }, timestamp: '2026-04-19T00:00:00.000Z', sessionId: 'sess-a' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'LAG is a governance substrate.' }] }, timestamp: '2026-04-19T00:00:01.000Z', sessionId: 'sess-a' },
      { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-04-19T00:00:02.000Z' },
    );
    await writeFile(join(dir, 'session-a.jsonl'), content);

    const host = createMemoryHost();
    const source = new ClaudeCodeTranscriptSource({ dir });
    const report = await source.ingest(host, { principalId });

    expect(report.sourceId).toBe('claude-code');
    expect(report.atomsWritten).toBe(2);
    expect(report.atomsSkipped).toBe(0);
    expect(report.errors).toEqual([]);
    const all = await host.atoms.query({}, 100);
    expect(all.atoms.map(a => a.content)).toContain('What is LAG?');
    expect(all.atoms.map(a => a.content)).toContain('LAG is a governance substrate.');

    // Provenance tagged correctly.
    const userAtom = all.atoms.find(a => a.content === 'What is LAG?')!;
    expect(userAtom.provenance.kind).toBe('user-directive');
    expect(userAtom.provenance.source.tool).toBe('claude-code');
    const asstAtom = all.atoms.find(a => a.content === 'LAG is a governance substrate.')!;
    expect(asstAtom.provenance.kind).toBe('agent-observed');
  });

  it('is idempotent: second ingest writes 0 atoms, skips all', async () => {
    const content = jsonl(
      { type: 'user', message: { role: 'user', content: 'hello' }, timestamp: '2026-04-19T00:00:00.000Z' },
    );
    await writeFile(join(dir, 's.jsonl'), content);
    const host = createMemoryHost();
    const source = new ClaudeCodeTranscriptSource({ dir });

    const r1 = await source.ingest(host, { principalId });
    const r2 = await source.ingest(host, { principalId });
    expect(r1.atomsWritten).toBe(1);
    expect(r2.atomsWritten).toBe(0);
    expect(r2.atomsSkipped).toBe(1);
  });

  it('reports error (not throw) when dir does not exist', async () => {
    const host = createMemoryHost();
    const source = new ClaudeCodeTranscriptSource({ dir: join(dir, 'does-not-exist') });
    const report = await source.ingest(host, { principalId });
    expect(report.atomsWritten).toBe(0);
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.errors[0]).toContain('Cannot read dir');
  });

  it('dryRun counts but persists nothing', async () => {
    const content = jsonl(
      { type: 'user', message: { role: 'user', content: 'A' } },
      { type: 'user', message: { role: 'user', content: 'B' } },
    );
    await writeFile(join(dir, 's.jsonl'), content);
    const host = createMemoryHost();
    const source = new ClaudeCodeTranscriptSource({ dir });
    const report = await source.ingest(host, { principalId, dryRun: true });
    expect(report.atomsWritten).toBe(2);
    const all = await host.atoms.query({}, 10);
    expect(all.atoms).toHaveLength(0);
  });

  it('maxAtoms caps the write count', async () => {
    const content = jsonl(
      ...Array.from({ length: 50 }, (_, i) => ({
        type: 'user',
        message: { role: 'user', content: `msg ${i}` },
      })),
    );
    await writeFile(join(dir, 's.jsonl'), content);
    const host = createMemoryHost();
    const source = new ClaudeCodeTranscriptSource({ dir });
    const report = await source.ingest(host, { principalId, maxAtoms: 10 });
    expect(report.atomsWritten).toBe(10);
  });

  it('malformed JSON line produces an error but other lines still ingest', async () => {
    const bad = '{ this is not json\n';
    const good = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'valid line' },
    }) + '\n';
    await writeFile(join(dir, 's.jsonl'), bad + good);

    const host = createMemoryHost();
    const source = new ClaudeCodeTranscriptSource({ dir });
    const report = await source.ingest(host, { principalId });
    expect(report.atomsWritten).toBe(1);
    expect(report.errors.length).toBeGreaterThan(0);
  });

  it('sessionFilter narrows which files are scanned', async () => {
    const content = jsonl(
      { type: 'user', message: { role: 'user', content: 'file-a' } },
    );
    await writeFile(join(dir, 'abc.jsonl'), content);
    await writeFile(join(dir, 'xyz.jsonl'), content);

    const host = createMemoryHost();
    const source = new ClaudeCodeTranscriptSource({ dir, sessionFilter: ['abc'] });
    const report = await source.ingest(host, { principalId });
    expect(report.atomsWritten).toBe(1); // only one file matched
  });
});
