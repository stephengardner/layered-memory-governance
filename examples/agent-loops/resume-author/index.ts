export { ResumeAuthorAgentLoopAdapter } from './loop.js';
export type { ResumeAuthorAdapterOptions } from './loop.js';

export { SameMachineCliResumeStrategy } from './strategies/same-machine.js';
export type { SameMachineCliResumeStrategyOptions } from './strategies/same-machine.js';

export { BlobShippedSessionResumeStrategy } from './strategies/blob-shipped.js';
export type { BlobShippedStrategyOptions } from './strategies/blob-shipped.js';

export { walkAuthorSessions } from './walk-author-sessions.js';

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

export { buildDefaultRegistry } from './default-registry.js';

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
