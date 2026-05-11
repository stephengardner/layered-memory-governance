/**
 * Pure helpers for the `/api/pipeline.abandon` handler.
 *
 * The Console UI surfaces an Abandon button on /pipelines/<id> for any
 * running or HIL-paused pipeline. When confirmed via a modal, the
 * backend route flips the pipeline atom's `pipeline_state` to
 * `abandoned` and writes a `pipeline-abandoned` audit atom carrying
 * the operator's reason. The pure helpers in this module do the
 * up-front validation (state check, reason validation, allowed_abandoners
 * gate) so the handler stays a thin disk-write wrapper and the unit
 * tests can exercise every rung without standing up the HTTP server.
 *
 * Runtime parity: server/index.ts imports from this module and uses
 * the same exported helpers for the route's load path, so the test
 * and the real handler agree by construction.
 *
 * Authority contract: the canon `pol-pipeline-abandon` directive's
 * `allowed_principals` list is the authoritative gate. Mirrors the
 * pipeline-stage-hil pattern at `pipeline-resume.ts::resolveAllowedResumers`:
 * a forbidden caller cannot land a write atom on disk even if they
 * reach the origin-allowed endpoint. Substrate-side runner re-walks
 * the abandon atom on its next tick and halts cleanly before
 * dispatching the next stage; the Console mirror is defense in depth,
 * not the only gate.
 *
 * Read-only by construction for the validation half: the helpers do
 * NOT read or write the filesystem; the route handler injects the
 * atoms it has in hand from the in-memory index per canon
 * `dec-console-atom-index-projection`.
 */

/**
 * Narrow atom shape the abandon helpers consume. Mirrors
 * `PipelineResumeSourceAtom` so the synthesizer stays decoupled from
 * the substrate's full Atom shape. Type-only: the caller injects the
 * atom array and the helpers walk it.
 *
 * The `layer` field is load-bearing for the canon-only authorization
 * gate (`resolveAllowedAbandoners` filters on `layer === 'L3'` so an
 * L0/L1 proposal cannot supply `allowed_principals` data that
 * satisfies the abandon gate). Without the field, a proposer with
 * write access to the atom store could mint a directive at L0 with
 * matching `metadata.policy.subject` and impersonate the canon entry.
 */
export interface PipelineAbandonSourceAtom {
  readonly id: string;
  readonly type: string;
  readonly layer?: string;
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
 * Bounds on the operator-supplied reason string. The reason is the
 * audit-trail entry that survives the pipeline atom going terminal; an
 * empty or trivial reason makes the audit record useless three months
 * later when an operator asks "why was this killed". An over-long
 * reason inflates atom storage and risks LLM-prompt-injection if the
 * field is ever re-read into a downstream stage.
 *
 * Min 10 chars: enough to force at least one short sentence (the
 * minimum word-count for a useful audit entry is roughly two).
 * Max 500 chars: a reasonable upper bound for a free-text justification
 * without bloating the atom file.
 */
export const REASON_MIN_LENGTH = 10;
export const REASON_MAX_LENGTH = 500;

/**
 * Tagged-union for the validation half. The handler maps each rung to
 * an HTTP status code:
 *   - kind='ok'             : write the abandon atom + flip pipeline_state
 *   - kind='not-found'      : 404, no pipeline atom with the requested id
 *   - kind='already-terminal': 409, pipeline is already abandoned / completed / failed
 *   - kind='no-policy'      : 403, no canon policy atom found
 *                            (fail closed; without canon we cannot authorize)
 *   - kind='forbidden'      : 403, caller not in allowed_principals
 *   - kind='reason-too-short': 400, reason fails the minimum-length floor
 *   - kind='reason-too-long' : 400, reason exceeds the maximum-length cap
 *   - kind='reason-missing'  : 400, reason absent or not a string
 */
export type ValidatePipelineAbandonResult =
  | { readonly kind: 'ok'; readonly allowedPrincipals: ReadonlyArray<string> }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'already-terminal'; readonly pipelineState: string }
  | { readonly kind: 'no-policy' }
  | { readonly kind: 'forbidden'; readonly allowedPrincipals: ReadonlyArray<string> }
  | { readonly kind: 'reason-missing' }
  | { readonly kind: 'reason-too-short'; readonly length: number; readonly min: number }
  | { readonly kind: 'reason-too-long'; readonly length: number; readonly max: number };

