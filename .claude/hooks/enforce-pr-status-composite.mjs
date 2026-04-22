#!/usr/bin/env node
/**
 * PreToolUse hook: force every PR-state read to go through the
 * composite observer (scripts/pr-status.mjs), not ad-hoc gh queries.
 *
 * Why: multiple times in session 2026-04-20/21 the agent polled a
 * single surface (legacy status, or just `pr view --json`) and made
 * decisions on a partial view - missed CodeRabbit completion, missed
 * pre-merge warnings, missed unresolved threads. The canon directive
 * `dev-multi-surface-review-observation` is the belief layer; this
 * hook is the mechanism layer. A PreToolUse hook on Bash fires on
 * every shell call in a Claude Code session, which means the agent
 * CANNOT bypass it by phrasing the query differently.
 *
 * Long-term (per `arch-pr-state-observation-via-actor-only`): session
 * agents should not poll PR state directly at all; the pr-landing
 * actor is the canonical observer. This hook is the bridge - it
 * redirects session polls to the composite CLI, which already exists
 * as a stepping stone to a future `run-pr-landing.mjs --observe-only`
 * invocation. When the actor-invocation form ships, this hook's
 * target command migrates from `pr-status.mjs` to the actor form
 * without any other change.
 *
 * Mechanism (Claude Code PreToolUse protocol):
 *   - Receives JSON on stdin: { tool_name, tool_input, ... }
 *   - For Bash calls whose command looks like a PR-state read,
 *     emit {"decision":"block","reason":"..."} on stdout with
 *     instructive rewrite guidance.
 *   - Everything else: exit 0 silently.
 *
 * Patterns this hook blocks (each checked against every chained
 * clause separately so compound commands do not slip through):
 *   - `gh pr view <N>`                         -> use pr-status.mjs
 *   - `gh pr checks <N>`                       -> use pr-status.mjs
 *   - `gh api ...repos/.../pulls/<N>...`       -> use pr-status.mjs
 *   - `gh api ...commits/.../status`           -> use pr-status.mjs
 *   - `gh api ...commits/.../check-runs`       -> use pr-status.mjs
 *
 * The hook only triggers when the caller is READING STATE. Writes
 * (`pr create`, `pr merge`, `pr comment`, etc.) flow through without
 * interference because they are the actor's legitimate work surface.
 *
 * Escape hatch: append `# allow-partial-pr-read` to the command to
 * explicitly opt out. Narrow use: a test that asserts on a single
 * surface, or a shell-wrapper comparing two commits on one endpoint.
 * The default is enforcement.
 *
 * Scope: only this repo. The hook file lives under `.claude/` which
 * is repo-local. In any other project, the hook does not exist and
 * the rule does not apply.
 *
 * Fail-open: any unexpected input, crash, or parse failure allows the
 * tool call. The hook must never wedge a session.
 */

const ESCAPE_MARKER = '# allow-partial-pr-read';

