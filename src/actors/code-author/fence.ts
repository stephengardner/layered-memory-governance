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

import type { AtomStore } from '../../substrate/interface.js';
import type { Atom, AtomId, Layer } from '../../substrate/types.js';

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
    if (atom.superseded_by.length > 0) {
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

  // Parse phase: every parser accumulates its own reasons and never
  // throws, so a multi-atom shape drift reports every broken atom in
  // one pass instead of fix-one-rerun-trip-on-next. Matches the
  // discipline the presence/taint/supersession loop above already
  // follows. The type coercion to the policy interfaces at the end
  // is safe because we only reach it after reasons.length === 0.
  const sp = parseSignedPrOnly(loaded.get('pol-code-author-signed-pr-only')!, warnings);
  const cc = parsePerPrCostCap(loaded.get('pol-code-author-per-pr-cost-cap')!, warnings);
  const ci = parseCiGate(loaded.get('pol-code-author-ci-gate')!, warnings);
  const wr = parseWriteRevocationOnStop(loaded.get('pol-code-author-write-revocation-on-stop')!, warnings);

  const parseReasons = [...sp.reasons, ...cc.reasons, ...ci.reasons, ...wr.reasons];
  if (parseReasons.length > 0) {
    throw new CodeAuthorFenceError(
      'code-author fence shape validation failed',
      parseReasons,
    );
  }

  return Object.freeze({
    signedPrOnly: sp.policy!,
    perPrCostCap: cc.policy!,
    ciGate: ci.policy!,
    writeRevocationOnStop: wr.policy!,
    warnings: Object.freeze(warnings.slice()),
  });
}

/**
 * Result of a per-atom parser. Policy is set only when reasons is
 * empty; reasons aggregates every shape failure across the atom so
 * loadCodeAuthorFence can combine them into one error at the end.
 */
interface ParseResult<T> {
  readonly policy?: T;
  readonly reasons: ReadonlyArray<string>;
}

/**
 * Extracts `metadata.policy` as a record, pushing a reason and
 * returning null on any failure. Does not throw so callers can
 * continue gathering reasons from the rest of the atom's shape.
 */
function atomPolicy(atom: Atom, reasons: string[]): Record<string, unknown> | null {
  const md = atom.metadata as { policy?: Record<string, unknown> } | undefined;
  const p = md?.policy;
  if (!p || typeof p !== 'object') {
    reasons.push(`${atom.id}: metadata.policy missing or not an object (stored=${JSON.stringify(atom.metadata)})`);
    return null;
  }
  return p;
}

const EXPECTED_SIGNED_PR_ONLY_KEYS = new Set([
  'subject', 'output_channel', 'allowed_direct_write_paths', 'require_app_identity',
]);

function parseSignedPrOnly(atom: Atom, warnings: string[]): ParseResult<SignedPrOnlyPolicy> {
  const reasons: string[] = [];
  const p = atomPolicy(atom, reasons);
  if (p === null) return { reasons };
  if (p['subject'] !== 'code-author-authorship') {
    reasons.push(`${atom.id}: subject: expected "code-author-authorship", got ${JSON.stringify(p['subject'])}`);
  }
  if (p['output_channel'] !== 'signed-pr') {
    reasons.push(`${atom.id}: output_channel: expected "signed-pr", got ${JSON.stringify(p['output_channel'])}`);
  }
  if (!isNonBlankStringArray(p['allowed_direct_write_paths'])) {
    reasons.push(`${atom.id}: allowed_direct_write_paths: expected string[] with non-blank entries`);
  }
  if (typeof p['require_app_identity'] !== 'boolean') {
    reasons.push(`${atom.id}: require_app_identity: expected boolean`);
  }
  if (reasons.length > 0) return { reasons };
  warnForExtraKeys(atom.id, p, EXPECTED_SIGNED_PR_ONLY_KEYS, warnings);
  return {
    policy: Object.freeze({
      subject: 'code-author-authorship',
      output_channel: 'signed-pr',
      // isStringArray has already asserted every element is a string;
      // the frozen copy below is now guaranteed string[] by construction.
      allowed_direct_write_paths: Object.freeze((p['allowed_direct_write_paths'] as ReadonlyArray<string>).slice()),
      require_app_identity: p['require_app_identity'] as boolean,
    }),
    reasons,
  };
}

const EXPECTED_COST_CAP_KEYS = new Set(['subject', 'max_usd_per_pr', 'include_retries']);

function parsePerPrCostCap(atom: Atom, warnings: string[]): ParseResult<PerPrCostCapPolicy> {
  const reasons: string[] = [];
  const p = atomPolicy(atom, reasons);
  if (p === null) return { reasons };
  if (p['subject'] !== 'code-author-per-pr-cost-cap') {
    reasons.push(`${atom.id}: subject: expected "code-author-per-pr-cost-cap", got ${JSON.stringify(p['subject'])}`);
  }
  const maxUsdPerPr = p['max_usd_per_pr'];
  if (typeof maxUsdPerPr !== 'number' || !Number.isFinite(maxUsdPerPr) || maxUsdPerPr <= 0) {
    reasons.push(`${atom.id}: max_usd_per_pr: expected positive finite number, got ${JSON.stringify(maxUsdPerPr)}`);
  }
  if (typeof p['include_retries'] !== 'boolean') {
    reasons.push(`${atom.id}: include_retries: expected boolean`);
  }
  if (reasons.length > 0) return { reasons };
  warnForExtraKeys(atom.id, p, EXPECTED_COST_CAP_KEYS, warnings);
  return {
    policy: Object.freeze({
      subject: 'code-author-per-pr-cost-cap',
      max_usd_per_pr: maxUsdPerPr as number,
      include_retries: p['include_retries'] as boolean,
    }),
    reasons,
  };
}

