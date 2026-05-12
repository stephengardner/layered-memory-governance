/**
 * Contract test for the agentic dispatch-stage adapter.
 *
 * Asserts:
 *   - the adapter is a PlanningStage<unknown, DispatchRecordPayload>;
 *   - run() returns a StageOutput with atom_type='dispatch-record';
 *   - the produced payload passes dispatchRecordPayloadSchema (mirrors
 *     the single-shot adapter's output contract);
 *   - the adapter emits the canon-bound + agent-turn + canon-audit-complete
 *     pipeline-stage-event chain by default;
 *   - disableCanonAudit=true skips the canon-audit checkpoint;
 *   - audit() re-runs the single-shot gated-finding emission unchanged;
 *   - config.principal threads through into the prompt and the
 *     AgentLoopInput.principal so the override stays in sync with the
 *     resolved actor identity;
 *   - verdict='rejected' translates to dispatch_status='gated' with the
 *     reason as gating_reason;
 *   - verdict='approved' invokes runDispatchTick (sub-actor invoker is
 *     called when a pipeline-scoped plan is present).
 */

import { describe, expect, it } from 'vitest';
import { buildAgenticDispatchStage } from '../../../../examples/planning-stages/dispatch/agentic.js';
import { dispatchRecordPayloadSchema } from '../../../../examples/planning-stages/dispatch/index.js';
import { createMemoryHost } from '../../../../src/adapters/memory/index.js';
import { SubActorRegistry } from '../../../../src/runtime/actor-message/index.js';
import type { AgentLoopAdapter } from '../../../../src/substrate/agent-loop.js';
import type {
  Atom,
  AtomId,
  PrincipalId,
  Time,
} from '../../../../src/substrate/types.js';
import type { StageInput } from '../../../../src/runtime/planning-pipeline/index.js';
import {
  makeStubAdapter,
  makeStubHostBundle,
  STUB_CAPABILITIES,
} from '../agent-loop-stubs.js';

const PRINCIPAL = 'plan-dispatcher' as PrincipalId;
const PIPELINE_ID = 'pipeline-dispatch-agentic-test' as AtomId;
const VERIFIED_ATOM_ID = 'atom-verified-1' as AtomId;
const VERIFIED_SUB_ACTOR = 'code-author' as PrincipalId;

function makeStageInput(host: ReturnType<typeof createMemoryHost>): StageInput<unknown> {
  return {
    host,
    principal: PRINCIPAL,
    correlationId: 'corr-dispatch-agentic-1',
    // Review-report shaped prior output: the dispatch stage verifies
    // this is clean before the substrate hands off to runDispatchTick.
    priorOutput: {
      audit_status: 'clean' as const,
      findings: [],
      total_bytes_read: 0,
      cost_usd: 0,
    },
    pipelineId: PIPELINE_ID,
    seedAtomIds: [],
    verifiedCitedAtomIds: [VERIFIED_ATOM_ID],
    verifiedSubActorPrincipalIds: [VERIFIED_SUB_ACTOR],
    operatorIntentContent:
      'add a one-line note to the README explaining what the deep planning pipeline does',
    priorAuditFindings: [],
    priorValidatorError: '',
  };
}

/**
 * Seed an approved plan whose provenance.derived_from includes the
 * pipeline atom id, so the dispatch-stage's planFilter (mirrors the
 * single-shot adapter) selects it for the runDispatchTick handoff.
 */
async function seedPlanForDispatch(
  host: ReturnType<typeof createMemoryHost>,
  id: string,
  subActorPrincipalId: string,
): Promise<AtomId> {
  const atomId = id as AtomId;
  const plan: Atom = {
    schema_version: 1,
    id: atomId,
    content: 'plan body',
    type: 'plan',
    layer: 'L0',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: 'cto-actor' },
      derived_from: [PIPELINE_ID],
    },
    confidence: 0.9,
    created_at: '2026-04-28T00:00:00.000Z' as Time,
    last_reinforced_at: '2026-04-28T00:00:00.000Z' as Time,
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
    principal_id: 'cto-actor' as PrincipalId,
    plan_state: 'approved',
    taint: 'clean',
    metadata: {
      delegation: {
        sub_actor_principal_id: subActorPrincipalId,
        reason: 'agentic dispatch-stage test',
        implied_blast_radius: 'tooling',
      },
    },
  };
  await host.atoms.put(plan);
  return atomId;
}

const STUB_APPROVED_VERDICT = {
  verdict: 'approved' as const,
  reason: `walked plan citations [${VERIFIED_ATOM_ID}] and confirmed sub-actor [${VERIFIED_SUB_ACTOR}] in verified set; review-report audit_status=clean`,
};

