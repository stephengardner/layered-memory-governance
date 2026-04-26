#!/usr/bin/env node
/**
 * Apply L3 canon to CLAUDE.md.
 *
 * Reads every layer-L3 atom from the FileHost atom store, renders the
 * canon section with the existing CanonMdManager, and writes it back
 * to CLAUDE.md (or an alternate path via --target). Idempotent: when
 * CLAUDE.md already matches the rendered canon, the section bytes are
 * preserved and the script reports unchanged.
 *
 * The LoopRunner does this every tick when `runCanonApplier=true` and
 * `canonTargets` is configured. This script is the operator-runnable
 * one-shot for sessions that don't have the loop running, plus the
 * explicit ground-truth refresh path when canon drift is observed.
 *
 * Usage:
 *   node scripts/apply-canon.mjs                     # default: <repo>/CLAUDE.md
 *   node scripts/apply-canon.mjs --target /tmp/x.md
 *   node scripts/apply-canon.mjs --root /alt/.lag    # alternate atom store
 *   node scripts/apply-canon.mjs --principal-id apex-agent --principal-id cto-actor
 *
 * Exit codes:
 *   0   Applied (or already up-to-date).
 *   1   Fatal error (atom store unreachable, target unwritable).
 *   2   Kill switch active (.lag/STOP at the resolved root).
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFileHost } from '../dist/adapters/file/index.js';
import { CanonMdManager } from '../dist/substrate/canon-md/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DEFAULT_TARGET = resolve(REPO_ROOT, 'CLAUDE.md');

function parseArgs(argv) {
  const args = {
    target: null,
    rootDir: null,
    principalIds: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target' && i + 1 < argv.length) {
      args.target = argv[++i];
    } else if (a === '--root' && i + 1 < argv.length) {
      args.rootDir = argv[++i];
    } else if (a === '--principal-id' && i + 1 < argv.length) {
      args.principalIds.push(argv[++i]);
    } else if (a === '-h' || a === '--help') {
      console.log(
        'Usage: node scripts/apply-canon.mjs [--target file.md] [--root .lag] [--principal-id id ...]',
      );
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = args.target ?? DEFAULT_TARGET;
  const rootDir = args.rootDir ?? resolve(REPO_ROOT, '.lag');

  const stopSentinel = resolve(rootDir, 'STOP');
  if (existsSync(stopSentinel)) {
    console.error(`STOP sentinel present at ${stopSentinel}; halting.`);
    process.exit(2);
  }

  const host = await createFileHost({ rootDir });
  /*
   * Pull every L3 atom so the renderer sees the full set. The store
   * paginates; we walk the cursor until exhausted, capping at 200
   * pages * 1000 = 200k atoms (well above any realistic backlog).
   */
  const atoms = [];
  let cursor;
  for (let i = 0; i < 200; i++) {
    const page = await host.atoms.query({ layer: ['L3'] }, 1000, cursor);
    for (const a of page.atoms) atoms.push(a);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  console.log(`[apply-canon] loaded ${atoms.length} L3 atoms from ${rootDir}`);

  /*
   * Look up principals so the renderer can use principal display
   * names where needed. Empty array is safe; the generator falls
   * back to bare ids.
   */
  const principals = [];
  for (const id of args.principalIds) {
    try {
      const p = await host.principals.get(id);
      if (p) principals.push(p);
    } catch (err) {
      // Missing principal is non-fatal; surface anything else (FS,
      // parse, transient errors) instead of silently swallowing them
      // and rendering bare ids with no operator signal.
      const msg = String((err && err.message) ?? err);
      if (!/not.?found|ENOENT/i.test(msg)) throw err;
      console.warn(`[apply-canon] principal '${id}' not found; skipping`);
    }
  }

  const mgr = new CanonMdManager({ filePath: target });
  const result = await mgr.applyCanon(atoms, principals.length > 0 ? { principals } : {});
  if (result.changed) {
    console.log(`[apply-canon] WROTE ${target} (canon section refreshed)`);
  } else {
    console.log(`[apply-canon] unchanged: ${target} already matches L3 atoms`);
  }
}

main().catch((err) => {
  console.error('[apply-canon] fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
});
