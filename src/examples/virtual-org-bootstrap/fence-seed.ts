/**
 * Blast-radius fence-atom seeder.
 *
 * Ports the four `pol-code-author-*` policy atoms from
 * `scripts/bootstrap-code-author-canon.mjs` verbatim. The shapes match
 * the script so an example runtime that calls `seedFenceAtoms` and a
 * deployment that ran the bootstrap script converge on the same L3
 * canon; drifting here would produce two incompatible sources of truth
 * for a principal that can push commits.
 *
 * Seeding is idempotent per atom id. An atom already in the store is
 * left in place (no drift check here; the bootstrap script remains the
 * authoritative drift guard at re-seed time). This lets a caller
 * rebuild the Host against the same state-dir without a ConflictError.
 */

import type { AtomStore } from '../../substrate/interface.js';
import type { Atom, AtomId, PrincipalId } from '../../substrate/types.js';

const BOOTSTRAP_TIME = '2026-04-21T00:00:00.000Z';

const FENCE_DERIVED_FROM = [
  'adr-code-author-principal-bootstrap',
  'adr-code-author-blast-radius-fence',
  'pol-cto-default-deny',
  'pol-cto-no-merge',
  'inv-kill-switch-first',
  'inv-governance-before-autonomy',
  'inv-l3-requires-human',
  'dev-substrate-not-prescription',
] as const;

interface FenceAtomSpec {
  readonly id: string;
  readonly content: string;
  readonly policy: Readonly<Record<string, unknown>>;
}

const FENCE_ATOM_SPECS: ReadonlyArray<FenceAtomSpec> = [
  {
    id: 'pol-code-author-signed-pr-only',
    content:
      'code-author writes reach the repo only as signed pull requests authored via the '
      + "actor's provisioned GitHub App identity. No direct writes to any tracked path "
      + '(src/, test/, design/, docs/, scripts/, or anywhere else); every mutation must '
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

function fenceAtomFromSpec(spec: FenceAtomSpec, operatorId: PrincipalId): Atom {
  return {
    schema_version: 1,
    id: spec.id as AtomId,
    content: spec.content,
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'bootstrap-code-author', agent_id: 'bootstrap' },
      derived_from: FENCE_DERIVED_FROM.map((id) => id as AtomId),
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
      policy: spec.policy,
    },
  };
}

/**
 * Seed the four blast-radius fence atoms into the provided AtomStore.
 * No-op per atom when that id already exists; safe to call repeatedly.
 */
export async function seedFenceAtoms(
  atoms: AtomStore,
  operatorId: PrincipalId,
): Promise<void> {
  for (const spec of FENCE_ATOM_SPECS) {
    const existing = await atoms.get(spec.id as AtomId);
    if (existing !== null) {
      continue;
    }
    await atoms.put(fenceAtomFromSpec(spec, operatorId));
  }
}

export const FENCE_ATOM_IDS: ReadonlyArray<string> = FENCE_ATOM_SPECS.map((s) => s.id);
