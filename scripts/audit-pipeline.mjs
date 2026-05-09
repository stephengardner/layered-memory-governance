#!/usr/bin/env node
// Bin entrypoint for `lag-audit-pipeline`. The shebang lives here so
// the file is directly executable; the pure rendering logic lives in
// scripts/lib/audit-pipeline-core.mjs (shebang-free) so .test.ts files
// can static-import without vitest's Windows-CI shebang-strip bug.
// Pattern mirrors scripts/cr-precheck.mjs + lib/cr-precheck.mjs.
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditPipeline } from './lib/audit-pipeline-core.mjs';

// Re-export so an out-of-tree caller importing 'audit-pipeline.mjs'
// directly (the prior public surface before the lib/ extraction) still
// resolves the function. New callers should import from lib/ directly.
export { auditPipeline } from './lib/audit-pipeline-core.mjs';

const USAGE = `Usage: lag-audit-pipeline --pipeline-id <id>

Walk the file adapter for <id> and print a tree of the six pipeline
stage atoms with atom_id, timestamp, and atom_type per leaf.

Options:
  --pipeline-id <id>   Pipeline id to audit (required)
  -h, --help           Show this help
`;

function parseArgs(argv) {
  const out = { pipelineId: null, help: false, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      out.help = true;
    } else if (a === '--pipeline-id') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        out.error = 'Missing value for --pipeline-id';
        return out;
      }
      out.pipelineId = v;
      i++;
    } else {
      out.error = `Unknown argument: ${a}`;
      return out;
    }
  }
  return out;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.error) {
    process.stderr.write(`${args.error}\n\n${USAGE}`);
    return 2;
  }
  if (!args.pipelineId) {
    process.stderr.write(`Missing required --pipeline-id\n\n${USAGE}`);
    return 2;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const hostUrl = pathToFileURL(resolve(here, '..', 'dist', 'adapters', 'file', 'index.js')).href;
  const mod = await import(hostUrl);
  if (typeof mod.createFileHost !== 'function') {
    process.stderr.write(
      'Unable to construct file host from dist/adapters/file/index.js: '
      + 'createFileHost export missing. Run `npm run build` to refresh dist/.\n',
    );
    return 2;
  }
  const rootDir = resolve(here, '..', '.lag');
  const host = await mod.createFileHost({ rootDir });
  if (!host?.atoms || typeof host.atoms.query !== 'function') {
    process.stderr.write(
      'File host is missing required atoms.query(...) API; '
      + 'rebuild dist/ with `npm run build` to refresh host exports.\n',
    );
    return 2;
  }
  // Adapter shim: auditPipeline expects a `query({atom_type, pipeline_id})`
  // surface. Bridge that to host.atoms.query({type: [...]}, limit) and
  // filter client-side by the atom's metadata.pipeline_id (preferred) or
  // provenance.derived_from chain (fallback for stage-output atoms that
  // pre-date the metadata.pipeline_id stamp). Pagination is exhausted so
  // a long-running pipeline with many stage-event atoms still surfaces.
  const adapter = {
    async query({ atom_type, pipeline_id }) {
      const out = [];
      let cursor;
      // Conservative page size: balances memory against round-trips for
      // a single audit run. The file adapter's query is in-process so
      // this does not hit a network bound.
      const PAGE_SIZE = 200;
      for (;;) {
        const page = await host.atoms.query({ type: [atom_type] }, PAGE_SIZE, cursor);
        for (const atom of page.atoms) {
          const metaPipelineId = atom.metadata?.pipeline_id;
          const derivedFrom = atom.provenance?.derived_from ?? [];
          const matches =
            metaPipelineId === pipeline_id
            || derivedFrom.includes(pipeline_id);
          if (matches) {
            out.push({
              atom_id: atom.id,
              atom_type: atom.type,
              pipeline_id,
              timestamp: atom.created_at,
            });
          }
        }
        if (!page.cursor) break;
        cursor = page.cursor;
      }
      return out;
    },
  };
  const result = await auditPipeline({ adapter, pipelineId: args.pipelineId });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.exitCode;
}

const invokedAsBin = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsBin) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err?.stack || err}\n`);
      process.exit(1);
    },
  );
}
