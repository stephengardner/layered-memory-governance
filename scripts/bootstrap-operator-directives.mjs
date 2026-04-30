#!/usr/bin/env node
/**
 * Canon bootstrap for operator-authored directives captured via the
 * decide skill / scripts/decide.mjs.
 *
 * This file is the canonical, committed home for operator directives
 * that governance relies on: "CR is non-negotiable", "no real-name
 * comments on automation artifacts", etc. The decide CLI writes
 * atoms directly to .lag/ on capture (fast, local, per-session);
 * THIS script re-seeds them on fresh checkouts / CI runs so the
 * atoms survive outside the operator's laptop.
 *
 * When the operator captures a new directive with `/decide`, the
 * follow-up PR should append its spec to the ATOMS array below so
 * the capture is durable across environments. A directive that
 * lives only in one operator's local .lag/ is not really canon.
 *
 * Idempotent per atom id; drift against stored shape fails loud
 * (same pattern as bootstrap-decisions-canon.mjs).
 */

import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');

const OPERATOR_ID = process.env.LAG_OPERATOR_ID;
if (!OPERATOR_ID) {
  console.error(
    '[bootstrap-operator-directives] ERROR: LAG_OPERATOR_ID is not set.\n'
    + '  export LAG_OPERATOR_ID=<your-operator-principal-id>\n',
  );
  process.exit(2);
}

