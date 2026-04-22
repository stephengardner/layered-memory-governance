/**
 * Parser for CodeRabbit review-body markdown.
 *
 * CodeRabbit posts two payloads on every review:
 *   1. Line comments, one per actionable finding. These are already
 *      covered by `listUnresolvedComments` via the GraphQL reviewThreads
 *      query; they need no parsing.
 *   2. A review BODY with an `**Actionable comments posted: N**`
 *      preamble, a collapsible `🧹 Nitpick comments (N)` block, and
 *      optional `♻️ Proposed fix` diffs. Nitpicks live in the body, NOT
 *      as line comments, so the reviewThreads query never sees them.
 *      Without parsing the body, an Actor can only act on the line
 *      comments and silently drops every nit.
 *
 * This parser extracts the body-scoped items so pr-landing can observe
 * the full review surface. It is intentionally scoped to the CodeRabbit
 * format: if GitHub's own review UI or a future reviewer bot posts a
 * similarly-structured body, they would need their own parser (or a
 * shared abstraction that sees two concrete instances first; no
 * premature abstraction).
 *
 * Parsing strategy: targeted regex on known landmarks
 * (`**Actionable comments posted: N**`, `🧹 Nitpick comments (N)`,
 * `<summary>path (N)</summary>`, `♻️ Proposed fix`) combined with a
 * nesting-aware `<details>` walker. The format is stable enough that
 * this is cheaper than pulling in a full markdown AST; if CodeRabbit
 * changes the structure, the tests (ridden on a real PR fixture) will
 * fail loudly.
 */

export interface ParsedCodeRabbitReview {
  /** Number claimed by the `**Actionable comments posted: N**` preamble. */
  readonly actionableCount: number;
  /** Number claimed by the `🧹 Nitpick comments (N)` summary. */
  readonly nitpickCount: number;
  /** Structured nitpicks extracted from the body. */
  readonly nitpicks: ReadonlyArray<ParsedNitpick>;
}

export interface ParsedNitpick {
  readonly path: string;
  /**
   * First line of the finding's scope. CodeRabbit uses either a single
   * number (`42`) or an inclusive range (`58-62`); both surface as
   * `lineStart`, and a range sets `lineEnd` too.
   */
  readonly lineStart?: number;
  readonly lineEnd?: number;
  /** Short title (the bold first sentence of the finding). */
  readonly title: string;
  /**
   * Body text of the finding, stripped of the title and any nested
   * `<details>` blocks (♻️ Proposed fix is extracted into its own field
   * so consumers can render it inline; the 🤖 Prompt for AI Agents
   * block is discarded).
   */
  readonly body: string;
  /**
   * The unified-diff content of a `♻️ Proposed fix` block, if present.
   * Plain diff text (no surrounding fenced code block markers). The
   * operator can copy this straight into `git apply`.
   */
  readonly proposedFix?: string;
}

export function parseCodeRabbitReviewBody(body: string): ParsedCodeRabbitReview {
  const actionableMatch = body.match(/\*\*Actionable comments posted:\s*(\d+)\*\*/);
  const actionableCount = actionableMatch ? parseInt(actionableMatch[1]!, 10) : 0;

  const nitpickHeaderMatch = body.match(/<summary>🧹 Nitpick comments \((\d+)\)<\/summary>/);
  if (!nitpickHeaderMatch || nitpickHeaderMatch.index === undefined) {
    return { actionableCount, nitpickCount: 0, nitpicks: [] };
  }
  const nitpickCount = parseInt(nitpickHeaderMatch[1]!, 10);

  // Find the <details> that opened just before the 🧹 summary. Walk
  // backward from the summary position to the nearest <details>.
  const detailsOpenIdx = body.lastIndexOf('<details>', nitpickHeaderMatch.index);
  if (detailsOpenIdx === -1) {
    return { actionableCount, nitpickCount, nitpicks: [] };
  }
  const sectionEnd = findBalancedDetailsEnd(body, detailsOpenIdx);
  const section = body.slice(nitpickHeaderMatch.index + nitpickHeaderMatch[0].length, sectionEnd);

  const nitpicks = parseNitpickSection(section);
  return { actionableCount, nitpickCount, nitpicks };
}

