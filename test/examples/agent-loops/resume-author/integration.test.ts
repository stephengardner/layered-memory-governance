/**
 * Integration-shape test for ResumeAuthorAgentLoopAdapter on a real
 * MemoryHost. Spec ref: §8.2 of
 * docs/superpowers/specs/2026-04-25-resume-author-agent-loop-adapter-design.md.
 *
 * Why this exists in addition to loop.test.ts
 * --------------------------------------------
 * The unit tests in loop.test.ts use a recording fallback that writes
 * agent-session atoms but never exercises the wrapper-side end-to-end
 * shape: `assembleCandidates` walking real atoms, `walkAuthorSessions`
 * pulling pr-fix-observation chains out of the host, the wrapper
 * patching the resumed-session atom in the same store the candidates
 * came from, and the consumer downstream observing the patched
 * `extra.resumed_from_atom_id` + `extra.resume_strategy_used` fields.
 *
 * This file plumbs all of those through a single MemoryHost so the
 * three substrate touch points (atom-store seed -> walkAuthorSessions
 * walk -> wrapper patch) wire up live; a regression in any of the
 * three surfaces here as a failed assertion rather than as a silent
 * miss in production.
 */
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  ResumeAuthorAgentLoopAdapter,
  walkAuthorSessions,
} from '../../../../examples/agent-loops/resume-author/index.js';
import type {
  CandidateSession,
  SessionResumeStrategy,
} from '../../../../examples/agent-loops/resume-author/types.js';
import type {
  AdapterCapabilities,
  AgentLoopAdapter,
  AgentLoopInput,
  AgentLoopResult,
} from '../../../../src/substrate/agent-loop.js';
import { defaultClassifyFailure } from '../../../../src/substrate/agent-loop.js';
import type { Workspace } from '../../../../src/substrate/workspace-provider.js';
import type { BlobStore, BlobRef } from '../../../../src/substrate/blob-store.js';
import type { Redactor } from '../../../../src/substrate/redactor.js';
import type {
  Atom,
  AtomId,
  PrincipalId,
  Time,
} from '../../../../src/substrate/types.js';
import { createMemoryHost, type MemoryHost } from '../../../../src/adapters/memory/index.js';
import { mkPrFixObservationAtom } from '../../../../src/runtime/actors/pr-fix/pr-fix-observation.js';
import type { PrFixObservationMeta } from '../../../../src/runtime/actors/pr-fix/types.js';

const PRINCIPAL = 'pr-fix-actor' as PrincipalId;
const WORKSPACE: Workspace = { id: 'ws-1', path: '/tmp/integration-ws', baseRef: 'main' };
const NOOP_REDACTOR: Redactor = { redact: (s) => s };

const FALLBACK_CAPS: AdapterCapabilities = {
  tracks_cost: true,
  supports_signal: true,
  classify_failure: defaultClassifyFailure,
};

/**
 * Minimal in-memory blob store that satisfies the substrate contract.
 * Reuses the structure from loop.test.ts so both files share an
 * obvious idiom.
 */
function makeInMemoryBlobStore(): BlobStore {
  const m = new Map<string, Buffer>();
  return {
    put: async (c) => {
      const buf = typeof c === 'string' ? Buffer.from(c) : c;
      const ref = `sha256:${randomBytes(32).toString('hex')}` as BlobRef;
      m.set(ref, buf);
      return ref;
    },
    get: async (r) => m.get(r as string)!,
    has: async (r) => m.has(r as string),
    describeStorage: () => ({ kind: 'remote' as const, target: 'in-memory:integration' }),
  };
}

function makeAgentLoopInput(host: MemoryHost): AgentLoopInput {
  return {
    host,
    principal: PRINCIPAL,
    workspace: WORKSPACE,
    task: { planAtomId: 'plan-1' as AtomId, questionPrompt: 'address-cr-findings' },
    budget: { max_turns: 10, max_wall_clock_ms: 60_000, max_usd: 1 },
    toolPolicy: { disallowedTools: [] },
    redactor: NOOP_REDACTOR,
    blobStore: makeInMemoryBlobStore(),
    replayTier: 'content-addressed',
    blobThreshold: 4096,
    correlationId: `corr-${randomBytes(4).toString('hex')}`,
  };
}