const EXPECTED_CI_GATE_KEYS = new Set([
  'subject', 'required_checks', 'require_all', 'max_check_age_ms',
]);

function parseCiGate(atom: Atom, warnings: string[]): ParseResult<CiGatePolicy> {
  const reasons: string[] = [];
  const p = atomPolicy(atom, reasons);
  if (p === null) return { reasons };
  if (p['subject'] !== 'code-author-ci-gate') {
    reasons.push(`${atom.id}: subject: expected "code-author-ci-gate", got ${JSON.stringify(p['subject'])}`);
  }
  const required = p['required_checks'];
  if (!isNonBlankStringArray(required) || (required as ReadonlyArray<string>).length === 0) {
    reasons.push(`${atom.id}: required_checks: expected non-empty string[] with non-blank entries`);
  }
  if (typeof p['require_all'] !== 'boolean') {
    reasons.push(`${atom.id}: require_all: expected boolean`);
  }
  const maxCheckAgeMs = p['max_check_age_ms'];
  if (
    typeof maxCheckAgeMs !== 'number'
    || !Number.isFinite(maxCheckAgeMs)
    || !Number.isInteger(maxCheckAgeMs)
    || maxCheckAgeMs <= 0
  ) {
    reasons.push(`${atom.id}: max_check_age_ms: expected positive finite integer, got ${JSON.stringify(maxCheckAgeMs)}`);
  }
  if (reasons.length > 0) return { reasons };
  warnForExtraKeys(atom.id, p, EXPECTED_CI_GATE_KEYS, warnings);
  return {
    policy: Object.freeze({
      subject: 'code-author-ci-gate',
      required_checks: Object.freeze((p['required_checks'] as ReadonlyArray<string>).slice()),
      require_all: p['require_all'] as boolean,
      max_check_age_ms: maxCheckAgeMs as number,
    }),
    reasons,
  };
}

const EXPECTED_REVOCATION_KEYS = new Set([
  'subject', 'on_stop_action', 'draft_atoms_layer', 'revocation_atom_type',
]);

const LAYERS: ReadonlySet<Layer> = new Set(['L0', 'L1', 'L2', 'L3']);

function parseWriteRevocationOnStop(atom: Atom, warnings: string[]): ParseResult<WriteRevocationOnStopPolicy> {
  const reasons: string[] = [];
  const p = atomPolicy(atom, reasons);
  if (p === null) return { reasons };
  if (p['subject'] !== 'code-author-write-revocation') {
    reasons.push(`${atom.id}: subject: expected "code-author-write-revocation", got ${JSON.stringify(p['subject'])}`);
  }
  if (p['on_stop_action'] !== 'close-pr-with-revocation-comment') {
    reasons.push(`${atom.id}: on_stop_action: expected "close-pr-with-revocation-comment", got ${JSON.stringify(p['on_stop_action'])}`);
  }
  if (typeof p['draft_atoms_layer'] !== 'string' || !LAYERS.has(p['draft_atoms_layer'] as Layer)) {
    reasons.push(`${atom.id}: draft_atoms_layer: expected one of L0..L3, got ${JSON.stringify(p['draft_atoms_layer'])}`);
  }
  if (typeof p['revocation_atom_type'] !== 'string' || p['revocation_atom_type'] === '') {
    reasons.push(`${atom.id}: revocation_atom_type: expected non-empty string`);
  }
  if (reasons.length > 0) return { reasons };
  warnForExtraKeys(atom.id, p, EXPECTED_REVOCATION_KEYS, warnings);
  return {
    policy: Object.freeze({
      subject: 'code-author-write-revocation',
      on_stop_action: 'close-pr-with-revocation-comment',
      draft_atoms_layer: p['draft_atoms_layer'] as Layer,
      revocation_atom_type: p['revocation_atom_type'] as string,
    }),
    reasons,
  };
}

// Strict array-of-non-blank-strings check. Array.isArray alone passes
// on [123, true, {}]; the silent String() coercion path would then
// produce `["123", "true", "[object Object]"]`. An all-string array
// still admits `['']` or `['   ']`, which widens downstream prefix
// checks (allowed_direct_write_paths) or weakens the CI-gate contract
// (required_checks); a blank entry is almost always a canon typo that
// reads like intent. Require non-blank so both failure modes surface
// as explicit drift rather than silently weakening policy.
function isNonBlankStringArray(v: unknown): v is ReadonlyArray<string> {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim().length > 0);
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
