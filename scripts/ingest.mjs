#!/usr/bin/env node
/**
 * Bootstrap a LAG state directory from one or more SessionSources.
 *
 * Usage:
 *   node scripts/ingest.mjs --source <kind>:<path> [--source ...]
 *                           [--principal <id>]
 *                           [--scope <session|project|user|global>]
 *                           [--layer <L0|L1|L2|L3>]
 *                           [--max <n>]
 *                           [--dry-run]
 *                           [--root-dir <path>]
 *
 * Examples:
 *   # Ingest this repo's own Claude Code transcripts into .lag/
 *   node scripts/ingest.mjs \
 *     --source claude-code:~/.claude/projects/C--Users-opens-memory-governance
 *
 *   # Dry run two sources against a custom state dir
 *   node scripts/ingest.mjs \
 *     --source fresh: \
 *     --source claude-code:~/.claude/projects/mything \
 *     --root-dir /tmp/lag-test --dry-run
 *
 * Supported sources (today):
 *   fresh:                        the no-op (useful for smoke tests)
 *   claude-code:<dir>             Claude Code transcripts under <dir>/*.jsonl
 *
 * Adding a source is a new implementation of SessionSource; the CLI
 * wrapper needs a new case in `buildSource` below. That's it.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { createFileHost } from '../dist/adapters/file/index.js';
import {
  ClaudeCodeTranscriptSource,
  FreshSource,
} from '../dist/sources/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function expandTilde(p) {
  if (p.startsWith('~/') || p === '~') return p.replace('~', homedir());
  return p;
}

function parseArgs(argv) {
  const args = {
    sources: [],
    principal: 'lag-self',
    scope: 'project',
    layer: 'L0',
    maxAtoms: 10_000,
    dryRun: false,
    rootDir: resolve(REPO_ROOT, '.lag'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source' && i + 1 < argv.length) {
      args.sources.push(argv[++i]);
    } else if (a === '--principal' && i + 1 < argv.length) {
      args.principal = argv[++i];
    } else if (a === '--scope' && i + 1 < argv.length) {
      args.scope = argv[++i];
    } else if (a === '--layer' && i + 1 < argv.length) {
      args.layer = argv[++i];
    } else if (a === '--max' && i + 1 < argv.length) {
      args.maxAtoms = Number(argv[++i]);
    } else if (a === '--root-dir' && i + 1 < argv.length) {
      args.rootDir = resolve(expandTilde(argv[++i]));
    } else if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      printHelp();
      process.exit(1);
    }
  }
  return args;
}

function printHelp() {
  console.log(`
Usage: node scripts/ingest.mjs --source <kind>:<path> [options]

Sources:
  fresh:                         no-op; empty init
  claude-code:<dir>              Claude Code transcripts at <dir>/*.jsonl

Options:
  --source <kind>:<path>         repeatable; order matters for dedup trace
  --principal <id>               principal id for ingested atoms (default lag-self)
  --scope <scope>                session|project|user|global (default project)
  --layer <layer>                L0|L1|L2|L3 (default L0 for raw ingests)
  --max <n>                      max atoms per source (default 10000)
  --root-dir <path>              .lag/ state dir (default <repo>/.lag)
  --dry-run                      report what would be written; do not persist
`);
}

function buildSource(spec) {
  const colon = spec.indexOf(':');
  if (colon < 0) throw new Error(`Invalid source spec: "${spec}". Expected <kind>:<path>.`);
  const kind = spec.slice(0, colon);
  const path = spec.slice(colon + 1);
  switch (kind) {
    case 'fresh':
      return new FreshSource();
    case 'claude-code':
      if (!path) throw new Error('claude-code source requires a path');
      return new ClaudeCodeTranscriptSource({ dir: expandTilde(path) });
    default:
      throw new Error(`Unknown source kind: "${kind}". Known: fresh, claude-code.`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.sources.length === 0) {
    console.error('No --source given.');
    printHelp();
    process.exit(1);
  }

  await mkdir(args.rootDir, { recursive: true });
  const host = await createFileHost({ rootDir: args.rootDir });

  console.log(`LAG ingest`);
  console.log(`  Root:     ${args.rootDir}`);
  console.log(`  Principal:${args.principal}`);
  console.log(`  Scope:    ${args.scope}`);
  console.log(`  Layer:    ${args.layer}`);
  if (args.dryRun) console.log(`  DRY RUN (no writes)`);
  console.log('');

  for (const spec of args.sources) {
    let source;
    try {
      source = buildSource(spec);
    } catch (err) {
      console.error(`  [skip] ${spec}: ${err.message}`);
      continue;
    }
    console.log(`[${source.id}] ${source.description}`);
    const report = await source.ingest(host, {
      principalId: args.principal,
      scope: args.scope,
      layer: args.layer,
      maxAtoms: args.maxAtoms,
      dryRun: args.dryRun,
    });
    console.log(`  written=${report.atomsWritten} skipped=${report.atomsSkipped} errors=${report.errors.length}`);
    if (report.errors.length > 0) {
      for (const e of report.errors.slice(0, 3)) console.log(`    ! ${e}`);
      if (report.errors.length > 3) console.log(`    ... (${report.errors.length - 3} more)`);
    }
    if (report.sampleAtomIds.length > 0) {
      console.log(`    sample ids: ${report.sampleAtomIds.slice(0, 3).join(', ')}`);
    }
    if (report.details) {
      for (const [k, v] of Object.entries(report.details)) {
        console.log(`    ${k}: ${JSON.stringify(v)}`);
      }
    }
    console.log('');
  }
}

main().catch(err => {
  console.error('ingest failed:', err);
  process.exit(1);
});
