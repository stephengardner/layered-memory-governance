#!/usr/bin/env node
/*
 * Mechanical import-rewriter. Walks every TS/JS file tracked by git
 * under src/, test/, scripts/, and examples/, parses each `from "..."`
 * specifier, resolves it against the source file's directory, and if
 * the resolved target matches a REWRITES entry, replaces the specifier
 * with a new relative path pointing at the new target.
 *
 * Two kinds of REWRITES:
 *   - { kind: 'file', from: <abs path to .ts>, to: <abs path to .ts> }
 *     Matches when resolved spec equals `from`. Used for single-file moves.
 *   - { kind: 'dir',  from: <abs dir>,         to: <abs dir> }
 *     Matches when resolved spec starts with `from + /`. Replaces the prefix
 *     with `to`. Used for entire-directory moves. Preserves the subpath.
 *
 * Two-pass resolution per specifier:
 *   1. Resolve the spec from the importer's CURRENT dir and look for a
 *      matching REWRITES `from` entry.
 *   2. If no match, check whether the importer itself has been moved
 *      in this or a prior phase. The importer is considered moved when
 *      (a) its directory lives inside a moved `dir` rule's `to`, OR
 *      (b) its absolute file path equals a moved `file` rule's `to`.
 *      If so, re-resolve the spec from the importer's PRE-MOVE dir and
 *      take the rule `to` (or the unmoved target) as the true target.
 *      This handles "importer moved in phase N+1, spec already pointed
 *      at a phase-N post-move target" - the rewriter produces the new
 *      relative path from the importer's current dir.
 *
 * Only relative specifiers (starting with './' or '../') are rewritten;
 * bare-specifier imports (npm packages) are left alone.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, relative, resolve, sep } from 'node:path';

// EDIT THIS ARRAY FOR EACH PHASE. Accumulated across phases; safe to keep
// old entries - they become no-ops once the files are at their `to` paths.
const REWRITES = [
  // Phase B1:
  { kind: 'file', from: resolve('src/types.ts'),     to: resolve('src/substrate/types.ts') },
  { kind: 'file', from: resolve('src/interface.ts'), to: resolve('src/substrate/interface.ts') },
  { kind: 'file', from: resolve('src/errors.ts'),    to: resolve('src/substrate/errors.ts') },
  // Phase B2:
  { kind: 'dir', from: resolve('src/arbitration'),   to: resolve('src/substrate/arbitration') },
  { kind: 'dir', from: resolve('src/promotion'),     to: resolve('src/substrate/promotion') },
  { kind: 'dir', from: resolve('src/taint'),         to: resolve('src/substrate/taint') },
  { kind: 'dir', from: resolve('src/kill-switch'),   to: resolve('src/substrate/kill-switch') },
  { kind: 'dir', from: resolve('src/canon-md'),      to: resolve('src/substrate/canon') },
  // Phase B3:
  { kind: 'dir',  from: resolve('src/policy'),             to: resolve('src/substrate/policy') },
  { kind: 'file', from: resolve('src/llm-tool-policy.ts'), to: resolve('src/substrate/policy/tool-policy.ts') },
  // Phase C1:
  { kind: 'dir', from: resolve('src/loop'),          to: resolve('src/runtime/loop') },
  { kind: 'dir', from: resolve('src/plans'),         to: resolve('src/runtime/plans') },
  { kind: 'dir', from: resolve('src/questions'),     to: resolve('src/runtime/questions') },
  { kind: 'dir', from: resolve('src/extraction'),    to: resolve('src/runtime/claims-extraction') },
  { kind: 'dir', from: resolve('src/actors'),        to: resolve('src/runtime/actors') },
  { kind: 'dir', from: resolve('src/actor-message'), to: resolve('src/runtime/actor-message') },
  // Phase D1:
  { kind: 'file', from: resolve('src/adapters/notifier/telegram.ts'),            to: resolve('src/adapters/notifier/telegram/notifier.ts') },
  { kind: 'file', from: resolve('src/daemon/format.ts'),                         to: resolve('src/adapters/notifier/telegram/format.ts') },
  { kind: 'file', from: resolve('src/daemon/cli-renderer/telegram-channel.ts'),  to: resolve('src/adapters/notifier/telegram/channel.ts') },
  // Phase D2:
  { kind: 'dir',  from: resolve('src/adapters/claude-cli'),    to: resolve('src/adapters/llm/claude-cli') },
  { kind: 'file', from: resolve('src/daemon/invoke-claude.ts'), to: resolve('src/adapters/llm/claude-cli/invoke.ts') },
  // Phase D3:
  { kind: 'file', from: resolve('src/daemon/voice.ts'), to: resolve('src/adapters/transcriber/whisper/whisper.ts') },
];

function resolveSpec(fileDir, spec) {
  // Treat `.js` specifier as pointing at the sibling `.ts`.
  return resolve(fileDir, spec.replace(/\.js$/, '.ts'));
}

function matchRewrite(resolved) {
  for (const r of REWRITES) {
    if (r.kind === 'file' && r.from === resolved) {
      return r.to;
    }
    if (r.kind === 'dir') {
      const withSep = r.from + sep;
      if (resolved === r.from || resolved.startsWith(withSep)) {
        // Preserve the subpath after the old dir.
        const subpath = resolved.slice(r.from.length); // '' or '/foo.ts' or '/bar/baz.ts'
        return r.to + subpath;
      }
    }
  }
  return null;
}

// If the importer itself has been moved, map its CURRENT location back
// to the PRE-MOVE dir so stale specs written before the importer moved
// can still be resolved. The importer is considered moved when either:
//   - a `file` rule's `to` equals the importer's absolute file path, OR
//   - a `dir` rule's `to` covers its current directory.
// File rules are checked first because they are strictly more specific
// than dir rules - a file moved INTO a moved directory (which is the
// case for tool-policy.ts landing inside substrate/policy/) should map
// back to its own pre-move dir, not the containing dir's pre-move dir.
function preMoveDir(fileDir, absPath) {
  if (absPath) {
    for (const r of REWRITES) {
      if (r.kind === 'file' && r.to === absPath) {
        return dirname(r.from);
      }
    }
  }
  for (const r of REWRITES) {
    if (r.kind !== 'dir') continue;
    const withSep = r.to + sep;
    if (fileDir === r.to || fileDir.startsWith(withSep)) {
      return r.from + fileDir.slice(r.to.length);
    }
  }
  return null;
}

// A resolved path is "valid" if the file actually exists on disk. Also
// accepts index.ts under a resolved-as-dir path (common for 'foo.js' imports
// that really mean 'foo/index.ts' after a directory rename). Does not chase
// other resolution rules (extension shims, tsconfig paths) - the rewriter
// operates on literal relative `.js` specifiers only.
function isValidTarget(resolved) {
  if (existsSync(resolved)) return true;
  // '.ts' file absent - try '/index.ts' (rare but possible after dir moves).
  if (resolved.endsWith('.ts')) {
    const asIndex = resolved.replace(/\.ts$/, '/index.ts');
    if (existsSync(asIndex)) return true;
  }
  return false;
}

function rewriteSpec(fileDir, spec, absPath) {
  const resolved = resolveSpec(fileDir, spec);
  const newResolved = matchRewrite(resolved);
  if (newResolved) {
    let rel = relative(fileDir, newResolved).replace(/\\/g, '/');
    if (!rel.startsWith('.')) rel = './' + rel;
    return rel.replace(/\.ts$/, '.js');
  }
  // If the current-dir resolution already points at a valid target, the
  // spec is already correct - no rewrite needed. This short-circuit is
  // what keeps the rewriter idempotent after a cross-phase fixup lands.
  if (isValidTarget(resolved)) return null;
  // Second chance: the importer itself may have moved, leaving a stale
  // spec that resolves to a bogus (non-existent) path. Re-resolve from
  // its pre-move directory; if that points at a valid current target,
  // compute the correct relative path from the importer's CURRENT dir.
  const preDir = preMoveDir(fileDir, absPath);
  if (preDir) {
    const preResolved = resolveSpec(preDir, spec);
    const preRewritten = matchRewrite(preResolved);
    const target = preRewritten ?? (isValidTarget(preResolved) ? preResolved : null);
    if (target) {
      let rel = relative(fileDir, target).replace(/\\/g, '/');
      if (!rel.startsWith('.')) rel = './' + rel;
      const newSpec = rel.replace(/\.ts$/, '.js');
      return newSpec === spec ? null : newSpec;
    }
  }
  return null;
}

const IMPORT_RE = /(from\s+["']|import\s*\(\s*["']|import\s+["'])(\.{1,2}\/[^"']+?\.js)(["'])/g;

let modifiedCount = 0;
const files = execSync('git ls-files src test scripts examples', { encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.(ts|tsx|mjs|js)$/.test(f));

for (const file of files) {
  const abs = resolve(file);
  let text;
  try { text = readFileSync(abs, 'utf8'); } catch { continue; }
  const fileDir = dirname(abs);
  const updated = text.replace(IMPORT_RE, (m, a, spec, b) => {
    const rewritten = rewriteSpec(fileDir, spec, abs);
    return rewritten ? a + rewritten + b : m;
  });
  if (updated !== text) {
    writeFileSync(abs, updated);
    console.log('updated:', file);
    modifiedCount++;
  }
}
console.log(`rewrite-imports: modified ${modifiedCount} file(s)`);
