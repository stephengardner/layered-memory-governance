#!/usr/bin/env node
/**
 * Pipeline subgraph reaper driver.
 *
 * Sibling to scripts/reap-stale-plans.mjs. Sweeps every pipeline atom in
 * the FileHost atom store, classifies it against the per-atom-class TTLs
 * (defaults: 30d terminal / 14d hil-paused / 30d standalone-agent-session),
 * and cascade-reaps the subgraph (stage events, audit findings, brainstorm
 * outputs, spec outputs, review reports, dispatch records, agent sessions,
 * agent turns) for every pipeline that crossed its TTL threshold. Each
 * reaped atom carries `metadata.reaped_at` + `metadata.reaped_reason` and
 * has its `confidence` floored to 0.01 so arbitration deprioritizes it;
 * each reap emits a per-atom audit row carrying the atom id in
 * `refs.atom_ids`. Atoms are NEVER deleted (substrate purity), so
 * provenance walks remain functional.
 *
 * The TTL resolution chain at this driver matches the `dev-substrate-not-
 * prescription` posture for tunable substrate dials:
 *
 *   1. canon policy atom (pol-pipeline-reaper-ttls-default and any
 *      higher-priority pol-pipeline-reaper-ttls-<scope>): preferred,
 *      deployment-tunable, read via readPipelineReaperTtlsFromCanon.
 *   2. env vars (LAG_PIPELINE_REAPER_TERMINAL_MS,
 *      LAG_PIPELINE_REAPER_HIL_PAUSED_MS,
 *      LAG_PIPELINE_REAPER_AGENT_SESSION_MS): ops-time fallback for
 *      one-off overrides without a canon edit.
 *   3. DEFAULT_PIPELINE_REAPER_TTLS: hardcoded floor (30d / 14d / 30d).
 *
 * Usage:
 *
 *   # Default thresholds (canon > env > defaults):
 *   node scripts/reap-stale-pipelines.mjs
 *
 *   # Custom thresholds via env vars (milliseconds; canon overrides if
 *   # a pol-pipeline-reaper-ttls atom is present):
 *   LAG_PIPELINE_REAPER_TERMINAL_MS=1209600000 \
 *     node scripts/reap-stale-pipelines.mjs
 *
 *   # Dry-run: classify-only, no transitions written:
 *   node scripts/reap-stale-pipelines.mjs --dry-run
 *
 *   # Explicit principal (overrides env):
 *   node scripts/reap-stale-pipelines.mjs --principal lag-loop
 *
 * Exit codes (mirror scripts/reap-stale-plans.mjs):
 *   0 - sweep completed (zero or more reaps applied)
 *   1 - fatal error (code threw, bad TTL value, etc.)
 *   2 - kill switch active (.lag/STOP present)
 *   3 - missing principal (operator misconfigured env)
 *
 * Kill switch: respects `.lag/STOP`. The driver halts before any
 * mutation when the sentinel exists, per `inv-kill-switch-first`. A
 * mid-sweep STOP halt is OK because every per-atom reap is idempotent
 * on the next run (the metadata-already-set guard short-circuits).
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFileHost } from '../dist/adapters/file/index.js';
import {
  runPipelineReaperSweep,
  DEFAULT_PIPELINE_REAPER_TTLS,
} from '../dist/runtime/plans/pipeline-reaper.js';
import { readPipelineReaperTtlsFromCanon } from '../dist/runtime/loop/pipeline-reaper-ttls.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

/*
 * Principal that the reaper attributes its reap transitions to in the
 * audit log. Resolved from --principal flag, then LAG_REAPER_PRINCIPAL
 * env, then LAG_OPERATOR_ID env. No silent fallback to a hardcoded id,
 * because a wrong principal in an audit row makes the chain lie about
 * who authored a state transition. Same discipline as
 * scripts/reap-stale-plans.mjs and scripts/decide.mjs.
 */
function resolveReaperPrincipal(args) {
  return (
    args.principal
    || process.env.LAG_REAPER_PRINCIPAL
    || process.env.LAG_OPERATOR_ID
    || null
  );
}

