#!/usr/bin/env node
/**
 * PreToolUse hook: enforce lag-ceo bot attribution for every GitHub
 * write the agent makes in this repo.
 *
 * Why: in this repo the operator wants every GitHub-API write action
 * the agent performs (PR create, review reply, merge, issue comment,
 * branch push) to flow through the lag-ceo[bot] installation token
 * via `node scripts/gh-as.mjs lag-ceo ...`, so artifacts never carry
 * the operator's personal login. Without a mechanical check this
 * depends on the agent remembering to prefix commands with gh-as.mjs,
 * which is exactly the kind of discipline the governance layer is
 * supposed to enforce deterministically.
 *
 * Two paths to a GitHub write from the agent:
 *   1. `gh` CLI via the Bash tool.
 *   2. `mcp__github__*` tools from the GitHub MCP server. The MCP
 *      server uses its own configured auth (typically the operator's
 *      personal token on `gh auth login`), which does NOT route
 *      through the lag-ceo installation. Unchecked, PR #61
 *      (2026-04-21) opened under the operator's personal login via
 *      this bypass and had to be closed post-hoc.
 *
 * Mechanism (Claude Code PreToolUse hook protocol):
 *   - Receives JSON on stdin: { tool_name, tool_input, ... }
 *   - For Bash tool calls, inspects tool_input.command for direct
 *     `gh` invocations outside the gh-as.mjs / gh-token-for.mjs
 *     wrappers.
 *   - For mcp__github__* tool calls, allows read-side names
 *     (get_*, list_*, search_*, *_read, get_me) and blocks everything
 *     else as a write-side attribution risk.
 *   - On block, emits {"decision":"block","reason":"..."} on stdout
 *     so Claude Code surfaces the error back to the agent instead of
 *     running under the operator's personal scope.
 *   - Everything else: exit 0 silently.
 *
 * Scope: ONLY this repo. The hook file lives under .claude/ which is
 * repo-local. In any other project, this hook doesn't exist; the
 * agent's GitHub calls run under whatever auth that project allows.
 *
 * Fail-open: any unexpected input / crash / parse failure allows the
 * tool call. The hook must never wedge a session.
 *
 * Escape hatch (Bash path only): if a legitimate workflow needs raw
 * gh (e.g., a test that shells to gh expecting operator scope), add
 * `# allow-raw-gh` on the same line as a comment in the command. The
 * MCP path has no escape hatch - if the MCP route is genuinely needed
 * for a specific case, run the equivalent via gh-as.mjs through Bash.
 */

const ALLOWED_WRAPPER_PATTERNS = [
  // node scripts/gh-as.mjs <role> ... (any role, typically lag-ceo)
  /\bnode\s+(?:scripts[\/\\])?gh-as\.mjs\b/,
  // node scripts/gh-token-for.mjs <role> -> returns raw token only
  /\bnode\s+(?:scripts[\/\\])?gh-token-for\.mjs\b/,
  // Explicit opt-out for narrow legitimate cases.
  /#\s*allow-raw-gh\b/,
];

