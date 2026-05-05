export { ResumeAuthorAgentLoopAdapter } from './loop.js';
export type { ResumeAuthorAdapterOptions } from './loop.js';

export { SameMachineCliResumeStrategy } from './strategies/same-machine.js';
export type { SameMachineCliResumeStrategyOptions } from './strategies/same-machine.js';

export { BlobShippedSessionResumeStrategy } from './strategies/blob-shipped.js';
export type { BlobShippedStrategyOptions } from './strategies/blob-shipped.js';

export { walkAuthorSessions, walkAuthorSessionsForPrFix } from './walk-author-sessions.js';
export type { PrFixWalkInput } from './walk-author-sessions.js';

export {
  ctoActorResumeStrategyDescriptor,
  CTO_ACTOR_PRINCIPAL_ID,
  CTO_ACTOR_WORK_ITEM_KEY_PREFIXES,
} from './cto-actor-strategy.js';
export type { CtoActorResumeInput } from './cto-actor-strategy.js';

export {
  codeAuthorResumeStrategyDescriptor,
  CODE_AUTHOR_PRINCIPAL_ID,
  CODE_AUTHOR_WORK_ITEM_KEY_PREFIXES,
} from './code-author-strategy.js';

export {
  prFixActorResumeStrategyDescriptor,
  PR_FIX_ACTOR_PRINCIPAL_ID,
  PR_FIX_ACTOR_WORK_ITEM_KEY_PREFIXES,
  encodePrFixWorkItemKey,
} from './pr-fix-actor-strategy.js';
export type { PrFixActorResumeInput } from './pr-fix-actor-strategy.js';

export { buildDefaultRegistry } from './default-registry.js';

export {
  addDescriptor,
  createResumeStrategyRegistry,
  resumeStrategyPolicySchema,
  validatePolicy,
  WorkItemKeyCollisionError,
  wrapAgentLoopAdapterIfEnabled,
  wrapIfEnabled,
} from './registry.js';
export type {
  AgentLoopWrapOptions,
  PrincipalId as RegistryPrincipalId,
  RegistryHost,
  ResumeStrategyDescriptor,
  ResumeStrategyPolicy,
  ResumeStrategyRegistry,
} from './registry.js';

export type {
  ActorWalkInput,
} from './strategy-common.js';
export {
  asCandidate,
  assembleActorCandidates,
  readMetaNumber,
  readMetaString,
} from './strategy-common.js';

export type {
  SessionResumeStrategy,
  CandidateSession,
  ResolvedSession,
  ResumeContext,
} from './types.js';
