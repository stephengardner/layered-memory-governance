#!/usr/bin/env node
/**
 * Canon bootstrap for three L3 directives drafted autonomously by
 * the cto-actor on 2026-04-21 and ratified via this PR-gate.
 *
 * Each directive's content is drawn from the corresponding CTO-drafted
 * plan atom's first-paragraph thesis; the full rationale (principles,
 * alternatives rejected, what-breaks-if-revisited) lives on the plan
 * atom, which every canon atom below cites via derived_from so future
 * arbitration can walk back to the drafting context.
 *
 * The three directives:
 *
 *   dev-canon-is-strategic-not-tactical
 *     Canon encodes strategic + architectural commitments (authority
 *     chains, approval gates, invariants, fences, seam contracts);
 *     tactical facts (naming conventions, existing utilities, patterns)
 *     live in the code and are read there, not atomized. Plans must
 *     cite canon for strategic claims and code/symbol for tactical.
 *
 *   dev-actor-scoped-llm-tool-policy
 *     Every LLM-backed actor's `disallowedTools` comes from a
 *     per-principal canon policy atom (`pol-llm-tool-policy-<id>`),
 *     not a framework constant. Default posture: Read+Grep+Glob
 *     allowed (reads are correctness-load-bearing); writes denied by
 *     default (Write/Edit/MultiEdit/Bash/Web*) because writes route
 *     through the existing signed-PR fence.
 *
 *   dev-canon-proposals-via-cto-not-direct
 *     Canon-atomization proposals originate from cto-actor-drafted
 *     plan atoms that the operator approves (via /decide or via a
 *     bootstrap-script PR merge; either is an auditable operator-
 *     ratification gate), not from conversational agents writing
 *     canon directly. Operator-override exception preserved for
 *     emergency corrections, producing its own decision atom.
 *
 * Idempotent per atom id; drift against the stored shape fails
 * loud (same discipline as `bootstrap-decisions-canon.mjs`).
 */

import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');
const BOOTSTRAP_TIME = '2026-04-21T15:00:00.000Z';

const OPERATOR_ID = process.env.LAG_OPERATOR_ID;
if (!OPERATOR_ID) {
  console.error(
    '[bootstrap-dev-canon-proposals] ERROR: LAG_OPERATOR_ID is not set.\n'
    + '  export LAG_OPERATOR_ID=<your-operator-id>\n',
  );
  process.exit(2);
}

// Source plan atoms (drafted by cto-actor 2026-04-21T15:02-15:03).
// Cited in every canon atom's derived_from so arbitration can walk
// back to the full rationale (alternatives_rejected, what_breaks_
// if_revisit) that the plan atom carries.
const PLAN_STRATEGIC_NOT_TACTICAL =
  'plan-seed-dev-canon-is-strategic-not-tactical-cto-actor-20260421150259';
const PLAN_LLM_TOOL_POLICY =
  'plan-seed-dev-actor-scoped-llm-tool-policy-pe-cto-actor-20260421150259';
const PLAN_PROPOSALS_VIA_CTO =
  'plan-seed-dev-canon-proposals-via-cto-not-dir-cto-actor-20260421150301';