/**
 * Given a `<details>` opener position, return the index just past its
 * matching `</details>`. Walks through the text balancing nested pairs.
 * Returns src.length if no match is found (degraded parse rather than
 * throwing; the parser is best-effort by design).
 */
function findBalancedDetailsEnd(src: string, openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  const OPEN = '<details>';
  const CLOSE = '</details>';
  while (i < src.length) {
    const nextOpen = src.indexOf(OPEN, i);
    const nextClose = src.indexOf(CLOSE, i);
    if (nextClose === -1) return src.length;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + OPEN.length;
    } else {
      depth--;
      if (depth === 0) return nextClose + CLOSE.length;
      i = nextClose + CLOSE.length;
    }
  }
  return src.length;
}

/**
 * Parse the inside of the 🧹 Nitpick comments <details>. Format:
 *
 *   <blockquote>
 *     <details>
 *       <summary>PATH (N)</summary>
 *       <blockquote>
 *         `LINE`: **Title**
 *         body text
 *         <details><summary>♻️ Proposed fix</summary>...</details>
 *         <details><summary>🤖 Prompt ...</summary>...</details>
 *       </blockquote>
 *     </details>
 *     ... more file blocks ...
 *   </blockquote>
 */
function parseNitpickSection(section: string): ReadonlyArray<ParsedNitpick> {
  const nitpicks: ParsedNitpick[] = [];
  const fileSummary = /<summary>([^<>\n]+?)\s*\((\d+)\)<\/summary>/g;
  let m: RegExpExecArray | null;
  while ((m = fileSummary.exec(section)) !== null) {
    const path = m[1]!.trim();
    // Skip pseudo-paths like "🤖 Prompt for AI Agents" or "♻️ Proposed fix"
    // that might accidentally match the regex.
    if (path.startsWith('🤖') || path.startsWith('♻️') || !looksLikePath(path)) continue;

    const fileOpenIdx = section.lastIndexOf('<details>', m.index);
    if (fileOpenIdx === -1) continue;
    const fileEnd = findBalancedDetailsEnd(section, fileOpenIdx);
    const fileBody = section.slice(m.index + m[0].length, fileEnd);

    for (const n of parseFileBlock(path, fileBody)) nitpicks.push(n);

    // Advance past this file block so exec() doesn't re-enter it.
    fileSummary.lastIndex = fileEnd;
  }
  return nitpicks;
}

function looksLikePath(s: string): boolean {
  // Accept foo.md, foo/bar.ts, src/x.ts, scripts/gh-as.mjs, etc.
  // Reject pure labels like "Proposed fix" or "Prompt for AI Agents".
  return /[\w-]+\.[\w-]+/.test(s);
}

/**
 * Parse an individual file block's body. Each block contains one or
 * more items of the form:
 *
 *   `LINE` or `LINE-RANGE`: **Title**
 *
 *   Free-form body text over N paragraphs.
 *
 *   <details><summary>♻️ Proposed fix</summary>
 *   ```diff
 *   ...
 *   ```
 *   </details>
 *
 *   <details><summary>🤖 Prompt for AI Agents</summary>...</details>
 *
 * Items within the same file block are separated by blank lines. The
 * line-range + bold-title pattern is the delimiter; everything until
 * the next `LINE-RANGE: **Title**` (or end of block) belongs to the
 * current item. Nested <details> blocks inside the item are handled:
 * the Proposed fix extracts to `proposedFix`; the AI prompt is dropped.
 */
function parseFileBlock(path: string, fileBody: string): ReadonlyArray<ParsedNitpick> {
  const results: ParsedNitpick[] = [];
  const itemHeader = /`(\d+)(?:-(\d+))?`:\s*\*\*([^*]+?)\*\*/g;
  const starts: Array<{ idx: number; headerLen: number; lineStart: number; lineEnd?: number; title: string }> = [];
  let hm: RegExpExecArray | null;
  while ((hm = itemHeader.exec(fileBody)) !== null) {
    const entry: {
      idx: number;
      headerLen: number;
      lineStart: number;
      lineEnd?: number;
      title: string;
    } = {
      idx: hm.index,
      headerLen: hm[0].length,
      lineStart: parseInt(hm[1]!, 10),
      title: hm[3]!.trim(),
    };
    if (hm[2] !== undefined) entry.lineEnd = parseInt(hm[2], 10);
    starts.push(entry);
  }
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i]!;
    const end = i + 1 < starts.length ? starts[i + 1]!.idx : fileBody.length;
    const rawBody = fileBody.slice(s.idx + s.headerLen, end);
    const { body, proposedFix } = splitBodyAndProposedFix(rawBody);
    const out: ParsedNitpick = proposedFix === undefined
      ? (s.lineEnd === undefined
        ? { path, lineStart: s.lineStart, title: s.title, body }
        : { path, lineStart: s.lineStart, lineEnd: s.lineEnd, title: s.title, body })
      : (s.lineEnd === undefined
        ? { path, lineStart: s.lineStart, title: s.title, body, proposedFix }
        : { path, lineStart: s.lineStart, lineEnd: s.lineEnd, title: s.title, body, proposedFix });
    results.push(out);
  }
  return results;
}

