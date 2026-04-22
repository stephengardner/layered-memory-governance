/**
 * Regression tests for .claude/hooks/enforce-lag-ceo-for-gh.mjs.
 *
 * The hook is the mechanical gate that keeps every GitHub-side write
 * the agent makes in this repo routed through lag-ceo[bot]. Two
 * attack surfaces are covered:
 *
 *   1. Bash tool with a raw `gh` CLI call (the original bypass).
 *   2. `mcp__github__*` tools from the GitHub MCP server (the PR #61
 *      bypass, 2026-04-21).
 *
 * The hook is a stdin/stdout protocol: Claude Code writes a JSON
 * payload on stdin and reads optionally a JSON decision on stdout.
 * An empty stdout means "allow". A `{"decision":"block","reason":...}`
 * stdout means the tool call is rejected and the reason surfaces to
 * the agent.
 *
 * These tests spawn the hook as a subprocess and assert the decision
 * output for each payload, so the contract is pinned end-to-end.
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HOOK_PATH = resolve('.claude/hooks/enforce-lag-ceo-for-gh.mjs');

interface HookResult {
  readonly decision: 'block' | 'allow';
  readonly reason: string | null;
  readonly exitCode: number;
}

async function runHook(payload: unknown): Promise<HookResult> {
  const child = spawn('node', [HOOK_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.write(JSON.stringify(payload));
  child.stdin.end();

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
  child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));

  const exitCode: number = await new Promise((res, rej) => {
    child.on('close', (code) => res(code ?? 0));
    child.on('error', rej);
  });

  // The hook is documented as fail-open (exit 0 on any crash) and
  // every success path also exits 0. A non-zero exit means the hook
  // itself crashed in a way that bypasses both the allow and block
  // contracts, which would silently masquerade as "allow" (empty
  // stdout) and make allow-path tests false-positive. Fail hard so
  // the contract is the test's assertion, not an accident of the
  // script's crash behaviour. Surface stderr in the failure message
  // so the cause is visible in CI output.
  const stderr = Buffer.concat(stderrChunks).toString('utf8');
  if (exitCode !== 0) {
    throw new Error(
      `enforce-lag-ceo-for-gh.mjs exited non-zero (${exitCode}); stderr:\n${stderr}`,
    );
  }

  const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
  if (stdout.length === 0) {
    return { decision: 'allow', reason: null, exitCode };
  }
  const parsed = JSON.parse(stdout) as { decision?: string; reason?: string };
  return {
    decision: parsed.decision === 'block' ? 'block' : 'allow',
    reason: parsed.reason ?? null,
    exitCode,
  };
}

describe('enforce-lag-ceo-for-gh hook (Bash path)', () => {
  it('blocks a raw gh pr create invocation', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --title t --body b' },
    });
    expect(result.decision).toBe('block');
    expect(result.reason).toMatch(/gh-as\.mjs lag-ceo/);
    expect(result.exitCode).toBe(0);
  });

  it('blocks gh embedded in a compound command chain', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'cd subdir && gh pr list --json number' },
    });
    expect(result.decision).toBe('block');
  });

  it('allows gh-as.mjs wrapper invocations', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: {
        command: 'node scripts/gh-as.mjs lag-ceo pr create --title t --body b',
      },
    });
    expect(result.decision).toBe('allow');
  });

  it('allows gh-token-for.mjs wrapper invocations', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'node scripts/gh-token-for.mjs lag-cto' },
    });
    expect(result.decision).toBe('allow');
  });

  it('allows the allow-raw-gh escape hatch', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'gh auth status # allow-raw-gh' },
    });
    expect(result.decision).toBe('allow');
  });

  it('allows a Bash command that never mentions gh', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });
    expect(result.decision).toBe('allow');
  });
});

describe('enforce-lag-ceo-for-gh hook (MCP github path)', () => {
  it('blocks mcp__github__create_pull_request (the PR #61 bypass)', async () => {
    const result = await runHook({
      tool_name: 'mcp__github__create_pull_request',
      tool_input: {
        owner: 'stephengardner',
        repo: 'layered-autonomous-governance',
        title: 't',
        body: 'b',
        head: 'feat/x',
        base: 'main',
      },
    });
    expect(result.decision).toBe('block');
    expect(result.reason).toMatch(/gh-as\.mjs lag-ceo/);
    expect(result.reason).toMatch(/PR #61/);
  });

  it('blocks mcp__github__merge_pull_request', async () => {
    const result = await runHook({
      tool_name: 'mcp__github__merge_pull_request',
      tool_input: { owner: 'o', repo: 'r', pullNumber: 1 },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks mcp__github__pull_request_review_write', async () => {
    const result = await runHook({
      tool_name: 'mcp__github__pull_request_review_write',
      tool_input: { owner: 'o', repo: 'r', pullNumber: 1, method: 'create' },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks mcp__github__add_issue_comment', async () => {
    const result = await runHook({
      tool_name: 'mcp__github__add_issue_comment',
      tool_input: { owner: 'o', repo: 'r', issue_number: 1, body: 'b' },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks mcp__github__issue_write', async () => {
    const result = await runHook({
      tool_name: 'mcp__github__issue_write',
      tool_input: { method: 'create' },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks mcp__github__update_pull_request', async () => {
    const result = await runHook({
      tool_name: 'mcp__github__update_pull_request',
      tool_input: { owner: 'o', repo: 'r', pullNumber: 1 },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks mcp__github__push_files', async () => {
    const result = await runHook({
      tool_name: 'mcp__github__push_files',
      tool_input: { owner: 'o', repo: 'r', branch: 'x', files: [] },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks mcp__github__create_branch', async () => {
    const result = await runHook({
      tool_name: 'mcp__github__create_branch',
      tool_input: { owner: 'o', repo: 'r', branch: 'x' },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks an unknown mcp__github__ write (default-deny)', async () => {
    const result = await runHook({
      tool_name: 'mcp__github__mystery_new_write_tool',
      tool_input: {},
    });
    expect(result.decision).toBe('block');
  });

  it('allows mcp__github__list_pull_requests', async () => {
    const result = await runHook({
      tool_name: 'mcp__github__list_pull_requests',
      tool_input: { owner: 'o', repo: 'r' },
    });
    expect(result.decision).toBe('allow');
  });

  it('allows mcp__github__get_me', async () => {
    const result = await runHook({
      tool_name: 'mcp__github__get_me',
      tool_input: {},
    });
    expect(result.decision).toBe('allow');
  });

  it('allows mcp__github__pull_request_read', async () => {
    const result = await runHook({
      tool_name: 'mcp__github__pull_request_read',
      tool_input: { owner: 'o', repo: 'r', pullNumber: 1, method: 'get' },
    });
    expect(result.decision).toBe('allow');
  });

  it('allows mcp__github__issue_read', async () => {
    const result = await runHook({
      tool_name: 'mcp__github__issue_read',
      tool_input: { owner: 'o', repo: 'r', issue_number: 1, method: 'get' },
    });
    expect(result.decision).toBe('allow');
  });

  it('allows mcp__github__search_code', async () => {
    const result = await runHook({
      tool_name: 'mcp__github__search_code',
      tool_input: { query: 'q' },
    });
    expect(result.decision).toBe('allow');
  });

  it('allows mcp__github__get_file_contents', async () => {
    const result = await runHook({
      tool_name: 'mcp__github__get_file_contents',
      tool_input: { owner: 'o', repo: 'r', path: 'x' },
    });
    expect(result.decision).toBe('allow');
  });
});

describe('enforce-lag-ceo-for-gh hook (unrelated tools)', () => {
  it('allows Edit tool calls without inspection', async () => {
    const result = await runHook({
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/x', old_string: 'a', new_string: 'b' },
    });
    expect(result.decision).toBe('allow');
  });

  it('allows tools outside the github namespace', async () => {
    const result = await runHook({
      tool_name: 'mcp__jira__jira_create_issue',
      tool_input: {},
    });
    expect(result.decision).toBe('allow');
  });

  it('fails open on malformed payload', async () => {
    // Sending a non-JSON payload; the hook must not crash the session.
    const child = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.write('not-json{{{');
    child.stdin.end();

    const exitCode: number = await new Promise((res, rej) => {
      child.on('close', (code) => res(code ?? 0));
      child.on('error', rej);
    });
    expect(exitCode).toBe(0);
  });
});

describe('enforce-lag-ceo-for-gh hook (git push attribution)', () => {
  it('blocks a raw `git push`', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git push -u origin my-branch' },
    });
    expect(result.decision).toBe('block');
    expect(result.reason).toMatch(/Raw `git push` blocked/);
    expect(result.reason).toMatch(/git-as\.mjs/);
  });

  it('blocks a raw `git push --force-with-lease`', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git push --force-with-lease origin main' },
    });
    expect(result.decision).toBe('block');
    expect(result.reason).toMatch(/Raw `git push` blocked/);
  });

  it('blocks `git push` in a compound && chain', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git add . && git commit -m x && git push' },
    });
    expect(result.decision).toBe('block');
  });

  it('allows `git-as.mjs` wrapped push', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'node scripts/git-as.mjs lag-ceo push -u origin my-branch' },
    });
    expect(result.decision).toBe('allow');
  });

  it('allows `git-as.mjs` wrapped push with backslash path on Windows', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'node scripts\\git-as.mjs lag-ceo push -u origin my-branch' },
    });
    expect(result.decision).toBe('allow');
  });

  it('allows the `# allow-raw-git-push` escape hatch', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git push --dry-run  # allow-raw-git-push' },
    });
    expect(result.decision).toBe('allow');
  });

  it('allows unrelated git commands (status, log, diff, fetch, add, commit)', async () => {
    const commands = [
      'git status',
      'git log --oneline -5',
      'git diff',
      'git fetch origin',
      'git add .',
      'git commit -m "x"',
      'git rebase origin/main',
      'git switch main',
    ];
    for (const cmd of commands) {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: { command: cmd },
      });
      expect(result.decision, `expected allow for: ${cmd}`).toBe('allow');
    }
  });

  it('mixed chain blocks the raw push clause even when another clause is wrapper-mediated', async () => {
    // If one clause uses the wrapper, that must NOT launder a later
    // raw `git push` in the same compound. Each clause is evaluated
    // on its own; a wrapper-mediated clause earlier does not exempt
    // a raw push at the end.
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: {
        command: 'node scripts/git-as.mjs lag-ceo push origin feat/A && git push origin feat/B',
      },
    });
    expect(result.decision).toBe('block');
    expect(result.reason).toMatch(/Raw `git push` blocked/);
    // The error must cite the RAW clause, not the wrapped one.
    expect(result.reason).toContain('git push origin feat/B');
  });

  it('mixed chain blocks the raw gh clause even when another clause is wrapper-mediated', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: {
        command: 'node scripts/gh-as.mjs lag-ceo pr view 1 && gh pr list',
      },
    });
    expect(result.decision).toBe('block');
    expect(result.reason).toMatch(/Raw `gh` CLI call blocked/);
  });

  it('allows `git pushd` (not actually a push subcommand)', async () => {
    // No such git subcommand exists, but the RAW_GIT_PUSH_PATTERN
    // must require `push` as a token, not a prefix match. A typo or
    // hypothetical plugin named `pushd` should not be flagged.
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git pushd' },
    });
    expect(result.decision).toBe('allow');
  });
});

/*
 * Subshell token-injection bypass tests.
 *
 * Incident (2026-04-21): the agent ran a command of the shape
 *   `GH_TOKEN=$(node scripts/gh-as.mjs lag-ceo auth token) gh pr comment ...`
 * The pre-fix hook matched the wrapper pattern anywhere in the
 * command string and allowed the call, but the OUTER `gh pr comment`
 * ran with whatever GH_TOKEN was produced by the subshell - and on a
 * machine where `gh auth login` has cached an operator-scoped token,
 * the effective auth for the outer `gh` could still be operator-
 * attributed for certain operations.
 *
 * The correct rule: the wrapper must be the PRIMARY INVOCATION, not
 * merely a subshell producing a value. These tests pin that contract.
 */
