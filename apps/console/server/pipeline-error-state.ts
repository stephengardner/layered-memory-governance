/**
 * Pure synthesizer: pipeline_id -> categorized error-state projection.
 *
 * Reads the pipeline atom + pipeline-failed atom + pipeline-audit-finding
 * atoms + pipeline-stage-event atoms from a flat atom array and projects
 * one `PipelineErrorState` envelope that the Console's PipelineErrorBlock
 * renders inline on /pipelines/<id> when the pipeline is in a terminal-
 * negative state (failed / kill-switch-halted / operator-abandoned).
 *
 * Design constraints (mirror pipelines.ts / intent-outcome.ts):
 *   - Pure: no I/O, no globals, no time. The handler in server/index.ts
 *     feeds the full atom array; this module folds it into a wire shape.
 *   - Read-only by construction. The substrate writes the underlying
 *     atoms; this module observes them.
 *   - Defensive on partial chains: a pipeline-failed atom without a
 *     resolvable pipeline atom still produces a populated envelope so
 *     the operator sees ground truth even when the chain is incomplete.
 *
 * Categorization rules (parsed from pipeline-failed.cause):
 *   - 'budget-exceeded'             : cause starts with 'budget-overflow:'
 *     emitted by runner.ts when stage cost > cap
 *   - 'pipeline-cost-overflow'      : cause starts with 'pipeline-cost-overflow:'
 *     emitted when accumulated cost > pipeline cap
 *   - 'schema-mismatch'             : cause starts with 'schema-validation-failed:'
 *     emitted when stage.outputSchema.safeParse rejects the value
 *   - 'critical-audit-finding'      : cause === 'critical-audit-finding'
 *     emitted when any auditor finding has severity='critical'
 *   - 'plan-author-confabulation'   : critical finding with category in the
 *     drafter-confabulation set (target_paths-mismatch, citation-not-found)
 *   - 'unknown-stage'               : cause string is 'unknown-stage' or the
 *     failed stage name is 'unknown-stage' (resumeFromStage missing)
 *   - 'kill-switch-halted'          : pipeline_state='failed' without a
 *     pipeline-failed atom, paired with a kill-switch-halt marker on the
 *     stage's exit-failure event metadata (substrate emits this when
 *     STOP flipped mid-stage)
 *   - 'operator-abandoned'          : pipeline atom carries metadata
 *     abandoned_at / abandoned_by (operator-issued via CLI)
 *   - 'stage-output-persist-failed' : cause starts with 'stage-output-persist-failed:'
 *   - 'stage-threw'                 : cause does not match any of the above
 *     and the failed-stage's exit-failure event has cost_usd > 0 (i.e.
 *     the stage ran code rather than getting rejected upstream)
 *   - 'uncategorized'               : fall-through
 *
 * Severity mapping is canonical per category:
 *   - critical : budget-exceeded, pipeline-cost-overflow, schema-mismatch,
 *                critical-audit-finding, plan-author-confabulation,
 *                stage-output-persist-failed
 *   - warning  : kill-switch-halted, operator-abandoned, unknown-stage
 *   - info     : stage-threw, uncategorized (operator still sees raw cause)
 */
import type {
  PipelineErrorAction,
  PipelineErrorCategory,
  PipelineErrorSeverity,
  PipelineErrorState,
  PipelineErrorStateSourceAtom,
} from './pipeline-error-state-types.js';
import { readObject, readString } from './projection-helpers.js';

/**
 * Live-atom filter: matches pipelines.ts / intent-outcome.ts so a
 * tainted or superseded atom never slips into the synthesis.
 */
function isCleanLive(atom: PipelineErrorStateSourceAtom): boolean {
  if (atom.taint && atom.taint !== 'clean') return false;
  if (atom.superseded_by && atom.superseded_by.length > 0) return false;
  return true;
}

/**
 * Drafter-confabulation finding categories. A critical finding with
 * one of these category values upgrades the bucket from generic
 * 'critical-audit-finding' to the more specific 'plan-author-
 * confabulation' so the recovery suggestion can point at canon
 * `dev-drafter-citation-verification-required` rather than a generic
 * "address the finding" message.
 */
