/**
 * In-process scheduler for the file adapter.
 *
 * Same shape as the memory scheduler: defer uses real setTimeout, recurring
 * is stored but not auto-fired (use `tickRecurring()` from tests). Kill
 * switch is checked via the interface method; the file adapter also honors
 * a `STOP` file in rootDir.
 */

import { randomUUID } from 'node:crypto';
import { readFileOrNull, p } from './util.js';
import type { Scheduler, SchedulerHandler } from '../../substrate/interface.js';
import type { RegistrationId } from '../../substrate/types.js';

interface DeferredReg {
  readonly id: RegistrationId;
  readonly taskId: string;
  readonly timer: NodeJS.Timeout;
  readonly kind: 'defer';
}

interface RecurringReg {
  readonly id: RegistrationId;
  readonly taskId: string;
  readonly cronExpr: string;
  readonly handler: SchedulerHandler;
  readonly kind: 'recurring';
}

type Reg = DeferredReg | RecurringReg;

export class FileScheduler implements Scheduler {
  private readonly stopFile: string;
  private readonly regs = new Map<RegistrationId, Reg>();
  private killedManually = false;

  constructor(rootDir: string) {
    this.stopFile = p(rootDir, 'STOP');
  }

  recurring(taskId: string, cronExpr: string, handler: SchedulerHandler): RegistrationId {
    const id = randomUUID() as RegistrationId;
    this.regs.set(id, { id, taskId, cronExpr, handler, kind: 'recurring' });
    return id;
  }

  defer(taskId: string, delayMs: number, handler: SchedulerHandler): RegistrationId {
    const id = randomUUID() as RegistrationId;
    const timer = setTimeout(async () => {
      if (await this.isKilled()) return;
      try {
        await handler();
      } finally {
        this.regs.delete(id);
      }
    }, delayMs);
    this.regs.set(id, { id, taskId, timer, kind: 'defer' });
    return id;
  }

  cancel(reg: RegistrationId): void {
    const r = this.regs.get(reg);
    if (!r) return;
    if (r.kind === 'defer') clearTimeout(r.timer);
    this.regs.delete(reg);
  }

  killswitchCheck(): boolean {
    if (this.killedManually) return true;
    // Note: this is sync to match the interface. Callers of scheduled
    // handlers that check async state should use the internal async path.
    return false;
  }

  /** Async kill-switch check that also honors the STOP file. */
  async isKilled(): Promise<boolean> {
    if (this.killedManually) return true;
    return (await readFileOrNull(this.stopFile)) !== null;
  }

  // ---- Test helpers ----

  kill(): void {
    this.killedManually = true;
    for (const r of this.regs.values()) {
      if (r.kind === 'defer') clearTimeout(r.timer);
    }
    this.regs.clear();
  }

  revive(): void {
    this.killedManually = false;
  }

  async tickRecurring(): Promise<void> {
    if (await this.isKilled()) return;
    const rec = Array.from(this.regs.values()).filter(
      (r): r is RecurringReg => r.kind === 'recurring',
    );
    for (const r of rec) await r.handler();
  }

  size(): number {
    return this.regs.size;
  }
}
