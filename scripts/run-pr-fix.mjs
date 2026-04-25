#!/usr/bin/env node
/**
 * The pr-fix Actor driver.
 *
 * Composes the framework primitives + the agent-loop substrate adapters
 * into a runnable pr-fix actor. Reads CR review state from a real GitHub
 * PR, classifies it, and -- when fixable findings remain -- dispatches a
 * sub-agent loop in an isolated workspace pinned to the PR's HEAD branch.
 * Verifies the resulting commit-SHA against the workspace HEAD and
 * resolves CR threads only on touched paths.
 *
 * Composition (read top to bottom; it IS the framework claim):
 *   1. Host                   - createFileHost over .lag/ (governance boundary)
 *   2. Principal              - pr-fix-actor from host.principals
 *   3. PrReviewAdapter        - GitHubPrReviewAdapter (D17 seam, shared
 *                               with pr-landing-actor; cheap shared dep).
 *   4. AgentLoopAdapter       - ClaudeCodeAgentLoopAdapter (real CLI;
 *                               substrate primitive owning LLM IO).
 *   5. WorkspaceProvider      - GitWorktreeProvider with checkoutBranch
 *                               support so the worktree pins to the PR's
 *                               HEAD branch.
 *   6. BlobStore              - FileBlobStore at args.blob-root.
 *   7. Redactor               - RegexRedactor with default patterns.
 *   8. Actor                  - PrFixActor (mechanism).
 *   9. runActor               - kill-switch + budget + convergence + policy
 *                               gate + audit trail.
 *
 * Safety rails:
 *   - Dry-run is the DEFAULT. Live writes (push, resolveComment) only
 *     run with --live.
 *   - Kill-switch checks `.lag/STOP`. Touch that file to halt.
 *   - Budget defaults to 3 iterations; per-iteration agent-loop has its
 *     own usd / turn / wall-clock caps below.
 *
 * Usage:
 *   node scripts/run-pr-fix.mjs --pr 1                         # dry-run (default)
 *   node scripts/run-pr-fix.mjs --pr 1 --live                  # actually fixes
 *   node scripts/run-pr-fix.mjs --pr 1 --max-iterations 5
 *   node scripts/run-pr-fix.mjs --pr 1 --max-budget-usd 2.0
 *   node scripts/run-pr-fix.mjs --pr 1 --owner stephengardner --repo layered-autonomous-governance
 */

import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import { createFileHost } from '../dist/adapters/file/index.js';
import { runActor } from '../dist/actors/index.js';
import { PrFixActor } from '../dist/actors/pr-fix/index.js';
import {
  GitHubPrReviewAdapter,
  getTokenFromEnv,
} from '../dist/actors/pr-review/index.js';
import { createGhClient } from '../dist/external/github/index.js';
// Substrate adapters live in examples/* and are NOT currently emitted to
// dist by the project-root tsconfig (rootDir: ./src). The plan explicitly
// flags this path as load-bearing for the driver script; resolution is
// the controller's responsibility (extend tsc include, ship a dedicated
// tsconfig.examples.json, or move the adapters under src/examples/*).
// The import paths below match the spec; they fail-loud at module load
// when the build does not emit them, which is the correct mechanical
// signal that the build path needs to be widened.
import { ClaudeCodeAgentLoopAdapter } from '../dist/examples/agent-loops/claude-code/index.js';
import { FileBlobStore } from '../dist/examples/blob-stores/file/index.js';
import { RegexRedactor } from '../dist/examples/redactors/regex-default/index.js';
import { GitWorktreeProvider } from '../dist/examples/workspace-providers/git-worktree/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');
const STOP_SENTINEL = resolve(STATE_DIR, 'STOP');
const DEFAULT_BLOB_ROOT = resolve(STATE_DIR, 'blobs');
const DEFAULT_WORKSPACE_ROOT = resolve(tmpdir(), 'lag-pr-fix-workspaces');

