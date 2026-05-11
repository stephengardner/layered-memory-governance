/**
 * Pure helpers for the per-pipeline SSE stream surface.
 *
 * The Console's /pipelines/<id> detail view originally polled
 * /api/pipelines.detail every 5 seconds. That cadence is wasteful at
 * the org-ceiling (50 concurrent operators each hitting the server
 * every 5s = 600 req/min for a payload that almost never changes) and
 * sluggish (up to 5s latency between an atom landing on disk and the
 * operator seeing it). This module owns the pure side of the
 * replacement: a per-pipeline SSE channel that pushes change events as
 * the filesystem watcher observes them.
 *
 * The impure side (subscriber Sets, HTTP response writes, watcher
 * wiring) lives in server/index.ts. This module is deliberately a
 * thin layer of decision functions so the wire shape can be locked by
 * unit tests without spinning up an HTTP server.
 *
 * Design constraints (mirror the existing live-ops + pipelines
 * projection modules):
 *   - Pure functions, no I/O.
 *   - Read-only by construction; no mutation paths exposed.
 *   - Bounded resource use (subscriber cap per pipeline).
 *   - Backed by canon `arch-atomstore-source-of-truth`: this module
 *     never invents pipeline state, only routes the watcher's
 *     observations to the right subscribers.
 */

/**
 * Hard cap on concurrent SSE subscribers per pipeline_id. Prevents a
 * runaway client (or a coordinated abuse) from holding hundreds of
 * sockets open for one pipeline.
 *
 * The default of 100 is generous for the indie-floor case (one
 * developer pinning a pipeline tab) and tight enough to bound the
 * worst-case memory pressure: 100 subscribers x 50 concurrent
 * pipelines x ~64KB per pending TCP buffer = 320MB peak, which is
 * recoverable rather than a server-killer. Tunable as a canon edit
 * when the org-ceiling needs more headroom.
 */
export const MAX_SUBSCRIBERS_PER_PIPELINE = 100;

/**
 * Heartbeat cadence for the SSE channel. 30s is the standard cadence
 * for HTTP/2 proxies and AWS ALB idle-timeouts (60s default) so the
 * heartbeat lands well within the cut-off window. Mirrors the cadence
 * used by the existing /api/events/atoms channel so a single watchdog
 * timing assumption holds across both surfaces.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Source-atom shape this module reads. Mirrors the wider Atom shape
 * in server/index.ts but narrowed to just the fields the stream
 * routing needs. Keeping the shape narrow makes the unit tests cheap
 * and prevents this module from depending on the full envelope.
 */
export interface StreamSourceAtom {
  readonly id: string;
  readonly type: string;
  readonly metadata?: Record<string, unknown>;
  readonly pipeline_state?: string;
}

/**
 * Event vocabulary emitted on the per-pipeline channel. Keep this in
 * sync with the client-side `SSE_PIPELINE_EVENT_NAMES` in
 * services/transport/http.ts; any new event must be added to both.
 */
export type PipelineStreamEvent =
  | 'open'
  | 'atom-change'
  | 'pipeline-state-change'
  | 'heartbeat';

/**
 * Wire-format the named SSE message. The shape `event: <name>\ndata:
 * <json>\n\n` is the canonical SSE frame and what EventSource clients
 * parse natively.
 *
 * Whitespace matters: the trailing blank line is the SSE record
 * terminator. Without it, a client that has already received a
 * complete JSON object will not fire the corresponding event listener
 * because the parser has not yet seen end-of-record.
 */
export function formatSseMessage(event: PipelineStreamEvent, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Extract the `pipeline_id` an atom belongs to. Two shapes count:
 *
 *   1. The atom IS a pipeline atom (atom.type === 'pipeline'):
 *      the pipeline_id is the atom's id. The detail view subscribes
 *      to the pipeline atom's own changes (state transitions land in
 *      pipeline.pipeline_state, observed via watcher 'change'
 *      events).
 *
 *   2. The atom carries `metadata.pipeline_id`:
 *      all downstream lifecycle atoms (pipeline-stage-event,
 *      pipeline-audit-finding, pipeline-failed, pipeline-resume,
 *      dispatch-record, agent-turn, code-author-invoked,
 *      pr-observation, plan-merge-settled, etc.) stamp their parent
 *      pipeline via this field.
 *
 * Returns null when the atom has no association; those atoms are
 * not relevant to any per-pipeline subscriber and should be skipped.
 */