const ATOMS = [
  {
    id: 'dev-coderabbit-required-status-check-non-negotiable',
    type: 'directive',
    content:
      'CodeRabbit is a required status check for the main branch of this repo. It is '
      + 'non-negotiable. Branch-protection changes that remove CodeRabbit from '
      + 'required_status_checks.contexts are rejected. Workarounds that preserve the gate '
      + '(operator-proxy comment triggers, auto-review reliability, machine-user accounts) '
      + 'are acceptable; workarounds that remove the gate (marking CR advisory, path-scoped '
      + 'conditional required checks that drop CR for bot-opened PRs, dropping the check '
      + 'entirely for a subset of PRs) are not. If the gate is temporarily waived for a '
      + 'specific merge due to an emergency, the waiver must itself produce a decision '
      + 'atom and a follow-up that restores the gate.',
    alternatives_rejected: [
      {
        option: 'Drop CodeRabbit from required_status_checks.contexts entirely',
        reason: 'Loses the merge-quality gate for all PRs; CR findings become advisory only; weakens the governance story this repo sells.',
      },
      {
        option: 'Path-scoped conditional required-check via ruleset (CR required only for human-authored PRs)',
        reason: 'Still removes the gate for exactly the PRs (bot-opened) most in need of independent review; gate-weakening by class, not per-decision.',
      },
      {
        option: 'Accept CR as optional when bot-opened PRs outnumber human-opened PRs in a given week',
        reason: 'Couples merge gate to throughput; at scale the threshold would always be crossed. Merge quality is not a throughput-tunable property.',
      },
    ],
    what_breaks_if_revisited:
      'Merge quality gate weakens; CR findings become advisory only; the repo\'s three-layer '
      + 'governance story loses its third-party-review layer.',
    derived_from: ['inv-governance-before-autonomy', 'dev-forward-thinking-no-regrets'],
  },
  {
    id: 'dev-operator-personal-account-no-automation-comments',
    type: 'directive',
    content:
      'The operator\'s personal GitHub account (stephengardner) does not comment on PRs '
      + 'as part of automation flows in this repo. All automation-originated PR comments, '
      + 'review replies, status updates, and merge actions route through provisioned bot '
      + 'identities (lag-ceo as the operator-proxy, lag-cto for decision-bearing work, '
      + 'lag-pr-landing for review handling). The only exception is extreme circumstances '
      + 'where the lag-ceo bot identity itself has broken (installation revoked, token flow '
      + 'dead, App disabled) AND autonomous recovery has failed; in that case the operator '
      + 'may comment from the personal account as a last-resort bootstrap to restore the '
      + 'bot flow, and a follow-up decision atom must capture the breakage + recovery so the '
      + 'bypass is auditable. A human-authored PR review on a PR the operator is personally '
      + 'reviewing as a reviewer (not as automation) is not covered by this directive.',
    alternatives_rejected: [
      {
        option: 'Operator comments permitted on any PR whenever convenient',
        reason: 'Collapses the bot-identity audit trail; breaks the three-layer attribution guarantee (credential isolation + repo-local git identity + PreToolUse hook) by giving the operator a silent second channel.',
      },
      {
        option: 'Operator comments forbidden entirely with no exception',
        reason: 'No escape hatch when the bot-identity flow itself breaks; operator becomes locked out of their own repo on a partial-outage scenario.',
      },
      {
        option: 'Operator comments allowed only when explicitly self-labeled [operator-bypass]',
        reason: 'Labelling discipline is eventually forgotten; the exception label gets reused for convenience over time, eroding into option 1.',
      },
    ],
    what_breaks_if_revisited:
      "Bot-identity abstraction leaks; the three-layer attribution guarantee weakens; future "
      + "audits of 'who did what' lose their clean operator->bot->action chain.",
    derived_from: ['arch-bot-identity-per-actor', 'inv-provenance-every-write'],
  },
  {
    id: 'dev-pr-fix-auto-resolve-outdated-threads',
    type: 'directive',
    content:
      'PR-authoring agents (pr-fix-actor, code-author, run-pr-fix.mjs, run-pr-landing.mjs, '
      + 'and any direct agent fix-push flow) MUST run '
      + '`node scripts/resolve-outdated-threads.mjs <pr>` after each fix-push so the '
      + 'unresolved-review-threads merge gate clears as soon as CI does. Outdated review '
      + 'threads (where the anchored line was changed by the fix-commit) are a hard merge '
      + 'gate alongside reviewDecision and CI: branch protection enforces '
      + 'all-conversations-resolved, and an outdated thread stays in the unresolved bucket '
      + 'until someone calls `resolveReviewThread` on it. Threads still anchored to live '
      + 'code (unresolved AND not outdated) are LEFT alone -- those need a human or a '
      + 'CR-side acknowledgement because the suggestion may still apply. The script routes '
      + 'through `gh-as.mjs lag-ceo` (operator-proxy bot identity), NOT `LAG_OPS_PAT` '
      + '(machine user reserved for `@coderabbitai review` triggers per '
      + 'dev-cr-trigger-via-machine-user-only); thread resolution is a routine PR action, '
      + 'not a CR trigger. Until the substrate enforces this in actor-loop code (PrFixActor '
      + 'and successors), it is a per-flow rule that PR-authoring agents must follow at '
      + 'fix-push time.',
    alternatives_rejected: [
      {
        option: 'Leave thread resolution to humans',
        reason:
          'Multiple PRs in a single session stalled in BLOCKED purely on this; the burden '
          + 'is operator-time-fragmenting and the resolution is mechanical.',
      },
      {
        option: 'Resolve ALL unresolved threads regardless of outdated state',
        reason:
          'Non-outdated threads are still anchored to live code where the suggestion may '
          + 'still apply; auto-resolving them silences feedback that the human or CR may '
          + 'want to act on.',
      },
      {
        option: 'Wait for CR to resolve threads on its own',
        reason:
          'CR does not resolve threads when the anchored diff becomes outdated; only the '
          + 'author or a programmatic resolveReviewThread mutation closes them.',
      },
      {
        option: 'Build this as a PrFixActor substrate seam now',
        reason:
          'Premature: the per-flow rule is the right shape until at least three actor-types '
          + 'use it; substrate-promotion at N=3 keeps the seam from solidifying around a '
          + 'one-call-site contract.',
      },
    ],
    what_breaks_if_revisited:
      'Every PR with more than one round of CR fixes sits in mergeStateStatus=BLOCKED until '
      + 'a human notices and manually resolves outdated threads; the merge queue stalls, '
      + 'autonomous-loop sessions end at N percent of work landed instead of 100, and the '
      + 'operator must re-state the directive having lost faith in the loop\'s discipline.',
    derived_from: [
      'pol-pr-fix-pr-thread-resolve',
      'dev-cr-triggers-via-machine-user',
      'dev-required-checks-must-cover-all-meaningful-ci',
      'inv-governance-before-autonomy',
    ],
  },
  {
    id: 'dev-deep-planning-pipeline',
    type: 'directive',
    content:
      'The deep planning pipeline replaces the single-pass HostLlmPlanningJudgment with a '
      + 'pluggable, atom-projected, per-stage-audited pipeline. Default 5-stage composition: '
      + 'brainstorm-stage -> spec-stage -> plan-stage -> review-stage -> dispatch-stage; '
      + 'org-ceiling deployments compose additional stages via canon policy atoms per '
      + 'dev-substrate-not-prescription. Each stage emits its output as an atom carrying '
      + 'provenance.derived_from chain back to the seed operator-intent; the review-stage '
      + 'runs a read-only auditor that re-walks every cited path and atom id from the '
      + 'upstream plan, closing the dev-drafter-citation-verification-required gap at the '
      + 'substrate level. Mode-gated via --mode=substrate-deep on run-cto-actor.mjs; the '
      + 'indie floor default is single-pass so a solo developer does not surprise-pay the '
      + 'multi-stage cost on a one-line README fix. Resumability and kill-switch posture '
      + 'inherit from the existing actor-message passes.',
    alternatives_rejected: [
      {
        option: 'Extend HostLlmPlanningJudgment with a multi-step prompt',
        reason:
          'Loses pluggability and per-stage auditing; concentrates judgment in a single LLM '
          + 'call that cannot be policy-gated or partially-resumed.',
      },
      {
        option: 'Build a separate planning pipeline framework outside src/runtime',
        reason:
          'Fragments the substrate; consumers would have to compose two seam systems with '
          + 'overlapping concerns (atom store, kill-switch, provenance).',
      },
      {
        option: 'Encode stages as a directed graph from day one',
        reason:
          'Over-engineers before the second consumer arrives; the depends_on forward-compat '
          + 'seam preserves the option without paying the complexity cost now.',
      },
    ],
    what_breaks_if_revisited:
      'Sound at 3 months: stages are atom-projected and policy-arbitrated, adding a stage is '
      + 'a canon edit, the trust-envelope authorization model from autonomous-intent inherits '
      + 'via derived_from chain, and the DAG forward-compat seam (depends_on on stage entries) '
      + 'is reserved in spec section 15 as the next step when a concrete consumer needs '
      + 'parallel stages.',
    derived_from: [
      'inv-l3-requires-human',
      'inv-governance-before-autonomy',
      'inv-kill-switch-first',
      'inv-provenance-every-write',
      'arch-atomstore-source-of-truth',
      'arch-host-interface-boundary',
      'dev-substrate-not-prescription',
      'dev-indie-floor-org-ceiling',
      'dev-canon-is-strategic-not-tactical',
      'dev-judgment-ladder-required-for-llm-actors',
      'dev-drafter-citation-verification-required',
      'operator-intent-deep-planning-pipeline-1777408799112',
    ],
  },
];

