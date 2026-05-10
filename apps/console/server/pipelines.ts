/**
 * Pure helpers for the pipelines surface.
 *
 * Reads the deep planning pipeline atom chain (1 root pipeline atom,
 * N pipeline-stage-event atoms, M pipeline-audit-finding atoms,
 * optional pipeline-failed, optional pipeline-resume) from a flat atom
 * array and projects three response shapes:
 *
 *   - `listPipelineSummaries` : the grid view (one row per pipeline)
 *   - `getPipelineDetail`     : the drill-in (full chain for one id)
 *   - `listLiveOpsPipelines`  : narrowed shape for the Pulse tile
 *
 * Design constraints baked into this module (mirrors `live-ops.ts`):
 *   - Pure functions, no I/O. The handler in server/index.ts feeds
 *     this module the full atom array.
 *   - Read-only by construction.
 *   - Bounded payload caps for the list views (DoS defense).
 *   - UTC ISO timestamps assumed.
 *
 * The "current stage" projection over a series of stage-event atoms
 * uses an event-fold: stage state collapses to running/paused/
 * succeeded/failed based on the LATEST event for that stage, with
 * stage order taken from the first time we see a stage name in event
 * order. This handles substrate-deep + single-pass uniformly without
 * the projection knowing the canon stage list.
 */
import type {
  AgentTurnRow,
  PipelineAuditCounts,
  PipelineAuditFinding,
  PipelineAuditSeverity,
  PipelineDetail,
  PipelineDispatchSummary,
  PipelineFailureRecord,
  PipelineLiveOpsResult,
  PipelineLiveOpsRow,
  PipelineListResult,
  PipelineResumeRecord,
  PipelineSourceAtom,
  PipelineStageEvent,
  PipelineStageState,
  PipelineStageSummary,
  PipelineSummary,
} from './pipelines-types.js';
import { readObject, readString } from './projection-helpers.js';

/**
 * Hard cap on summaries returned in a single list response. Pipelines
 * accumulate over time; the grid surfaces "head of the feed" with
 * deeper inspection deferred to filter chips + drill-in. Mirrors
 * MAX_LIST_ITEMS in live-ops.ts.
 */
export const MAX_PIPELINE_LIST_ITEMS = 100;

/**
 * Hard cap on the "live" pipelines (running/paused) returned to the
 * Pulse tile. Tighter than the list cap because the tile is small and
 * the operator only needs to see what's actively happening.
 */
export const MAX_LIVE_OPS_PIPELINES = 10;

/**
 * Cap on the per-pipeline event chain returned in detail. Real chains
 * for substrate-deep mode top out around 5 stages * 4 events = 20;
 * this cap is well above that and protects against pathological data.
 */
export const MAX_DETAIL_EVENTS = 500;

/**
 * Cap on findings per pipeline in detail. Substrate caps cited
 * lists at 256 per finding (atom-shapes.ts MAX_CITED_LIST), so this
 * limit only matters if a stage produces an unreasonable number of
 * findings.
 */
export const MAX_DETAIL_FINDINGS = 500;

/**
 * Cap on the per-pipeline `agent_turns` array surfaced in the detail
 * payload. Agentic stages can produce many turns inside a single
 * session; the "live progress" surface only needs the newest few to
 * answer "what is the active stage doing right now". The cap keeps
 * the wire shape small even when a long-running session has minted
 * 100+ turns. Tunable as a canon edit if the org-ceiling deployment
 * needs more headroom; the indie-floor default keeps the payload
 * bounded.
 */
export const PIPELINE_DETAIL_MAX_TURNS = 30;

/**
 * llm_input preview cap (in characters). Beyond this the projection
 * truncates and appends an ellipsis. Single-line code-block render in
 * the UI; 200 chars is enough to read the gist of a prompt without
 * shipping the whole conversation back over the wire on every 5s
 * poll.
 */
const LLM_INPUT_PREVIEW_LIMIT = 200;

/**
 * Severity weight for audit-finding ordering. Larger = more severe.
 * Used for stable sort: by severity desc, then created_at desc.
 */
const SEVERITY_WEIGHT: Readonly<Record<PipelineAuditSeverity, number>> = Object.freeze({
  critical: 3,
  major: 2,
  minor: 1,
});

/**
 * Parse an ISO timestamp; return NaN on invalid input. Same shape as
 * live-ops.ts so the helpers feel like one family.
 */
export function parseIsoTs(value: string | undefined | null): number {
  if (typeof value !== 'string' || value.length === 0) return NaN;
  return Date.parse(value);
}

function readMeta(atom: PipelineSourceAtom): Record<string, unknown> {
  return (atom.metadata ?? {}) as Record<string, unknown>;
}

// readString is shared with the sibling projection modules via
// projection-helpers.ts; readNumber stays local because this module
// returns 0 on missing/non-numeric values whereas the lifecycle
// modules return null. Aligning the two contracts is a follow-up;
// extracting one now would silently change the fallback shape in
// the consumers we don't touch.