const CONFAB_FINDING_CATEGORIES: ReadonlySet<string> = new Set([
  'target-paths-mismatch',
  'target_paths-mismatch',
  'citation-not-found',
  'cited-path-not-found',
  'cited-atom-not-found',
  'drafter-confabulation',
  'plan-author-confabulation',
]);

/**
 * Parse a pipeline-failed.cause string into the canonical category +
 * severity. Order of branches is the canonical priority when multiple
 * prefixes could match -- e.g. a substrate that ever produces both
 * "budget-overflow" + a schema-validation prefix would resolve to
 * budget-overflow (the higher-priority branch).
 *
 * The categorizer is also called with the finding category list so a
 * critical-audit-finding cause can upgrade to plan-author-confabulation
 * when the matching finding is from the confab set.
 */
export function categorizeCause(
  cause: string,
  criticalFindingCategories: ReadonlyArray<string>,
): { category: PipelineErrorCategory; severity: PipelineErrorSeverity } {
  if (cause.startsWith('budget-overflow:')) {
    return { category: 'budget-exceeded', severity: 'critical' };
  }
  if (cause.startsWith('pipeline-cost-overflow:')) {
    return { category: 'pipeline-cost-overflow', severity: 'critical' };
  }
  if (cause.startsWith('schema-validation-failed:')) {
    return { category: 'schema-mismatch', severity: 'critical' };
  }
  if (cause === 'critical-audit-finding') {
    // Upgrade to plan-author-confabulation when ANY critical finding
    // carries a confab-shaped category. Keep the broader bucket if no
    // finding matches so the operator still sees the right recovery
    // suggestion in the catch-all case.
    const hasConfab = criticalFindingCategories.some((c) =>
      CONFAB_FINDING_CATEGORIES.has(c),
    );
    return hasConfab
      ? { category: 'plan-author-confabulation', severity: 'critical' }
      : { category: 'critical-audit-finding', severity: 'critical' };
  }
  if (cause === 'unknown-stage' || cause.startsWith('unknown-stage')) {
    return { category: 'unknown-stage', severity: 'warning' };
  }
  if (cause.startsWith('stage-output-persist-failed:')) {
    return { category: 'stage-output-persist-failed', severity: 'critical' };
  }
  // Any cause that survived to here was emitted by the runner's
  // generic stage-threw branch (the `catch (err)` inside the try/await
  // block that wraps stage.run). Treat as info-tier because the cause
  // string carries the underlying error message verbatim; the
  // operator inspects raw_cause to triage.
  if (cause.length > 0) {
    return { category: 'stage-threw', severity: 'info' };
  }
  return { category: 'uncategorized', severity: 'info' };
}

/**
 * Recovery suggestion text per category. Kept as a server-rendered
 * string so the UI doesn't have to ship its own copy of the
 * suggestion lookup; new categories land with a single source-of-truth
 * change here.
 *
 * `failedStageName` is interpolated when present so the suggestion
 * reads with concrete context ("re-run from `plan-stage`" vs the
 * generic "re-run from the failed stage").
 */