function atomFromSpec(spec) {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    id: spec.id,
    content: spec.content,
    type: spec.type,
    layer: 'L3',
    provenance: {
      // operator-seeded (not human-asserted): this atom is written
      // by a bootstrap script, not by a live conversational /decide
      // capture. The distinction matters for taint/provenance
      // analysis - pre-dynamic seed atoms and post-compromise
      // live-session atoms need to be separable, which is why
      // ProvenanceKind keeps 'operator-seeded' distinct from
      // 'human-asserted'.
      kind: 'operator-seeded',
      source: {
        tool: 'bootstrap-operator-directives',
        agent_id: OPERATOR_ID,
      },
      derived_from: spec.derived_from ?? [],
    },
    confidence: 1.0,
    created_at: now,
    last_reinforced_at: now,
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
      source: 'bootstrap-operator-directives',
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
  // Bidirectional metadata diff so extra keys on the stored atom
  // (the hostile-injection class of tampering) are caught too.
  // One-sided iteration lets a tampered atom with an extra
  // metadata.* key read as clean if the original spec's keys all
  // match - the exact gap bootstrap-inbox-canon.mjs already closed
  // via diffPolicyAtom.
  const em = existing.metadata ?? {};
  const xm = expected.metadata;
  const metaKeys = new Set([...Object.keys(em), ...Object.keys(xm)]);
  for (const k of metaKeys) {
    if (JSON.stringify(em[k]) !== JSON.stringify(xm[k])) {
      diffs.push(`metadata.${k}: stored=${JSON.stringify(em[k])} expected=${JSON.stringify(xm[k])}`);
    }
  }
  if (existing.provenance?.kind !== expected.provenance.kind) {
    diffs.push(`provenance.kind: stored=${JSON.stringify(existing.provenance?.kind)} expected=${JSON.stringify(expected.provenance.kind)}`);
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
      console.log(`[bootstrap-operator-directives] wrote ${expected.id}`);
      continue;
    }
    const diffs = diffAtom(existing, expected);
    if (diffs.length > 0) {
      console.error(`[bootstrap-operator-directives] DRIFT on ${expected.id}:\n  ${diffs.join('\n  ')}`);
      process.exitCode = 1;
      return;
    }
    ok += 1;
  }
  console.log(`[bootstrap-operator-directives] done. ${written} written, ${ok} already in sync.`);
}

await main();
