/**
 * Contract test for the agentic review-stage adapter.
 *
 * Asserts:
 *   - the adapter is a PlanningStage<unknown, ReviewReportPayload>;
 *   - run() returns a StageOutput with atom_type='review-report';
 *   - the produced payload passes reviewReportPayloadSchema (mirrors
 *     the single-shot adapter's output contract);
 *   - the adapter emits the canon-bound + agent-turn + canon-audit-complete
 *     pipeline-stage-event chain by default (with disableCanonAudit
 *     defaulting to true for the review stage, the canon-audit-complete
 *     event still emits with verdict='approved' + empty findings);
 *   - opting INTO the canon-audit checkpoint via disableCanonAudit=false
 *     dispatches a second agent-loop run for the meta-audit;
 *   - audit() re-runs the single-shot citation-closure check unchanged.
 *
 * The review-stage's disableCanonAudit defaults to true (the inverse
 * of the other stages) because the review-stage IS the auditor; running
 * a canon-audit on top of the audit run is a redundant pass over the
 * same evidence chain. Tests lock the contract on this default so a
 * future regression that flips the default surfaces as a single-test
 * failure rather than silently doubling per-stage cost.
 */

import { describe, expect, it } from 'vitest';
import { buildAgenticReviewStage } from '../../../../examples/planning-stages/review/agentic.js';
import { reviewReportPayloadSchema } from '../../../../examples/planning-stages/review/index.js';
import { createMemoryHost } from '../../../../src/adapters/memory/index.js';
import type { AgentLoopAdapter } from '../../../../src/substrate/agent-loop.js';
import type { AtomId, PrincipalId } from '../../../../src/substrate/types.js';
import type { StageInput } from '../../../../src/runtime/planning-pipeline/index.js';
import {
  STUB_CAPABILITIES,
  makeStubAdapter,
  makeStubHostBundle,
} from '../agent-loop-stubs.js';

const PRINCIPAL = 'pipeline-auditor' as PrincipalId;
const PIPELINE_ID = 'pipeline-review-agentic-test' as AtomId;

function makeStageInput(host: ReturnType<typeof createMemoryHost>): StageInput<unknown> {
  return {
    host,
    principal: PRINCIPAL,
    correlationId: 'corr-review-agentic-1',
    // Upstream plan-stage output the review audits. A simple plan with
    // no fabricated atom-ids; the stub LLM emits a clean audit.
    priorOutput: {
      plans: [
        {
          title: 'add a one-line note to the README naming the deep planning pipeline',
          body: 'Add a single bullet under the existing Architecture section.',
          derived_from: [],
          principles_applied: [],
          alternatives_rejected: [
            {
              option: 'append at the top',
              reason: 'pushes existing first-impression content down',
            },
          ],
          what_breaks_if_revisit: 'README structure changes invalidate the bullet placement',
          confidence: 0.9,
          delegation: {
            sub_actor_principal_id: 'code-author',
            reason: 'docs-only one-line edit within scope',
            implied_blast_radius: 'framework' as const,
          },
        },
      ],
      cost_usd: 0.42,
    },
    pipelineId: PIPELINE_ID,
    seedAtomIds: [],
    verifiedCitedAtomIds: [],
    verifiedSubActorPrincipalIds: [],
    operatorIntentContent:
      'add a one-line note to the README explaining what the deep planning pipeline does',
    priorAuditFindings: [],
    priorValidatorError: '',
  };
}

const STUB_REVIEW_PAYLOAD = {
  audit_status: 'clean' as const,
  findings: [],
  total_bytes_read: 0,
  cost_usd: 0.05,
};

