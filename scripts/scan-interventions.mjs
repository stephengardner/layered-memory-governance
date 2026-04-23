/**
 * Intervention scanner.
 *
 * Sweeps a JSONL session log (or a directory of them) for operator
 * course-correction prompts. The heuristic is deliberately conservative:
 * only user turns that FOLLOW an assistant turn containing a `tool_use`
 * content block are considered - initial task prompts and mid-turn
 * clarifications without a prior tool call are skipped.
 *
 * A course-correction is flagged when the user prompt contains one of
 * COURSE_CORRECT_PATTERN's keywords. The keyword list biases recall
 * over precision at this stage; the spec's week-2 tuning gate (label 50
 * samples and require precision >= 0.7) drives later tightening.
 *
 * Output:
 *   - Programmatic: `scanJsonl(path) -> Promise<Result[]>` for use by
 *     tests and downstream tooling.
 *   - CLI: writes a markdown proposals file under
 *     `.lag/pending-canon-proposals/<date>.md` for the Friday ritual.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Keywords that, after a tool_use, typically mark a course-correction.
// Tuned on the synthetic fixture + operator's accumulated feedback
// patterns ("no", "actually", "don't", "wrong", "fix", etc.).
// Precision tuning continues in Phase 4 via the real-data label pass.
//
// The "no" branch is factored out of the main alternation because the
// word-boundary `\b` does not recognise a word->comma transition, so
// `\b(no,|...)\b` silently misses "no, write the failing test first"
// (the exact shape operators type when correcting course). Allow the
// bare word "no" with an optional trailing comma instead.
const COURSE_CORRECT_PATTERN =
  /(?:\bno\b,?|\b(?:actually|include|don'?t|stop|fix|wrong|not\s+this|rework|reject|should\s+have)\b)/i;

/**
 * @typedef {Object} InterventionResult
 * @property {'course-correction'} type
 * @property {string} prompt
 * @property {string} timestamp
 * @property {string} session
 */

/**
 * Scan a single JSONL file for course-corrections.
 *
 * @param {string} jsonlPath
 * @returns {Promise<InterventionResult[]>}
 */
export async function scanJsonl(jsonlPath) {
  const results = [];
  let raw;
  try {
    raw = fs.readFileSync(jsonlPath, 'utf8');
  } catch (err) {
    // If the file vanished mid-scan, return empty rather than crash
    // the whole sweep; a missing file is a non-fatal condition for the
    // Friday-ritual path.
    if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) return [];
    throw err;
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  let lastAssistantHadToolUse = false;
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      // Skip malformed lines silently; real session logs sometimes
      // contain partial final lines from crashed writers.
      continue;
    }
    if (rec.type === 'assistant') {
      const content = rec.message?.content;
      lastAssistantHadToolUse = Array.isArray(content)
        ? content.some((b) => b && b.type === 'tool_use')
        : false;
      continue;
    }
    if (rec.type !== 'user') {
      // Non-user/non-assistant records (attachments, file-history-snapshot,
      // permission-mode) do NOT reset the lastAssistantHadToolUse flag; the
      // operator's corrective message arrives a few records after the
      // tool_use in practice.
      continue;
    }
    const userText = extractUserText(rec);
    if (!userText) continue;
    if (lastAssistantHadToolUse && COURSE_CORRECT_PATTERN.test(userText)) {
      results.push({
        type: 'course-correction',
        prompt: userText.slice(0, 500),
        timestamp: typeof rec.timestamp === 'string' ? rec.timestamp : '',
        session: typeof rec.sessionId === 'string' ? rec.sessionId : '',
      });
    }
    // Intentionally DO NOT reset lastAssistantHadToolUse here. Operators
    // often send multiple user turns in succession ("ok", then "wait,
    // actually wrong - ..."). All of them are legitimate follow-ups on
    // the same tool_use; only a new assistant turn updates the flag.
  }
  return results;
}

function extractUserText(rec) {
  const content = rec.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : ''))
      .filter((s) => s.length > 0)
      .join(' ');
  }
  return '';
}

/**
 * CLI entrypoint. Accepts a file OR directory path and writes a
 * consolidated markdown report. Kept out of the default export surface
 * so tests can import scanJsonl without triggering fs writes.
 */
async function main() {
  const target = process.argv[2] ?? process.env.LAG_SESSIONS_DIR;
  if (!target) {
    console.error('Usage: node scripts/scan-interventions.mjs <jsonl-path-or-dir>');
    process.exit(2);
  }
  const stat = fs.statSync(target);
  const files = stat.isDirectory()
    ? fs
        .readdirSync(target)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => path.join(target, f))
    : [target];
  const all = [];
  for (const f of files) {
    const hits = await scanJsonl(f);
    all.push(...hits);
  }
  const outDir = '.lag/pending-canon-proposals';
  const outFile = path.join(outDir, `${new Date().toISOString().slice(0, 10)}.md`);
  fs.mkdirSync(outDir, { recursive: true });
  const md = renderProposals(all);
  fs.writeFileSync(outFile, md);
  console.log(`Wrote ${all.length} candidates to ${outFile}`);
}

function renderProposals(results) {
  if (results.length === 0) {
    return '# Pending canon proposals\n\n_No course-corrections detected._\n';
  }
  const sections = results.map(
    (r) =>
      `## ${r.timestamp || '(no timestamp)'}\n\nSession: ${r.session || '(unknown)'}\n\n> ${r.prompt.replace(/\n/g, '\n> ')}\n\nProposed canon atom: TBD\n\n---\n`,
  );
  return `# Pending canon proposals\n\n${sections.join('\n')}`;
}

// Execute only when invoked as CLI, not when imported as a module.
// Using fileURLToPath + path.resolve for a cross-platform robust
// comparison. The earlier `import.meta.url.endsWith(... ?? '')` shape
// was buggy: when `process.argv[1]` was undefined, the fallback `''`
// made `endsWith('')` always true, so main() ran during any import -
// writing files into .lag/pending-canon-proposals/ as a side effect.
// The fix fails closed: require argv[1] to resolve to this exact
// script file before invoking main().
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
