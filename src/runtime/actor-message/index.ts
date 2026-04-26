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

// Agentic CodeAuthorExecutor: composes the agentic-actor-loop substrate
// (AgentLoopAdapter + WorkspaceProvider + BlobStore + Redactor +
// per-actor policy resolvers) into a CodeAuthorExecutor implementation.
// Operators choose between the diff-based and agentic flavors by which
// factory they wire into their executor config.
export {
  buildAgenticCodeAuthorExecutor,
} from './agentic-code-author-executor.js';
export type {
  AgenticExecutorConfig,
} from './agentic-code-author-executor.js';

// Diff-based CodeAuthorExecutor: composes drafter + git-ops + pr-creation
// in a single LLM call. Preferred name for new code; the deprecated
// `buildDefaultCodeAuthorExecutor` alias below resolves to the same
// factory for one minor release.
export {
  buildDiffBasedCodeAuthorExecutor,
} from './diff-based-code-author-executor.js';
export type {
  DiffBasedExecutorConfig,
} from './diff-based-code-author-executor.js';

// Deprecated back-compat alias: imports via the old name continue to
// resolve to the same factory while consumers migrate. Will be removed
// in the release after.
export {
  buildDefaultCodeAuthorExecutor,
} from './code-author-executor-default.js';
export type {
  DefaultExecutorConfig,
} from './code-author-executor-default.js';

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

export {
  RADIUS_RANK,
  SkipReason,
  isBlastRadiusWithin,
  findIntentInProvenance,
  runIntentAutoApprovePass,
} from './intent-approve.js';
export type {
  BlastRadius,
  IntentAutoApproveResult,
  IntentAutoApproveOptions,
  SkippedByReason,
} from './intent-approve.js';
