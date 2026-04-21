/**
 * Deliberately non-compliant adapter.
 *
 * Purpose: prove the conformance suite actually detects interface violations.
 * If `it.fails(...)` tests against this adapter PASS (meaning the broken
 * behavior was caught), the suite is working.
 *
 * Violations injected (each mapped to a conformance assertion):
 *   1. AtomStore.embed is non-deterministic (returns Math.random vector).
 *      Violates: "embed is deterministic across calls".
 *   2. Auditor.log is a no-op; audit log never grows.
 *      Violates: "append-only: size is monotonically non-decreasing".
 *   3. Notifier.respond accepts "pending" disposition.
 *      Violates: "respond with pending throws".
 *
 * Everything else delegates to the memory adapter, so only these specific
 * conformance tests should fail.
 */

import type {
  AtomStore,
  Auditor,
  CanonStore,
  Clock,
  Host,
  LLM,
  Notifier,
  PrincipalStore,
  Scheduler,
} from '../../substrate/interface.js';
import type {
  AuditEvent,
  AuditId,
  Disposition,
  NotificationHandle,
  PrincipalId,
  Vector,
} from '../../substrate/types.js';
import { createMemoryHost, type MemoryHost } from '../memory/index.js';

class NonDeterministicAtomStore implements AtomStore {
  constructor(private readonly base: AtomStore) {}

  async put(...args: Parameters<AtomStore['put']>) { return this.base.put(...args); }
  async get(...args: Parameters<AtomStore['get']>) { return this.base.get(...args); }
  async query(...args: Parameters<AtomStore['query']>) { return this.base.query(...args); }
  async search(...args: Parameters<AtomStore['search']>) { return this.base.search(...args); }
  async update(...args: Parameters<AtomStore['update']>) { return this.base.update(...args); }
  async batchUpdate(...args: Parameters<AtomStore['batchUpdate']>) { return this.base.batchUpdate(...args); }

  async embed(_text: string): Promise<Vector> {
    // VIOLATION: non-deterministic
    const v = new Array(128).fill(0).map(() => Math.random());
    return Object.freeze(v);
  }

  similarity(...args: Parameters<AtomStore['similarity']>) { return this.base.similarity(...args); }
  contentHash(...args: Parameters<AtomStore['contentHash']>) { return this.base.contentHash(...args); }
}

class DroppingAuditor implements Auditor {
  constructor(private readonly base: Auditor) {}

  async log(_event: AuditEvent): Promise<AuditId> {
    // VIOLATION: drops the event, returns a bogus id
    return 'dropped' as AuditId;
  }

  async query(...args: Parameters<Auditor['query']>) { return this.base.query(...args); }
  metric(...args: Parameters<Auditor['metric']>) { this.base.metric(...args); }

  // Test-accessor passthrough: size() always returns 0 now.
  size(): number { return 0; }
  allMetrics(): ReadonlyArray<{ name: string; value: number; tags?: Readonly<Record<string, string>> }> {
    return (this.base as unknown as { allMetrics?: () => ReadonlyArray<{ name: string; value: number; tags?: Readonly<Record<string, string>> }> })
      .allMetrics?.() ?? [];
  }
}

class LaxNotifier implements Notifier {
  constructor(private readonly base: Notifier) {}

  async telegraph(...args: Parameters<Notifier['telegraph']>) { return this.base.telegraph(...args); }
  async disposition(...args: Parameters<Notifier['disposition']>) { return this.base.disposition(...args); }
  async awaitDisposition(...args: Parameters<Notifier['awaitDisposition']>) { return this.base.awaitDisposition(...args); }

  async respond(
    handle: NotificationHandle,
    disposition: Disposition,
    responderId: PrincipalId,
  ): Promise<void> {
    // VIOLATION: accepts "pending" without throwing
    if (disposition === 'pending') {
      return; // silently accepted
    }
    return this.base.respond(handle, disposition, responderId);
  }
}

export interface InvalidHost extends Host {
  readonly atoms: AtomStore;
  readonly canon: CanonStore;
  readonly llm: LLM;
  readonly notifier: Notifier;
  readonly scheduler: Scheduler;
  readonly auditor: Auditor;
  readonly principals: PrincipalStore;
  readonly clock: Clock;
  readonly _inner: MemoryHost;
}

export function createInvalidHost(): InvalidHost {
  const inner = createMemoryHost();
  return {
    atoms: new NonDeterministicAtomStore(inner.atoms),
    canon: inner.canon,
    llm: inner.llm,
    notifier: new LaxNotifier(inner.notifier),
    scheduler: inner.scheduler,
    auditor: new DroppingAuditor(inner.auditor),
    principals: inner.principals,
    clock: inner.clock,
    _inner: inner,
  };
}
