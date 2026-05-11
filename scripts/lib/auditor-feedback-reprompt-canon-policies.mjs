// Shared policy-spec factory for bootstrap-auditor-feedback-reprompt-canon.mjs.
//
// Extracted into a lib module (no shebang, no top-level side effects)
// so drift tests in test/scripts can import the POLICIES payload and
// assert it matches the runtime reader (readAuditorFeedbackRePromptPolicy
// in src/runtime/planning-pipeline/auditor-feedback-reprompt-config.ts)
// without spawning Node.
//
// The bootstrap script at
// scripts/bootstrap-auditor-feedback-reprompt-canon.mjs imports
// buildPolicies + policyAtom from here; the script remains the CLI
// entry point and owns env/host side effects. Mirrors the convention
// established by scripts/lib/loop-pass-claim-reaper-canon-policies.mjs
// (PR #394) and scripts/lib/pipeline-reaper-canon-policies.mjs.
//
// The single policy atom seeded here gates the planning-pipeline
// runner's auditor-feedback re-prompt loop. Default
// max_attempts=2, severities_to_reprompt=['critical'] per the
// indie-floor floor: a solo developer's typo-fix prompt that hits a
// critical finding gets exactly one chance to self-correct before
// the pipeline halts; the auditor stays the gate and the loop is the
// teaching seam. An org-ceiling deployment that wants the loop to
// also re-prompt on 'major' findings lands a higher-priority
// pol-auditor-feedback-reprompt-<scope> atom via a deliberate canon
// edit, not a global toggle.

const BOOTSTRAP_TIME = '2026-05-11T00:00:00.000Z';

/**
 * Build the auditor-feedback-reprompt POLICIES spec list. Parameterized
 * on the operator principal id (signs the seed atom) but otherwise
 * pure.
 *
 * Currently a single-atom set:
 * `pol-auditor-feedback-reprompt-default`. The atom id carries the
 * `-default` suffix so an org-ceiling deployment can land a
 * higher-priority pol-auditor-feedback-reprompt-<scope> atom (e.g.
 * pol-auditor-feedback-reprompt-strict with max_attempts=3 +
 * severities=['critical', 'major']) without superseding the default;
 * arbitration's source-rank formula resolves the higher-priority atom
 * first.
 *
 * Default matches the runner's hardcoded floor
 * (HARDCODED_DEFAULT in auditor-feedback-reprompt-config.ts) so an
 * existing deployment that runs this seed for the first time observes
 * IDENTICAL behavior to its pre-canon-policy run. Tightening the dial
 * to a smaller max_attempts (or widening severities) is a deliberate
 * canon edit; the substrate documents the recommended higher-priority
 * shape for orgs that run multiple concurrent stages.
 */
export function buildPolicies(_operatorId) {
  return [
    {
      id: 'pol-auditor-feedback-reprompt-default',
      subject: 'auditor-feedback-reprompt-default',
      reason:
        'Auditor-feedback re-prompt loop config for the deep planning pipeline. '
        + 'When a stage`s audit() returns findings whose severity is in '
        + 'severities_to_reprompt, the runner re-invokes the same stage with '
        + 'the findings folded into the next attempt`s prompt context, '
        + 'bounded at max_attempts total. Default max_attempts=2, '
        + 'severities_to_reprompt=[`critical`] per the indie-floor + org-ceiling '
        + 'discipline: a solo developer running a typo-fix pipeline gets exactly one chance '
        + 'to self-correct on a critical finding before the pipeline halts; the '
        + 'auditor stays the gate and the loop is the teaching seam. An '
        + 'org-ceiling deployment that wants the loop to also re-prompt on '
        + '`major` findings (or extend max_attempts to 3+) lands a '
        + 'higher-priority pol-auditor-feedback-reprompt-<scope> atom via a '
        + 'deliberate canon edit. Empty severities_to_reprompt disables the '
        + 'loop entirely while keeping the policy atom present (explicit '
        + 'disable shape).',
      fields: {
        // Indie-floor default. max_attempts=2 means attempt 1 + 1 re-prompt
        // (attempt 2). The runner's pure decision helper enforces this cap
        // mechanically; an oversize value flips no other dial.
        max_attempts: 2,
        // Only critical findings trigger a re-prompt by default. 'major'
        // and 'minor' findings are advisory: the existing halt-on-critical
        // path still fires when applicable, but the loop does not widen
        // the surface to non-critical severities without a canon edit.
        severities_to_reprompt: ['critical'],
      },
    },
  ];
}

/**
 * Build the L3 directive atom that the bootstrap script writes. Shape
 * mirrors policyAtom in scripts/lib/loop-pass-claim-reaper-canon-policies.mjs
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
      source: { session_id: 'bootstrap-auditor-feedback-reprompt', agent_id: 'bootstrap' },
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
