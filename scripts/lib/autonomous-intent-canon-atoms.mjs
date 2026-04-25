// Pure builders for the three L3 atoms the autonomous-intent
// substrate seeds into canon. The CLI wrapper
// (scripts/bootstrap-autonomous-intent-canon.mjs) shells out to this
// module so the test suite can build atoms off the same data without
// spawning the script.
//
// Pre-fix the bootstrap shipped policy atoms with `type: 'decision'`
// and the policy block hoisted under `metadata.subject` +
// `metadata.fields`. The intent-approval tick filters on
// `type='directive'` + `layer='L3'` and reads
// `metadata.policy.{subject, allowed_principal_ids, allowed_sub_actors}`,
// so the seeded atoms were unreachable: every dispatch fell through
// the empty-allowlist fail-closed path even though the bootstrap
// reported success. Tests in test/scripts/autonomous-intent-canon-atoms.test.ts
// pin the new shape to the fields readIntentApprovePolicy and
// readIntentCreationPolicy actually look at.

const BOOTSTRAP_TIME = '2026-04-24T00:00:00.000Z';

/**
 * Build the canonical specs (data only) for the three substrate
 * atoms. Pure: same input -> same output, ready for the CLI wrapper
 * to walk into atomFromSpec or for the test to assert against.
 *
 * `operatorId` seeds the allowed_principal_ids list so the bootstrap
 * matches whatever LAG_OPERATOR_ID intend.mjs / run-cto-actor.mjs
 * read. A hard-coded principal id would lock this flow to one
 * deployment's seed name.
 */
