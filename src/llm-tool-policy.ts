/**
 * Per-principal LLM tool policy loader.
 *
 * Reads the canonical policy atom (`pol-llm-tool-policy-<principal-id>`)
 * from the atom store and returns the deny-list the caller should
 * forward to the LLM implementation via `LlmOptions.disallowedTools`.
 *
 * Why this exists
 * ---------------
 * `src/adapters/claude-cli/llm.ts` ships a `DEFAULT_DISALLOWED_TOOLS`
 * that denies every code-interacting tool for every actor. That
 * posture is correct for the zero-config safety floor but too
 * restrictive for real actors: planners grounding plans in tactical
 * claims need `Read + Grep + Glob`, executors drafting diffs need
 * the same. The framework must not hardcode per-actor policy; the
 * shape of what each actor can read is a governance concern, not a
 * code-release concern, per `dev-substrate-not-prescription`.
 *
 * This loader is the seam: actors (or their runners) call
 * `loadLlmToolPolicy(atoms, principalId)` before invoking
 * `host.llm.judge(...)`, forward the returned deny-list as
 * `LlmOptions.disallowedTools`, and tuning is a canon edit.
 *
 * Fail-closed discipline
 * ----------------------
 * The loader mirrors the discipline applied to every other policy
 * read in this codebase (pol-judgment-fallback-ladder, the fence
 * atoms, reset-validator):
 *
 *   1. Missing atom       -> return null (caller falls back to
 *                            implementation default, which IS a
 *                            deny-all floor; not more permissive).
 *   2. Tainted atom       -> return null (caller falls back; a
 *                            compromised policy must not silently
 *                            broaden tool access).
 *   3. Superseded atom    -> return null (same reason).
 *   4. Malformed payload  -> throw, so a canon edit that produces
 *                            an un-parsable policy atom fails loud
 *                            rather than silently widening access.
 *
 * Null is "no policy found"; the caller treats it as "use the
 * adapter default." This is strictly less permissive than adding a
 * fallback policy here: we never infer permissions, only read
 * them.
 */

import type { AtomStore } from './substrate/interface.js';
import type { AtomId, PrincipalId } from './substrate/types.js';

/**
 * Canonical atom-id prefix. The per-principal atom lives at
 * `pol-llm-tool-policy-<principal-id>`.
 */
export const LLM_TOOL_POLICY_PREFIX = 'pol-llm-tool-policy-';

export interface LlmToolPolicy {
  readonly principalId: PrincipalId;
  readonly disallowedTools: ReadonlyArray<string>;
  /** Optional human-readable rationale; carried through for audit. */
  readonly rationale?: string;
}

export class LlmToolPolicyError extends Error {
  constructor(message: string, public readonly reasons: ReadonlyArray<string>) {
    super(`${message}:\n  - ${reasons.join('\n  - ')}`);
    this.name = 'LlmToolPolicyError';
  }
}

export function llmToolPolicyAtomId(principalId: PrincipalId | string): AtomId {
  return `${LLM_TOOL_POLICY_PREFIX}${String(principalId)}` as AtomId;
}

/**
 * Load the per-principal LLM tool policy.
 *
 * Returns null when no policy atom is present, or when the atom is
 * tainted / superseded (fail-closed: caller uses adapter default,
 * which is deny-all). Throws `LlmToolPolicyError` on a malformed
 * payload so a canon edit that accidentally produces an unparsable
 * atom surfaces at the first call, not silently later.
 */
export async function loadLlmToolPolicy(
  atoms: AtomStore,
  principalId: PrincipalId,
): Promise<LlmToolPolicy | null> {
  const atom = await atoms.get(llmToolPolicyAtomId(principalId));
  if (!atom) return null;
  if (atom.taint !== 'clean') return null;
  if (atom.superseded_by.length > 0) return null;

  const md = atom.metadata as { policy?: Record<string, unknown> } | undefined;
  const p = md?.policy;
  if (!p || typeof p !== 'object') {
    throw new LlmToolPolicyError(
      `${atom.id}: metadata.policy missing or not an object`,
      [`stored metadata=${JSON.stringify(atom.metadata)}`],
    );
  }

  const reasons: string[] = [];
  if (p['subject'] !== 'llm-tool-policy') {
    reasons.push(`subject: expected "llm-tool-policy", got ${JSON.stringify(p['subject'])}`);
  }
  if (p['principal'] !== String(principalId)) {
    reasons.push(
      `principal: expected ${JSON.stringify(String(principalId))}, got ${JSON.stringify(p['principal'])}`,
    );
  }
  if (!isStringArray(p['disallowed_tools'])) {
    reasons.push('disallowed_tools: expected string[] (empty array is valid; a blank string entry is not)');
  }
  if (p['rationale'] !== undefined && typeof p['rationale'] !== 'string') {
    reasons.push(`rationale: expected string or undefined, got ${JSON.stringify(p['rationale'])}`);
  }
  if (reasons.length > 0) {
    throw new LlmToolPolicyError(`${atom.id}: invalid policy shape`, reasons);
  }

  return Object.freeze({
    principalId,
    disallowedTools: Object.freeze((p['disallowed_tools'] as ReadonlyArray<string>).slice()),
    ...(typeof p['rationale'] === 'string' ? { rationale: p['rationale'] } : {}),
  });
}

// Strict string-array check: blank-string members rejected. A blank
// tool name in the deny-list is almost always a canon typo and would
// widen the `--disallowedTools <space-joined>` surface unpredictably
// (Claude CLI accepts trailing empties but the semantics are
// unspecified). Reject loudly.
function isStringArray(v: unknown): v is ReadonlyArray<string> {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim().length > 0);
}
