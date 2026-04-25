import type { PrIdentifier, PrReviewAdapter, ReviewComment, SubmittedReview, CheckRun, LegacyStatus } from '../pr-review/adapter.js';
import type { AgentLoopAdapter } from '../../../substrate/agent-loop.js';
import type { WorkspaceProvider } from '../../../substrate/workspace-provider.js';
import type { BlobStore } from '../../../substrate/blob-store.js';
import type { Redactor } from '../../../substrate/redactor.js';
import type { GhClient } from '../../../external/github/index.js';
import type { AtomId } from '../../../substrate/types.js';

export interface PrFixAdapters {
  readonly review: PrReviewAdapter;
  readonly agentLoop: AgentLoopAdapter;
  readonly workspaceProvider: WorkspaceProvider;
  readonly blobStore: BlobStore;
  readonly redactor: Redactor;
  readonly ghClient: GhClient;
  readonly [k: string]: unknown;  // tolerate ActorAdapters base shape
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