function parseArgs(argv) {
  const args = {
    prNumber: null,
    owner: null,
    repo: null,
    live: false,
    maxIterations: 3,
    deadlineMs: 60_000,
    principalId: 'pr-fix-actor',
    origin: 'pr-fix-runner',
    maxBudgetUsd: 1.0,
    maxTurns: 30,
    maxWallClockMs: 600_000,
    workspaceRoot: DEFAULT_WORKSPACE_ROOT,
    blobRoot: DEFAULT_BLOB_ROOT,
  };
  const parseInteger = (raw, flag) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      console.error(`ERROR: ${flag} expects a positive integer, got "${raw}".`);
      process.exit(2);
    }
    return n;
  };
  const parsePositiveNumber = (raw, flag) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      console.error(`ERROR: ${flag} expects a positive number, got "${raw}".`);
      process.exit(2);
    }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pr') args.prNumber = parseInteger(argv[++i], '--pr');
    else if (a === '--owner') args.owner = argv[++i];
    else if (a === '--repo') args.repo = argv[++i];
    else if (a === '--live') args.live = true;
    else if (a === '--dry-run') args.live = false;
    else if (a === '--max-iterations') args.maxIterations = parseInteger(argv[++i], '--max-iterations');
    else if (a === '--deadline-ms') args.deadlineMs = parseInteger(argv[++i], '--deadline-ms');
    else if (a === '--principal') args.principalId = argv[++i];
    else if (a === '--origin') args.origin = argv[++i];
    else if (a === '--max-budget-usd') args.maxBudgetUsd = parsePositiveNumber(argv[++i], '--max-budget-usd');
    else if (a === '--max-turns') args.maxTurns = parseInteger(argv[++i], '--max-turns');
    else if (a === '--max-wall-clock-ms') args.maxWallClockMs = parseInteger(argv[++i], '--max-wall-clock-ms');
    else if (a === '--workspace-root') args.workspaceRoot = resolve(argv[++i]);
    else if (a === '--blob-root') args.blobRoot = resolve(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node scripts/run-pr-fix.mjs --pr <n> [--owner o --repo r] [--live|--dry-run]\n'
        + '         [--max-iterations n] [--deadline-ms ms]\n'
        + '         [--max-budget-usd n] [--max-turns n] [--max-wall-clock-ms ms]\n'
        + '         [--workspace-root path] [--blob-root path]\n'
        + '         [--principal pr-fix-actor] [--origin name]\n\n'
        + 'Defaults:\n'
        + '  --max-iterations 3 --deadline-ms 60000\n'
        + '  --max-budget-usd 1.0 --max-turns 30 --max-wall-clock-ms 600000\n'
        + `  --workspace-root ${DEFAULT_WORKSPACE_ROOT}\n`
        + `  --blob-root ${DEFAULT_BLOB_ROOT}\n`
        + '  --principal pr-fix-actor (matches bootstrap-pr-fix-canon.mjs)\n',
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if ((args.owner === null) !== (args.repo === null)) {
    console.error('ERROR: --owner and --repo must be provided together (or neither, for gh repo-view fallback).');
    process.exit(2);
  }
  return args;
}

async function resolveOwnerRepo(args) {
  if (args.owner && args.repo) return { owner: args.owner, repo: args.repo };
  const result = await execa('gh', ['repo', 'view', '--json', 'owner,name'], { reject: false });
  if (result.exitCode !== 0) {
    throw new Error(`Could not resolve owner/repo via gh; pass --owner and --repo explicitly. stderr: ${result.stderr}`);
  }
  const parsed = JSON.parse(result.stdout);
  return { owner: parsed.owner.login, repo: parsed.name };
}

