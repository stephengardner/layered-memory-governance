/**
 * File-backed Auditor.
 *
 * Layout:
 *   rootDir/audit.jsonl                append-only event log
 *   rootDir/metrics.jsonl              append-only metric stream
 *
 * Query does a linear scan. Scales to ~1M events; migrate to SQLite when it
 * matters. Append-only property is enforced only by convention; conformance
 * tests verify file size is non-decreasing over writes.
 */

import { createHash } from 'node:crypto';
import type { Auditor } from '../../substrate/interface.js';
import type { AuditEvent, AuditFilter, AuditId } from '../../substrate/types.js';
import type { FileClock } from './clock.js';
import { appendLine, p, readFileOrNull } from './util.js';

export class FileAuditor implements Auditor {
  private readonly auditPath: string;
  private readonly metricsPath: string;

  constructor(rootDir: string, private readonly clock: FileClock) {
    this.auditPath = p(rootDir, 'audit.jsonl');
    this.metricsPath = p(rootDir, 'metrics.jsonl');
  }

  async log(event: AuditEvent): Promise<AuditId> {
    const line = JSON.stringify(event);
    await appendLine(this.auditPath, line);
    const digest = createHash('sha256')
      .update(line, 'utf8')
      .update(this.clock.monotonic().toString(), 'utf8')
      .digest('hex')
      .slice(0, 16);
    return digest as AuditId;
  }

  async query(filter: AuditFilter, limit: number): Promise<ReadonlyArray<AuditEvent>> {
    const text = await readFileOrNull(this.auditPath);
    if (!text) return [];
    const events = text
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as AuditEvent);

    const kinds = filter.kind ? new Set(filter.kind) : null;
    const principals = filter.principal_id ? new Set(filter.principal_id) : null;
    const atomIds = filter.atom_ids ? new Set(filter.atom_ids) : null;
    const after = filter.after;
    const before = filter.before;

    const out: AuditEvent[] = [];
    for (const ev of events) {
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
    const payload: Record<string, unknown> = {
      name,
      value,
      at: this.clock.now(),
    };
    if (tags) payload['tags'] = { ...tags };
    // Fire and forget; non-blocking contract.
    void appendLine(this.metricsPath, JSON.stringify(payload)).catch(() => {
      /* ignore; metrics must never block callers */
    });
  }

  // ---- Test helpers ----

  async size(): Promise<number> {
    const text = await readFileOrNull(this.auditPath);
    if (!text) return 0;
    return text.split('\n').filter(l => l.trim().length > 0).length;
  }
}
