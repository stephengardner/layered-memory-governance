/**
 * markdownToTelegramHtml tests.
 *
 * Covers the common patterns Claude emits: bold, italic, inline code,
 * fenced code blocks, headings, bullets, links. Verifies HTML escaping
 * on free text and inside code blocks, and that code contents are
 * NOT touched by markdown rules (e.g. * inside code stays *).
 */

import { describe, expect, it } from 'vitest';
import {
  markdownToTelegramHtml,
  splitMarkdownForTelegram,
} from '../../src/daemon/format.js';

describe('markdownToTelegramHtml', () => {
  it('converts **bold** to <b>', () => {
    expect(markdownToTelegramHtml('hello **world**'))
      .toBe('hello <b>world</b>');
  });

  it('converts *italic* and _italic_ to <i>', () => {
    expect(markdownToTelegramHtml('say *hi* and _there_'))
      .toBe('say <i>hi</i> and <i>there</i>');
  });

  it('does not treat ** as italic', () => {
    expect(markdownToTelegramHtml('a **b** c'))
      .toBe('a <b>b</b> c');
  });

  it('converts ~~strike~~', () => {
    expect(markdownToTelegramHtml('hi ~~world~~'))
      .toBe('hi <s>world</s>');
  });

  it('converts inline code', () => {
    expect(markdownToTelegramHtml('run `npm test` now'))
      .toBe('run <code>npm test</code> now');
  });

  it('does not touch markdown inside inline code', () => {
    expect(markdownToTelegramHtml('see `**not bold**` literal'))
      .toBe('see <code>**not bold**</code> literal');
  });

  it('converts fenced code blocks with language', () => {
    const input = 'Look:\n```typescript\nconst x = 1;\n```\nDone.';
    const out = markdownToTelegramHtml(input);
    expect(out).toContain('<pre><code class="language-typescript">');
    expect(out).toContain('const x = 1;');
    expect(out).toContain('</code></pre>');
  });

  it('converts fenced code blocks without language', () => {
    const input = '```\nplain\n```';
    const out = markdownToTelegramHtml(input);
    expect(out).toContain('<pre>');
    expect(out).toContain('plain');
    expect(out).toContain('</pre>');
  });

  it('escapes HTML entities in free text', () => {
    expect(markdownToTelegramHtml('foo < bar > & baz'))
      .toBe('foo &lt; bar &gt; &amp; baz');
  });

  it('escapes HTML entities inside fenced code blocks', () => {
    const out = markdownToTelegramHtml('```\n<div>hi</div>\n```');
    expect(out).toContain('&lt;div&gt;hi&lt;/div&gt;');
    expect(out).not.toContain('<div>');
  });

  it('escapes HTML entities inside inline code', () => {
    const out = markdownToTelegramHtml('`<x>`');
    expect(out).toBe('<code>&lt;x&gt;</code>');
  });

  it('converts headings by bolding and stripping the marker', () => {
    expect(markdownToTelegramHtml('# Title')).toBe('<b>Title</b>');
    expect(markdownToTelegramHtml('### Sub')).toBe('<b>Sub</b>');
  });

  it('converts bullet lists to Unicode bullets', () => {
    const out = markdownToTelegramHtml('- one\n- two\n- three');
    expect(out).toContain('• one');
    expect(out).toContain('• two');
    expect(out).toContain('• three');
    // No stray italic from * bullets.
    expect(out).not.toContain('<i>');
  });

  it('converts links to anchor tags', () => {
    const out = markdownToTelegramHtml('[github](https://github.com/user/repo)');
    expect(out).toBe('<a href="https://github.com/user/repo">github</a>');
  });

  it('handles a multi-feature paragraph realistically', () => {
    const input = [
      '# Status',
      '',
      'You are on **LAG v0.1.0** with `node >= 22`.',
      '',
      'Next steps:',
      '- Finish *Phase 41*',
      '- Ship `npm run bootstrap`',
      '',
      '```bash',
      'npm test',
      '```',
    ].join('\n');
    const out = markdownToTelegramHtml(input);
    expect(out).toContain('<b>Status</b>');
    expect(out).toContain('<b>LAG v0.1.0</b>');
    expect(out).toContain('<code>node &gt;= 22</code>');
    expect(out).toContain('<i>Phase 41</i>');
    expect(out).toContain('<code>npm run bootstrap</code>');
    expect(out).toContain('• Finish');
    expect(out).toContain('<pre><code class="language-bash">npm test</code></pre>');
  });

  it('returns empty for empty input', () => {
    expect(markdownToTelegramHtml('')).toBe('');
  });

  // Tables: Telegram HTML parse mode does not support <table>/<tr>/<td>.
  // Rendering markdown tables as <pre> blocks with space-padded columns
  // keeps them readable in Telegram without adding a rendering dep. The
  // passes MUST run before code-fence extraction (they synthesize a
  // fenced block) and before generic line-level transforms so pipe
  // characters and header dashes are consumed by the table pass, not
  // mistaken for bullets or other line-start markers.
  describe('markdown tables', () => {
    it('renders a simple table as a <pre> block with padded columns', () => {
      const input = [
        '| name | count |',
        '| ---- | ----- |',
        '| a    | 1     |',
        '| bb   | 22    |',
      ].join('\n');
      const out = markdownToTelegramHtml(input);
      // Body should be inside a <pre> block.
      expect(out.startsWith('<pre>')).toBe(true);
      expect(out.endsWith('</pre>')).toBe(true);
      // Columns are space-padded to the widest cell.
      expect(out).toContain('name | count');
      expect(out).toContain('---- | -----');
      expect(out).toContain('a    | 1');
      expect(out).toContain('bb   | 22');
    });

    it('renders a header-only table (separator row, no data rows)', () => {
      const input = [
        '| col1 | col2 |',
        '| ---- | ---- |',
      ].join('\n');
      const out = markdownToTelegramHtml(input);
      expect(out.startsWith('<pre>')).toBe(true);
      expect(out).toContain('col1 | col2');
      expect(out).toContain('---- | ----');
    });

    it('renders a table with empty cells without collapsing columns', () => {
      const input = [
        '| k    | v     |',
        '| ---- | ----- |',
        '| a    |       |',
        '|      | b     |',
      ].join('\n');
      const out = markdownToTelegramHtml(input);
      // Pin the exact expected output so the "do not collapse columns"
      // invariant is literal: header widths come from the separator
      // (4 and 5), data cells are padded to the same width.
      const expectedBody = [
        'k    | v    ',
        '---- | -----',
        'a    |      ',
        '     | b    ',
      ].join('\n');
      expect(out).toBe(`<pre>${expectedBody}</pre>`);
    });

    it('escapes HTML-special chars inside table cells', () => {
      const input = [
        '| html        |',
        '| ----------- |',
        '| <b>x</b> & y |',
      ].join('\n');
      const out = markdownToTelegramHtml(input);
      expect(out).toContain('&lt;b&gt;x&lt;/b&gt; &amp; y');
      expect(out).not.toContain('<b>x</b>');
    });

    it('leaves a pipe in prose (not matching the table shape) untouched', () => {
      const input = 'use the | operator for pipes';
      const out = markdownToTelegramHtml(input);
      expect(out).toBe('use the | operator for pipes');
    });

    it('treats a line starting with | but no separator row as plain text', () => {
      // Without a `| --- |` separator on the next line, this is not a
      // markdown table and must not be promoted to <pre>. Pin the
      // exact preserved output so a regression that drops or mangles
      // the pipes does not silently pass this assertion.
      const input = '| lone pipe-looking line |';
      const out = markdownToTelegramHtml(input);
      expect(out).toBe('| lone pipe-looking line |');
    });

    it('preserves surrounding prose around a table', () => {
      // Pin the exact output shape: blank-line separators around the <pre>
      // block, prose on the outside, and the padded table on the inside.
      // A regression that collapses blank lines, glues <pre> to surrounding
      // text, or shifts prose inside the block must not pass silently.
      const input = [
        'before the table',
        '',
        '| x | y |',
        '| - | - |',
        '| 1 | 2 |',
        '',
        'after the table',
      ].join('\n');
      const out = markdownToTelegramHtml(input);
      expect(out).toBe(
        'before the table\n\n<pre>x | y\n- | -\n1 | 2</pre>\n\nafter the table',
      );
    });
  });
});

