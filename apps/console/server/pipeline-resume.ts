/**
 * Pure helpers for the `/api/pipeline.resume` handler.
 *
 * The Console UI surfaces a Resume button on /pipelines/<id> for any
 * HIL-paused pipeline. When clicked, the backend route flips the
 * pipeline atom's `pipeline_state` from `hil-paused` to `running` and
 * writes a `pipeline-resume` audit atom. The pure helpers in this
 * module do the up-front validation (paused-state check, paused-stage
 * resolution, allowed_resumers gate) so the handler stays a thin
 * disk-write wrapper and the unit tests can exercise every rung
 * without standing up the HTTP server.
 *
 * Runtime parity: server/index.ts imports from this module and uses
 * the same exported helpers for the route's load path, so the test
 * and the real handler agree by construction.
 *
 * Authority contract: the substrate's HIL gate at
 * `src/runtime/planning-pipeline/runner.ts` reads
 * `pol-pipeline-stage-hil-<stage_name>` canon atoms and enforces
 * pause_mode + allowed_resumers semantics at runner-tick time. The
 * Console resume endpoint mirrors that gate by re-reading the same
 * canon atom and refusing a resume from a caller absent from
 * `allowed_resumers`. The substrate is authoritative; this module is
 * a UI-side mirror so a forbidden click never lands a write atom on
 * disk. Without the mirror, a write would land and the next runner
 * tick would silently ignore it on substrate-side re-validation,
 * leaving a misleading audit-chain entry.
 *
 * Read-only by construction for the validation half: the helpers do
 * NOT read or write the filesystem; the route handler injects the
 * atoms it has in hand from the in-memory index per canon
 * `dec-console-atom-index-projection`.
 */

/**
 * Narrow atom shape the resume helpers consume. Mirrors
 * `IntentOutcomeSourceAtom` and `PipelineSourceAtom` so the synthesizer
 * stays decoupled from the substrate's full Atom shape. Type-only:
 * the caller injects the atom array and the helpers walk it.
 */
export interface PipelineResumeSourceAtom {
  readonly id: string;
  readonly type: string;
  readonly content: string;
  readonly principal_id: string;
  readonly created_at: string;
  readonly metadata?: Record<string, unknown>;
  readonly provenance?: Record<string, unknown>;
  readonly taint?: string;
  readonly superseded_by?: ReadonlyArray<string>;
  readonly pipeline_state?: string;
}

/**
 * Result of `validateResumeRequest`. The handler reads each rung in
 * order:
 *   - kind='ok'         : write the resume atom + flip pipeline_state
 *   - kind='not-paused' : 409, pipeline is not currently paused
 *   - kind='not-found'  : 404, no pipeline atom with the requested id
 *   - kind='forbidden'  : 403, caller not in allowed_resumers
 *   - kind='no-policy'  : 403, no HIL canon atom found for the paused
 *                        stage (fail closed; without a policy we
 *                        cannot authorize a resume)
 *   - kind='no-stage'   : 409, paused but no hil-pause event resolves
 *                        the stage name (substrate invariant violated
 *                        upstream; surfaced loud to the operator)
 */
export type ValidateResumeResult =
  | {
      readonly kind: 'ok';
      readonly stageName: string;
      readonly allowedResumers: ReadonlyArray<string>;
    }
  | { readonly kind: 'not-paused'; readonly pipelineState: string | null }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'forbidden'; readonly stageName: string; readonly allowedResumers: ReadonlyArray<string> }
  | { readonly kind: 'no-policy'; readonly stageName: string }
  | { readonly kind: 'no-stage' };

/**
 * Live-atom filter. Same shape as
 * `intent-outcome.ts::isCleanLive` and `pipelines.ts::isCleanLive`.
 * A tainted or superseded atom must never authorize a state flip.
 */
function isCleanLive(atom: PipelineResumeSourceAtom): boolean {
  if (atom.taint && atom.taint !== 'clean') return false;
  if (atom.superseded_by && atom.superseded_by.length > 0) return false;
  return true;
}

/**
 * Resolve the paused-stage name for a pipeline by walking the latest
 * pipeline-stage-event atom whose transition is `hil-pause`. The
 * substrate emits exactly one `hil-pause` event per paused stage so
 * the latest such event for the pipeline is authoritative.
 *
 * Returns null when no hil-pause event resolves; the route caller
 * surfaces that as `no-stage` so the operator sees a substrate
 * invariant violation rather than a silent skip.
 *
 * Pure: takes the atom array in, returns the resolved stage name.
 * The handler injects atoms from its in-memory index per canon
 * `dec-console-atom-index-projection`.
 */
export function resolvePausedStageName(
  atoms: ReadonlyArray<PipelineResumeSourceAtom>,
  pipelineId: string,
): string | null {
  let chosen: { name: string; ts: number } | null = null;
  for (const atom of atoms) {
    if (atom.type !== 'pipeline-stage-event') continue;
    if (!isCleanLive(atom)) continue;
    const meta = (atom.metadata ?? {}) as Record<string, unknown>;
    if (meta['pipeline_id'] !== pipelineId) continue;
    if (meta['transition'] !== 'hil-pause') continue;
    const stageName = meta['stage_name'];
    if (typeof stageName !== 'string' || stageName.length === 0) continue;
    const ts = Date.parse(atom.created_at);
    if (!Number.isFinite(ts)) continue;
    if (chosen === null || ts > chosen.ts) {
      chosen = { name: stageName, ts };
    }
  }
  return chosen?.name ?? null;
}

