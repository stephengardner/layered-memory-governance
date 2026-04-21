import { createHash } from 'node:crypto';
import { NotFoundError } from '../../substrate/errors.js';
import type { Notifier } from '../../substrate/interface.js';
import type {
  Diff,
  Disposition,
  Event,
  NotificationHandle,
  PrincipalId,
  Time,
} from '../../substrate/types.js';
import type { MemoryClock } from './clock.js';

interface PendingEntry {
  readonly event: Event;
  readonly diff: Diff | null;
  readonly defaultDisposition: Disposition;
  readonly timeoutAt: number; // wall-clock ms
  status: Disposition;
  respondedBy: PrincipalId | null;
}

/**
 * In-memory notifier with wall-clock timeouts.
 *
 * Note: `awaitDisposition` uses real setTimeout for timeout handling, not
 * the injected MemoryClock, because tests need real delay semantics when
 * awaiting. Callers using short timeoutMs values stay responsive.
 */
export class MemoryNotifier implements Notifier {
  private readonly entries = new Map<NotificationHandle, PendingEntry>();

  constructor(private readonly _clock: MemoryClock) {}

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

    if (!this.entries.has(handle)) {
      this.entries.set(handle, {
        event,
        diff,
        defaultDisposition,
        timeoutAt: Date.now() + timeoutMs,
        status: 'pending',
        respondedBy: null,
      });
    }
    return handle;
  }

  async disposition(handle: NotificationHandle): Promise<Disposition> {
    const entry = this.entries.get(handle);
    if (!entry) {
      throw new NotFoundError(`Notification handle ${String(handle)} not found`);
    }
    if (entry.status === 'pending' && Date.now() >= entry.timeoutAt) {
      entry.status = entry.defaultDisposition;
    }
    return entry.status;
  }

  async awaitDisposition(handle: NotificationHandle, maxWaitMs: number): Promise<Disposition> {
    const entry = this.entries.get(handle);
    if (!entry) {
      throw new NotFoundError(`Notification handle ${String(handle)} not found`);
    }
    if (entry.status !== 'pending') return entry.status;

    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      if (entry.status !== 'pending') return entry.status;
      if (Date.now() >= entry.timeoutAt) {
        entry.status = entry.defaultDisposition;
        return entry.status;
      }
      await sleep(5);
    }
    return entry.status;
  }

  async respond(
    handle: NotificationHandle,
    disposition: Disposition,
    responderId: PrincipalId,
  ): Promise<void> {
    const entry = this.entries.get(handle);
    if (!entry) {
      throw new NotFoundError(`Notification handle ${String(handle)} not found`);
    }
    if (disposition === 'pending') {
      throw new Error(`Cannot respond with "pending" disposition`);
    }
    entry.status = disposition;
    entry.respondedBy = responderId;
  }

  // ---- Test helpers ----

  size(): number {
    return this.entries.size;
  }

  /** Force-set an entry's status (for adversarial tests). */
  _forceStatus(handle: NotificationHandle, status: Disposition): void {
    const entry = this.entries.get(handle);
    if (entry) entry.status = status;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
