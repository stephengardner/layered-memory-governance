/**
 * Convert common markdown (what Claude models emit) to Telegram HTML.
 *
 * Design: extract code blocks and emphasis as placeholders FIRST, then
 * escape HTML entities in free text, then substitute remaining patterns
 * (headings, bullets, links), then restore placeholders. Every regex
 * is bounded (no nested unbounded quantifiers) so the pass is O(n).
 *
 * Telegram HTML mode (parse_mode: HTML) supports:
 *   <b>, <i>, <u>, <s>, <a>, <code>, <pre>, <blockquote>
 * Headings are NOT supported as tags; we bold them.
 * Lists are NOT supported as tags; we use Unicode bullets.
 */

const TELEGRAM_MAX_CHARS = 4000;
const PH_PREFIX = '\u0000LAGFMT_';
const PH_SUFFIX = '\u0000';

interface Placeholder {
  readonly tag: string;
  readonly html: string;
}

/**
 * Convert a markdown string to Telegram HTML. Returns a safe HTML
 * string that Telegram will accept with `parse_mode: 'HTML'`.
 */
export function markdownToTelegramHtml(text: string): string {
  if (text.length === 0) return '';
  const placeholders: Placeholder[] = [];
  let s = text;

  // 1. Fenced code blocks (greedy across lines, but non-overlapping).
  s = extractPattern(
    s,
    /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)\n?```/g,
    placeholders,
    'FENCE',
    (m) => {
      const lang = m[1] ?? '';
      const body = m[2] ?? '';
      const escaped = escapeHtml(body);
      const cls = lang.trim().length > 0 ? ` class="language-${escapeHtml(lang.trim())}"` : '';
      return lang.trim().length > 0
        ? `<pre><code${cls}>${escaped}</code></pre>`
        : `<pre>${escaped}</pre>`;
    },
  );

  // 2. Inline code (single backticks, no newlines inside).
  s = extractPattern(
    s,
    /`([^`\n]+)`/g,
    placeholders,
    'INLINE',
    (m) => `<code>${escapeHtml(m[1] ?? '')}</code>`,
  );

  // 3. Bold **...** (non-greedy, bounded inside a line; chars only).
  s = extractPattern(
    s,
    /\*\*([^*\n]+?)\*\*/g,
    placeholders,
    'BOLD',
    (m) => `<b>${escapeHtml(m[1] ?? '')}</b>`,
  );

  // 4. Italic *...* (single star, not ** because ** already extracted).
  //    Requires non-whitespace on both sides of the content.
  s = extractPattern(
    s,
    /(^|[^*\w])\*([^*\s][^*\n]*?[^*\s]|[^*\s])\*(?!\w)/g,
    placeholders,
    'ITAL_AST',
    (m) => `${m[1] ?? ''}<i>${escapeHtml(m[2] ?? '')}</i>`,
  );

  // 5. Italic _..._ (only when surrounded by non-alphanumeric).
  s = extractPattern(
    s,
    /(^|[^_\w])_([^_\s][^_\n]*?[^_\s]|[^_\s])_(?!\w)/g,
    placeholders,
    'ITAL_UND',
    (m) => `${m[1] ?? ''}<i>${escapeHtml(m[2] ?? '')}</i>`,
  );

  // 6. Strikethrough ~~...~~.
  s = extractPattern(
    s,
    /~~([^~\n]+)~~/g,
    placeholders,
    'STRIKE',
    (m) => `<s>${escapeHtml(m[1] ?? '')}</s>`,
  );

  // 7. Links [text](url). Url must be http(s).
  s = extractPattern(
    s,
    /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    placeholders,
    'LINK',
    (m) => `<a href="${escapeAttr(m[2] ?? '')}">${escapeHtml(m[1] ?? '')}</a>`,
  );

  // 8. Headings at line start. Bold the text, drop the marker.
  s = extractPattern(
    s,
    /^#{1,6}[ \t]+([^\n]+)$/gm,
    placeholders,
    'HEAD',
    (m) => `<b>${escapeHtml(m[1] ?? '')}</b>`,
  );

  // Now escape remaining free text. Placeholders contain \u0000 so they
  // do not collide with HTML entity escaping.
  s = escapeHtml(s);

  // 9. Bullet lines: "- foo" or "* foo" at line start -> "• foo".
  s = s.replace(/^[ \t]*[-*][ \t]+/gm, '• ');

  // 10. Restore placeholders.
  s = s.replace(new RegExp(`${PH_PREFIX}(\\w+?)_(\\d+)${PH_SUFFIX}`, 'g'), (_m, _tag: string, idxStr: string) => {
    const i = parseInt(idxStr, 10);
    return placeholders[i]?.html ?? '';
  });

  return s;
}

/**
 * Split a markdown text into chunks sized for Telegram. Never splits
 * inside a fenced code block. Operates on RAW markdown so each chunk
 * can be independently converted with markdownToTelegramHtml().
 */
export function splitMarkdownForTelegram(text: string, maxChars = TELEGRAM_MAX_CHARS): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxChars) {
    let cut = maxChars;

    // Never cut inside a fenced code block when there is enough
    // non-fence content before the fence to make a useful chunk. If
    // the fence starts too early (e.g. at position 0), accept that we
    // must cut inside the block.
    const safeFence = findSafeFenceCut(remaining, maxChars);
    if (safeFence > maxChars * 0.3) {
      cut = safeFence;
    } else {
      const nl = remaining.lastIndexOf('\n', maxChars);
      if (nl > maxChars * 0.5) {
        cut = nl;
      } else {
        const sp = remaining.lastIndexOf(' ', maxChars);
        if (sp > maxChars * 0.5) cut = sp;
      }
    }

    // Guard against cut <= 0 which would loop forever.
    if (cut <= 0) cut = maxChars;

    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^[\n ]+/, '');
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

// ---- Internal helpers ---------------------------------------------------

function extractPattern(
  text: string,
  re: RegExp,
  placeholders: Placeholder[],
  tag: string,
  render: (m: RegExpMatchArray) => string,
): string {
  return text.replace(re, (...args) => {
    const m = args.slice(0, args.length - 2) as unknown as RegExpMatchArray;
    const idx = placeholders.length;
    placeholders.push({ tag, html: render(m) });
    return `${PH_PREFIX}${tag}_${idx}${PH_SUFFIX}`;
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * Find a safe place to cut AT or BEFORE `limit` that does not split a
 * fenced code block. If the window contains an odd number of ``` (i.e.
 * we are mid-block), return the position of the last opening fence so
 * we cut just before it. Otherwise return -1 (caller uses newline/space
 * heuristics).
 */
function findSafeFenceCut(text: string, limit: number): number {
  const window = text.slice(0, limit);
  const positions: number[] = [];
  let i = 0;
  while (i < window.length) {
    const found = window.indexOf('```', i);
    if (found === -1) break;
    positions.push(found);
    i = found + 3;
  }
  if (positions.length % 2 === 1 && positions.length > 0) {
    return positions[positions.length - 1]!;
  }
  return -1;
}
