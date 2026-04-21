/**
 * Fence-atom loader for the code-author actor.
 *
 * Reads the four `pol-code-author-*` policy atoms from the AtomStore,
 * validates their shapes, and returns a typed `CodeAuthorFence` that
 * actor code consumes in place of hardcoded constants. Every fence
 * constant is a canon edit away from change; the fence-loader is the
 * single point where that canon is lifted into code.
 *
 * Fail-closed on three axes, matching the graduation-gate discipline
 * the bootstrap enforces:
 *
 *   1. Presence       -- any of the four atoms missing => failure.
 *   2. Taint          -- `taint !== 'clean'` => failure.
 *   3. Supersession   -- `superseded_by.length > 0` => failure.
 *
 * Runtime policy reads (and the bootstrap graduation gate) already
 * apply the same three filters; loading fences through a permissive
 * reader would let the actor operate under a policy its own governance
 * rejects. For a principal that can push commits, that asymmetry is
 * the class of silent-fail the fence exists to prevent.
 *
 * Shape validation on each atom is strict: unexpected payload keys
 * surface as warnings in the returned `CodeAuthorFence.warnings`
 * array but do not fail the load (canon may carry forward-compatible
 * additions). Missing required keys DO fail so an under-specified
 * atom cannot masquerade as a valid fence.
 */

import type { AtomStore } from '../../interface.js';
import type { Atom, AtomId, Layer } from '../../types.js';

export const FENCE_ATOM_IDS = [
  'pol-code-author-signed-pr-only',
  'pol-code-author-per-pr-cost-cap',
  'pol-code-author-ci-gate',
  'pol-code-author-write-revocation-on-stop',
] as const;

export type FenceAtomId = (typeof FENCE_ATOM_IDS)[number];

export interface SignedPrOnlyPolicy {
  readonly subject: 'code-author-authorship';
  readonly output_channel: 'signed-pr';
  readonly allowed_direct_write_paths: ReadonlyArray<string>;
  readonly require_app_identity: boolean;
}

export interface PerPrCostCapPolicy {
  readonly subject: 'code-author-per-pr-cost-cap';
  readonly max_usd_per_pr: number;
  readonly include_retries: boolean;
}

export interface CiGatePolicy {
  readonly subject: 'code-author-ci-gate';
  readonly required_checks: ReadonlyArray<string>;
  readonly require_all: boolean;
  readonly max_check_age_ms: number;
}

export interface WriteRevocationOnStopPolicy {
  readonly subject: 'code-author-write-revocation';
  readonly on_stop_action: 'close-pr-with-revocation-comment';
  readonly draft_atoms_layer: Layer;
  readonly revocation_atom_type: string;
}

export interface CodeAuthorFence {
  readonly signedPrOnly: SignedPrOnlyPolicy;
  readonly perPrCostCap: PerPrCostCapPolicy;
  readonly ciGate: CiGatePolicy;
  readonly writeRevocationOnStop: WriteRevocationOnStopPolicy;
  /**
   * Non-fatal warnings surfaced during validation (e.g., unexpected
   * forward-compatible keys). The actor runner prints these so
   * operators see drift hints without the load failing.
   */
  readonly warnings: ReadonlyArray<string>;
}

export class CodeAuthorFenceError extends Error {
  constructor(message: string, public readonly reasons: ReadonlyArray<string>) {
    super(`${message}:\n  - ${reasons.join('\n  - ')}`);
    this.name = 'CodeAuthorFenceError';
  }
}

/**
 * Load + validate the four fence atoms. Throws `CodeAuthorFenceError`
 * on any failure; a thrown load is terminal for the calling actor
 * since the authority grant rests on the fences being live.
 */