describe('agenticReviewStage', () => {
  it('produces a ReviewReportPayload with atom_type review-report', async () => {
    const { host, blobStore, redactor, workspaceProvider } = makeStubHostBundle();
    // Single-pass adapter: only the main run dispatches because
    // disableCanonAudit defaults to true for the review stage.
    let dispatchCount = 0;
    const singlePassAdapter: AgentLoopAdapter = {
      capabilities: STUB_CAPABILITIES,
      async run(input) {
        dispatchCount++;
        const stub = makeStubAdapter({
          outputs: [JSON.stringify(STUB_REVIEW_PAYLOAD)],
        });
        return stub.run(input);
      },
    };

    const stage = buildAgenticReviewStage({
      agentLoop: singlePassAdapter,
      workspaceProvider,
      blobStore,
      redactor,
      baseRef: 'main',
    });
    expect(stage.name).toBe('review-stage');
    expect(stage.outputSchema).toBe(reviewReportPayloadSchema);

    const stageInput = makeStageInput(host);
    const out = await stage.run(stageInput);
    expect(out.atom_type).toBe('review-report');
    const parsed = reviewReportPayloadSchema.safeParse(out.value);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.audit_status).toBe('clean');
      expect(parsed.data.findings).toHaveLength(0);
    }

    // Verify chain: canon-bound + agent-turn + canon-audit-complete
    // events landed on the host with the pipeline_id. The canon-audit
    // event emits with verdict='approved' even though disableCanonAudit
    // defaults to true; the helper emits the no-audit fallback so the
    // chain shape stays uniform.
    const events = await host.atoms.query({ type: ['pipeline-stage-event'] }, 200);
    const transitions = events.atoms
      .filter(
        (a) => (a.metadata as { pipeline_id?: AtomId }).pipeline_id === PIPELINE_ID,
      )
      .map((a) => (a.metadata as { transition: string }).transition);
    expect(transitions).toContain('canon-bound');
    expect(transitions).toContain('canon-audit-complete');
    expect(transitions.filter((t) => t === 'agent-turn').length).toBeGreaterThan(0);

    // Default skip path: only the main agent-loop dispatch happens; no
    // canon-audit dispatch. This locks the disableCanonAudit=true default
    // for the review stage; a future regression that re-enables the
    // default would surface as dispatchCount=2 here.
    expect(dispatchCount).toBe(1);
    const auditEvents = events.atoms
      .filter(
        (a) => (a.metadata as { pipeline_id?: AtomId }).pipeline_id === PIPELINE_ID,
      )
      .filter((a) => (a.metadata as { transition: string }).transition === 'canon-audit-complete');
    expect(auditEvents).toHaveLength(1);
    const verdict = (auditEvents[0]!.metadata as { canon_audit_verdict?: string }).canon_audit_verdict;
    expect(verdict).toBe('approved');
    const findings =
      (auditEvents[0]!.metadata as { canon_audit_findings?: unknown[] }).canon_audit_findings;
    expect(Array.isArray(findings) ? findings : []).toHaveLength(0);
  });

  it('disableCanonAudit=false dispatches the meta-audit run', async () => {
    const { host, blobStore, redactor, workspaceProvider } = makeStubHostBundle();
    // Sequencing adapter: first call returns the review payload, second
    // call returns the canon-audit verdict. Tests the opt-IN path where
    // a deployment wants the redundant defense-in-depth pass.
    let runIdx = 0;
    const sequencingAdapter: AgentLoopAdapter = {
      capabilities: STUB_CAPABILITIES,
      async run(input) {
        const stub = makeStubAdapter({
          outputs: [JSON.stringify(STUB_REVIEW_PAYLOAD)],
        });
        const auditStub = makeStubAdapter({
          outputs: [JSON.stringify({ verdict: 'approved', findings: [] })],
        });
        const a = runIdx === 0 ? stub : auditStub;
        runIdx++;
        return a.run(input);
      },
    };

    const stage = buildAgenticReviewStage({
      agentLoop: sequencingAdapter,
      workspaceProvider,
      blobStore,
      redactor,
      // Explicit opt-in: the review stage normally skips canon-audit
      // because IT is the auditor; this flag forces the redundant pass
      // for defense-in-depth deployments.
      disableCanonAudit: false,
    });
    const out = await stage.run(makeStageInput(host));
    expect(out.atom_type).toBe('review-report');
    // Both the main run and the canon-audit run dispatched, so the
    // sequencing adapter ran twice.
    expect(runIdx).toBe(2);

    const events = await host.atoms.query({ type: ['pipeline-stage-event'] }, 200);
    const auditEvents = events.atoms
      .filter(
        (a) => (a.metadata as { pipeline_id?: AtomId }).pipeline_id === PIPELINE_ID,
      )
      .filter((a) => (a.metadata as { transition: string }).transition === 'canon-audit-complete');
    expect(auditEvents).toHaveLength(1);
    const verdict = (auditEvents[0]!.metadata as { canon_audit_verdict?: string }).canon_audit_verdict;
    expect(verdict).toBe('approved');
  });

  it('audit() re-emits findings from the produced payload (load-bearing halt path)', async () => {
    const { host, blobStore, redactor, workspaceProvider } = makeStubHostBundle();
    const adapter = makeStubAdapter({ outputs: ['{}'] });
    const stage = buildAgenticReviewStage({
      agentLoop: adapter,
      workspaceProvider,
      blobStore,
      redactor,
    });
    expect(typeof stage.audit).toBe('function');
    // Feed audit() a literal payload with one critical finding; assert
    // the same finding is re-emitted unchanged. The agentic adapter's
    // load-bearing halt-on-critical path is the runner re-running this
    // hook on the produced payload; a no-op audit would let a critical
    // finding escape the runner's halt machinery.
    const payload = {
      audit_status: 'findings' as const,
      findings: [
        {
          severity: 'critical' as const,
          category: 'fabricated-cited-atom',
          message: 'cited atom-id "fake-atom-id" does not resolve',
          cited_atom_ids: ['fake-atom-id'],
          cited_paths: [],
        },
      ],
      total_bytes_read: 0,
      cost_usd: 0,
    };
    const ctx = {
      host,
      principal: PRINCIPAL,
      correlationId: 'corr-audit-test',
      pipelineId: PIPELINE_ID,
      stageName: 'review-stage',
      verifiedCitedAtomIds: [] as ReadonlyArray<AtomId>,
      verifiedSubActorPrincipalIds: [] as ReadonlyArray<PrincipalId>,
      operatorIntentContent: '',
    };
    const findings = await stage.audit!(payload, ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('critical');
    expect(findings[0]!.category).toBe('fabricated-cited-atom');
    expect(findings[0]!.message).toContain('fake-atom-id');
    expect(findings[0]!.cited_atom_ids).toEqual(['fake-atom-id']);
  });

  it('threads config.principal into the prompt so the override stays in sync with the actor identity', async () => {
    const { host, blobStore, redactor, workspaceProvider } = makeStubHostBundle();
    const customPrincipal = 'custom-pipeline-auditor' as PrincipalId;
    const recorder: { lastInput?: import('../../../../src/substrate/agent-loop.js').AgentLoopInput } = {};
    const recordingAdapter: AgentLoopAdapter = {
      capabilities: STUB_CAPABILITIES,
      async run(input) {
        recorder.lastInput = input;
        const stub = makeStubAdapter({
          outputs: [JSON.stringify(STUB_REVIEW_PAYLOAD)],
        });
        return stub.run(input);
      },
    };

    const stage = buildAgenticReviewStage({
      agentLoop: recordingAdapter,
      workspaceProvider,
      blobStore,
      redactor,
      principal: customPrincipal,
    });
    await stage.run(makeStageInput(host));

    // The review-prompt embeds the resolved principal id; the hardcoded
    // literal 'pipeline-auditor' must NOT appear when the caller supplied
    // an override.
    const prompt = recorder.lastInput?.task.successCriteria ?? '';
    expect(prompt).toContain(`- principal: ${customPrincipal}`);
    expect(prompt).not.toMatch(/- principal: pipeline-auditor\b/);
    expect(recorder.lastInput?.principal).toBe(customPrincipal);
  });
});
