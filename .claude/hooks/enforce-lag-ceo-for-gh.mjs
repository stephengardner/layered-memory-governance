#!/usr/bin/env node
/**
 * PreToolUse hook: enforce lag-ceo bot attribution for every `gh` CLI
 * call the agent makes in this repo.
 *
 * Why: in this repo the operator wants every GitHub-API action the
 * agent performs (PR create, review reply, merge, issue comment) to
 * flow through the lag-ceo[bot] installation token via
 * `node scripts/gh-as.mjs lag-ceo ...`, so artifacts never carry the
 * operator's personal login. Without a mechanical check this depends
 * on the agent remembering to prefix commands with gh-as.mjs, which
 * is exactly the kind of discipline the governance layer is supposed
 * to enforce deterministically.
 *
 * Mechanism (Claude Code PreToolUse hook protocol):
 *   - Receives JSON on stdin: { tool_name, tool_input, ... }
 *   - For Bash tool calls, inspects tool_input.command.
 *   - If the command invokes the `gh` CLI directly (and NOT through
 *     gh-as.mjs / gh-token-for.mjs / inside a comment / as a
 *     non-command token), emit:
 *       {"decision":"block","reason":"..."} on stdout
 *     so Claude Code surfaces the error back to the agent instead of
 *     running gh with the operator's personal scope.
 *   - Everything else: exit 0 silently.
 *
 * Scope: ONLY this repo. The hook file lives under .claude/ which is
 * repo-local. In any other project, this hook doesn't exist; the
 * agent's `gh` calls run under the operator's normal gh-auth.
 *
 * Fail-open: any unexpected input / crash / parse failure allows the
 * tool call. The hook must never wedge a session.
 *
 * Escape hatch: if a legitimate workflow needs raw gh (e.g., a test
 * that shells to gh expecting operator scope), add `# allow-raw-gh`
 * on the same line as a comment in the command. The hook matches
 * that suffix verbatim and allows through. Intended use is narrow;
 * the default is enforcement.
 */

import { readFile } from 'node:fs/promises';

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

  // Fast path: if gh is not mentioned at all, allow.
  if (!/\bgh(?:\.exe)?\b/.test(command)) process.exit(0);

  // If the command is explicitly using one of the allowed wrappers
  // OR contains the allow-raw-gh escape hatch, allow.
  for (const p of ALLOWED_WRAPPER_PATTERNS) {
    if (p.test(command)) process.exit(0);
  }

  // Inspect each ; / && / || -separated clause individually so a
  // compound command like `cd repo && gh pr list` gets caught at the
  // actual gh clause instead of getting false-allowed by something
  // earlier in the chain.
  const clauses = command.split(/\s*(?:\|\||&&|;)\s*/);
  const offending = clauses.find((c) => RAW_GH_PATTERN.test(c));
  if (offending === undefined) process.exit(0);

  // Emit block decision. Claude Code forwards `reason` back into the
  // conversation; make it instructive so the agent rewrites the call.
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
  process.exit(0);
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
