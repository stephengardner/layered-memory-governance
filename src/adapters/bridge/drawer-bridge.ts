/**
 * Bridge: dump bridge drawers to the Node process via a Python helper.
 *
 * Calls `scripts/bridge_bootstrap.py` which uses chromadb.PersistentClient to
 * read the palace. Returns an array of BridgeDrawer records. Safe to run
 * concurrently with a live external ChromaDB process (ChromaDB supports multi-reader).
 *
 * Why shell out to Python: the chromadb JS client is HTTP-only and does not
 * support reading a local persistent directory. the external palace is a
 * local-directory ChromaDB. Python's chromadb package IS what wrote the data;
 * dumping through it is the lowest-risk read path.
 */

import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { UnsupportedError, ValidationError } from '../../substrate/errors.js';

export interface BridgeDrawer {
  readonly id: string;
  readonly document: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface BootstrapOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly collection?: string;
  readonly pythonPath?: string;
  /** Optional JSON where-clause for chromadb filtering. */
  readonly where?: Readonly<Record<string, unknown>>;
  /** Path to the bootstrap script. Defaults to scripts/bridge_bootstrap.py in repo. */
  readonly scriptPath?: string;
}

const DEFAULT_LIMIT = 500;
const DEFAULT_COLLECTION = 'lmg_bridge_drawers';

function resolveScriptPath(): string {
  try {
    // ESM: import.meta.url resolves to the compiled module path.
    const here = fileURLToPath(import.meta.url);
    // src/adapters/bridge/drawer-bridge.ts  ->  scripts/bridge_bootstrap.py
    // After build: dist/adapters/bridge/drawer-bridge.js -> ../../../scripts/bridge_bootstrap.py
    return resolve(dirname(here), '..', '..', '..', 'scripts', 'bridge_bootstrap.py');
  } catch {
    return join('scripts', 'bridge_bootstrap.py');
  }
}

export async function dumpDrawers(
  palacePath: string,
  options: BootstrapOptions = {},
): Promise<BridgeDrawer[]> {
  const scriptPath = options.scriptPath ?? resolveScriptPath();
  const args: string[] = [
    scriptPath,
    palacePath,
    '--limit',
    String(options.limit ?? DEFAULT_LIMIT),
    '--offset',
    String(options.offset ?? 0),
    '--collection',
    options.collection ?? DEFAULT_COLLECTION,
  ];
  if (options.where) {
    args.push('--where', JSON.stringify(options.where));
  }

  const pythonBin = options.pythonPath ?? 'python';
  let result;
  try {
    result = await execa(pythonBin, args, {
      stripFinalNewline: false,
      reject: false,
      stdin: 'ignore',
      encoding: 'utf8',
    });
  } catch (err) {
    throw new UnsupportedError(
      `Failed to execute ${pythonBin} ${args.join(' ')}; is Python + chromadb installed?`,
      { cause: err instanceof Error ? err : undefined },
    );
  }

  if (result.exitCode !== 0) {
    const stderr = result.stderr ?? '';
    if (result.exitCode === 2) {
      throw new UnsupportedError(`chromadb not installed: ${stderr.slice(0, 200)}`);
    }
    throw new ValidationError(
      `bridge_bootstrap.py exit=${result.exitCode}: ${stderr.slice(0, 400)}`,
    );
  }

  const stdout = result.stdout ?? '';
  const drawers: BridgeDrawer[] = [];
  const lines = stdout.split('\n').filter(line => line.trim().length > 0);
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as BridgeDrawer;
      if (!record.id || record.document === undefined) continue;
      drawers.push(record);
    } catch {
      // Skip malformed lines rather than failing the whole dump.
    }
  }
  return drawers;
}