describe('enforce-lag-ceo-for-gh hook (subshell token-injection bypass)', () => {
  it('blocks GH_TOKEN=$(...gh-as.mjs...) gh pr comment (the 2026-04-21 incident)', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: {
        command: 'GH_TOKEN=$(node scripts/gh-as.mjs lag-ceo auth token) gh pr comment 90 --body "hello"',
      },
    });
    expect(result.decision).toBe('block');
    expect(result.reason).toMatch(/gh/);
  });

  it('blocks GH_TOKEN=$(...gh-as.mjs...) gh pr merge variant', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: {
        command:
          'GH_TOKEN=$(node scripts/gh-as.mjs lag-ceo auth token 2>/dev/null | tail -1) gh pr merge 90 --squash --admin',
      },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks backtick subshell variant: GH_TOKEN=`...gh-as.mjs...` gh pr create', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: {
        command: 'GH_TOKEN=`node scripts/gh-as.mjs lag-ceo auth token` gh pr create --title "x" --body "y"',
      },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks nested subshell: GH_TOKEN=$(echo $(node ...gh-as.mjs...)) gh ...', async () => {
    /*
     * The strip-subshells pass iterates to a fixed point, so the
     * innermost $(...) (where the wrapper lives) is removed. Outer
     * $(echo ...) becomes $(echo) which is also stripped. Bare gh
     * remains and blocks.
     */
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: {
        command: 'GH_TOKEN=$(echo $(node scripts/gh-as.mjs lag-ceo auth token)) gh pr comment 1 --body "x"',
      },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks TOKEN=... variable then gh in a single clause', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: {
        command: 'TOKEN=$(node scripts/gh-as.mjs lag-ceo auth token | tail -1) && GH_TOKEN=$TOKEN gh pr comment 90 --body "x"',
      },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks a git push variant with token subshell', async () => {
    /*
     * `TOKEN=$(...gh-as.mjs...) && git push https://x-access-token:$TOKEN@github.com/... HEAD:branch`
     * The first clause is fine (it's not a gh / git push on its own).
     * The second clause contains raw git push without the git-as.mjs
     * wrapper - block.
     */
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: {
        command:
          'TOKEN=$(node scripts/gh-as.mjs lag-ceo auth token | tail -1) && git push "https://x-access-token:${TOKEN}@github.com/foo/bar.git" HEAD:main',
      },
    });
    expect(result.decision).toBe('block');
  });

  it('still allows a legitimate top-level gh-as.mjs invocation (regression guard)', async () => {
    // The fix must not break the legitimate path: the wrapper AS the
    // primary process.
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: {
        command: 'node scripts/gh-as.mjs lag-ceo pr comment 90 --body "hello"',
      },
    });
    expect(result.decision).toBe('allow');
  });

  it('still allows commands without any gh / git push (regression guard)', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: {
        command: 'TOKEN=$(node scripts/gh-as.mjs lag-ceo auth token) && echo "got token"',
      },
    });
    expect(result.decision).toBe('allow');
  });

  it('blocks the "quoted paren" subshell bypass (CR 2026-04-21 on PR #91)', async () => {
    /*
     * CR review flagged: `$(printf ")" ; node scripts/gh-as.mjs ... auth token) gh ...`
     * The `)` inside the double-quoted printf argument fooled the
     * original non-nested regex `\$\([^()]*\)` into stopping at the
     * wrong paren, leaving `node scripts/gh-as.mjs` visible in the
     * "stripped" text and re-enabling the wrapper whitelist. Fix: the
     * stripSubshells state machine now tracks single/double quotes
     * and balances nested parens, so a quoted `)` no longer closes the
     * subshell prematurely.
     */
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: {
        command: 'GH_TOKEN=$(printf ")" ; node scripts/gh-as.mjs lag-ceo auth token) gh pr comment 1 --body x',
      },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks the "quoted paren" bypass with single-quoted paren variant', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: {
        command: "GH_TOKEN=$(echo ')' ; node scripts/gh-as.mjs lag-ceo auth token) gh pr merge 1 --squash --admin",
      },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks an escaped-paren subshell bypass', async () => {
    /*
     * Escaped `)` inside the subshell should NOT close the subshell.
     */
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: {
        command: 'GH_TOKEN=$(echo \\) ; node scripts/gh-as.mjs lag-ceo auth token) gh pr view 1',
      },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks arbitrarily nested subshells (stripSubshells balances to depth)', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: {
        command: 'GH_TOKEN=$(echo $(echo $(node scripts/gh-as.mjs lag-ceo auth token))) gh pr list --json number',
      },
    });
    expect(result.decision).toBe('block');
  });
});