export function buildAutonomousIntentCanonSpecs(operatorId) {
  if (typeof operatorId !== 'string' || operatorId.length === 0) {
    throw new Error('buildAutonomousIntentCanonSpecs: operatorId is required');
  }
  return [
    {
      id: 'pol-operator-intent-creation',
      // type='directive' + layer='L3' so the readIntentCreationPolicy
      // query (which filters on type=['directive'], layer=['L3']) can
      // surface this atom. Pre-fix the bootstrap wrote 'decision' and
      // every read fell through to the empty-allowlist fail-closed
      // path.
      type: 'directive',
      content:
        'Whitelist of principals allowed to author operator-intent atoms that the '
        + 'autonomous-intent approval tick honors. Non-whitelisted authors can still '
        + 'write atoms of type operator-intent (for audit), but the tick treats them as '
        + 'non-authorizing observations. v1 ships with the configured operator principal '
        + 'only; adding a bot or delegated-human principal is a conscious canon-edit '
        + 'moment that broadens the authorization surface. Do NOT widen without an '
        + 'explicit operator decision atom citing the broadening rationale.',
      // The tick reads metadata.policy.{subject, allowed_principal_ids};
      // anything else lives outside that block.
      policy: {
        subject: 'operator-intent-creation',
        allowed_principal_ids: [operatorId],
        max_expires_in_hours: 72,
        required_trust_envelope_fields: [
          'max_blast_radius',
          'allowed_sub_actors',
        ],
      },
      alternatives_rejected: [
        'Allow any signed principal (not just the configured operator) to author authorizing intents in v1',
        'Enforce principal constraint only at approval-tick time without a canon policy atom',
        'Use a transitive signed_by chain walk instead of a flat allowlist in v1',
      ],
      what_breaks_if_revisit:
        'Sound at 3 months: operator-only authorship is the most restrictive safe '
        + 'default; widening is additive and requires only a canon edit plus a derived '
        + 'decision atom. Narrowing below the configured operator id would break '
        + 'intend.mjs for any operator. The flat allowlist is upgraded to chain-walk in '
        + 'a follow-up without changing this atom\'s semantics.',
      derived_from: [
        'inv-l3-requires-human',
        'inv-governance-before-autonomy',
        'inv-kill-switch-first',
        'inv-provenance-every-write',
        'arch-atomstore-source-of-truth',
        'dev-forward-thinking-no-regrets',
        'dev-indie-floor-org-ceiling',
      ],
    },
    {
      id: 'pol-plan-autonomous-intent-approve',
      type: 'directive',
      content:
        'Plans that derive_from a fresh (non-expired) operator-intent atom with a '
        + 'matching trust envelope auto-transition proposed -> approved without a multi-reviewer '
        + 'vote cycle. The intent IS the authorization. This policy enforces envelope match: '
        + 'plan confidence >= intent.min_plan_confidence, plan blast_radius <= intent.max_blast_radius, '
        + 'plan.delegation.sub_actor_principal_id in intent.allowed_sub_actors. Intent must be fresh '
        + '(now < intent.expires_at) and uncompromised (taint=clean). Empty allowlist = no intent path; '
        + 'removing this policy disables autonomous-intent flow without breaking manual paths.',
      policy: {
        subject: 'plan-autonomous-intent-approve',
        allowed_sub_actors: ['code-author', 'auditor-actor'],
        require_intent_fresh: true,
        require_intent_clean: true,
        require_intent_principal_allowlist: 'pol-operator-intent-creation',
      },
      alternatives_rejected: [
        'Extend pol-plan-auto-approve-low-stakes to handle intent-based approval instead of a separate policy atom',
        'Require multi-reviewer vote even when operator-intent provides explicit authorization',
        'Embed allowed_sub_actors list directly in the approval-tick code rather than in a canon policy atom',
      ],
      what_breaks_if_revisit:
        'Sound at 3 months: the empty-allowlist short-circuit means the policy is a feature '
        + 'flag; setting allowed_sub_actors to [] disables autonomous-intent without any code '
        + 'change. Adding new sub-actor types (deploy-actor, security-reviewer) is additive. '
        + 'The require_intent_principal_allowlist reference to pol-operator-intent-creation '
        + 'creates a deliberate two-atom dependency so that tightening the principal list '
        + 'automatically tightens autonomous approval.',
      derived_from: [
        'inv-l3-requires-human',
        'inv-governance-before-autonomy',
        'inv-kill-switch-first',
        'inv-provenance-every-write',
        'arch-atomstore-source-of-truth',
        'dev-forward-thinking-no-regrets',
        'dev-indie-floor-org-ceiling',
        'pol-operator-intent-creation',
      ],
    },
    {
      id: 'dev-autonomous-intent-substrate-shape',
      type: 'directive',
      content:
        'Operator-authored operator-intent atoms with a trust_envelope authorize autonomous plan-approval; '
        + 'non-operator-authored operator-intent atoms are ignored by the autonomous path. Do not add '
        + 'non-operator principals to pol-operator-intent-creation.allowed_principal_ids without a prior '
        + 'operator-signed decision atom citing the broadening rationale.',
      alternatives_rejected: [
        'Encode this as a process note in a skill file rather than a canon directive',
        'Merge into pol-operator-intent-creation content rather than issuing a separate directive',
      ],
      what_breaks_if_revisit:
        'Sound at 3 months: the two-sentence invariant is the load-bearing safety property '
        + 'of the entire autonomous-intent design. Weakening the first sentence without a '
        + 'principal-delegation-chain mechanism in place would allow bot-authored intents to '
        + 'self-approve plans, collapsing the human-in-the-loop gate. The second sentence '
        + 'is a process guard that survives any future extension to the allowlist.',
      derived_from: [
        'inv-l3-requires-human',
        'inv-governance-before-autonomy',
        'inv-kill-switch-first',
        'arch-atomstore-source-of-truth',
        'dev-flag-structural-concerns',
        'dev-right-over-easy',
        'pol-operator-intent-creation',
        'pol-plan-autonomous-intent-approve',
      ],
    },
  ];
}

/**
 * Lift a spec into a fully-formed canon Atom.
 *
 * Policy specs carry an optional `policy` block; when present it
 * lands under `metadata.policy` (NOT `metadata.subject` /
 * `metadata.fields`, which the tick ignores).
 */
export function buildAtomFromSpec(spec, operatorId) {
  if (typeof operatorId !== 'string' || operatorId.length === 0) {
    throw new Error('buildAtomFromSpec: operatorId is required');
  }
  const metadata = {
    alternatives_rejected: spec.alternatives_rejected,
    what_breaks_if_revisit: spec.what_breaks_if_revisit,
  };
  if (spec.policy !== undefined) {
    metadata.policy = spec.policy;
  }
  return {
    schema_version: 1,
    id: spec.id,
    content: spec.content,
    type: spec.type,
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'bootstrap-autonomous-intent-canon', agent_id: 'bootstrap' },
      derived_from: spec.derived_from,
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
    metadata,
  };
}

export function buildAutonomousIntentCanonAtoms(operatorId) {
  return buildAutonomousIntentCanonSpecs(operatorId).map(
    (spec) => buildAtomFromSpec(spec, operatorId),
  );
}