/**
 * Wrap a substrate primitive (BlobStore, Redactor, AgentLoopAdapter,
 * WorkspaceProvider, GhClient) with the `{name, version}` shape every
 * `ActorAdapter` carries. The wrap is non-mutating: a fresh object
 * preserves the original prototype + own properties plus the
 * identification fields.
 *
 * `Object.create(Object.getPrototypeOf(adapter))` preserves the prototype
 * chain so class-backed adapters keep their methods (`run()`, `acquire()`,
 * `release()`, etc.). A plain `{ ...adapter, name, version }` spread copies
 * only own enumerable properties; for class-backed adapters the prototype
 * methods would drop and any caller of e.g. `adapters.agentLoop.run(...)`
 * would fail with "... is not a function" at runtime.
 *
 * Necessary because the substrate primitives are minimal-interface
 * (no name/version on the contract) but `ActorAdapters` carries the
 * shape across the actor boundary so audit + escalation surfaces can
 * cite the adapter that produced an event.
 */
function withAdapterIdentity(adapter, name, version) {
  return Object.assign(
    Object.create(Object.getPrototypeOf(adapter)),
    adapter,
    { name, version },
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.prNumber === null) {
    console.error('ERROR: --pr <number> is required.');
    process.exit(2);
  }
  const { owner, repo } = await resolveOwnerRepo(args);

  const host = await createFileHost({ rootDir: STATE_DIR });

  const principal = await host.principals.get(args.principalId);
  if (!principal) {
    console.error(
      `ERROR: principal '${args.principalId}' not found in ${STATE_DIR}. Run scripts/bootstrap-pr-fix-canon.mjs first.`,
    );
    process.exit(1);
  }

  // Build the framework + substrate adapters.
  // The GhClient is the GitHub transport; PrReviewAdapter wraps it for
  // the multi-surface review observation read.
  const ghClient = createGhClient();
  const reviewAdapter = new GitHubPrReviewAdapter({ client: ghClient, dryRun: !args.live });

  // Substrate primitives. ClaudeCodeAgentLoopAdapter spawns the real
  // Claude Code CLI in agentic-headless mode; FileBlobStore stores
  // tool-call payloads above the blobThreshold; RegexRedactor scrubs
  // secret-shaped strings before atom write.
  const agentLoopAdapter = new ClaudeCodeAgentLoopAdapter({});
  const blobStore = new FileBlobStore(args.blobRoot);
  const redactor = new RegexRedactor();

  // GitWorktreeProvider checks out the PR's existing HEAD branch (per
  // the AcquireInput.checkoutBranch substrate extension) so the agent's
  // commits land on the PR's branch and push back to update the PR.
  // copyCredsForRoles: ['lag-ceo'] mirrors the bot identity used by
  // git-as / gh-as throughout this repo; the worktree's `.lag/apps/`
  // is seeded so the spawned agent's `git push` carries the right
  // credentials.
  const workspaceProvider = new GitWorktreeProvider({
    repoDir: REPO_ROOT,
    copyCredsForRoles: ['lag-ceo'],
    worktreesRoot: args.workspaceRoot,
  });

  // Wrap each adapter with `{name, version}` so the ActorAdapter
  // contract is satisfied; PrReviewAdapter already carries the shape.
  const adapterBag = {
    review: reviewAdapter,
    ghClient: withAdapterIdentity(ghClient, 'gh-client', '0.1.0'),
    agentLoop: withAdapterIdentity(agentLoopAdapter, 'claude-code-agent-loop', '0.1.0'),
    workspaceProvider: withAdapterIdentity(workspaceProvider, 'git-worktree', '0.1.0'),
    blobStore: withAdapterIdentity(blobStore, 'file-blob-store', '0.1.0'),
    redactor: withAdapterIdentity(redactor, 'regex-default-redactor', '0.1.0'),
  };

  // In dry-run mode, gate Bash so the spawned sub-agent cannot shell out
  // to `git push`, `gh pr edit`, or any other write. The actor's
  // SUB_AGENT_DISALLOWED_FLOOR (WebFetch / WebSearch / NotebookEdit) is
  // sized for substrate-level write paths; Bash is the operator-controlled
  // surface that toggles between dry-run and live. The CLI contract
  // ("Dry-run is the DEFAULT") is enforced here, not at the adapter layer
  // (FileBlobStore / GitWorktreeProvider / ClaudeCodeAgentLoopAdapter
  // are dry-run-agnostic substrate primitives; the right place to gate
  // writes is the spawned agent's tool-policy).
  const actor = new PrFixActor({
    pr: { owner, repo, number: args.prNumber },
    additionalDisallowedTools: args.live ? [] : ['Bash'],
    budget: {
      max_turns: args.maxTurns,
      max_wall_clock_ms: args.maxWallClockMs,
      max_usd: args.maxBudgetUsd,
    },
  });

  const deadline = new Date(Date.now() + args.deadlineMs).toISOString();
  const mode = args.live ? 'LIVE' : 'DRY-RUN';
  console.log(`[pr-fix] ${mode} run on ${owner}/${repo}#${args.prNumber} as ${args.principalId}`);
  console.log(`[pr-fix] budget: maxIterations=${args.maxIterations}, deadline=${deadline}`);
  console.log(`[pr-fix] agent-loop budget: max_turns=${args.maxTurns}, max_wall_clock_ms=${args.maxWallClockMs}, max_usd=${args.maxBudgetUsd}`);
  console.log(`[pr-fix] workspaces: ${args.workspaceRoot}`);
  console.log(`[pr-fix] blobs: ${args.blobRoot}`);

  const report = await runActor(actor, {
    host,
    principal,
    adapters: adapterBag,
    budget: { maxIterations: args.maxIterations, deadline },
    origin: args.origin,
    killSwitch: () => existsSync(STOP_SENTINEL),
    onAudit: async (event) => {
      console.log(`[audit] iter=${event.iteration} kind=${event.kind} ${summarize(event.payload)}`);
      await host.auditor.log({
        kind: `actor.${event.kind}`,
        principal_id: event.principal,
        timestamp: event.at,
        refs: {},
        details: {
          actor: event.actor,
          iteration: event.iteration,
          ...event.payload,
        },
      });
    },
  });

  console.log('[pr-fix] --- REPORT ---');
  console.log(JSON.stringify(
    {
      actor: report.actor,
      principal: report.principal,
      haltReason: report.haltReason,
      iterations: report.iterations,
      startedAt: report.startedAt,
      endedAt: report.endedAt,
      escalations: report.escalations,
      lastNote: report.lastNote,
    },
    null,
    2,
  ));

  // Exit-code map mirrors run-pr-landing.mjs:
  //   0 = converged or correctly-halted (escalations are surfaced via
  //       the actor-message channel; CI shouldn't double-signal)
  //   1 = actor crashed (genuine error)
  //   2 = budget exhausted (operator can re-run)
  const exitMap = {
    'converged': 0,
    'policy-escalate-blocking': 0,
    'kill-switch': 0,
    'convergence-loop': 0,
    'budget-iterations': 2,
    'budget-deadline': 2,
    'error': 1,
  };
  process.exit(exitMap[report.haltReason] ?? 1);
}

function summarize(payload) {
  if (!payload) return '';
  const keys = Object.keys(payload);
  if (keys.length === 0) return '';
  const compact = {};
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === 'string') compact[k] = v.length > 60 ? v.slice(0, 60) + '...' : v;
    else if (typeof v === 'number' || typeof v === 'boolean') compact[k] = v;
    else if (Array.isArray(v)) compact[k] = `[${v.length}]`;
    else compact[k] = typeof v;
  }
  return JSON.stringify(compact);
}

main().catch((err) => {
  console.error('[pr-fix] FAILED:', err);
  process.exit(1);
});

// Reference unused tokenAccessor helper so getTokenFromEnv stays a
// known import path; future work will swap GitHubPrReviewAdapter to a
// per-run token provider that calls getTokenFromEnv(...) directly.
void getTokenFromEnv;
