// Shared policy-spec factory for bootstrap-claim-contract-canon.mjs.
//
// Extracted into a lib module (no shebang, no top-level side effects)
// so drift tests in test/scripts can import the POLICIES payload and
// assert it matches the runtime readers
// (resolveBudgetTier in src/substrate/policy/claim-budget-tier.ts and
// the 8 named resolvers in src/substrate/policy/claim-reaper-config.ts)
// without spawning Node.
//
// The bootstrap script at scripts/bootstrap-claim-contract-canon.mjs
// imports buildPolicies + policyAtom from here; the script remains the
// CLI entry point and owns env/host side effects. Mirrors the convention
// established by scripts/lib/reaper-canon-policies.mjs and
// scripts/lib/inbox-canon-policies.mjs.
//
// The 11 policy atoms seeded here back the work-claim substrate:
//
//   - 3 budget-tier atoms (kind='claim-budget-tier') resolved by
//     resolveBudgetTier(tier, host). Indie-floor ceilings: default=$2,
//     raised=$5, max=$10. Org-ceiling deployments add new tiers
//     (e.g. emergency=$100) via higher-priority canon atoms with the
//     same kind; binding the resolver to a fixed atom-id pattern would
//     foreclose that path and break dev-substrate-not-prescription.
//
//   - 8 numeric-config atoms (each with kind=metadata.policy.kind and
//     a single numeric `value` field) resolved by the eight named
//     readers in claim-reaper-config.ts. Defaults match the values
//     locked into the spec (docs/superpowers/specs/2026-05-10-zero-
//     failure-sub-agent-substrate.md) so an existing deployment that
//     runs this seed for the first time observes the documented
//     reaper cadence + recovery + grace windows.
//
// Every value in this file is also asserted by tests at:
//   - test/scripts/bootstrap-claim-contract-canon.test.ts
//   - test/substrate/policy/claim-budget-tier.test.ts (reader contract)
//   - test/substrate/policy/claim-reaper-config.test.ts (reader contract)
//
// Tuning any value is a canon edit, not a release. Bumping a number
// shows up as a diff here and the drift-check fails loud on a stale
// store, so the operator-facing seed and the runtime reader contract
// stay in lockstep.

const BOOTSTRAP_TIME = '2026-05-11T00:00:00.000Z';

/**
 * Build the claim-contract-canon POLICIES spec list. Pure function
 * of operatorId so the bootstrap drift-check + idempotency property
 * reduce to function-purity at this layer.
 *
 * Returns 11 specs in a stable order:
 *   1. Three budget-tier atoms (default / raised / max).
 *   2. Eight numeric-config atoms covering reaper cadence, recovery
 *      attempts + deadline extension, attesting/pending grace, verifier
 *      timeout + failure cap, and the post-finalize session grace.
 *
 * @param {string} _operatorId - The operator principal id. Currently
 *   unused (none of the policies seed an operator-specific allowlist),
 *   but kept on the signature to match the bootstrap-*-canon-policies
 *   convention so the script wiring is uniform across canon seeds.
 */