function suggestedActionFor(
  category: PipelineErrorCategory,
  failedStageName: string | null,
  rawCause: string | null,
  abandonReason: string | null,
): string {
  const stage = failedStageName ?? 'the failed stage';
  switch (category) {
    case 'budget-exceeded':
      return `Raise the per-stage cost cap via pol-pipeline-stage-cost-cap (or set the stage's budget_cap_usd) and re-run from ${stage}. The substrate halts when the stage's cost exceeds the configured ceiling.`;
    case 'pipeline-cost-overflow':
      return `The pipeline's accumulated cost exceeded the pipeline-wide cap. Raise pol-pipeline-cost-cap or simplify the stage chain and re-run from ${stage}.`;
    case 'schema-mismatch':
      return `Stage '${stage}' produced an output that did not match its declared schema. Inspect the rejected payload via the View output button and adjust the stage's prompt or schema; re-run after addressing.`;
    case 'critical-audit-finding':
      return `The auditor flagged a critical finding at ${stage}. Address the finding (see the cited atoms) and re-run from the prior stage. Critical findings always halt the pipeline by canon.`;
    case 'plan-author-confabulation':
      return `Plan-author drafted target_paths or citations that did not match repo state -- see canon dev-drafter-citation-verification-required. Review the plan output, correct the citations, and re-run from ${stage}.`;
    case 'unknown-stage':
      return `Pipeline tried to resume from an unknown stage name. Verify the canon stage-list and the resumeFromStage argument; re-run with a valid stage name.`;
    case 'kill-switch-halted':
      return `Pipeline was halted by the .lag/STOP kill switch mid-execution. Clear the sentinel (rm .lag/STOP) and re-dispatch the pipeline from the operator CLI.`;
    case 'operator-abandoned':
      return abandonReason && abandonReason.length > 0
        ? `Operator abandoned the pipeline with reason: ${abandonReason}. Re-dispatch a fresh pipeline if the work still needs to ship.`
        : `Operator marked the pipeline non-recoverable. Re-dispatch a fresh pipeline if the work still needs to ship.`;
    case 'stage-output-persist-failed':
      return `Stage '${stage}' produced a valid output but the AtomStore rejected the persist. Inspect the raw cause for the storage layer error; the substrate's failure was downstream of the LLM call.`;
    case 'stage-threw':
      return rawCause && rawCause.length > 0
        ? `Stage '${stage}' threw an uncategorized error: ${rawCause}. Inspect the failure atom for the full trace and re-run from ${stage} after addressing.`
        : `Stage '${stage}' threw an uncategorized error. Inspect the failure atom and re-run from ${stage} after addressing.`;
    case 'uncategorized':
      return `Pipeline failed without categorized metadata. See the failure atom for the raw cause and re-run from ${stage} after addressing.`;
  }
}

const CATEGORY_LABELS: Readonly<Record<PipelineErrorCategory, string>> = Object.freeze({
  'budget-exceeded': 'Budget exceeded',
  'pipeline-cost-overflow': 'Pipeline cost cap exceeded',
  'schema-mismatch': 'Schema mismatch',
  'critical-audit-finding': 'Critical audit finding',
  'plan-author-confabulation': 'Plan-author confabulation',
  'unknown-stage': 'Unknown stage',
  'kill-switch-halted': 'Halted by kill switch',
  'operator-abandoned': 'Abandoned by operator',
  'stage-output-persist-failed': 'Stage-output persist failed',
  'stage-threw': 'Stage threw an error',
  'uncategorized': 'Uncategorized failure',
});

const CANON_DIRECTIVE_FOR_CATEGORY: Readonly<Partial<Record<PipelineErrorCategory, string>>> = Object.freeze({
  'plan-author-confabulation': 'dev-drafter-citation-verification-required',
  'critical-audit-finding': 'dev-implementation-canon-audit-loop',
  'budget-exceeded': 'dev-indie-floor-org-ceiling',
  'pipeline-cost-overflow': 'dev-indie-floor-org-ceiling',
  'kill-switch-halted': 'inv-kill-switch-first',
});

const POLICY_ATOM_FOR_CATEGORY: Readonly<Partial<Record<PipelineErrorCategory, string>>> = Object.freeze({
  'budget-exceeded': 'pol-pipeline-stage-cost-cap',
  'pipeline-cost-overflow': 'pol-pipeline-cost-cap',
});

/**
 * Build the quick-action list for a category. Order is the canonical
 * render order in the UI (left -> right on desktop, top -> bottom on
 * mobile per the wide-block rules). 'View failure atom' is always
 * first when a failure atom exists; 'Abandon pipeline' is always last
 * because it is the destructive escape hatch.
 *
 * `failureAtomId` is the pipeline-failed atom id (null when no failure
 * atom exists yet -- e.g. kill-switch halt that fired before failPipeline
 * could write).
 *
 * `failedStageOutputAtomId` is the persisted stage-output atom id (when
 * the stage wrote one before failure); used by the 'View output' action
 * for schema-mismatch + critical-audit-finding + plan-author-
 * confabulation so the operator can read the exact payload the
 * substrate rejected.
 */
