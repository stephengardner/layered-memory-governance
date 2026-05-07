export { decayedConfidence, shouldUpdateConfidence } from './decay.js';
export { ttlExpirePatch, type TtlExpireOptions } from './ttl.js';
export { LoopRunner } from './runner.js';
export { readReaperTtlsFromCanon } from './reaper-ttls.js';
export {
  readApprovalCycleTickIntervalMs,
  DEFAULT_TICK_INTERVAL_MS,
} from './approval-cycle-interval.js';
export {
  readPrOrphanReconcileCadenceMs,
  DEFAULT_PR_ORPHAN_CADENCE_MS,
} from './pr-orphan-cadence.js';
export {
  DEFAULT_HALF_LIVES,
  type CanonTarget,
  type HalfLifeConfig,
  type LoopOptions,
  type LoopStats,
  type LoopTickReport,
} from './types.js';