function readNumber(meta: Record<string, unknown>, key: string): number {
  const v = meta[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function readStringArray(meta: Record<string, unknown>, key: string): ReadonlyArray<string> {
  const v = meta[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

function isCleanLive(atom: PipelineSourceAtom): boolean {
  // Live atoms have an unset taint or the canonical 'clean' sentinel.
  // Any other taint value (tainted, quarantined, future enum members)
  // disqualifies. Mirrors the sibling projection at
  // apps/console/server/actor-activity.ts. Earlier shape
  // `if (atom.taint) return false` was wrong because every well-formed
  // atom carries `taint: 'clean'` (a truthy string) and was therefore
  // filtered out, causing the entire pipelines list + Pulse
  // pipelines-in-flight tile to render empty even with valid pipeline
  // atoms on disk.
  if (atom.taint && atom.taint !== 'clean') return false;
  if (atom.superseded_by && atom.superseded_by.length > 0) return false;
  return true;
}

/**
 * Pull a human-readable title for a pipeline. Priority:
 *   1. metadata.title       (if a future stage adapter sets one)
 *   2. seed_atom_id content (first seed atom)
 *   3. atom.content
 *   4. atom.id              (last-resort)
 *
 * The first-seed-content path is the workhorse: pipelines derive_from
 * the operator-intent atom whose content IS the operator's prose
 * description; surfacing it makes the list immediately legible.
 */
function pipelineTitle(
  pipeline: PipelineSourceAtom,
  byId: ReadonlyMap<string, PipelineSourceAtom>,
): string {
  const meta = readMeta(pipeline);
  const explicit = readString(meta, 'title');
  if (explicit) return explicit;
  const seedIds = readStringArray(meta, 'seed_atom_ids');
  for (const seedId of seedIds) {
    const seed = byId.get(seedId);
    if (seed && typeof seed.content === 'string' && seed.content.length > 0) {
      return firstLine(seed.content);
    }
  }
  // The pipeline atom's `content` defaults to `pipeline:<correlationId>`;
  // surface it but prefer the seed content above when it exists.
  if (pipeline.content && pipeline.content.length > 0) {
    return firstLine(pipeline.content);
  }
  return pipeline.id;
}

function firstLine(text: string): string {
  // Strip a leading markdown heading marker if present, then return the
  // first non-empty line. Cap at 240 chars so a verbose seed atom does
  // not blow the card layout; the full content is one click away in
  // the detail view.
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.replace(/^#{1,6}\s+/, '').trim();
    if (trimmed.length > 0) {
      return trimmed.length > 240 ? `${trimmed.slice(0, 239)}\u2026` : trimmed;
    }
  }
  return text.slice(0, 240);
}

interface StageFold {
  // Insertion order in `byName` is the canonical stage order — we add
  // a stage entry the first time we see an event for it, which mirrors
  // the order the runtime emitted stages.
  readonly byName: Map<string, MutableStage>;
}

interface MutableStage {
  index: number;
  state: PipelineStageState;
  duration_ms: number;
  cost_usd: number;
  last_event_ts: number;
  last_event_iso: string | null;
  output_atom_id: string | null;
}

function newStage(index: number): MutableStage {
  return {
    index,
    state: 'pending',
    duration_ms: 0,
    cost_usd: 0,
    last_event_ts: -Infinity,
    last_event_iso: null,
    output_atom_id: null,
  };
}

/**
 * Fold a list of pipeline-stage-event atoms (already filtered to one
 * pipeline) into a per-stage summary plus the canonical event order.
 * Keeps the projection deterministic regardless of the input array's
 * order: events are sorted by timestamp first, ties broken by atom
 * id ascending so two events at the same instant fold deterministically.
 *
 * Optional `agentTurnTimestamps`: a list of `AgentTurnIndexEvent`
 * derived from pipeline-stage-event atoms with transition='agent-turn'.
 * These DO NOT contribute to the visible event strip (`ordered`) and
 * MUST NOT change a stage's state (state collapse is driven by the
 * lifecycle enter/exit/pause/resume transitions only — agent turns are
 * mid-stage progress signals, not lifecycle transitions). They DO
 * advance the stage's `last_event_ts/iso` so that
 * PipelineStageSummary.last_event_at and the top-level
 * pipeline.last_event_at reflect the freshest activity, even while a
 * running stage has not yet emitted an exit event. See CR review on
 * PR #387 for the regression this closes.
 */
function foldStageEvents(
  events: ReadonlyArray<PipelineStageEvent>,
  agentTurnTimestamps: ReadonlyArray<AgentTurnIndexEvent> = [],
): {
  fold: StageFold;
  ordered: ReadonlyArray<PipelineStageEvent>;
} {
  const ordered = [...events].sort((a, b) => {
    const aTs = parseIsoTs(a.at);
    const bTs = parseIsoTs(b.at);
    if (aTs !== bTs) return aTs - bTs;
    return a.atom_id.localeCompare(b.atom_id);
  });

  const fold: StageFold = { byName: new Map() };
  for (const event of ordered) {
    const ts = parseIsoTs(event.at);
    if (!Number.isFinite(ts)) continue;
    let entry = fold.byName.get(event.stage_name);
    if (!entry) {
      entry = newStage(fold.byName.size);
      fold.byName.set(event.stage_name, entry);
    }
    entry.duration_ms += event.duration_ms;
    entry.cost_usd += event.cost_usd;
    // `>=` (not `>`) so equal-timestamp events still update state. The
    // outer `ordered` sort guarantees deterministic order at equal `at`
    // values (atom_id ascending), so iterating later in the loop means
    // later in time-resolved logical order: e.g. `enter` followed by
    // `exit-success` at the same instant must collapse to `succeeded`.
    if (ts >= entry.last_event_ts) {
      entry.last_event_ts = ts;
      entry.last_event_iso = event.at;
      // Latest-event-wins state collapse. `enter` lifts to running;
      // exit-* terminates; hil-pause/hil-resume model the HIL pause
      // state explicitly so the UI can show "Resume" affordances.
      switch (event.transition) {
        case 'enter':
          entry.state = 'running';
          break;
        case 'exit-success':
          entry.state = 'succeeded';
          break;
        case 'exit-failure':
          entry.state = 'failed';
          break;
        case 'hil-pause':
          entry.state = 'paused';
          break;
        case 'hil-resume':
          entry.state = 'running';
          break;
      }
    }
    if (event.output_atom_id) entry.output_atom_id = event.output_atom_id;
  }

  // Second pass: advance per-stage `last_event_ts/iso` with agent-turn
  // event timestamps. Sort by (ts, atom_id) so equal-timestamp turns
  // fold deterministically — same tiebreak shape the lifecycle loop
  // uses above. Agent-turn timestamps NEVER mutate `state`,
  // `duration_ms`, `cost_usd`, or `output_atom_id` — those remain
  // owned by lifecycle events. We do auto-create a stage entry when an
  // agent-turn arrives for a stage that has not yet emitted an
  // `enter` event (extremely rare; defensive against substrate
  // misordering on out-of-order disk reads).
  if (agentTurnTimestamps.length > 0) {
    const sortedTurns = [...agentTurnTimestamps].sort((a, b) => {
      const aTs = parseIsoTs(a.created_at);
      const bTs = parseIsoTs(b.created_at);
      if (aTs !== bTs) return aTs - bTs;
      return a.atom_id.localeCompare(b.atom_id);
    });
    for (const turn of sortedTurns) {
      const ts = parseIsoTs(turn.created_at);
      if (!Number.isFinite(ts)) continue;
      let entry = fold.byName.get(turn.stage_name);
      if (!entry) {
        entry = newStage(fold.byName.size);
        fold.byName.set(turn.stage_name, entry);
      }
      if (ts >= entry.last_event_ts) {
        entry.last_event_ts = ts;
        entry.last_event_iso = turn.created_at;
      }
    }
  }

  return { fold, ordered };
}

function stageSummariesFromFold(fold: StageFold): ReadonlyArray<PipelineStageSummary> {
  const out: PipelineStageSummary[] = [];
  for (const [stageName, stage] of fold.byName) {
    out.push({
      stage_name: stageName,
      state: stage.state,
      index: stage.index,
      duration_ms: stage.duration_ms,
      cost_usd: stage.cost_usd,
      last_event_at: stage.last_event_iso,
      output_atom_id: stage.output_atom_id,
    });
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

/**
 * Pick the "current" stage from a fold. Definition: the latest stage
 * (highest index) that is in a non-pending state. If every stage is
 * pending or there are no stages, returns null.
 */
function currentStageFromSummaries(
  summaries: ReadonlyArray<PipelineStageSummary>,
): { name: string | null; index: number } {
  let chosen: PipelineStageSummary | null = null;
  for (const s of summaries) {
    if (s.state === 'pending') continue;
    if (!chosen || s.index >= chosen.index) chosen = s;
  }
  return chosen
    ? { name: chosen.stage_name, index: chosen.index }
    : { name: null, index: 0 };
}

/**
 * Materialize a pipeline-stage-event atom into its wire shape.
 *
 * Returns null for the `agent-turn` transition (and any other
 * transition the wire shape does not surface today). agent-turn index
 * events are collected separately by `agentTurnIndexEventFromAtom`
 * and projected into the `agent_turns` array on the detail payload;
 * they DO NOT belong on the per-stage `events` strip (which models
 * the canonical enter/exit/pause/resume lifecycle).
 */
function eventFromAtom(atom: PipelineSourceAtom): PipelineStageEvent | null {
  const meta = readMeta(atom);
  const stageName = readString(meta, 'stage_name');
  const transitionRaw = readString(meta, 'transition');
  if (!stageName || !transitionRaw) return null;
  if (
    transitionRaw !== 'enter'
    && transitionRaw !== 'exit-success'
    && transitionRaw !== 'exit-failure'
    && transitionRaw !== 'hil-pause'
    && transitionRaw !== 'hil-resume'
  ) {
    return null;
  }
  return {
    atom_id: atom.id,
    stage_name: stageName,
    transition: transitionRaw,
    at: atom.created_at,
    duration_ms: readNumber(meta, 'duration_ms'),
    cost_usd: readNumber(meta, 'cost_usd'),
    output_atom_id: readString(meta, 'output_atom_id'),
    principal_id: atom.principal_id,
  };
}

/**
 * Internal shape for an agent-turn index event: a `pipeline-stage-event`
 * atom whose transition is `'agent-turn'`. Carries the index pointer
 * (agent_turn_atom_id + turn_index) plus the event ordering signal
 * (atom_id + created_at). Telemetry is resolved lazily by cross-walking
 * to the agent-turn atom; this struct holds only the index-side shape.
 */
interface AgentTurnIndexEvent {
  readonly atom_id: string;
  readonly stage_name: string;
  readonly agent_turn_atom_id: string | null;
  readonly turn_index: number;
  readonly created_at: string;
}

/**
 * Materialize a `pipeline-stage-event` atom with `transition='agent-turn'`
 * into the lightweight index shape `AgentTurnIndexEvent`. Returns null
 * for every non-`agent-turn` transition (the lifecycle events flow
 * through `eventFromAtom` instead).
 *
 * Defensive on `agent_turn_atom_id`: substrate writes always include
 * it (the mint helper throws when absent), but the projection accepts
 * a missing pointer as `null` rather than dropping the row, so a
 * malformed atom still surfaces as an index marker for the operator
 * to inspect.
 */
function agentTurnIndexEventFromAtom(atom: PipelineSourceAtom): AgentTurnIndexEvent | null {
  const meta = readMeta(atom);
  const stageName = readString(meta, 'stage_name');
  const transitionRaw = readString(meta, 'transition');
  if (!stageName || transitionRaw !== 'agent-turn') return null;
  const turnIndexRaw = meta['turn_index'];
  const turnIndex = typeof turnIndexRaw === 'number' && Number.isFinite(turnIndexRaw)
    ? turnIndexRaw
    : 0;
  return {
    atom_id: atom.id,
    stage_name: stageName,
    agent_turn_atom_id: readString(meta, 'agent_turn_atom_id'),
    turn_index: turnIndex,
    created_at: atom.created_at,
  };
}

/**
 * Project an agent-turn index event + the cross-walked agent-turn atom
 * (when reachable AND live) into the wire `AgentTurnRow` shape.
 *
 * The cross-walk is best-effort: a missing, tainted, or superseded
 * agent-turn atom yields null telemetry rather than dropping the row,
 * so the operator still sees the index marker. This is the same
 * defensive posture the projection uses elsewhere when an atom-chain
 * pointer dangles.
 *
 * llm_input_preview rules:
 *   - inline payload: truncate at LLM_INPUT_PREVIEW_LIMIT and append
 *     a single-character ellipsis when truncated.
 *   - ref payload (blob-content-addressed): null (the projection does
 *     not resolve blob refs at read time).
 *   - any other shape (substrate-violating atom): null.
 */
function agentTurnRowFromIndex(
  index: AgentTurnIndexEvent,
  byId: ReadonlyMap<string, PipelineSourceAtom>,
): AgentTurnRow {
  let latency_ms: number | null = null;
  let tool_calls_count: number | null = null;
  let llm_input_preview: string | null = null;

  const turnAtomId = index.agent_turn_atom_id;
  const turnAtom = turnAtomId ? byId.get(turnAtomId) : undefined;
  // Cross-walk integrity gates, applied in order:
  //   1. The atom must exist on disk.
  //   2. Its type must be 'agent-turn' (a corrupted pointer could land
  //      on a different atom type with the same id).
  //   3. It must be live (taint='clean' AND not superseded). A
  //      tainted atom is by definition NOT a trustworthy data source.
  //   4. Its agent_turn.turn_index MUST equal the index event's
  //      turn_index.
  //   5. Its agent_turn.session_atom_id MUST be a non-empty string
  //      with the 'agent-session-' prefix. This is the substrate
  //      shape contract (mkAgentTurnAtom only ever writes that
  //      shape); failing it means the cross-walk landed on a
  //      synthetic / malformed atom rather than a real turn record.
  //   6. The agent-turn atom's provenance.derived_from MUST include
  //      the session_atom_id it claims. This is the structural
  //      proof that the atom is genuinely a child of that session;
  //      a forged metadata.session_atom_id without matching
  //      provenance fails this gate.
  //
  // Gates 5+6 are the CR-flagged "provenance proof" per PR #387 round
  // 3: a corrupted index event pointing at an unrelated live
  // agent-turn (e.g. from a different pipeline's session) can no
  // longer leak its telemetry under the current pipeline. The
  // substrate writes index event + agent-turn atom in lockstep, so
  // an honest substrate always passes these gates; the value is the
  // defense against adversarial / accidentally-mutated atoms.
  //
  // Any failure surfaces the index row with null telemetry (treats
  // the cross-walk as a dangling pointer), same as a missing atom.
  if (turnAtom && turnAtom.type === 'agent-turn' && isCleanLive(turnAtom)) {
    const meta = readMeta(turnAtom);
    const agentTurn = readObject(meta, 'agent_turn');
    const atomTurnIndexRaw = agentTurn ? agentTurn['turn_index'] : undefined;
    const atomTurnIndex = typeof atomTurnIndexRaw === 'number' && Number.isFinite(atomTurnIndexRaw)
      ? atomTurnIndexRaw
      : null;
    const claimedSessionAtomIdRaw = agentTurn ? agentTurn['session_atom_id'] : undefined;
    const claimedSessionAtomId = typeof claimedSessionAtomIdRaw === 'string'
      && claimedSessionAtomIdRaw.startsWith('agent-session-')
      && claimedSessionAtomIdRaw.length > 'agent-session-'.length
      ? claimedSessionAtomIdRaw
      : null;
    const provenanceDerivedFrom = (turnAtom as { provenance?: { derived_from?: ReadonlyArray<string> } }).provenance?.derived_from;
    const provenanceMatchesSession = claimedSessionAtomId !== null
      && Array.isArray(provenanceDerivedFrom)
      && provenanceDerivedFrom.includes(claimedSessionAtomId);
    if (
      agentTurn
      && atomTurnIndex === index.turn_index
      && claimedSessionAtomId !== null
      && provenanceMatchesSession
    ) {
      const rawLatency = agentTurn['latency_ms'];
      if (typeof rawLatency === 'number' && Number.isFinite(rawLatency)) {
        latency_ms = rawLatency;
      }
      const rawToolCalls = agentTurn['tool_calls'];
      if (Array.isArray(rawToolCalls)) {
        tool_calls_count = rawToolCalls.length;
      }
      const rawLlmInput = agentTurn['llm_input'];
      if (rawLlmInput && typeof rawLlmInput === 'object' && !Array.isArray(rawLlmInput)) {
        const inline = (rawLlmInput as Record<string, unknown>)['inline'];
        if (typeof inline === 'string') {
          llm_input_preview = inline.length > LLM_INPUT_PREVIEW_LIMIT
            ? `${inline.slice(0, LLM_INPUT_PREVIEW_LIMIT)}…`
            : inline;
        }
      }
    }
  }

  return {
    stage_name: index.stage_name,
    turn_index: index.turn_index,
    agent_turn_atom_id: index.agent_turn_atom_id,
    created_at: index.created_at,
    latency_ms,
    llm_input_preview,
    tool_calls_count,
  };
}

/**
 * Materialize a pipeline-audit-finding atom into its wire shape.
 */
function findingFromAtom(atom: PipelineSourceAtom): PipelineAuditFinding | null {
  const meta = readMeta(atom);
  const stageName = readString(meta, 'stage_name');
  const severityRaw = readString(meta, 'severity');
  const category = readString(meta, 'category');
  const message = readString(meta, 'message');
  if (!stageName || !severityRaw || !category || !message) return null;
  if (severityRaw !== 'critical' && severityRaw !== 'major' && severityRaw !== 'minor') {
    return null;
  }
  return {
    atom_id: atom.id,
    stage_name: stageName,
    severity: severityRaw,
    category,
    message,
    cited_atom_ids: readStringArray(meta, 'cited_atom_ids'),
    cited_paths: readStringArray(meta, 'cited_paths'),
    created_at: atom.created_at,
    principal_id: atom.principal_id,
  };
}

function failureFromAtom(atom: PipelineSourceAtom): PipelineFailureRecord | null {
  const meta = readMeta(atom);
  const failedStageName = readString(meta, 'failed_stage_name');
  const cause = readString(meta, 'cause');
  const recoveryHint = readString(meta, 'recovery_hint');
  if (!failedStageName || !cause || !recoveryHint) return null;
  const indexRaw = meta['failed_stage_index'];
  const failedStageIndex = typeof indexRaw === 'number' && Number.isFinite(indexRaw) ? indexRaw : 0;
  const chain = readStringArray(meta, 'chain');
  return {
    atom_id: atom.id,
    failed_stage_name: failedStageName,
    failed_stage_index: failedStageIndex,
    cause,
    recovery_hint: recoveryHint,
    chain,
    at: atom.created_at,
    // Reserved seam for a future "the chain was too long" flag the
    // substrate may emit; default false until that signal exists.
    truncated: meta['truncated'] === true,
  };
}

function resumeFromAtom(atom: PipelineSourceAtom): PipelineResumeRecord | null {
  const meta = readMeta(atom);
  const stageName = readString(meta, 'stage_name');
  const resumer = readString(meta, 'resumer_principal_id');
  if (!stageName || !resumer) return null;
  return {
    atom_id: atom.id,
    stage_name: stageName,
    resumer_principal_id: resumer,
    at: atom.created_at,
  };
}

/**
 * Index pipeline-related atoms by pipeline id in a single pass so the
 * listing path is O(N) rather than O(N * pipelines).
 */
interface PipelineIndex {
  readonly pipelinesById: Map<string, PipelineSourceAtom>;
  readonly eventsByPipeline: Map<string, PipelineStageEvent[]>;
  readonly findingsByPipeline: Map<string, PipelineAuditFinding[]>;
  readonly failureByPipeline: Map<string, PipelineFailureRecord>;
  readonly resumesByPipeline: Map<string, PipelineResumeRecord[]>;
  /*
   * One dispatch-record atom per pipeline (substrate writes one at the
   * end of dispatch-stage). Indexed here so the summarize/detail paths
   * can surface scanned/dispatched/failed counters without re-walking
   * the atom set or stitching through the lifecycle envelope.
   */
  readonly dispatchByPipeline: Map<string, PipelineDispatchSummary>;
  /*
   * pipeline-stage-event atoms with `transition='agent-turn'` grouped
   * by pipeline id. These index events point at the matching agent-turn
   * atom via `agent_turn_atom_id`; the detail projection cross-walks
   * each one through `atomById` to resolve telemetry. Kept separate
   * from `eventsByPipeline` so the existing stages strip is unaffected
   * by the new live-progress surface.
   */
  readonly agentTurnEventsByPipeline: Map<string, AgentTurnIndexEvent[]>;
  readonly atomById: Map<string, PipelineSourceAtom>;
}

function buildPipelineIndex(atoms: ReadonlyArray<PipelineSourceAtom>): PipelineIndex {
  const pipelinesById = new Map<string, PipelineSourceAtom>();
  const eventsByPipeline = new Map<string, PipelineStageEvent[]>();
  const findingsByPipeline = new Map<string, PipelineAuditFinding[]>();
  const failureByPipeline = new Map<string, PipelineFailureRecord>();
  const resumesByPipeline = new Map<string, PipelineResumeRecord[]>();
  const dispatchByPipeline = new Map<string, PipelineDispatchSummary>();
  const agentTurnEventsByPipeline = new Map<string, AgentTurnIndexEvent[]>();
  const atomById = new Map<string, PipelineSourceAtom>();

  for (const atom of atoms) {
    atomById.set(atom.id, atom);
    if (!isCleanLive(atom)) continue;
    if (atom.type === 'pipeline') {
      pipelinesById.set(atom.id, atom);
      continue;
    }
    if (atom.type === 'dispatch-record') {
      const meta = readMeta(atom);
      const pipelineId = readString(meta, 'pipeline_id');
      if (!pipelineId) continue;
      // Counters live under metadata.stage_output (per the dispatch-stage
      // atom shape); read defensively so a malformed atom yields zeros
      // rather than throwing for the whole list response.
      const stageOutput = (meta['stage_output'] && typeof meta['stage_output'] === 'object')
        ? (meta['stage_output'] as Record<string, unknown>)
        : {};
      dispatchByPipeline.set(pipelineId, {
        scanned: readNumber(stageOutput, 'scanned'),
        dispatched: readNumber(stageOutput, 'dispatched'),
        failed: readNumber(stageOutput, 'failed'),
      });
      continue;
    }
    if (
      atom.type !== 'pipeline-stage-event'
      && atom.type !== 'pipeline-audit-finding'
      && atom.type !== 'pipeline-failed'
      && atom.type !== 'pipeline-resume'
    ) {
      continue;
    }
    const meta = readMeta(atom);
    const pipelineId = readString(meta, 'pipeline_id');
    if (!pipelineId) continue;
    if (atom.type === 'pipeline-stage-event') {
      // Two surfaces consume pipeline-stage-event atoms:
      //   1. The canonical enter/exit/pause/resume lifecycle strip
      //      (via eventFromAtom, which filters non-lifecycle
      //      transitions out).
      //   2. The agent-turn index surface (via
      //      agentTurnIndexEventFromAtom). One atom can only land on
      //      ONE surface; the helpers are mutually exclusive by
      //      transition type.
      const event = eventFromAtom(atom);
      if (event) {
        const list = eventsByPipeline.get(pipelineId);
        if (list) list.push(event);
        else eventsByPipeline.set(pipelineId, [event]);
        continue;
      }
      const turnEvent = agentTurnIndexEventFromAtom(atom);
      if (turnEvent) {
        // Note: agent-turn atoms land ONLY in agentTurnEventsByPipeline
        // here, but they are NOT lost to lifecycle aggregation. The
        // detail + list paths below pass agentTurnEventsByPipeline as
        // the `agentTurnTimestamps` parameter to foldStageEvents
        // (search for `turnEvents` ~ line 740 and ~ line 912), which
        // advances per-stage `last_event_ts/iso` and (via the
        // stage-roll-up below) top-level pipeline `last_event_at`.
        // Tests covering this contract: `advances stage last_event_at
        // and pipeline last_event_at as agent-turn events stream`
        // and `list-summary also advances last_event_at with
        // agent-turn streaming` in pipelines.test.ts.
        const turnList = agentTurnEventsByPipeline.get(pipelineId);
        if (turnList) turnList.push(turnEvent);
        else agentTurnEventsByPipeline.set(pipelineId, [turnEvent]);
      }
    } else if (atom.type === 'pipeline-audit-finding') {
      const finding = findingFromAtom(atom);
      if (!finding) continue;
      const list = findingsByPipeline.get(pipelineId);
      if (list) list.push(finding);
      else findingsByPipeline.set(pipelineId, [finding]);
    } else if (atom.type === 'pipeline-failed') {
      const failure = failureFromAtom(atom);
      if (!failure) continue;
      // Earliest failure wins (a re-run would supersede the failed
      // atom rather than write another one in the same chain).
      const existing = failureByPipeline.get(pipelineId);
      if (!existing || parseIsoTs(failure.at) < parseIsoTs(existing.at)) {
        failureByPipeline.set(pipelineId, failure);
      }
    } else {
      const resume = resumeFromAtom(atom);
      if (!resume) continue;
      const list = resumesByPipeline.get(pipelineId);
      if (list) list.push(resume);
      else resumesByPipeline.set(pipelineId, [resume]);
    }
  }

  return {
    pipelinesById,
    eventsByPipeline,
    findingsByPipeline,
    failureByPipeline,
    resumesByPipeline,
    dispatchByPipeline,
    agentTurnEventsByPipeline,
    atomById,
  };
}

function countAuditSeverities(
  findings: ReadonlyArray<PipelineAuditFinding>,
): PipelineAuditCounts {
  let critical = 0;
  let major = 0;
  let minor = 0;
  for (const f of findings) {
    if (f.severity === 'critical') critical += 1;
    else if (f.severity === 'major') major += 1;
    else minor += 1;
  }
  return { total: critical + major + minor, critical, major, minor };
}

function summarizePipeline(
  pipeline: PipelineSourceAtom,
  index: PipelineIndex,
): PipelineSummary {
  const meta = readMeta(pipeline);
  const events = index.eventsByPipeline.get(pipeline.id) ?? [];
  const findings = index.findingsByPipeline.get(pipeline.id) ?? [];
  // Pass agent-turn timestamps into the fold so a stage that is still
  // emitting mid-session turns has a fresh last_event_at even before
  // its exit event lands. Mirrors the detail-path pattern below.
  const turnEvents = index.agentTurnEventsByPipeline.get(pipeline.id) ?? [];
  const { fold } = foldStageEvents(events, turnEvents);
  const stages = stageSummariesFromFold(fold);

  let totalCost = 0;
  let totalDuration = 0;
  let lastEventTs = parseIsoTs(pipeline.created_at);
  let lastEventIso = pipeline.created_at;
  for (const stage of stages) {
    totalCost += stage.cost_usd;
    totalDuration += stage.duration_ms;
    if (stage.last_event_at) {
      const ts = parseIsoTs(stage.last_event_at);
      if (Number.isFinite(ts) && ts > lastEventTs) {
        lastEventTs = ts;
        lastEventIso = stage.last_event_at;
      }
    }
  }

  const current = currentStageFromSummaries(stages);
  const auditCounts = countAuditSeverities(findings);
  const seedAtomIds = readStringArray(meta, 'seed_atom_ids')
    .length > 0
      ? readStringArray(meta, 'seed_atom_ids')
      : (pipeline.provenance && Array.isArray((pipeline.provenance as Record<string, unknown>)['derived_from'])
        ? ((pipeline.provenance as Record<string, unknown>)['derived_from'] as ReadonlyArray<unknown>)
          .filter((x): x is string => typeof x === 'string' && x.length > 0)
        : []);

  const correlationId = (pipeline.provenance && typeof (pipeline.provenance as Record<string, unknown>)['source'] === 'object'
    ? ((pipeline.provenance as Record<string, unknown>)['source'] as Record<string, unknown>)
    : null);
  const correlationIdValue = correlationId
    && typeof correlationId['session_id'] === 'string'
    && correlationId['session_id'].length > 0
      ? (correlationId['session_id'] as string)
      : null;

  return {
    pipeline_id: pipeline.id,
    pipeline_state: typeof pipeline.pipeline_state === 'string' ? pipeline.pipeline_state : 'pending',
    mode: readString(meta, 'mode'),
    principal_id: pipeline.principal_id,
    correlation_id: correlationIdValue,
    title: pipelineTitle(pipeline, index.atomById),
    seed_atom_ids: seedAtomIds,
    created_at: pipeline.created_at,
    last_event_at: lastEventIso,
    total_cost_usd: round6(totalCost),
    total_duration_ms: totalDuration,
    current_stage_name: current.name,
    current_stage_index: current.index,
    total_stages: stages.length,
    audit_counts: auditCounts,
    has_failed_atom: index.failureByPipeline.has(pipeline.id),
    has_resume_atom: (index.resumesByPipeline.get(pipeline.id) ?? []).length > 0,
    dispatch_summary: index.dispatchByPipeline.get(pipeline.id) ?? null,
  };
}

/**
 * Round a USD-cost figure to 6 decimal places. Millicent precision
 * matches the substrate atom-shape rounding so the projection does not
 * introduce a different decimal style.
 */
function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Build the full sorted set of pipeline summaries with NO cap applied.
 * The list endpoint slices to MAX_PIPELINE_LIST_ITEMS for grid render,
 * but live-ops needs to filter for active states first and then slice;
 * otherwise a busy workspace with 100+ recent terminal pipelines
 * pushes still-running pipelines out of the Pulse tile entirely.
 * Internal helper extracted at N=2 per canon `dev-extract-at-n=2`.
 */
function sortedPipelineSummaries(
  atoms: ReadonlyArray<PipelineSourceAtom>,
): ReadonlyArray<PipelineSummary> {
  const index = buildPipelineIndex(atoms);
  const summaries: PipelineSummary[] = [];
  for (const pipeline of index.pipelinesById.values()) {
    summaries.push(summarizePipeline(pipeline, index));
  }
  summaries.sort((a, b) => {
    const aTs = parseIsoTs(a.last_event_at);
    const bTs = parseIsoTs(b.last_event_at);
    if (aTs === bTs) return a.pipeline_id.localeCompare(b.pipeline_id);
    return bTs - aTs;
  });
  return summaries;
}

/**
 * `/api/pipelines.list` projection. Sorts by last_event_at desc so
 * recently-active pipelines top the grid.
 */
export function listPipelineSummaries(
  atoms: ReadonlyArray<PipelineSourceAtom>,
  now: number,
): PipelineListResult {
  const summaries = sortedPipelineSummaries(atoms);
  return {
    computed_at: new Date(now).toISOString(),
    pipelines: summaries.slice(0, MAX_PIPELINE_LIST_ITEMS),
  };
}

/**
 * `/api/pipelines.live-ops` projection. Narrowed to running/paused
 * pipelines for the Pulse tile. Filter BEFORE the live-ops cap so the
 * still-active rows always survive even when the general list overflows.
 * Indie defaults rarely hit the cap; the org-ceiling case (50+ concurrent
 * actors emitting pipelines) is where this ordering decision matters
 * per canon `dev-indie-floor-org-ceiling`.
 */
export function listLiveOpsPipelines(
  atoms: ReadonlyArray<PipelineSourceAtom>,
  now: number,
): PipelineLiveOpsResult {
  const all = sortedPipelineSummaries(atoms);
  const live: PipelineLiveOpsRow[] = [];
  for (const p of all) {
    if (p.pipeline_state !== 'running' && p.pipeline_state !== 'hil-paused') continue;
    live.push({
      pipeline_id: p.pipeline_id,
      pipeline_state: p.pipeline_state,
      title: p.title,
      current_stage_name: p.current_stage_name,
      current_stage_index: p.current_stage_index,
      total_stages: p.total_stages,
      last_event_at: p.last_event_at,
      total_cost_usd: p.total_cost_usd,
      dispatch_summary: p.dispatch_summary,
    });
  }
  return {
    computed_at: new Date(now).toISOString(),
    pipelines: live.slice(0, MAX_LIVE_OPS_PIPELINES),
  };
}

/**
 * `/api/pipelines.detail` projection. Returns null when the requested
 * pipeline atom is not in the store.
 */
export function getPipelineDetail(
  atoms: ReadonlyArray<PipelineSourceAtom>,
  pipelineId: string,
): PipelineDetail | null {
  const index = buildPipelineIndex(atoms);
  const pipeline = index.pipelinesById.get(pipelineId);
  if (!pipeline) return null;

  const meta = readMeta(pipeline);
  const allEvents = index.eventsByPipeline.get(pipelineId) ?? [];
  const allFindings = index.findingsByPipeline.get(pipelineId) ?? [];
  const failure = index.failureByPipeline.get(pipelineId) ?? null;
  const resumes = (index.resumesByPipeline.get(pipelineId) ?? []).slice().sort((a, b) => {
    const aTs = parseIsoTs(a.at);
    const bTs = parseIsoTs(b.at);
    return bTs - aTs;
  });

  // Feed agent-turn timestamps into the fold so per-stage
  // last_event_at and the top-level last_event_at advance while a
  // running stage streams turns. State + duration + cost remain
  // owned by lifecycle events only; see foldStageEvents for the
  // contract.
  const allTurnEvents = index.agentTurnEventsByPipeline.get(pipelineId) ?? [];
  const { fold, ordered } = foldStageEvents(allEvents, allTurnEvents);
  const stages = stageSummariesFromFold(fold);
  const current = currentStageFromSummaries(stages);

  let totalCost = 0;
  let totalDuration = 0;
  let lastEventTs = parseIsoTs(pipeline.created_at);
  let lastEventIso = pipeline.created_at;
  for (const stage of stages) {
    totalCost += stage.cost_usd;
    totalDuration += stage.duration_ms;
    if (stage.last_event_at) {
      const ts = parseIsoTs(stage.last_event_at);
      if (Number.isFinite(ts) && ts > lastEventTs) {
        lastEventTs = ts;
        lastEventIso = stage.last_event_at;
      }
    }
  }

  const findingsSorted = [...allFindings].sort((a, b) => {
    const wDiff = SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity];
    if (wDiff !== 0) return wDiff;
    return parseIsoTs(b.created_at) - parseIsoTs(a.created_at);
  });

  // Project agent-turn index events into the wire row shape, sorted
  // newest-first with `turn_index DESC` as the equal-timestamp
  // tiebreaker. Newest-first across ALL stages means the actively
  // running stage's most recent turn always leads when the operator
  // opens the detail view, which is the substrate's primary use-case
  // for this surface. Capped at PIPELINE_DETAIL_MAX_TURNS so a
  // long-running session does not blow the wire shape on every 5s
  // poll. Reuses `allTurnEvents` from the foldStageEvents call above.
  const turnRows: AgentTurnRow[] = allTurnEvents.map((evt) =>
    agentTurnRowFromIndex(evt, index.atomById),
  );
  turnRows.sort((a, b) => {
    const aTs = parseIsoTs(a.created_at);
    const bTs = parseIsoTs(b.created_at);
    if (aTs !== bTs) return bTs - aTs;
    return b.turn_index - a.turn_index;
  });
  const agentTurns = turnRows.slice(0, PIPELINE_DETAIL_MAX_TURNS);

  const seedAtomIds = readStringArray(meta, 'seed_atom_ids');
  // Fallback: if seed_atom_ids isn't on metadata (older atom?), use
  // provenance.derived_from for seed lineage so we still render
  // something non-empty in the detail header.
  const seedFromProvenance = pipeline.provenance && Array.isArray((pipeline.provenance as Record<string, unknown>)['derived_from'])
    ? ((pipeline.provenance as Record<string, unknown>)['derived_from'] as ReadonlyArray<unknown>)
      .filter((x): x is string => typeof x === 'string' && x.length > 0)
    : [];
  const finalSeedIds = seedAtomIds.length > 0 ? seedAtomIds : seedFromProvenance;

  const correlationId = (pipeline.provenance && typeof (pipeline.provenance as Record<string, unknown>)['source'] === 'object'
    ? ((pipeline.provenance as Record<string, unknown>)['source'] as Record<string, unknown>)
    : null);
  const correlationIdValue = correlationId
    && typeof correlationId['session_id'] === 'string'
    && correlationId['session_id'].length > 0
      ? (correlationId['session_id'] as string)
      : null;

  return {
    pipeline: {
      id: pipeline.id,
      pipeline_state: typeof pipeline.pipeline_state === 'string' ? pipeline.pipeline_state : 'pending',
      mode: readString(meta, 'mode'),
      principal_id: pipeline.principal_id,
      correlation_id: correlationIdValue,
      title: pipelineTitle(pipeline, index.atomById),
      content: pipeline.content,
      seed_atom_ids: finalSeedIds,
      stage_policy_atom_id: readString(meta, 'stage_policy_atom_id'),
      started_at: readString(meta, 'started_at') ?? pipeline.created_at,
      completed_at: readString(meta, 'completed_at'),
    },
    stages,
    events: ordered.slice(0, MAX_DETAIL_EVENTS),
    findings: findingsSorted.slice(0, MAX_DETAIL_FINDINGS),
    audit_counts: countAuditSeverities(findingsSorted),
    failure,
    resumes,
    agent_turns: agentTurns,
    total_cost_usd: round6(totalCost),
    total_duration_ms: totalDuration,
    current_stage_name: current.name,
    current_stage_index: current.index,
    total_stages: stages.length,
    last_event_at: lastEventIso,
    dispatch_summary: index.dispatchByPipeline.get(pipeline.id) ?? null,
  };
}
