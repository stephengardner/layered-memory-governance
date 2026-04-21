import { randomUUID } from 'node:crypto';
import type { Scheduler, SchedulerHandler } from '../../substrate/interface.js';
import type { RegistrationId } from '../../substrate/types.js';
import type { MemoryClock } from './clock.js';

interface DeferredRegistration {
  readonly id: RegistrationId;
  readonly taskId: string;
  readonly handler: SchedulerHandler;
  readonly timer: NodeJS.Timeout;
  readonly kind: 'defer';
}

interface RecurringRegistration {
  readonly id: RegistrationId;
  readonly taskId: string;
  readonly cronExpr: string;
  readonly handler: SchedulerHandler;
  readonly kind: 'recurring';
}

type Registration = DeferredRegistration | RecurringRegistration;

/**
 * In-memory scheduler.
 *
 * `defer` uses real setTimeout. Tests using short delays (ms) and small
 * `await sleep(X)` calls validate behavior.
 *
 * `recurring` is stored but not fired automatically in V0 (no cron library).
 * Tests can call `tick()` to manually invoke recurring handlers.
 *
 * `killswitchCheck` returns the flag set via `kill()` (test helper).
 */
export class MemoryScheduler implements Scheduler {
  private readonly registrations = new Map<RegistrationId, Registration>();
  private killed = false;

  constructor(private readonly _clock: MemoryClock) {}

  recurring(taskId: string, cronExpr: string, handler: SchedulerHandler): RegistrationId {
    const id = randomUUID() as RegistrationId;
    this.registrations.set(id, { id, taskId, cronExpr, handler, kind: 'recurring' });
    return id;
  }

  defer(taskId: string, delayMs: number, handler: SchedulerHandler): RegistrationId {
    const id = randomUUID() as RegistrationId;
    const timer = setTimeout(async () => {
      if (this.killed) return;
      try {
        await handler();
      } finally {
        this.registrations.delete(id);
      }
    }, delayMs);
    this.registrations.set(id, { id, taskId, handler, timer, kind: 'defer' });
    return id;
  }

  cancel(reg: RegistrationId): void {
    const r = this.registrations.get(reg);
    if (!r) return;
    if (r.kind === 'defer') {
      clearTimeout(r.timer);
    }
    this.registrations.delete(reg);
  }

  killswitchCheck(): boolean {
    return this.killed;
  }

  // ---- Test helpers ----

  /** Toggle the kill switch. */
  kill(): void {
    this.killed = true;
    // Cancel all pending deferred tasks.
    for (const r of this.registrations.values()) {
      if (r.kind === 'defer') {
        clearTimeout(r.timer);
      }
    }
    this.registrations.clear();
  }

  /** Reset the kill switch (test only). */
  revive(): void {
    this.killed = false;
  }

  /** Manually invoke all recurring handlers once. */
  async tickRecurring(): Promise<void> {
    if (this.killed) return;
    const rec = Array.from(this.registrations.values()).filter(
      (r): r is RecurringRegistration => r.kind === 'recurring',
    );
    for (const r of rec) {
      await r.handler();
    }
  }

  size(): number {
    return this.registrations.size;
  }
}
