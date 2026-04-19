import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CANON_END,
  CANON_START,
  extractSection,
  readSection,
  replaceSection,
  writeSection,
} from '../../src/canon-md/section.js';

let tmpPath: string;

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lag-section-'));
  tmpPath = join(dir, 'CLAUDE.md');
});

afterEach(async () => {
  try {
    await rm(tmpPath, { force: true });
  } catch {
    /* ignore */
  }
});

describe('extractSection', () => {
  it('returns empty when markers are missing', () => {
    expect(extractSection('no markers here')).toBe('');
  });

  it('extracts content between markers', () => {
    const text = `before\n${CANON_START}\nhello\n${CANON_END}\nafter`;
    expect(extractSection(text)).toBe('hello');
  });

  it('trims surrounding whitespace', () => {
    const text = `${CANON_START}\n\n  content  \n\n${CANON_END}`;
    expect(extractSection(text)).toBe('content');
  });

  it('returns empty when end marker is before start', () => {
    const text = `${CANON_END}\nwhatever\n${CANON_START}`;
    expect(extractSection(text)).toBe('');
  });
});

describe('replaceSection', () => {
  it('appends a fresh block when markers missing', () => {
    const result = replaceSection('# Project\n\nsome content', 'new canon');
    expect(result).toContain(CANON_START);
    expect(result).toContain('new canon');
    expect(result).toContain(CANON_END);
    expect(result.startsWith('# Project')).toBe(true);
  });

  it('replaces between markers, preserving surrounding text', () => {
    const text = `# Header\n\n${CANON_START}\nold\n${CANON_END}\n\n# Footer`;
    const result = replaceSection(text, 'new');
    expect(result).toContain('# Header');
    expect(result).toContain('# Footer');
    expect(result).toContain('new');
    expect(result).not.toContain('old');
  });

  it('writes an empty file cleanly when file was empty', () => {
    const result = replaceSection('', 'canon content');
    expect(result).toContain(CANON_START);
    expect(result).toContain('canon content');
  });

  it('is idempotent when given same content twice', () => {
    const first = replaceSection('# P\n', 'X');
    const second = replaceSection(first, 'X');
    expect(second).toBe(first);
  });
});

describe('writeSection / readSection', () => {
  it('creates the file when it does not exist', async () => {
    const result = await writeSection(tmpPath, 'hello canon');
    expect(result.changed).toBe(true);
    const read = await readSection(tmpPath);
    expect(read).toBe('hello canon');
  });

  it('preserves human-edited content outside markers', async () => {
    await writeFile(tmpPath, '# Human header\n\nHand-written intro.\n\n', 'utf8');
    await writeSection(tmpPath, 'canon body');
    const full = await readFile(tmpPath, 'utf8');
    expect(full).toContain('# Human header');
    expect(full).toContain('Hand-written intro.');
    expect(full).toContain('canon body');
  });

  it('reports changed=false when content is unchanged', async () => {
    await writeSection(tmpPath, 'stable');
    const result = await writeSection(tmpPath, 'stable');
    expect(result.changed).toBe(false);
  });

  it('overwrites only the section, not surrounding text, on re-apply', async () => {
    await writeFile(tmpPath, 'top\n\n' + CANON_START + '\nv1\n' + CANON_END + '\n\nbottom\n', 'utf8');
    await writeSection(tmpPath, 'v2');
    const full = await readFile(tmpPath, 'utf8');
    expect(full).toContain('top');
    expect(full).toContain('bottom');
    expect(full).toContain('v2');
    expect(full).not.toContain('v1');
  });
});