/**
 * Construct an `agent-session` atom shaped exactly like the agent-loop
 * substrate writes them on session-finalization. The seeded atom MUST
 * carry a non-empty `metadata.agent_session.extra.resumable_session_id`
 * so walkAuthorSessions surfaces it as a candidate.
 */
function mkAgentSessionAtom(opts: {
  readonly id: string;
  readonly startedAt: Time;
  readonly adapterId: string;
  readonly resumableSessionId: string;
}): Atom {
  return {
    schema_version: 1,
    id: opts.id as AtomId,
    content: `seeded-session-${opts.id}`,
    type: 'agent-session',
    layer: 'L0',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: 'agentic-code-author' },
      derived_from: [],
    },
    confidence: 1,
    created_at: opts.startedAt,
    last_reinforced_at: opts.startedAt,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: 'agentic-code-author' as PrincipalId,
    taint: 'clean',
    metadata: {
      agent_session: {
        model_id: 'claude-opus-4-7',
        adapter_id: opts.adapterId,
        workspace_id: WORKSPACE.id,
        started_at: opts.startedAt,
        completed_at: opts.startedAt,
        terminal_state: 'completed',
        replay_tier: 'content-addressed',
        budget_consumed: { turns: 1, wall_clock_ms: 100 },
        extra: { resumable_session_id: opts.resumableSessionId },
      },
    },
  };
}

/**
 * Build a pr-fix-observation atom via the production atom builder so
 * the integration genuinely exercises the same shape an actor writes.
 */
function mkObservationViaProductionBuilder(opts: {
  readonly observationId: string;
  readonly priorObservationAtomId: string | undefined;
  readonly dispatchedSessionAtomId: string | undefined;
  readonly prOwner: string;
  readonly prRepo: string;
  readonly prNumber: number;
  readonly now: Time;
}): Atom {
  const meta: PrFixObservationMeta = {
    pr_owner: opts.prOwner,
    pr_repo: opts.prRepo,
    pr_number: opts.prNumber,
    head_branch: 'feat/integration',
    head_sha: 'integration0001',
    cr_review_states: [],
    merge_state_status: null,
    mergeable: null,
    line_comment_count: 1,
    body_nit_count: 0,
    check_run_failure_count: 0,
    legacy_status_failure_count: 0,
    partial: false,
    classification: 'has-findings',
  };
  return mkPrFixObservationAtom({
    principal: PRINCIPAL,
    observationId: opts.observationId as AtomId,
    meta,
    priorObservationAtomId: opts.priorObservationAtomId !== undefined
      ? (opts.priorObservationAtomId as AtomId)
      : undefined,
    dispatchedSessionAtomId: opts.dispatchedSessionAtomId !== undefined
      ? (opts.dispatchedSessionAtomId as AtomId)
      : undefined,
    now: opts.now,
  });
}

/**
 * Real-shaped fallback that writes a fresh `agent-session` atom into
 * the host and returns a real session id. Tracks every call for the
 * integration assertions. Mirrors the production claude-code adapter's
 * write-on-entry contract closely enough that walkAuthorSessions
 * could in principle pick this session up on a subsequent run.
 */
interface RecordedFallbackCall {
  readonly resumeSessionId: string | undefined;
  readonly correlationId: string;
}

