#!/usr/bin/env node
/**
 * lag-run-loop: run the LAG autonomous loop as a daemon.
 *
 * Usage:
 *   lag-run-loop --root-dir <path>
 *                [--palace-path <path>]       # bootstrap from external store
 *                [--canon-md <file>]          # target CLAUDE.md for canon applier
 *                [--interval <ms>]            # tick interval (default 60000)
 *                [--bootstrap-limit <n>]      # max drawers to import on startup
 *                [--principal <id>]           # principal for loop writes
 *                [--gate-timeout <ms>]        # L3 human-gate timeout (default 60000)
 *
 * Prints a one-line tick summary after every cycle. Ctrl+C halts cleanly.
 */

import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFileHost, type FileHost } from '../adapters/file/index.js';
import { createBridgeHost, type BridgeHost } from '../adapters/bridge/index.js';
import { CachingEmbedder } from '../adapters/_common/caching-embedder.js';
import { TrigramEmbedder } from '../adapters/_common/trigram-embedder.js';
import { LoopRunner } from '../loop/runner.js';
import type { Embedder, Host } from '../interface.js';
import type { PrincipalId } from '../types.js';
import type { LoopTickReport } from '../loop/types.js';
import type { PrObservationRefresher } from '../runtime/plans/pr-observation-refresh.js';

type EmbedderChoice = 'trigram' | 'onnx-minilm';

interface CliArgs {
  readonly rootDir: string;
  readonly palacePath: string | null;
  readonly canonMd: string | null;
  readonly intervalMs: number;
  readonly bootstrapLimit: number | null;
  readonly principal: string;
  readonly gateTimeoutMs: number;
  readonly embedderChoice: EmbedderChoice;
  readonly embedCache: boolean;
  readonly reapStalePlans: boolean;
  /**
   * Resolved reaper principal id. `null` when --reap-stale-plans is
   * not enabled. When enabled, populated via the precedence chain:
   * --reaper-principal flag > LAG_REAPER_PRINCIPAL env > --principal
   * (which itself defaults to "lag-loop") > LAG_OPERATOR_ID env.
   */
  readonly reaperPrincipal: string | null;
  /** Override the warn-bucket TTL in ms; null = use reaper default. */
  readonly reaperWarnMs: number | null;
  /** Override the abandon-bucket TTL in ms; null = use reaper default. */
  readonly reaperAbandonMs: number | null;
  /**
   * Run the plan-state reconcile pass on every loop tick. Default
   * `true` at the indie-floor: the failure mode the operator
   * surfaced (3 plans stuck in 'executing' indefinitely after their
   * PR merged) requires this pass to be self-sustaining. A
   * deployment that observes PR state through a webhook / external
   * driver and never wants the loop to write back can pass
   * `--no-reconcile-plan-state` to flip it off.
   */
  readonly reconcilePlanState: boolean;
  /**
   * Run the pr-observation refresh pass on every loop tick. Default
   * `true` at the indie-floor for the same reason as
   * reconcilePlanState: a stale OPEN observation on a merged PR is
   * exactly what produces the stuck-executing failure mode. Disabling
   * is via `--no-refresh-plan-observations`. The pass requires the
   * `node` runtime to be able to spawn `scripts/run-pr-landing.mjs
   * --observe-only --live`; in a sandboxed deployment that cannot
   * spawn child processes, the operator disables this and provides
   * an alternative observation driver.
   */
  readonly refreshPlanObservations: boolean;
}

