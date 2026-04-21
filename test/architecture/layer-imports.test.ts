import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Architectural invariants for the substrate / runtime / integrations
 * layering. These assertions fail if a future change crosses a
 * boundary that would compromise the compose-on story.
 *
 * Rules:
 *   1. substrate/ cannot import from runtime/, integrations/, adapters/,
 *      ingestion/, retrieval/, llm-judge/, cli/, simulation/, external/.
 *      Substrate is load-bearing always; it must not pull in any layer
 *      that a consumer might swap out.
 *   2. runtime/ cannot import from integrations/, cli/.
 *      Runtime is the REFERENCE orchestration; it must not depend on
 *      the compose-on seam for external orchestrators, or on CLI
 *      tooling.
 *   3. integrations/ cannot import from runtime/ internals; only from
 *      substrate/ + adapters/. (An integration IS a way to expose the
 *      substrate to a non-LAG orchestrator; leaning on runtime/
 *      defeats the point.)
 *   4. adapters/ cannot import from runtime/ or integrations/.
 *      Adapters are Host implementations; they should depend on
 *      substrate contracts only.
 */

// ESM-compatible directory resolution. The repo ships `"type": "module"`,
// so __dirname is not defined at runtime; mirror the pattern used by
// test/architecture/no-explicit-any.test.ts.
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(HERE, '..', '..', 'src');

async function listTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of glob('**/*.ts', { cwd: dir })) {
    if (typeof entry === 'string' && !entry.endsWith('.d.ts')) {
      out.push(resolve(dir, entry));
    }
  }
  return out;
}

function resolveImportTarget(fromFile: string, spec: string): string {
  // Only analyze relative imports. Bare specifiers (npm packages) are out of scope.
  if (!spec.startsWith('.')) return '';
  const abs = resolve(dirname(fromFile), spec.replace(/\.js$/, '.ts'));
  return relative(SRC_ROOT, abs).replace(/\\/g, '/');
}

function extractImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  const re = /(?:from|import)\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

function layerOf(relPath: string): string | null {
  const head = relPath.split('/')[0];
  return head ?? null;
}

const FORBIDDEN: Record<string, ReadonlyArray<string>> = {
  substrate:    ['runtime', 'integrations', 'adapters', 'ingestion', 'retrieval', 'llm-judge', 'cli', 'simulation', 'external'],
  runtime:      ['integrations', 'cli'],
  integrations: ['runtime', 'cli'],
  adapters:     ['runtime', 'integrations', 'cli'],
};

describe('architectural invariants: layer import boundaries', () => {
  for (const layer of Object.keys(FORBIDDEN)) {
    it(`${layer}/ does not import from forbidden layers`, async () => {
      const layerDir = resolve(SRC_ROOT, layer);
      const files = await listTsFiles(layerDir);
      const violations: Array<{ file: string; target: string }> = [];
      for (const file of files) {
        for (const spec of extractImports(file)) {
          const target = resolveImportTarget(file, spec);
          if (!target) continue;
          const targetLayer = layerOf(target);
          if (targetLayer && FORBIDDEN[layer]!.includes(targetLayer)) {
            violations.push({ file: relative(SRC_ROOT, file), target });
          }
        }
      }
      expect(violations).toEqual([]);
    });
  }
});
