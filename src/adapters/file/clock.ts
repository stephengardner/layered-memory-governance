import { hrtime } from 'node:process';
import type { Clock } from '../../substrate/interface.js';
import type { Time } from '../../substrate/types.js';

/**
 * Real wall-clock clock for the file adapter.
 *
 * Unlike MemoryClock this is non-deterministic: `now()` reflects real time
 * and advances as the process runs. Tests that rely on deterministic time
 * should use the memory clock via a composed test host.
 */
export class FileClock implements Clock {
  now(): Time {
    return new Date().toISOString();
  }

  monotonic(): bigint {
    return hrtime.bigint();
  }
}