/*
 * Raw HTTP (curl / wget) to GitHub's API is the third bypass vector.
 * After the hook blocks `gh` (2026-04-21 incident) and `git push`, a
 * determined caller could still issue a mutating HTTP request straight
 * at api.github.com with whatever bearer/Basic auth is in scope, and
 * the call would attribute to whoever owns that token - defeating the
 * rule that the gh / git-push checks enforce.
 *
 * Read-side curl (no -X or explicit -X GET) is NOT blocked because it
 * doesn't change state and carries no attribution risk.
 */
describe('enforce-lag-ceo-for-gh hook (raw HTTP client bypass)', () => {
  it('blocks curl -X POST against api.github.com', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: {
        command:
          'curl -X POST -H "Authorization: token $TOKEN" https://api.github.com/repos/x/y/issues -d \'{"title":"t"}\'',
      },
    });
    expect(result.decision).toBe('block');
    expect(result.reason).toMatch(/HTTP|gh-as.mjs/);
  });

  it('blocks curl --request DELETE against api.github.com', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: {
        command:
          'curl --request DELETE -H "Authorization: Bearer $PAT" https://api.github.com/repos/x/y/issues/comments/1',
      },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks curl -XPATCH (no space after -X) against api.github.com', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: {
        command: 'curl -XPATCH https://api.github.com/repos/x/y -H "Authorization: token $T" -d \'{"name":"z"}\'',
      },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks wget --method=PUT against api.github.com', async () => {
    /*
     * CR review 2026-04-21 (PR #91) flagged that the previous
     * `wget -X POST` test was semantically wrong: wget's -X flag is
     * --exclude-directories, not the HTTP method. Correct wget method
     * flag is --method=<M> with --body-data/--body-file for the body.
     */
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: {
        command: 'wget --method=PUT --body-data=\'{"name":"x"}\' https://api.github.com/repos/x/y',
      },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks wget --post-data against api.github.com', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: {
        command: 'wget --post-data=\'{"title":"t"}\' https://api.github.com/repos/x/y/issues',
      },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks curl -d (implies POST without -X) against api.github.com', async () => {
    /*
     * CR review 2026-04-21 (PR #91): curl -d / --data implies POST
     * without needing -X. The previous method-only check missed this.
     */
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: {
        command: 'curl -d \'{"title":"t"}\' -H "Authorization: token $T" https://api.github.com/repos/x/y/issues',
      },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks curl --data (long form) against api.github.com', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: {
        command: 'curl --data \'{"body":"x"}\' https://api.github.com/repos/x/y/issues/1/comments',
      },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks curl --data-raw / --data-binary / --data-urlencode variants', async () => {
    for (const flag of ['--data-raw', '--data-binary', '--data-urlencode']) {
      const result = await runHook({
        tool_name: 'Bash',
        tool_input: {
          command: `curl ${flag} '{"x":"y"}' https://api.github.com/repos/a/b/issues`,
        },
      });
      expect(result.decision, `flag=${flag}`).toBe('block');
    }
  });

  it('blocks curl -F (form, implies POST) against api.github.com', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: {
        command: 'curl -F "file=@asset.zip" https://api.github.com/repos/a/b/releases/1/assets',
      },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks curl -T (upload-file, implies PUT) against api.github.com', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: {
        command: 'curl -T asset.zip https://api.github.com/repos/a/b/contents/a.txt',
      },
    });
    expect(result.decision).toBe('block');
  });

  it('blocks curl -X POST against github.com (non-api subdomain)', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: {
        command: 'curl -X POST https://github.com/login/oauth/access_token -d "..."',
      },
    });
    expect(result.decision).toBe('block');
  });

  it('allows curl with no mutating method against api.github.com (read)', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: {
        command: 'curl -H "Authorization: token $TOKEN" https://api.github.com/user',
      },
    });
    expect(result.decision).toBe('allow');
  });

  it('allows curl -X GET against api.github.com (explicit read)', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: {
        command: 'curl -X GET https://api.github.com/repos/x/y',
      },
    });
    expect(result.decision).toBe('allow');
  });

  it('allows curl -X POST against a non-github host (out of scope)', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: {
        command: 'curl -X POST https://api.example.com/hook -d "{...}"',
      },
    });
    expect(result.decision).toBe('allow');
  });

  it('allows curl -X POST to github with # allow-raw-http-gh escape hatch', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: {
        command: 'curl -X POST https://api.github.com/repos/x/y/issues -d "{...}" # allow-raw-http-gh',
      },
    });
    expect(result.decision).toBe('allow');
  });

  it('allows gh-as wrapper for the API mutation (the suggested rewrite)', async () => {
    const result = await runHook({
      tool_name: 'Bash',
      tool_input: {
        command: 'node scripts/gh-as.mjs lag-ceo api -X POST /repos/x/y/issues --input issue.json',
      },
    });
    expect(result.decision).toBe('allow');
  });
});