function buildActions(
  category: PipelineErrorCategory,
  failureAtomId: string | null,
  failedStageOutputAtomId: string | null,
  firstCriticalFindingAtomId: string | null,
  state: 'failed' | 'halted' | 'abandoned',
): ReadonlyArray<PipelineErrorAction> {
  const actions: PipelineErrorAction[] = [];

  // 1. View the failure atom (or the critical finding atom when present
  //    and more diagnostic than the failure atom alone).
  if (firstCriticalFindingAtomId && (category === 'critical-audit-finding' || category === 'plan-author-confabulation')) {
    actions.push({
      kind: 'view-atom',
      label: 'View finding atom',
      atom_id: firstCriticalFindingAtomId,
      canon_id: null,
    });
  }
  if (failureAtomId) {
    actions.push({
      kind: 'view-atom',
      label: 'View failure atom',
      atom_id: failureAtomId,
      canon_id: null,
    });
  }

  // 2. View the stage output (when the stage produced one before the
  //    halt). Only surface for categories where the output is the
  //    diagnostic payload.
  if (
    failedStageOutputAtomId
    && (category === 'schema-mismatch'
      || category === 'critical-audit-finding'
      || category === 'plan-author-confabulation')
  ) {
    actions.push({
      kind: 'view-output',
      label: 'View stage output',
      atom_id: failedStageOutputAtomId,
      canon_id: null,
    });
  }

  // 3. View the policy atom (budget / cost-cap categories).
  const policyId = POLICY_ATOM_FOR_CATEGORY[category];
  if (policyId) {
    actions.push({
      kind: 'view-policy',
      label: `View ${policyId}`,
      atom_id: policyId,
      canon_id: null,
    });
  }

  // 4. View the canon directive cited by the category.
  const canonId = CANON_DIRECTIVE_FOR_CATEGORY[category];
  if (canonId) {
    actions.push({
      kind: 'view-canon',
      label: 'Open cited canon',
      atom_id: null,
      canon_id: canonId,
    });
  }

  // 5. Abandon pipeline. Surfaced ONLY when the pipeline is halted by
  //    the kill switch (non-terminal in substrate terms; the kill-switch
  //    halt is recoverable). For `failed` and `abandoned` states the
  //    substrate rejects abandon with 409 `pipeline-already-terminal`
  //    per pipeline-abandon.ts::validateAbandon, so surfacing the button
  //    would mislead the operator into clicking through to an
  //    unactionable error. Halted pipelines can also recover via the
  //    operator CLI; the button is the escape hatch when re-running is
  //    not the right call.
  if (state === 'halted') {
    actions.push({
      kind: 'abandon',
      label: 'Abandon pipeline',
      atom_id: null,
      canon_id: null,
    });
  }

  return actions;
}

/**
 * Pick the pipeline atom by id. Returns null when no live atom matches.
 */
function pickPipeline(
  atoms: ReadonlyArray<PipelineErrorStateSourceAtom>,
  pipelineId: string,
): PipelineErrorStateSourceAtom | null {
  for (const atom of atoms) {
    if (atom.type !== 'pipeline') continue;
    if (atom.id !== pipelineId) continue;
    if (!isCleanLive(atom)) continue;
    return atom;
  }
  return null;
}

/**
 * Pick the pipeline-failed atom for a pipeline. Earliest failure wins:
 * a re-run supersedes the failed atom rather than emitting a sibling,
 * but defensive ordering picks the chronologically-earliest live atom
 * in case the substrate ever emits more than one.
 */
function pickFailureAtom(
  atoms: ReadonlyArray<PipelineErrorStateSourceAtom>,
  pipelineId: string,
): PipelineErrorStateSourceAtom | null {
  let earliest: PipelineErrorStateSourceAtom | null = null;
  let earliestTs = Infinity;
  for (const atom of atoms) {
    if (atom.type !== 'pipeline-failed') continue;
    if (!isCleanLive(atom)) continue;
    const meta = (atom.metadata ?? {}) as Record<string, unknown>;
    if (readString(meta, 'pipeline_id') !== pipelineId) continue;
    const ts = Date.parse(atom.created_at);
    if (Number.isFinite(ts) && ts < earliestTs) {
      earliestTs = ts;
      earliest = atom;
    }
  }
  return earliest;
}

/**
 * Collect critical audit findings for a pipeline. Returns the live
 * subset, deterministically ordered (earliest created_at wins ties so
 * the categorizer's "first critical finding" pointer is stable across
 * runs).
 */
