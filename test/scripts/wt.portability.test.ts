import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const FILES = [
  resolve(HERE, '../../scripts/wt.mjs'),
  resolve(HERE, '../../scripts/lib/wt.mjs'),
];

// Match every import-like specifier regardless of syntactic form.
// The original regex only caught `import X from '...'` and missed:
//   - side-effect imports: `import '../src/foo.js';`
//   - dynamic imports: `await import('../src/foo.js')`
//   - re-exports: `export * from '../src/foo.js';`
//   - CommonJS require: `require('../src/foo.js')`
// A specifier is anything inside a string literal that shows up after
// `from`, a bare `import`, `import(`, or `require(`. Matching the
// specifier-in-quotes form with multiple lead-ins keeps the guard
// working no matter how the offending import is spelled.
const FORBIDDEN_PATHS = [
  /(\.\.\/)+src\//,
  /(\.\.\/)+dist\//,
  /(\.\.\/)+\.lag\//,
  /\/dist\/adapters\//,
  /\/dist\/actors\//,
];

// Extract every import/require/re-export specifier into a flat list
// so the assertion can point at the offender verbatim.
const SPECIFIER_PATTERNS = [
  /from\s+['"]([^'"]+)['"]/g,
  /\bimport\s+['"]([^'"]+)['"]/g,   // side-effect import
  /\bimport\s*\(\s*['"]([^'"]+)['"]/g, // dynamic import
  /\brequire\s*\(\s*['"]([^'"]+)['"]/g, // commonjs
  /\bexport\s+[^'"]*from\s+['"]([^'"]+)['"]/g, // re-export
];

function collectSpecifiers(body: string): string[] {
  const specs: string[] = [];
  for (const pat of SPECIFIER_PATTERNS) {
    // Reset lastIndex because /g regex state is shared across calls.
    pat.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.exec(body)) !== null) specs.push(m[1]!);
  }
  return specs;
}

describe('wt CLI portability', () => {
  for (const file of FILES) {
    it(`${file} imports nothing from src/, dist/, or .lag/`, async () => {
      const body = await readFile(file, 'utf8');
      const specifiers = collectSpecifiers(body);
      for (const spec of specifiers) {
        for (const pat of FORBIDDEN_PATHS) {
          expect(
            spec,
            `${file} has forbidden import: ${spec}`,
          ).not.toMatch(pat);
        }
      }
    });
  }
});
