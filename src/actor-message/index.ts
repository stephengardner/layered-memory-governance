/**
 * Public surface of the actor-message primitive.
 *
 *   import {
 *     ActorMessageRateLimiter,
 *     CircuitBreakerOpenError,
 *     RateLimitedError,
 *   } from 'layered-autonomous-governance/actor-message';
 *
 * Exports:
 * - V1 type shapes for actor-message, actor-message-ack,
 *   circuit-breaker-trip, and circuit-breaker-reset atoms.
 * - ActorMessageRateLimiter: write-time token bucket + circuit breaker
 *   consuming the pol-actor-message-rate and
 *   pol-actor-message-circuit-breaker policy atoms.
 * - RateLimitedError / CircuitBreakerOpenError: typed errors thrown by
 *   checkWrite(), extending TransientError / ValidationError.
 */

export type {
  ActorMessageV1,
  ActorMessageAckV1,
  CircuitBreakerTripV1,
  CircuitBreakerResetV1,
  UrgencyTier,
} from './types.js';

export {
  ActorMessageRateLimiter,
  CircuitBreakerOpenError,
  RateLimitedError,
} from './rate-limiter.js';
export type { ActorMessageRateLimiterOptions } from './rate-limiter.js';

export { listUnread, emitAck } from './inbox-reader.js';
export type { InboxMessage, ListUnreadOptions } from './inbox-reader.js';

export {
  pickNextMessage,
  defaultOrdering,
} from './pickup.js';
export type {
  PickupOutcome,
  PickupOptions,
  OrderingFn,
} from './pickup.js';

export {
  validateResetWrite,
  ResetAuthorityError,
  ResetShapeError,
} from './reset-validator.js';
