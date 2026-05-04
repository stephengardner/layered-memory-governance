import { describe, it, expect } from 'vitest';
import type { PrFixObservation, PrFixAction, PrFixOutcome, PrFixAdapters, PrFixClassification, PrFixObservationMeta } from '../../../../src/runtime/actors/pr-fix/types.js';
import type { AtomId, PrincipalId } from '../../../../src/substrate/types.js';
import { mkPrFixObservationAtom } from '../../../../src/runtime/actors/pr-fix/pr-fix-observation.js';
import { PrFixActor } from '../../../../src/runtime/actors/pr-fix/pr-fix.js';
import type { ActorContext } from '../../../../src/runtime/actors/actor.js';
import type { Classified, ProposedAction } from '../../../../src/runtime/actors/types.js';
import type {
  PrIdentifier,
  PrReviewAdapter,
  PrReviewStatus,
  ReviewComment,
  CheckRun,
  LegacyStatus,
  SubmittedReview,
} from '../../../../src/runtime/actors/pr-review/adapter.js';
import type {
  GhClient,
  GhExecResult,
  GhRestArgs,
} from '../../../../src/external/github/index.js';
import type {
  AgentLoopAdapter,
  AgentLoopInput,
  AgentLoopResult,
  AdapterCapabilities,
} from '../../../../src/substrate/agent-loop.js';
import { defaultClassifyFailure } from '../../../../src/substrate/agent-loop.js';
import type { Workspace, WorkspaceProvider, AcquireInput } from '../../../../src/substrate/workspace-provider.js';
import type { BlobStore } from '../../../../src/substrate/blob-store.js';
import type { Redactor } from '../../../../src/substrate/redactor.js';
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
    expect(atom.type).toBe('observation');
    expect(atom.layer).toBe('L0');
    expect(atom.scope).toBe('project');
    expect(atom.principal_id).toBe('pr-fix-actor');
    expect(atom.provenance.kind).toBe('agent-observed');
    expect(atom.provenance.derived_from).toContain('pr-fix-obs-0');
    expect((atom.metadata as { kind?: string }).kind).toBe('pr-fix-observation');
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
    prState: 'OPEN',
    title: null,
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
    expect(stored?.type).toBe('observation');
    expect((stored?.metadata as { kind?: string }).kind).toBe('pr-fix-observation');
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

// ---------------------------------------------------------------------------
// PrFixActor.classify
// ---------------------------------------------------------------------------

const baseObs: PrFixObservation = {
  pr: PR,
  headBranch: 'feat/x',
  headSha: 'abc1234',
  baseRef: 'main',
  lineComments: [],
  bodyNits: [],
  submittedReviews: [],
  checkRuns: [],
  legacyStatuses: [],
  mergeStateStatus: 'CLEAN',
  mergeable: true,
  partial: false,
  observationAtomId: 'pr-fix-obs-test' as AtomId,
};

function makeClassifyCtx(): ActorContext<PrFixAdapters> {
  const host = createMemoryHost();
  const adapters = {} as unknown as PrFixAdapters;
  return makeStubCtx({ host, adapters });
}

function mkLineComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: overrides.id ?? 'c1',
    author: overrides.author ?? 'coderabbitai',
    path: overrides.path ?? 'src/foo.ts',
    line: overrides.line ?? 10,
    body: overrides.body ?? 'nit: fix this',
    createdAt: overrides.createdAt ?? '2026-04-25T00:00:00.000Z',
    resolved: overrides.resolved ?? false,
    ...overrides,
  };
}

