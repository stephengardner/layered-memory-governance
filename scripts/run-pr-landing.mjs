#!/usr/bin/env node
/**
 * The pr-landing Actor driver (Phase 53b).
 *
 * Gives the pr-landing agent a "soul": wires every framework primitive
 * through to a running actor that reads review comments from a real
 * GitHub PR, classifies them, and acts within its delegated authority.
 *
 * Composition (read this top to bottom; it IS the framework claim):
 *   1. Host              - createFileHost over .lag/ (governance boundary)
 *   2. Principal         - pr-landing-agent from host.principals
 *   3. ActorAdapter      - GhClient + GitHubPrReviewAdapter (D17 seam)
 *   4. Actor             - PrLandingActor (the mechanism)
 *   5. runActor          - enforces kill-switch, budget, convergence,
 *                          policy gate (checkToolPolicy) per-action,
 *                          audit trail through host.auditor.
 *
 * Safety rails:
 *   - Dry-run is the DEFAULT. Write operations short-circuit inside the
 *     adapter and log what they would do. Reads still run so observation
 *     + classification are exercised.
 *   - --live must be passed explicitly to enable writes.
 *   - Kill-switch checks `.lag/STOP`. Touch that file to halt.
 *   - Budget defaults to 3 iterations, 60s deadline per run.
 *
 * Usage:
 *   node scripts/run-pr-landing.mjs --pr 1                    # dry-run (default)
 *   node scripts/run-pr-landing.mjs --pr 1 --live             # posts comments
 *   node scripts/run-pr-landing.mjs --pr 1 --max-iterations 5
 *   node scripts/run-pr-landing.mjs --pr 1 --owner stephengardner --repo layered-autonomous-governance
 */

import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { createFileHost } from '../dist/adapters/file/index.js';
import { runActor } from '../dist/actors/index.js';
import { PrLandingActor } from '../dist/actors/pr-landing/index.js';
import { GitHubPrReviewAdapter } from '../dist/actors/pr-review/index.js';
import { createGhClient } from '../dist/external/github/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');
const STOP_SENTINEL = resolve(STATE_DIR, 'STOP');

function parseArgs(argv) {
  const args = {
    prNumber: null,
    owner: null,
    repo: null,
    live: false,
    maxIterations: 3,
    deadlineMs: 60_000,
    principalId: 'pr-landing-agent',
    origin: 'github-action',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pr') args.prNumber = Number(argv[++i]);
    else if (a === '--owner') args.owner = argv[++i];
    else if (a === '--repo') args.repo = argv[++i];
    else if (a === '--live') args.live = true;
    else if (a === '--dry-run') args.live = false;
    else if (a === '--max-iterations') args.maxIterations = Number(argv[++i]);
    else if (a === '--deadline-ms') args.deadlineMs = Number(argv[++i]);
    else if (a === '--principal') args.principalId = argv[++i];
    else if (a === '--origin') args.origin = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node scripts/run-pr-landing.mjs --pr <n> [--owner o] [--repo r] [--live] [--max-iterations n]',
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
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
      `ERROR: principal '${args.principalId}' not found in ${STATE_DIR}. Run scripts/bootstrap-pr-landing-canon.mjs first.`,
    );
    process.exit(1);
  }

  const client = createGhClient();
  const review = new GitHubPrReviewAdapter({ client, dryRun: !args.live });

  const actor = new PrLandingActor({ pr: { owner, repo, number: args.prNumber } });

  const deadline = new Date(Date.now() + args.deadlineMs).toISOString();
  const mode = args.live ? 'LIVE' : 'DRY-RUN';
  console.log(`[pr-landing] ${mode} run on ${owner}/${repo}#${args.prNumber} as ${args.principalId}`);
  console.log(`[pr-landing] budget: maxIterations=${args.maxIterations}, deadline=${deadline}`);

  const report = await runActor(actor, {
    host,
    principal,
    adapters: { review },
    budget: { maxIterations: args.maxIterations, deadline },
    origin: args.origin,
    killSwitch: () => existsSync(STOP_SENTINEL),
    onAudit: async (event) => {
      // Tee audit events to stdout for operator visibility + to host.auditor
      // for the durable record.
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

  console.log('[pr-landing] --- REPORT ---');
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

  // Exit code signals the broad outcome so CI can gate on it.
  //   0 = converged (clean PR)
  //   1 = halted with escalation or error
  //   2 = hit iteration / deadline budget (may need another run)
  if (report.haltReason === 'converged') process.exit(0);
  if (report.haltReason === 'budget-iterations' || report.haltReason === 'budget-deadline') process.exit(2);
  process.exit(1);
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
  console.error('[pr-landing] FAILED:', err);
  process.exit(1);
});
