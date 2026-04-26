#!/usr/bin/env node
/**
 * Canon bootstrap for the code-author principal + its blast-radius
 * fence atoms.
 *
 * Run from repo root (after `npm run build`):
 *   LAG_OPERATOR_ID=<your-id> node scripts/bootstrap-code-author-canon.mjs
 *
 * Grounded in:
 *   design/adr-code-author-principal-bootstrap.md  -- the principal shape.
 *   design/adr-code-author-blast-radius-fence.md   -- the four
 *                                                     pol-code-author-*
 *                                                     policy-atom shapes.
 *
 * Graduation gate: the script refuses to seed unless all four prereqs
 * from the fence ADR are present. The check runs before the first
 * principal write so a missing prereq produces a clean no-op with an
 * actionable list, not a partial seed.
 *
 * Creates (only when all prereqs pass):
 *   1. `code-author` principal, signed_by `claude-agent` (depth 2 from
 *      the operator root). permitted_layers.write = [L0, L1]; L2/L3
 *      unreachable by design so no autonomous canon-promotion path exists.
 *   2. Four L3 policy atoms verbatim from the fence ADR:
 *        - pol-code-author-signed-pr-only
 *        - pol-code-author-per-pr-cost-cap
 *        - pol-code-author-ci-gate
 *        - pol-code-author-write-revocation-on-stop
 *
 * Idempotent per atom / principal id; drift against the expected shape
 * fails loud on a second run (matches the `bootstrap-decisions-canon.mjs`
 * + `bootstrap-inbox-canon.mjs` drift patterns). Principal identity,
 * provenance integrity, and the full policy payload are all in the drift
 * surface so a silent re-attribution under unchanged numeric fields is
 * loud. A rewritten provenance under unchanged policy payload is exactly
 * the class of silent re-attribution this check catches; for a principal
 * that can push commits, that bar is non-negotiable.
 *
 * No hardcoded operator fallback is permitted. The code-author is a
 * principal that can write code to a shared repo; a silent-default
 * operator id would make the write's provenance unverifiable.
 */

import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');
const BOOTSTRAP_TIME = '2026-04-21T00:00:00.000Z';

const OPERATOR_ID = process.env.LAG_OPERATOR_ID;
if (!OPERATOR_ID) {
  console.error(
    '[bootstrap-code-author] ERROR: LAG_OPERATOR_ID is not set. Export it and re-run.\n'
    + '  export LAG_OPERATOR_ID=<your-operator-id>\n',
  );
  process.exit(2);
}

// Canonical agent id. Soft-fallback matches bootstrap-pr-landing-canon.mjs
// and bootstrap-cto-actor-canon.mjs: 'claude-agent' is the project's canonical
// agent-principal id, and every bootstrap script in this repo roots its
// agent chain on it. If a deployment chooses a different agent id, it MUST
// set LAG_AGENT_ID consistently for all bootstrap scripts; setting it for
// one but not the others would fork the principal tree and leave the
// default-id principal orphaned.
//
// The risk this fallback could create (silent re-attribution through a
// freshly-minted 'claude-agent' parent) is closed by the parent-chain
// drift check in ensureParentChain: if an existing claude-agent principal
// has drifted shape (different signed_by, compromised_at, permitted_scopes,
// permitted_layers), the script fails loud rather than adopting the
// compromise into code-author.signed_by.
const CLAUDE_AGENT_ID = process.env.LAG_AGENT_ID || 'claude-agent';
const CODE_AUTHOR_ID = 'code-author';

// Every fence atom links back to the source ADRs so the audit trail from
// a live atom in .lag/atoms/ lands on the frozen shape in design/ without
// a side lookup. `dev-substrate-not-prescription` is the discipline the
// fences embody (policy atoms, not framework constants).
const FENCE_DERIVED_FROM = [
  'adr-code-author-principal-bootstrap',
  'adr-code-author-blast-radius-fence',
  'pol-cto-default-deny',
  'pol-cto-no-merge',
  'inv-kill-switch-first',
  'inv-governance-before-autonomy',
  'inv-l3-requires-human',
  'dev-substrate-not-prescription',
];

