/**
 * Public surface of the actor-message primitive (PR A of the inbox
 * V1 sequence). Later PRs layer the inbox reader (PR B), the
 * lag-inbox CLI (PR C), the hybrid wake seam (PR D), and the
 * sub-actor registry (PR E) on top of these primitives.
 *
 *   import {
 *     ActorMessageRateLimiter,
 *     CircuitBreakerOpenError,
 *     RateLimitedError,
 *   } from 'layered-autonomous-governance/actor-message';
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
