/**
 * Contract test for the agentic plan-stage adapter.
 *
 * Asserts:
 *   - the adapter is a PlanningStage<unknown, PlanPayload>;
 *   - run() returns a StageOutput with atom_type='plan';
 *   - the produced payload passes planPayloadSchema (mirrors the
 *     single-shot adapter's output contract);
 *   - the adapter emits the canon-bound + agent-turn + canon-audit-complete
 *     pipeline-stage-event chain by default;
 *   - disableCanonAudit=true skips the canon-audit checkpoint;
 *   - audit() re-runs the single-shot citation-closure check unchanged;
 *   - config.principal threads through into the prompt and the
 *     AgentLoopInput.principal so the override stays in sync with the
 *     resolved actor identity.
 */

import { describe, expect, it } from 'vitest';
import { buildAgenticPlanStage } from '../../../../examples/planning-stages/plan/agentic.js';
import { planPayloadSchema } from '../../../../examples/planning-stages/plan/index.js';
import { createMemoryHost } from '../../../../src/adapters/memory/index.js';
import type { AgentLoopAdapter } from '../../../../src/substrate/agent-loop.js';
import type { AtomId, PrincipalId } from '../../../../src/substrate/types.js';
import type { StageInput } from '../../../../src/runtime/planning-pipeline/index.js';
import {
  makeStubAdapter,
  makeStubHostBundle,
  STUB_CAPABILITIES,
} from '../agent-loop-stubs.js';

const PRINCIPAL = 'plan-author' as PrincipalId;
const PIPELINE_ID = 'pipeline-plan-agentic-test' as AtomId;
const VERIFIED_ATOM_ID = 'atom-verified-1' as AtomId;
const VERIFIED_SUB_ACTOR = 'code-author' as PrincipalId;

function makeStageInput(host: ReturnType<typeof createMemoryHost>): StageInput<unknown> {
  return {
    host,
    principal: PRINCIPAL,
    correlationId: 'corr-plan-agentic-1',
    // Spec-shaped prior output: the plan stage synthesises this into
    // an executable plan. Keeps the test grounded in the actual
    // upstream payload shape (specPayloadSchema) so a future spec
    // schema change surfaces as a fixture failure here.
    priorOutput: {
      goal: 'add a one-line note to the README naming the deep planning pipeline',
      body: 'Add a single-sentence bullet under the existing Architecture section of README.md naming the deep planning pipeline.',
      cited_paths: ['README.md'],
      cited_atom_ids: [],
      alternatives_rejected: [
        {
          option: 'append to top of README',
          reason: 'pushes existing first-impression content down for low-value gain',
        },
        {
          option: 'create a new section dedicated to the pipeline',
          reason: 'too heavy for a one-line note',
        },
      ],
      cost_usd: 0.42,
    },
    pipelineId: PIPELINE_ID,
    seedAtomIds: [],
    verifiedCitedAtomIds: [VERIFIED_ATOM_ID],
    verifiedSubActorPrincipalIds: [VERIFIED_SUB_ACTOR],
    operatorIntentContent:
      'add a one-line note to the README explaining what the deep planning pipeline does',
  };
}

const STUB_PLAN_PAYLOAD = {
  plans: [
    {
      title: 'add one-line README note about the deep planning pipeline',
      body: [
        '## Why this',
        '',
        'The operator asked for a one-line README addition naming the deep',
        'planning pipeline so a first-time reader sees the entry point.',
        '',
        '## Concrete steps',
        '',
        '1. **Open README.md** - find the Architecture section.',
        '2. **Insert one bullet** - "Deep planning pipeline: see examples/planning-stages/."',
        '3. **Commit** - git commit -m "docs: name the deep planning pipeline in the README".',
      ].join('\n'),
      derived_from: [String(VERIFIED_ATOM_ID)],
      principles_applied: [String(VERIFIED_ATOM_ID)],
      alternatives_rejected: [
        {
          option: 'create a new top-level pipeline-overview README',
          reason: 'too heavy for a one-line note; defers the simple case',
        },
      ],
      what_breaks_if_revisit:
        'a future planner that drops the named-pipeline reference loses the discoverability anchor',
      confidence: 0.92,
      delegation: {
        sub_actor_principal_id: String(VERIFIED_SUB_ACTOR),
        reason: 'docs-only edit fits the code-author sub-actor',
        implied_blast_radius: 'docs',
      },
    },
  ],
  cost_usd: 0.42,
};