const FENCE_ATOMS = [
  {
    id: 'pol-code-author-signed-pr-only',
    content:
      'code-author writes reach the repo only as signed pull requests authored via the '
      + "actor's provisioned GitHub App identity. No direct writes to any tracked path "
      + "(src/, test/, design/, docs/, scripts/, or anywhere else); every mutation must "
      + "be visible in GitHub's review UI so the operator's review gate and the branch-"
      + 'protection ruleset stay load-bearing.',
    policy: {
      subject: 'code-author-authorship',
      output_channel: 'signed-pr',
      allowed_direct_write_paths: [],
      require_app_identity: true,
    },
  },
  {
    id: 'pol-code-author-per-pr-cost-cap',
    content:
      'Hard cap on LLM spend per code-author PR, independent of the per-day budget. '
      + 'pol-inbox-poll-cadence and pol-actor-message-rate cap per-minute and per-day; '
      + 'neither catches a single plan that plans -> codes -> re-plans -> codes in one '
      + 'logical PR until it has burned a large share of the daily budget. Retries count '
      + 'toward the cap so a tight retry loop trips the fence instead of hiding behind '
      + 'per-attempt accounting.',
    policy: {
      subject: 'code-author-per-pr-cost-cap',
      max_usd_per_pr: 10.0,
      include_retries: true,
    },
  },
  {
    id: 'pol-code-author-ci-gate',
    content:
      'A code-author PR is eligible for any auto-approval (PR-landing merge, dispatch '
      + 'of a follow-up plan, anything downstream) only when CI reports success for the '
      + 'named checks AND none of those successes are older than max_check_age_ms. The '
      + 'age bound prevents a stale green check from justifying an auto-merge on a '
      + 'freshly-edited branch. CodeRabbit remains a separate gate; this atom is the '
      + 'CI-correctness floor.',
    policy: {
      subject: 'code-author-ci-gate',
      required_checks: [
        'Node 22 on ubuntu-latest',
        'Node 22 on windows-latest',
        'package hygiene',
      ],
      require_all: true,
      max_check_age_ms: 600_000,
    },
  },
  {
    id: 'pol-code-author-write-revocation-on-stop',
    content:
      'When .lag/STOP is written during a code-author run, the actor halts its current '
      + 'operation, closes (not abandons) any in-progress draft PR with a revocation '
      + 'comment, and writes a code-author-revoked atom so the operator finds a clean '
      + 'state rather than a half-drafted PR sitting open. Drafts preserve in L0 so the '
      + 'operator can re-enter or discard explicitly; halt without closure is the '
      + 'failure mode inv-kill-switch-first is written to prevent.',
    policy: {
      subject: 'code-author-write-revocation',
      on_stop_action: 'close-pr-with-revocation-comment',
      draft_atoms_layer: 'L0',
      revocation_atom_type: 'code-author-revoked',
    },
  },
];

function fenceAtomFromSpec(spec) {
  return {
    schema_version: 1,
    id: spec.id,
    content: spec.content,
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'bootstrap-code-author', agent_id: 'bootstrap' },
      derived_from: FENCE_DERIVED_FROM,
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
      policy: spec.policy,
    },
  };
}

// Drift check covers: shape (type/layer/content), identity (principal_id),
// provenance integrity (kind + source + derived_from), and the full policy
// payload. Every sub-field is load-bearing for a principal that can push
// commits; silent re-attribution under unchanged numeric fields is
// exactly the class of bug this surface catches.
function diffFenceAtom(existing, expected) {
  const diffs = [];
  for (const k of ['type', 'layer', 'content', 'principal_id', 'taint']) {
    if (existing[k] !== expected[k]) {
      diffs.push(`${k}: stored=${JSON.stringify(existing[k])} expected=${JSON.stringify(expected[k])}`);
    }
  }
  const ev = existing.provenance ?? {};
  const xv = expected.provenance;
  if (ev.kind !== xv.kind) {
    diffs.push(`provenance.kind: stored=${JSON.stringify(ev.kind)} expected=${JSON.stringify(xv.kind)}`);
  }
  if (JSON.stringify(ev.source ?? null) !== JSON.stringify(xv.source)) {
    diffs.push('provenance.source differs');
  }
  if (JSON.stringify(ev.derived_from ?? []) !== JSON.stringify(xv.derived_from)) {
    diffs.push('provenance.derived_from differs');
  }
  const ep = existing.metadata?.policy ?? {};
  const xp = expected.metadata.policy;
  const keys = new Set([...Object.keys(ep), ...Object.keys(xp)]);
  for (const k of keys) {
    if (JSON.stringify(ep[k]) !== JSON.stringify(xp[k])) {
      diffs.push(`metadata.policy.${k}: stored=${JSON.stringify(ep[k])} expected=${JSON.stringify(xp[k])}`);
    }
  }
  return diffs;
}

