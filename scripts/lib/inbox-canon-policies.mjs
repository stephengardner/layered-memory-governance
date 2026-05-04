// Shared policy-spec factory for bootstrap-inbox-canon.mjs.
//
// Extracted into a lib module (no shebang, no top-level side effects)
// so drift tests in test/scripts can import the POLICIES payload and
// assert it matches runtime fallbacks (e.g. FALLBACK_PLAN_APPROVAL in
// src/runtime/actor-message/plan-approval.ts) without spawning Node.
//
// The bootstrap script at scripts/bootstrap-inbox-canon.mjs imports
// buildPolicies + policyAtom from here; the script remains the CLI
// entry point and owns env/host side effects. Keeping the pure data
// + shape here + the I/O there matches the substrate discipline
// (mechanism-only lib, policy-and-env in the script).

const BOOTSTRAP_TIME = '2026-04-20T00:00:00.000Z';

/**
 * Build the inbox-canon POLICIES spec list. Parameterized on the
 * operator principal id because pol-circuit-breaker-reset-authority
 * seeds it into authorized_principals; every other policy is
 * operator-id-independent.
 *
 * Every number is justified in the v2.1 plan; tuning is a canon edit,
 * not a release. Bumping a value is intentional and shows up as a
 * diff here.
 */
export function buildPolicies(operatorId) {
  return [
    {
      id: 'pol-actor-message-rate',
      subject: 'actor-message-rate',
      reason:
        'Token bucket that gates write-time actor-message creation per sender principal. '
        + 'Applies to ALL principals by default; per-principal overrides land as additional '
        + 'atoms with a specific `principal` field. Bursts beyond the bucket are rejected at '
        + 'write time (not just at read-time inbox depth) so a runaway sender cannot pollute '
        + 'the atom store before back-pressure engages.',
      fields: {
        // All principals unless overridden.
        principal: '*',
        // 10 msgs/min steady state matches the "legitimate webhook + operator
        // chatter" burst ceiling observed in prior repos; high enough that normal
        // operator usage never hits it, low enough that a tight-loop runaway trips
        // the circuit breaker inside one window_ms (3 denials / 5min).
        tokens_per_minute: 10,
        // Burst 20 absorbs brief spikes (PR-event webhook flurries, multi-operator
        // standup) without denying legitimate work.
        burst_capacity: 20,
      },
    },
    {
      id: 'pol-actor-message-circuit-breaker',
      subject: 'actor-message-circuit-breaker',
      reason:
        'Trip-count circuit breaker for actor-message writes. Three denials inside the '
        + 'window trips the breaker and rejects further writes from the offending principal '
        + 'until an operator-signed `circuit-breaker-reset` atom clears the trip. Default '
        + 'auto-reset is null (human gate required) per the inv-governance-before-autonomy '
        + 'and inv-l3-requires-human canon directives.',
      fields: {
        // "1 is noise, 5 is slow": 3 denials rises above legitimate-burst noise
        // given the 10/min bucket while surfacing runaways within one window.
        denial_count_trip_threshold: 3,
        // 5 minutes matches the operator attention cycle; short enough that
        // transients self-heal via bucket refill, long enough that a flapping
        // sender still trips.
        window_ms: 300_000,
        // null = requires operator-signed reset atom. Auto-reset would hide the
        // governance surface; default-null is the governance-first posture.
        // Deployments that want auto-reset set a positive number here explicitly.
        automatic_reset_after_ms: null,
      },
    },
    {
      id: 'pol-circuit-breaker-reset-authority',
      subject: 'circuit-breaker-reset-authority',
      reason:
        'Who may sign a circuit-breaker-reset atom. V0 ships root-only because depth-based '
        + 'authority is attackable: a compromised sub-principal at allowed depth could sign a '
        + 'reset that clears its own trip. Future multi-human orgs widen this atom '
        + 'explicitly; raising the dial is a canon edit, lowering after a compromise is a '
        + 'schema migration, so start strict.',
      fields: {
        // Empty = default-deny. The expected shape is either an explicit list of
        // principal ids OR a non-null `max_signer_depth` with a non-empty
        // `root_principals` list. The validator checks this at write time.
        authorized_principals: [operatorId],
        // 0 = root-only. Raised via canon edit when multi-human structure exists.
        max_signer_depth: 0,
      },
    },
    {
      id: 'pol-inbox-ordering',
      subject: 'inbox-ordering',
      reason:
        'Default pickup ordering for actor-message atoms: deadline-imminent beats '
        + 'urgency tier beats arrival FIFO. Thresholds and tier weights are tunable '
        + 'via canon edit rather than a framework release, per dev-substrate-not-'
        + 'prescription. Deployments that want a fundamentally different ordering '
        + 'function pass a custom orderingFn to pickNextMessage; this atom only '
        + 'configures the default function.',
      fields: {
        // ms threshold that treats a deadline_ts as "imminent" for priority.
        // 60s matches the cadence threshold in pol-inbox-poll-cadence.
        deadline_imminent_threshold_ms: 60_000,
        // Urgency tier weights. Lower = higher priority.
        urgency_weights: {
          high: 0,
          normal: 1,
          soft: 2,
        },
      },
    },
    {
      id: 'pol-judgment-fallback-ladder',
      subject: 'judgment-fallback-ladder',
      reason:
        'Tiered fallback policy for LLM-backed judgment calls (e.g., HostLlmPlanningJudgment). '
        + 'A failed primary draft MUST NOT emit an atom that is eligible for auto-approval. The '
        + 'ladder: (1) retry with jitter up to retry_max attempts on transient errors, (2) single '
        + 're-draft against cheaper_model if configured, (3) emit an escalation atom with the full '
        + 'failure trace so HIL sees it. Fail-closed: if no rung succeeds, the produced atom is a '
        + 'missing-judgment escalation with confidence below the auto-approve floor, NEVER a '
        + 'low-confidence stub whose plan_state could be auto-approved. Surfaced by the first '
        + 'self-audit run; consumes the five plan-clarify-cannot-draft-a-grounded-plan-llm atoms '
        + 'observed on 2026-04-20 as evidence of the primary path failing modes (budget exceeded, '
        + 'exit=undefined, empty stdout).',
      fields: {
        // Retry on transient errors (rate limit, network, timeout).
        // 2 retries + 1 primary attempt = 3 total shots before moving
        // to the cheaper-model rung. Low enough that a stuck request
        // does not blow past the per-call budget on its own.
        retry_max: 2,
        // Base backoff 2s; full jitter applied (random in [0, retry_base_ms]).
        retry_base_ms: 2000,
        // Cheaper model for the re-draft rung. Null = skip this rung
        // and go straight to escalation when the primary fails.
        cheaper_model: null,
        // Confidence below which a produced atom is never eligible
        // for auto-approval, regardless of any other policy. Prevents
        // a fallback stub from sneaking through pol-plan-auto-approve-
        // low-stakes.min_confidence.
        escalation_floor_confidence: 0.3,
      },
    },
    {
      id: 'pol-plan-auto-approve-low-stakes',
      subject: 'plan-auto-approve-low-stakes',
      reason:
        'Plans that delegate to a read-only sub-actor (v0: auditor-actor only) and '
        + 'that meet a minimum confidence bar can auto-transition from proposed to '
        + 'approved without an operator signature. Ships default-deny: empty allowlist = '
        + 'no auto-approvals. Operators widen the allowlist via canon edit when a new '
        + 'read-only actor is ready. Never auto-approve a sub-actor that mutates state '
        + 'beyond atom writes; use the manual plan-approval path for those.',
      fields: {
        // v0: only the read-only auditor is pre-allowed. Raising the
        // dial means appending principal ids here, and it is a
        // deliberate canon-edit moment each time.
        allowed_sub_actors: ['auditor-actor'],
        // Plans below this confidence bar wait for manual operator
        // approval regardless of the delegation target.
        min_confidence: 0.55,
      },
    },
    {
      id: 'pol-plan-multi-reviewer-approval',
      subject: 'plan-multi-reviewer-approval',
      reason:
        'Multi-reviewer consensus path for state-mutating sub-actors (code-author first). '
        + 'Where pol-plan-auto-approve-low-stakes grants single-principal auto-approval for '
        + 'read-only actors, this policy grants distinct-principal consensus approval for '
        + 'actors that mutate external state (PRs, commits, deployments). runPlanApprovalTick '
        + 'reads this atom and transitions `proposed` -> `approved` when N distinct principals '
        + 'have cast fresh plan-approval-vote atoms above the confidence floor. A single fresh '
        + 'reject vote hard-blocks (abandoned). Defaults match FALLBACK_PLAN_APPROVAL in '
        + 'src/runtime/actor-message/plan-approval.ts so a drift between seed and fallback is '
        + 'a test failure, not a silent runtime surprise. Seeded with code-author on the '
        + 'allowlist so the default autonomous loop (Question -> Plan -> PR) has a sanctioned '
        + 'approval path without an additional canon edit per deployment.',
      fields: {
        // Default sanctioned allowlist. Adding another state-mutating
        // sub-actor is a canon-edit moment by design (matches the
        // auto-approve dial discipline).
        allowed_sub_actors: ['code-author'],
        // Distinct-principal approve count required to transition. 2 is
        // the "third opinion" threshold from the canon layer-3 promotion
        // default; kept consistent with L3-promotion discipline.
        min_votes: 2,
        // Per-vote confidence floor. Votes below this do not count
        // toward the threshold; they still land as atoms for audit but
        // the consensus math ignores them.
        min_vote_confidence: 0.8,
        // Plan's own confidence floor. A plan whose planner emitted it
        // at <0.85 confidence does not enter the consensus path;
        // operators route low-confidence plans through full manual
        // review instead.
        min_plan_confidence: 0.85,
        // Empty = no role quorum required. Tenants with an org shape
        // (SRE, legal, security) append role names here; runPlanApprovalTick
        // then requires at least one vote per listed role in addition to
        // the min_votes count.
        required_roles: [],
        // One fresh reject vote abandons the plan. Rationale: a reviewer
        // spotting a shape-compromising issue must be able to halt the
        // plan; the default is reviewer-veto over majority-approve.
        hard_reject_on_any_reject: true,
        // 24h freshness window. Votes older than this are treated as
        // stale and do not count. Keeps the approval signal from
        // accumulating indefinitely when a plan sits queued.
        max_age_ms: 86_400_000,
      },
    },
    {
      id: 'pol-inbox-poll-cadence',
      subject: 'inbox-poll-cadence',
      reason:
        'Correctness and deadline-imminent poll intervals for the Scheduler pickup '
        + 'handler. The correctness poll is a backstop when the NOTIFY-wake channel '
        + 'silently drops; the deadline-imminent poll tightens cadence whenever any atom '
        + 'with an imminent deadline is visible. Tuning is a canon edit so sub-30s SLA '
        + 'deployments can move the floor without a framework release.',
      fields: {
        // 30s matches the 50-actor-scale math: 50 x 1q/30s = ~144k q/day vs ~4.3M
        // at 1s polling. 30x cheaper idle footprint; caps NOTIFY-dropped latency
        // at 30s for non-deadline messages.
        correctness_poll_ms: 30_000,
        // 5s cadence while any atom with deadline_ts - now < deadline_imminent_threshold_ms
        // is visible. Self-corrective without depending on NOTIFY reliability.
        deadline_imminent_poll_ms: 5_000,
        // Sub-minute deadlines trigger the tight-cadence branch. Deployments that
        // run with finer SLAs narrow this; zero disables the tight branch.
        deadline_imminent_threshold_ms: 60_000,
      },
    },
    {
      id: 'pol-pr-observation-freshness-threshold-ms',
      subject: 'pr-observation-freshness-threshold-ms',
      reason:
        'Freshness threshold for pr-observation atoms. The plan-observation-refresh tick '
        + 're-observes a PR whose latest observation is older than this many milliseconds, '
        + 'has pr_state=OPEN, and whose linked plan is still executing. Default 5 minutes is '
        + 'a sensible indie-floor; an org running tighter latency budgets sets a smaller '
        + 'value. Closes the substrate gap where a PR that merges or closes leaves its plan '
        + 'stuck in plan_state=executing because the only observation atom for the PR was '
        + 'written ONCE at PR-creation time and carries pr_state=OPEN forever.',
      fields: {
        // 5 minutes matches the autonomous-loop cadence; the next approval-cycle
        // tick after a PR merges sees the stale observation and refreshes it,
        // which the reconciler then transitions on the same pass.
        freshness_ms: 300_000,
      },
    },
    {
      id: 'pol-approval-cycle-tick-interval-ms',
      subject: 'approval-cycle-tick-interval-ms',
      reason:
        'Sleep interval between passes for the approval-cycle daemon mode '
        + '(scripts/run-approval-cycle.mjs --daemon). The daemon drives the six '
        + 'approval-cycle ticks (intent-approve, auto-approve, plan-approval, '
        + 'plan-obs-refresh, plan-reconcile, dispatch) on this cadence; the '
        + 'pr-observation refresh tick in particular needs the daemon to be '
        + 'self-sustaining so substrate gap #8 (stale OPEN observations on '
        + 'merged PRs) does not require manual operator invocation. Default 5 '
        + 'minutes matches pol-pr-observation-freshness-threshold-ms so a stale '
        + 'OPEN observation is refreshed within one cadence-window. Org-ceiling '
        + 'deployments that want a tighter (60s) or relaxed (15min) cadence flip '
        + 'this via a higher-priority canon atom; the daemon reads the value '
        + 'BEFORE each sleep so a canon edit takes effect on the next pass '
        + 'without a daemon restart.',
      fields: {
        // 5 minutes matches pol-pr-observation-freshness-threshold-ms above.
        // Keeping the pair in lockstep means a stale observation is refreshed
        // within one cadence-window without forcing an operator to tune two
        // atoms together.
        interval_ms: 300_000,
      },
    },
  ];
}

/**
 * Build the L3 directive atom that the bootstrap script writes. All
 * policy atoms share the shape; subject-specific numeric fields live
 * under metadata.policy.
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
      source: { session_id: 'bootstrap-inbox', agent_id: 'bootstrap' },
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
