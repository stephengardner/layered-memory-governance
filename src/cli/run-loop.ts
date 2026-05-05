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
import { createFileHost, type FileHost } from '../adapters/file/index.js';
import { createBridgeHost, type BridgeHost } from '../adapters/bridge/index.js';
import { CachingEmbedder } from '../adapters/_common/caching-embedder.js';
import { TrigramEmbedder } from '../adapters/_common/trigram-embedder.js';
import { LoopRunner } from '../loop/runner.js';
import type { Embedder, Host } from '../interface.js';
import type { PrincipalId } from '../types.js';
import type { LoopTickReport } from '../loop/types.js';

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
  return (
    `tick ${report.tickNumber}: ` +
    `decayed=${report.atomsDecayed} ` +
    `l2+=${report.l2Promoted}/-=${report.l2Rejected} ` +
    `l3+=${report.l3Proposed} ` +
    `canon=${report.canonApplied}${reaper}${err}${kill}`
  );
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

  const runner = new LoopRunner(host, {
    principalId: args.principal,
    l3HumanGateTimeoutMs: args.gateTimeoutMs,
    ...(args.canonMd !== null ? { canonTargetPath: args.canonMd } : {}),
    runReaperPass: args.reapStalePlans,
    ...(args.reaperPrincipal !== null ? { reaperPrincipal: args.reaperPrincipal } : {}),
    ...(args.reaperWarnMs !== null ? { reaperWarnMs: args.reaperWarnMs } : {}),
    ...(args.reaperAbandonMs !== null ? { reaperAbandonMs: args.reaperAbandonMs } : {}),
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
