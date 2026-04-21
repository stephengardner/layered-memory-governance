import { createHash, randomBytes } from 'node:crypto';
import { ConflictError, NotFoundError } from '../../substrate/errors.js';
import type { CanonStore } from '../../substrate/interface.js';
import type {
  Commit,
  CommitRef,
  Diff,
  PrincipalId,
  Proposal,
  ProposalId,
} from '../../substrate/types.js';
import type { MemoryClock } from './clock.js';

/**
 * In-memory canon store.
 *
 * Canon is a map of "section" -> current text. Full canon = concatenation
 * by a canonical ordering. A null/undefined selector returns the full canon.
 *
 * Proposals are staged; commit() applies. History is an append-only array;
 * revert() appends a new commit that undoes a prior one.
 */
export class MemoryCanonStore implements CanonStore {
  private readonly sections = new Map<string, string>();
  private readonly proposals = new Map<ProposalId, Proposal>();
  private readonly history_: Commit[] = [];

  constructor(private readonly clock: MemoryClock) {}

  async read(selector?: string): Promise<string> {
    if (selector === undefined) {
      const keys = Array.from(this.sections.keys()).sort();
      return keys.map(k => this.sections.get(k) ?? '').join('\n');
    }
    return this.sections.get(selector) ?? '';
  }

  async propose(diff: Diff, principalId: PrincipalId, rationale: string): Promise<ProposalId> {
    // Idempotent: same (diff, principal, rationale) => same id.
    const idStr = createHash('sha256')
      .update(JSON.stringify(diff), 'utf8')
      .update('|', 'utf8')
      .update(String(principalId), 'utf8')
      .update('|', 'utf8')
      .update(rationale, 'utf8')
      .digest('hex')
      .slice(0, 24);
    const id = idStr as ProposalId;

    if (!this.proposals.has(id)) {
      const now = this.clock.now();
      this.proposals.set(id, {
        id,
        atom_id: null,
        diff,
        principal_id: principalId,
        rationale,
        created_at: now,
        timeout_at: now, // adapter does not manage timeout; LAG does
        default_disposition: 'timeout',
        status: 'pending',
        approver_id: null,
      });
    }
    return id;
  }

  async commit(proposalId: ProposalId, approverId: PrincipalId): Promise<CommitRef> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new NotFoundError(`Proposal ${String(proposalId)} not found`);
    }
    if (proposal.status !== 'pending' && proposal.status !== 'approve') {
      throw new ConflictError(`Proposal ${String(proposalId)} is ${proposal.status}, cannot commit`);
    }
    // Apply diff: write after-text to the path.
    this.sections.set(proposal.diff.path, proposal.diff.after);

    const ref = fakeRef();
    this.history_.push({
      ref,
      diff: proposal.diff,
      principal_id: proposal.principal_id,
      approver_id: approverId,
      committed_at: this.clock.now(),
      reason: proposal.rationale,
    });
    // Mark the proposal as committed (approve status) for audit purposes.
    (proposal as { status: 'approve' }).status = 'approve';
    return ref;
  }

  async revert(commitRef: CommitRef, reason: string, principalId: PrincipalId): Promise<CommitRef> {
    const target = this.history_.find(c => c.ref === commitRef);
    if (!target) {
      throw new NotFoundError(`Commit ${String(commitRef)} not found`);
    }
    // Revert = restore the "before" text for that path. We do NOT walk further
    // history; revert is a point operation against the target commit's diff.
    this.sections.set(target.diff.path, target.diff.before);

    const ref = fakeRef();
    const revertDiff: Diff = {
      path: target.diff.path,
      before: target.diff.after,
      after: target.diff.before,
      reason,
    };
    this.history_.push({
      ref,
      diff: revertDiff,
      principal_id: principalId,
      approver_id: principalId, // self-approved revert in memory adapter
      committed_at: this.clock.now(),
      reason,
    });
    return ref;
  }

  async history(pathFilter?: string, limit?: number): Promise<ReadonlyArray<Commit>> {
    const filtered = pathFilter
      ? this.history_.filter(c => c.diff.path === pathFilter)
      : this.history_;
    const lim = limit ?? filtered.length;
    // Newest last in history_; return newest first for ergonomics.
    return [...filtered].reverse().slice(0, lim);
  }

  // ---- Test helpers ----

  sectionsCount(): number {
    return this.sections.size;
  }
}

function fakeRef(): CommitRef {
  return randomBytes(20).toString('hex') as CommitRef;
}