/**
 * Live-atom filter. Same shape as
 * `pipeline-resume.ts::isCleanLive`. A tainted or superseded atom must
 * never authorize a state flip.
 */
function isCleanLive(atom: PipelineAbandonSourceAtom): boolean {
  if (atom.taint && atom.taint !== 'clean') return false;
  if (atom.superseded_by && atom.superseded_by.length > 0) return false;
  return true;
}

/**
 * The set of pipeline_state values that mean "already terminal" and
 * therefore cannot be abandoned. The substrate runner emits these
 * states on completion (success path), failure path, or a prior
 * abandon. Abandoning a pipeline already in one of these states is a
 * no-op at best and a misleading audit entry at worst.
 *
 * Note `pending` is NOT terminal: a pipeline that has not yet started
 * executing CAN be abandoned (the operator decides early that the
 * direction is wrong). Mirrors substrate state machine in
 * src/runtime/planning-pipeline/runner.ts.
 */
const TERMINAL_PIPELINE_STATES = new Set<string>([
  'abandoned',
  'completed',
  'failed',
]);

/**
 * Validate the reason field. Returns `null` on success or a tagged
 * verdict for the rung that failed. Extracted so the route handler can
 * call it before doing any atom-store work.
 *
 * Trimming: leading/trailing whitespace does not count toward the
 * length floor (a "          " reason is 10 chars of nothing).
 */
export function validateReason(
  reason: unknown,
):
  | { readonly kind: 'ok'; readonly trimmed: string }
  | { readonly kind: 'reason-missing' }
  | { readonly kind: 'reason-too-short'; readonly length: number; readonly min: number }
  | { readonly kind: 'reason-too-long'; readonly length: number; readonly max: number } {
  if (typeof reason !== 'string') {
    return { kind: 'reason-missing' };
  }
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    return { kind: 'reason-missing' };
  }
  if (trimmed.length < REASON_MIN_LENGTH) {
    return { kind: 'reason-too-short', length: trimmed.length, min: REASON_MIN_LENGTH };
  }
  if (trimmed.length > REASON_MAX_LENGTH) {
    return { kind: 'reason-too-long', length: trimmed.length, max: REASON_MAX_LENGTH };
  }
  return { kind: 'ok', trimmed };
}

/**
 * Find the pipeline atom by id. The handler uses this to verify the
 * pipeline exists AND to read its current `pipeline_state` for the
 * terminal-check rung.
 */
export function pickPipelineAtom(
  atoms: ReadonlyArray<PipelineAbandonSourceAtom>,
  pipelineId: string,
): PipelineAbandonSourceAtom | null {
  for (const atom of atoms) {
    if (atom.type !== 'pipeline') continue;
    if (atom.id !== pipelineId) continue;
    if (!isCleanLive(atom)) continue;
    return atom;
  }
  return null;
}

/**
 * Resolve the canon `pol-pipeline-abandon` policy atom's
 * `allowed_principals` list. Walks every L3 directive atom looking for
 * one whose `metadata.policy.subject === 'pipeline-abandon'`. Returns
 * null when no matching atom is found; the handler treats null as
 * `no-policy` (fail closed: without an authoritative canon entry we
 * cannot authorize an abandon).
 *
 * Mirrors `pipeline-resume.ts::resolveAllowedResumers` shape-wise. The
 * substrate's runner re-walks the same canon directive on its next
 * tick so a forbidden abandon cannot pass via stale canon.
 *
 * Substrate parity: walks `superseded_by` + `taint='clean'` the same
 * way; respects the L3-layer floor so an L0 proposal cannot satisfy
 * the gate.
 */