export async function loadCodeAuthorFence(atoms: AtomStore): Promise<CodeAuthorFence> {
  const failures: string[] = [];
  const warnings: string[] = [];
  const loaded = new Map<FenceAtomId, Atom>();

  for (const id of FENCE_ATOM_IDS) {
    const atom = await atoms.get(id as unknown as AtomId);
    if (!atom) {
      failures.push(`${id}: atom not present in store`);
      continue;
    }
    if (atom.taint !== 'clean') {
      failures.push(`${id}: taint=${atom.taint}, not clean`);
      continue;
    }
    if ((atom.superseded_by?.length ?? 0) > 0) {
      failures.push(`${id}: superseded by ${atom.superseded_by.join(', ')}`);
      continue;
    }
    loaded.set(id, atom);
  }

  if (failures.length > 0) {
    throw new CodeAuthorFenceError(
      'code-author fence load failed; actor cannot run under an incomplete or tainted fence',
      failures,
    );
  }

  const signedPrOnly = parseSignedPrOnly(
    loaded.get('pol-code-author-signed-pr-only')!, warnings,
  );
  const perPrCostCap = parsePerPrCostCap(
    loaded.get('pol-code-author-per-pr-cost-cap')!, warnings,
  );
  const ciGate = parseCiGate(
    loaded.get('pol-code-author-ci-gate')!, warnings,
  );
  const writeRevocationOnStop = parseWriteRevocationOnStop(
    loaded.get('pol-code-author-write-revocation-on-stop')!, warnings,
  );

  return Object.freeze({
    signedPrOnly,
    perPrCostCap,
    ciGate,
    writeRevocationOnStop,
    warnings: Object.freeze(warnings.slice()),
  });
}

function atomPolicy(atom: Atom): Record<string, unknown> {
  const md = atom.metadata as { policy?: Record<string, unknown> } | undefined;
  const p = md?.policy;
  if (!p || typeof p !== 'object') {
    throw new CodeAuthorFenceError(
      `${atom.id}: metadata.policy missing or not an object`,
      [`stored metadata=${JSON.stringify(atom.metadata)}`],
    );
  }
  return p;
}

const EXPECTED_SIGNED_PR_ONLY_KEYS = new Set([
  'subject', 'output_channel', 'allowed_direct_write_paths', 'require_app_identity',
]);

function parseSignedPrOnly(atom: Atom, warnings: string[]): SignedPrOnlyPolicy {
  const p = atomPolicy(atom);
  const reasons: string[] = [];
  if (p['subject'] !== 'code-author-authorship') {
    reasons.push(`subject: expected "code-author-authorship", got ${JSON.stringify(p['subject'])}`);
  }
  if (p['output_channel'] !== 'signed-pr') {
    reasons.push(`output_channel: expected "signed-pr", got ${JSON.stringify(p['output_channel'])}`);
  }
  if (!Array.isArray(p['allowed_direct_write_paths'])) {
    reasons.push('allowed_direct_write_paths: expected array');
  }
  if (typeof p['require_app_identity'] !== 'boolean') {
    reasons.push('require_app_identity: expected boolean');
  }
  if (reasons.length > 0) {
    throw new CodeAuthorFenceError(`${atom.id}: invalid policy shape`, reasons);
  }
  warnForExtraKeys(atom.id, p, EXPECTED_SIGNED_PR_ONLY_KEYS, warnings);
  return Object.freeze({
    subject: 'code-author-authorship',
    output_channel: 'signed-pr',
    allowed_direct_write_paths: Object.freeze((p['allowed_direct_write_paths'] as ReadonlyArray<unknown>).map(String)),
    require_app_identity: p['require_app_identity'] as boolean,
  });
}

const EXPECTED_COST_CAP_KEYS = new Set(['subject', 'max_usd_per_pr', 'include_retries']);

function parsePerPrCostCap(atom: Atom, warnings: string[]): PerPrCostCapPolicy {
  const p = atomPolicy(atom);
  const reasons: string[] = [];
  if (p['subject'] !== 'code-author-per-pr-cost-cap') {
    reasons.push(`subject: expected "code-author-per-pr-cost-cap", got ${JSON.stringify(p['subject'])}`);
  }
  if (typeof p['max_usd_per_pr'] !== 'number' || !(p['max_usd_per_pr'] as number > 0)) {
    reasons.push(`max_usd_per_pr: expected positive number, got ${JSON.stringify(p['max_usd_per_pr'])}`);
  }
  if (typeof p['include_retries'] !== 'boolean') {
    reasons.push('include_retries: expected boolean');
  }
  if (reasons.length > 0) {
    throw new CodeAuthorFenceError(`${atom.id}: invalid policy shape`, reasons);
  }
  warnForExtraKeys(atom.id, p, EXPECTED_COST_CAP_KEYS, warnings);
  return Object.freeze({
    subject: 'code-author-per-pr-cost-cap',
    max_usd_per_pr: p['max_usd_per_pr'] as number,
    include_retries: p['include_retries'] as boolean,
  });
}

