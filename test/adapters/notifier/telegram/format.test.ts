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
} from '../../../../src/adapters/notifier/telegram/format.js';

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
