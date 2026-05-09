// Shared policy-spec factory for bootstrap-pipeline-reaper-canon.mjs.
//
// Extracted into a lib module (no shebang, no top-level side effects)
// so drift tests in test/scripts can import the POLICIES payload and
// assert it matches runtime fallbacks (DEFAULT_PIPELINE_REAPER_TTLS in
// src/runtime/plans/pipeline-reaper.ts) without spawning Node.
//
// The bootstrap script at scripts/bootstrap-pipeline-reaper-canon.mjs
// imports buildPolicies + policyAtom from here; the script remains the
// CLI entry point and owns env/host side effects. Mirrors the
// scripts/lib/reaper-canon-policies.mjs convention.

const BOOTSTRAP_TIME = '2026-05-09T00:00:00.000Z';

/**
 * Build the pipeline-reaper-canon POLICIES spec list. Parameterized on
 * the operator principal id (signs the seed atom) but otherwise pure.
 *
 * Currently a single-atom set: `pol-pipeline-reaper-ttls-default`. The
 * atom id carries the `-default` suffix so an org-ceiling deployment
 * can land a higher-priority `pol-pipeline-reaper-ttls-<scope>` atom
 * (e.g. `pol-pipeline-reaper-ttls-tight` for tighter retention) without
 * superseding the default; arbitration's source-rank formula
 * (Layer x Provenance x depth x confidence) resolves the higher-
 * priority atom first.
 *
 * Defaults match `DEFAULT_PIPELINE_REAPER_TTLS` in
 * src/runtime/plans/pipeline-reaper.ts so an existing deployment that
 * runs this script for the first time observes IDENTICAL behavior to
 * its pre-canon-policy run. The drift test at
 * test/scripts/bootstrap-pipeline-reaper-canon.test.ts locks the two
 * together.
 */
export function buildPolicies(_operatorId) {
  return [
    {
      id: 'pol-pipeline-reaper-ttls-default',
      subject: 'pipeline-reaper-ttls',
      reason:
        'Default per-atom-class TTLs for the pipeline subgraph reaper, in milliseconds. '
        + 'Promotes the env-var + CLI-flag knobs (LAG_PIPELINE_REAPER_TERMINAL_MS, '
        + '--pipeline-reaper-terminal-ms, etc.) to a canon policy atom per '
        + 'dev-substrate-not-prescription so an org-ceiling deployment can tune retention at '
        + 'scope boundaries via a higher-priority pol-pipeline-reaper-ttls-<scope> atom rather '
        + 'than a framework release. Resolution order in runPipelineReaperSweep: canon > env > '
        + 'defaults; a malformed canon payload logs a stderr warning and falls through. '
        + 'Defaults (30d terminal / 14d hil-paused / 30d standalone-agent-session) match '
        + 'DEFAULT_PIPELINE_REAPER_TTLS in src/runtime/plans/pipeline-reaper.ts so an '
        + 'existing deployment running this seed for the first time observes identical '
        + 'behavior. Tightening retention (e.g. 14d / 7d / 14d) is an org-side canon edit '
        + 'that lands as a higher-priority pol-pipeline-reaper-ttls-<scope> atom; arbitration '
        + 'resolves it via the existing source-rank formula.',
      fields: {
        // 30d: matches DEFAULT_PIPELINE_REAPER_TTLS.terminalPipelineMs.
        // A pipeline run that completed or failed a month ago is
        // unlikely to be re-investigated; the audit chain is preserved
        // via the leaf metadata write (atoms are not deleted) and the
        // Console projection hides reaped atoms by default.
        terminal_pipeline_ms: 30 * 24 * 60 * 60 * 1000,
        // 14d: matches DEFAULT_PIPELINE_REAPER_TTLS.hilPausedPipelineMs.
        // Half the terminal TTL: a pipeline paused for HIL review that
        // has not resumed in two weeks is effectively abandoned. The
        // shorter window biases the substrate toward forgetting paused
        // runs sooner so the pipeline-list view does not accumulate
        // stale checkpoints.
        hil_paused_pipeline_ms: 14 * 24 * 60 * 60 * 1000,
        // 30d: matches DEFAULT_PIPELINE_REAPER_TTLS.agentSessionMs.
        // Standalone agent-session atoms (PrFix sessions, future
        // agentic adapters not bundled into a pipeline) reap on this
        // independent TTL.
        agent_session_ms: 30 * 24 * 60 * 60 * 1000,
      },
    },
  ];
}

/**
 * Build the L3 directive atom that the bootstrap script writes. Shape
 * mirrors policyAtom in scripts/lib/reaper-canon-policies.mjs so the
 * file-host round-trip and drift-check are identical across the two
 * bootstraps.
 */
export function policyAtom(spec, operatorId) {
  return {
    schema_version: 1,
    id: spec.id,
    content: spec.reason,
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'bootstrap-pipeline-reaper', agent_id: 'bootstrap' },
      derived_from: [],
    },
    confidence: 1.0,
    created_at: BOOTSTRAP_TIME,
    last_reinforced_at: BOOTSTRAP_TIME,
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
    principal_id: operatorId,
    taint: 'clean',
    metadata: {
      policy: {
        subject: spec.subject,
        reason: spec.reason,
        ...spec.fields,
      },
    },
  };
}
