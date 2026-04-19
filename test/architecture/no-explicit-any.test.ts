/**
 * Architectural guard: no explicit `any` types in source.
 *
 * tsconfig.json already sets `noImplicitAny: true`, which catches
 * accidental any. Explicit `: any`, `as any`, `<any>`, and function
 * generics like `<T = any>` still slip through. Enforce their absence
 * here so any future reintroduction is a failing test, not a silent
 * regression.
 *
 * Scope:
 *   - `src/**` is strict: zero explicit-any allowed.
 *   - `test/**` is strict as well: we want test code to model type
 *     discipline too. If a specific cast is unavoidable, add a
 *     `// eslint-disable-line` style escape hatch comment that this
 *     test can explicitly allow (NOT implemented yet; add if needed).
 *
 * False positives we tolerate:
 *   - The word "any" in prose comments or string literals.
 *
 * Detection pattern:
 *   - `\bany\b` preceded by one of ': ', 'as ', '<', ',', '|', '&'
 *     (contexts that unambiguously mark a type reference).
 *   - Strips line comments and block comments before matching.
 *   - Strips string literals (single-quoted, double-quoted, backtick)
 *     before matching.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'node:fs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

const TARGET_GLOBS = [
  'src/**/*.ts',
  'test/**/*.ts',
] as const;

function stripCommentsAndStrings(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    const c2 = source[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\' && i + 1 < source.length) {
          i += 2;
          continue;
        }
        i++;
      }
      out += quote;
      if (i < source.length) i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Contexts where `any` is a type position that we want to reject:
//   `: any`        field / param annotation
//   `as any`       cast
//   `<any`         generic argument or angle-bracket cast opener
//   `, any`        next generic arg in a list, or tuple element
//   `| any`, `& any`  union / intersection with any
//   `= any`        defaulted generic (`<T = any>`) or aliased (`type X = any`)
// We also reject `any` on its own line after a return-type arrow / colon at the
// end of a line (matched via the `:` branch after cleaning).
const ANY_TYPE_REGEX = /(?::|=|as|<|,|\|\s*|&\s*)\s*any\b(?!\w|\s*:)/g;

function findExplicitAnyMatches(source: string): Array<{ line: number; snippet: string }> {
  const cleaned = stripCommentsAndStrings(source);
  const matches: Array<{ line: number; snippet: string }> = [];
  const lines = cleaned.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    ANY_TYPE_REGEX.lastIndex = 0;
    if (ANY_TYPE_REGEX.test(line)) {
      matches.push({ line: i + 1, snippet: line.trim() });
    }
  }
  return matches;
}

describe('architectural guard: no explicit any', () => {
  it('no explicit `any` type annotations in src/ or test/', () => {
    const offenders: Array<{ file: string; line: number; snippet: string }> = [];
    for (const pattern of TARGET_GLOBS) {
      const files = globSync(pattern, { cwd: REPO_ROOT });
      for (const rel of files) {
        const full = resolve(REPO_ROOT, rel);
        const source = readFileSync(full, 'utf8');
        const hits = findExplicitAnyMatches(source);
        for (const h of hits) {
          offenders.push({ file: rel, ...h });
        }
      }
    }
    if (offenders.length > 0) {
      const msg = offenders
        .slice(0, 25)
        .map((o) => `  ${o.file}:${o.line}  ${o.snippet}`)
        .join('\n');
      throw new Error(
        `Found ${offenders.length} explicit-any occurrence(s) in tracked TS sources:\n${msg}`,
      );
    }
    expect(offenders).toEqual([]);
  });
});
