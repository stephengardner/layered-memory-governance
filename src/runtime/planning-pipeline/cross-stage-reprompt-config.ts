/**
 * Cross-stage re-prompt canon-policy reader.
 *
 * Mirrors the shape of `./auditor-feedback-reprompt-config.ts` so the
 * two tunable substrate knobs (intra-stage re-prompt, cross-stage re-
 * prompt) reuse one read pattern. The dial -- HOW MANY cross-stage
 * re-prompts the pipeline may issue, WHICH severities trigger them,
 * and WHICH upstream stages are valid targets -- belongs in canon,
 * not constants. Lifting it from a hardcoded floor to a policy atom
 * lets deployments tune the cadence at scope boundaries without a
 * framework release.
 *
 * Substrate purity: the reader is mechanism-only. It scans canon
 * directive atoms for
 * `metadata.policy.subject === 'cross-stage-reprompt-default'`,
 * matching the L3-only read shape of `readAuditorFeedbackRePromptPolicy`
 * so future maintainers see one pattern, not two.
 *
 * Resolution chain at the call site (runner's audit block):
 *   1. canon policy atom (this reader): preferred, deployment-tunable
 *   2. hardcoded default (HARDCODED_DEFAULT below): indie-floor floor
 *
 * Loud-fail-recoverable at the layer boundary: when a policy atom
 * EXISTS but its payload is malformed, the reader logs a warning to
 * stderr naming the bad field and returns `null` so the caller falls
 * through to the hardcoded default.
 */

import type { Host } from '../../substrate/interface.js';

/**
 * Severity values that may appear in `severities_to_reprompt`. Used
 * by the malformed-payload check so a canon atom that names an unknown
 * severity falls through to the hardcoded default instead of silently
 * widening the trigger surface.
 */
const KNOWN_SEVERITIES: ReadonlySet<string> = new Set([
  'critical',
  'major',
  'minor',
]);

/**
 * Policy atom subject discriminator. Mirrors the convention of the
 * peer tunable dials (`auditor-feedback-reprompt-default`,
 * `plan-stage-validator-retry-default`).
 */
const POLICY_SUBJECT = 'cross-stage-reprompt-default';

/**
 * Special string value for `allowed_targets`. When the policy atom
 * carries this literal, the runner derives the allowed-targets set
 * from the active pipeline composition at startup: every stage in
 * the composition EXCEPT the terminal stage and any stage flagged
 * `audit_only: true`. Deployments that want an explicit literal list
 * pass a `string[]` instead.
 */
export const DERIVE_FROM_PIPELINE_COMPOSITION = 'derive-from-pipeline-composition';

export interface CrossStageRePromptConfig {
  /**
   * Maximum number of cross-stage re-prompts the pipeline may issue
   * in a single run. Shares the runner's unified attempt counter with
   * the intra-stage re-prompt cap and the validator-retry cap: total
   * pipeline iterations per stage = max(all three caps). With the
   * indie default of 2 on each, the pipeline budget is 2 total
   * attempts per stage regardless of which mechanism fires.
   */
  readonly max_attempts: number;
  /**
   * Severities whose findings may trigger a cross-stage re-prompt.
   * A finding whose severity is outside this set is treated as a
   * normal finding: the `reprompt_target` field is ignored for
   * re-prompt routing and the finding flows through the intra-stage
   * re-prompt policy. Empty array explicitly disables the cross-stage
   * re-prompt path while keeping the policy atom present.
   */
  readonly severities_to_reprompt: ReadonlyArray<'critical' | 'major' | 'minor'>;
  /**
   * Set of stage names that may be cited as `reprompt_target` on a
   * cross-stage finding. Either the literal string
   * 'derive-from-pipeline-composition' (the runner derives the set
   * at startup from the active pipeline composition) OR an explicit
   * `string[]` of stage names for deployments that want to narrow.
   */
  readonly allowed_targets: typeof DERIVE_FROM_PIPELINE_COMPOSITION | ReadonlyArray<string>;
}

/**
 * Hardcoded floor used when no canon atom resolves. Matches the
 * spec section 'Indie floor vs org ceiling': at most one cross-stage
 * re-prompt (max_attempts=2 means attempt 1 + attempt 2), triggered
 * only on a critical finding, with the allowed-targets set derived
 * from the active pipeline composition.
 *
 * Exported so the bootstrap script (and any test that wants to assert
 * the seeded canon matches the hardcoded floor) reads a single
 * constant rather than duplicating the numbers.
 */
export const HARDCODED_DEFAULT: CrossStageRePromptConfig = {
  max_attempts: 2,
  severities_to_reprompt: ['critical'],
  allowed_targets: DERIVE_FROM_PIPELINE_COMPOSITION,
};