/**
 * Find the pipeline atom by id. The handler uses this to verify the
 * pipeline exists AND to read its current `pipeline_state` for the
 * paused-check rung.
 */
export function pickPipelineAtom(
  atoms: ReadonlyArray<PipelineResumeSourceAtom>,
  pipelineId: string,
): PipelineResumeSourceAtom | null {
  for (const atom of atoms) {
    if (atom.type !== 'pipeline') continue;
    if (atom.id !== pipelineId) continue;
    if (!isCleanLive(atom)) continue;
    return atom;
  }
  return null;
}

/**
 * Resolve the canon HIL policy atom's `allowed_resumers` list for a
 * paused stage. Walks every L3 directive atom looking for one whose
 * `metadata.policy.subject === 'pipeline-stage-hil'` and
 * `metadata.policy.stage_name === stageName`. Returns null when no
 * matching atom is found; the handler treats null as `no-policy`
 * (fail closed: without an authoritative canon entry we cannot
 * authorize a resume).
 *
 * Mirrors the policy reader in
 * `src/runtime/planning-pipeline/policy.ts::readPipelineStageHilPolicy`
 * shape-wise but is a pure synchronous read over the injected atom
 * array (the runner uses a substrate host pagination; the Console
 * has the full index in memory per canon
 * `dec-console-atom-index-projection`).
 *
 * Substrate parity: the runner's `readPipelineStageHilPolicy` walks
 * superseded_by + taint='clean' the same way; we mirror that here so
 * a forbidden resume cannot land via stale canon.
 */
export function resolveAllowedResumers(
  atoms: ReadonlyArray<PipelineResumeSourceAtom>,
  stageName: string,
): ReadonlyArray<string> | null {
  for (const atom of atoms) {
    if (atom.type !== 'directive') continue;
    if (!isCleanLive(atom)) continue;
    const meta = (atom.metadata ?? {}) as Record<string, unknown>;
    const policy = meta['policy'];
    if (!policy || typeof policy !== 'object') continue;
    const policyObj = policy as Record<string, unknown>;
    if (policyObj['subject'] !== 'pipeline-stage-hil') continue;
    if (policyObj['stage_name'] !== stageName) continue;
    const raw = policyObj['allowed_resumers'];
    if (!Array.isArray(raw)) return [];
    return raw.filter((v): v is string => typeof v === 'string');
  }
  return null;
}

/**
 * Validate a resume request. The route handler calls this with the
 * full atom set + the request payload; the helper returns a tagged
 * union the handler maps to HTTP status codes.
 *
 * The ladder is intentional:
 *   1. Pipeline missing -> 404 (caller sent a stale id)
 *   2. Pipeline not paused -> 409 (already running, completed, etc)
 *   3. Paused but no resolving stage -> 409 (substrate invariant)
 *   4. No canon policy for the stage -> 403 (fail closed; cannot
 *      authorize without an authoritative canon entry)
 *   5. Caller not in allowed_resumers -> 403 (governance gate)
 *   6. Everything checks out -> 'ok' with the resolved stage + list
 *
 * Pure: no I/O. The handler injects the atoms + does the write.
 */
export function validateResumeRequest(
  atoms: ReadonlyArray<PipelineResumeSourceAtom>,
  params: {
    readonly pipelineId: string;
    readonly resumerPrincipalId: string;
  },
): ValidateResumeResult {
  const pipeline = pickPipelineAtom(atoms, params.pipelineId);
  if (pipeline === null) return { kind: 'not-found' };
  const pipelineState = pipeline.pipeline_state ?? null;
  if (pipelineState !== 'hil-paused') {
    return { kind: 'not-paused', pipelineState };
  }
  const stageName = resolvePausedStageName(atoms, params.pipelineId);
  if (stageName === null) return { kind: 'no-stage' };
  const allowedResumers = resolveAllowedResumers(atoms, stageName);
  if (allowedResumers === null) return { kind: 'no-policy', stageName };
  if (!allowedResumers.includes(params.resumerPrincipalId)) {
    return { kind: 'forbidden', stageName, allowedResumers };
  }
  return { kind: 'ok', stageName, allowedResumers };
}

/**
 * Build the deterministic atom id for the pipeline-resume atom.
 * Matches the substrate's `mkPipelineResumeAtom` helper in
 * `src/runtime/planning-pipeline/atom-shapes.ts` so a resume atom
 * written by the Console is shape-indistinguishable from one written
 * by an in-process runner. Two resumes against the same {pipelineId,
 * stageName, correlationId} collapse to one (idempotent put on disk).
 *
 * The correlationId is the Console-supplied request id so two
 * separate resume clicks on the same paused stage produce distinct
 * atoms (a real-world case: the operator clicks, the request fails
 * with a transient error, they click again -- both attempts deserve
 * audit-trail rows).
 */
export function buildResumeAtomId(input: {
  readonly pipelineId: string;
  readonly stageName: string;
  readonly correlationId: string;
}): string {
  return `pipeline-resume-${input.pipelineId}-${input.stageName}-${input.correlationId}`;
}
