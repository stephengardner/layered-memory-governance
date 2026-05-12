// Shared policy-spec factory for bootstrap-plan-stage-validator-retry-canon.mjs.
//
// Extracted into a lib module (no shebang, no top-level side effects)
// so drift tests in test/scripts can import the POLICIES payload and
// assert it matches the runtime reader
// (readPlanStageValidatorRetryPolicy in
// src/runtime/planning-pipeline/plan-stage-validator-retry-config.ts)
// without spawning Node.
//
// The bootstrap script at
// scripts/bootstrap-plan-stage-validator-retry-canon.mjs imports
// buildPolicies + policyAtom from here; the script remains the CLI
// entry point and owns env/host side effects. Mirrors the convention
// established by scripts/lib/auditor-feedback-reprompt-canon-policies.mjs
// (PR #397) so the two retry-loop canon bootstraps share one shape.
//
// The single policy atom seeded here gates the planning-pipeline
// runner's plan-stage validator-retry loop. Default max_attempts=2,
// recoverable_error_patterns=['schema-validation-failed'] per the
// indie-floor floor: a solo developer's typo-fix pipeline that hits a
// recoverable schema-validation failure gets exactly one chance to
// self-correct before the pipeline halts; the schema-validator stays
// the gate and the loop is the teaching seam. An org-ceiling
// deployment that wants finer control (retry only on specific Zod
// error paths) lands a higher-priority
// pol-plan-stage-validator-retry-<scope> atom via a deliberate canon
// edit, not a global toggle.

const BOOTSTRAP_TIME = '2026-05-12T00:00:00.000Z';

/**
 * Build the plan-stage-validator-retry POLICIES spec list. Parameterized
 * on the operator principal id (signs the seed atom) but otherwise
 * pure.
 *
 * Currently a single-atom set:
 * `pol-plan-stage-validator-retry-default`. The atom id carries the
 * `-default` suffix so an org-ceiling deployment can land a
 * higher-priority pol-plan-stage-validator-retry-<scope> atom (e.g.
 * pol-plan-stage-validator-retry-strict with max_attempts=3 +
 * recoverable_error_patterns=['target_paths', 'principles_applied'])
 * without superseding the default; arbitration's source-rank formula
 * resolves the higher-priority atom first.
 *
 * Default matches the runner's hardcoded floor
 * (HARDCODED_DEFAULT in plan-stage-validator-retry-config.ts) so an
 * existing deployment that runs this seed for the first time observes
 * IDENTICAL behavior to its pre-canon-policy run. Tightening the dial
 * to a smaller max_attempts (or narrowing recoverable_error_patterns)
 * is a deliberate canon edit; the substrate documents the recommended
 * higher-priority shape for orgs that run multiple concurrent stages.
 */
export function buildPolicies(_operatorId) {
  return [
    {
      id: 'pol-plan-stage-validator-retry-default',
      subject: 'plan-stage-validator-retry-default',
      reason:
        'Plan-stage validator-retry loop config for the deep planning pipeline. '
        + 'When a stage`s outputSchema.safeParse rejects with an error message that '
        + 'contains one of recoverable_error_patterns, the runner re-invokes the same '
        + 'stage with the validator error folded into the next attempt`s prompt '
        + 'context, bounded at max_attempts total. Default max_attempts=2, '
        + 'recoverable_error_patterns=[`schema-validation-failed`] per the '
        + 'indie-floor + org-ceiling discipline: a solo developer running a '
        + 'typo-fix pipeline gets exactly one chance to self-correct on a '
        + 'recoverable schema-validation failure before the pipeline halts; '
        + 'the schema-validator stays the gate and the loop is the teaching '
        + 'seam (mirrors #293 auditor-feedback-reprompt). An org-ceiling '
        + 'deployment that wants finer control (retry only on specific Zod '
        + 'error paths like `target_paths` or `principles_applied`) lands a '
        + 'higher-priority pol-plan-stage-validator-retry-<scope> atom via a '
        + 'deliberate canon edit. Empty recoverable_error_patterns disables '
        + 'the loop entirely while keeping the policy atom present (explicit '
        + 'disable shape).',
      fields: {
        // Indie-floor default. max_attempts=2 means attempt 1 + 1 retry
        // (attempt 2). The runner's pure decision helper enforces this
        // cap mechanically; an oversize value flips no other dial.
        max_attempts: 2,
        // Default-allowlist matches the runner's wholesale category
        // prefix ('schema-validation-failed: ${zod.error.message}'),
        // making every current zod failure recoverable. Org-ceiling
        // deployments narrow this to specific Zod error-path
        // substrings (e.g. ['target_paths', 'plans[']) so only the
        // well-known LLM-recoverable shapes retry while novel error
        // classes halt immediately. Empty list disables the loop.
        recoverable_error_patterns: ['schema-validation-failed'],
      },
    },
  ];
}

/**
 * Build the L3 directive atom that the bootstrap script writes. Shape
 * mirrors policyAtom in
 * scripts/lib/auditor-feedback-reprompt-canon-policies.mjs so the
 * file-host round-trip and drift-check are identical across the canon
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
      source: { session_id: 'bootstrap-plan-stage-validator-retry', agent_id: 'bootstrap' },
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