function collectCriticalFindings(
  atoms: ReadonlyArray<PipelineErrorStateSourceAtom>,
  pipelineId: string,
): ReadonlyArray<{ atom_id: string; category: string; created_at: string }> {
  const out: { atom_id: string; category: string; created_at: string }[] = [];
  for (const atom of atoms) {
    if (atom.type !== 'pipeline-audit-finding') continue;
    if (!isCleanLive(atom)) continue;
    const meta = (atom.metadata ?? {}) as Record<string, unknown>;
    if (readString(meta, 'pipeline_id') !== pipelineId) continue;
    if (readString(meta, 'severity') !== 'critical') continue;
    const category = readString(meta, 'category');
    if (!category) continue;
    out.push({ atom_id: atom.id, category, created_at: atom.created_at });
  }
  out.sort((a, b) => {
    const aTs = Date.parse(a.created_at);
    const bTs = Date.parse(b.created_at);
    if (aTs !== bTs) return aTs - bTs;
    return a.atom_id.localeCompare(b.atom_id);
  });
  return out;
}

/**
 * Find the failed stage's persisted stage-output atom id. The substrate
 * stamps `output_atom_id` on the failing stage's exit-failure event
 * when the stage successfully persisted before failure (e.g. schema
 * validation rejected the value AFTER persist; critical-audit-finding
 * halted AFTER persist). Returns null when no output_atom_id is on the
 * exit-failure event for the failed stage.
 */
function findFailedStageOutputAtomId(
  atoms: ReadonlyArray<PipelineErrorStateSourceAtom>,
  pipelineId: string,
  failedStageName: string,
): string | null {
  for (const atom of atoms) {
    if (atom.type !== 'pipeline-stage-event') continue;
    if (!isCleanLive(atom)) continue;
    const meta = (atom.metadata ?? {}) as Record<string, unknown>;
    if (readString(meta, 'pipeline_id') !== pipelineId) continue;
    if (readString(meta, 'stage_name') !== failedStageName) continue;
    if (readString(meta, 'transition') !== 'exit-failure') continue;
    const outputAtomId = readString(meta, 'output_atom_id');
    if (outputAtomId) return outputAtomId;
  }
  return null;
}

/**
 * Detect whether the pipeline was halted by the kill switch. The
 * substrate's failPipeline path writes a pipeline-failed atom with a
 * canonical cause string, but the kill-switch halt path returns
 * `{ kind: 'halted' }` WITHOUT emitting a pipeline-failed atom. The
 * pipeline atom's `pipeline_state` therefore stays at 'running' (or
 * whatever it was when STOP fired) until the operator re-enters the
 * loop. We detect this by combining two signals:
 *
 *   1. A pipeline-stage-event atom for the pipeline whose metadata
 *      carries `halt_reason: 'kill-switch'` (substrate stamps this
 *      when the runner observes STOP between attempts -- see runner.ts
 *      retry loop).
 *   2. The pipeline atom carries metadata.halted_by='kill-switch'
 *      (operator-CLI-initiated halt that flips the kill switch).
 *
 * Returns null when neither signal is present.
 */
function detectKillSwitchHalt(
  pipeline: PipelineErrorStateSourceAtom | null,
  atoms: ReadonlyArray<PipelineErrorStateSourceAtom>,
  pipelineId: string,
): { halted: true; stageName: string | null } | null {
  const pipelineMeta = (pipeline?.metadata ?? {}) as Record<string, unknown>;
  if (readString(pipelineMeta, 'halted_by') === 'kill-switch') {
    return { halted: true, stageName: null };
  }
  for (const atom of atoms) {
    if (atom.type !== 'pipeline-stage-event') continue;
    if (!isCleanLive(atom)) continue;
    const meta = (atom.metadata ?? {}) as Record<string, unknown>;
    if (readString(meta, 'pipeline_id') !== pipelineId) continue;
    if (readString(meta, 'halt_reason') === 'kill-switch') {
      return { halted: true, stageName: readString(meta, 'stage_name') };
    }
  }
  return null;
}

