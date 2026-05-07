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
 *   4. AgentLoopAdapter       - wrapAgentLoopAdapterIfEnabled gates the
 *                               ResumeAuthorAgentLoopAdapter wrap on
 *                               the per-actor canon policy atom
 *                               `pol-resume-strategy-pr-fix-actor`.
 *                               When the policy is present + valid +
 *                               enabled=true, the bridge wraps the
 *                               ClaudeCodeAgentLoopAdapter (fresh-spawn
 *                               fallback) with strategies tried in
 *                               order; today only same-machine CLI is
 *                               wired. When the policy is absent /
 *                               disabled / malformed, the bridge
 *                               returns the fresh adapter unchanged
 *                               (fail-closed). Run
 *                               `node scripts/bootstrap-pol-resume-strategy.mjs`
 *                               once per deployment to land the seeded
 *                               PR #171-equivalent posture.
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
import {
  buildDefaultRegistry,
  SameMachineCliResumeStrategy,
  validatePolicy,
  walkAuthorSessionsForPrFix,
  wrapAgentLoopAdapterIfEnabled,
} from '../dist/examples/agent-loops/resume-author/index.js';
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
  const freshAgentLoop = new ClaudeCodeAgentLoopAdapter({});
  const blobStore = new FileBlobStore(args.blobRoot);
  const redactor = new RegexRedactor();

  // Phase 3 registry-based wrapping (PR #308): construct the default
  // resume-strategy registry, consult the per-actor canon policy via a
  // RegistryHost canon-read indirection, and wrap the fresh-spawn
  // adapter with `ResumeAuthorAgentLoopAdapter` ONLY when
  // `pol-resume-strategy-pr-fix-actor` is present in canon and
  // `enabled: true` (validated against the registry's Zod schema).
  // When the policy is absent / disabled / malformed, the bridge
  // returns the fresh adapter unchanged (fail-closed).
  //
  // The bridge mirrors PR #171 behavior when the policy seed exists
  // (run `node scripts/bootstrap-pol-resume-strategy.mjs` once per
  // deployment to land the seeded shape); removing the policy atom
  // flips PR-fix back to fresh-spawn with no code change.
  //
  // Strategy ladder remains [SameMachineCliResumeStrategy] in the
  // reference driver; an operator wanting cross-machine session
  // capture copies this driver and explicitly opts into
  // BlobShippedSessionResumeStrategy via its four construction
  // guards. The descriptor's `ladder` is empty (per PR #307
  // convention); the runner builds strategies here, parameterized by
  // the canon policy's optional `max_stale_hours` field with the
  // SameMachineCliResumeStrategy default (8h) as the floor.
  //
  // assembleCandidates is invoked once per `agentLoop.run(input)` call
  // by the wrapper. The closure pre-fetches recent observations +
  // their dispatched agent-session atoms scoped to the current PR
  // identity, then delegates to the registered descriptor's
  // synchronous walker (`walkAuthorSessionsForPrFix`). Two-axis filter
  // (`principal_id === 'pr-fix-actor'` AND PR identity matches) is
  // enforced by the walker per spec section 8.3.
  const registry = buildDefaultRegistry(host);

  // Read canon policy via the host's atom store. Per the bootstrap
  // script, the policy payload lives at
  // `metadata.policy.content` on the `pol-resume-strategy-<principal>`
  // atom; the bridge's `policyEnables` validates the payload against
  // the Zod schema and returns false on any mismatch (fail-closed).
  // The canon-read closure is synchronous because `wrapIfEnabled`'s
  // construction-time read fires once per runner invocation; the
  // host.atoms cache means no I/O cost per `acquire`.
  const policyAtomCacheById = new Map();
  for (const policyId of [`pol-resume-strategy-${args.principalId}`]) {
    const stored = await host.atoms.get(policyId);
    policyAtomCacheById.set(policyId, stored);
  }
  const registryHost = {
    registry,
    canon: {
      read: (key) => {
        const atom = policyAtomCacheById.get(key);
        if (!atom) return undefined;
        const policy = atom?.metadata?.policy;
        return policy?.content;
      },
    },
  };

  // Strategy ladder: parameterized by canon policy's optional
  // `max_stale_hours` if validated. The validator returns null on
  // malformed input; in that case the bridge already short-circuits
  // to fresh-spawn so the value here is never consulted.
  const policyContent = registryHost.canon.read(`pol-resume-strategy-${args.principalId}`);
  const validated = validatePolicy(policyContent);
  const strategies = [
    new SameMachineCliResumeStrategy({
      maxStaleHours: validated?.max_stale_hours ?? 8,
    }),
  ];

  // assembleCandidates closure: pre-fetch observations + sessions, then
  // delegate to the registered descriptor's synchronous walker.
  const assembleCandidates = async (_input) => {
    const recent = await host.atoms.query({ type: ['observation'] }, 50);
    // Filter observations to pr-fix-actor's atoms scoped to the current
    // PR identity. The walker enforces the same two-axis filter again
    // for defense-in-depth; this pre-filter shrinks the list passed in.
    const observations = recent.atoms.filter((a) => {
      if (a.principal_id !== 'pr-fix-actor') return false;
      const meta = a.metadata;
      if (meta === null || typeof meta !== 'object') return false;
      if (meta.kind !== 'pr-fix-observation') return false;
      const obs = meta.pr_fix_observation;
      return obs !== null
        && typeof obs === 'object'
        && obs.pr_owner === owner
        && obs.pr_repo === repo
        && obs.pr_number === args.prNumber;
    });
    // Resolve each observation's dispatched_session_atom_id into a
    // session atom; pass them as a Map for O(1) lookup in the walker.
    const sessionsById = new Map();
    for (const obs of observations) {
      const meta = obs.metadata;
      const prFix = meta?.pr_fix_observation;
      const dispatchedId = prFix?.dispatched_session_atom_id;
      if (typeof dispatchedId === 'string' && dispatchedId.length > 0) {
        const sessionAtom = await host.atoms.get(dispatchedId);
        if (sessionAtom !== null) {
          sessionsById.set(String(sessionAtom.id), sessionAtom);
        }
      }
    }
    return walkAuthorSessionsForPrFix({
      observations,
      sessionsById,
      prIdentity: { owner, repo, number: args.prNumber },
    });
  };

  // Honor `--principal` override end-to-end: the policy cache key
  // above used `args.principalId`, the wrap call MUST pass the same
  // principal so the bridge's internal canon read hits the same key.
  // A mismatch (e.g. cache keyed by the override but wrap keyed by a
  // hard-coded literal) causes a silent fail-closed because the
  // bridge looks up the wrong cache key, finds undefined, and falls
  // through to fresh-spawn. Threading the override through both sites
  // keeps `--principal pr-fix-actor` (the default) and
  // `--principal something-else` (an org-ceiling alias) working
  // identically: both look up `pol-resume-strategy-${principalId}`.
  // The default registry is keyed by `pr-fix-actor`; an override that
  // does not match a registered descriptor short-circuits cleanly via
  // the bridge's descriptor-not-found path (returns the fresh adapter).
  const agentLoopAdapter = wrapAgentLoopAdapterIfEnabled(
    freshAgentLoop,
    args.principalId,
    registryHost,
    {
      agentLoopHost: host,
      strategies,
      assembleCandidates,
    },
  );

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
    agentLoop: withAdapterIdentity(agentLoopAdapter, 'resume-author-agent-loop', '0.1.0'),
    workspaceProvider: withAdapterIdentity(workspaceProvider, 'git-worktree', '0.1.0'),
    blobStore: withAdapterIdentity(blobStore, 'file-blob-store', '0.1.0'),
    redactor: withAdapterIdentity(redactor, 'regex-default-redactor', '0.1.0'),
  };

  // Optional dispatch-origin context. When the actor was spawned by an
  // upstream orchestrator (e.g. the orphan-PR reconciler in
  // src/runtime/plans/pr-orphan-reconcile.ts) the orchestrator sets
  // both env vars; the actor chains the first observation's
  // derived_from to the upstream atom and writes the reason onto
  // metadata.extra.dispatch_origin so the audit trail reads end-to-end
  // (origin -> pr-fix observation -> session -> fix-push) without a
  // side-channel scan. Absent both vars, the actor runs in stand-alone
  // mode and the chain begins at its own first observation atom.
  const orphanAtomIdEnv = process.env.LAG_PR_ORPHAN_ATOM_ID;
  const orphanReasonEnv = process.env.LAG_PR_ORPHAN_REASON;
  const originContext
    = typeof orphanAtomIdEnv === 'string'
      && orphanAtomIdEnv.length > 0
      && typeof orphanReasonEnv === 'string'
      && orphanReasonEnv.length > 0
      ? {
          origin_atom_id: orphanAtomIdEnv,
          origin_reason: orphanReasonEnv,
          origin_kind: 'pr-orphan-reconciler',
        }
      : undefined;
  if (originContext !== undefined) {
    console.log(
      `[pr-fix] dispatch origin: kind=${originContext.origin_kind} `
      + `atom=${originContext.origin_atom_id} reason=${originContext.origin_reason}`,
    );
  }

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
    ...(originContext !== undefined ? { originContext } : {}),
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

  /*
   * Routine post-step: resolve outdated review threads on this PR so
   * the unresolved-threads merge gate clears as soon as CI does.
   * Outdated threads (the actor's fix-push changed the anchored line)
   * stay unresolved until someone calls resolveReviewThread; threads
   * still anchored to live code are LEFT alone for a human or a
   * CR-side acknowledgement. Per canon
   * `dev-pr-fix-auto-resolve-outdated-threads` (operator stated
   * 2026-04-27 'this should never happen again' after multiple PRs
   * stalled in mergeStateStatus=BLOCKED on outdated threads alone).
   *
   * Best-effort: failures here are non-fatal so the actor's exit
   * code stays driven by report.haltReason. Resolving threads is
   * idempotent (the helper re-fetches and skips already-resolved
   * threads), so a retry on the next iteration is safe.
   *
   * Skipped in dry-run since dry-run does not push and therefore
   * does not produce outdated threads worth resolving.
   */
  if (args.live) {
    try {
      console.log('[pr-fix] running scripts/resolve-outdated-threads.mjs as routine post-step');
      await execa(
        'node',
        [resolve(REPO_ROOT, 'scripts/resolve-outdated-threads.mjs'), String(args.prNumber)],
        { stdio: 'inherit', cwd: REPO_ROOT },
      );
    } catch (err) {
      console.error('[pr-fix] resolve-outdated-threads failed (non-fatal):', err?.message ?? err);
    }
  }

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
