/**
 * Pipeline-reaper TTL canon-policy reader.
 *
 * Mirrors the shape of `./reaper-ttls.ts` so the two tunable substrate
 * knobs (plan reaper, pipeline reaper) reuse one pattern across the loop
 * directory. Promotes the per-atom-class TTL knobs that
 * `runPipelineReaperSweep` consumes from CLI flags + env vars to a
 * canon policy atom so deployments tune the cadence at scope boundaries
 * without a framework release. The knobs are tuning data, not code;
 * tunable thresholds belong in canon, not constants.
 *
 * Substrate purity: the reader is mechanism-only. It scans canon
 * directive atoms for `metadata.policy.subject ===
 * 'pipeline-reaper-ttls'`, matching the read shape of
 * `readReaperTtlsFromCanon`, `readApprovalCycleTickIntervalMs`, and
 * `readPrObservationFreshnessMs` so future maintainers see one pattern,
 * not four.
 *
 * Resolution chain at the call site (driver script + LoopRunner pass):
 *   1. canon policy atom (this reader): preferred, deployment-tunable
 *   2. env vars (e.g. LAG_PIPELINE_REAPER_TERMINAL_MS): fallback
 *   3. `DEFAULT_PIPELINE_REAPER_TTLS`: hardcoded floor (30d / 14d / 30d)
 *
 * Loud-fail at the layer boundary: when a policy atom EXISTS but its
 * payload is malformed (non-integer, missing field, non-numeric, zero,
 * or negative), the reader logs a warning to stderr naming the bad
 * field and returns `null` so the caller falls through to env /
 * hardcoded defaults. The operator sees the warning rather than a
 * silent default substitution.
 */

import type { Host } from '../../interface.js';
import type { PipelineReaperTtls } from '../plans/pipeline-reaper.js';

/**
 * Policy atom subject discriminator. Mirrors the convention of the
 * other tunable dials (`reaper-ttls`,
 * `approval-cycle-tick-interval-ms`, `pr-observation-freshness-threshold-ms`).
 */
const POLICY_SUBJECT = 'pipeline-reaper-ttls';

/**
 * Read the configured pipeline-reaper TTLs from canon. Returns the
 * validated set when a clean, non-superseded policy atom with
 * subject='pipeline-reaper-ttls' exists and carries a well-formed
 * payload. Returns `null` when:
 *   - no policy atom exists (caller falls through to env / defaults)
 *   - the policy atom exists but its payload is malformed (caller logs
 *     and falls through; the warning is emitted by this reader so the
 *     operator sees the boundary-failure signal)
 *
 * Validation rules: every numeric field must be a positive integer ms.
 * Field names on disk are snake_case (matching the canon-write
 * convention); the returned `PipelineReaperTtls` shape is camelCase
 * (matching the runtime contract).
 *
 * Substrate purity: the reader never throws on malformed canon. A
 * malformed policy atom is operator data, not framework state; failing
 * the boot would leave the pipeline reaper offline because someone
 * fat-fingered a JSON value. Falling through to env / defaults keeps
 * the reaper alive while surfacing the error.
 */
export async function readPipelineReaperTtlsFromCanon(
  host: Host,
): Promise<PipelineReaperTtls | null> {
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
      // Named fields are canonical. Reject unknown shapes loud-but-
      // recoverable: stderr warning + return null so the caller falls
      // through to env / hardcoded defaults. The operator sees the
      // warning rather than a silent substitution.
      const terminalRaw = policy['terminal_pipeline_ms'];
      const hilRaw = policy['hil_paused_pipeline_ms'];
      const sessionRaw = policy['agent_session_ms'];
      const fields: ReadonlyArray<readonly [string, unknown]> = [
        ['terminal_pipeline_ms', terminalRaw],
        ['hil_paused_pipeline_ms', hilRaw],
        ['agent_session_ms', sessionRaw],
      ];
      const bad: string[] = [];
      for (const [name, raw] of fields) {
        const v = typeof raw === 'number' ? raw : Number.NaN;
        if (!Number.isInteger(v) || v <= 0) {
          bad.push(`${name}=${String(raw)}`);
        }
      }
      if (bad.length > 0) {
        // eslint-disable-next-line no-console
        console.error(
          `[pipeline-reaper-ttls] WARN: pipeline-reaper-ttls policy atom '${atom.id}' has `
          + `malformed payload (${bad.join(' ')}); falling through to env / hardcoded `
          + 'defaults. Each field must be a positive integer ms.',
        );
        return null;
      }
      return {
        terminalPipelineMs: terminalRaw as number,
        hilPausedPipelineMs: hilRaw as number,
        agentSessionMs: sessionRaw as number,
      };
    }
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);
  return null;
}
