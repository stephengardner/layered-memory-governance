#!/usr/bin/env node
// Rewrite import paths in src/runtime/** to prepend one extra `../`
// whenever the target resolves OUTSIDE src/runtime/. The modules moved
// from src/X/ to src/runtime/X/, so imports that previously went up to
// src/ need an extra level. Intra-runtime imports (../<sibling-that-also-moved>)
// stay unchanged.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, relative, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const RUNTIME_DIRS = new Set(['actors', 'actor-message', 'plans', 'questions', 'loop', 'extraction']);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_RUNTIME = resolve(REPO_ROOT, 'src', 'runtime');

function listTsFiles(root) {
  const out = execSync(`git ls-files "${root}/**/*.ts"`, { cwd: REPO_ROOT }).toString();
  return out.split('\n').filter((l) => l.length > 0).map((p) => resolve(REPO_ROOT, p));
}

function isUnderRuntime(absPath) {
  return absPath.startsWith(SRC_RUNTIME + sep) || absPath === SRC_RUNTIME;
}

async function processFile(filePath) {
  let content = await readFile(filePath, 'utf8');
  let changed = false;
  const fileDir = dirname(filePath);
  // Match the quoted specifier portion of any `from '...'` or `import '...'`
  // whose path starts with `./` or `../`. Non-greedy on quotes.
  const pattern = /(['"])(\.\.?\/[^'"\n]+?)\1/g;
  content = content.replace(pattern, (match, quote, spec) => {
    // Only interested in relative specs that could escape runtime/.
    if (!spec.startsWith('..')) return match;
    // Strip .js extension for resolution; TS files don't have it on disk.
    const specNoExt = spec.replace(/\.js$/, '');
    const resolvedAsIs = resolve(fileDir, specNoExt);
    const candidatesAsTs = [`${resolvedAsIs}.ts`, resolve(resolvedAsIs, 'index.ts')];
    const existsAsIs = candidatesAsTs.some((p) => existsSync(p));
    if (existsAsIs) return match; // import is valid at current depth
    // Try one more `../` prefix.
    const newSpec = `../${spec}`;
    const newNoExt = newSpec.replace(/\.js$/, '');
    const newResolved = resolve(fileDir, newNoExt);
    const newCandidates = [`${newResolved}.ts`, resolve(newResolved, 'index.ts')];
    const existsDeeper = newCandidates.some((p) => existsSync(p));
    if (existsDeeper) {
      // Ensure the resolved target is OUTSIDE runtime/ - that's the case
      // where the move shifted the relative depth. If it's still inside
      // runtime/, the import was already correct and we shouldn't fix it.
      const absTarget = resolve(fileDir, newNoExt);
      if (isUnderRuntime(absTarget)) return match;
      changed = true;
      return `${quote}${newSpec}${quote}`;
    }
    // Couldn't resolve either way - leave alone, typecheck will flag it.
    return match;
  });
  if (changed) {
    await writeFile(filePath, content, 'utf8');
    return true;
  }
  return false;
}

async function main() {
  const files = listTsFiles('src/runtime');
  let touched = 0;
  for (const f of files) {
    if (await processFile(f)) touched++;
  }
  console.log(`Updated imports in ${touched} of ${files.length} files.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
