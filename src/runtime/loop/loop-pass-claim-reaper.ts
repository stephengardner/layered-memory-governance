/**
 * Claim-reaper loop-pass canon-policy reader.
 *
 * Mirrors the shape of `./pipeline-reaper-ttls.ts` so the two tunable
 * substrate knobs (pipeline reaper TTLs, claim reaper enable) reuse
 * one read pattern across the loop directory. Promotes the claim-
 * reaper enable knob that the LoopRunner consumes from CLI flags +
 * env vars (today: nothing -- the pass defaults off) to a canon
 * policy atom so deployments tune the cadence at scope boundaries
 * without a framework release. The knob is tuning data, not code;
 * tunable enable belongs in canon, not constants.
 *
 * Substrate purity: the reader is mechanism-only. It scans canon
 * directive atoms for `metadata.policy.subject ===
 * 'loop-pass-claim-reaper-default'`, matching the read shape of
 * `readPipelineReaperTtlsFromCanon` so future maintainers see one
 * pattern, not two.
 *
 * Resolution chain at the call site (LoopRunner.claimReaperPass):
 *   1. canon policy atom (this reader): preferred, deployment-tunable
 *   2. `LoopOptions.runClaimReaperPass` (CLI / env): fallback
 *   3. hardcoded default: `false` (indie-floor: opt-in per spec)
 *
 * Loud-fail at the layer boundary: when a policy atom EXISTS but its
 * payload is malformed (`enabled` not a boolean), the reader logs a
 * warning to stderr naming the bad field and returns `null` so the
 * caller falls through to the env / hardcoded default. The operator
 * sees the warning rather than a silent default substitution.
 */

import type { Host } from '../../interface.js';

/**
 * Policy atom subject discriminator. Mirrors the convention of the
 * other tunable dials (`reaper-ttls`, `pipeline-reaper-ttls`,
 * `loop-pass-pr-observation-refresh-default`).
 */
const POLICY_SUBJECT = 'loop-pass-claim-reaper-default';

/**
 * Resolved claim-reaper enable knob shape. A struct (not a bare
 * boolean) so future fields (e.g. per-tier cadence, scope filter,
 * resume-strategy override) extend the policy atom without changing
 * this reader's return type or its call site in `LoopRunner.claimReaperPass`.
 */
export interface LoopPassClaimReaperPolicy {
  readonly enabled: boolean;
}

/**
 * Read the configured claim-reaper enable knob from canon. Returns
 * the validated struct when a clean, non-superseded policy atom with
 * subject='loop-pass-claim-reaper-default' exists and carries a well-
 * formed payload. Returns `null` when:
 *   - no policy atom exists (caller falls through to env / default)
 *   - the policy atom exists but its payload is malformed (caller
 *     logs and falls through; the warning is emitted by this reader
 *     so the operator sees the boundary-failure signal)
 *
 * Validation rule: `enabled` must be a strict boolean. Coercion via
 * `Boolean(...)` is wrong because the string `"false"` is truthy --
 * silently flipping an operator-typed `"false"` to `true` would lie
 * about the configured posture. A non-boolean falls through to the
 * default with a stderr warning.
 *
 * Substrate purity: the reader never throws on malformed canon. A
 * malformed policy atom is operator data, not framework state;
 * failing the boot would take the claim reaper offline because
 * someone fat-fingered a JSON value. Falling through to env / default
 * keeps the loop alive while surfacing the error.
 */
export async function readLoopPassClaimReaperFromCanon(
  host: Host,
): Promise<LoopPassClaimReaperPolicy | null> {
  const PAGE_SIZE = 200;
  let cursor: string | undefined;
  do {
    const page = await host.atoms.query({ type: ['directive'] }, PAGE_SIZE, cursor);
    for (const atom of page.atoms) {
      if (atom.taint !== 'clean') continue;
      if (atom.superseded_by.length > 0) continue;
      // Guard the metadata shape before indexing. Atom.metadata is a
      // best-effort record on the substrate side -- a JSON write that
      // dropped the field, an externally-edited atom file, or a future
      // schema migration could leave it null/undefined/non-object.
      // Indexing through `as Record<string, unknown>` would TypeError on
      // those shapes and break the documented fail-soft posture
      // (malformed operator data must warn + null, never throw).
      const meta = atom.metadata;
      if (typeof meta !== 'object' || meta === null) continue;
      const policy = (meta as Record<string, unknown>)['policy'] as
        | Record<string, unknown>
        | undefined;
      if (!policy || policy['subject'] !== POLICY_SUBJECT) continue;
      // Strict-typed read: only `true` / `false` round-trip; any other
      // shape (string, number, null, missing) is a malformed payload.
      // See doc-comment above for why coercion is wrong.
      const raw = policy['enabled'];
      if (typeof raw !== 'boolean') {
        // eslint-disable-next-line no-console
        console.error(
          `[loop-pass-claim-reaper] WARN: policy atom '${atom.id}' has malformed `
          + `payload (enabled=${JSON.stringify(raw)}); falling through to env / hardcoded `
          + 'default. Field must be a strict boolean.',
        );
        return null;
      }
      return { enabled: raw };
    }
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);
  return null;
}