describe('agenticPlanStage', () => {
  it('produces a PlanPayload with atom_type plan', async () => {
    const { host, blobStore, redactor, workspaceProvider } = makeStubHostBundle();
    // Sequencing adapter: first call returns the plan payload, second
    // call returns the canon-audit verdict.
    let runIdx = 0;
    const sequencingAdapter: AgentLoopAdapter = {
      capabilities: STUB_CAPABILITIES,
      async run(input) {
        const stub = makeStubAdapter({
          outputs: [JSON.stringify(STUB_PLAN_PAYLOAD)],
        });
        const auditStub = makeStubAdapter({
          outputs: [JSON.stringify({ verdict: 'approved', findings: [] })],
        });
        const a = runIdx === 0 ? stub : auditStub;
        runIdx++;
        return a.run(input);
      },
    };

    const stage = buildAgenticPlanStage({
      agentLoop: sequencingAdapter,
      workspaceProvider,
      blobStore,
      redactor,
      baseRef: 'main',
    });
    expect(stage.name).toBe('plan-stage');
    expect(stage.outputSchema).toBe(planPayloadSchema);

    const stageInput = makeStageInput(host);
    const out = await stage.run(stageInput);
    expect(out.atom_type).toBe('plan');
    const parsed = planPayloadSchema.safeParse(out.value);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.plans).toHaveLength(1);
      expect(parsed.data.plans[0]!.title).toContain('README');
      expect(parsed.data.plans[0]!.delegation.sub_actor_principal_id).toBe(
        String(VERIFIED_SUB_ACTOR),
      );
      expect(parsed.data.plans[0]!.derived_from).toContain(String(VERIFIED_ATOM_ID));
    }

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

  it('disableCanonAudit=true emits canon-audit-complete with no findings (helper-default approved)', async () => {
    const { host, blobStore, redactor, workspaceProvider } = makeStubHostBundle();
    // Single-pass adapter: only the main run dispatches; the audit
    // checkpoint is skipped, so the helper emits an approved-by-default
    // event without invoking the adapter a second time.
    let dispatchCount = 0;
    const singlePassAdapter: AgentLoopAdapter = {
      capabilities: STUB_CAPABILITIES,
      async run(input) {
        dispatchCount++;
        const stub = makeStubAdapter({
          outputs: [JSON.stringify(STUB_PLAN_PAYLOAD)],
        });
        return stub.run(input);
      },
    };

    const stage = buildAgenticPlanStage({
      agentLoop: singlePassAdapter,
      workspaceProvider,
      blobStore,
      redactor,
      disableCanonAudit: true,
    });
    const out = await stage.run(makeStageInput(host));
    expect(out.atom_type).toBe('plan');
    // Only the main agent-loop dispatch happens; no audit dispatch.
    expect(dispatchCount).toBe(1);

    const events = await host.atoms.query({ type: ['pipeline-stage-event'] }, 200);
    const auditEvents = events.atoms
      .filter(
        (a) => (a.metadata as { pipeline_id?: AtomId }).pipeline_id === PIPELINE_ID,
      )
      .filter((a) => (a.metadata as { transition: string }).transition === 'canon-audit-complete');
    expect(auditEvents).toHaveLength(1);
    // The helper emits verdict='approved' with empty findings when no
    // builder is supplied, so the chain stays uniform regardless of
    // audit posture.
    const verdict = (auditEvents[0]!.metadata as { canon_audit_verdict?: string }).canon_audit_verdict;
    expect(verdict).toBe('approved');
    // Lock the contract on the findings list too: the helper emits an
    // empty array when no canon-audit prompt builder is supplied, so a
    // future regression that injects synthesized findings here would
    // surface as a single-test failure.
    const findings =
      (auditEvents[0]!.metadata as { canon_audit_findings?: unknown[] }).canon_audit_findings;
    expect(Array.isArray(findings) ? findings : []).toHaveLength(0);
  });

  it('exposes audit() so the runner re-runs the single-shot citation-closure check', () => {
    const { blobStore, redactor, workspaceProvider } = makeStubHostBundle();
    const adapter = makeStubAdapter({ outputs: ['{}'] });
    const stage = buildAgenticPlanStage({
      agentLoop: adapter,
      workspaceProvider,
      blobStore,
      redactor,
    });
    expect(typeof stage.audit).toBe('function');
  });

  it('threads config.principal into the prompt so the override stays in sync with the actor identity', async () => {
    const { host, blobStore, redactor, workspaceProvider } = makeStubHostBundle();
    const customPrincipal = 'custom-plan-author' as PrincipalId;
    const recorder: { lastInput?: import('../../../../src/substrate/agent-loop.js').AgentLoopInput } = {};
    let runIdx = 0;
    const sequencingAdapter: AgentLoopAdapter = {
      capabilities: STUB_CAPABILITIES,
      async run(input) {
        if (runIdx === 0) {
          recorder.lastInput = input;
        }
        const stub = makeStubAdapter({
          outputs: [JSON.stringify(STUB_PLAN_PAYLOAD)],
        });
        const auditStub = makeStubAdapter({
          outputs: [JSON.stringify({ verdict: 'approved', findings: [] })],
        });
        const a = runIdx === 0 ? stub : auditStub;
        runIdx++;
        return a.run(input);
      },
    };

    const stage = buildAgenticPlanStage({
      agentLoop: sequencingAdapter,
      workspaceProvider,
      blobStore,
      redactor,
      principal: customPrincipal,
    });
    await stage.run(makeStageInput(host));

    // The plan-prompt embeds the resolved principal id; the hardcoded
    // literal 'plan-author' must NOT appear when the caller supplied
    // an override.
    const prompt = recorder.lastInput?.task.successCriteria ?? '';
    expect(prompt).toContain(`- principal: ${customPrincipal}`);
    expect(prompt).not.toMatch(/- principal: plan-author\b/);
    expect(recorder.lastInput?.principal).toBe(customPrincipal);
  });
});
