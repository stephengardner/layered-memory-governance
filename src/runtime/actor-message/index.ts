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

export {
  readOrderingPolicy,
  DEFAULT_ORDERING_POLICY,
} from './ordering-policy.js';
export type { OrderingPolicyConfig } from './ordering-policy.js';

export { runInboxPoller } from './poller.js';
export type { InboxPollerOptions } from './poller.js';

export { SubActorRegistry } from './sub-actor-registry.js';
export type { InvokeResult, SubActorInvoker } from './sub-actor-registry.js';

export { runAuditor } from './auditor-actor.js';
export type { AuditorPayload, AuditFinding } from './auditor-actor.js';

export {
  runCodeAuthor,
  mkCodeAuthorInvokedAtomId,
} from './code-author-invoker.js';
export type {
  CodeAuthorPayload,
  CodeAuthorExecutor,
  CodeAuthorExecutorResult,
  CodeAuthorExecutorSuccess,
  CodeAuthorExecutorFailure,
} from './code-author-invoker.js';

// The default executor (drafter + git-ops + pr-creation composition)
// is a concrete, GitHub-backed implementation of CodeAuthorExecutor.
// Intentionally NOT re-exported from this barrel so the primitive
// surface stays seam-only: consumers importing `actor-message`
// receive the invoker and the executor interface; consumers who want
// the default chain opt in via the `/actor-message/executor-default`
// subpath (see package.json exports + src/actor-message/executor-default.ts).

export { runDispatchTick } from './plan-dispatch.js';
export type { DelegationEnvelope, DispatchTickResult } from './plan-dispatch.js';

export {
  runAutoApprovePass,
  FALLBACK_AUTO_APPROVE,
} from './auto-approve.js';
export type {
  AutoApprovePolicyConfig,
  AutoApproveTickResult,
} from './auto-approve.js';

export {
  runPlanApprovalTick,
  FALLBACK_PLAN_APPROVAL,
} from './plan-approval.js';
export type {
  PlanApprovalPolicyConfig,
  PlanApprovalTickOptions,
  PlanApprovalTickResult,
} from './plan-approval.js';

export {
  sendOperatorEscalation,
  shouldEscalate,
  renderEscalationBody,
  escalationAtomId,
} from './operator-escalation.js';
export type {
  OperatorEscalationContext,
  EscalationWriteOutcome,
} from './operator-escalation.js';