export function resolveAllowedAbandoners(
  atoms: ReadonlyArray<PipelineAbandonSourceAtom>,
): ReadonlyArray<string> | null {
  let chosen: ReadonlyArray<string> | null = null;
  for (const atom of atoms) {
    if (atom.type !== 'directive') continue;
    /*
     * Layer floor: only L3 (canon) atoms can satisfy the abandon gate.
     * An L0 proposal or L1 working-set atom with a matching
     * `metadata.policy.subject === 'pipeline-abandon'` MUST be ignored
     * regardless of how convincing the shape looks. Without this floor,
     * any principal with write access to the atom store could mint a
     * directive at L0 that adds itself to `allowed_principals` and
     * bypass canon governance entirely. Mirrors the layer-floor
     * regression test in pipeline-resume.test.ts (CR PR #396 critical
     * finding).
     */
    if (atom.layer !== 'L3') continue;
    if (!isCleanLive(atom)) continue;
    const meta = (atom.metadata ?? {}) as Record<string, unknown>;
    const policy = meta['policy'];
    if (!policy || typeof policy !== 'object') continue;
    const policyObj = policy as Record<string, unknown>;
    if (policyObj['subject'] !== 'pipeline-abandon') continue;
    const raw = policyObj['allowed_principals'];
    if (!Array.isArray(raw)) {
      chosen = [];
      continue;
    }
    chosen = raw.filter((v): v is string => typeof v === 'string');
  }
  return chosen;
}

/**
 * Validate an abandon request. The route handler calls this with the
 * full atom set + the validated request payload; the helper returns a
 * tagged union the handler maps to HTTP status codes.
 *
 * The ladder is intentional:
 *   1. Reason validation runs first via validateReason (cheap check,
 *      fails the loud user-input rung early)
 *   2. Pipeline missing -> 404 (caller sent a stale id)
 *   3. Pipeline already terminal -> 409 (already abandoned/done/failed)
 *   4. No canon policy -> 403 (fail closed; cannot authorize without canon)
 *   5. Caller not in allowed_principals -> 403 (governance gate)
 *   6. Everything checks out -> 'ok' with the allowlist for the audit row
 *
 * Pure: no I/O. The handler injects the atoms + does the write.
 */
export function validatePipelineAbandonInput(
  atoms: ReadonlyArray<PipelineAbandonSourceAtom>,
  params: {
    readonly pipelineId: string;
    readonly abandonerPrincipalId: string;
    readonly reason: unknown;
  },
): ValidatePipelineAbandonResult {
  const reasonVerdict = validateReason(params.reason);
  if (reasonVerdict.kind !== 'ok') {
    return reasonVerdict;
  }
  const pipeline = pickPipelineAtom(atoms, params.pipelineId);
  if (pipeline === null) return { kind: 'not-found' };
  const pipelineState = pipeline.pipeline_state ?? null;
  if (pipelineState !== null && TERMINAL_PIPELINE_STATES.has(pipelineState)) {
    return { kind: 'already-terminal', pipelineState };
  }
  const allowedPrincipals = resolveAllowedAbandoners(atoms);
  if (allowedPrincipals === null) return { kind: 'no-policy' };
  if (!allowedPrincipals.includes(params.abandonerPrincipalId)) {
    return { kind: 'forbidden', allowedPrincipals };
  }
  return { kind: 'ok', allowedPrincipals };
}

/**
 * Build the deterministic atom id for the pipeline-abandoned atom.
 * Mirrors the substrate's atom-id pattern. Two abandons against the
 * same {pipelineId, correlationId} collapse to one (idempotent put on
 * disk via the `wx` flag in the handler).
 *
 * The correlationId is the per-request nonce so two separate clicks
 * (real-world: operator clicks, transient error, operator clicks
 * again) produce distinct audit atoms.
 */
export function buildAbandonAtomId(input: {
  readonly pipelineId: string;
  readonly correlationId: string;
}): string {
  return `pipeline-abandoned-${input.pipelineId}-${input.correlationId}`;
}