function parseArgs(argv) {
  const args = {
    dryRun: argv.includes('--dry-run'),
    help: argv.includes('--help') || argv.includes('-h'),
    rootDir: undefined,
    principal: undefined,
  };
  const rootIdx = argv.findIndex((a) => a === '--root');
  if (rootIdx >= 0 && argv[rootIdx + 1]) {
    args.rootDir = argv[rootIdx + 1];
  } else if (process.env.LAG_ROOT) {
    args.rootDir = process.env.LAG_ROOT;
  }
  const principalIdx = argv.findIndex((a) => a === '--principal');
  if (principalIdx >= 0 && argv[principalIdx + 1]) {
    args.principal = argv[principalIdx + 1];
  }
  // Reject unknown flags loudly so a typo (e.g. --dryrun missing dash)
  // surfaces at parse time rather than silently running with defaults.
  // Non-flag tokens are accepted as values to known flags or rejected.
  const KNOWN_FLAGS = new Set(['--dry-run', '--help', '-h', '--root', '--principal']);
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('-')) {
      // Value to a known flag; the previous token must have been the
      // flag name. parseArgs reads --root + --principal values directly
      // so plain values land here only when no flag preceded them.
      const prev = argv[i - 1];
      if (prev !== '--root' && prev !== '--principal') {
        return { ...args, error: `unknown argument: ${tok}` };
      }
      continue;
    }
    if (!KNOWN_FLAGS.has(tok)) {
      return { ...args, error: `unknown flag: ${tok}` };
    }
  }
  return args;
}

function printHelp() {
  // Help text routed to stdout (not stderr) and exits 0 because --help
  // is a successful query, not an error condition.
  console.log(
    'Usage: node scripts/reap-stale-pipelines.mjs [--dry-run] [--principal <id>] [--root <dir>] [--help]\n'
    + '\n'
    + 'Sweeps pipeline atom subgraphs that have crossed TTL and applies\n'
    + 'the reaped marker (metadata.reaped_at + reaped_reason + confidence:0.01).\n'
    + 'Atoms are never deleted; the marker is the change.\n'
    + '\n'
    + 'Options:\n'
    + '  --dry-run         Classify only; do not write reap markers.\n'
    + '  --principal <id>  Principal id for audit attribution. Overrides\n'
    + '                    LAG_REAPER_PRINCIPAL and LAG_OPERATOR_ID env.\n'
    + '  --root <dir>      Atom store root (default .lag in repo root or LAG_ROOT env).\n'
    + '  --help, -h        Show this help and exit.\n'
    + '\n'
    + 'Exit codes:\n'
    + '  0  sweep completed\n'
    + '  1  fatal error (code threw, bad TTL, etc.)\n'
    + '  2  kill switch active (.lag/STOP present)\n'
    + '  3  missing principal\n',
  );
}

/**
 * Parse env-var TTL overrides into a partial PipelineReaperTtls. Returns
 * an object whose set fields are the env-supplied positive integers; an
 * unset env var leaves the field undefined so the caller can compose
 * canon > env > defaults. Throws on a malformed value (non-integer,
 * non-positive, scientific notation) so a typo does not silently slip
 * past as `0` or `NaN` ms.
 */
function parseEnvTtlOverrides() {
  const isPositiveIntMs = (n) =>
    typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n > 0;
  const out = {};
  const fields = [
    ['terminalPipelineMs', 'LAG_PIPELINE_REAPER_TERMINAL_MS'],
    ['hilPausedPipelineMs', 'LAG_PIPELINE_REAPER_HIL_PAUSED_MS'],
    ['agentSessionMs', 'LAG_PIPELINE_REAPER_AGENT_SESSION_MS'],
  ];
  for (const [field, envName] of fields) {
    const raw = process.env[envName];
    if (raw === undefined || raw === '') continue;
    const parsed = Number(raw);
    if (!isPositiveIntMs(parsed)) {
      throw new Error(
        `Invalid ${envName}: ${raw} (must be positive integer ms)`,
      );
    }
    out[field] = parsed;
  }
  return out;
}

/**
 * Compose the final TTLs by resolving canon > env > defaults per field.
 * Canon supplies a complete PipelineReaperTtls when present (the reader
 * returns null on absent OR malformed); env supplies per-field overrides;
 * unspecified fields fall through to DEFAULT_PIPELINE_REAPER_TTLS.
 *
 * Returned object plus the resolution-source-by-field map so the
 * driver's startup log shows the operator where each TTL came from.
 */
