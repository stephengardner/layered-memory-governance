import { describe, it, expect } from 'vitest';
import type { PrFixObservation, PrFixAction, PrFixOutcome, PrFixAdapters } from '../../../../src/runtime/actors/pr-fix/types.js';
import type { AtomId, PrFixObservationMeta, PrincipalId } from '../../../../src/substrate/types.js';
import { mkPrFixObservationAtom } from '../../../../src/runtime/actors/pr-fix/pr-fix-observation.js';
import { PrFixActor } from '../../../../src/runtime/actors/pr-fix/pr-fix.js';
import type { ActorContext } from '../../../../src/runtime/actors/actor.js';
import type {
  PrIdentifier,
  PrReviewAdapter,
  PrReviewStatus,
} from '../../../../src/runtime/actors/pr-review/adapter.js';
import type {
  GhClient,
  GhExecResult,
  GhRestArgs,
} from '../../../../src/external/github/index.js';
import { createMemoryHost } from '../../../../src/adapters/memory/index.js';
import { samplePrincipal } from '../../../fixtures.js';

describe('PrFixActor types', () => {
  it('PrFixAction is a discriminated union of agent-loop-dispatch / pr-escalate', () => {
    const a: PrFixAction = { kind: 'agent-loop-dispatch', findings: [], planAtomId: 'plan-x' as AtomId, headBranch: 'feat/x' };
    const b: PrFixAction = { kind: 'pr-escalate', reason: 'CI failure' };
    expect(a.kind).toBe('agent-loop-dispatch');
    expect(b.kind).toBe('pr-escalate');
  });

  it('PrFixOutcome has fix-pushed / fix-failed / escalated variants', () => {
    const a: PrFixOutcome = { kind: 'fix-pushed', commitSha: 'abc', resolvedCommentIds: [], sessionAtomId: 's1' as AtomId };
    const b: PrFixOutcome = { kind: 'fix-failed', stage: 'verify-commit-sha', reason: 'mismatch', sessionAtomId: 's1' as AtomId };
    const c: PrFixOutcome = { kind: 'escalated', reason: 'arch' };
    expect([a.kind, b.kind, c.kind]).toEqual(['fix-pushed', 'fix-failed', 'escalated']);
  });
});

describe('mkPrFixObservationAtom', () => {
  const meta: PrFixObservationMeta = {
    pr_owner: 'o', pr_repo: 'r', pr_number: 1,
    head_branch: 'feat/x', head_sha: 'abc1234567890abcdef',
    cr_review_states: [],
    merge_state_status: null, mergeable: null,
    line_comment_count: 0, body_nit_count: 0,
    check_run_failure_count: 0, legacy_status_failure_count: 0,
    partial: false, classification: 'all-clean',
  };

  it('builds an L0 agent-observed atom with the expected metadata + chain', () => {
    const atom = mkPrFixObservationAtom({
      principal: 'pr-fix-actor' as PrincipalId,
      observationId: 'pr-fix-obs-1' as AtomId,
      meta,
      priorObservationAtomId: 'pr-fix-obs-0' as AtomId,
      dispatchedSessionAtomId: undefined,
      now: '2026-04-25T00:00:00.000Z',
    });
    expect(atom.type).toBe('pr-fix-observation');
    expect(atom.layer).toBe('L0');
    expect(atom.scope).toBe('project');
    expect(atom.principal_id).toBe('pr-fix-actor');
    expect(atom.provenance.kind).toBe('agent-observed');
    expect(atom.provenance.derived_from).toContain('pr-fix-obs-0');
    expect((atom.metadata as { pr_fix_observation: PrFixObservationMeta }).pr_fix_observation.classification).toBe('all-clean');
  });

  it('omits prior derived_from when no priorObservationAtomId given', () => {
    const atom = mkPrFixObservationAtom({
      principal: 'pr-fix-actor' as PrincipalId,
      observationId: 'pr-fix-obs-1' as AtomId,
      meta,
      priorObservationAtomId: undefined,
      dispatchedSessionAtomId: undefined,
      now: '2026-04-25T00:00:00.000Z',
    });
    expect(atom.provenance.derived_from).toEqual([]);
  });

  it('renderObservationContent returns a deterministic prose summary', () => {
    const content = (mkPrFixObservationAtom({
      principal: 'pr-fix-actor' as PrincipalId,
      observationId: 'pr-fix-obs-1' as AtomId,
      meta,
      priorObservationAtomId: undefined,
      dispatchedSessionAtomId: undefined,
      now: '2026-04-25T00:00:00.000Z',
    })).content;
    expect(content).toContain('o/r#1');
    expect(content).toContain('classification=all-clean');
  });
});

// ---------------------------------------------------------------------------
// PrFixActor.observe
// ---------------------------------------------------------------------------

const PR: PrIdentifier = { owner: 'o', repo: 'r', number: 1 };

function mkCleanReviewStatus(pr: PrIdentifier): PrReviewStatus {
  return {
    pr,
    mergeable: true,
    mergeStateStatus: 'CLEAN',
    lineComments: [],
    bodyNits: [],
    submittedReviews: [],
    checkRuns: [],
    legacyStatuses: [],
    partial: false,
    partialSurfaces: [],
  };
}