function makeProductionShapedFallback(host: MemoryHost): AgentLoopAdapter & {
  readonly calls: ReadonlyArray<RecordedFallbackCall>;
} {
  const calls: RecordedFallbackCall[] = [];
  return {
    capabilities: FALLBACK_CAPS,
    calls,
    async run(input: AgentLoopInput): Promise<AgentLoopResult> {
      calls.push({
        resumeSessionId: input.resumeSessionId,
        correlationId: input.correlationId,
      });
      const sessionId = `fresh-session-${randomBytes(6).toString('hex')}` as AtomId;
      const now = new Date().toISOString();
      const sessionAtom: Atom = {
        schema_version: 1,
        id: sessionId,
        content: `fallback-spawned-session ${input.correlationId}`,
        type: 'agent-session',
        layer: 'L0',
        provenance: {
          kind: 'agent-observed',
          source: { agent_id: input.principal as unknown as string },
          derived_from: [],
        },
        confidence: 1,
        created_at: now,
        last_reinforced_at: now,
        expires_at: null,
        supersedes: [],
        superseded_by: [],
        scope: 'project',
        signals: {
          agrees_with: [],
          conflicts_with: [],
          validation_status: 'unchecked',
          last_validated_at: null,
        },
        principal_id: input.principal,
        taint: 'clean',
        metadata: {
          agent_session: {
            model_id: 'claude-opus-4-7',
            adapter_id: 'claude-code-agent-loop',
            workspace_id: input.workspace.id,
            started_at: now,
            completed_at: now,
            terminal_state: 'completed',
            replay_tier: input.replayTier,
            budget_consumed: { turns: 1, wall_clock_ms: 100 },
            // The fallback honors `resumeSessionId` by recording it on
            // the new session atom under the canonical extra slot. A
            // production adapter does the same after extracting the
            // CLI's session UUID; for the integration shape, replaying
            // the input token is sufficient evidence that the resume
            // hint propagated through the wrapper.
            extra:
              input.resumeSessionId !== undefined
                ? { resumable_session_id: input.resumeSessionId }
                : { resumable_session_id: `fresh-uuid-${randomBytes(4).toString('hex')}` },
          },
        },
      };
      await host.atoms.put(sessionAtom);
      return {
        kind: 'completed',
        sessionAtomId: sessionId,
        turnAtomIds: [],
        artifacts: { commitSha: 'integration-commit-sha' },
      };
    },
  } as AgentLoopAdapter & { calls: RecordedFallbackCall[] };
}

