#!/usr/bin/env node
/**
 * Canon bootstrap for decisions and architectural choices made during
 * the proactive-CTO inbox V1 + self-audit cycle (starting 2026-04-20).
 *
 * Source plan: plan-seed-8-canon-atoms-recording-proactive-c-cto-actor-
 * 20260420193913, produced by the CTO self-audit run that followed the
 * inbox V1 merge. Eight atoms: three arch/decisions, one decision, and
 * four directives. All additive; none overturn existing canon.
 *
 * Idempotent per atom id; drift against stored shape fails loud.
 */

import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');
const BOOTSTRAP_TIME = '2026-04-20T19:39:13.200Z';

const OPERATOR_ID = process.env.LAG_OPERATOR_ID;
if (!OPERATOR_ID) {
  console.error(
    '[bootstrap-decisions] ERROR: LAG_OPERATOR_ID is not set.\n'
    + '  export LAG_OPERATOR_ID=<your-operator-id>\n',
  );
  process.exit(2);
}

const SOURCE_PLAN = 'plan-seed-8-canon-atoms-recording-proactive-c-cto-actor-20260420193913';

const ATOMS = [
  {
    id: 'arch-actor-message-inbox-primitive',
    type: 'decision',
    content:
      'Inbox V1 is the inter-actor messaging primitive: actor-message atoms '
      + 'in the AtomStore plus Scheduler-driven pickup plus policy-atom ordering. '
      + 'Not a new Host sub-interface.',
    alternatives_rejected: [
      'Bidirectional Notifier (violates arch-notifier-is-a-channel)',
      'Dedicated inbox storage (violates arch-atomstore-source-of-truth)',
      'New Host sub-interface (violates arch-host-interface-boundary)',
    ],
    derived_from: [
      'arch-atomstore-source-of-truth',
      'arch-notifier-is-a-channel',
      'arch-host-interface-boundary',
      'plan-inbox-as-actor-message-atoms-polled-by-s-cto-actor-20260420104254',
      'plan-revised-inbox-hybrid-wake-write-time-rat-cto-actor-20260420110310',
      SOURCE_PLAN,
    ],
    what_breaks_if_revisited: 'Projections depend on this shape; revisit forces adapter rewrite.',
  },
  {
    id: 'arch-bot-identity-per-actor',
    type: 'decision',
    content:
      'Actors acquire per-role GitHub App identities via the lag-actors CLI. '
      + 'Terminal automation routes through gh-as.mjs using short-lived installation '
      + 'tokens. The operator personal gh auth is not used for autonomous actions.',
    alternatives_rejected: [
      'Operator PAT per actor (leaks identity, violates arch-principal-hierarchy-signed-by)',
      'Single shared bot across actors (destroys per-actor authority)',
      'OAuth device flow (breaks indie-floor/org-ceiling)',
    ],
    derived_from: [
      'arch-principal-hierarchy-signed-by',
      'inv-provenance-every-write',
      'pol-cto-default-deny',
      SOURCE_PLAN,
    ],
    what_breaks_if_revisited: 'Sound unless GitHub App quotas force architectural change; token rotation already documented.',
  },
  {
    id: 'arch-plan-state-top-level-field',
    type: 'decision',
    content:
      'plan_state is a top-level Atom field, not a metadata key. Surfaced by '
      + 'the first self-audit run when PlanningActor was writing it into metadata '
      + 'where dispatch and auto-approve loops could not see it. Consumers read '
      + 'atom.plan_state, never atom.metadata.plan_state.',
    alternatives_rejected: [
      'Keep plan_state in metadata (observed filter bug; dispatch + auto-approve loops silently skipped every plan)',
      'Separate lifecycle table outside Atom shape (violates arch-atomstore-source-of-truth)',
    ],
    derived_from: [
      'arch-atomstore-source-of-truth',
      'plan-harden-three-substrate-layers-before-aut-cto-actor-20260420171042',
      SOURCE_PLAN,
    ],
    what_breaks_if_revisited: 'Precedent for future lifecycle fields; backward-compat reads remain in aggregate-context + host-llm-judgment.',
  },
  {
    id: 'dec-autonomous-merge-via-bot-not-co-maintainer',
    type: 'decision',
    content:
      'The autonomous-merge endgame is policy-driven auto-merge by a bot, NOT '
      + 'a second human co-maintainer. Model B (the lag-cto bot has merge '
      + 'capability, constrained to flow through plan-dispatch) is the chosen '
      + 'path for clean GitHub audit-log provenance. CTO direct merge under '
      + 'medium-tier kill switch protection is the concrete implementation.',
    alternatives_rejected: [
      'Second human co-maintainer (doesn\'t scale; adds signed_by ambiguity; permanent human-in-loop bottleneck at merge layer)',
      'Permanent HIL merge for every PR (blocks autonomy dial indefinitely)',
      'Separate lag-merger[bot] sub-actor (Model A; two-hop provenance chain worse for human git-log readability)',
    ],
    derived_from: [
      'pol-cto-no-merge',
      'inv-kill-switch-first',
      'inv-governance-before-autonomy',
      'dev-indie-floor-org-ceiling',
      SOURCE_PLAN,
    ],
    what_breaks_if_revisited: 'Academic if D13 medium-tier kill switch never ships; if a second human co-maintainer onboards before D13, canon-edit reversal with preserved-alternative chain.',
  },
  {
    id: 'dev-merge-authority-requires-medium-tier-kill-switch',
    type: 'directive',
    content:
      'Loosening pol-cto-no-merge (or any merge-authority policy atom) requires '
      + 'the medium-tier kill switch (canon D13) shipped first. The soft STOP '
      + 'sentinel alone is insufficient for autonomous merges because it cannot '
      + 'halt an in-flight merge mid-operation.',
    alternatives_rejected: [
      'Autonomous merge behind the soft STOP sentinel only (no runtime recovery path; compromised actor can complete a merge before STOP is read)',
      'Wait for hard-tier kill switch (over-gated; delays autonomous merge indefinitely)',
    ],
    derived_from: [
      'pol-cto-no-merge',
      'inv-kill-switch-first',
      'inv-governance-before-autonomy',
      'dev-forward-thinking-no-regrets',
      SOURCE_PLAN,
    ],
    what_breaks_if_revisited: 'Tied to D13 scope stability; if D13 shape changes, this atom needs review.',
  },
  {
    id: 'dev-judgment-ladder-required-for-llm-actors',
    type: 'directive',
    content:
      'Every LLM-judgment-backed actor must consume the pol-judgment-fallback-ladder '
      + 'policy atom. A failed primary draft MUST NOT produce an atom that is '
      + 'eligible for auto-approval, regardless of any other policy. The '
      + 'escalation floor confidence in the policy prevents silent-stub autoprove.',
    alternatives_rejected: [
      'Per-actor ad-hoc fallback logic (duplication, drift between actors, violates dev-substrate-not-prescription)',
      'Framework-hardcoded ladder values (tuning becomes framework release, violates dev-substrate-not-prescription)',
    ],
    derived_from: [
      'pol-judgment-fallback-ladder',
      'inv-governance-before-autonomy',
      'dev-substrate-not-prescription',
      SOURCE_PLAN,
    ],
    what_breaks_if_revisited: 'Sound; only revisit if the ladder\'s structure itself is restructured (three rungs: retry, cheaper-model, escalation).',
  },
  {
    id: 'arch-code-author-blast-radius-fence-reserved',
    type: 'decision',
    content:
      'The code-author blast-radius fence (ADR design/adr-code-author-blast-'
      + 'radius-fence.md) reserves the pol-code-author-* policy-atom slot. '
      + 'Graduation criteria are documented; fence atoms are seeded only when '
      + 'the code-author principal materializes.',
    alternatives_rejected: [
      'Seed pol-code-author-* atoms immediately without a code-author principal (canon drift; atoms that decay because their subject never materializes; devil\'s advocate in the source self-audit plan conceded this)',
      'Skip ADR and write atoms when the principal ships (loses pre-review gate; violates ≥2-consumer bar in dev-substrate-not-prescription)',
    ],
    derived_from: [
      'pol-cto-default-deny',
      'pol-cto-no-merge',
      'dev-substrate-not-prescription',
      'plan-harden-three-substrate-layers-before-aut-cto-actor-20260420171042',
      SOURCE_PLAN,
    ],
    what_breaks_if_revisited: 'Slot reservation costs nothing if never used; ADR provides graduation criteria so revisit is a canon-edit, not a re-design.',
  },
  {
    id: 'dev-self-audit-is-a-rhythm',
    type: 'directive',
    content:
      'Self-audit is a regular CTO-driven rhythm, not a one-off. The CTO '
      + 're-runs self-audit after each substantive hardening ship. Observed '
      + 'autonomous-loop failures from the run itself guide the next hardening '
      + 'ask; the loop observes itself.',
    alternatives_rejected: [
      'Calendar-based audit (ignores shipped-work signal; wastes cycles when nothing changed)',
      'Operator-request only (drops the loop-observes-itself feedback; audits only surface operator-visible concerns, miss substrate-visible ones)',
    ],
    derived_from: [
      'dev-extreme-rigor-and-research',
      'dev-flag-structural-concerns',
      'dev-forward-thinking-no-regrets',
      'dev-right-over-easy',
      'plan-harden-three-substrate-layers-before-aut-cto-actor-20260420171042',
      SOURCE_PLAN,
    ],
    what_breaks_if_revisited: 'Tied to cto-actor principal continuity; if CTO principal is replaced, re-derive.',
  },
];