function splitBodyAndProposedFix(raw: string): { body: string; proposedFix?: string } {
  const proposedFixMarker = '<summary>♻️ Proposed fix</summary>';
  const proposedIdx = raw.indexOf(proposedFixMarker);
  const aiPromptMarker = '<summary>🤖 Prompt for AI Agents</summary>';

  // Strip the AI prompt block regardless: it is an instruction back to a
  // coding agent, not user-facing content.
  let working = stripDetailsBlock(raw, aiPromptMarker);

  if (proposedIdx === -1) {
    return { body: working.trim() };
  }

  // Find the proposed-fix <details> opener in the ORIGINAL raw string
  // (stripping the AI prompt may have moved indices, so re-locate on
  // the current working copy).
  const workingFixIdx = working.indexOf(proposedFixMarker);
  if (workingFixIdx === -1) {
    return { body: working.trim() };
  }
  const fixOpenIdx = working.lastIndexOf('<details>', workingFixIdx);
  if (fixOpenIdx === -1) {
    return { body: working.trim() };
  }
  const fixEnd = findBalancedDetailsEnd(working, fixOpenIdx);
  const fixContent = working.slice(workingFixIdx + proposedFixMarker.length, fixEnd - '</details>'.length);
  const proposedFix = extractDiffFromFencedBlock(fixContent);

  // Remove the proposed-fix block from the body we return.
  const bodyWithoutFix = (working.slice(0, fixOpenIdx) + working.slice(fixEnd)).trim();
  if (proposedFix === undefined) {
    return { body: bodyWithoutFix };
  }
  return { body: bodyWithoutFix, proposedFix };
}

/**
 * Remove a <details> block whose summary matches the marker from src.
 * Leaves the rest of src untouched. No-op if the marker isn't found.
 */
function stripDetailsBlock(src: string, summaryMarker: string): string {
  const markerIdx = src.indexOf(summaryMarker);
  if (markerIdx === -1) return src;
  const openIdx = src.lastIndexOf('<details>', markerIdx);
  if (openIdx === -1) return src;
  const end = findBalancedDetailsEnd(src, openIdx);
  return src.slice(0, openIdx) + src.slice(end);
}

/**
 * Given the inside of a Proposed-fix details block, extract the first
 * fenced ```diff code block. Returns the raw diff text with no fences.
 * Returns undefined if no diff block is found.
 */
function extractDiffFromFencedBlock(src: string): string | undefined {
  const match = src.match(/```diff\s*\n([\s\S]*?)\n```/);
  if (!match) return undefined;
  return match[1]!;
}

/**
 * Extract a `♻️ Proposed fix` diff from a single comment body (as
 * opposed to a full review body). Used by the adapter to enrich line
 * comments: CodeRabbit's actionable line comments frequently include a
 * proposed-fix diff inline. Returns the raw diff text (no fences) or
 * undefined if no proposed-fix block is present.
 */
export function extractProposedFixFromCommentBody(commentBody: string): string | undefined {
  const marker = '<summary>♻️ Proposed fix</summary>';
  const markerIdx = commentBody.indexOf(marker);
  if (markerIdx === -1) return undefined;
  const openIdx = commentBody.lastIndexOf('<details>', markerIdx);
  if (openIdx === -1) return undefined;
  const end = findBalancedDetailsEnd(commentBody, openIdx);
  const content = commentBody.slice(markerIdx + marker.length, end - '</details>'.length);
  return extractDiffFromFencedBlock(content);
}