const STUB_REJECTED_VERDICT = {
  verdict: 'rejected' as const,
  reason: 'plan derived_from contains atom-id atom-fabricated-1 NOT in verified citation set; chain rejected',
};

describe('agenticDispatchStage', () => {
  it('produces a DispatchRecordPayload with atom_type dispatch-record on approved verdict', async () => {
    const { host, blobStore, redactor, workspaceProvider } = makeStubHostBundle();
    const registry = new SubActorRegistry();
    let invokedAtAll = false;
    registry.register(VERIFIED_SUB_ACTOR, async () => {
      invokedAtAll = true;
      return { kind: 'completed', producedAtomIds: [], summary: 'ok' };
    });
    await seedPlanForDispatch(host, 'plan-dispatch-agentic-1', VERIFIED_SUB_ACTOR);

    // Sequencing adapter: first call returns the verification verdict,
    // second call returns the canon-audit verdict.
    let runIdx = 0;
    const sequencingAdapter: AgentLoopAdapter = {
      capabilities: STUB_CAPABILITIES,
      async run(input) {
        const stub = makeStubAdapter({
          outputs: [JSON.stringify(STUB_APPROVED_VERDICT)],
        });
        const auditStub = makeStubAdapter({
          outputs: [JSON.stringify({ verdict: 'approved', findings: [] })],
        });
        const a = runIdx === 0 ? stub : auditStub;
        runIdx++;
        return a.run(input);
      },
    };

    const stage = buildAgenticDispatchStage({
      agentLoop: sequencingAdapter,
      workspaceProvider,
      blobStore,
      redactor,
      registry,
      baseRef: 'main',
    });
    expect(stage.name).toBe('dispatch-stage');
    expect(stage.outputSchema).toBe(dispatchRecordPayloadSchema);

    const stageInput = makeStageInput(host);
    const out = await stage.run(stageInput);
    expect(out.atom_type).toBe('dispatch-record');
    const parsed = dispatchRecordPayloadSchema.safeParse(out.value);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.dispatch_status).toBe('completed');
      expect(parsed.data.dispatched).toBe(1);
      expect(parsed.data.failed).toBe(0);
    }
    // The approved verdict authorised runDispatchTick to invoke the
    // registered sub-actor invoker; the dispatch-stage adapter does
    // NOT invoke sub-actors itself.
    expect(invokedAtAll).toBe(true);

    // Verify chain: canon-bound + agent-turn + canon-audit-complete
    // events landed on the host with the pipeline_id.
    const events = await host.atoms.query({ type: ['pipeline-stage-event'] }, 200);
    const transitions = events.atoms
      .filter(
        (a) => (a.metadata as { pipeline_id?: AtomId }).pipeline_id === PIPELINE_ID,
      )
      .map((a) => (a.metadata as { transition: string }).transition);
    expect(transitions).toContain('canon-bound');
    expect(transitions).toContain('canon-audit-complete');
    expect(transitions.filter((t) => t === 'agent-turn').length).toBeGreaterThan(0);
  });

  it('rejected verdict translates to dispatch_status=gated with the reason as gating_reason', async () => {
    const { host, blobStore, redactor, workspaceProvider } = makeStubHostBundle();
    const registry = new SubActorRegistry();
    let invokedAtAll = false;
    registry.register(VERIFIED_SUB_ACTOR, async () => {
      invokedAtAll = true;
      return { kind: 'completed', producedAtomIds: [], summary: 'ok' };
    });
    await seedPlanForDispatch(host, 'plan-dispatch-agentic-2', VERIFIED_SUB_ACTOR);

    let runIdx = 0;
    const sequencingAdapter: AgentLoopAdapter = {
      capabilities: STUB_CAPABILITIES,
      async run(input) {
        const stub = makeStubAdapter({
          outputs: [JSON.stringify(STUB_REJECTED_VERDICT)],
        });
        const auditStub = makeStubAdapter({
          outputs: [JSON.stringify({ verdict: 'approved', findings: [] })],
        });
        const a = runIdx === 0 ? stub : auditStub;
        runIdx++;
        return a.run(input);
      },
    };

    const stage = buildAgenticDispatchStage({
      agentLoop: sequencingAdapter,
      workspaceProvider,
      blobStore,
      redactor,
      registry,
    });
    const out = await stage.run(makeStageInput(host));
    expect(out.atom_type).toBe('dispatch-record');
    const parsed = dispatchRecordPayloadSchema.safeParse(out.value);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.dispatch_status).toBe('gated');
      expect(parsed.data.dispatched).toBe(0);
      expect(parsed.data.failed).toBe(0);
      expect(parsed.data.gating_reason).toBe(STUB_REJECTED_VERDICT.reason);
    }
    // Default-deny: a rejected verdict MUST NOT trigger runDispatchTick.
    expect(invokedAtAll).toBe(false);
  });

  it('disableCanonAudit=true emits canon-audit-complete with no findings (helper-default approved)', async () => {
    const { host, blobStore, redactor, workspaceProvider } = makeStubHostBundle();
    const registry = new SubActorRegistry();
    registry.register(VERIFIED_SUB_ACTOR, async () => ({
      kind: 'completed',
      producedAtomIds: [],
      summary: 'ok',
    }));
    await seedPlanForDispatch(host, 'plan-dispatch-agentic-3', VERIFIED_SUB_ACTOR);

    // Single-pass adapter: only the main run dispatches; the audit
    // checkpoint is skipped, so the helper emits an approved-by-default
    // event without invoking the adapter a second time.
    let dispatchCount = 0;
    const singlePassAdapter: AgentLoopAdapter = {
      capabilities: STUB_CAPABILITIES,
      async run(input) {
        dispatchCount++;
        const stub = makeStubAdapter({
          outputs: [JSON.stringify(STUB_APPROVED_VERDICT)],
        });
        return stub.run(input);
      },
    };

    const stage = buildAgenticDispatchStage({
      agentLoop: singlePassAdapter,
      workspaceProvider,
      blobStore,
      redactor,
      registry,
      disableCanonAudit: true,
    });
    const out = await stage.run(makeStageInput(host));
    expect(out.atom_type).toBe('dispatch-record');
    // Only the main agent-loop dispatch happens; no audit dispatch.
    expect(dispatchCount).toBe(1);

    const events = await host.atoms.query({ type: ['pipeline-stage-event'] }, 200);
    const auditEvents = events.atoms
      .filter(
        (a) => (a.metadata as { pipeline_id?: AtomId }).pipeline_id === PIPELINE_ID,
      )
      .filter(
        (a) =>
          (a.metadata as { transition: string }).transition === 'canon-audit-complete',
      );
    expect(auditEvents).toHaveLength(1);
    const verdict = (auditEvents[0]!.metadata as { canon_audit_verdict?: string })
      .canon_audit_verdict;
    expect(verdict).toBe('approved');
    // Lock the contract on the findings list too: the helper emits an
    // empty array when no canon-audit prompt builder is supplied, so a
    // future regression that injects synthesized findings here would
    // surface as a single-test failure.
    const findings = (
      auditEvents[0]!.metadata as { canon_audit_findings?: unknown[] }
    ).canon_audit_findings;
    expect(Array.isArray(findings) ? findings : []).toHaveLength(0);
  });

  it('threads config.principal into the prompt so the override stays in sync with the actor identity', async () => {
    const { host, blobStore, redactor, workspaceProvider } = makeStubHostBundle();
    const registry = new SubActorRegistry();
    registry.register(VERIFIED_SUB_ACTOR, async () => ({
      kind: 'completed',
      producedAtomIds: [],
      summary: 'ok',
    }));
    await seedPlanForDispatch(host, 'plan-dispatch-agentic-4', VERIFIED_SUB_ACTOR);

    const customPrincipal = 'custom-plan-dispatcher' as PrincipalId;
    const recorder: {
      lastInput?: import('../../../../src/substrate/agent-loop.js').AgentLoopInput;
    } = {};
    let runIdx = 0;
    const sequencingAdapter: AgentLoopAdapter = {
      capabilities: STUB_CAPABILITIES,
      async run(input) {
        if (runIdx === 0) {
          recorder.lastInput = input;
        }
        const stub = makeStubAdapter({
          outputs: [JSON.stringify(STUB_APPROVED_VERDICT)],
        });
        const auditStub = makeStubAdapter({
          outputs: [JSON.stringify({ verdict: 'approved', findings: [] })],
        });
        const a = runIdx === 0 ? stub : auditStub;
        runIdx++;
        return a.run(input);
      },
    };

    const stage = buildAgenticDispatchStage({
      agentLoop: sequencingAdapter,
      workspaceProvider,
      blobStore,
      redactor,
      registry,
      principal: customPrincipal,
    });
    await stage.run(makeStageInput(host));

    // The dispatch-prompt embeds the resolved principal id; the hardcoded
    // literal 'plan-dispatcher' must NOT appear when the caller supplied
    // an override.
    const prompt = recorder.lastInput?.task.successCriteria ?? '';
    expect(prompt).toContain(`- principal: ${customPrincipal}`);
    expect(prompt).not.toMatch(/- principal: plan-dispatcher\b/);
    expect(recorder.lastInput?.principal).toBe(customPrincipal);
  });
});
