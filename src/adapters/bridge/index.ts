/**
 * bridge adapter entry point.
 *
 * Bridges LAG to the external ChromaDB store palace. The Host this factory returns
 * composes:
 *   - BridgeAtomStore (wraps FileAtomStore, adds bootstrapFromChroma).
 *   - FileCanonStore, FileNotifier, FileScheduler, FilePrincipalStore, FileClock
 *     (file-backed for durability + cross-session; isolated from the palace).
 *   - ClaudeCliLLM (real Claude CLI via OAuth, no API key).
 *
 * Directory layout (under options.rootDir):
 *   atoms/<id>.json                  LAG-native atoms and imported drawers
 *   canon/...                        canon state + proposals + history
 *   audit.jsonl, metrics.jsonl       append-only
 *   principals/                      principal records
 *   notifier/                        pending + responded events
 *   STOP                             kill-switch sentinel
 *
 * The palace at options.palacePath is NEVER written to; the bridge only reads it
 * via the Python bridge during bootstrap.
 */

import { createFileHost, type FileHost } from '../file/index.js';
import { ClaudeCliLLM, type ClaudeCliOptions } from '../claude-cli/llm.js';
import type { Embedder, Host } from '../../substrate/interface.js';
import type { PrincipalId } from '../../substrate/types.js';
import { BridgeAtomStore, type BootstrapResult, type BridgeAtomStoreOptions } from './atom-store.js';
import type { BootstrapOptions, BridgeDrawer } from './drawer-bridge.js';

export interface BridgeHostOptions {
  /** Path to the external palace to bootstrap from (e.g. <palace-path>). */
  readonly palacePath: string;
  /** Directory for LAG's own state (atoms, canon, audit). Separate from palace. */
  readonly rootDir: string;
  /** Principal stamped on bootstrapped atoms without an agent hint. */
  readonly defaultPrincipalId: PrincipalId;
  /** Optional prefix for imported atom ids (default 'phx_'). */
  readonly importedIdPrefix?: string;
  /** Optional Claude CLI options (claudePath, disallowedTools, verbose). */
  readonly claudeCli?: ClaudeCliOptions;
  /**
   * Optional retrieval embedder. Threads through to the underlying
   * FileAtomStore so bridge-hosted palaces can opt into semantic retrieval
   * (OnnxMiniLmEmbedder, CachingEmbedder) or any custom Embedder.
   * Defaults to TrigramEmbedder.
   */
  readonly embedder?: Embedder;
}

export interface BridgeHost extends Host {
  readonly atoms: BridgeAtomStore;
  readonly rootDir: string;
  readonly palacePath: string;
  /** Shortcut to BridgeAtomStore.bootstrapFromChroma against options.palacePath. */
  bootstrap(options?: BootstrapOptions): Promise<BootstrapResult>;
  /** Test helper: delete the rootDir. Does NOT touch the palace. */
  cleanup(): Promise<void>;
}

export async function createBridgeHost(options: BridgeHostOptions): Promise<BridgeHost> {
  const fileHost: FileHost = await createFileHost({
    rootDir: options.rootDir,
    ...(options.embedder !== undefined ? { embedder: options.embedder } : {}),
  });
  const phxAtomOptions: BridgeAtomStoreOptions = {
    defaultPrincipalId: options.defaultPrincipalId,
    ...(options.importedIdPrefix !== undefined
      ? { importedIdPrefix: options.importedIdPrefix }
      : {}),
  };
  const phxAtoms = new BridgeAtomStore(fileHost.atoms, phxAtomOptions);
  const llm = new ClaudeCliLLM(options.claudeCli ?? {});

  const host: BridgeHost = {
    atoms: phxAtoms,
    canon: fileHost.canon,
    notifier: fileHost.notifier,
    scheduler: fileHost.scheduler,
    auditor: fileHost.auditor,
    principals: fileHost.principals,
    clock: fileHost.clock,
    llm,
    rootDir: options.rootDir,
    palacePath: options.palacePath,
    async bootstrap(bootstrapOpts: BootstrapOptions = {}): Promise<BootstrapResult> {
      return phxAtoms.bootstrapFromChroma(options.palacePath, bootstrapOpts);
    },
    async cleanup(): Promise<void> {
      await fileHost.cleanup();
    },
  };
  return host;
}

export { BridgeAtomStore } from './atom-store.js';
export { dumpDrawers } from './drawer-bridge.js';
export type { BridgeAtomStoreOptions, BootstrapResult } from './atom-store.js';
export type { BootstrapOptions, BridgeDrawer } from './drawer-bridge.js';