/**
 * Read the configured cross-stage re-prompt config from canon.
 * Returns the validated struct when a clean, non-superseded L3 policy
 * atom with subject='cross-stage-reprompt-default' exists and carries
 * a well-formed payload. Returns `null` when:
 *   - no policy atom exists (caller falls through to HARDCODED_DEFAULT)
 *   - the policy atom exists but its payload is malformed (caller
 *     logs and falls through; the warning is emitted by this reader
 *     so the operator sees the boundary-failure signal)
 *
 * Validation rules:
 *   - `max_attempts` must be a positive integer.
 *   - `severities_to_reprompt` must be an array of strings, EACH a
 *     known severity ('critical' | 'major' | 'minor'). Empty array
 *     is valid (explicit disable).
 *   - `allowed_targets` must be EITHER the literal string
 *     'derive-from-pipeline-composition' OR a non-empty array of
 *     non-empty strings.
 *
 * Substrate purity: the reader never throws on malformed canon. A
 * malformed policy atom is operator data, not framework state;
 * failing the runner boot would take the entire pipeline offline
 * because someone fat-fingered a JSON value. Falling through to the
 * hardcoded default keeps the pipeline alive while surfacing the
 * error.
 */
export async function readCrossStageRePromptPolicy(
  host: Host,
): Promise<CrossStageRePromptConfig | null> {
  const PAGE_SIZE = 200;
  let cursor: string | undefined;
  do {
    const page = await host.atoms.query(
      { type: ['directive'], layer: ['L3'] },
      PAGE_SIZE,
      cursor,
    );
    for (const atom of page.atoms) {
      if (atom.taint !== 'clean') continue;
      if (atom.superseded_by.length > 0) continue;
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
          `[cross-stage-reprompt] WARN: policy atom '${atom.id}' has malformed `
            + `payload (max_attempts=${JSON.stringify(rawMax)}); falling through to hardcoded `
            + 'default. Field must be a positive integer.',
        );
        return null;
      }

      // Strict-typed read on severities_to_reprompt. Empty array is
      // valid (explicit disable).
      const rawSev = policy['severities_to_reprompt'];
      if (!Array.isArray(rawSev)) {
        // eslint-disable-next-line no-console
        console.error(
          `[cross-stage-reprompt] WARN: policy atom '${atom.id}' has malformed `
            + `payload (severities_to_reprompt=${JSON.stringify(rawSev)}); falling through to `
            + 'hardcoded default. Field must be an array of severity strings.',
        );
        return null;
      }
      const validatedSeverities: ('critical' | 'major' | 'minor')[] = [];
      for (const entry of rawSev) {
        if (typeof entry !== 'string' || !KNOWN_SEVERITIES.has(entry)) {
          // eslint-disable-next-line no-console
          console.error(
            `[cross-stage-reprompt] WARN: policy atom '${atom.id}' has malformed `
              + `payload (severities_to_reprompt entry=${JSON.stringify(entry)}); falling `
              + 'through to hardcoded default. Each entry must be one of '
              + "'critical' | 'major' | 'minor'.",
          );
          return null;
        }
        validatedSeverities.push(entry as 'critical' | 'major' | 'minor');
      }

      // Strict-typed read on allowed_targets. Either the special
      // literal string OR a non-empty array of non-empty strings.
      const rawTargets = policy['allowed_targets'];
      let validatedTargets: CrossStageRePromptConfig['allowed_targets'];
      if (rawTargets === DERIVE_FROM_PIPELINE_COMPOSITION) {
        validatedTargets = DERIVE_FROM_PIPELINE_COMPOSITION;
      } else if (Array.isArray(rawTargets)) {
        if (rawTargets.length === 0) {
          // eslint-disable-next-line no-console
          console.error(
            `[cross-stage-reprompt] WARN: policy atom '${atom.id}' has malformed `
              + 'payload (allowed_targets is an empty array); falling through to '
              + "hardcoded default. Use the literal 'derive-from-pipeline-composition' "
              + 'or a non-empty array of stage names.',
          );
          return null;
        }
        const validated: string[] = [];
        for (const entry of rawTargets) {
          if (typeof entry !== 'string' || entry.length === 0) {
            // eslint-disable-next-line no-console
            console.error(
              `[cross-stage-reprompt] WARN: policy atom '${atom.id}' has malformed `
                + `payload (allowed_targets entry=${JSON.stringify(entry)}); falling `
                + 'through to hardcoded default. Each entry must be a non-empty stage name.',
            );
            return null;
          }
          validated.push(entry);
        }
        validatedTargets = validated;
      } else {
        // eslint-disable-next-line no-console
        console.error(
          `[cross-stage-reprompt] WARN: policy atom '${atom.id}' has malformed `
            + `payload (allowed_targets=${JSON.stringify(rawTargets)}); falling through to `
            + "hardcoded default. Field must be either 'derive-from-pipeline-composition' "
            + 'or a non-empty array of stage name strings.',
        );
        return null;
      }

      return {
        max_attempts: rawMax,
        severities_to_reprompt: validatedSeverities,
        allowed_targets: validatedTargets,
      };
    }
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);
  return null;
}