async function resolveTtls(host) {
  const canon = await readPipelineReaperTtlsFromCanon(host);
  const env = parseEnvTtlOverrides();
  const sources = {
    terminalPipelineMs: 'default',
    hilPausedPipelineMs: 'default',
    agentSessionMs: 'default',
  };
  const merged = { ...DEFAULT_PIPELINE_REAPER_TTLS };
  if (canon) {
    merged.terminalPipelineMs = canon.terminalPipelineMs;
    merged.hilPausedPipelineMs = canon.hilPausedPipelineMs;
    merged.agentSessionMs = canon.agentSessionMs;
    sources.terminalPipelineMs = 'canon';
    sources.hilPausedPipelineMs = 'canon';
    sources.agentSessionMs = 'canon';
  }
  // Env overrides canon per-field. The doctrine: env is an ops-time
  // override knob, canon is a deployment-time policy knob. An operator
  // running a one-off custom-TTL sweep should not have to write a
  // higher-priority policy atom; setting an env var per command is
  // the right granularity. The ops-time override is loud (the startup
  // log names the source per field) so the operator never wonders why
  // the canon value did not apply.
  for (const field of /** @type {const} */ ([
    'terminalPipelineMs',
    'hilPausedPipelineMs',
    'agentSessionMs',
  ])) {
    if (env[field] !== undefined) {
      merged[field] = env[field];
      sources[field] = 'env';
    }
  }
  return { ttls: merged, sources };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (args.error) {
    console.error(`[pipeline-reaper] ${args.error}`);
    console.error('[pipeline-reaper] run with --help for usage.');
    process.exit(1);
  }

  const rootDir = args.rootDir ?? resolve(REPO_ROOT, '.lag');
  /*
   * Kill-switch sentinel lives inside the resolved store root, not
   * REPO_ROOT, so a sweep targeting an alternate atom store (--root or
   * LAG_ROOT) honors that store's own STOP. Per inv-kill-switch-first
   * the gate halts before any mutation, so we check it BEFORE
   * constructing the host.
   */
  const stopSentinel = resolve(rootDir, 'STOP');
  if (existsSync(stopSentinel)) {
    console.error(
      `[pipeline-reaper] STOP sentinel present at ${stopSentinel}; halting before any sweep.`,
    );
    // Exit 2 (governance halt, expected) so shell pipelines can
    // distinguish "STOP armed" from "code threw"; mirrors
    // scripts/reap-stale-plans.mjs convention.
    process.exit(2);
  }

  const host = await createFileHost({ rootDir });
  const { ttls, sources } = await resolveTtls(host);

  const days = (ms) => Math.round(ms / (24 * 60 * 60 * 1000));
  console.log(
    `[pipeline-reaper] sweep starting `
    + `(terminal=${days(ttls.terminalPipelineMs)}d[${sources.terminalPipelineMs}] `
    + `hil-paused=${days(ttls.hilPausedPipelineMs)}d[${sources.hilPausedPipelineMs}] `
    + `agent-session=${days(ttls.agentSessionMs)}d[${sources.agentSessionMs}] `
    + `dryRun=${args.dryRun})`,
  );

  /*
   * Two-phase: in dry-run we classify and report would-reap counts; in
   * live mode we classify + apply via runPipelineReaperSweep. The
   * classify-only path is useful for operator-visibility ("what WOULD
   * be reaped if I ran for real?") and as a non-mutating audit before
   * raising the autonomy dial.
   *
   * In dry-run we still need a principal-shaped argument because
   * runPipelineReaperSweep validates it; but the dry-run never reaches
   * the apply path. We therefore hold the principal-resolution gate to
   * the live path so a dry-run never trips exit 3 on missing principal.
   * The operator's "what would happen" check should not require the
   * audit-attribution principal to be configured.
   */
  if (args.dryRun) {
    // Re-implement the classify pass inline (cheap; shares the
    // helpers) so dry-run doesn't reach the apply path. Loading every
    // pipeline atom mirrors loadAllTerminalPipelines; classifying via
    // classifyPipelineForReap matches the live sweep.
    const { loadAllTerminalPipelines, classifyPipelineForReap } = await import(
      '../dist/runtime/plans/pipeline-reaper.js'
    );
    const { atoms, truncated } = await loadAllTerminalPipelines(host);
    const rawNow = host.clock.now();
    const nowMs = Date.parse(rawNow);
    if (!Number.isFinite(nowMs)) {
      console.error(
        `[pipeline-reaper] host.clock.now() returned non-parseable value: ${rawNow}`,
      );
      process.exit(1);
    }
    const reap = [];
    const skip = [];
    for (const a of atoms) {
      const c = classifyPipelineForReap(a, nowMs, ttls);
      if (!c) continue;
      if (c.verdict === 'reap') reap.push(c);
      else skip.push(c);
    }
    console.log(
      `[pipeline-reaper] DRY RUN: pipelines reap=${reap.length} skip=${skip.length}`
      + `${truncated ? ' (TRUNCATED - more atoms remain)' : ''}`,
    );
    for (const c of reap) {
      const ageDays = Math.floor(c.ageMs / (24 * 60 * 60 * 1000));
      console.log(`  would-reap: ${c.atomId} (age=${ageDays}d reason=${c.reason})`);
    }
    return;
  }

  const principal = resolveReaperPrincipal(args);
  if (!principal) {
    console.error(
      '[pipeline-reaper] no principal resolved. Set --principal, LAG_REAPER_PRINCIPAL, or LAG_OPERATOR_ID.',
    );
    console.error(
      '[pipeline-reaper] this script writes audit rows and refuses to guess the operator principal.',
    );
    /*
     * Exit 3, distinct from STOP-sentinel exit 2 and generic exit 1.
     * Cron wrappers can distinguish "operator misconfigured" (3,
     * recoverable with config edit) from "kill-switch armed" (2,
     * intentional) from "code threw" (1, needs investigation). Same
     * convention as scripts/reap-stale-plans.mjs.
     */
    process.exit(3);
  }

  const out = await runPipelineReaperSweep(host, principal, ttls);

  // Per-pipeline reap summary: count by reason class so the operator
  // sees which TTL fired (terminal vs hil-paused vs standalone agent
  // session). The reason strings come from classifyPipelineForReap and
  // the standalone-session pass; we group by prefix to keep the summary
  // legible at scale.
  const counts = {
    terminal: 0,
    hilPaused: 0,
    standaloneAgentSession: 0,
    other: 0,
  };
  let truncatedSubgraphDeferred = 0;
  let idempotentSkipped = 0;
  for (const r of out.reaped) {
    if (r.reason.startsWith('completed-after-') || r.reason.startsWith('failed-after-')) {
      counts.terminal += 1;
    } else if (r.reason.startsWith('hil-paused-after-')) {
      counts.hilPaused += 1;
    } else if (r.reason.startsWith('standalone-agent-session-')) {
      counts.standaloneAgentSession += 1;
    } else {
      counts.other += 1;
    }
  }
  for (const s of out.skipped) {
    if (s.error === 'subgraph-truncated:root-deferred') {
      truncatedSubgraphDeferred += 1;
    } else if (s.error.startsWith('state-changed:')) {
      idempotentSkipped += 1;
    }
  }

  console.log(
    `[pipeline-reaper] classified: total=${out.classifications.length} `
    + `reap=${out.classifications.filter((c) => c.verdict === 'reap').length} `
    + `skip=${out.classifications.filter((c) => c.verdict === 'skip').length}`
    + `${out.truncated ? ' (TRUNCATED - more atoms remain; will pick up next run)' : ''}`,
  );
  console.log(
    `[pipeline-reaper] reaped: total=${out.reaped.length} `
    + `terminal=${counts.terminal} `
    + `hil-paused=${counts.hilPaused} `
    + `standalone-agent-session=${counts.standaloneAgentSession}`
    + `${counts.other > 0 ? ` other=${counts.other}` : ''}`,
  );
  console.log(
    `[pipeline-reaper] skipped: total=${out.skipped.length} `
    + `subgraph-truncated-deferred=${truncatedSubgraphDeferred} `
    + `state-changed=${idempotentSkipped}`,
  );
  for (const r of out.reaped) {
    console.log(`  reaped: ${r.atomId} (type=${r.atomType} reason=${r.reason})`);
  }
  for (const s of out.skipped) {
    console.log(`  skipped: ${s.atomId} (${s.error})`);
  }
}

main().catch((err) => {
  console.error('[pipeline-reaper] fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
});
