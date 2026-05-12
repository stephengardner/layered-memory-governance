/**
 * Plan-stage validator-retry canon-policy reader.
 *
 * Mirrors the shape of `./auditor-feedback-reprompt-config.ts` so the
 * two tunable retry knobs at the planning-pipeline layer (auditor-
 * feedback teach-back, plan-stage validator-retry) reuse one read
 * pattern. The dial -- HOW MANY attempts + WHICH error patterns are
 * recoverable -- belongs in canon, not constants. Lifting it from a
 * hardcoded floor to a policy atom lets deployments tune the cadence
 * at scope boundaries without a framework release.
 *
 * Substrate purity: the reader is mechanism-only. It scans canon
 * directive atoms for
 * `metadata.policy.subject === 'plan-stage-validator-retry-default'`,
 * matching the L3-only read shape of `readAuditorFeedbackRePromptPolicy`
 * so future maintainers see one pattern, not two.
 *
 * Resolution chain at the call site (runner's schema-validation block):
 *   1. canon policy atom (this reader): preferred, deployment-tunable
 *   2. hardcoded default (HARDCODED_DEFAULT below): indie-floor floor
 *
 * Loud-fail-recoverable at the layer boundary: when a policy atom
 * EXISTS but its payload is malformed (`max_attempts` not a positive
 * integer, `recoverable_error_patterns` not a string array), the
 * reader logs a warning to stderr naming the bad field and returns
 * `null` so the caller falls through to the hardcoded default. The
 * operator sees the warning rather than a silent default substitution;
 * the policy atom itself remains the audit trail of what they tried to
 * set.
 */

import type { Host } from '../../substrate/interface.js';
import type { PlanStageValidatorRetryConfig } from './plan-stage-validator-retry.js';

/**
 * Policy atom subject discriminator. Mirrors the convention of the
 * other tunable dials (`auditor-feedback-reprompt-default`,
 * `loop-pass-claim-reaper-default`).
 */
const POLICY_SUBJECT = 'plan-stage-validator-retry-default';

/**
 * Hardcoded floor used when no canon atom resolves. Matches the default
 * shipped seed (max_attempts=2, recoverable_error_patterns=
 * ['schema-validation-failed']): at most one retry, triggered by the
 * wholesale schema-validation-failed category the runner currently
 * prefixes every zod failure with. An org-ceiling deployment that
 * wants finer control (retry only on specific Zod error paths) lands a
 * higher-priority `pol-plan-stage-validator-retry-default` atom with a
 * narrowed `recoverable_error_patterns` list via a deliberate canon
 * edit, not a global toggle. The indie floor + org ceiling discipline
 * is what motivates the default-deny posture on max_attempts (no
 * widening without explicit canon).
 *
 * Exported so the bootstrap script (and any test that wants to assert
 * the seeded canon matches the hardcoded floor) reads a single
 * constant rather than duplicating the values.
 */
export const HARDCODED_DEFAULT: PlanStageValidatorRetryConfig = {
  max_attempts: 2,
  recoverable_error_patterns: ['schema-validation-failed'],
};

/**
 * Read the configured plan-stage validator-retry config from canon.
 * Returns the validated struct when a clean, non-superseded L3 policy
 * atom with subject='plan-stage-validator-retry-default' exists and
 * carries a well-formed payload. Returns `null` when:
 *   - no policy atom exists (caller falls through to HARDCODED_DEFAULT)
 *   - the policy atom exists but its payload is malformed (caller
 *     logs and falls through; the warning is emitted by this reader
 *     so the operator sees the boundary-failure signal)
 *
 * Validation rules:
 *   - `max_attempts` must be a positive integer.
 *   - `recoverable_error_patterns` must be an array of non-empty
 *     strings. Empty array is valid -- it explicitly disables the
 *     retry loop while keeping the policy atom present.
 *
 * Substrate purity: the reader never throws on malformed canon. A
 * malformed policy atom is operator data, not framework state; failing
 * the runner boot would take the entire pipeline offline because
 * someone fat-fingered a JSON value. Falling through to the hardcoded
 * default keeps the pipeline alive while surfacing the error.
 */
export async function readPlanStageValidatorRetryPolicy(
  host: Host,
): Promise<PlanStageValidatorRetryConfig | null> {
  const PAGE_SIZE = 200;
  let cursor: string | undefined;
  do {
    // Constrain to L3 (canonical layer) so a same-subject non-canon
    // directive (L0/L1/L2) cannot impersonate authoritative canon.
    // Mirrors the L3-only scan in `auditor-feedback-reprompt-config.ts`;
    // without this filter an attacker-or-mistake L0/L1 atom with the
    // same subject discriminator could widen the retry surface.
    const page = await host.atoms.query(
      { type: ['directive'], layer: ['L3'] },
      PAGE_SIZE,
      cursor,
    );
    for (const atom of page.atoms) {
      if (atom.taint !== 'clean') continue;
      if (atom.superseded_by.length > 0) continue;
      // Guard the metadata shape before indexing. Atom.metadata is a
      // best-effort record on the substrate side -- a JSON write that
      // dropped the field, an externally-edited atom file, or a future
      // schema migration could leave it null/undefined/non-object.
      // Indexing through `as Record<string, unknown>` would TypeError on
      // those shapes and break the fail-soft posture (malformed
      // operator data must warn + null, never throw).
      const meta = atom.metadata;
      if (typeof meta !== 'object' || meta === null) continue;
      const policy = (meta as Record<string, unknown>)['policy'] as
        | Record<string, unknown>
        | undefined;
      if (!policy || policy['subject'] !== POLICY_SUBJECT) continue;
      // Strict-typed read on max_attempts.
      const rawMax = policy['max_attempts'];
      if (
        typeof rawMax !== 'number'
        || !Number.isInteger(rawMax)
        || rawMax < 1
      ) {
        // eslint-disable-next-line no-console
        console.error(
          `[plan-stage-validator-retry] WARN: policy atom '${atom.id}' has malformed `
            + `payload (max_attempts=${JSON.stringify(rawMax)}); falling through to hardcoded `
            + 'default. Field must be a positive integer.',
        );
        return null;
      }
      // Strict-typed read on recoverable_error_patterns. Empty array is
      // valid (explicit disable); any non-array OR an array element
      // that is not a non-empty string falls through to default with a
      // warning.
      const rawPatterns = policy['recoverable_error_patterns'];
      if (!Array.isArray(rawPatterns)) {
        // eslint-disable-next-line no-console
        console.error(
          `[plan-stage-validator-retry] WARN: policy atom '${atom.id}' has malformed `
            + `payload (recoverable_error_patterns=${JSON.stringify(rawPatterns)}); falling `
            + 'through to hardcoded default. Field must be an array of substring patterns.',
        );
        return null;
      }
      const validatedPatterns: string[] = [];
      for (const entry of rawPatterns) {
        if (typeof entry !== 'string' || entry.length === 0) {
          // eslint-disable-next-line no-console
          console.error(
            `[plan-stage-validator-retry] WARN: policy atom '${atom.id}' has malformed `
              + `payload (recoverable_error_patterns entry=${JSON.stringify(entry)}); falling `
              + 'through to hardcoded default. Each entry must be a non-empty string '
              + '(matched against the validator error message via String.prototype.includes).',
          );
          return null;
        }
        validatedPatterns.push(entry);
      }
      return {
        max_attempts: rawMax,
        recoverable_error_patterns: validatedPatterns,
      };
    }
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);
  return null;
}
