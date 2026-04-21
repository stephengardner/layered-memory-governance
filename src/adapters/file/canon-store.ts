/**
 * File-backed CanonStore.
 *
 * Layout under `rootDir/canon/`:
 *   sections/<selector>.txt              current section text (empty when missing)
 *   proposals/<proposal-id>.json         pending / resolved proposals
 *   history.jsonl                        append-only commit log
 *
 * This adapter does NOT shell out to git; it uses file operations directly.
 * A future bridge adapter can use real git for versioning. The behavioral
 * contract matches the memory adapter (including lossy-revert; see Q25).
 */

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
import type { FileClock } from './clock.js';
import {
  appendLine,
  isEnoent,
  p,
  readFileOrNull,
  readJsonOrNull,
  writeJson,
  atomicWriteFile,
  ensureDir,
} from './util.js';
import { readdir } from 'node:fs/promises';

const DEFAULT_SELECTOR = '_all';

export class FileCanonStore implements CanonStore {
  private readonly sectionsDir: string;
  private readonly proposalsDir: string;
  private readonly historyPath: string;

  constructor(rootDir: string, private readonly clock: FileClock) {
    const base = p(rootDir, 'canon');
    this.sectionsDir = p(base, 'sections');
    this.proposalsDir = p(base, 'proposals');
    this.historyPath = p(base, 'history.jsonl');
  }

  async read(selector?: string): Promise<string> {
    if (selector !== undefined) {
      return (await readFileOrNull(this.sectionPath(selector))) ?? '';
    }
    // Full canon: concatenate all section files by sorted selector.
    try {
      const entries = await readdir(this.sectionsDir);
      const selectors = entries
        .filter(name => name.endsWith('.txt'))
        .map(name => name.replace(/\.txt$/, ''))
        .sort();
      const parts: string[] = [];
      for (const sel of selectors) {
        parts.push((await readFileOrNull(this.sectionPath(sel))) ?? '');
      }
      return parts.join('\n');
    } catch (err) {
      if (isEnoent(err)) return '';
      throw err;
    }
  }

  async propose(
    diff: Diff,
    principalId: PrincipalId,
    rationale: string,
  ): Promise<ProposalId> {
    const idStr = createHash('sha256')
      .update(JSON.stringify(diff), 'utf8')
      .update('|', 'utf8')
      .update(String(principalId), 'utf8')
      .update('|', 'utf8')
      .update(rationale, 'utf8')
      .digest('hex')
      .slice(0, 24);
    const id = idStr as ProposalId;

    const path = this.proposalPath(id);
    const existing = await readJsonOrNull<Proposal>(path);
    if (!existing) {
      const now = this.clock.now();
      const proposal: Proposal = {
        id,
        atom_id: null,
        diff,
        principal_id: principalId,
        rationale,
        created_at: now,
        timeout_at: now,
        default_disposition: 'timeout',
        status: 'pending',
        approver_id: null,
      };
      await writeJson(path, proposal);
    }
    return id;
  }

  async commit(proposalId: ProposalId, approverId: PrincipalId): Promise<CommitRef> {
    const path = this.proposalPath(proposalId);
    const proposal = await readJsonOrNull<Proposal>(path);
    if (!proposal) throw new NotFoundError(`Proposal ${String(proposalId)} not found`);
    if (proposal.status !== 'pending' && proposal.status !== 'approve') {
      throw new ConflictError(`Proposal ${String(proposalId)} is ${proposal.status}`);
    }

    await atomicWriteFile(this.sectionPath(proposal.diff.path), proposal.diff.after);

    const ref = fakeRef();
    const commit: Commit = {
      ref,
      diff: proposal.diff,
      principal_id: proposal.principal_id,
      approver_id: approverId,
      committed_at: this.clock.now(),
      reason: proposal.rationale,
    };
    await appendLine(this.historyPath, JSON.stringify(commit));

    const updated: Proposal = { ...proposal, status: 'approve', approver_id: approverId };
    await writeJson(path, updated);
    return ref;
  }

  async revert(
    commitRef: CommitRef,
    reason: string,
    principalId: PrincipalId,
  ): Promise<CommitRef> {
    const history = await this.readHistory();
    const target = history.find(c => c.ref === commitRef);
    if (!target) throw new NotFoundError(`Commit ${String(commitRef)} not found`);

    await atomicWriteFile(this.sectionPath(target.diff.path), target.diff.before);

    const ref = fakeRef();
    const revertDiff: Diff = {
      path: target.diff.path,
      before: target.diff.after,
      after: target.diff.before,
      reason,
    };
    const commit: Commit = {
      ref,
      diff: revertDiff,
      principal_id: principalId,
      approver_id: principalId,
      committed_at: this.clock.now(),
      reason,
    };
    await appendLine(this.historyPath, JSON.stringify(commit));
    return ref;
  }

  async history(
    pathFilter?: string,
    limit?: number,
  ): Promise<ReadonlyArray<Commit>> {
    const all = await this.readHistory();
    const filtered = pathFilter
      ? all.filter(c => c.diff.path === pathFilter)
      : all;
    const lim = limit ?? filtered.length;
    // Newest first (history is stored oldest-first in JSONL).
    return [...filtered].reverse().slice(0, lim);
  }

  // ---- Private ----

  private sectionPath(selector: string): string {
    const safe = selector === undefined || selector === '' ? DEFAULT_SELECTOR : selector;
    const sanitized = safe.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    return p(this.sectionsDir, `${sanitized}.txt`);
  }

  private proposalPath(id: ProposalId): string {
    return p(this.proposalsDir, `${String(id)}.json`);
  }

  private async readHistory(): Promise<Commit[]> {
    const text = await readFileOrNull(this.historyPath);
    if (!text) return [];
    return text
      .split('\n')
      .filter(l => l.trim().length > 0)
      .map(l => JSON.parse(l) as Commit);
  }

  // Ensure dirs so readers don't trip on fresh hosts.
  async init(): Promise<void> {
    await ensureDir(this.sectionsDir);
    await ensureDir(this.proposalsDir);
  }
}

function fakeRef(): CommitRef {
  return randomBytes(20).toString('hex') as CommitRef;
}
