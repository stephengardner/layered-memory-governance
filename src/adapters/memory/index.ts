import type { Embedder, Host } from '../../substrate/interface.js';
import { MemoryAtomStore } from './atom-store.js';
import { MemoryAuditor } from './auditor.js';
import { MemoryCanonStore } from './canon-store.js';
import { MemoryClock } from './clock.js';
import { MemoryLLM } from './llm.js';
import { MemoryNotifier } from './notifier.js';
import { MemoryPrincipalStore } from './principal-store.js';
import { MemoryScheduler } from './scheduler.js';

export interface MemoryHostOptions {
  readonly clockStart?: string;
  /**
   * Optional retrieval embedder. If omitted, defaults to TrigramEmbedder
   * (fast, deterministic, adequate for V0; see design/phase-15-findings.md).
   * Pass an AnthropicEmbedder or similar to swap retrieval semantics
   * without touching the rest of the stack.
   */
  readonly embedder?: Embedder;
}

/**
 * Memory-backed Host with concrete adapter types exposed for test access.
 * Every adapter assignable up to its Host interface but callers that need
 * test helpers (MemoryClock.advance, MemoryLLM.register, etc.) can reach
 * them via this concrete typing.
 */
export interface MemoryHost extends Host {
  readonly atoms: MemoryAtomStore;
  readonly canon: MemoryCanonStore;
  readonly llm: MemoryLLM;
  readonly notifier: MemoryNotifier;
  readonly scheduler: MemoryScheduler;
  readonly auditor: MemoryAuditor;
  readonly principals: MemoryPrincipalStore;
  readonly clock: MemoryClock;
}

export function createMemoryHost(options: MemoryHostOptions = {}): MemoryHost {
  const clock = options.clockStart ? new MemoryClock(options.clockStart) : new MemoryClock();
  const atoms = new MemoryAtomStore(options.embedder);
  const canon = new MemoryCanonStore(clock);
  const llm = new MemoryLLM(clock);
  const notifier = new MemoryNotifier(clock);
  const scheduler = new MemoryScheduler(clock);
  const auditor = new MemoryAuditor(clock);
  const principals = new MemoryPrincipalStore(clock);
  return { atoms, canon, llm, notifier, scheduler, auditor, principals, clock };
}

export {
  MemoryAtomStore,
  MemoryAuditor,
  MemoryCanonStore,
  MemoryClock,
  MemoryLLM,
  MemoryNotifier,
  MemoryPrincipalStore,
  MemoryScheduler,
};