export function extractAtomPipelineId(atom: StreamSourceAtom): string | null {
  if (atom.type === 'pipeline') {
    return atom.id;
  }
  const meta = atom.metadata;
  if (!meta || typeof meta !== 'object') return null;
  const raw = meta['pipeline_id'];
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return raw;
}

/**
 * Build the `atom-change` SSE payload. The payload is intentionally
 * minimal: the client uses the event as a cache-invalidation signal
 * and re-fetches the full detail via /api/pipelines.detail. Shipping
 * the atom body inline would couple the wire shape to the projection,
 * which canon `dec-console-http-api-canonical-read-surface` warns
 * against.
 */
export function buildAtomChangePayload(
  atom: StreamSourceAtom,
  pipelineId: string,
  at: string,
): {
  pipeline_id: string;
  atom_id: string;
  atom_type: string;
  at: string;
} {
  return {
    pipeline_id: pipelineId,
    atom_id: atom.id,
    atom_type: atom.type,
    at,
  };
}

/**
 * Build the `pipeline-state-change` SSE payload. Fires only when the
 * pipeline atom itself changes (atom.type === 'pipeline'). The state
 * is included inline so the client can patch its query cache without
 * a round-trip in the common case of a state-pill update.
 */
export function buildPipelineStateChangePayload(
  pipelineAtom: StreamSourceAtom,
  at: string,
): {
  pipeline_id: string;
  pipeline_state: string | null;
  at: string;
} {
  const state = typeof pipelineAtom.pipeline_state === 'string'
    ? pipelineAtom.pipeline_state
    : null;
  return {
    pipeline_id: pipelineAtom.id,
    pipeline_state: state,
    at,
  };
}

/**
 * Decode the per-pipeline channel name from the path segment. The
 * route surface is `/api/events/pipeline.<pipeline-id>`; this helper
 * extracts the id and validates the prefix.
 *
 * Returns null for channels that do not match the per-pipeline shape
 * (the caller routes those to the generic atoms channel or to a 404).
 *
 * Bounded length so a malicious caller cannot fill memory with a
 * giant subscriber-key string. 256 is more than enough for any
 * legitimate pipeline atom id (current ids are ~50 chars) and small
 * enough that a per-request validation is O(1).
 */
export const MAX_PIPELINE_ID_LEN = 256;

export function parsePipelineChannel(channel: string): string | null {
  const prefix = 'pipeline.';
  if (!channel.startsWith(prefix)) return null;
  const id = channel.substring(prefix.length);
  if (id.length === 0 || id.length > MAX_PIPELINE_ID_LEN) return null;
  /*
   * Atom ids are lowercase kebab-case alphanumerics with optional
   * dot/underscore separators in some legacy fixtures. Reject control
   * chars and anything that could land in an HTTP header injection or
   * a filesystem walk. The allowlist matches the existing atom
   * filename pattern in the .lag/atoms/ directory layout.
   */
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) return null;
  return id;
}

/**
 * Standard 'open' acknowledgement payload. Emitted on every new
 * subscription so the client knows the stream is alive and which
 * pipeline it is bound to. The client uses this to flip its
 * `connected` state for fall-back-vs-stream gating.
 */
export function buildOpenPayload(
  pipelineId: string,
  at: string,
): {
  pipeline_id: string;
  at: string;
} {
  return { pipeline_id: pipelineId, at };
}

/**
 * Standard heartbeat payload. Empty object on purpose: clients only
 * observe arrival cadence, not the body.
 */
export function buildHeartbeatPayload(at: string): { at: string } {
  return { at };
}