function atomFromSpec(spec) {
  return {
    schema_version: 1,
    id: spec.id,
    content: spec.content,
    type: spec.type,
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'bootstrap-decisions', agent_id: 'bootstrap' },
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
    principal_id: OPERATOR_ID,
    taint: 'clean',
    metadata: {
      alternatives_rejected: spec.alternatives_rejected,
      what_breaks_if_revisited: spec.what_breaks_if_revisited,
      source_plan: SOURCE_PLAN,
    },
  };
}

function diffAtom(existing, expected) {
  const diffs = [];
  for (const k of ['type', 'layer', 'content', 'principal_id', 'taint']) {
    if (existing[k] !== expected[k]) {
      diffs.push(`${k}: stored=${JSON.stringify(existing[k])} expected=${JSON.stringify(expected[k])}`);
    }
  }
  const em = existing.metadata ?? {};
  const xm = expected.metadata;
  for (const k of Object.keys(xm)) {
    if (JSON.stringify(em[k]) !== JSON.stringify(xm[k])) {
      diffs.push(`metadata.${k}: stored vs expected differ`);
    }
  }
  // Provenance is load-bearing for audit integrity. Drift checks must
  // cover ALL four integrity fields (principal_id above, plus the
  // three provenance sub-fields below) because a rewritten provenance
  // with unchanged payload would silently reattribute authorship.
  // Matches the bootstrap-inbox-canon.mjs diffPolicyAtom pattern.
  if (existing.provenance?.kind !== expected.provenance.kind) {
    diffs.push(
      `provenance.kind: stored=${JSON.stringify(existing.provenance?.kind)} expected=${JSON.stringify(expected.provenance.kind)}`,
    );
  }
  if (JSON.stringify(existing.provenance?.source ?? null) !== JSON.stringify(expected.provenance.source)) {
    diffs.push('provenance.source differs');
  }
  if (JSON.stringify(existing.provenance?.derived_from ?? []) !== JSON.stringify(expected.provenance.derived_from)) {
    diffs.push('provenance.derived_from differs');
  }
  return diffs;
}

async function main() {
  await mkdir(STATE_DIR, { recursive: true });
  const host = await createFileHost({ rootDir: STATE_DIR });
  let written = 0;
  let ok = 0;
  for (const spec of ATOMS) {
    const expected = atomFromSpec(spec);
    const existing = await host.atoms.get(expected.id);
    if (existing === null) {
      await host.atoms.put(expected);
      written += 1;
      console.log(`[bootstrap-decisions] wrote ${expected.id}`);
      continue;
    }
    const diffs = diffAtom(existing, expected);
    if (diffs.length > 0) {
      console.error(`[bootstrap-decisions] DRIFT on ${expected.id}:\n  ${diffs.join('\n  ')}`);
      process.exitCode = 1;
      return;
    }
    ok += 1;
  }
  console.log(`[bootstrap-decisions] done. ${written} written, ${ok} already in sync.`);
}

await main();