/**
 * Detect whether the pipeline was abandoned by the operator. Today
 * the substrate signals abandonment via a metadata patch on the
 * pipeline atom (`abandoned_at` + `abandoned_by` + optional
 * `abandoned_reason`). A future substrate may emit a separate
 * `pipeline-abandoned` atom -- this helper accepts EITHER signal so
 * the projection survives the change without coordinated work.
 */
function detectOperatorAbandon(
  pipeline: PipelineErrorStateSourceAtom | null,
  atoms: ReadonlyArray<PipelineErrorStateSourceAtom>,
  pipelineId: string,
): { abandoned: true; reason: string | null; at: string | null } | null {
  const pipelineMeta = (pipeline?.metadata ?? {}) as Record<string, unknown>;
  const abandonedAt = readString(pipelineMeta, 'abandoned_at');
  if (abandonedAt) {
    return {
      abandoned: true,
      reason: readString(pipelineMeta, 'abandoned_reason'),
      at: abandonedAt,
    };
  }
  // Forward-compat: a dedicated pipeline-abandoned atom type.
  for (const atom of atoms) {
    if (atom.type !== 'pipeline-abandoned') continue;
    if (!isCleanLive(atom)) continue;
    const meta = (atom.metadata ?? {}) as Record<string, unknown>;
    if (readString(meta, 'pipeline_id') !== pipelineId) continue;
    return {
      abandoned: true,
      reason: readString(meta, 'reason'),
      at: atom.created_at,
    };
  }
  return null;
}

/**
 * Resolve cited_atom_ids for the error block:
 *   - For a failure-atom-backed state, the substrate's `chain` field
 *     carries the seed -> failing-stage-output trail (capped at 32 by
 *     the substrate per atom-shapes.ts MAX_CITED_LIST).
 *   - For a critical-audit-finding, also include the finding's
 *     cited_atom_ids so the operator's "View finding atom" + cited
 *     atoms are on the same visible chip row.
 */
function buildCitedAtomIds(
  failureAtom: PipelineErrorStateSourceAtom | null,
  firstCriticalFinding: PipelineErrorStateSourceAtom | null,
): ReadonlyArray<string> {
  const out: string[] = [];
  if (failureAtom) {
    const meta = (failureAtom.metadata ?? {}) as Record<string, unknown>;
    const chain = meta['chain'];
    if (Array.isArray(chain)) {
      for (const id of chain) {
        if (typeof id === 'string' && id.length > 0 && !out.includes(id)) {
          out.push(id);
        }
      }
    }
  }
  if (firstCriticalFinding) {
    const meta = (firstCriticalFinding.metadata ?? {}) as Record<string, unknown>;
    const cited = meta['cited_atom_ids'];
    if (Array.isArray(cited)) {
      for (const id of cited) {
        if (typeof id === 'string' && id.length > 0 && !out.includes(id)) {
          out.push(id);
        }
      }
    }
  }
  return out;
}

/**
 * Find a critical-audit-finding atom by its id from the source array.
 * Tight helper rather than a re-walk so the categorizer can pull the
 * finding's full atom for `buildCitedAtomIds` and the finding's
 * cited_atom_ids without re-scanning.
 */
function findAtomById(
  atoms: ReadonlyArray<PipelineErrorStateSourceAtom>,
  atomId: string,
): PipelineErrorStateSourceAtom | null {
  for (const atom of atoms) {
    if (atom.id === atomId) return atom;
  }
  return null;
}

/**
 * Main entry: build the PipelineErrorState envelope for one pipeline.
 *
 * Returns 'ok' state when the pipeline is not in a terminal-negative
 * state (running, pending, hil-paused, completed). The 'ok' shape
 * leaves every diagnostic field null so the client renders an empty
 * block; this is intentional rather than 404 because the client polls
 * this endpoint on every refresh of /pipelines/<id> and a 404 storm
 * for the happy path would clutter the network panel.
 *
 * `now` is injected for testability; production callers pass
 * `Date.now()`.
 */