function parseCliArgs(): CliArgs | null {
  try {
    const { values } = parseArgs({
      options: {
        'root-dir': { type: 'string' },
        'palace-path': { type: 'string' },
        'canon-md': { type: 'string' },
        interval: { type: 'string', default: '60000' },
        'bootstrap-limit': { type: 'string' },
        principal: { type: 'string', default: 'lag-loop' },
        'gate-timeout': { type: 'string', default: '60000' },
        embedder: { type: 'string', default: 'trigram' },
        'embed-cache': { type: 'boolean', default: true },
        'no-embed-cache': { type: 'boolean', default: false },
        'reap-stale-plans': { type: 'boolean', default: false },
        'reaper-principal': { type: 'string' },
        'reaper-warn-ms': { type: 'string' },
        'reaper-abandon-ms': { type: 'string' },
        // The approval-cycle ticks (reconcile + refresh) default ON
        // at the indie-floor; the failure mode the operator surfaced
        // requires self-sustaining writeback. The negated flags are
        // the explicit opt-out for sandboxed deployments.
        'reconcile-plan-state': { type: 'boolean', default: true },
        'no-reconcile-plan-state': { type: 'boolean', default: false },
        'refresh-plan-observations': { type: 'boolean', default: true },
        'no-refresh-plan-observations': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
    if (values['help']) {
      printUsage();
      return null;
    }
    const rootDir = values['root-dir'];
    if (!rootDir) {
      console.error('Error: --root-dir is required.');
      printUsage();
      return null;
    }
    const intervalMs = parseInt(String(values['interval']), 10);
    if (!Number.isFinite(intervalMs) || intervalMs < 100) {
      console.error(`Error: --interval must be >= 100ms. Got ${values['interval']}.`);
      return null;
    }
    const gateTimeoutMs = parseInt(String(values['gate-timeout']), 10);
    if (!Number.isFinite(gateTimeoutMs) || gateTimeoutMs < 100) {
      console.error(`Error: --gate-timeout must be >= 100ms. Got ${values['gate-timeout']}.`);
      return null;
    }
    const bootstrapLimit = values['bootstrap-limit']
      ? parseInt(String(values['bootstrap-limit']), 10)
      : null;
    if (bootstrapLimit !== null && (!Number.isFinite(bootstrapLimit) || bootstrapLimit < 0)) {
      console.error(`Error: --bootstrap-limit must be a non-negative number.`);
      return null;
    }
    const embedderChoice = String(values['embedder']);
    if (embedderChoice !== 'trigram' && embedderChoice !== 'onnx-minilm') {
      console.error(`Error: --embedder must be "trigram" or "onnx-minilm". Got "${embedderChoice}".`);
      return null;
    }
    // --no-embed-cache explicitly disables; else honor --embed-cache (default true).
    const embedCache = Boolean(values['no-embed-cache']) ? false : Boolean(values['embed-cache']);
    const principal = String(values['principal']);
    const reapStalePlans = Boolean(values['reap-stale-plans']);
    // Resolution order documented in the CLI usage. Loud-fail when
    // --reap-stale-plans is on but no source resolves a non-empty
    // value; we never silently default the reaper attribution.
    let reaperPrincipal: string | null = null;
    if (reapStalePlans) {
      const flagValue = values['reaper-principal'];
      const envReaper = process.env.LAG_REAPER_PRINCIPAL;
      const envOperator = process.env.LAG_OPERATOR_ID;
      const candidate =
        (typeof flagValue === 'string' && flagValue.trim().length > 0 ? flagValue : null)
        ?? (typeof envReaper === 'string' && envReaper.trim().length > 0 ? envReaper : null)
        ?? (typeof principal === 'string' && principal.trim().length > 0 ? principal : null)
        ?? (typeof envOperator === 'string' && envOperator.trim().length > 0 ? envOperator : null);
      if (!candidate) {
        console.error(
          'Error: --reap-stale-plans requires a reaper principal. Set --reaper-principal, '
            + 'LAG_REAPER_PRINCIPAL, --principal, or LAG_OPERATOR_ID.',
        );
        return null;
      }
      reaperPrincipal = candidate;
    }
    let reaperWarnMs: number | null = null;
    if (typeof values['reaper-warn-ms'] === 'string') {
      const n = parseInt(String(values['reaper-warn-ms']), 10);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        console.error(
          `Error: --reaper-warn-ms must be a positive integer ms. Got ${String(values['reaper-warn-ms'])}.`,
        );
        return null;
      }
      reaperWarnMs = n;
    }
    let reaperAbandonMs: number | null = null;
    if (typeof values['reaper-abandon-ms'] === 'string') {
      const n = parseInt(String(values['reaper-abandon-ms']), 10);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        console.error(
          `Error: --reaper-abandon-ms must be a positive integer ms. Got ${String(values['reaper-abandon-ms'])}.`,
        );
        return null;
      }
      reaperAbandonMs = n;
    }
    // Reconcile / refresh defaults: --no-* flags win over the positive
    // form. This matches the --embed-cache / --no-embed-cache pattern
    // already in this CLI.
    const reconcilePlanState = Boolean(values['no-reconcile-plan-state'])
      ? false
      : Boolean(values['reconcile-plan-state']);
    const refreshPlanObservations = Boolean(values['no-refresh-plan-observations'])
      ? false
      : Boolean(values['refresh-plan-observations']);
    return {
      rootDir,
      palacePath: values['palace-path'] ?? null,
      canonMd: values['canon-md'] ?? null,
      intervalMs,
      bootstrapLimit,
      principal,
      gateTimeoutMs,
      embedderChoice: embedderChoice as EmbedderChoice,
      embedCache,
      reapStalePlans,
      reaperPrincipal,
      reaperWarnMs,
      reaperAbandonMs,
      reconcilePlanState,
      refreshPlanObservations,
    };
  } catch (err) {
    console.error('Error parsing args:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

function printUsage(): void {
  console.error(
    [
      'lag-run-loop: run the LAG autonomous loop as a daemon.',
      '',
      'Usage: lag-run-loop --root-dir <path> [options]',
      '',
      'Options:',
      '  --root-dir <path>         Root directory for LAG state (required).',
      '  --palace-path <path>      Path to external palace for bootstrap.',
      '  --canon-md <file>         Target CLAUDE.md for canon applier.',
      '  --interval <ms>           Tick interval (default 60000).',
      '  --bootstrap-limit <n>     Max drawers to import at startup.',
      '  --principal <id>          Loop principal id (default "lag-loop").',
      '  --gate-timeout <ms>       L3 human-gate timeout (default 60000).',
      '  --embedder <name>         Retrieval embedder: trigram | onnx-minilm (default trigram).',
      '  --embed-cache             Wrap embedder in a disk cache at rootDir/embed-cache/ (default true).',
      '  --no-embed-cache          Disable embed cache.',
      '  --reap-stale-plans        Run the stale-plan reaper on every tick (default off).',
      '  --reaper-principal <id>   Principal id the reaper attributes abandonment',
      '                            transitions to. Resolution order when --reap-stale-plans',
      '                            is on: this flag > LAG_REAPER_PRINCIPAL env > --principal',
      '                            value > LAG_OPERATOR_ID env. No silent default.',
      '  --reaper-warn-ms <ms>     Override warn-bucket TTL (default 24h).',
      '  --reaper-abandon-ms <ms>  Override abandon-bucket TTL (default 72h).',
      '  --reconcile-plan-state         Run the plan-state reconcile pass on every tick',
      '                                 (default on). Transitions plans whose linked',
      '                                 pr-observation atoms carry a terminal pr_state from',
      '                                 executing/approved to succeeded/abandoned.',
      '  --no-reconcile-plan-state      Disable the reconcile pass.',
      '  --refresh-plan-observations    Run the pr-observation refresh pass on every tick',
      '                                 (default on). Re-observes stale OPEN observations',
      '                                 whose linked plan is still executing so the',
      '                                 reconcile pass sees terminal state on PRs that',
      '                                 merged or closed since the last observation.',
      '                                 Spawns scripts/run-pr-landing.mjs --observe-only',
      '                                 per refresh; bounded by an in-tick refresh cap.',
      '  --no-refresh-plan-observations Disable the refresh pass (e.g. for sandboxed',
      '                                 deployments that cannot spawn child processes).',
      '  --help                    Print this message.',
    ].join('\n'),
  );
}

/**
 * Build the embedder chain the user selected. Returns null when the
 * default (trigram, no cache) is chosen and no wiring is needed; the
 * adapter's own default kicks in.
 */
async function buildEmbedder(args: CliArgs): Promise<Embedder | null> {
  let inner: Embedder;
  if (args.embedderChoice === 'onnx-minilm') {
    // Dynamic import so the 47-package transformers dep only loads
    // when actually requested.
    const mod = await import('../adapters/_common/onnx-minilm-embedder.js');
    inner = new mod.OnnxMiniLmEmbedder();
    console.log('[boot] embedder: onnx-minilm (Xenova/all-MiniLM-L6-v2)');
  } else {
    if (!args.embedCache) return null; // bare trigram = adapter default
    inner = new TrigramEmbedder();
    console.log('[boot] embedder: trigram (default)');
  }
  if (args.embedCache) {
    console.log(`[boot] embed cache: ${args.rootDir}/embed-cache/${inner.id ?? '?'}`);
    return new CachingEmbedder(inner, { rootDir: args.rootDir });
  }
  console.log('[boot] embed cache: disabled');
  return inner;
}

async function buildHost(args: CliArgs): Promise<{
  host: Host;
  cleanup: () => Promise<void>;
  kind: 'bridge' | 'file';
}> {
  const embedder = await buildEmbedder(args);
  if (args.palacePath) {
    const bridgeHost: BridgeHost = await createBridgeHost({
      palacePath: args.palacePath,
      rootDir: args.rootDir,
      defaultPrincipalId: args.principal as PrincipalId,
      ...(embedder !== null ? { embedder } : {}),
    });
    if (args.bootstrapLimit !== null && args.bootstrapLimit > 0) {
      console.log(`[boot] bootstrapping up to ${args.bootstrapLimit} drawers from ${args.palacePath}`);
      const start = Date.now();
      const result = await bridgeHost.bootstrap({ limit: args.bootstrapLimit });
      const elapsed = Date.now() - start;
      console.log(
        `[boot] fetched=${result.fetched} imported=${result.imported} skipped=${result.skipped} errors=${result.errors.length} in ${elapsed}ms`,
      );
    }
    return {
      host: bridgeHost,
      cleanup: async () => {},
      kind: 'bridge',
    };
  }
  const file: FileHost = await createFileHost({
    rootDir: args.rootDir,
    ...(embedder !== null ? { embedder } : {}),
  });
  return { host: file, cleanup: async () => {}, kind: 'file' };
}

function formatTickReport(report: LoopTickReport): string {
  const err = report.errors.length > 0 ? ` errors=${report.errors.length}` : '';
  const kill = report.killSwitchTriggered ? ' [KILL SWITCH]' : '';
  const reaper =
    report.reaperReport !== null
      ? ` reaper(swept=${report.reaperReport.swept}/abandoned=${report.reaperReport.abandoned}/warn=${report.reaperReport.warned})`
      : '';
  // Only render plan-* segments when the corresponding pass actually
  // ran this tick (report field non-null). A disabled pass stays
  // invisible in the per-tick stdout to keep the line scannable on
  // the indie-floor where these defaults are on but commonly
  // produce zero work.
  const reconcile =
    report.planReconcileReport !== null
      ? ` reconcile(matched=${report.planReconcileReport.matched}/transitioned=${report.planReconcileReport.transitioned})`
      : '';
  const refresh =
    report.planObservationRefreshReport !== null
      ? ` obs-refresh(refreshed=${report.planObservationRefreshReport.refreshed})`
      : '';
  return (
    `tick ${report.tickNumber}: ` +
    `decayed=${report.atomsDecayed} ` +
    `l2+=${report.l2Promoted}/-=${report.l2Rejected} ` +
    `l3+=${report.l3Proposed} ` +
    `canon=${report.canonApplied}${reaper}${reconcile}${refresh}${err}${kill}`
  );
}

/**
 * Build the pr-observation refresher seam by dynamic-importing the
 * existing scripts/lib/pr-observation-refresher.mjs helper. The helper
 * shells out to `node scripts/run-pr-landing.mjs --observe-only --live`
 * per refresh, which is the deployment-side GitHub-shaped concern. The
 * framework loop module never imports a GitHub adapter; this CLI seam
 * is the deployment-side wiring per dev-substrate-not-prescription.
 *
 * Dynamic import (vs. a static one) because the .mjs file lives outside
 * the TypeScript graph and the path depends on package layout: at
 * runtime, `dist/cli/run-loop.js` is at `<pkg>/dist/cli/run-loop.js`
 * and the helper is at `<pkg>/scripts/lib/pr-observation-refresher.mjs`.
 * Returns null when the helper cannot be resolved (e.g. an out-of-tree
 * build that didn't ship `scripts/`); the refresh pass then becomes a
 * silent-skip in LoopRunner per its documented contract.
 */
async function buildPrObservationRefresher(): Promise<PrObservationRefresher | null> {
  // dist layout: <pkg>/dist/cli/run-loop.js -> two `..` up reaches the
  // package root, then scripts/lib/<name>.mjs is the canonical helper.
  const here = dirname(fileURLToPath(import.meta.url));
  const helperPath = resolve(here, '..', '..', 'scripts', 'lib', 'pr-observation-refresher.mjs');
  try {
    // pathToFileURL is Windows-safe: a bare path with a `C:` drive
    // letter is interpreted as a URL scheme by ESM dynamic import,
    // which would crash on Windows.
    const mod: { createPrLandingObserveRefresher: (opts?: unknown) => PrObservationRefresher } =
      await import(pathToFileURL(helperPath).href);
    if (typeof mod.createPrLandingObserveRefresher !== 'function') {
      // eslint-disable-next-line no-console
      console.error(
        `[plan-obs-refresh] WARN: refresher helper at ${helperPath} did not export `
          + 'createPrLandingObserveRefresher; refresh pass will silent-skip.',
      );
      return null;
    }
    return mod.createPrLandingObserveRefresher();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[plan-obs-refresh] WARN: could not load refresher helper at ${helperPath}: `
        + `${err instanceof Error ? err.message : String(err)}; refresh pass will silent-skip.`,
    );
    return null;
  }
}

async function main(): Promise<number> {
  const args = parseCliArgs();
  if (args === null) return 1;

  const { host, cleanup, kind } = await buildHost(args);
  console.log(`[boot] host kind=${kind} root=${args.rootDir}`);
  if (args.canonMd) console.log(`[boot] canon target: ${args.canonMd}`);
  console.log(`[boot] interval=${args.intervalMs}ms  gate=${args.gateTimeoutMs}ms  principal=${args.principal}`);
  if (args.reapStalePlans) {
    console.log(
      `[boot] reaper: ENABLED  principal=${args.reaperPrincipal ?? '(unresolved)'}` +
        (args.reaperWarnMs !== null ? `  warn=${args.reaperWarnMs}ms` : '') +
        (args.reaperAbandonMs !== null ? `  abandon=${args.reaperAbandonMs}ms` : ''),
    );
  }
  // Build the refresher only when the refresh pass is enabled. A
  // deployment that opted out via --no-refresh-plan-observations does
  // not pay the dynamic-import cost.
  const refresher: PrObservationRefresher | null = args.refreshPlanObservations
    ? await buildPrObservationRefresher()
    : null;
  console.log(
    `[boot] reconcile-plan-state: ${args.reconcilePlanState ? 'ENABLED' : 'DISABLED'}`,
  );
  console.log(
    `[boot] refresh-plan-observations: ${
      args.refreshPlanObservations ? (refresher !== null ? 'ENABLED' : 'ENABLED (refresher unresolved; will silent-skip)') : 'DISABLED'
    }`,
  );

  const runner = new LoopRunner(host, {
    principalId: args.principal,
    l3HumanGateTimeoutMs: args.gateTimeoutMs,
    ...(args.canonMd !== null ? { canonTargetPath: args.canonMd } : {}),
    runReaperPass: args.reapStalePlans,
    ...(args.reaperPrincipal !== null ? { reaperPrincipal: args.reaperPrincipal } : {}),
    ...(args.reaperWarnMs !== null ? { reaperWarnMs: args.reaperWarnMs } : {}),
    ...(args.reaperAbandonMs !== null ? { reaperAbandonMs: args.reaperAbandonMs } : {}),
    runPlanReconcilePass: args.reconcilePlanState,
    runPlanObservationRefreshPass: args.refreshPlanObservations,
    ...(refresher !== null ? { prObservationRefresher: refresher } : {}),
    onTick: report => {
      console.log(formatTickReport(report));
      for (const e of report.errors) {
        console.error('  ! ' + e);
      }
    },
  });

  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[${sig}] stopping loop...`);
    runner.stop();
    await cleanup();
    console.log('[shutdown] done');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await runner.start(args.intervalMs);
  // runner.start chains setTimeouts internally; the process stays alive
  // until SIGINT/SIGTERM.
  return 0;
}

const exitCode = await main().catch(err => {
  console.error('fatal:', err instanceof Error ? err.stack ?? err.message : String(err));
  return 2;
});
if (exitCode !== 0) process.exit(exitCode);
