// Shared policy-spec factory for bootstrap-pol-resume-strategy.mjs.
//
// Extracted into a lib module (no shebang, no top-level side effects)
// so drift tests in test/scripts can import the POLICIES payload and
// assert it matches the registry's Zod schema (resumeStrategyPolicySchema
// in examples/agent-loops/resume-author/registry.ts) without spawning
// Node. Mirrors the scripts/lib/inbox-canon-policies.mjs convention.
//
// The bootstrap script at scripts/bootstrap-pol-resume-strategy.mjs
// imports buildPolicies + policyAtom from here; the script remains the
// CLI entry point and owns env/host side effects.

const BOOTSTRAP_TIME = '2026-05-05T00:00:00.000Z';

/**
 * Build the per-actor pol-resume-strategy spec list.
 *
 * Per spec section 11.3 (PR3 acceptance): "a bootstrap script that
 * seeds the empty-default for pr-fix-actor (mirroring PR #171's
 * hard-coded behavior so the substrate represents the same posture)".
 * PR #171 + run-pr-fix.mjs hard-coded resume-on for pr-fix-actor with
 * an 8-hour staleness window (SameMachineCliResumeStrategy default).
 * This bootstrap reproduces that posture as a canon atom so a fresh
 * deployment running this seed gets identical behavior to the
 * pre-canon-policy run.
 *
 * Indie-floor fit: the seed is intentionally minimal:
 *   - enabled: true            -> matches PR #171's behavior
 *   - max_stale_hours: 8       -> matches SameMachineCliResumeStrategy default
 *   - fresh_spawn_kinds: [...] -> the indie-floor minimum set per
 *                                 spec section 6.2:
 *                                  - 'budget-exhausted'
 *                                  - 'stale-window-exceeded'
 *                                  - 'workspace-unrecoverable'
 *                                  - 'operator-reset'
 *
 * cto-actor + code-author POLICIES are intentionally OMITTED in this
 * v1 seed: per spec section 5.2 ("indie-floor default: absent") the
 * policy atom for those principals ships absent so a solo developer's
 * first run-cto-actor.mjs / run-code-author.mjs invocation does not
 * surprise-restore stale context. An org-ceiling deployment that
 * decides resume should be on for those principals adds a
 * higher-priority canon atom via a second `decide` call; this
 * bootstrap is the v1 minimal seed.
 */
export function buildPolicies(_operatorId) {
  return [
    {
      id: 'pol-resume-strategy-pr-fix-actor',
      principal_id: 'pr-fix-actor',
      reason:
        'Per-actor resume-strategy policy for the pr-fix-actor principal. '
        + 'Mirrors the hard-coded posture in scripts/run-pr-fix.mjs (PR #171): '
        + 'resume-on with an 8-hour staleness window via the SameMachineCliResumeStrategy. '
        + 'The bootstrap seeds the canon atom so a fresh deployment running this seed for '
        + 'the first time observes IDENTICAL behavior to the pre-canon-policy run; '
        + 'removing this atom flips PR-fix back to fresh-spawn (regression check vs PR #171). '
        + 'Indie-floor default per spec section 5.2 (cto-actor + code-author ship ABSENT '
        + 'so a solo developer does not surprise-restore stale context); org-ceiling '
        + 'deployments that want resume on cto-actor or code-author write a separate '
        + 'pol-resume-strategy-cto-actor or pol-resume-strategy-code-author atom via '
        + 'a deliberate canon-edit moment, not a global toggle.',
      content: {
        enabled: true,
        max_stale_hours: 8,
        fresh_spawn_kinds: [
          'budget-exhausted',
          'stale-window-exceeded',
          'workspace-unrecoverable',
          'operator-reset',
        ],
      },
    },
  ];
}

/**
 * Compare a stored pol-resume-strategy atom's payload to the expected
 * shape. Returns a list of drift descriptors (empty = in sync). Mirrors
 * diffPolicyAtom from bootstrap-reaper-canon.mjs so the bootstraps use
 * one drift-check pattern. Compares the full metadata.policy object
 * (subject, principal_id, reason, content) and the four integrity
 * fields (principal_id, provenance.kind / source / derived_from)
 * because re-attribution under unchanged content would silently
 * re-author the policy without changing any payload field.
 *
 * Extracted from bootstrap-pol-resume-strategy.mjs so the test suite
 * can drive the same drift-check rather than re-implementing the
 * comparison; the bootstrap script imports this helper from here.
 */
export function diffPolicyAtom(existing, expected) {
  const diffs = [];
  if (existing.type !== expected.type) diffs.push(`type: ${existing.type} -> ${expected.type}`);
  if (existing.layer !== expected.layer) diffs.push(`layer: ${existing.layer} -> ${expected.layer}`);
  if (existing.content !== expected.content) {
    diffs.push('content (rationale): stored vs expected differ; rewrite or bump id to supersede');
  }
  if (existing.principal_id !== expected.principal_id) {
    diffs.push(
      `principal_id: stored=${JSON.stringify(existing.principal_id)} `
        + `expected=${JSON.stringify(expected.principal_id)}`,
    );
  }
  const ev = existing.provenance ?? {};
  const xv = expected.provenance;
  if (ev.kind !== xv.kind) {
    diffs.push(
      `provenance.kind: stored=${JSON.stringify(ev.kind)} `
        + `expected=${JSON.stringify(xv.kind)}`,
    );
  }
  if (JSON.stringify(ev.source ?? {}) !== JSON.stringify(xv.source)) {
    diffs.push(
      `provenance.source: stored=${JSON.stringify(ev.source)} `
        + `expected=${JSON.stringify(xv.source)}`,
    );
  }
  if (JSON.stringify(ev.derived_from ?? []) !== JSON.stringify(xv.derived_from)) {
    diffs.push(
      `provenance.derived_from: stored=${JSON.stringify(ev.derived_from)} `
        + `expected=${JSON.stringify(xv.derived_from)}`,
    );
  }
  const ep = existing.metadata?.policy ?? {};
  const xp = expected.metadata.policy;
  const keys = new Set([...Object.keys(ep), ...Object.keys(xp)]);
  for (const k of keys) {
    if (JSON.stringify(ep[k]) !== JSON.stringify(xp[k])) {
      diffs.push(`policy.${k}: stored=${JSON.stringify(ep[k])} expected=${JSON.stringify(xp[k])}`);
    }
  }
  return diffs;
}

/**
 * Build the L3 directive atom that the bootstrap script writes. Shape
 * mirrors policyAtom in scripts/lib/inbox-canon-policies.mjs so the
 * file-host round-trip and drift-check are identical across the
 * bootstraps. The metadata.policy field carries the structured policy
 * payload + identifying subject/principal_id; the schema-validated
 * content shape lives nested under metadata.policy.content per the
 * policy-atom convention used elsewhere in this repo
 * (see e.g. metadata.policy.principal in scripts/bootstrap-pr-fix-canon.mjs).
 *
 * The validator the registry runs at canon-read time
 * (resumeStrategyPolicySchema in
 * examples/agent-loops/resume-author/registry.ts) reads
 * metadata.policy.content; that is the structured payload the schema
 * validates against. Other fields under metadata.policy are policy-atom
 * convention sugar (subject for routing, principal_id for matching, reason
 * for human review) and are not part of the validated content shape.
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
      source: { session_id: 'bootstrap-pol-resume-strategy', agent_id: 'bootstrap' },
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
        subject: 'resume-strategy',
        principal_id: spec.principal_id,
        reason: spec.reason,
        content: spec.content,
      },
    },
  };
}
