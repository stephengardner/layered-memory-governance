/**
 * Blast-radius fence-atom seeder.
 *
 * Ports the four policy atoms from the canon bootstrap script
 * verbatim. The shapes must match the script so an example runtime
 * that calls `seedFenceAtoms` and a deployment that ran the bootstrap
 * script converge on the same L3 canon; drifting here would produce
 * two incompatible sources of truth for a principal that can push
 * commits.
 *
 * Idempotency with drift guard: when an atom with the same id is
 * already present, every field load-bearing for provenance and policy
 * integrity (content, type, layer, scope, taint, principal_id,
 * provenance.kind, provenance.source, provenance.derived_from, and
 * metadata.policy) is compared against the canonical shape. A mismatch
 * throws a clear error naming the atom id and the drifted fields.
 * Identity alone is not a license to skip validation; a tampered or
 * upgraded atom surviving rebuild silently would defeat the fence's
 * purpose.
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
 *
 * Idempotent with a drift guard: when an atom with the same id already
 * exists, every integrity-load-bearing field is compared against the
 * canonical shape. A mismatch throws a `FenceDriftError` naming the
 * atom id and the drifted fields; a match is a silent no-op. A fresh
 * slot is written via `put`.
 */
export async function seedFenceAtoms(
  atoms: AtomStore,
  operatorId: PrincipalId,
): Promise<void> {
  for (const spec of FENCE_ATOM_SPECS) {
    const expected = fenceAtomFromSpec(spec, operatorId);
    const existing = await atoms.get(spec.id as AtomId);
    if (existing !== null) {
      const mismatches = diffFenceAtom(existing, expected);
      if (mismatches.length > 0) {
        throw new FenceDriftError(spec.id, mismatches);
      }
      continue;
    }
    await atoms.put(expected);
  }
}

export const FENCE_ATOM_IDS: ReadonlyArray<string> = FENCE_ATOM_SPECS.map((s) => s.id);

/**
 * Error thrown when an existing atom in the store differs from the
 * canonical fence-atom shape on any integrity-load-bearing field.
 * Carries the atom id and the list of drifted fields for operator
 * triage.
 */
export class FenceDriftError extends Error {
  readonly atomId: string;
  readonly fields: ReadonlyArray<string>;

  constructor(atomId: string, fields: ReadonlyArray<string>) {
    super(
      `fence atom ${atomId} drifted from canonical shape on fields: ${fields.join(', ')}. `
      + 'Re-run the canon bootstrap script to restore the authoritative shape.',
    );
    this.name = 'FenceDriftError';
    this.atomId = atomId;
    this.fields = fields;
  }
}

/**
 * Compare two fence atoms field-by-field on the set that must match
 * for the fence to function. Returns the list of mismatched field
 * names (empty when everything matches).
 *
 * Not checked: created_at / last_reinforced_at (timestamps shift with
 * bootstrap re-runs), confidence (fence confidence is always 1.0 and
 * not load-bearing for the authority grant).
 */
function diffFenceAtom(existing: Atom, expected: Atom): ReadonlyArray<string> {
  const drifted: string[] = [];
  if (existing.content !== expected.content) drifted.push('content');
  if (existing.type !== expected.type) drifted.push('type');
  if (existing.layer !== expected.layer) drifted.push('layer');
  if (existing.scope !== expected.scope) drifted.push('scope');
  if (existing.taint !== expected.taint) drifted.push('taint');
  if (existing.principal_id !== expected.principal_id) {
    drifted.push('principal_id');
  }
  if (existing.provenance.kind !== expected.provenance.kind) {
    drifted.push('provenance.kind');
  }
  if (stableJson(existing.provenance.source) !== stableJson(expected.provenance.source)) {
    drifted.push('provenance.source');
  }
  if (stableJson(existing.provenance.derived_from) !== stableJson(expected.provenance.derived_from)) {
    drifted.push('provenance.derived_from');
  }
  const existingPolicy = (existing.metadata as Record<string, unknown>)?.['policy'];
  const expectedPolicy = (expected.metadata as Record<string, unknown>)?.['policy'];
  if (stableJson(existingPolicy) !== stableJson(expectedPolicy)) {
    drifted.push('metadata.policy');
  }
  if (stableJson(existing.superseded_by) !== stableJson(expected.superseded_by)) {
    drifted.push('superseded_by');
  }
  if (stableJson(existing.supersedes) !== stableJson(expected.supersedes)) {
    drifted.push('supersedes');
  }
  return drifted;
}

/**
 * Stable stringify for comparison. Object keys serialize in insertion
 * order; both sides of the comparison are produced from the same code
 * path in this file, so a structural-equality string match is
 * sufficient for the shapes the fence carries (no arbitrary user
 * objects). Arrays serialize by index, preserving order.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(value);
}
