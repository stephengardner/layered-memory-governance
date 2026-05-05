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
  PipelineAuditCounts,
  PipelineAuditFinding,
  PipelineAuditSeverity,
  PipelineDetail,
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
import { readString } from './projection-helpers.js';

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
 */
function foldStageEvents(events: ReadonlyArray<PipelineStageEvent>): {
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
  readonly atomById: Map<string, PipelineSourceAtom>;
}

function buildPipelineIndex(atoms: ReadonlyArray<PipelineSourceAtom>): PipelineIndex {
  const pipelinesById = new Map<string, PipelineSourceAtom>();
  const eventsByPipeline = new Map<string, PipelineStageEvent[]>();
  const findingsByPipeline = new Map<string, PipelineAuditFinding[]>();
  const failureByPipeline = new Map<string, PipelineFailureRecord>();
  const resumesByPipeline = new Map<string, PipelineResumeRecord[]>();
  const atomById = new Map<string, PipelineSourceAtom>();

  for (const atom of atoms) {
    atomById.set(atom.id, atom);
    if (!isCleanLive(atom)) continue;
    if (atom.type === 'pipeline') {
      pipelinesById.set(atom.id, atom);
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
      const event = eventFromAtom(atom);
      if (!event) continue;
      const list = eventsByPipeline.get(pipelineId);
      if (list) list.push(event);
      else eventsByPipeline.set(pipelineId, [event]);
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
  const { fold } = foldStageEvents(events);
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

  const { fold, ordered } = foldStageEvents(allEvents);
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
    total_cost_usd: round6(totalCost),
    total_duration_ms: totalDuration,
    current_stage_name: current.name,
    current_stage_index: current.index,
    total_stages: stages.length,
    last_event_at: lastEventIso,
  };
}
