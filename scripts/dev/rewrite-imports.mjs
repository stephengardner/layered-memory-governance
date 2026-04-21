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
 * Only relative specifiers (starting with './' or '../') are rewritten;
 * bare-specifier imports (npm packages) are left alone.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, relative, resolve, sep } from 'node:path';

// EDIT THIS ARRAY FOR EACH PHASE. Accumulated across phases; safe to keep
// old entries - they become no-ops once the files are at their `to` paths.
const REWRITES = [
  // Phase B1:
  { kind: 'file', from: resolve('src/types.ts'),     to: resolve('src/substrate/types.ts') },
  { kind: 'file', from: resolve('src/interface.ts'), to: resolve('src/substrate/interface.ts') },
  { kind: 'file', from: resolve('src/errors.ts'),    to: resolve('src/substrate/errors.ts') },
  // Phase B2 additions go here. Phase B3, C1, D1-D3, D4, E1 each append.
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

function rewriteSpec(fileDir, spec) {
  const resolved = resolveSpec(fileDir, spec);
  const newResolved = matchRewrite(resolved);
  if (!newResolved) return null;
  let rel = relative(fileDir, newResolved).replace(/\\/g, '/');
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel.replace(/\.ts$/, '.js');
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
    const rewritten = rewriteSpec(fileDir, spec);
    return rewritten ? a + rewritten + b : m;
  });
  if (updated !== text) {
    writeFileSync(abs, updated);
    console.log('updated:', file);
    modifiedCount++;
  }
}
console.log(`rewrite-imports: modified ${modifiedCount} file(s)`);
