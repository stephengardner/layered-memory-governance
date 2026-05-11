// Shared policy-spec factory for bootstrap-loop-pass-claim-reaper-canon.mjs.
//
// Extracted into a lib module (no shebang, no top-level side effects)
// so drift tests in test/scripts can import the POLICIES payload and
// assert it matches the runtime reader (readLoopPassClaimReaperFromCanon
// in src/runtime/loop/loop-pass-claim-reaper.ts) without spawning Node.
//
// The bootstrap script at scripts/bootstrap-loop-pass-claim-reaper-canon.mjs
// imports buildPolicies + policyAtom from here; the script remains the
// CLI entry point and owns env/host side effects. Mirrors the convention
// established by scripts/lib/pipeline-reaper-canon-policies.mjs and
// scripts/lib/inbox-canon-policies.mjs.
//
// The single policy atom seeded here gates the LoopRunner's
// claim-reaper pass (the wiring PR for the zero-failure sub-agent
// substrate, spec section 13). Default enabled=false per the indie-
// floor opt-in posture; an org-ceiling deployment that wants the
// claim-reaper sweep on every loop tick lands a higher-priority
// pol-loop-pass-claim-reaper-default atom with enabled=true via a
// deliberate canon edit, not a global toggle.

const BOOTSTRAP_TIME = '2026-05-11T00:00:00.000Z';

/**
 * Build the loop-pass-claim-reaper POLICIES spec list. Parameterized
 * on the operator principal id (signs the seed atom) but otherwise
 * pure.
 *
 * Currently a single-atom set: `pol-loop-pass-claim-reaper-default`.
 * The atom id carries the `-default` suffix so an org-ceiling
 * deployment can land a higher-priority
 * pol-loop-pass-claim-reaper-<scope> atom (e.g.
 * pol-loop-pass-claim-reaper-tight for an org that wants the sweep
 * on by default) without superseding the default; arbitration's
 * source-rank formula resolves the higher-priority atom first.
 *
 * Default matches the LoopRunner's hardcoded `false` floor so an
 * existing deployment that runs this seed for the first time
 * observes IDENTICAL behavior to its pre-canon-policy run. Flipping
 * the dial to `true` is a deliberate canon edit; a follow-up PR can
 * add a `pol-loop-pass-claim-reaper-org-ceiling` atom with
 * enabled=true that the substrate documents as the recommended
 * higher-priority shape for orgs that run multiple concurrent
 * claim-bearing actors.
 */
export function buildPolicies(_operatorId) {
  return [
    {
      id: 'pol-loop-pass-claim-reaper-default',
      subject: 'loop-pass-claim-reaper-default',
      reason:
        'Whether the autonomous loop runs the claim-reaper pass on every tick. '
        + 'The pass detects stalled work-claim atoms (Phase A) and drives them through '
        + 'the bounded recovery ladder (Phase B) per the zero-failure-sub-agent-substrate '
        + 'spec Section 13. Default enabled=false per dev-indie-floor-org-ceiling: a solo '
        + 'developer running LAG does not surprise-pay the claim-reaper read pressure on '
        + 'every tick when the substrate has no in-flight work-claim atoms. An org-ceiling '
        + 'deployment that runs multiple concurrent claim-bearing actors lands a higher-'
        + 'priority pol-loop-pass-claim-reaper-<scope> atom with enabled=true (or sets the '
        + 'CLI option / env var) so the reaper sweep fires on every tick. The reaper module '
        + 'has its own STOP-sentinel gate inside runClaimReaperTick so a .lag/STOP arming '
        + 'mid-tick produces halted=true rather than partial work.',
      fields: {
        // Indie-floor default. The CLI option / env override wins when
        // explicitly set; this value is consulted by the canon reader
        // when no override resolves. Flipping to true on a deployment
        // that wants the reaper on every tick is a one-line edit to a
        // higher-priority atom, not a framework release.
        enabled: false,
      },
    },
  ];
}

/**
 * Build the L3 directive atom that the bootstrap script writes. Shape
 * mirrors policyAtom in scripts/lib/pipeline-reaper-canon-policies.mjs
 * so the file-host round-trip and drift-check are identical across
 * the canon bootstraps.
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
      source: { session_id: 'bootstrap-loop-pass-claim-reaper', agent_id: 'bootstrap' },
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