class StubReviewAdapter implements PrReviewAdapter {
  readonly name = 'stub-review';
  readonly version = '0';
  constructor(private readonly status: PrReviewStatus) {}
  async listUnresolvedComments() { return this.status.lineComments; }
  async listReviewBodyNits() { return this.status.bodyNits; }
  async replyToComment() { return { commentId: 'x', posted: true }; }
  async resolveComment() {}
  async hasReviewerEngaged() { return false; }
  async postPrComment() { return { posted: true }; }
  async getPrReviewStatus(pr: PrIdentifier) { return { ...this.status, pr }; }
}

function makeStubGhClient(prDetails: { head: { ref: string; sha: string }; base: { ref: string } } | undefined): GhClient {
  const calls: GhRestArgs[] = [];
  return {
    executor: async (): Promise<GhExecResult> => ({ exitCode: 0, stdout: '', stderr: '' }),
    rest: async <T,>(args: GhRestArgs): Promise<T | undefined> => {
      calls.push(args);
      return prDetails as unknown as T | undefined;
    },
    graphql: async () => { throw new Error('graphql not stubbed'); },
    raw: async (): Promise<GhExecResult> => ({ exitCode: 0, stdout: '', stderr: '' }),
  };
}

function makeStubCtx<A extends PrFixAdapters>(args: {
  host: ReturnType<typeof createMemoryHost>;
  adapters: A;
  iteration?: number;
}): ActorContext<A> {
  return {
    host: args.host,
    principal: samplePrincipal({ id: 'pr-fix-actor' as PrincipalId }),
    adapters: args.adapters,
    budget: { maxIterations: 5 },
    iteration: args.iteration ?? 1,
    killSwitch: () => false,
    abortSignal: new AbortController().signal,
    audit: async () => {},
  };
}

describe('PrFixActor.observe', () => {
  it('writes a pr-fix-observation atom and returns the observation', async () => {
    const host = createMemoryHost();
    const review = new StubReviewAdapter(mkCleanReviewStatus(PR));
    const ghClient = makeStubGhClient({
      head: { ref: 'feat/x', sha: 'abc1234' },
      base: { ref: 'main' },
    });

    const adapters = { review, ghClient } as unknown as PrFixAdapters;
    const actor = new PrFixActor({ pr: PR });
    const ctx = makeStubCtx({ host, adapters });

    const obs = await actor.observe(ctx);

    expect(obs.pr).toEqual(PR);
    expect(obs.headBranch).toBe('feat/x');
    expect(obs.headSha).toBe('abc1234');
    expect(obs.baseRef).toBe('main');
    expect(obs.partial).toBe(false);
    expect(obs.observationAtomId).toMatch(/^pr-fix-obs-/);

    const stored = await host.atoms.get(obs.observationAtomId);
    expect(stored).not.toBeNull();
    expect(stored?.type).toBe('pr-fix-observation');
    const meta = (stored?.metadata as { pr_fix_observation: PrFixObservationMeta }).pr_fix_observation;
    expect(meta.head_sha).toBe('abc1234');
    expect(meta.head_branch).toBe('feat/x');
    expect(meta.classification).toBe('has-findings');
    expect(meta.partial).toBe(false);
    expect(meta.line_comment_count).toBe(0);
  });

  it('chains derived_from to a prior observation when observe runs twice', async () => {
    const host = createMemoryHost();
    const review = new StubReviewAdapter(mkCleanReviewStatus(PR));
    const ghClient = makeStubGhClient({
      head: { ref: 'feat/x', sha: 'abc1234' },
      base: { ref: 'main' },
    });

    const adapters = { review, ghClient } as unknown as PrFixAdapters;
    const actor = new PrFixActor({ pr: PR });

    const first = await actor.observe(makeStubCtx({ host, adapters, iteration: 1 }));
    const second = await actor.observe(makeStubCtx({ host, adapters, iteration: 2 }));

    expect(second.observationAtomId).not.toBe(first.observationAtomId);
    const secondAtom = await host.atoms.get(second.observationAtomId);
    expect(secondAtom?.provenance.derived_from).toContain(first.observationAtomId);
  });

  it('throws when ghClient.rest returns undefined (404 / empty body)', async () => {
    const host = createMemoryHost();
    const review = new StubReviewAdapter(mkCleanReviewStatus(PR));
    const ghClient = makeStubGhClient(undefined);

    const adapters = { review, ghClient } as unknown as PrFixAdapters;
    const actor = new PrFixActor({ pr: PR });
    const ctx = makeStubCtx({ host, adapters });

    await expect(actor.observe(ctx)).rejects.toThrow(/pulls\.get/);
  });

  it('uses options.now for deterministic timestamps in tests', async () => {
    const host = createMemoryHost();
    const review = new StubReviewAdapter(mkCleanReviewStatus(PR));
    const ghClient = makeStubGhClient({
      head: { ref: 'feat/x', sha: 'abc1234' },
      base: { ref: 'main' },
    });

    const adapters = { review, ghClient } as unknown as PrFixAdapters;
    const fixed = '2026-04-25T12:34:56.000Z';
    const actor = new PrFixActor({ pr: PR, now: () => fixed });
    const ctx = makeStubCtx({ host, adapters });

    const obs = await actor.observe(ctx);
    const stored = await host.atoms.get(obs.observationAtomId);
    expect(stored?.created_at).toBe(fixed);
    expect(stored?.last_reinforced_at).toBe(fixed);
  });
});
