/**
 * CodeAuthorActor (subpath: `/actors/code-author`).
 *
 * Outward actor that reifies the `pol-code-author-*` blast-radius
 * fence. The module name matches the principal id the actor runs
 * under; the actor's authority surface is defined entirely by the
 * four fence atoms, loaded + validated at `observe` time.
 *
 * Subpath import:
 *
 *   import { CodeAuthorActor } from 'layered-autonomous-governance/actors/code-author';
 *
 * LAG does not prescribe that you use this actor. It is a reference
 * implementation of a fence-gated outward actor; any consumer can
 * write their own against `src/actors/` with their own fence-atom
 * family.
 */

export { CodeAuthorActor } from './code-author.js';
export type {
  CodeAuthorAction,
  CodeAuthorAdapters,
  CodeAuthorObservation,
  CodeAuthorOutcome,
} from './code-author.js';

export {
  FENCE_ATOM_IDS,
  loadCodeAuthorFence,
  CodeAuthorFenceError,
} from './fence.js';

export {
  DRAFT_SCHEMA,
  DRAFT_SYSTEM_PROMPT,
  DrafterError,
  draftCodeChange,
  looksLikeUnifiedDiff,
} from './drafter.js';
export type {
  DraftCodeChangeInputs,
  DraftResult,
} from './drafter.js';
export type {
  CiGatePolicy,
  CodeAuthorFence,
  FenceAtomId,
  PerPrCostCapPolicy,
  SignedPrOnlyPolicy,
  WriteRevocationOnStopPolicy,
} from './fence.js';

export {
  GitOpsError,
  applyDraftBranch,
} from './git-ops.js';
export type {
  ApplyDraftBranchInputs,
  ApplyDraftBranchResult,
  GitIdentity,
  GitOpsErrorReason,
} from './git-ops.js';

export {
  PrCreationError,
  createDraftPr,
  renderPrBody,
} from './pr-creation.js';
export type {
  CreatePrInputs,
  CreatePrResult,
  PrBodyInputs,
  PrCreationErrorReason,
} from './pr-creation.js';