// Shape of the code-author principal, frozen by
// adr-code-author-principal-bootstrap.md. Building it from the env vars
// so the authority chain roots at the caller's operator, never a baked-in
// fallback.
function codeAuthorPrincipal() {
  return {
    id: CODE_AUTHOR_ID,
    name: 'Code Author',
    role: 'agent',
    permitted_scopes: {
      read: ['project'],
      write: ['project'],
    },
    permitted_layers: {
      read: ['L0', 'L1', 'L2', 'L3'],
      write: ['L0', 'L1'],
    },
    goals: [],
    constraints: [],
    active: true,
    compromised_at: null,
    signed_by: CLAUDE_AGENT_ID,
    created_at: BOOTSTRAP_TIME,
  };
}

// Expected shape of the `operator` parent principal. Factored into a builder
// so ensureParentChain seeds it AND drift-checks an existing record against
// the same source of truth. The drift check covers compromised_at and
// permitted_scopes because a mutated parent (e.g. scope broadened, or
// compromised_at cleared under a tainted key) silently re-attributes every
// child's signed_by edge to a weakened parent, and code-author inherits.
function operatorPrincipal() {
  return {
    id: OPERATOR_ID,
    name: 'Apex Agent',
    role: 'apex',
    permitted_scopes: {
      read: ['session', 'project', 'user', 'global'],
      write: ['session', 'project', 'user', 'global'],
    },
    permitted_layers: {
      read: ['L0', 'L1', 'L2', 'L3'],
      write: ['L0', 'L1', 'L2', 'L3'],
    },
    goals: [],
    constraints: [],
    active: true,
    compromised_at: null,
    signed_by: null,
    created_at: BOOTSTRAP_TIME,
  };
}

function claudeAgentPrincipal() {
  return {
    id: CLAUDE_AGENT_ID,
    name: 'Agent (Claude Code instance)',
    role: 'agent',
    permitted_scopes: {
      read: ['session', 'project', 'user', 'global'],
      write: ['session', 'project', 'user'],
    },
    permitted_layers: {
      read: ['L0', 'L1', 'L2', 'L3'],
      write: ['L0', 'L1', 'L2'],
    },
    goals: [],
    constraints: [],
    active: true,
    compromised_at: null,
    signed_by: OPERATOR_ID,
    created_at: BOOTSTRAP_TIME,
  };
}

function diffPrincipal(existing, expected) {
  const diffs = [];
  // compromised_at drift is load-bearing: a stored parent with a
  // non-null compromised_at (or a cleared value under a rotated key)
  // is exactly the class of silent re-attribution this bootstrap
  // exists to prevent. Same reason provenance is in diffFenceAtom.
  for (const k of ['name', 'role', 'signed_by', 'active', 'compromised_at']) {
    if (existing[k] !== expected[k]) {
      diffs.push(`${k}: stored=${JSON.stringify(existing[k])} expected=${JSON.stringify(expected[k])}`);
    }
  }
  for (const k of ['permitted_scopes', 'permitted_layers']) {
    if (JSON.stringify(existing[k]) !== JSON.stringify(expected[k])) {
      diffs.push(`${k}: stored=${JSON.stringify(existing[k])} expected=${JSON.stringify(expected[k])}`);
    }
  }
  return diffs;
}

// Graduation criteria from adr-code-author-blast-radius-fence.md.
// Every prereq is a cheap presence check; failure produces an actionable
// no-op rather than a partial seed. We check prereqs AFTER Host init so
// the host.atoms probe for pol-judgment-fallback-ladder goes through the
// same read path every other consumer uses.
async function verifyGraduationCriteria(host) {
  const missing = [];

  // Criterion 2: D13 medium-tier kill switch. The module's entry point is
  // src/kill-switch/index.ts; its absence means the runtime-revocation
  // primitive that pol-code-author-write-revocation-on-stop depends on
  // has not shipped.
  const killSwitchPath = resolve(REPO_ROOT, 'src', 'kill-switch', 'index.ts');
  if (!existsSync(killSwitchPath)) {
    missing.push('D13 medium-tier kill switch (src/kill-switch/index.ts not found)');
  }

  // Criterion 3: arbitration conflict fuzz. Presence of the test file is
  // the gate; the file actually being green is verified by CI on every
  // PR and is not re-run here.
  const fuzzPath = resolve(REPO_ROOT, 'test', 'arbitration', 'conflict-fuzz.test.ts');
  if (!existsSync(fuzzPath)) {
    missing.push('arbitration conflict fuzz (test/arbitration/conflict-fuzz.test.ts not found)');
  }

  // Criterion 4: judgment fallback ladder is live in canon. Probed via
  // host.atoms so the check honors the same store a consuming actor
  // would read through.
  //
  // Fail-closed on taint + supersession: host.atoms.get returns the atom
  // regardless of `taint` or `superseded_by`, but the runtime policy-read
  // (queryPolicyAtoms + consumer actors) skips dirty/archived/superseded
  // atoms and falls back to the restrictive default. A graduation gate
  // that accepted what the runtime rejects would unblock a principal
  // that can push commits under a policy its live readers ignore, which
  // is exactly the fail-open class of bug reset-validator.ts was written
  // to prevent.
  const ladder = await host.atoms.get('pol-judgment-fallback-ladder');
  if (!ladder) {
    missing.push('pol-judgment-fallback-ladder (not present in the atom store)');
  } else if (ladder.taint !== 'clean') {
    missing.push(`pol-judgment-fallback-ladder (taint=${ladder.taint}, not clean)`);
  } else if ((ladder.superseded_by?.length ?? 0) > 0) {
    missing.push(`pol-judgment-fallback-ladder (superseded by ${ladder.superseded_by.join(', ')})`);
  }

  return missing;
}