/**
 * Shape of the pipeline-abandoned audit atom written on disk. Returned
 * from the build helper so the route handler walks a single,
 * type-checked record into JSON.stringify rather than spreading the
 * shape across the codebase.
 *
 * The atom is L0 because the abandon is a per-event observation; canon
 * (L3) governs WHO may sign one, not the event itself.
 */
export interface PipelineAbandonedAtom {
  readonly schema_version: 1;
  readonly id: string;
  readonly type: 'pipeline-abandoned';
  readonly layer: 'L0';
  readonly content: string;
  readonly principal_id: string;
  readonly confidence: number;
  readonly created_at: string;
  readonly last_reinforced_at: string;
  readonly expires_at: null;
  readonly supersedes: ReadonlyArray<string>;
  readonly superseded_by: ReadonlyArray<string>;
  readonly scope: string;
  readonly signals: {
    readonly agrees_with: ReadonlyArray<string>;
    readonly conflicts_with: ReadonlyArray<string>;
    readonly validation_status: 'unchecked';
    readonly last_validated_at: null;
  };
  readonly taint: 'clean';
  readonly provenance: {
    readonly kind: 'user-directive';
    readonly source: {
      readonly tool: string;
      readonly agent_id: string;
      readonly session_id: string;
    };
    readonly derived_from: ReadonlyArray<string>;
  };
  readonly metadata: {
    readonly pipeline_id: string;
    readonly reason: string;
    readonly abandoned_at: string;
    readonly abandoner_principal_id: string;
  };
}

/**
 * Build the abandon audit atom record. Pure: takes the validated input
 * + a `now` stamp and returns the on-disk shape. The handler picks the
 * atom up and writes it to disk; the file-watcher updates the in-memory
 * index on the next event tick per canon `dec-console-atom-index-projection`.
 *
 * Test seam: the helper is exported so the unit tests can assert the
 * exact shape without standing up the HTTP server. The shape mirrors
 * the substrate's pipeline-resume atom (PipelineResumeAtom shape + a
 * `reason` field) so a future audit walker that observes both kinds
 * does not branch on origin.
 *
 * `derived_from` carries the pipeline atom id at minimum; an
 * implementation can extend the array with intermediate provenance
 * (stage events, seed intent) but the pipeline id is the load-bearing
 * link that ties the abandon back to its target.
 */
export function buildPipelineAbandonedAtom(input: {
  readonly pipelineId: string;
  readonly abandonerPrincipalId: string;
  readonly reason: string;
  readonly correlationId: string;
  readonly now: string;
}): PipelineAbandonedAtom {
  const id = buildAbandonAtomId({
    pipelineId: input.pipelineId,
    correlationId: input.correlationId,
  });
  return {
    schema_version: 1,
    id,
    type: 'pipeline-abandoned',
    layer: 'L0',
    content: `abandoned:${input.pipelineId}`,
    principal_id: input.abandonerPrincipalId,
    confidence: 1.0,
    created_at: input.now,
    last_reinforced_at: input.now,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    taint: 'clean',
    provenance: {
      /*
       * `user-directive` is the canonical ProvenanceKind for an
       * operator-initiated write through a live UI session per
       * substrate/types.ts. The operator clicked Abandon; the atom
       * carries that intent through the audit trail. tool + agent_id +
       * session_id together identify the surface and the specific
       * click instance so a future audit walker can reconstruct the
       * (UI -> backend -> atom-store) chain.
       */
      kind: 'user-directive',
      source: {
        tool: 'lag-console-pipeline-abandon',
        agent_id: input.abandonerPrincipalId,
        session_id: input.correlationId,
      },
      derived_from: [input.pipelineId],
    },
    metadata: {
      pipeline_id: input.pipelineId,
      reason: input.reason,
      abandoned_at: input.now,
      abandoner_principal_id: input.abandonerPrincipalId,
    },
  };
}
