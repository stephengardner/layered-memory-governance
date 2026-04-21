import { createHash } from 'node:crypto';
import type { Auditor } from '../../substrate/interface.js';
import type { AuditEvent, AuditFilter, AuditId } from '../../substrate/types.js';
import type { MemoryClock } from './clock.js';

/**
 * In-memory append-only audit log.
 *
 * Invariants (verified by conformance):
 *   - log(event) never replaces or mutates prior events.
 *   - query returns events in insertion order (newest last).
 *   - metric() is non-blocking.
 */
export class MemoryAuditor implements Auditor {
  private readonly events: AuditEvent[] = [];
  private readonly metrics: Array<{
    readonly name: string;
    readonly value: number;
    readonly tags: Readonly<Record<string, string>> | undefined;
    readonly at: bigint;
  }> = [];

  constructor(private readonly clock: MemoryClock) {}

  async log(event: AuditEvent): Promise<AuditId> {
    this.events.push(event);
    const digest = createHash('sha256')
      .update(JSON.stringify(event), 'utf8')
      .update(this.clock.monotonic().toString(), 'utf8')
      .digest('hex')
      .slice(0, 16);
    return digest as AuditId;
  }

  async query(filter: AuditFilter, limit: number): Promise<ReadonlyArray<AuditEvent>> {
    const kinds = filter.kind ? new Set(filter.kind) : null;
    const principals = filter.principal_id ? new Set(filter.principal_id) : null;
    const atomIds = filter.atom_ids ? new Set(filter.atom_ids) : null;
    const after = filter.after;
    const before = filter.before;

    const out: AuditEvent[] = [];
    for (const ev of this.events) {
      if (kinds && !kinds.has(ev.kind)) continue;
      if (principals && !principals.has(ev.principal_id)) continue;
      if (after !== undefined && ev.timestamp <= after) continue;
      if (before !== undefined && ev.timestamp >= before) continue;
      if (atomIds) {
        const refIds = ev.refs.atom_ids ?? [];
        if (!refIds.some(id => atomIds.has(id))) continue;
      }
      out.push(ev);
      if (out.length >= limit) break;
    }
    return out;
  }

  metric(name: string, value: number, tags?: Readonly<Record<string, string>>): void {
    this.metrics.push({
      name,
      value,
      tags: tags ? Object.freeze({ ...tags }) : undefined,
      at: this.clock.monotonic(),
    });
  }

  // ---- Test-only helpers ----

  size(): number {
    return this.events.length;
  }

  allMetrics(): ReadonlyArray<{ name: string; value: number; tags?: Readonly<Record<string, string>> }> {
    return this.metrics.map(m => ({ name: m.name, value: m.value, ...(m.tags ? { tags: m.tags } : {}) }));
  }
}
