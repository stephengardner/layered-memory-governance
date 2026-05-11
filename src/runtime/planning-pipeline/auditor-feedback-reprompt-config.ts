/**
 * Auditor-feedback re-prompt canon-policy reader.
 *
 * Mirrors the shape of `../loop/loop-pass-claim-reaper.ts` so the two
 * tunable substrate knobs (claim-reaper enable, auditor-feedback re-
 * prompt) reuse one read pattern. The dial -- HOW MANY attempts +
 * WHICH severities trigger a re-prompt -- belongs in canon, not
 * constants. Lifting it from a hardcoded floor to a policy atom lets
 * deployments tune the cadence at scope boundaries without a
 * framework release.
 *
 * Substrate purity: the reader is mechanism-only. It scans canon
 * directive atoms for
 * `metadata.policy.subject === 'auditor-feedback-reprompt-default'`,
 * matching the L3-only read shape of `readLoopPassClaimReaperFromCanon`
 * so future maintainers see one pattern, not two.
 *
 * Resolution chain at the call site (runner's audit block):
 *   1. canon policy atom (this reader): preferred, deployment-tunable
 *   2. hardcoded default (HARDCODED_DEFAULT below): indie-floor floor
 *
 * Loud-fail-recoverable at the layer boundary: when a policy atom
 * EXISTS but its payload is malformed (`max_attempts` not a positive
 * integer, `severities_to_reprompt` not a string array of known
 * severities), the reader logs a warning to stderr naming the bad
 * field and returns `null` so the caller falls through to the
 * hardcoded default. The operator sees the warning rather than a
 * silent default substitution; the policy atom itself remains the
 * audit trail of what they tried to set.
 */

import type { Host } from '../../substrate/interface.js';
import type { AuditorFeedbackRePromptConfig } from './auditor-feedback-reprompt.js';

/**
 * Policy atom subject discriminator. Mirrors the convention of the
 * other tunable dials (`reaper-ttls`, `pipeline-reaper-ttls`,
 * `loop-pass-claim-reaper-default`).
 */
const POLICY_SUBJECT = 'auditor-feedback-reprompt-default';

/**
 * Hardcoded floor used when no canon atom resolves. Matches the
 * default: at most one re-prompt (max_attempts=2 means attempt 1 +
 * attempt 2), triggered only on a critical finding. An org-ceiling
 * deployment that wants 'major' findings to also trigger re-prompts
 * lands a higher-priority `pol-auditor-feedback-reprompt-default`
 * atom with `severities_to_reprompt: ['critical', 'major']` via a
 * deliberate canon edit, not a global toggle. The indie floor + org
 * ceiling discipline is what motivates the default-deny posture.
 *
 * Exported so the bootstrap script (and any test that wants to assert
 * the seeded canon matches the hardcoded floor) reads a single
 * constant rather than duplicating the numbers.
 */
export const HARDCODED_DEFAULT: AuditorFeedbackRePromptConfig = {
  max_attempts: 2,
  severities_to_reprompt: ['critical'],
};

/**
 * Known severity values. Used by the malformed-payload check so a
 * canon atom that names an unknown severity (typo, future-severity-
 * not-yet-supported) falls through to the hardcoded default instead
 * of silently widening the trigger surface.
 */
const KNOWN_SEVERITIES: ReadonlySet<string> = new Set(['critical', 'major', 'minor']);

/**
 * Read the configured auditor-feedback re-prompt config from canon.
 * Returns the validated struct when a clean, non-superseded L3 policy
 * atom with subject='auditor-feedback-reprompt-default' exists and
 * carries a well-formed payload. Returns `null` when:
 *   - no policy atom exists (caller falls through to HARDCODED_DEFAULT)
 *   - the policy atom exists but its payload is malformed (caller
 *     logs and falls through; the warning is emitted by this reader
 *     so the operator sees the boundary-failure signal)
 *
 * Validation rules:
 *   - `max_attempts` must be a positive integer.
 *   - `severities_to_reprompt` must be an array of strings, EACH a
 *     known severity ('critical' | 'major' | 'minor'). Empty array is
 *     valid -- it explicitly disables the re-prompt loop while
 *     keeping the policy atom present.
 *
 * Substrate purity: the reader never throws on malformed canon. A
 * malformed policy atom is operator data, not framework state;
 * failing the runner boot would take the entire pipeline offline
 * because someone fat-fingered a JSON value. Falling through to the
 * hardcoded default keeps the pipeline alive while surfacing the
 * error.
 */
export async function readAuditorFeedbackRePromptPolicy(
  host: Host,
): Promise<AuditorFeedbackRePromptConfig | null> {
  const PAGE_SIZE = 200;
  let cursor: string | undefined;
  do {
    // Constrain to L3 (canonical layer) so a same-subject non-canon
    // directive (L0/L1/L2) cannot impersonate authoritative canon.
    // Mirrors the L3-only scan in `loop-pass-claim-reaper.ts`; without
    // this filter an attacker-or-mistake L0/L1 atom with the same
    // subject discriminator could widen the re-prompt surface.
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
          `[auditor-feedback-reprompt] WARN: policy atom '${atom.id}' has malformed `
            + `payload (max_attempts=${JSON.stringify(rawMax)}); falling through to hardcoded `
            + 'default. Field must be a positive integer.',
        );
        return null;
      }
      // Strict-typed read on severities_to_reprompt. Empty array is
      // valid (explicit disable); any non-array OR an array element
      // that is not a known severity falls through to default with a
      // warning.
      const rawSev = policy['severities_to_reprompt'];
      if (!Array.isArray(rawSev)) {
        // eslint-disable-next-line no-console
        console.error(
          `[auditor-feedback-reprompt] WARN: policy atom '${atom.id}' has malformed `
            + `payload (severities_to_reprompt=${JSON.stringify(rawSev)}); falling through to `
            + 'hardcoded default. Field must be an array of severity strings.',
        );
        return null;
      }
      const validatedSeverities: AuditorFeedbackRePromptConfig['severities_to_reprompt'][number][] = [];
      for (const entry of rawSev) {
        if (typeof entry !== 'string' || !KNOWN_SEVERITIES.has(entry)) {
          // eslint-disable-next-line no-console
          console.error(
            `[auditor-feedback-reprompt] WARN: policy atom '${atom.id}' has malformed `
              + `payload (severities_to_reprompt entry=${JSON.stringify(entry)}); falling `
              + 'through to hardcoded default. Each entry must be one of '
              + "'critical' | 'major' | 'minor'.",
          );
          return null;
        }
        // Cast is safe -- KNOWN_SEVERITIES.has narrowed the runtime
        // value to the known-severity union. TypeScript cannot infer
        // the narrowing through a Set membership check, so the cast
        // is the bridge.
        validatedSeverities.push(entry as AuditorFeedbackRePromptConfig['severities_to_reprompt'][number]);
      }
      return {
        max_attempts: rawMax,
        severities_to_reprompt: validatedSeverities,
      };
    }
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);
  return null;
}