describe('splitMarkdownForTelegram', () => {
  it('returns single chunk under limit', () => {
    expect(splitMarkdownForTelegram('short', 1000)).toEqual(['short']);
  });

  it('prefers newline boundaries when splitting', () => {
    const text = 'a'.repeat(800) + '\n' + 'b'.repeat(800);
    const chunks = splitMarkdownForTelegram(text, 1000);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]!.endsWith('a')).toBe(true);
  });

  it('prefers to avoid splitting inside a fenced code block when feasible', () => {
    // Fenced block small enough to fit, with lots of text on either side.
    const openFence = '```bash\n';
    const body = 'x'.repeat(500);
    const closeFence = '\n```\n';
    const text = 'A'.repeat(1500) + '\n' + openFence + body + closeFence + 'B'.repeat(1500);
    const chunks = splitMarkdownForTelegram(text, 2000);
    // Each chunk should have balanced ``` count (fences not split).
    for (const c of chunks) {
      const count = (c.match(/```/g) ?? []).length;
      expect(count % 2).toBe(0);
    }
  });

  it('falls back to hard-splitting when a fenced block itself exceeds the limit', () => {
    // One fence bigger than the whole chunk budget. We MUST cut inside it
    // (accept that HTML rendering of that chunk will be ugly). The
    // splitter must still terminate and produce chunks under the limit.
    const giantBlock = '```\n' + 'y'.repeat(5000) + '\n```';
    const chunks = splitMarkdownForTelegram(giantBlock, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
  });
});