// Patterns that MATCH a state-read. Each regex runs per-clause.
// The order is broadest-to-narrowest; first match wins.
//
// IMPORTANT: patterns must match state-reads regardless of INVOKER.
// Earlier versions anchored on `\bgh\s+` which only caught bare `gh`,
// letting wrapper invocations like `node scripts/gh-as.mjs lag-ceo
// pr view <N>` slip through (the `-as.mjs` between `gh` and `pr`
// defeats `\s+`). The agent's convention in this repo is to route
// every gh call through gh-as.mjs for bot-identity attribution, so
// EVERY real-world state read flowed past the hook until 2026-04-22.
// Patterns now match on the action shape itself (e.g. `pr view <N>`,
// `/pulls/<N>`, `/commits/<sha>/status`) with wrapper-agnostic
// prefixes: bare `gh`, `gh-as.mjs`, or any other wrapper that ends
// up passing those arguments to `gh`.
//
// The wrapper-agnostic prefix is `(?:^|[\s;&|`(])` - start of line
// or a shell token boundary that is NOT an alphanumeric / hyphen
// (so "git-show" doesn't match "gh"). Each pattern then asserts its
// own shape. Bare `gh` is still included via the same set; we no
// longer need a separate `\bgh\s+` anchor.
const STATE_READ_PATTERNS = [
  {
    // `pr view <N>` - matches `gh pr view 52`, `gh-as.mjs lag-ceo
    // pr view 52`, any wrapper form that passes those args to gh.
    // The preceding token must look like a gh-invocation (bare
    // `gh` or something ending in `gh`/`gh-as.mjs`/`gh.exe`/etc).
    name: 'pr view',
    regex: /(?:^|[\s;&|`(])(?:gh|[\w.\-\/\\]*?gh(?:-as)?\.?m?js?|[\w.\-\/\\]*?gh(?:\.exe)?)(?=\s)[^\n;|&]*?\s+pr\s+view\b/,
    rewrite: (c) => c.replace(/\s+pr\s+view\b/, ' pr-status.mjs <n> # was `pr view`'),
  },
  {
    name: 'pr checks',
    regex: /(?:^|[\s;&|`(])(?:gh|[\w.\-\/\\]*?gh(?:-as)?\.?m?js?|[\w.\-\/\\]*?gh(?:\.exe)?)(?=\s)[^\n;|&]*?\s+pr\s+checks\b/,
    rewrite: (c) => c.replace(/\s+pr\s+checks\b/, ' pr-status.mjs <n> # was `pr checks`'),
  },
  {
    // `api .../pulls/<N>` - state-level read of a PR. Excludes sub-
    // paths that are action surfaces (/comments POST, /reviews POST,
    // /merge PUT). The write-side hook (enforce-lag-ceo-for-gh) gates
    // those separately.
    name: 'api .../pulls/<N>',
    regex: /(?:^|[\s;&|`(])(?:gh|[\w.\-\/\\]*?gh(?:-as)?\.?m?js?|[\w.\-\/\\]*?gh(?:\.exe)?)(?=\s)[^\n;|&]*?\s+api\s+[^\s;|&]*\/pulls\/\d+\b(?!\/(?:comments|replies|reviews|merge))/,
    rewrite: () => 'node scripts/pr-status.mjs <pr-number>',
  },
  {
    name: 'api .../commits/<sha>/status',
    regex: /(?:^|[\s;&|`(])(?:gh|[\w.\-\/\\]*?gh(?:-as)?\.?m?js?|[\w.\-\/\\]*?gh(?:\.exe)?)(?=\s)[^\n;|&]*?\s+api\s+[^\s;|&]*\/commits\/[^\s;|&]+\/status\b/,
    rewrite: () => 'node scripts/pr-status.mjs <pr-number>',
  },
  {
    name: 'api .../commits/<sha>/check-runs',
    regex: /(?:^|[\s;&|`(])(?:gh|[\w.\-\/\\]*?gh(?:-as)?\.?m?js?|[\w.\-\/\\]*?gh(?:\.exe)?)(?=\s)[^\n;|&]*?\s+api\s+[^\s;|&]*\/commits\/[^\s;|&]+\/check-runs\b/,
    rewrite: () => 'node scripts/pr-status.mjs <pr-number>',
  },
];

async function main() {
  let payload;
  try {
    const raw = await readStdin();
    payload = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  if (payload.tool_name !== 'Bash') process.exit(0);

  const command = payload.tool_input?.command;
  if (typeof command !== 'string' || command.length === 0) process.exit(0);

  // Fast path: commands that carry the escape marker bypass.
  if (command.includes(ESCAPE_MARKER)) process.exit(0);

  // Fast path: commands that explicitly invoke the composite CLI
  // are the sanctioned form. Allow.
  if (/\bnode\s+(?:scripts[\/\\])?pr-status\.mjs\b/.test(command)) process.exit(0);

  // Fast path: if the command does not mention gh at all, allow.
  if (!/\bgh\b/.test(command)) process.exit(0);

  // Walk each chained clause independently so a compound command like
  // `cd repo && gh pr view 52` gets caught at the actual gh clause.
  const clauses = command.split(/\s*(?:\|\||&&|;|\|)\s*/);
  for (const clause of clauses) {
    for (const p of STATE_READ_PATTERNS) {
      if (p.regex.test(clause)) {
        const suggested = p.rewrite(clause.trim());
        emitBlock(clause.trim(), p.name, suggested);
        process.exit(0);
      }
    }
  }

  process.exit(0);
}

function emitBlock(offending, patternName, suggested) {
  const reason = [
    `Ad-hoc PR state read blocked by .claude/hooks/enforce-pr-status-composite.mjs.`,
    ``,
    `This repo enforces that EVERY PR-state observation goes through`,
    `the composite read (scripts/pr-status.mjs), not a single-surface`,
    `query. Partial reads produced silent-failure bugs in sessions`,
    `2026-04-20/21 (missed CodeRabbit completion, missed pre-merge`,
    `warnings). Canon directives: dev-multi-surface-review-observation,`,
    `arch-pr-state-observation-via-actor-only.`,
    ``,
    `    MATCHED  : ${patternName}`,
    `    OFFENDING: ${offending}`,
    `    SUGGESTED: ${suggested}`,
    ``,
    `pr-status.mjs prints: mergeable, mergeStateStatus, submitted`,
    `reviews, check-runs, legacy statuses, unresolved line comments,`,
    `and body-scoped nits - all in one call. Use it.`,
    ``,
    `For the rare narrow-read case (test fixtures, single-surface`,
    `comparison), append \`${ESCAPE_MARKER}\` to opt out.`,
  ].join('\n');

  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

main().catch(() => process.exit(0));