describe('PrFixActor.classify', () => {
  it("returns 'all-clean' when zero findings + zero CI failures + mergeStateStatus !== 'BEHIND'", async () => {
    const actor = new PrFixActor({ pr: PR });
    const c = await actor.classify(baseObs, makeClassifyCtx());
    expect((c.metadata as { classification: PrFixClassification }).classification).toBe('all-clean');
    expect(c.observation).toBe(baseObs);
    expect(c.key).toBe('pr-fix:lineN=0:bodyN=0:cr=:ci=0:arch=0');
  });

  it("returns 'partial' when obs.partial === true (short-circuits before count helpers)", async () => {
    const actor = new PrFixActor({ pr: PR });
    const obs: PrFixObservation = { ...baseObs, partial: true };
    const c = await actor.classify(obs, makeClassifyCtx());
    expect((c.metadata as { classification: PrFixClassification }).classification).toBe('partial');
    expect(c.key).toBe('pr-fix:partial=true');
  });

  it("returns 'ci-failure' when at least one check-run is completed+failure", async () => {
    const actor = new PrFixActor({ pr: PR });
    const checkRuns: ReadonlyArray<CheckRun> = [
      { name: 'lint', status: 'completed', conclusion: 'success' },
      { name: 'test', status: 'completed', conclusion: 'failure' },
    ];
    const obs: PrFixObservation = { ...baseObs, checkRuns };
    const c = await actor.classify(obs, makeClassifyCtx());
    expect((c.metadata as { classification: PrFixClassification }).classification).toBe('ci-failure');
    expect((c.metadata as { ciFailures: number }).ciFailures).toBe(1);
    expect(c.key).toBe('pr-fix:lineN=0:bodyN=0:cr=:ci=1:arch=0');
  });

  it("returns 'ci-failure' when a legacy status is failure or error", async () => {
    const actor = new PrFixActor({ pr: PR });
    const legacyStatuses: ReadonlyArray<LegacyStatus> = [
      { context: 'ci/build', state: 'failure', updatedAt: '2026-04-25T00:00:00.000Z' },
      { context: 'ci/lint', state: 'error', updatedAt: '2026-04-25T00:00:00.000Z' },
    ];
    const obs: PrFixObservation = { ...baseObs, legacyStatuses };
    const c = await actor.classify(obs, makeClassifyCtx());
    expect((c.metadata as { classification: PrFixClassification }).classification).toBe('ci-failure');
    expect((c.metadata as { ciFailures: number }).ciFailures).toBe(2);
  });

  it("returns 'has-findings' when there are line comments but no CI failure or arch marker", async () => {
    const actor = new PrFixActor({ pr: PR });
    const obs: PrFixObservation = {
      ...baseObs,
      lineComments: [mkLineComment({ id: 'c1', body: 'nit: rename this' })],
    };
    const c = await actor.classify(obs, makeClassifyCtx());
    expect((c.metadata as { classification: PrFixClassification }).classification).toBe('has-findings');
    expect(c.key).toBe('pr-fix:lineN=1:bodyN=0:cr=:ci=0:arch=0');
  });

  it("returns 'architectural' when a comment body has BOTH the orange-circle Major marker AND an architectural substring", async () => {
    const actor = new PrFixActor({ pr: PR });
    const archBody = '\u{1F7E0} Major: this requires an architectural rework of the loop';
    const obs: PrFixObservation = {
      ...baseObs,
      lineComments: [mkLineComment({ id: 'c1', body: archBody })],
    };
    const c = await actor.classify(obs, makeClassifyCtx());
    expect((c.metadata as { classification: PrFixClassification }).classification).toBe('architectural');
    expect((c.metadata as { arch: number }).arch).toBe(1);
    expect(c.key).toBe('pr-fix:lineN=1:bodyN=0:cr=:ci=0:arch=1');
  });

  it("matches 'large refactor' as architectural when combined with the marker", async () => {
    const actor = new PrFixActor({ pr: PR });
    const body = '\u{1F7E0} Major\nThis would require a large refactor to address.';
    const obs: PrFixObservation = {
      ...baseObs,
      lineComments: [mkLineComment({ id: 'c1', body })],
    };
    const c = await actor.classify(obs, makeClassifyCtx());
    expect((c.metadata as { classification: PrFixClassification }).classification).toBe('architectural');
    expect((c.metadata as { arch: number }).arch).toBe(1);
  });

  it("matches 'redesign' as architectural when combined with the marker", async () => {
    const actor = new PrFixActor({ pr: PR });
    const body = '\u{1F7E0} Major - propose a redesign of the API surface';
    const obs: PrFixObservation = {
      ...baseObs,
      lineComments: [mkLineComment({ id: 'c1', body })],
    };
    const c = await actor.classify(obs, makeClassifyCtx());
    expect((c.metadata as { classification: PrFixClassification }).classification).toBe('architectural');
  });

  it("does NOT classify 'this is a major usability issue' as architectural (regression: marker required)", async () => {
    const actor = new PrFixActor({ pr: PR });
    // The substring 'architectural' is present but the orange-circle Major
    // marker is NOT, so this must fall through to has-findings.
    const body = 'this is a major usability issue with architectural impact';
    const obs: PrFixObservation = {
      ...baseObs,
      lineComments: [mkLineComment({ id: 'c1', body })],
    };
    const c = await actor.classify(obs, makeClassifyCtx());
    expect((c.metadata as { classification: PrFixClassification }).classification).toBe('has-findings');
    expect((c.metadata as { arch: number }).arch).toBe(0);
  });

  it("does NOT classify '\u{1F7E0} Major: typo here' (marker but no arch substring) as architectural", async () => {
    const actor = new PrFixActor({ pr: PR });
    const body = '\u{1F7E0} Major: typo on this line, please fix';
    const obs: PrFixObservation = {
      ...baseObs,
      lineComments: [mkLineComment({ id: 'c1', body })],
    };
    const c = await actor.classify(obs, makeClassifyCtx());
    expect((c.metadata as { classification: PrFixClassification }).classification).toBe('has-findings');
    expect((c.metadata as { arch: number }).arch).toBe(0);
  });

  it('does NOT count pending check-runs (queued / in_progress) as failures', async () => {
    const actor = new PrFixActor({ pr: PR });
    const checkRuns: ReadonlyArray<CheckRun> = [
      { name: 'lint', status: 'queued', conclusion: null },
      { name: 'test', status: 'in_progress', conclusion: null },
    ];
    const obs: PrFixObservation = { ...baseObs, checkRuns };
    const c = await actor.classify(obs, makeClassifyCtx());
    expect((c.metadata as { classification: PrFixClassification }).classification).toBe('all-clean');
    expect((c.metadata as { ciFailures: number }).ciFailures).toBe(0);
  });

  it("does NOT count pending legacy statuses (state 'pending') as failures", async () => {
    const actor = new PrFixActor({ pr: PR });
    const legacyStatuses: ReadonlyArray<LegacyStatus> = [
      { context: 'CodeRabbit', state: 'pending', updatedAt: '2026-04-25T00:00:00.000Z' },
    ];
    const obs: PrFixObservation = { ...baseObs, legacyStatuses };
    const c = await actor.classify(obs, makeClassifyCtx());
    expect((c.metadata as { classification: PrFixClassification }).classification).toBe('all-clean');
    expect((c.metadata as { ciFailures: number }).ciFailures).toBe(0);
  });

  it("convergence key carries concrete numeric counts (not literal 'N' placeholders)", async () => {
    const actor = new PrFixActor({ pr: PR });
    const lineComments = [
      mkLineComment({ id: 'l1' }),
      mkLineComment({ id: 'l2' }),
    ];
    const bodyNits = [mkLineComment({ id: 'b1', body: 'body nit' })];
    const submittedReviews: ReadonlyArray<SubmittedReview> = [
      { author: 'cr', state: 'CHANGES_REQUESTED', submittedAt: '2026-04-25T00:00:00.000Z' },
      { author: 'human', state: 'APPROVED', submittedAt: '2026-04-25T00:00:01.000Z' },
    ];
    const obs: PrFixObservation = {
      ...baseObs,
      lineComments,
      bodyNits,
      submittedReviews,
    };
    const c = await actor.classify(obs, makeClassifyCtx());
    expect(c.key).toBe('pr-fix:lineN=2:bodyN=1:cr=APPROVED+CHANGES_REQUESTED:ci=0:arch=0');
    // Regression: literal 'N' placeholder MUST NOT appear
    expect(c.key).not.toMatch(/lineN=N/);
    expect(c.key).not.toMatch(/bodyN=N/);
  });

  it('cr= summary is order-independent (sorted alphabetically)', async () => {
    const actor = new PrFixActor({ pr: PR });
    const orderA: ReadonlyArray<SubmittedReview> = [
      { author: 'a', state: 'APPROVED', submittedAt: 't1' },
      { author: 'b', state: 'COMMENTED', submittedAt: 't2' },
    ];
    const orderB: ReadonlyArray<SubmittedReview> = [
      { author: 'b', state: 'COMMENTED', submittedAt: 't2' },
      { author: 'a', state: 'APPROVED', submittedAt: 't1' },
    ];
    const cA = await actor.classify({ ...baseObs, submittedReviews: orderA }, makeClassifyCtx());
    const cB = await actor.classify({ ...baseObs, submittedReviews: orderB }, makeClassifyCtx());
    expect(cA.key).toBe(cB.key);
  });
});

// ---------------------------------------------------------------------------
// PrFixActor.propose
// ---------------------------------------------------------------------------

function makeProposeCtx(): ActorContext<PrFixAdapters> {
  const host = createMemoryHost();
  const adapters = {} as unknown as PrFixAdapters;
  return makeStubCtx({ host, adapters });
}

