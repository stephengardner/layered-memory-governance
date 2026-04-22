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

// Wrappers that authenticate git push under a bot App installation
// token (see scripts/git-as.mjs). Raw `git push` uses the system
// credential helper, which on this machine caches the operator's
// personal PAT and attributes the push event to the operator.
const ALLOWED_GIT_WRAPPER_PATTERNS = [
  /\bnode\s+(?:scripts[\/\\])?git-as\.mjs\b/,
  /#\s*allow-raw-git-push\b/,
];

// Match direct gh invocations. Handles gh / gh.exe, bare or path-prefixed,
// accounting for the most common ways a command gets composed. The check
// runs per-statement so chained commands (`foo && gh ...`) are all
// inspected.
const RAW_GH_PATTERN = /(^|[\s;&|`(])(?:\.\/|\.\\)?gh(?:\.exe)?(?:\s|$)/;

// Match direct `git push` (only push; other git subcommands like
// status / diff / log / add / commit / rebase are local-only and
// never touch GitHub's pusher attribution). Handles `git push`,
// `git.exe push`, path-prefixed variants, and any subcommand form
// of push (e.g. `git push --force-with-lease`, `git push origin`).
const RAW_GIT_PUSH_PATTERN = /(^|[\s;&|`(])(?:\.\/|\.\\)?git(?:\.exe)?\s+(?:-[^\s]+\s+)*push(?:\s|$)/;

// Match direct curl / wget invocations that issue a mutating HTTP
// request to GitHub's API host. Third bypass vector after `gh` CLI
// (2026-04-21 incident) and `git push`. Without this check, a
// determined caller could hit api.github.com directly with whatever
// bearer/Basic auth is in scope and attribute the write to whoever
// owns that token. The agent should use
//   node scripts/gh-as.mjs lag-ceo api -X POST /repos/...
// which wraps `gh api` with the bot installation token.
//
// Block criteria require BOTH:
//   (1) a mutating HTTP method (-X POST/PUT/PATCH/DELETE or
//       --request POST/PUT/PATCH/DELETE)
//   (2) a target host matching github.com or api.github.com
// Reads (GET, or no -X at all) against api.github.com stay allowed
// because they don't change state and carry no attribution risk.
// Escape hatch: `# allow-raw-http-gh`.
const RAW_HTTP_CLIENT_PATTERN = /(^|[\s;&|`(])(?:\.\/|\.\\)?(?:curl|wget)(?:\.exe)?(?:\s|$)/;

// Explicit HTTP method: curl -X / --request, and wget --method=.
// (Note: wget's -X flag is --exclude-directories, NOT the method;
// the previous pattern was semantically wrong per CR 2026-04-21.)
const HTTP_MUTATING_METHOD_PATTERN = /(?:-X\s*|--request\s+|--method[=\s]+)(?:POST|PUT|PATCH|DELETE)\b/i;

// Body-supplying flags that IMPLY a write even without an explicit
// -X. curl defaults to POST when given -d / --data* / -F / --form,
// and to PUT when given -T / --upload-file. wget has --post-data /
// --post-file (POST) and --body-data / --body-file (pairs with
// --method=). CR review 2026-04-21 (PR #91) flagged that a
// method-only check missed `curl -d '{...}' api.github.com`.
const HTTP_BODY_IMPLIES_WRITE_PATTERN = /(?:^|[\s;&|`(])(?:-d|--data(?:-raw|-binary|-urlencode|-ascii)?|-F|--form|--form-string|-T|--upload-file|--post-data|--post-file|--body-data|--body-file)(?:[\s=]|$)/;

const GITHUB_HOST_PATTERN = /\b(?:api\.)?github\.com\b/;
const ALLOWED_HTTP_GH_PATTERNS = [/#\s*allow-raw-http-gh\b/];

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

/*
 * Strip subshell substitutions from a command string so the "does
 * the wrapper run the OUTER command" check is not fooled by a
 * wrapper that only ran inside `$(...)` or backticks.
 *
 * Incident (2026-04-21): agent ran
 *   `GH_TOKEN=$(node scripts/gh-as.mjs lag-ceo auth token) gh pr comment ...`
 * The hook saw `gh-as.mjs` in the string, matched the wrapper
 * pattern, and allowed the call. But the OUTER `gh pr comment` ran
 * with whatever GH_TOKEN env it got, and on Windows where `gh` is
 * also auth-persisted via `gh auth login` to the operator's account
 * the effective attribution routed to the operator for some calls.
 *
 * After this strip, the same input becomes
 *   `GH_TOKEN= gh pr comment ...`
 * which contains a bare `gh` and NO wrapper pattern, so it blocks.
 *
 * We iterate to a fixed point to handle nested substitutions up to
 * the limit of the regex's balanced-paren tolerance. The regex
 * matches `$( ... )` without nested parens and backtick blocks; a
 * crafted `$(echo $(...))` falls through the first pass but the
 * inner substitution (the part we care about — the place a wrapper
 * would run to produce a token) is stripped on some iteration.
 */
function stripSubshells(s) {
  const n = s.length;
  let out = '';
  let i = 0;
  while (i < n) {
    const c = s[i];

    // Single-quoted string: bash treats the body as literal; no
    // metachars active, no backslash escape. Copy the whole span
    // verbatim so the inner content stays visible to the check.
    if (c === "'") {
      out += c;
      i++;
      while (i < n && s[i] !== "'") {
        out += s[i];
        i++;
      }
      if (i < n) {
        out += s[i];
        i++;
      }
      continue;
    }

    // $( ... ) - balanced-paren scan, quote-aware. Skipped entirely
    // (not appended to `out`) so the check sees as if the subshell
    // never existed. CR review 2026-04-21 flagged that the previous
    // regex `\$\([^()]*\)` failed on `$(printf ")" ; node ...)` because
    // the `)` inside the string literal closed the match early, leaving
    // `node scripts/gh-as.mjs` visible in the "stripped" text and
    // re-enabling the wrapper whitelist.
    if (c === '$' && s[i + 1] === '(') {
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        const ch = s[i];
        if (ch === "'") {
          // Quoted literal inside the subshell: any `)` here is part
          // of the string, not a paren.
          i++;
          while (i < n && s[i] !== "'") i++;
          if (i < n) i++;
          continue;
        }
        if (ch === '"') {
          // Double-quoted: find matching unescaped `"` and continue.
          i++;
          while (i < n && s[i] !== '"') {
            if (s[i] === '\\' && i + 1 < n) i++;
            i++;
          }
          if (i < n) i++;
          continue;
        }
        if (ch === '\\' && i + 1 < n) {
          // Escaped char: advance past so an escaped `)` does not
          // close the subshell prematurely.
          i += 2;
          continue;
        }
        if (ch === '(') { depth++; i++; continue; }
        if (ch === ')') { depth--; i++; continue; }
        i++;
      }
      continue;
    }

    // Backtick substitution.
    if (c === '`') {
      i++;
      while (i < n && s[i] !== '`') {
        if (s[i] === '\\' && i + 1 < n) i++;
        i++;
      }
      if (i < n) i++;
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

function inspectBash(payload) {
  const command = payload.tool_input?.command;
  if (typeof command !== 'string' || command.length === 0) return;

  /*
   * All subsequent checks operate on the subshell-stripped form. The
   * wrapper pattern must appear at the TOP LEVEL of the clause, not
   * inside a `$(...)` that merely produces an env value for a bare
   * `gh` invocation.
   */
  const stripped = stripSubshells(command);
  const clauses = stripped.split(/\s*(?:\|\||&&|;)\s*/);

  // `git push` attribution check. Raw push uses the system credential
  // helper (operator PAT on this machine); the push event's pusher
  // is then recorded as the operator. git-as.mjs threads an App
  // installation token via env-injected git config so the pusher is
  // the bot instead. Block anything else.
  //
  // Scope the wrapper check to the offending CLAUSE, not the whole
  // command. A compound like
  //   `node scripts/git-as.mjs lag-ceo push ...; git push --force`
  // must NOT be allowed just because an earlier clause was
  // wrapper-mediated: the raw push at the end still leaks operator
  // identity. Each clause that contains `git push` must itself be
  // wrapped (or carry the `# allow-raw-git-push` escape hatch).
  const offendingPush = clauses.find(
    (c) => RAW_GIT_PUSH_PATTERN.test(c)
      && !ALLOWED_GIT_WRAPPER_PATTERNS.some((p) => p.test(c)),
  );
  if (offendingPush !== undefined) {
    const reason = [
      `Raw \`git push\` blocked by .claude/hooks/enforce-lag-ceo-for-gh.mjs.`,
      ``,
      `Commit authorship is already the bot via local git config, but`,
      `the PUSH authenticates via the system credential helper, which`,
      `caches the operator's personal PAT. GitHub records the pusher`,
      `of the push event as whoever owns that token - leaking operator`,
      `identity on every force-push / new-branch push.`,
      ``,
      `Rewrite:`,
      ``,
      `    FROM:  ${offendingPush.trim()}`,
      `    TO  :  node scripts/git-as.mjs lag-ceo ${stripGitPrefix(offendingPush.trim())}`,
      ``,
      `For a narrowly-scoped legitimate case (e.g. pushing a local`,
      `branch that must be under operator identity), append`,
      `\`# allow-raw-git-push\` to the offending clause.`,
    ].join('\n');
    process.stdout.write(JSON.stringify({ decision: 'block', reason }));
    return;
  }

  // curl / wget against github.com or api.github.com with a mutating
  // HTTP method. Third bypass vector after `gh` CLI and `git push`.
  // Same per-clause discipline: each clause that makes a GitHub HTTP
  // mutation must carry the escape hatch or use the gh-as.mjs api
  // wrapper. Read-only calls (no -X or explicit -X GET) are allowed.
  const offendingHttp = clauses.find(
    (c) => RAW_HTTP_CLIENT_PATTERN.test(c)
      && (HTTP_MUTATING_METHOD_PATTERN.test(c) || HTTP_BODY_IMPLIES_WRITE_PATTERN.test(c))
      && GITHUB_HOST_PATTERN.test(c)
      && !ALLOWED_HTTP_GH_PATTERNS.some((p) => p.test(c)),
  );
  if (offendingHttp !== undefined) {
    const reason = [
      `Raw mutating HTTP call to GitHub blocked by .claude/hooks/enforce-lag-ceo-for-gh.mjs.`,
      ``,
      `The clause below issues a POST/PUT/PATCH/DELETE against github.com`,
      `or api.github.com without routing through the lag-ceo[bot] wrapper.`,
      `Whatever bearer/Basic auth that curl/wget picks up attributes the`,
      `write to its owner - typically the operator's cached PAT on this`,
      `machine, which defeats the same rule that blocks raw \`gh\` and`,
      `\`git push\`.`,
      ``,
      `Rewrite via the gh-as.mjs api wrapper (handles the token):`,
      ``,
      `    node scripts/gh-as.mjs lag-ceo api -X POST /repos/OWNER/REPO/... --input -`,
      ``,
      `For a narrowly-scoped legitimate case (webhook test, audit tool),`,
      `append \`# allow-raw-http-gh\` to the offending clause.`,
      ``,
      `Offending clause: ${offendingHttp.trim()}`,
    ].join('\n');
    process.stdout.write(JSON.stringify({ decision: 'block', reason }));
    return;
  }

  // Fast path: if gh is not mentioned at all (after stripping
  // subshells, so a wrapper-inside-$(...) doesn't leave `gh-as.mjs`
  // for the substring scan to see and shortcircuit), skip the check.
  if (!/\bgh(?:\.exe)?\b/.test(stripped)) return;

  // Scope the wrapper check to the offending CLAUSE, matching the
  // per-clause discipline above: a wrapper on one clause does not
  // exempt a raw `gh` on another clause from attribution rules.
  const offending = clauses.find(
    (c) => RAW_GH_PATTERN.test(c)
      && !ALLOWED_WRAPPER_PATTERNS.some((p) => p.test(c)),
  );
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

function stripGitPrefix(clause) {
  // Strip the leading `git` token so the suggested rewrite reads
  // cleanly. Preserves args.
  return clause.replace(/^(?:\.\/|\.\\)?git(?:\.exe)?\s+/, '').trim();
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

main().catch(() => process.exit(0));