export function buildPolicies(_operatorId) {
  return [
    // -----------------------------------------------------------------
    // Budget-tier atoms (kind='claim-budget-tier').
    //
    // Resolved by resolveBudgetTier(tier, host). The reader matches on
    // metadata.policy.kind === 'claim-budget-tier' AND
    // metadata.policy.tier === <tier>. Indie-floor ceilings are sized
    // so a default claim never accidentally outspends a casual local
    // dev loop; raised/max provide a deliberate widening surface.
    // -----------------------------------------------------------------
    {
      id: 'pol-claim-budget-tier-default',
      kind: 'claim-budget-tier',
      reason:
        'Default budget tier ceiling ($2 USD) for work-claim substrate. Resolves via '
        + 'resolveBudgetTier("default", host); matches by metadata.policy.kind + tier so '
        + 'org-ceiling deployments can register higher-priority overrides at the same kind '
        + 'without superseding this atom. Indie-floor default: a one-claim mistake on the '
        + 'default tier costs at most $2.',
      fields: {
        tier: 'default',
        max_budget_usd: 2.0,
      },
    },
    {
      id: 'pol-claim-budget-tier-raised',
      kind: 'claim-budget-tier',
      reason:
        'Raised budget tier ceiling ($5 USD) for claims that need a wider envelope than '
        + 'default but stay below max. Resolved by resolveBudgetTier("raised", host); '
        + 'consumers opt into this tier explicitly per claim. Org-ceiling overrides land as '
        + 'higher-priority same-kind canon edits per dev-substrate-not-prescription.',
      fields: {
        tier: 'raised',
        max_budget_usd: 5.0,
      },
    },
    {
      id: 'pol-claim-budget-tier-max',
      kind: 'claim-budget-tier',
      reason:
        'Max budget tier ceiling ($10 USD) for the highest indie-floor envelope; deliberate '
        + 'opt-in only. Resolved by resolveBudgetTier("max", host). An org with deeper budget '
        + 'discipline lands a tighter same-kind override; an org with a $100 emergency tier '
        + 'lands an entirely new "emergency" tier as an additive canon atom.',
      fields: {
        tier: 'max',
        max_budget_usd: 10.0,
      },
    },

    // -----------------------------------------------------------------
    // Numeric-config atoms (one per kind; each carries `value`).
    //
    // Resolved by the eight named readers in
    // src/substrate/policy/claim-reaper-config.ts. The reader matches
    // by metadata.policy.kind === <kind> and validates
    // metadata.policy.value is a finite positive number. Defaults
    // below match the locked spec values so a deployment running this
    // seed for the first time observes the documented behaviour.
    // -----------------------------------------------------------------
    {
      id: 'pol-claim-reaper-cadence-ms',
      kind: 'claim-reaper-cadence-ms',
      reason:
        'Reaper-loop sweep cadence in milliseconds. 60s (60000) balances detection latency '
        + 'against atom-store read pressure: a stuck claim is reaped within one minute, but '
        + 'the loop costs one L3-pagination walk per minute rather than per second. Org-'
        + 'ceiling deployments with sub-30s SLAs tune this via higher-priority same-kind canon.',
      fields: { value: 60_000 },
    },
    {
      id: 'pol-claim-recovery-max-attempts',
      kind: 'claim-recovery-max-attempts',
      reason:
        'Maximum recovery attempts before a claim is finalized as failed. 3 attempts plus '
        + 'the original = 4 total shots; high enough to absorb transient infra blips, low '
        + 'enough that a stuck-loop fault trips fail-closed within ~3 cadence cycles. Tied '
        + 'to claim-recovery-deadline-extension-ms: each recovery extends the deadline by '
        + 'that ms count, so the total recovery window is bounded.',
      fields: { value: 3 },
    },
    {
      id: 'pol-claim-recovery-deadline-extension-ms',
      kind: 'claim-recovery-deadline-extension-ms',
      reason:
        'Deadline extension (ms) granted per recovery attempt. 30 minutes (1_800_000) gives '
        + 'a recovered claim a fresh window to make forward progress without immediately '
        + 're-tripping the reaper. Combined with claim-recovery-max-attempts=3, the total '
        + 'recovery window is bounded at 90 minutes past the original deadline.',
      fields: { value: 1_800_000 },
    },
    {
      id: 'pol-claim-attesting-grace-ms',
      kind: 'claim-attesting-grace-ms',
      reason:
        'Grace window (ms) before reaping a claim stuck in the attesting state. 5 minutes '
        + '(300_000) absorbs verifier round-trip latency + network jitter without giving a '
        + 'genuinely-wedged attestation phase an open-ended hide window. Independent of '
        + 'claim-pending-grace-ms because the failure modes (verifier slowness vs no '
        + 'verifier engaging) call for different timeouts.',
      fields: { value: 300_000 },
    },
    {
      id: 'pol-claim-pending-grace-ms',
      kind: 'claim-pending-grace-ms',
      reason:
        'Grace window (ms) before reaping a claim stuck in the pending state. 60s (60_000) '
        + 'is tight because pending = no verifier has picked it up yet; a one-minute lull is '
        + 'the longest acceptable in a healthy substrate. Tighter than attesting because the '
        + 'failure mode is different: pending-stuck means dispatch failed, attesting-stuck '
        + 'means verifier is slow.',
      fields: { value: 60_000 },
    },
    {
      id: 'pol-claim-verifier-timeout-ms',
      kind: 'claim-verifier-timeout-ms',
      reason:
        'Per-call timeout (ms) for a single verifier-handler invocation. 30s (30_000) is '
        + 'generous for sync verifiers (atom-store lookup, GitHub PR query) and surfaces a '
        + 'stuck verifier loudly rather than silently consuming budget. Independent of the '
        + 'claim-attesting-grace-ms window because that one governs the whole attesting '
        + 'phase, this one governs a single call.',
      fields: { value: 30_000 },
    },
    {
      id: 'pol-claim-verifier-failure-cap',
      kind: 'claim-verifier-failure-cap',
      reason:
        'Maximum consecutive verifier failures before the substrate trips the breaker on a '
        + 'verifier. 3 failures matches the inbox circuit-breaker discipline (3 denials in a '
        + 'window trips the breaker): low enough that a wedged verifier is contained inside '
        + 'a few cadence cycles, high enough that legitimate transient failures self-heal '
        + 'without operator intervention.',
      fields: { value: 3 },
    },
    {
      id: 'pol-claim-session-post-finalize-grace-ms',
      kind: 'claim-session-post-finalize-grace-ms',
      reason:
        'Debounce grace (ms) before finalizing a session after its last claim closes. 30s '
        + '(30_000) covers the common case where one claim closes and another opens inside '
        + 'the same logical turn (e.g. plan-verifier closes, drafter opens). Without this '
        + 'debounce the session would flap finalized -> reopened, polluting the audit log '
        + 'with spurious lifecycle atoms.',
      fields: { value: 30_000 },
    },
  ];
}

/**
 * Build the L3 directive atom that the bootstrap script writes. Shape
 * mirrors the policyAtom helpers in scripts/lib/reaper-canon-policies.mjs
 * and scripts/lib/inbox-canon-policies.mjs so the file-host round-trip
 * and drift-check are identical across the canon bootstraps.
 *
 * Critical contract with the readers in src/substrate/policy/:
 *   - metadata.policy.kind is the resolver discriminator (NOT atom id).
 *   - For budget-tier atoms, metadata.policy.tier + max_budget_usd live
 *     on the same policy block; the reader matches kind + tier.
 *   - For numeric-config atoms, metadata.policy.value is the resolver
 *     output; the reader validates it is a finite positive number.
 *
 * @param {{ id: string, kind: string, reason: string, fields: Record<string, unknown> }} spec
 * @param {string} operatorId - principal id that signs the atom.
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
      source: { session_id: 'bootstrap-claim-contract', agent_id: 'bootstrap' },
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
        kind: spec.kind,
        reason: spec.reason,
        ...spec.fields,
      },
    },
  };
}
