#!/usr/bin/env node
/**
 * `lag inbox` CLI: read-only projection over the actor-message inbox.
 *
 * Shows, for a given principal:
 *   - unread actor-message atoms (what pickNextMessage would see)
 *   - in-flight plans derived from an acked message (correlation chain)
 *   - open circuit-breaker trips for this principal (writes blocked)
 *   - any pending circuit-breaker-reset atoms (authority flow awaiting)
 *
 * Usage:
 *   node scripts/lag-inbox.mjs --for <principal-id> [--state-dir <path>] [--json]
 *
 * Does NOT write atoms. Does NOT pick messages. The CLI is a
 * projection; operators run pickNextMessage via the inbox daemon (a
 * future PR) or via direct consumer code.
 *
 * Exit codes:
 *   0 = success (output rendered)
 *   2 = bad args or state dir missing
 *   3 = runtime error (fell through to catch)
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';
import { listUnread } from '../dist/runtime/actor-message/index.js';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const DEFAULT_STATE_DIR = resolve(REPO_ROOT, '.lag');

function parseArgs(argv) {
  const args = {
    principal: null,
    stateDir: DEFAULT_STATE_DIR,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--for' && i + 1 < argv.length) args.principal = argv[++i];
    else if (a === '--state-dir' && i + 1 < argv.length) args.stateDir = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '-h' || a === '--help') {
      console.log([
        'Usage: node scripts/lag-inbox.mjs --for <principal-id> [options]',
        '',
        'Options:',
        '  --for <id>            Required. Principal whose inbox to show.',
        '  --state-dir <path>    Default: .lag/ under the repo root.',
        '  --json                Emit JSON (default: human-readable).',
        '',
        'Output sections:',
        '  UNREAD              actor-message atoms awaiting pickup',
        '  OPEN CIRCUIT TRIPS  circuit-breaker-trip atoms blocking writes',
        '  PENDING RESETS      circuit-breaker-reset atoms not yet applied',
        '',
        'Exit codes:',
        '  0 success, 2 bad args / missing state, 3 runtime error',
      ].join('\n'));
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (args.principal === null) {
    console.error('ERROR: --for <principal-id> is required.');
    process.exit(2);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.stateDir)) {
    console.error(`ERROR: state-dir does not exist: ${args.stateDir}`);
    process.exit(2);
  }
  const host = await createFileHost({ rootDir: args.stateDir });

  // Unread messages addressed to --for.
  const unread = await listUnread(host, args.principal);

  // Open circuit-breaker trips for --for.
  const tripsPage = await host.atoms.query({ type: ['circuit-breaker-trip'] }, 500);
  const openTrips = tripsPage.atoms
    .filter((a) => a.superseded_by.length === 0 && a.taint === 'clean')
    .filter((a) => a.metadata?.trip?.target_principal === args.principal);

  // Pending reset atoms targeting --for that have no matching trip
  // (or whose trip is already superseded by a different reset). This
  // surfaces resets whose validator run was skipped or failed.
  const resetsPage = await host.atoms.query({ type: ['circuit-breaker-reset'] }, 500);
  const pendingResets = [];
  for (const reset of resetsPage.atoms) {
    if (reset.taint !== 'clean') continue;
    // A superseded reset has itself been replaced (e.g. by a revocation
    // atom); it is no longer actionable and should not be surfaced.
    if (reset.superseded_by.length > 0) continue;
    const envelope = reset.metadata?.reset;
    if (!envelope || envelope.target_principal !== args.principal) continue;
    const trip = await host.atoms.get(envelope.trip_atom_id);
    if (trip === null) {
      pendingResets.push({ reset_id: String(reset.id), state: 'trip-missing' });
      continue;
    }
    if (!trip.superseded_by.map(String).includes(String(reset.id))) {
      pendingResets.push({ reset_id: String(reset.id), state: 'trip-not-superseded-by-this-reset' });
    }
  }

  if (args.json) {
    console.log(JSON.stringify({
      principal: args.principal,
      state_dir: args.stateDir,
      unread: unread.map((m) => ({
        atom_id: String(m.atom.id),
        from: m.envelope.from,
        topic: m.envelope.topic,
        urgency_tier: m.envelope.urgency_tier,
        deadline_ts: m.envelope.deadline_ts ?? null,
        correlation_id: m.envelope.correlation_id ?? null,
        created_at: m.atom.created_at,
      })),
      open_trips: openTrips.map((t) => ({
        atom_id: String(t.id),
        denial_count: t.metadata?.trip?.denial_count,
        window_ms: t.metadata?.trip?.window_ms,
        tripped_at: t.metadata?.trip?.tripped_at,
      })),
      pending_resets: pendingResets,
    }, null, 2));
    return;
  }

  console.log(`Inbox for ${args.principal} (state: ${args.stateDir})`);
  console.log('');
  console.log(`UNREAD (${unread.length})`);
  if (unread.length === 0) {
    console.log('  (no unacked messages)');
  } else {
    for (const m of unread) {
      const deadline = m.envelope.deadline_ts ? ` deadline=${m.envelope.deadline_ts}` : '';
      const corr = m.envelope.correlation_id ? ` correlation=${m.envelope.correlation_id}` : '';
      console.log(
        `  ${String(m.atom.id)}  from=${m.envelope.from}  [${m.envelope.urgency_tier}]  topic=${m.envelope.topic}${deadline}${corr}`,
      );
    }
  }
  console.log('');
  console.log(`OPEN CIRCUIT TRIPS (${openTrips.length})`);
  if (openTrips.length === 0) {
    console.log('  (none)');
  } else {
    for (const t of openTrips) {
      console.log(
        `  ${String(t.id)}  denials=${t.metadata?.trip?.denial_count} window_ms=${t.metadata?.trip?.window_ms} tripped_at=${t.metadata?.trip?.tripped_at}`,
      );
    }
  }
  console.log('');
  console.log(`PENDING RESETS (${pendingResets.length})`);
  if (pendingResets.length === 0) {
    console.log('  (none)');
  } else {
    for (const p of pendingResets) {
      console.log(`  ${p.reset_id}  state=${p.state}`);
    }
  }
}

try {
  await main();
} catch (err) {
  console.error(`[lag-inbox] ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(3);
}
