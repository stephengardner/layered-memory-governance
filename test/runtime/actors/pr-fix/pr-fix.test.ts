import { describe, it, expect } from 'vitest';
import type { PrFixObservation, PrFixAction, PrFixOutcome, PrFixAdapters, PrFixClassification } from '../../../../src/runtime/actors/pr-fix/types.js';
import type { AtomId, PrFixObservationMeta, PrincipalId } from '../../../../src/substrate/types.js';
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
