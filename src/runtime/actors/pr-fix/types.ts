import type { PrIdentifier, PrReviewAdapter, ReviewComment, SubmittedReview, CheckRun, LegacyStatus } from '../pr-review/adapter.js';
import type { AgentLoopAdapter } from '../../../substrate/agent-loop.js';
import type { WorkspaceProvider } from '../../../substrate/workspace-provider.js';
import type { BlobStore } from '../../../substrate/blob-store.js';
import type { Redactor } from '../../../substrate/redactor.js';
import type { GhClient } from '../../../external/github/index.js';
import type { ActorAdapter } from '../types.js';
import type { AtomId } from '../../../substrate/types.js';

/**
 * The adapter map `PrFixActor` requires.
 *
 * Substrate primitives (`AgentLoopAdapter`, `WorkspaceProvider`, `BlobStore`,
 * `Redactor`, `GhClient`) do not themselves carry the `ActorAdapter`
 * `{name, version}` shape because they are reusable across the substrate.
 * `PrFixAdapters` therefore intersects each slot with `ActorAdapter` so
 * the whole record satisfies `Readonly<Record<string, ActorAdapter>>`
 * (the constraint `Actor<>` enforces). Callers wrap each substrate
 * instance with a `{name, version}` label when constructing the bag.
 */
export interface PrFixAdapters {
  readonly review: PrReviewAdapter;
  readonly agentLoop: AgentLoopAdapter & ActorAdapter;
  readonly workspaceProvider: WorkspaceProvider & ActorAdapter;
  readonly blobStore: BlobStore & ActorAdapter;
  readonly redactor: Redactor & ActorAdapter;
  readonly ghClient: GhClient & ActorAdapter;
  readonly [k: string]: ActorAdapter;
}

export interface PrFixObservation {
  readonly pr: PrIdentifier;
  readonly headBranch: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly lineComments: ReadonlyArray<ReviewComment>;
  readonly bodyNits: ReadonlyArray<ReviewComment>;
  readonly submittedReviews: ReadonlyArray<SubmittedReview>;
  readonly checkRuns: ReadonlyArray<CheckRun>;
  readonly legacyStatuses: ReadonlyArray<LegacyStatus>;
  readonly mergeStateStatus: string | null;
  readonly mergeable: boolean | null;
  readonly partial: boolean;
  readonly observationAtomId: AtomId;
}

export type PrFixClassification = 'all-clean' | 'has-findings' | 'ci-failure' | 'architectural' | 'partial';

export type PrFixAction =
  | {
      readonly kind: 'agent-loop-dispatch';
      readonly findings: ReadonlyArray<ReviewComment>;
      readonly planAtomId: AtomId;
      readonly headBranch: string;
    }
  | {
      readonly kind: 'pr-escalate';
      readonly reason: string;
    };

export type PrFixOutcome =
  | {
      readonly kind: 'fix-pushed';
      readonly commitSha: string;
      readonly resolvedCommentIds: ReadonlyArray<string>;
      readonly sessionAtomId: AtomId;
    }
  | {
      readonly kind: 'fix-failed';
      readonly stage: string;
      readonly reason: string;
      readonly sessionAtomId: AtomId | null;
    }
  | {
      readonly kind: 'escalated';
      readonly reason: string;
    };