describe('PrFixActor.propose', () => {
  it("returns [] for 'all-clean' classification", async () => {
    const actor = new PrFixActor({ pr: PR });
    const classified: Classified<PrFixObservation> = {
      observation: baseObs,
      key: 'pr-fix:lineN=0:bodyN=0:cr=:ci=0:arch=0',
      metadata: { classification: 'all-clean' satisfies PrFixClassification, ciFailures: 0, arch: 0 },
    };
    const actions = await actor.propose(classified, makeProposeCtx());
    expect(actions).toEqual([]);
  });

  it("returns [] for 'partial' classification (do-not-decide)", async () => {
    const actor = new PrFixActor({ pr: PR });
    const classified: Classified<PrFixObservation> = {
      observation: { ...baseObs, partial: true },
      key: 'pr-fix:partial=true',
      metadata: { classification: 'partial' satisfies PrFixClassification, ciFailures: 0, arch: 0 },
    };
    const actions = await actor.propose(classified, makeProposeCtx());
    expect(actions).toEqual([]);
  });

  it("returns one 'agent-loop-dispatch' action for 'has-findings'", async () => {
    const actor = new PrFixActor({ pr: PR });
    const lineComments = [
      mkLineComment({ id: 'l1', body: 'rename this' }),
      mkLineComment({ id: 'l2', body: 'extract helper' }),
    ];
    const bodyNits = [mkLineComment({ id: 'b1', body: 'body nit' })];
    const obs: PrFixObservation = { ...baseObs, lineComments, bodyNits };
    const classified: Classified<PrFixObservation> = {
      observation: obs,
      key: 'pr-fix:lineN=2:bodyN=1:cr=:ci=0:arch=0',
      metadata: { classification: 'has-findings' satisfies PrFixClassification, ciFailures: 0, arch: 0 },
    };
    const actions = await actor.propose(classified, makeProposeCtx());
    expect(actions).toHaveLength(1);
    const a = actions[0] as ProposedAction<PrFixAction>;
    expect(a.tool).toBe('agent-loop-dispatch');
    expect(a.payload.kind).toBe('agent-loop-dispatch');
    if (a.payload.kind !== 'agent-loop-dispatch') throw new Error('discriminant');
    expect(a.payload.findings).toEqual([...lineComments, ...bodyNits]);
    expect(a.payload.headBranch).toBe(obs.headBranch);
    expect(a.payload.planAtomId).toMatch(/^pr-fix-plan-/);
    expect(a.description).toContain('o/r#1');
    expect(a.description).toContain('3');
  });

  it("returns one 'pr-escalate' action with reason 'CI failure: ...' for 'ci-failure'", async () => {
    const actor = new PrFixActor({ pr: PR });
    const checkRuns: ReadonlyArray<CheckRun> = [
      { name: 'lint', status: 'completed', conclusion: 'success' },
      { name: 'test-suite', status: 'completed', conclusion: 'failure' },
    ];
    const legacyStatuses: ReadonlyArray<LegacyStatus> = [
      { context: 'ci/build', state: 'failure', updatedAt: '2026-04-25T00:00:00.000Z' },
    ];
    const obs: PrFixObservation = { ...baseObs, checkRuns, legacyStatuses };
    const classified: Classified<PrFixObservation> = {
      observation: obs,
      key: 'pr-fix:lineN=0:bodyN=0:cr=:ci=2:arch=0',
      metadata: { classification: 'ci-failure' satisfies PrFixClassification, ciFailures: 2, arch: 0 },
    };
    const actions = await actor.propose(classified, makeProposeCtx());
    expect(actions).toHaveLength(1);
    const a = actions[0] as ProposedAction<PrFixAction>;
    expect(a.tool).toBe('pr-escalate');
    expect(a.payload.kind).toBe('pr-escalate');
    if (a.payload.kind !== 'pr-escalate') throw new Error('discriminant');
    expect(a.payload.reason.startsWith('CI failure:')).toBe(true);
    expect(a.payload.reason).toContain('test-suite');
    expect(a.payload.reason).toContain('ci/build');
    expect(a.description).toContain('o/r#1');
  });

  it("returns one 'pr-escalate' action with reason 'Architectural concern: ...' for 'architectural'", async () => {
    const actor = new PrFixActor({ pr: PR });
    const archBody = '\u{1F7E0} Major: this requires an architectural rework of the loop';
    const obs: PrFixObservation = {
      ...baseObs,
      lineComments: [mkLineComment({ id: 'arch-c1', body: archBody })],
    };
    const classified: Classified<PrFixObservation> = {
      observation: obs,
      key: 'pr-fix:lineN=1:bodyN=0:cr=:ci=0:arch=1',
      metadata: { classification: 'architectural' satisfies PrFixClassification, ciFailures: 0, arch: 1 },
    };
    const actions = await actor.propose(classified, makeProposeCtx());
    expect(actions).toHaveLength(1);
    const a = actions[0] as ProposedAction<PrFixAction>;
    expect(a.tool).toBe('pr-escalate');
    expect(a.payload.kind).toBe('pr-escalate');
    if (a.payload.kind !== 'pr-escalate') throw new Error('discriminant');
    expect(a.payload.reason.startsWith('Architectural concern:')).toBe(true);
    expect(a.payload.reason).toContain('arch-c1');
  });

  it('returns [] (defensive) when classified.metadata is undefined (never throws)', async () => {
    const actor = new PrFixActor({ pr: PR });
    const classified: Classified<PrFixObservation> = {
      observation: baseObs,
      key: 'pr-fix:partial=true',
      // metadata intentionally omitted
    };
    const actions = await actor.propose(classified, makeProposeCtx());
    expect(actions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PrFixActor.apply (agent-loop-dispatch)
//
// The injectable readWorkspaceHeadSha / readTouchedPaths PrFixOptions
// fields keep these tests off real `execa`; the production path falls
// back to git rev-parse / git diff via execa when the overrides are
// absent.
// ---------------------------------------------------------------------------

const NOOP_CAPS: AdapterCapabilities = {
  tracks_cost: false,
  supports_signal: false,
  classify_failure: defaultClassifyFailure,
};

const NOOP_REDACTOR: Redactor = { redact: (s: string) => s };
const EMPTY_BLOB_STORE = {} as BlobStore;

class StubResolveAdapter implements PrReviewAdapter {
  readonly name = 'stub-review-resolve';
  readonly version = '0';
  readonly resolveCalls: Array<{ pr: PrIdentifier; commentId: string }> = [];
  constructor(private readonly resolveBehavior: (commentId: string) => Promise<void> = async () => {}) {}
  async listUnresolvedComments() { return []; }
  async listReviewBodyNits() { return []; }
  async replyToComment() { return { commentId: 'x', posted: true }; }
  async resolveComment(pr: PrIdentifier, commentId: string): Promise<void> {
    this.resolveCalls.push({ pr, commentId });
    return this.resolveBehavior(commentId);
  }
  async hasReviewerEngaged() { return false; }
  async postPrComment() { return { posted: true }; }
  async getPrReviewStatus(pr: PrIdentifier): Promise<PrReviewStatus> {
    return {
      pr,
      mergeable: null,
      mergeStateStatus: null,
      prState: null,
      title: null,
      lineComments: [],
      bodyNits: [],
      submittedReviews: [],
      checkRuns: [],
      legacyStatuses: [],
      partial: false,
      partialSurfaces: [],
    };
  }
}

interface RecordingAgentLoop extends AgentLoopAdapter {
  readonly captured: { input?: AgentLoopInput };
}

function recordingAgentLoop(result: AgentLoopResult, options?: { capsOverride?: AdapterCapabilities }): RecordingAgentLoop {
  const captured: { input?: AgentLoopInput } = {};
  return {
    capabilities: options?.capsOverride ?? NOOP_CAPS,
    captured,
    run: async (input: AgentLoopInput): Promise<AgentLoopResult> => {
      captured.input = input;
      return result;
    },
  };
}

interface RecordingWorkspaceProvider extends WorkspaceProvider {
  readonly captured: { acquire: AcquireInput[]; releaseCount: number };
}

function recordingWorkspaceProvider(opts?: {
  acquireBehavior?: (input: AcquireInput) => Promise<Workspace>;
  releaseBehavior?: (workspace: Workspace) => Promise<void>;
}): RecordingWorkspaceProvider {
  const captured: { acquire: AcquireInput[]; releaseCount: number } = { acquire: [], releaseCount: 0 };
  const provider = {
    captured,
    acquire: async (input: AcquireInput): Promise<Workspace> => {
      captured.acquire.push(input);
      if (opts?.acquireBehavior !== undefined) return opts.acquireBehavior(input);
      return { id: `ws-${captured.acquire.length}`, path: `/tmp/ws-${captured.acquire.length}`, baseRef: input.baseRef };
    },
    release: async (workspace: Workspace): Promise<void> => {
      captured.releaseCount += 1;
      if (opts?.releaseBehavior !== undefined) return opts.releaseBehavior(workspace);
      return;
    },
  };
  return provider;
}

function mkApplyCtx(adapters: PrFixAdapters): ActorContext<PrFixAdapters> {
  const host = createMemoryHost();
  return makeStubCtx({ host, adapters });
}

function applyDispatchAction(
  findings: ReadonlyArray<ReviewComment>,
  headBranch = 'feat/x',
): ProposedAction<PrFixAction> {
  return {
    tool: 'agent-loop-dispatch',
    description: `Dispatch agent loop to address ${findings.length} unresolved finding(s)`,
    payload: {
      kind: 'agent-loop-dispatch',
      findings,
      planAtomId: 'pr-fix-plan-test' as AtomId,
      headBranch,
    },
  };
}

const APPLY_PR: PrIdentifier = PR;

const APPLY_OBS: PrFixObservation = {
  pr: APPLY_PR,
  headBranch: 'feat/x',
  headSha: 'abc1234',
  baseRef: 'main',
  lineComments: [],
  bodyNits: [],
  submittedReviews: [],
  checkRuns: [],
  legacyStatuses: [],
  mergeStateStatus: 'BLOCKED',
  mergeable: true,
  partial: false,
  observationAtomId: 'pr-fix-obs-apply' as AtomId,
};

function makeApplyAdapters(args: {
  agentLoop: AgentLoopAdapter;
  workspaceProvider: WorkspaceProvider;
  review: PrReviewAdapter;
}): PrFixAdapters {
  // Non-substrate adapters that the apply path does not touch are
  // deliberately empty stubs typed as the labelled adapter shape.
  const ghClient = makeStubGhClient(undefined);
  const adapters = {
    review: args.review,
    agentLoop: { ...args.agentLoop, name: 'stub-agent-loop', version: '0' },
    workspaceProvider: { ...args.workspaceProvider, name: 'stub-workspace', version: '0' },
    blobStore: { ...EMPTY_BLOB_STORE, name: 'stub-blob', version: '0' },
    redactor: { ...NOOP_REDACTOR, name: 'stub-redactor', version: '0' },
    ghClient: { ...(ghClient as object), name: 'stub-gh', version: '0' } as unknown as GhClient & { readonly name: string; readonly version: string },
  } as unknown as PrFixAdapters;
  return adapters;
}

async function primeObservation(actor: PrFixActor, adapters: PrFixAdapters): Promise<void> {
  // The apply path reads the actor's lastObservation to recover
  // baseRef / observation pr metadata. In production this is set by
  // observe(); here we drive observe() against a stub ghClient + review
  // adapter to mirror the real call sequence.
  const review = new StubReviewAdapter({
    pr: APPLY_PR,
    mergeable: APPLY_OBS.mergeable,
    mergeStateStatus: APPLY_OBS.mergeStateStatus,
    prState: 'OPEN',
    title: null,
    lineComments: [],
    bodyNits: [],
    submittedReviews: [],
    checkRuns: [],
    legacyStatuses: [],
    partial: false,
    partialSurfaces: [],
  });
  const ghClient = makeStubGhClient({
    head: { ref: APPLY_OBS.headBranch, sha: APPLY_OBS.headSha },
    base: { ref: APPLY_OBS.baseRef },
  });
  const primingAdapters = {
    ...(adapters as unknown as Record<string, unknown>),
    review,
    ghClient,
  } as unknown as PrFixAdapters;
  const host = createMemoryHost();
  await actor.observe(makeStubCtx({ host, adapters: primingAdapters }));
}

function mkLineCommentForApply(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: overrides.id ?? 'c1',
    author: overrides.author ?? 'coderabbitai',
    path: overrides.path ?? 'src/foo.ts',
    line: overrides.line ?? 10,
    body: overrides.body ?? 'nit: rename',
    createdAt: overrides.createdAt ?? '2026-04-25T00:00:00.000Z',
    resolved: overrides.resolved ?? false,
    kind: overrides.kind ?? 'line',
    ...overrides,
  };
}

describe('PrFixActor.apply (agent-loop-dispatch)', () => {
  it("happy path: completed + matching SHA + touched-paths covers findings -> 'fix-pushed' with resolvedCommentIds", async () => {
    const findings: ReadonlyArray<ReviewComment> = [
      mkLineCommentForApply({ id: 'l1', path: 'src/foo.ts' }),
      mkLineCommentForApply({ id: 'l2', path: 'src/bar.ts' }),
    ];
    const review = new StubResolveAdapter();
    const agentLoop = recordingAgentLoop({
      kind: 'completed',
      sessionAtomId: 'sess-ok' as AtomId,
      turnAtomIds: ['t-1' as AtomId],
      artifacts: { commitSha: 'sha-deadbeef', branchName: 'feat/x', touchedPaths: ['src/foo.ts', 'src/bar.ts'] },
    });
    const workspaceProvider = recordingWorkspaceProvider();
    const adapters = makeApplyAdapters({ agentLoop, workspaceProvider, review });
    const actor = new PrFixActor({
      pr: APPLY_PR,
      readWorkspaceHeadSha: async () => 'sha-deadbeef',
      readTouchedPaths: async () => new Set<string>(['src/foo.ts', 'src/bar.ts']),
    });
    await primeObservation(actor, adapters);

    const outcome = await actor.apply(applyDispatchAction(findings), mkApplyCtx(adapters));

    expect(outcome.kind).toBe('fix-pushed');
    if (outcome.kind !== 'fix-pushed') throw new Error('unreachable');
    expect(outcome.commitSha).toBe('sha-deadbeef');
    expect(outcome.resolvedCommentIds.slice().sort()).toEqual(['l1', 'l2']);
    expect(outcome.sessionAtomId).toBe('sess-ok');
    expect(review.resolveCalls.map((c) => c.commentId).sort()).toEqual(['l1', 'l2']);
    expect(workspaceProvider.captured.acquire).toHaveLength(1);
    expect(workspaceProvider.captured.acquire[0]?.checkoutBranch).toBe('feat/x');
    expect(workspaceProvider.captured.acquire[0]?.baseRef).toBe('main');
    expect(workspaceProvider.captured.releaseCount).toBe(1);
    // Layer-B floor is enforced regardless of operator extension.
    const dt = agentLoop.captured.input?.toolPolicy.disallowedTools ?? [];
    for (const t of ['WebFetch', 'WebSearch', 'NotebookEdit']) {
      expect(dt).toContain(t);
    }
    // The headBranch from the action drives the workspace pin.
    expect(agentLoop.captured.input?.workspace.path).toBeDefined();
  });

  it("SHA mismatch -> fix-failed with stage 'verify-commit-sha'; releases workspace", async () => {
    const findings = [mkLineCommentForApply({ id: 'l1', path: 'src/foo.ts' })];
    const review = new StubResolveAdapter();
    const agentLoop = recordingAgentLoop({
      kind: 'completed',
      sessionAtomId: 'sess-mismatch' as AtomId,
      turnAtomIds: [],
      artifacts: { commitSha: 'abc', branchName: 'feat/x' },
    });
    const workspaceProvider = recordingWorkspaceProvider();
    const adapters = makeApplyAdapters({ agentLoop, workspaceProvider, review });
    const actor = new PrFixActor({
      pr: APPLY_PR,
      readWorkspaceHeadSha: async () => 'def',
      readTouchedPaths: async () => new Set<string>(),
    });
    await primeObservation(actor, adapters);

    const outcome = await actor.apply(applyDispatchAction(findings), mkApplyCtx(adapters));

    expect(outcome.kind).toBe('fix-failed');
    if (outcome.kind !== 'fix-failed') throw new Error('unreachable');
    expect(outcome.stage).toBe('verify-commit-sha');
    expect(outcome.reason).toMatch(/abc/);
    expect(outcome.reason).toMatch(/def/);
    expect(outcome.sessionAtomId).toBe('sess-mismatch');
    expect(review.resolveCalls).toHaveLength(0);
    // finally{} releases workspace even on failure.
    expect(workspaceProvider.captured.releaseCount).toBe(1);
  });

  it("completed result without commitSha -> fix-failed with stage 'agent-no-commit'", async () => {
    const findings = [mkLineCommentForApply({ id: 'l1', path: 'src/foo.ts' })];
    const review = new StubResolveAdapter();
    const agentLoop = recordingAgentLoop({
      kind: 'completed',
      sessionAtomId: 'sess-no-commit' as AtomId,
      turnAtomIds: [],
      // artifacts intentionally missing
    });
    const workspaceProvider = recordingWorkspaceProvider();
    const adapters = makeApplyAdapters({ agentLoop, workspaceProvider, review });
    const actor = new PrFixActor({ pr: APPLY_PR });
    await primeObservation(actor, adapters);

    const outcome = await actor.apply(applyDispatchAction(findings), mkApplyCtx(adapters));

    expect(outcome.kind).toBe('fix-failed');
    if (outcome.kind !== 'fix-failed') throw new Error('unreachable');
    expect(outcome.stage).toBe('agent-no-commit');
    expect(outcome.sessionAtomId).toBe('sess-no-commit');
    expect(review.resolveCalls).toHaveLength(0);
    expect(workspaceProvider.captured.releaseCount).toBe(1);
  });

  it("agent-loop kind:'error' -> fix-failed with stage 'agent-loop/error/<failure-kind>'", async () => {
    const findings = [mkLineCommentForApply({ id: 'l1', path: 'src/foo.ts' })];
    const review = new StubResolveAdapter();
    const agentLoop = recordingAgentLoop({
      kind: 'error',
      sessionAtomId: 'sess-err' as AtomId,
      turnAtomIds: [],
      failure: { kind: 'transient', reason: 'rate limited', stage: 'turn-2' },
    });
    const workspaceProvider = recordingWorkspaceProvider();
    const adapters = makeApplyAdapters({ agentLoop, workspaceProvider, review });
    const actor = new PrFixActor({ pr: APPLY_PR });
    await primeObservation(actor, adapters);

    const outcome = await actor.apply(applyDispatchAction(findings), mkApplyCtx(adapters));

    expect(outcome.kind).toBe('fix-failed');
    if (outcome.kind !== 'fix-failed') throw new Error('unreachable');
    expect(outcome.stage).toBe('agent-loop/error/transient');
    expect(outcome.reason).toContain('rate limited');
    expect(outcome.sessionAtomId).toBe('sess-err');
    expect(review.resolveCalls).toHaveLength(0);
    expect(workspaceProvider.captured.releaseCount).toBe(1);
  });

  it("agent-loop kind:'budget-exhausted' (no failure record) -> fix-failed with stage 'agent-loop/budget-exhausted'", async () => {
    const findings = [mkLineCommentForApply({ id: 'l1', path: 'src/foo.ts' })];
    const review = new StubResolveAdapter();
    const agentLoop = recordingAgentLoop({
      kind: 'budget-exhausted',
      sessionAtomId: 'sess-budget' as AtomId,
      turnAtomIds: [],
    });
    const workspaceProvider = recordingWorkspaceProvider();
    const adapters = makeApplyAdapters({ agentLoop, workspaceProvider, review });
    const actor = new PrFixActor({ pr: APPLY_PR });
    await primeObservation(actor, adapters);

    const outcome = await actor.apply(applyDispatchAction(findings), mkApplyCtx(adapters));

    expect(outcome.kind).toBe('fix-failed');
    if (outcome.kind !== 'fix-failed') throw new Error('unreachable');
    expect(outcome.stage).toBe('agent-loop/budget-exhausted');
    expect(outcome.sessionAtomId).toBe('sess-budget');
  });

  it("workspace acquire throws -> fix-failed with stage 'workspace-acquire'; release NOT called", async () => {
    const findings = [mkLineCommentForApply({ id: 'l1', path: 'src/foo.ts' })];
    const review = new StubResolveAdapter();
    const agentLoop = recordingAgentLoop({
      kind: 'completed',
      sessionAtomId: 'never-reached' as AtomId,
      turnAtomIds: [],
      artifacts: { commitSha: 'sha', branchName: 'feat/x' },
    });
    const workspaceProvider = recordingWorkspaceProvider({
      acquireBehavior: async () => { throw new Error('disk full'); },
    });
    const adapters = makeApplyAdapters({ agentLoop, workspaceProvider, review });
    const actor = new PrFixActor({ pr: APPLY_PR });
    await primeObservation(actor, adapters);

    const outcome = await actor.apply(applyDispatchAction(findings), mkApplyCtx(adapters));

    expect(outcome.kind).toBe('fix-failed');
    if (outcome.kind !== 'fix-failed') throw new Error('unreachable');
    expect(outcome.stage).toBe('workspace-acquire');
    expect(outcome.reason).toContain('disk full');
    expect(outcome.sessionAtomId).toBeNull();
    expect(workspaceProvider.captured.releaseCount).toBe(0);
  });

  it("body-nit findings are NOT individually resolved (no thread)", async () => {
    const findings: ReadonlyArray<ReviewComment> = [
      mkLineCommentForApply({ id: 'l1', path: 'src/foo.ts', kind: 'line' }),
      mkLineCommentForApply({ id: 'b1', path: 'src/foo.ts', kind: 'body-nit' }),
    ];
    const review = new StubResolveAdapter();
    const agentLoop = recordingAgentLoop({
      kind: 'completed',
      sessionAtomId: 'sess-nit' as AtomId,
      turnAtomIds: [],
      artifacts: { commitSha: 'sha-1', branchName: 'feat/x' },
    });
    const workspaceProvider = recordingWorkspaceProvider();
    const adapters = makeApplyAdapters({ agentLoop, workspaceProvider, review });
    const actor = new PrFixActor({
      pr: APPLY_PR,
      readWorkspaceHeadSha: async () => 'sha-1',
      readTouchedPaths: async () => new Set<string>(['src/foo.ts']),
    });
    await primeObservation(actor, adapters);

    const outcome = await actor.apply(applyDispatchAction(findings), mkApplyCtx(adapters));

    expect(outcome.kind).toBe('fix-pushed');
    if (outcome.kind !== 'fix-pushed') throw new Error('unreachable');
    // l1 (line) on touched path -> resolved. b1 (body-nit) -> NOT resolved.
    expect(outcome.resolvedCommentIds).toEqual(['l1']);
    expect(review.resolveCalls.map((c) => c.commentId)).toEqual(['l1']);
  });

  it("findings whose path is NOT in touched-paths are NOT resolved", async () => {
    const findings: ReadonlyArray<ReviewComment> = [
      mkLineCommentForApply({ id: 'on-touched', path: 'src/foo.ts' }),
      mkLineCommentForApply({ id: 'off-touched', path: 'src/untouched.ts' }),
    ];
    const review = new StubResolveAdapter();
    const agentLoop = recordingAgentLoop({
      kind: 'completed',
      sessionAtomId: 'sess-2' as AtomId,
      turnAtomIds: [],
      artifacts: { commitSha: 'sha-2', branchName: 'feat/x' },
    });
    const workspaceProvider = recordingWorkspaceProvider();
    const adapters = makeApplyAdapters({ agentLoop, workspaceProvider, review });
    const actor = new PrFixActor({
      pr: APPLY_PR,
      readWorkspaceHeadSha: async () => 'sha-2',
      readTouchedPaths: async () => new Set<string>(['src/foo.ts']),
    });
    await primeObservation(actor, adapters);

    const outcome = await actor.apply(applyDispatchAction(findings), mkApplyCtx(adapters));

    expect(outcome.kind).toBe('fix-pushed');
    if (outcome.kind !== 'fix-pushed') throw new Error('unreachable');
    expect(outcome.resolvedCommentIds).toEqual(['on-touched']);
    expect(review.resolveCalls.map((c) => c.commentId)).toEqual(['on-touched']);
  });

  it("operator-supplied additionalDisallowedTools merges with the floor", async () => {
    const findings = [mkLineCommentForApply({ id: 'l1', path: 'src/foo.ts' })];
    const review = new StubResolveAdapter();
    const agentLoop = recordingAgentLoop({
      kind: 'completed',
      sessionAtomId: 'sess-tools' as AtomId,
      turnAtomIds: [],
      artifacts: { commitSha: 'sha-tools', branchName: 'feat/x' },
    });
    const workspaceProvider = recordingWorkspaceProvider();
    const adapters = makeApplyAdapters({ agentLoop, workspaceProvider, review });
    const actor = new PrFixActor({
      pr: APPLY_PR,
      readWorkspaceHeadSha: async () => 'sha-tools',
      readTouchedPaths: async () => new Set<string>(),
      additionalDisallowedTools: ['Bash'],
    });
    await primeObservation(actor, adapters);

    await actor.apply(applyDispatchAction(findings), mkApplyCtx(adapters));

    const dt = agentLoop.captured.input?.toolPolicy.disallowedTools ?? [];
    for (const t of ['WebFetch', 'WebSearch', 'NotebookEdit', 'Bash']) {
      expect(dt).toContain(t);
    }
  });

});

// ---------------------------------------------------------------------------
// PrFixActor.apply (pr-escalate)
//
// Scenario: classify returned 'ci-failure' or 'architectural'. propose
// emitted a 'pr-escalate' action carrying a human-readable reason. apply
// surfaces the escalation through the actor-message channel via
// `sendOperatorEscalation` and returns `{kind: 'escalated', reason}` so
// reflect can halt the loop.
//
// Behaviors guarded:
//   1. CI-failure escalation writes an actor-message atom and returns
//      `{kind: 'escalated', reason}`.
//   2. Architectural escalation writes the same shape and the atom's
//      content embeds the reason so the operator sees full context.
//   3. A storage failure during atom write does NOT mask the actor's
//      halt path. apply still returns `{kind: 'escalated', reason}`.
//   4. Pre-observation call (apply before observe ran) is best-effort:
//      returns `{kind: 'escalated', reason}` and does NOT throw.
// ---------------------------------------------------------------------------

function escalateAction(reason: string): ProposedAction<PrFixAction> {
  return {
    tool: 'pr-escalate',
    description: `escalate: ${reason}`,
    payload: { kind: 'pr-escalate', reason },
  };
}

describe('PrFixActor.apply (pr-escalate)', () => {
  it("CI-failure escalation: returns {kind:'escalated', reason} and writes an actor-message atom", async () => {
    const review = new StubResolveAdapter();
    const agentLoop = recordingAgentLoop({
      kind: 'completed',
      sessionAtomId: 'never' as AtomId,
      turnAtomIds: [],
      artifacts: { commitSha: 'x', branchName: 'feat/x' },
    });
    const workspaceProvider = recordingWorkspaceProvider();
    const adapters = makeApplyAdapters({ agentLoop, workspaceProvider, review });
    const actor = new PrFixActor({ pr: APPLY_PR });
    await primeObservation(actor, adapters);

    const reason = 'CI failure: test-suite, ci/build';
    const host = createMemoryHost();
    const ctx = makeStubCtx({ host, adapters });
    const outcome = await actor.apply(escalateAction(reason), ctx);

    expect(outcome.kind).toBe('escalated');
    if (outcome.kind !== 'escalated') throw new Error('unreachable');
    expect(outcome.reason).toBe(reason);

    const messages = await host.atoms.query({ type: ['actor-message'] }, 100);
    expect(messages.atoms.length).toBeGreaterThanOrEqual(1);
    // Workspace was never touched on the escalate path.
    expect(workspaceProvider.captured.acquire).toHaveLength(0);
    expect(workspaceProvider.captured.releaseCount).toBe(0);
  });

  it("architectural escalation: atom body embeds the reason", async () => {
    const review = new StubResolveAdapter();
    const agentLoop = recordingAgentLoop({
      kind: 'completed',
      sessionAtomId: 'never' as AtomId,
      turnAtomIds: [],
      artifacts: { commitSha: 'x', branchName: 'feat/x' },
    });
    const workspaceProvider = recordingWorkspaceProvider();
    const adapters = makeApplyAdapters({ agentLoop, workspaceProvider, review });
    const actor = new PrFixActor({ pr: APPLY_PR });
    await primeObservation(actor, adapters);

    const reason = 'Architectural concern: arch-c1: large refactor needed';
    const host = createMemoryHost();
    const ctx = makeStubCtx({ host, adapters });
    const outcome = await actor.apply(escalateAction(reason), ctx);

    expect(outcome.kind).toBe('escalated');
    if (outcome.kind !== 'escalated') throw new Error('unreachable');
    expect(outcome.reason).toBe(reason);

    const messages = await host.atoms.query({ type: ['actor-message'] }, 100);
    expect(messages.atoms.length).toBeGreaterThanOrEqual(1);
    const message = messages.atoms[0];
    expect(message?.content).toContain(reason);
  });

  it("storage failure during sendOperatorEscalation does NOT mask the halt", async () => {
    const review = new StubResolveAdapter();
    const agentLoop = recordingAgentLoop({
      kind: 'completed',
      sessionAtomId: 'never' as AtomId,
      turnAtomIds: [],
      artifacts: { commitSha: 'x', branchName: 'feat/x' },
    });
    const workspaceProvider = recordingWorkspaceProvider();
    const adapters = makeApplyAdapters({ agentLoop, workspaceProvider, review });
    const actor = new PrFixActor({ pr: APPLY_PR });
    await primeObservation(actor, adapters);

    const host = createMemoryHost();
    // Inject a put failure so the helper's atom write throws something
    // other than ConflictError; the actor must swallow it and still
    // return {kind:'escalated', reason}.
    (host.atoms as unknown as { put: typeof host.atoms.put }).put = async () => {
      throw new Error('atom store refused write');
    };
    const ctx = makeStubCtx({ host, adapters });
    const reason = 'CI failure: lint';

    const outcome = await actor.apply(escalateAction(reason), ctx);
    expect(outcome.kind).toBe('escalated');
    if (outcome.kind !== 'escalated') throw new Error('unreachable');
    expect(outcome.reason).toBe(reason);
  });

  it("returns {kind:'escalated', reason} when apply runs before observe (best-effort)", async () => {
    const review = new StubResolveAdapter();
    const agentLoop = recordingAgentLoop({
      kind: 'completed',
      sessionAtomId: 'never' as AtomId,
      turnAtomIds: [],
      artifacts: { commitSha: 'x', branchName: 'feat/x' },
    });
    const workspaceProvider = recordingWorkspaceProvider();
    const adapters = makeApplyAdapters({ agentLoop, workspaceProvider, review });
    const actor = new PrFixActor({ pr: APPLY_PR });
    // NOTE: no primeObservation() call here -- lastObservation is undefined.

    const host = createMemoryHost();
    const ctx = makeStubCtx({ host, adapters });
    const reason = 'CI failure: lint';

    const outcome = await actor.apply(escalateAction(reason), ctx);
    expect(outcome.kind).toBe('escalated');
    if (outcome.kind !== 'escalated') throw new Error('unreachable');
    expect(outcome.reason).toBe(reason);
  });
});

// ---------------------------------------------------------------------------
// PrFixActor.reflect
// ---------------------------------------------------------------------------

function makeReflectCtx(): ActorContext<PrFixAdapters> {
  const host = createMemoryHost();
  const adapters = {} as unknown as PrFixAdapters;
  return makeStubCtx({ host, adapters });
}

function classifiedWith(classification: PrFixClassification): Classified<PrFixObservation> {
  return {
    observation: baseObs,
    key: `pr-fix:test=${classification}`,
    metadata: { classification, ciFailures: 0, arch: 0 },
  };
}

describe('PrFixActor.reflect', () => {
  it("returns {done:true, progress:false, note:'all clean; nothing to fix'} for 'all-clean' classification", async () => {
    const actor = new PrFixActor({ pr: PR });
    const reflection = await actor.reflect([], classifiedWith('all-clean'), makeReflectCtx());
    expect(reflection.done).toBe(true);
    expect(reflection.progress).toBe(false);
    expect(reflection.note).toBe('all clean; nothing to fix');
  });

  it("returns {done:false, progress:false, note:'partial observation; retrying'} for 'partial' classification", async () => {
    const actor = new PrFixActor({ pr: PR });
    const reflection = await actor.reflect([], classifiedWith('partial'), makeReflectCtx());
    expect(reflection.done).toBe(false);
    expect(reflection.progress).toBe(false);
    expect(reflection.note).toBe('partial observation; retrying');
  });

  it("returns {done:true, progress:false, note:<reason>} when an 'escalated' outcome is present", async () => {
    const actor = new PrFixActor({ pr: PR });
    const outcomes: ReadonlyArray<PrFixOutcome> = [
      { kind: 'escalated', reason: 'CI failure: lint' },
    ];
    const reflection = await actor.reflect(outcomes, classifiedWith('ci-failure'), makeReflectCtx());
    expect(reflection.done).toBe(true);
    expect(reflection.progress).toBe(false);
    expect(reflection.note).toBe('CI failure: lint');
  });

  it("returns {done:false, progress:false, note:<reason>} for a 'fix-failed' outcome (no escalated, no fix-pushed)", async () => {
    const actor = new PrFixActor({ pr: PR });
    const outcomes: ReadonlyArray<PrFixOutcome> = [
      { kind: 'fix-failed', stage: 'verify-commit-sha', reason: 'sha mismatch', sessionAtomId: 's1' as AtomId },
    ];
    const reflection = await actor.reflect(outcomes, classifiedWith('has-findings'), makeReflectCtx());
    expect(reflection.done).toBe(false);
    expect(reflection.progress).toBe(false);
    expect(reflection.note).toBe('sha mismatch');
  });

  it("returns {done:false, progress:true, note:'fix pushed; reobserving'} for a 'fix-pushed' outcome (no escalated, no failed)", async () => {
    const actor = new PrFixActor({ pr: PR });
    const outcomes: ReadonlyArray<PrFixOutcome> = [
      { kind: 'fix-pushed', commitSha: 'abc', resolvedCommentIds: ['c1'], sessionAtomId: 's1' as AtomId },
    ];
    const reflection = await actor.reflect(outcomes, classifiedWith('has-findings'), makeReflectCtx());
    expect(reflection.done).toBe(false);
    expect(reflection.progress).toBe(true);
    expect(reflection.note).toBe('fix pushed; reobserving');
  });

  it("returns {done:false, progress:false, note:'no progress'} for empty outcomes with 'has-findings' classification (defensive)", async () => {
    const actor = new PrFixActor({ pr: PR });
    const reflection = await actor.reflect([], classifiedWith('has-findings'), makeReflectCtx());
    expect(reflection.done).toBe(false);
    expect(reflection.progress).toBe(false);
    expect(reflection.note).toBe('no progress');
  });

  it("'escalated' outcome takes priority over 'fix-failed' and 'fix-pushed' in the same iteration", async () => {
    const actor = new PrFixActor({ pr: PR });
    const outcomes: ReadonlyArray<PrFixOutcome> = [
      { kind: 'fix-pushed', commitSha: 'abc', resolvedCommentIds: [], sessionAtomId: 's1' as AtomId },
      { kind: 'fix-failed', stage: 'verify-commit-sha', reason: 'mismatch', sessionAtomId: 's2' as AtomId },
      { kind: 'escalated', reason: 'Architectural concern: rework needed' },
    ];
    const reflection = await actor.reflect(outcomes, classifiedWith('architectural'), makeReflectCtx());
    expect(reflection.done).toBe(true);
    expect(reflection.progress).toBe(false);
    expect(reflection.note).toBe('Architectural concern: rework needed');
  });

  it("'fix-failed' outcome takes priority over 'fix-pushed' when no 'escalated' present", async () => {
    const actor = new PrFixActor({ pr: PR });
    const outcomes: ReadonlyArray<PrFixOutcome> = [
      { kind: 'fix-pushed', commitSha: 'abc', resolvedCommentIds: [], sessionAtomId: 's1' as AtomId },
      { kind: 'fix-failed', stage: 'agent-no-commit', reason: 'agent loop completed but did not commit', sessionAtomId: 's2' as AtomId },
    ];
    const reflection = await actor.reflect(outcomes, classifiedWith('has-findings'), makeReflectCtx());
    expect(reflection.done).toBe(false);
    expect(reflection.progress).toBe(false);
    expect(reflection.note).toBe('agent loop completed but did not commit');
  });
});

// ---------------------------------------------------------------------------
// PrFixActor end-to-end (MemoryHost)
//
// Drives observe -> classify -> propose -> apply -> reflect against a single
// MemoryHost-backed AtomStore using the same stub adapter helpers from the
// per-method blocks. The intent is to assert the contracts compose: the
// observation atom written in observe() lands in the store, classify and
// propose see the freshest counts, apply receives `checkoutBranch ===
// observation.headBranch`, and reflect produces the right done/progress
// signal for the iteration. Convergence-loop interaction is out of scope
// (runActor's responsibility); this block exercises the actor contract chain.
// ---------------------------------------------------------------------------

const E2E_PR: PrIdentifier = { owner: 'o', repo: 'r', number: 42 };

function makeE2EAdapters(args: {
  status: PrReviewStatus;
  prDetails: { head: { ref: string; sha: string }; base: { ref: string } };
  agentLoop: AgentLoopAdapter;
  workspaceProvider: WorkspaceProvider;
  resolveBehavior?: (commentId: string) => Promise<void>;
}): { adapters: PrFixAdapters; review: StubResolveAdapter; ghClient: GhClient } {
  const review = new StubResolveAdapter(args.resolveBehavior);
  // Override getPrReviewStatus so the e2e exercises non-empty findings sets.
  review.getPrReviewStatus = async (pr: PrIdentifier): Promise<PrReviewStatus> => ({
    ...args.status,
    pr,
  });
  const ghClient = makeStubGhClient(args.prDetails);
  const adapters = {
    review,
    agentLoop: { ...args.agentLoop, name: 'stub-agent-loop', version: '0' },
    workspaceProvider: { ...args.workspaceProvider, name: 'stub-workspace', version: '0' },
    blobStore: { ...EMPTY_BLOB_STORE, name: 'stub-blob', version: '0' },
    redactor: { ...NOOP_REDACTOR, name: 'stub-redactor', version: '0' },
    ghClient: { ...(ghClient as object), name: 'stub-gh', version: '0' } as unknown as GhClient & { readonly name: string; readonly version: string },
  } as unknown as PrFixAdapters;
  return { adapters, review, ghClient };
}

describe('PrFixActor end-to-end (MemoryHost)', () => {
  it('one full pass with findings: observe -> classify=has-findings -> propose dispatch -> apply fix-pushed -> reflect progress', async () => {
    const host = createMemoryHost();
    const findings = [
      mkLineCommentForApply({ id: 'l1', path: 'src/foo.ts', body: 'rename this', kind: 'line' }),
    ];
    const status: PrReviewStatus = {
      pr: E2E_PR,
      mergeable: true,
      mergeStateStatus: 'BLOCKED',
      prState: 'OPEN',
      title: null,
      lineComments: findings,
      bodyNits: [],
      submittedReviews: [
        { author: 'coderabbitai', state: 'CHANGES_REQUESTED', submittedAt: '2026-04-25T00:00:00.000Z' },
      ],
      checkRuns: [],
      legacyStatuses: [],
      partial: false,
      partialSurfaces: [],
    };
    const agentLoop = recordingAgentLoop({
      kind: 'completed',
      sessionAtomId: 'sess-e2e' as AtomId,
      turnAtomIds: ['t-e2e' as AtomId],
      artifacts: { commitSha: 'sha-e2e', branchName: 'feat/x', touchedPaths: ['src/foo.ts'] },
    });
    const workspaceProvider = recordingWorkspaceProvider();
    const { adapters, review } = makeE2EAdapters({
      status,
      prDetails: { head: { ref: 'feat/x', sha: 'before-fix-sha' }, base: { ref: 'main' } },
      agentLoop,
      workspaceProvider,
    });
    const actor = new PrFixActor({
      pr: E2E_PR,
      readWorkspaceHeadSha: async () => 'sha-e2e',
      readTouchedPaths: async () => new Set<string>(['src/foo.ts']),
    });
    const ctx = makeStubCtx({ host, adapters });

    // observe
    const obs = await actor.observe(ctx);
    expect(obs.headBranch).toBe('feat/x');
    expect(obs.lineComments).toHaveLength(1);
    const obsAtoms = await host.atoms.query({ type: ['observation'] }, 100);
    const prFixObsAtoms = obsAtoms.atoms.filter(
      (a) => (a.metadata as { kind?: string }).kind === 'pr-fix-observation',
    );
    expect(prFixObsAtoms).toHaveLength(1);

    // classify
    const classified = await actor.classify(obs, ctx);
    expect((classified.metadata as { classification: PrFixClassification }).classification).toBe('has-findings');

    // propose
    const actions = await actor.propose(classified, ctx);
    expect(actions).toHaveLength(1);
    const action = actions[0]!;
    expect(action.tool).toBe('agent-loop-dispatch');
    if (action.payload.kind !== 'agent-loop-dispatch') throw new Error('discriminant');
    expect(action.payload.headBranch).toBe(obs.headBranch);

    // apply
    const outcome = await actor.apply(action, ctx);
    expect(outcome.kind).toBe('fix-pushed');
    if (outcome.kind !== 'fix-pushed') throw new Error('unreachable');
    expect(outcome.commitSha).toBe('sha-e2e');
    expect(outcome.resolvedCommentIds).toEqual(['l1']);

    // Regression guard: workspace acquired with checkoutBranch === observation.headBranch.
    expect(workspaceProvider.captured.acquire).toHaveLength(1);
    expect(workspaceProvider.captured.acquire[0]?.checkoutBranch).toBe(obs.headBranch);
    expect(workspaceProvider.captured.acquire[0]?.baseRef).toBe(obs.baseRef);
    expect(review.resolveCalls.map((c) => c.commentId)).toEqual(['l1']);

    // reflect
    const reflection = await actor.reflect([outcome], classified, ctx);
    expect(reflection.done).toBe(false);
    expect(reflection.progress).toBe(true);
    expect(reflection.note).toBe('fix pushed; reobserving');
  });

  it('all-clean iteration: observe -> classify=all-clean -> propose [] -> reflect done', async () => {
    const host = createMemoryHost();
    const status: PrReviewStatus = {
      pr: E2E_PR,
      mergeable: true,
      mergeStateStatus: 'CLEAN',
      prState: 'OPEN',
      title: null,
      lineComments: [],
      bodyNits: [],
      submittedReviews: [
        { author: 'coderabbitai', state: 'APPROVED', submittedAt: '2026-04-25T00:00:00.000Z' },
      ],
      checkRuns: [
        { name: 'CodeRabbit', status: 'completed', conclusion: 'success' },
      ],
      legacyStatuses: [],
      partial: false,
      partialSurfaces: [],
    };
    const agentLoop = recordingAgentLoop({
      kind: 'completed',
      sessionAtomId: 'never' as AtomId,
      turnAtomIds: [],
      artifacts: { commitSha: 'never', branchName: 'feat/x' },
    });
    const workspaceProvider = recordingWorkspaceProvider();
    const { adapters } = makeE2EAdapters({
      status,
      prDetails: { head: { ref: 'feat/x', sha: 'final-sha' }, base: { ref: 'main' } },
      agentLoop,
      workspaceProvider,
    });
    const actor = new PrFixActor({ pr: E2E_PR });
    const ctx = makeStubCtx({ host, adapters });

    const obs = await actor.observe(ctx);
    const classified = await actor.classify(obs, ctx);
    expect((classified.metadata as { classification: PrFixClassification }).classification).toBe('all-clean');

    const actions = await actor.propose(classified, ctx);
    expect(actions).toEqual([]);

    // No actions => no apply call. reflect on empty outcomes + all-clean halts.
    const reflection = await actor.reflect([], classified, ctx);
    expect(reflection.done).toBe(true);
    expect(reflection.progress).toBe(false);
    expect(reflection.note).toBe('all clean; nothing to fix');

    // Workspace was never touched on the all-clean path.
    expect(workspaceProvider.captured.acquire).toHaveLength(0);
    expect(workspaceProvider.captured.releaseCount).toBe(0);
  });

  it("commit-SHA mismatch: apply returns fix-failed stage='verify-commit-sha'; reflect done=false progress=false", async () => {
    const host = createMemoryHost();
    const findings = [
      mkLineCommentForApply({ id: 'l1', path: 'src/foo.ts', body: 'rename this', kind: 'line' }),
    ];
    const status: PrReviewStatus = {
      pr: E2E_PR,
      mergeable: true,
      mergeStateStatus: 'BLOCKED',
      prState: 'OPEN',
      title: null,
      lineComments: findings,
      bodyNits: [],
      submittedReviews: [],
      checkRuns: [],
      legacyStatuses: [],
      partial: false,
      partialSurfaces: [],
    };
    // Stub adapter claims commit 'abc' but workspace HEAD is 'def'.
    const agentLoop = recordingAgentLoop({
      kind: 'completed',
      sessionAtomId: 'sess-mismatch' as AtomId,
      turnAtomIds: [],
      artifacts: { commitSha: 'abc', branchName: 'feat/x' },
    });
    const workspaceProvider = recordingWorkspaceProvider();
    const { adapters, review } = makeE2EAdapters({
      status,
      prDetails: { head: { ref: 'feat/x', sha: 'before-fix-sha' }, base: { ref: 'main' } },
      agentLoop,
      workspaceProvider,
    });
    const actor = new PrFixActor({
      pr: E2E_PR,
      readWorkspaceHeadSha: async () => 'def',
      readTouchedPaths: async () => new Set<string>(['src/foo.ts']),
    });
    const ctx = makeStubCtx({ host, adapters });

    const obs = await actor.observe(ctx);
    const classified = await actor.classify(obs, ctx);
    expect((classified.metadata as { classification: PrFixClassification }).classification).toBe('has-findings');

    const actions = await actor.propose(classified, ctx);
    const action = actions[0]!;
    const outcome = await actor.apply(action, ctx);
    expect(outcome.kind).toBe('fix-failed');
    if (outcome.kind !== 'fix-failed') throw new Error('unreachable');
    expect(outcome.stage).toBe('verify-commit-sha');
    expect(outcome.reason).toMatch(/abc/);
    expect(outcome.reason).toMatch(/def/);
    // No threads resolved on a SHA mismatch.
    expect(review.resolveCalls).toHaveLength(0);
    // Workspace still released in finally{}.
    expect(workspaceProvider.captured.releaseCount).toBe(1);

    const reflection = await actor.reflect([outcome], classified, ctx);
    expect(reflection.done).toBe(false);
    expect(reflection.progress).toBe(false);
  });
});