async function ensureParentChain(host) {
  // Seed OR drift-check the operator + claude-agent chain so this script
  // is runnable standalone AND surfaces a compromised / tampered parent
  // as loudly as it would a compromised code-author. Earlier versions of
  // this script seeded parents only when absent and silently accepted any
  // existing shape; that is the exact silent-re-attribution class the
  // fence atoms exist to close, applied one hop up. If the parent is
  // tampered, the write that inherits from it is already suspect.
  for (const expected of [operatorPrincipal(), claudeAgentPrincipal()]) {
    const existing = await host.principals.get(expected.id);
    if (!existing) {
      await host.principals.put(expected);
      continue;
    }
    const pdiffs = diffPrincipal(existing, expected);
    if (pdiffs.length > 0) {
      console.error(
        `[bootstrap-code-author] DRIFT on parent principal ${expected.id}:\n  ${pdiffs.join('\n  ')}\n`
        + 'code-author cannot safely inherit a signed_by edge to a drifted '
        + 'parent. Resolve by: (a) aligning the stored parent with the canonical '
        + 'shape, or (b) explicitly revoking the stored parent through an operator '
        + 'tool before re-bootstrapping. No principals or fence atoms have been written.',
      );
      process.exit(1);
    }
  }
}

async function main() {
  await mkdir(STATE_DIR, { recursive: true });
  const host = await createFileHost({ rootDir: STATE_DIR });

  const missing = await verifyGraduationCriteria(host);
  if (missing.length > 0) {
    console.error(
      '[bootstrap-code-author] ABORT: graduation criteria not met. Missing:\n'
      + missing.map((m) => `  - ${m}`).join('\n')
      + '\n\nSee design/adr-code-author-blast-radius-fence.md for the full list.\n'
      + 'No principal or fence atom has been written.',
    );
    process.exit(1);
  }

  await ensureParentChain(host);

  // Seed or drift-check the code-author principal.
  const expectedPrincipal = codeAuthorPrincipal();
  const existingPrincipal = await host.principals.get(CODE_AUTHOR_ID);
  let principalWritten = false;
  if (!existingPrincipal) {
    await host.principals.put(expectedPrincipal);
    principalWritten = true;
  } else {
    const pdiffs = diffPrincipal(existingPrincipal, expectedPrincipal);
    if (pdiffs.length > 0) {
      console.error(
        `[bootstrap-code-author] DRIFT on principal ${CODE_AUTHOR_ID}:\n  ${pdiffs.join('\n  ')}\n`
        + 'Resolve by: (a) aligning this script with the stored principal if that is '
        + 'authoritative, or (b) revoking the stored principal explicitly through an '
        + 'operator tool before re-bootstrapping.',
      );
      process.exit(1);
    }
  }

  // Seed or drift-check each fence atom.
  let written = 0;
  let ok = 0;
  for (const spec of FENCE_ATOMS) {
    const expected = fenceAtomFromSpec(spec);
    const existing = await host.atoms.get(expected.id);
    if (existing === null) {
      await host.atoms.put(expected);
      written += 1;
      console.log(`[bootstrap-code-author] wrote ${expected.id}`);
      continue;
    }
    const diffs = diffFenceAtom(existing, expected);
    if (diffs.length > 0) {
      console.error(
        `[bootstrap-code-author] DRIFT on ${expected.id}:\n  ${diffs.join('\n  ')}\n`
        + 'Resolve by: (a) editing FENCE_ATOMS[] here to match the stored shape if the '
        + 'stored value is authoritative, or (b) bumping the atom id and superseding '
        + 'the old one if you are intentionally changing policy.',
      );
      process.exit(1);
    }
    ok += 1;
  }

  console.log(
    `[bootstrap-code-author] principal ${CODE_AUTHOR_ID} ${principalWritten ? 'written' : 'in sync'}; `
    + `${written} fence atoms written, ${ok} already in sync.`,
  );
}

await main();