export function buildPipelineErrorState(
  atoms: ReadonlyArray<PipelineErrorStateSourceAtom>,
  pipelineId: string,
  now: number,
): PipelineErrorState {
  const computedAt = new Date(now).toISOString();

  const pipeline = pickPipeline(atoms, pipelineId);
  const failureAtom = pickFailureAtom(atoms, pipelineId);
  const criticalFindings = collectCriticalFindings(atoms, pipelineId);
  const firstFindingId = criticalFindings.length > 0 ? criticalFindings[0]!.atom_id : null;
  const firstFinding = firstFindingId ? findAtomById(atoms, firstFindingId) : null;

  // Priority order:
  //   1. operator-abandoned (explicit operator signal trumps everything)
  //   2. failure atom (substrate-emitted failure)
  //   3. kill-switch halt (substrate-emitted halt without failure atom)
  //   4. ok (happy path)
  //
  // Critical-audit-finding atoms without a failure atom are still
  // surfaced via priority 2: failPipeline writes a pipeline-failed
  // atom with cause='critical-audit-finding' when the audit halt
  // fires. The bare-finding-without-failure-atom case (substrate bug)
  // falls through to ok and the client renders no error block; this
  // is intentional fail-open behavior because rendering an error
  // block whose root atom we cannot resolve would confuse the
  // operator.

  const abandon = detectOperatorAbandon(pipeline, atoms, pipelineId);
  if (abandon) {
    const category: PipelineErrorCategory = 'operator-abandoned';
    return {
      pipeline_id: pipelineId,
      state: 'abandoned',
      severity: 'warning',
      category,
      category_label: CATEGORY_LABELS[category],
      suggested_action: suggestedActionFor(category, null, null, abandon.reason),
      raw_cause: abandon.reason,
      failed_stage_name: null,
      failed_stage_index: null,
      cited_atom_ids: [],
      actions: buildActions(category, null, null, null, 'abandoned'),
      computed_at: computedAt,
    };
  }

  if (failureAtom) {
    const meta = (failureAtom.metadata ?? {}) as Record<string, unknown>;
    const cause = readString(meta, 'cause') ?? '';
    const failedStageName = readString(meta, 'failed_stage_name');
    const failedStageIndexRaw = meta['failed_stage_index'];
    const failedStageIndex = typeof failedStageIndexRaw === 'number' && Number.isFinite(failedStageIndexRaw)
      ? failedStageIndexRaw
      : null;
    const { category, severity } = categorizeCause(
      cause,
      criticalFindings.map((f) => f.category),
    );
    const stageOutputAtomId = failedStageName
      ? findFailedStageOutputAtomId(atoms, pipelineId, failedStageName)
      : null;

    return {
      pipeline_id: pipelineId,
      state: 'failed',
      severity,
      category,
      category_label: CATEGORY_LABELS[category],
      suggested_action: suggestedActionFor(category, failedStageName, cause, null),
      raw_cause: cause.length > 0 ? cause : null,
      failed_stage_name: failedStageName,
      failed_stage_index: failedStageIndex,
      cited_atom_ids: buildCitedAtomIds(failureAtom, firstFinding),
      actions: buildActions(category, failureAtom.id, stageOutputAtomId, firstFindingId, 'failed'),
      computed_at: computedAt,
    };
  }

  const killSwitch = detectKillSwitchHalt(pipeline, atoms, pipelineId);
  if (killSwitch) {
    const category: PipelineErrorCategory = 'kill-switch-halted';
    return {
      pipeline_id: pipelineId,
      state: 'halted',
      severity: 'warning',
      category,
      category_label: CATEGORY_LABELS[category],
      suggested_action: suggestedActionFor(category, killSwitch.stageName, null, null),
      raw_cause: 'halted by .lag/STOP kill switch',
      failed_stage_name: killSwitch.stageName,
      failed_stage_index: null,
      cited_atom_ids: [],
      actions: buildActions(category, null, null, null, 'halted'),
      computed_at: computedAt,
    };
  }

  // Happy path: no error block to render.
  return {
    pipeline_id: pipelineId,
    state: 'ok',
    severity: null,
    category: null,
    category_label: null,
    suggested_action: null,
    raw_cause: null,
    failed_stage_name: null,
    failed_stage_index: null,
    cited_atom_ids: [],
    actions: [],
    computed_at: computedAt,
  };
}

// readObject re-export so the test module can verify the helper is
// wired through projection-helpers (catches a regression where a
// future refactor drops the shared helper for an inline copy).
export { readObject };
