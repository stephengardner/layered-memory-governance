/**
 * File-backed Host factory.
 *
 * Every store is rooted at `rootDir`. A second Host process pointing at the
 * same rootDir shares atoms, canon, audit, principals, and notifications
 * through the filesystem. This is the cross-session primitive: session A
 * writes, session B (fresh process) reads.
 *
 * LLM is the memory adapter's deterministic mock by default; tests compose
 * with ClaudeCliLLM or any other LLM adapter when real inference is wanted.
 */

import { rm } from 'node:fs/promises';
import type { Embedder, Host, LLM } from '../../substrate/interface.js';
import { MemoryLLM } from '../memory/llm.js';
import { MemoryClock } from '../memory/clock.js';
import { FileAtomStore } from './atom-store.js';
import { FileAuditor } from './auditor.js';
import { FileCanonStore } from './canon-store.js';
import { FileClock } from './clock.js';
import { FileNotifier } from './notifier.js';
import { FilePrincipalStore } from './principal-store.js';
import { FileScheduler } from './scheduler.js';
import { ensureDir } from './util.js';

export interface FileHostOptions {
  readonly rootDir: string;
  /**
   * Override the LLM slot. Defaults to the deterministic in-process
   * MemoryLLM so conformance tests can run without a real model or an
   * API key. Production callers pass a real adapter (e.g.
   * ClaudeCliLLM from adapters/claude-cli) that implements the LLM
   * interface.
   */
  readonly llm?: LLM;
  /**
   * Override the clock. Defaults to the real wall clock. Tests may pass a
   * MemoryClock for deterministic time.
   */
  readonly clock?: FileClock | MemoryClock;
  /**
   * Optional retrieval embedder. Defaults to TrigramEmbedder. Swap for
   * AnthropicEmbedder / onnx / etc. without touching the rest of the stack.
   */
  readonly embedder?: Embedder;
}

export interface FileHost extends Host {
  readonly atoms: FileAtomStore;
  readonly canon: FileCanonStore;
  readonly auditor: FileAuditor;
  readonly notifier: FileNotifier;
  readonly principals: FilePrincipalStore;
  readonly scheduler: FileScheduler;
  readonly rootDir: string;
  /** Test helper: delete all state under rootDir. */
  cleanup(): Promise<void>;
}

export async function createFileHost(options: FileHostOptions): Promise<FileHost> {
  const { rootDir } = options;
  await ensureDir(rootDir);

  const clock = options.clock ?? new FileClock();
  const atoms = new FileAtomStore(rootDir, options.embedder);
  const auditor = new FileAuditor(rootDir, clock as FileClock);
  const canon = new FileCanonStore(rootDir, clock as FileClock);
  await canon.init();
  const notifier = new FileNotifier(rootDir);
  const principals = new FilePrincipalStore(rootDir);
  const scheduler = new FileScheduler(rootDir);
  const llm = options.llm ?? new MemoryLLM(new MemoryClock());

  const host: FileHost = {
    atoms,
    auditor,
    canon,
    clock,
    notifier,
    principals,
    scheduler,
    llm,
    rootDir,
    async cleanup() {
      await rm(rootDir, { recursive: true, force: true });
    },
  };
  return host;
}

export {
  FileAtomStore,
  FileAuditor,
  FileCanonStore,
  FileClock,
  FileNotifier,
  FilePrincipalStore,
  FileScheduler,
};
