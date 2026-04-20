#!/usr/bin/env node
/**
 * Canon bootstrap for the proactive-CTO inbox (V1 hardening).
 *
 * Seeds four L3 policy atoms whose runtime behaviour will be consumed
 * by subsequent PRs in the inbox V1 sequence:
 *
 *   - `pol-actor-message-rate`               -> token-bucket config for the write-time
 *                                               rate limiter (PR A).
 *   - `pol-actor-message-circuit-breaker`    -> trip thresholds for the circuit
 *                                               breaker that blocks a runaway sender
 *                                               (PR A).
 *   - `pol-circuit-breaker-reset-authority`  -> who may sign a circuit-breaker-reset
 *                                               atom to clear a trip (PR A).
 *   - `pol-inbox-poll-cadence`               -> correctness and deadline-imminent
 *                                               poll intervals for the Scheduler
 *                                               pickup handler (PR B / PR D).
 *
 * Every threshold is a policy atom so tuning is a canon edit, not a
 * code release -- per the `dev-substrate-not-prescription` canon
 * directive and the revised v2.1 CTO plan
 * (plan-v2-1-hardening-circuit-breaker-policy-re-*).
 *
 * Shape note: these atoms reuse the `metadata.policy` convention but
 * with per-subject fields. The existing `checkToolPolicy` path ignores
 * non-`tool-use` subjects; consumers added in PRs A/B/D read these
 * atoms by id and parse the subject-specific fields. Layer L3 so the
 * canon-applier renders the human reason into CLAUDE.md.
 *
 * Idempotent per atom id; drift against the expected spec fails loud
 * (same discipline as bootstrap-cto-actor-canon.mjs).
 */

import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');
const BOOTSTRAP_TIME = '2026-04-20T00:00:00.000Z';

// Operator principal id. Every deployment picks its own; a
// hardcoded default here would leak one instance's shape into
// the script. Require explicit configuration. Matches the
// bootstrap-cto-actor-canon.mjs convention but without any
// fallback to a specific person's id.
const OPERATOR_ID = process.env.LAG_OPERATOR_ID;
if (!OPERATOR_ID) {
  console.error(
    '[bootstrap-inbox] ERROR: LAG_OPERATOR_ID is not set. Export your\n'
    + 'operator principal id before running this script, e.g.\n\n'
    + '  export LAG_OPERATOR_ID=<your-operator-id>\n\n'
    + 'The id is referenced by pol-circuit-breaker-reset-authority and must\n'
    + 'match the principal already seeded in .lag/principals/.',
  );
  process.exit(2);
}

/**
 * Per-subject defaults. Every number is justified in the v2.1 plan;
 * tuning is a canon edit, not a release. Bumping a value is
 * intentional and shows up as a diff here.
 */
const POLICIES = [
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
      authorized_principals: [OPERATOR_ID],
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
];

function policyAtom(spec) {
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
    principal_id: OPERATOR_ID,
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

/**
 * Compare a stored inbox-policy atom's payload to the expected shape.
 * Returns a list of drift descriptors (empty = in sync). Every subject-
 * specific numeric or id field is compared so a silent edit to the
 * POLICIES table here is loud on the next bootstrap run.
 *
 * `content` and `metadata.policy.reason` are both compared so editing the
 * human-reading rationale is surfaced as drift (a policy whose reason
 * was "root-only because depth-based is attackable" quietly becoming
 * "any operator" would misrepresent the governance posture without
 * changing any numeric field; that silent edit is exactly the class of
 * bug this drift check is here to catch).
 */
function diffPolicyAtom(existing, expected) {
  const diffs = [];
  if (existing.type !== expected.type) diffs.push(`type: ${existing.type} -> ${expected.type}`);
  if (existing.layer !== expected.layer) diffs.push(`layer: ${existing.layer} -> ${expected.layer}`);
  if (existing.content !== expected.content) {
    diffs.push(`content (rationale): stored vs expected differ; rewrite or bump id to supersede`);
  }
  // Signer / provenance integrity. These fields establish WHO authored the
  // atom and WHERE it came from. Editing them while the policy payload stays
  // unchanged would misattribute the atom without changing any numeric
  // threshold; the drift check must surface that, otherwise a compromised
  // principal could silently re-sign policies without triggering any alarm.
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

async function main() {
  await mkdir(STATE_DIR, { recursive: true });
  const host = await createFileHost({ rootDir: STATE_DIR });

  let written = 0;
  let ok = 0;
  for (const spec of POLICIES) {
    const expected = policyAtom(spec);
    const existing = await host.atoms.get(expected.id);
    if (existing === null) {
      await host.atoms.put(expected);
      written += 1;
      console.log(`[bootstrap-inbox] wrote ${expected.id}`);
      continue;
    }
    const diffs = diffPolicyAtom(existing, expected);
    if (diffs.length > 0) {
      console.error(
        `[bootstrap-inbox] DRIFT on ${expected.id}:\n  ${diffs.join('\n  ')}\n`
        + 'Resolve by: (a) editing POLICIES[] to match stored shape if the '
        + 'stored value is authoritative, or (b) bumping the atom id and '
        + 'superseding the old one if you are intentionally changing policy.',
      );
      process.exitCode = 1;
      return;
    }
    ok += 1;
  }
  console.log(`[bootstrap-inbox] done. ${written} written, ${ok} already in sync.`);
}

await main();