const ATOMS = [
  {
    id: 'dev-canon-is-strategic-not-tactical',
    content:
      'Canon encodes strategic and architectural commitments whose provenance must survive code churn: '
      + 'authority chains, approval gates, invariants, blast-radius fences, seam contracts. Tactical facts '
      + '(naming conventions, existence of a utility, the exact shape of an already-landed pattern) live in '
      + 'the code and are discovered by reading it. Atomizing tactical facts violates substrate discipline '
      + 'and produces canon debt: atoms whose referent drifts the moment a file is renamed, leaving '
      + 'arbitration to reason from stale ids. Plans must cite canon for strategic claims and code/symbol '
      + 'for tactical claims; plans that hand-wave tactical claims without a code citation, or that atomize '
      + 'tactical claims that should have been code citations, fail review under this directive.',
    alternatives_rejected: [
      'Atomize all infrastructure facts (util inventories, existing patterns) into canon for retrieval-time grounding',
      'Leave canon scope undefined; trust authors to avoid tactical atomization by taste',
      'Encode the rule only as a process note in the plan template, not as L3 canon',
    ],
    what_breaks_if_revisit:
      'Sound at 3 months: the canon/code boundary it names only sharpens as the atomstore grows; revisit '
      + 'would be prompted only by a substrate redesign (e.g. a code-indexed retrieval layer that makes '
      + 'tactical-atom staleness cheap), in which case the directive still applies to strategic claims and '
      + 'widens rather than reverses.',
    derived_from: [
      'dev-substrate-not-prescription',
      'dev-forward-thinking-no-regrets',
      'dev-extreme-rigor-and-research',
      'arch-atomstore-source-of-truth',
      'dev-flag-structural-concerns',
      'dev-right-over-easy',
      PLAN_STRATEGIC_NOT_TACTICAL,
    ],
  },
  {
    id: 'dev-actor-scoped-llm-tool-policy',
    content:
      'Every LLM-backed actor\'s `disallowedTools` list is resolved from a per-principal canon policy atom '
      + '(`pol-llm-tool-policy-<principal-id>`), not from a framework constant. Default posture: Read, Grep, '
      + 'and Glob allowed because reads are correctness-load-bearing (a planner or executor that cannot '
      + 'observe the repo draws plans from imagination); Write, Edit, MultiEdit, Bash, and Web* denied '
      + 'because writes route through the existing signed-PR fence and other governance gates. Framework '
      + 'code retains the mechanism only: LlmOptions carries disallowedTools threaded from caller, and the '
      + 'caller resolves it from the principal\'s policy atom at invocation time. Fallback when no policy '
      + 'atom resolves is deny-all with an escalation, per inv-governance-before-autonomy.',
    alternatives_rejected: [
      'Keep DEFAULT_DISALLOWED_TOOLS in code, tune per-actor by editing src/adapters/claude-cli/llm.ts',
      'Allow every tool by default for every LLM actor; rely solely on downstream fences (signed-PR, CI, STOP)',
      'Ship a single framework-level per-role default (planner-default, executor-default) without per-principal atoms',
    ],
    what_breaks_if_revisit:
      'Sound at 3 months: the per-principal atom shape is additive and the default posture is justified by '
      + 'concrete failure evidence; the one fragility is that when a new tool class lands, the operator '
      + 'must decide posture for it via canon edit, which is exactly the path this directive prescribes.',
    derived_from: [
      'dev-substrate-not-prescription',
      'arch-atomstore-source-of-truth',
      'inv-provenance-every-write',
      'dev-indie-floor-org-ceiling',
      'dev-forward-thinking-no-regrets',
      'dev-extreme-rigor-and-research',
      'dev-right-over-easy',
      'pol-cto-default-deny',
      PLAN_LLM_TOOL_POLICY,
    ],
  },
  {
    id: 'dev-canon-proposals-via-cto-not-direct',
    content:
      'Canon-atomization proposals (any new L3 directive, decision, architecture, or policy atom) '
      + 'originate from a cto-actor-drafted plan atom that the operator ratifies via an auditable approval '
      + 'gate: the `/decide` skill for a single-atom addition, or a PR merge of a bootstrap-script for a '
      + 'batched seed. The drafting contract requires the plan atom to carry derived_from, '
      + 'alternatives_rejected, what_breaks_if_revisit, and principles_applied so approvers can spot-check '
      + 'grounding. Exception: the operator may override with an explicit "skip CTO, I have already '
      + 'decided" when a canon write is an emergency correction; the override produces its own decision '
      + 'atom recording the bypass and its reason so the shortcut is auditable rather than invisible. '
      + 'Scope note: the directive governs who drafts a canon proposal, not who approves it; approval '
      + 'authority remains with the operator per inv-l3-requires-human.',
    alternatives_rejected: [
      'Allow any agent to draft canon proposals directly; operator approves via /decide',
      'Require every canon proposal to route through operator-authored plan atoms (no CTO drafting)',
      'Keep the status quo; rely on agents to voluntarily route canon proposals through CTO',
    ],
    what_breaks_if_revisit:
      'Sound at 3 months as long as cto-actor remains the canon-drafting principal; if a future role split '
      + '(e.g. a dedicated canon-editor actor) lands, the directive widens to name both drafters rather '
      + 'than reversing, since the provenance-chain rationale is substrate-invariant.',
    derived_from: [
      'inv-l3-requires-human',
      'inv-provenance-every-write',
      'arch-atomstore-source-of-truth',
      'dev-flag-structural-concerns',
      'dev-no-hacks-without-approval',
      'pol-cto-plan-propose',
      'pol-cto-plan-escalate',
      'dev-self-audit-is-a-rhythm',
      PLAN_PROPOSALS_VIA_CTO,
    ],
  },
];

function atomFromSpec(spec) {
  return {
    schema_version: 1,
    id: spec.id,
    content: spec.content,
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'bootstrap-dev-canon-proposals', agent_id: 'bootstrap' },
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
      // Canonical spelling matches the PlanningActor plan-shape
      // contract (src/actors/planning/*) and the source plan atoms
      // own metadata. bootstrap-decisions-canon.mjs uses the past-
      // tense variant; that is a pre-existing drift handled
      // separately, not something this script inherits.
      what_breaks_if_revisit: spec.what_breaks_if_revisit,
    },
  };
}

// Drift-check pattern mirrors bootstrap-decisions-canon.mjs +
// bootstrap-inbox-canon.mjs. Identity + provenance integrity are
// load-bearing: a rewritten provenance under unchanged content
// would silently re-attribute authorship, which violates
// inv-provenance-every-write.
function diffAtom(existing, expected) {
  const diffs = [];
  for (const k of ['type', 'layer', 'content', 'principal_id', 'taint']) {
    if (existing[k] !== expected[k]) {
      diffs.push(`${k}: stored=${JSON.stringify(existing[k])} expected=${JSON.stringify(expected[k])}`);
    }
  }
  const em = existing.metadata ?? {};
  const xm = expected.metadata;
  // Symmetric key comparison: a stored atom with an EXTRA key (stale
  // key left over from a prior version of the script, or post-seed
  // injection) must surface as drift. One-sided comparison would
  // silently accept legacy/injected metadata, which is exactly the
  // class of tampering the drift check exists to catch.
  const allKeys = new Set([...Object.keys(xm), ...Object.keys(em)]);
  for (const k of allKeys) {
    if (JSON.stringify(em[k]) !== JSON.stringify(xm[k])) {
      diffs.push(`metadata.${k}: stored vs expected differ`);
    }
  }
  if (existing.provenance?.kind !== expected.provenance.kind) {
    diffs.push(
      `provenance.kind: stored=${JSON.stringify(existing.provenance?.kind)} `
      + `expected=${JSON.stringify(expected.provenance.kind)}`,
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
      console.log(`[bootstrap-dev-canon-proposals] wrote ${expected.id}`);
      continue;
    }
    const diffs = diffAtom(existing, expected);
    if (diffs.length > 0) {
      console.error(`[bootstrap-dev-canon-proposals] DRIFT on ${expected.id}:\n  ${diffs.join('\n  ')}`);
      process.exitCode = 1;
      return;
    }
    ok += 1;
  }
  console.log(`[bootstrap-dev-canon-proposals] done. ${written} written, ${ok} already in sync.`);
}

await main();
