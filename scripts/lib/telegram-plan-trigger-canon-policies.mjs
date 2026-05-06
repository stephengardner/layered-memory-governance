// Shared policy-spec factory for bootstrap-telegram-plan-trigger-canon.mjs.
//
// Extracted into a lib module (no shebang, no top-level side effects)
// so drift tests in test/scripts can import the POLICIES payload and
// assert it matches runtime fallbacks (DEFAULT_PRINCIPAL_ALLOWLIST in
// src/runtime/loop/telegram-plan-trigger-allowlist.ts) without
// spawning Node.
//
// The bootstrap script at scripts/bootstrap-telegram-plan-trigger-canon.mjs
// imports buildPolicies + policyAtom from here; the script remains
// the CLI entry point and owns env/host side effects. Mirrors the
// scripts/lib/reaper-canon-policies.mjs convention.

const BOOTSTRAP_TIME = '2026-05-05T00:00:00.000Z';

/**
 * Build the telegram-plan-trigger canon POLICIES spec list.
 * Parameterized on the operator principal id (signs the seed atom)
 * but otherwise pure.
 *
 * Currently a single-atom set: `pol-telegram-plan-trigger-principals-default`.
 * The atom id carries the `-default` suffix so an org-ceiling
 * deployment can land a higher-priority `pol-telegram-plan-trigger-
 * principals-<scope>` atom (e.g. `pol-telegram-plan-trigger-principals-
 * sandbox` to drop cpo-actor in a smoke deployment) without
 * superseding the default; arbitration's source-rank formula
 * resolves the higher-priority atom first.
 *
 * Defaults match `DEFAULT_PRINCIPAL_ALLOWLIST` in
 * src/runtime/loop/telegram-plan-trigger-allowlist.ts so an existing
 * deployment that runs this script for the first time observes
 * IDENTICAL behavior to its pre-canon-policy run. The drift test at
 * test/scripts/bootstrap-telegram-plan-trigger-canon.test.ts locks
 * the two together.
 */
export function buildPolicies(_operatorId) {
  return [
    {
      id: 'pol-telegram-plan-trigger-principals-default',
      subject: 'telegram-plan-trigger-principals',
      reason:
        'Default allowlist of principals whose newly-proposed plan atoms are auto-pushed to '
        + 'Telegram by the LoopRunner notify pass. Promotes the indie-floor default from a '
        + 'framework constant to a canon policy atom per dev-substrate-not-prescription so an '
        + 'org-ceiling deployment can override the list at scope boundaries via a higher-priority '
        + 'pol-telegram-plan-trigger-principals-<scope> atom rather than a framework release. '
        + 'An explicitly empty principal_ids array is the explicit opt-out; absent / malformed '
        + 'payloads fall through to the framework default. Defaults (cto-actor + cpo-actor) match '
        + 'DEFAULT_PRINCIPAL_ALLOWLIST in src/runtime/loop/telegram-plan-trigger-allowlist.ts so an '
        + 'existing deployment running this seed for the first time observes identical behavior. '
        + 'A solo developer running zero-config gets phone-pings on the two planning-shaped roles; '
        + 'an org adding a new planning role updates this atom (or a higher-priority overlay).',
      fields: {
        // cto-actor + cpo-actor: matches DEFAULT_PRINCIPAL_ALLOWLIST.
        // The two planning-shaped principals that produce operator-
        // actionable plans in the indie-floor reference deployment.
        principal_ids: ['cto-actor', 'cpo-actor'],
      },
    },
  ];
}

/**
 * Build the L3 directive atom that the bootstrap script writes. Shape
 * mirrors policyAtom in scripts/lib/reaper-canon-policies.mjs so the
 * file-host round-trip and drift-check are identical across the
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
      source: { session_id: 'bootstrap-telegram-plan-trigger', agent_id: 'bootstrap' },
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