// Match direct gh invocations. Handles gh / gh.exe, bare or path-prefixed,
// accounting for the most common ways a command gets composed. The check
// runs per-statement so chained commands (`foo && gh ...`) are all
// inspected.
const RAW_GH_PATTERN = /(^|[\s;&|`(])(?:\.\/|\.\\)?gh(?:\.exe)?(?:\s|$)/;

const MCP_GITHUB_PREFIX = 'mcp__github__';

// Read-side MCP github tool names (no attribution risk). Any
// mcp__github__* NAME not matched by READ_PATTERNS or this explicit
// allow list is treated as a write and blocked.
const READ_ONLY_EXPLICIT = new Set([
  'get_me',
  'get_commit',
  'get_file_contents',
  'get_label',
  'get_latest_release',
  'get_release_by_tag',
  'get_tag',
  'get_team_members',
  'get_teams',
  'issue_read',
  'pull_request_read',
  'list_branches',
  'list_commits',
  'list_issue_types',
  'list_issues',
  'list_pull_requests',
  'list_releases',
  'list_tags',
  'search_code',
  'search_issues',
  'search_pull_requests',
  'search_repositories',
  'search_users',
]);

const READ_PATTERNS = [/^get_/, /^list_/, /^search_/, /_read$/];

async function main() {
  let payload;
  try {
    const raw = await readStdin();
    payload = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : '';

  if (toolName === 'Bash') {
    inspectBash(payload);
    process.exit(0);
  }

  if (toolName.startsWith(MCP_GITHUB_PREFIX)) {
    inspectMcpGithub(toolName);
    process.exit(0);
  }

  process.exit(0);
}

function inspectBash(payload) {
  const command = payload.tool_input?.command;
  if (typeof command !== 'string' || command.length === 0) return;

  // Fast path: if gh is not mentioned at all, allow.
  if (!/\bgh(?:\.exe)?\b/.test(command)) return;

  // If the command is explicitly using one of the allowed wrappers
  // OR contains the allow-raw-gh escape hatch, allow.
  for (const p of ALLOWED_WRAPPER_PATTERNS) {
    if (p.test(command)) return;
  }

  // Inspect each ; / && / || -separated clause individually so a
  // compound command like `cd repo && gh pr list` gets caught at the
  // actual gh clause instead of getting false-allowed by something
  // earlier in the chain.
  const clauses = command.split(/\s*(?:\|\||&&|;)\s*/);
  const offending = clauses.find((c) => RAW_GH_PATTERN.test(c));
  if (offending === undefined) return;

  const reason = [
    `Raw \`gh\` CLI call blocked by .claude/hooks/enforce-lag-ceo-for-gh.mjs.`,
    ``,
    `This repo enforces that every GitHub API action flows through the`,
    `lag-ceo[bot] identity (operator's human-proxy) so artifacts never`,
    `carry the operator's personal login. Rewrite the command:`,
    ``,
    `    FROM:  ${offending.trim()}`,
    `    TO  :  node scripts/gh-as.mjs lag-ceo ${stripGhPrefix(offending.trim())}`,
    ``,
    `Or, if the call is for a decision-bearing operation (opens a PR`,
    `for a CTO-authored plan, posts a CodeRabbit reply as the CTO):`,
    `use lag-cto instead of lag-ceo.`,
    ``,
    `For a narrowly-scoped legitimate case (e.g. a test that must run`,
    `under operator scope), append \`# allow-raw-gh\` to the command.`,
  ].join('\n');

  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

function inspectMcpGithub(toolName) {
  const suffix = toolName.slice(MCP_GITHUB_PREFIX.length);

  if (isMcpGithubRead(suffix)) return;

  const reason = [
    `MCP GitHub write tool '${toolName}' blocked by .claude/hooks/enforce-lag-ceo-for-gh.mjs.`,
    ``,
    `This repo enforces that every GitHub write action flows through the`,
    `lag-ceo[bot] identity so artifacts never carry the operator's`,
    `personal login. MCP GitHub tools use the server's configured auth,`,
    `which does NOT route through the lag-ceo installation token; a call`,
    `via this route will attribute the PR / comment / merge to the`,
    `operator's personal account. PR #61 (2026-04-21) is the incident.`,
    ``,
    `Use the gh-as.mjs wrapper via Bash instead. Examples:`,
    ``,
    `    mcp__github__create_pull_request         ->`,
    `      node scripts/gh-as.mjs lag-ceo pr create --title ... --body-file ...`,
    `    mcp__github__merge_pull_request          ->`,
    `      node scripts/gh-as.mjs lag-ceo pr merge <n> --squash --admin`,
    `    mcp__github__add_issue_comment           ->`,
    `      node scripts/gh-as.mjs lag-ceo pr comment <n> --body-file ...`,
    `    mcp__github__pull_request_review_write   ->`,
    `      node scripts/gh-as.mjs lag-ceo api -X POST /repos/{owner}/{repo}/pulls/{n}/reviews --input -`,
    `    mcp__github__update_pull_request         ->`,
    `      node scripts/gh-as.mjs lag-ceo pr edit <n> --title ... --body-file ...`,
    ``,
    `For decision-bearing operations (CTO plan landing, CR reply as`,
    `CTO), use lag-cto instead of lag-ceo.`,
  ].join('\n');

  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

function isMcpGithubRead(suffix) {
  if (READ_ONLY_EXPLICIT.has(suffix)) return true;
  for (const p of READ_PATTERNS) {
    if (p.test(suffix)) return true;
  }
  return false;
}

function stripGhPrefix(clause) {
  // Best-effort: strip the leading `gh` token so the suggested
  // rewrite reads cleanly. Preserves args.
  return clause.replace(/^(?:\.\/|\.\\)?gh(?:\.exe)?\s+/, '').trim();
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

main().catch(() => process.exit(0));