describe('ResumeAuthorAgentLoopAdapter -- integration on MemoryHost', () => {
  it('resumes when prior pr-fix-observation chain has a resumable session', async () => {
    const host = createMemoryHost();

    // Seed: prior agent-session atom with a known resumable token.
    const seededSessionId = 'seeded-session-001';
    const seededResumableId = 'test-uuid-001';
    await host.atoms.put(
      mkAgentSessionAtom({
        id: seededSessionId,
        startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        adapterId: 'claude-code-agent-loop',
        resumableSessionId: seededResumableId,
      }),
    );

    // Seed: prior pr-fix-observation atom pointing at that session via
    // dispatched_session_atom_id. Built through the real atom builder
    // so the shape matches what the actor writes in production.
    const priorObsId = 'pr-fix-obs-prior-001';
    await host.atoms.put(
      mkObservationViaProductionBuilder({
        observationId: priorObsId,
        priorObservationAtomId: undefined,
        dispatchedSessionAtomId: seededSessionId,
        prOwner: 'acme',
        prRepo: 'memory-governance',
        prNumber: 999,
        now: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      }),
    );

    // Seed: current iteration's pr-fix-observation atom whose
    // provenance.derived_from[0] points at the prior observation. This
    // is the atom walkAuthorSessions starts the walk from.
    const currentObsId = 'pr-fix-obs-current-001';
    await host.atoms.put(
      mkObservationViaProductionBuilder({
        observationId: currentObsId,
        priorObservationAtomId: priorObsId,
        dispatchedSessionAtomId: undefined,
        prOwner: 'acme',
        prRepo: 'memory-governance',
        prNumber: 999,
        now: new Date().toISOString(),
      }),
    );

    let stubResumeStrategyCalled = 0;
    const stubResumeStrategy: SessionResumeStrategy = {
      name: 'integration-stub',
      async findResumableSession(ctx) {
        stubResumeStrategyCalled += 1;
        if (ctx.candidateSessions.length === 0) return null;
        const first = ctx.candidateSessions[0]!;
        return {
          resumableSessionId: first.resumableSessionId,
          resumedFromSessionAtomId: first.sessionAtomId,
          strategyName: this.name,
        };
      },
    };

    const fallback = makeProductionShapedFallback(host);

    // Capture the candidates that assembleCandidates returns so the
    // assertion below can verify the walk actually surfaced the seed.
    let candidatesSeen: ReadonlyArray<CandidateSession> = [];
    const wrapper = new ResumeAuthorAgentLoopAdapter({
      fallback,
      host,
      strategies: [stubResumeStrategy],
      // The runner script's pattern: walk from the LATEST pr-fix-observation
      // atom in the host (newest-first by created_at) so this integration
      // exercises the production-shape candidate-assembly path end-to-end.
      assembleCandidates: async () => {
        const obsPage = await host.atoms.query({ type: ['observation'] }, 50);
        const prFixObs = obsPage.atoms.find(
          (a) => (a.metadata as { kind?: string }).kind === 'pr-fix-observation',
        );
        if (prFixObs === undefined) return [];
        const out = await walkAuthorSessions(host, prFixObs.id);
        candidatesSeen = out;
        return out;
      },
    });

    const result = await wrapper.run(makeAgentLoopInput(host));

    // Strategy was consulted exactly once, with one candidate from the
    // walk; fallback was invoked exactly once with the resume token.
    expect(stubResumeStrategyCalled).toBe(1);
    expect(candidatesSeen).toHaveLength(1);
    expect(candidatesSeen[0]!.resumableSessionId).toBe(seededResumableId);
    expect(candidatesSeen[0]!.sessionAtomId).toBe(seededSessionId);
    expect(candidatesSeen[0]!.adapterId).toBe('claude-code-agent-loop');
    expect(fallback.calls).toHaveLength(1);
    expect(fallback.calls[0]!.resumeSessionId).toBe(seededResumableId);
    expect(result.kind).toBe('completed');

    // Wrapper patched the new session atom with the cross-reference
    // metadata. Read it back from the SAME store the candidates came
    // from to exercise the full read-write loop.
    const patchedAtom = await host.atoms.get(result.sessionAtomId);
    expect(patchedAtom).not.toBeNull();
    const meta = patchedAtom!.metadata as Record<string, unknown>;
    const agentSession = meta['agent_session'] as Record<string, unknown>;
    const extra = agentSession['extra'] as Record<string, unknown>;
    expect(extra['resumed_from_atom_id']).toBe(seededSessionId);
    expect(extra['resume_strategy_used']).toBe('integration-stub');
    // The resume token the fallback wrote MUST be preserved by the
    // wrapper's patch (the patch is a merge, not an overwrite).
    expect(extra['resumable_session_id']).toBe(seededResumableId);
  });

  it('falls through to fresh-spawn when no prior observation exists', async () => {
    const host = createMemoryHost();

    let stubResumeStrategyCalled = 0;
    const stubResumeStrategy: SessionResumeStrategy = {
      name: 'integration-stub',
      async findResumableSession(ctx) {
        stubResumeStrategyCalled += 1;
        if (ctx.candidateSessions.length === 0) return null;
        const first = ctx.candidateSessions[0]!;
        return {
          resumableSessionId: first.resumableSessionId,
          resumedFromSessionAtomId: first.sessionAtomId,
          strategyName: this.name,
        };
      },
    };

    const fallback = makeProductionShapedFallback(host);

    const wrapper = new ResumeAuthorAgentLoopAdapter({
      fallback,
      host,
      strategies: [stubResumeStrategy],
      assembleCandidates: async () => {
        const obsPage = await host.atoms.query({ type: ['observation'] }, 50);
        const prFixObs = obsPage.atoms.find(
          (a) => (a.metadata as { kind?: string }).kind === 'pr-fix-observation',
        );
        if (prFixObs === undefined) return [];
        return walkAuthorSessions(host, prFixObs.id);
      },
    });

    const result = await wrapper.run(makeAgentLoopInput(host));

    // Empty store -> empty candidate list -> strategy called once with
    // zero candidates and returns null -> wrapper delegates to fallback
    // without a resume hint.
    expect(stubResumeStrategyCalled).toBe(1);
    expect(fallback.calls).toHaveLength(1);
    expect(fallback.calls[0]!.resumeSessionId).toBeUndefined();
    expect(result.kind).toBe('completed');

    // The fresh-spawn session atom is in the store and has its OWN
    // resumable_session_id (a fresh UUID, not the seeded one), and
    // does NOT carry a resumed_from_atom_id.
    const freshAtom = await host.atoms.get(result.sessionAtomId);
    expect(freshAtom).not.toBeNull();
    const meta = freshAtom!.metadata as Record<string, unknown>;
    const agentSession = meta['agent_session'] as Record<string, unknown>;
    const extra = agentSession['extra'] as Record<string, unknown>;
    expect(extra['resumed_from_atom_id']).toBeUndefined();
    expect(extra['resume_strategy_used']).toBeUndefined();
    expect(typeof extra['resumable_session_id']).toBe('string');
  });
});