const EXPECTED_CI_GATE_KEYS = new Set([
  'subject', 'required_checks', 'require_all', 'max_check_age_ms',
]);

function parseCiGate(atom: Atom, warnings: string[]): CiGatePolicy {
  const p = atomPolicy(atom);
  const reasons: string[] = [];
  if (p['subject'] !== 'code-author-ci-gate') {
    reasons.push(`subject: expected "code-author-ci-gate", got ${JSON.stringify(p['subject'])}`);
  }
  if (!Array.isArray(p['required_checks']) || (p['required_checks'] as ReadonlyArray<unknown>).length === 0) {
    reasons.push('required_checks: expected non-empty array');
  }
  if (typeof p['require_all'] !== 'boolean') {
    reasons.push('require_all: expected boolean');
  }
  if (typeof p['max_check_age_ms'] !== 'number' || !(p['max_check_age_ms'] as number > 0)) {
    reasons.push(`max_check_age_ms: expected positive number, got ${JSON.stringify(p['max_check_age_ms'])}`);
  }
  if (reasons.length > 0) {
    throw new CodeAuthorFenceError(`${atom.id}: invalid policy shape`, reasons);
  }
  warnForExtraKeys(atom.id, p, EXPECTED_CI_GATE_KEYS, warnings);
  return Object.freeze({
    subject: 'code-author-ci-gate',
    required_checks: Object.freeze((p['required_checks'] as ReadonlyArray<unknown>).map(String)),
    require_all: p['require_all'] as boolean,
    max_check_age_ms: p['max_check_age_ms'] as number,
  });
}

const EXPECTED_REVOCATION_KEYS = new Set([
  'subject', 'on_stop_action', 'draft_atoms_layer', 'revocation_atom_type',
]);

const LAYERS: ReadonlySet<Layer> = new Set(['L0', 'L1', 'L2', 'L3']);

function parseWriteRevocationOnStop(atom: Atom, warnings: string[]): WriteRevocationOnStopPolicy {
  const p = atomPolicy(atom);
  const reasons: string[] = [];
  if (p['subject'] !== 'code-author-write-revocation') {
    reasons.push(`subject: expected "code-author-write-revocation", got ${JSON.stringify(p['subject'])}`);
  }
  if (p['on_stop_action'] !== 'close-pr-with-revocation-comment') {
    reasons.push(`on_stop_action: expected "close-pr-with-revocation-comment", got ${JSON.stringify(p['on_stop_action'])}`);
  }
  if (typeof p['draft_atoms_layer'] !== 'string' || !LAYERS.has(p['draft_atoms_layer'] as Layer)) {
    reasons.push(`draft_atoms_layer: expected one of L0..L3, got ${JSON.stringify(p['draft_atoms_layer'])}`);
  }
  if (typeof p['revocation_atom_type'] !== 'string' || p['revocation_atom_type'] === '') {
    reasons.push('revocation_atom_type: expected non-empty string');
  }
  if (reasons.length > 0) {
    throw new CodeAuthorFenceError(`${atom.id}: invalid policy shape`, reasons);
  }
  warnForExtraKeys(atom.id, p, EXPECTED_REVOCATION_KEYS, warnings);
  return Object.freeze({
    subject: 'code-author-write-revocation',
    on_stop_action: 'close-pr-with-revocation-comment',
    draft_atoms_layer: p['draft_atoms_layer'] as Layer,
    revocation_atom_type: p['revocation_atom_type'] as string,
  });
}

function warnForExtraKeys(
  atomId: string,
  payload: Record<string, unknown>,
  expected: ReadonlySet<string>,
  warnings: string[],
): void {
  for (const k of Object.keys(payload)) {
    if (!expected.has(k)) {
      warnings.push(`${atomId}: unexpected key ${JSON.stringify(k)} (forward-compatible; ignored)`);
    }
  }
}
