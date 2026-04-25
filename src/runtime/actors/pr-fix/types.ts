import type { PrIdentifier, PrReviewAdapter, ReviewComment, SubmittedReview, CheckRun, LegacyStatus } from '../pr-review/adapter.js';
import type { AgentLoopAdapter } from '../../../substrate/agent-loop.js';
import type { WorkspaceProvider } from '../../../substrate/workspace-provider.js';
import type { BlobStore } from '../../../substrate/blob-store.js';
import type { Redactor } from '../../../substrate/redactor.js';
import type { GhClient } from '../../../external/github/index.js';
import type { ActorAdapter } from '../types.js';
import type { AtomId } from '../../../substrate/types.js';

/**
 * Stored on generic `observation` atoms with `metadata.kind:
 * 'pr-fix-observation'` under `metadata.pr_fix_observation`. One per
 * actor `observe()` pass; carries the PR snapshot the actor classified
 * on. The actor patches `dispatched_session_atom_id` onto the atom
 * AFTER `apply()` runs (via `host.atoms.update`); the initial atom
 * written in `observe()` does not have it set.
 *
 * `extra` is the open extension slot for adapter-specific signals
 * (e.g. CR comment IDs, thread refs); namespace keys to avoid collision.
 */
export interface PrFixObservationMeta {
  readonly pr_owner: string;
  readonly pr_repo: string;
  readonly pr_number: number;
  readonly head_branch: string;
  readonly head_sha: string;
  readonly cr_review_states: ReadonlyArray<{ readonly author: string; readonly state: string; readonly submitted_at: string }>;
  readonly merge_state_status: string | null;
  readonly mergeable: boolean | null;
  readonly line_comment_count: number;
  readonly body_nit_count: number;
  readonly check_run_failure_count: number;
  readonly legacy_status_failure_count: number;
  readonly partial: boolean;
  readonly classification: 'all-clean' | 'has-findings' | 'ci-failure' | 'architectural' | 'partial';
  readonly dispatched_session_atom_id?: AtomId;
  readonly extra?: Readonly<Record<string, unknown>>;
}

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
