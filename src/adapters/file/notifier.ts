/**
 * File-backed Notifier.
 *
 * Layout under `rootDir/notifier/`:
 *   pending/<handle>.json               pending events
 *   responded/<handle>.json             resolved events (moved from pending)
 *
 * Polling-based awaitDisposition, same idea as the memory adapter. Works
 * across processes: a second process watching `pending/` can respond to
 * events by writing disposition and moving files.
 */

import { createHash } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';
import { NotFoundError } from '../../substrate/errors.js';
import type { Notifier } from '../../substrate/interface.js';
import type {
  Diff,
  Disposition,
  Event,
  NotificationHandle,
  PrincipalId,
} from '../../substrate/types.js';
import { isEnoent, p, readJsonOrNull, writeJson } from './util.js';

interface StoredEntry {
  readonly event: Event;
  readonly diff: Diff | null;
  readonly defaultDisposition: Disposition;
  readonly timeoutAt: number; // epoch ms
  status: Disposition;
  respondedBy: PrincipalId | null;
}

export class FileNotifier implements Notifier {
  private readonly pendingDir: string;
  private readonly respondedDir: string;

  constructor(rootDir: string) {
    const base = p(rootDir, 'notifier');
    this.pendingDir = p(base, 'pending');
    this.respondedDir = p(base, 'responded');
  }

  async telegraph(
    event: Event,
    diff: Diff | null,
    defaultDisposition: Disposition,
    timeoutMs: number,
  ): Promise<NotificationHandle> {
    const handle = createHash('sha256')
      .update(event.summary, 'utf8')
      .update('|', 'utf8')
      .update(event.created_at, 'utf8')
      .digest('hex')
      .slice(0, 24) as NotificationHandle;

    const pendingPath = this.pendingPath(handle);
    const existing = await readJsonOrNull<StoredEntry>(pendingPath);
    if (!existing) {
      const entry: StoredEntry = {
        event,
        diff,
        defaultDisposition,
        timeoutAt: Date.now() + timeoutMs,
        status: 'pending',
        respondedBy: null,
      };
      await writeJson(pendingPath, entry);
    }
    return handle;
  }

  async disposition(handle: NotificationHandle): Promise<Disposition> {
    const responded = await readJsonOrNull<StoredEntry>(this.respondedPath(handle));
    if (responded) return responded.status;

    const pending = await readJsonOrNull<StoredEntry>(this.pendingPath(handle));
    if (!pending) throw new NotFoundError(`Notification ${String(handle)} not found`);

    if (pending.status === 'pending' && Date.now() >= pending.timeoutAt) {
      const timed: StoredEntry = { ...pending, status: pending.defaultDisposition };
      await writeJson(this.pendingPath(handle), timed);
      return timed.status;
    }
    return pending.status;
  }

  async awaitDisposition(
    handle: NotificationHandle,
    maxWaitMs: number,
  ): Promise<Disposition> {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const d = await this.disposition(handle);
      if (d !== 'pending') return d;
      await sleep(20);
    }
    return await this.disposition(handle);
  }

  async respond(
    handle: NotificationHandle,
    disposition: Disposition,
    responderId: PrincipalId,
  ): Promise<void> {
    if (disposition === 'pending') {
      throw new Error(`Cannot respond with "pending" disposition`);
    }
    const pending = await readJsonOrNull<StoredEntry>(this.pendingPath(handle));
    if (!pending) throw new NotFoundError(`Notification ${String(handle)} not found`);
    const updated: StoredEntry = { ...pending, status: disposition, respondedBy: responderId };
    await writeJson(this.respondedPath(handle), updated);
    try {
      await rm(this.pendingPath(handle), { force: true });
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
  }

  /**
   * Test/ops helper: list handles of currently-pending notifications.
   * Reads the pending directory; does NOT apply timeout logic. Returns empty
   * when the directory does not exist yet.
   */
  async listPending(): Promise<ReadonlyArray<NotificationHandle>> {
    const { readdir } = await import('node:fs/promises');
    try {
      const entries = await readdir(this.pendingDir);
      return entries
        .filter(name => name.endsWith('.json'))
        .map(name => name.replace(/\.json$/, '') as NotificationHandle);
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
  }

  /**
   * Ops helper: fetch the full pending entry (event + diff + defaults).
   * Returns null if no longer pending. Used by the `lag-respond` CLI to
   * display notification details to the operator.
   */
  async getPendingEntry(handle: NotificationHandle): Promise<{
    readonly event: Event;
    readonly diff: Diff | null;
    readonly defaultDisposition: Disposition;
    readonly timeoutAt: number;
  } | null> {
    const entry = await readJsonOrNull<StoredEntry>(this.pendingPath(handle));
    if (!entry) return null;
    return {
      event: entry.event,
      diff: entry.diff,
      defaultDisposition: entry.defaultDisposition,
      timeoutAt: entry.timeoutAt,
    };
  }

  // ---- Private ----

  private pendingPath(handle: NotificationHandle): string {
    return p(this.pendingDir, `${String(handle)}.json`);
  }

  private respondedPath(handle: NotificationHandle): string {
    return p(this.respondedDir, `${String(handle)}.json`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
