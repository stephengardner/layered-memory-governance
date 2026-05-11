/**
 * Server-side helpers for /api/intents.file -- the Console replacement
 * for `node scripts/intend.mjs`.
 *
 * The flow:
 *   1. validateFileIntentInput: pure, takes the raw POST body, returns
 *      a `{ ok, args }` result. Rejects malformed or unknown enums up
 *      front so the route layer maps each rejection to a typed 400.
 *   2. buildOperatorIntentAtom: pure, produces the operator-intent atom
 *      in the same shape `scripts/lib/intend.mjs#buildIntentAtom`
 *      writes. The trust_envelope + provenance + scope match byte-for-byte
 *      so the autonomous-intent approval tick treats Console-filed and
 *      CLI-filed intents identically (canon
 *      `dec-canon-as-projection-of-substrate`).
 *   3. isPrincipalAllowedToFileIntent: pure, walks the canon snapshot
 *      and returns true when the proposer principal_id is whitelisted
 *      under `pol-operator-intent-creation.allowed_principal_ids`. The
 *      gate mirrors the runtime tick at
 *      `src/runtime/actor-message/intent-approve.ts#readIntentCreationPolicy`
 *      so a non-whitelisted intent never reaches the approval path.
 *
 * The route layer (server/index.ts) glues these together:
 *   - reads body  -> validateFileIntentInput
 *   - reads canon -> isPrincipalAllowedToFileIntent
 *   - writes atom -> buildOperatorIntentAtom + fs.writeFile
 *   - optional --trigger semantics: spawn dist/.../scripts/run-cto-actor
 *     under the same envelope `intend.mjs --trigger` uses.
 *
 * Every helper is pure (no I/O, no globals, no time) so the suite at
 * `file-intent.test.ts` can pin every branch without standing up the
 * HTTP server. Mirrors the helper-extraction pattern already in
 * `intent-outcome.ts`, `pipeline-lifecycle.ts`, `security.ts`.
 */

// ---------------------------------------------------------------------------
// Enums + safety caps (single source of truth for the wire shape).
//
// Cross-checked against `scripts/lib/intend.mjs` so the CLI and the
// Console accept the same set of scope / blast-radius / sub-actor
// values. Drifting either side without a paired update here is a
// substrate violation (canon `dec-canon-as-projection-of-substrate`).
// ---------------------------------------------------------------------------

export const SCOPE_VALUES = ['tooling', 'docs', 'framework', 'canon'] as const;
export const BLAST_RADIUS_VALUES = ['none', 'docs', 'tooling', 'framework', 'l3-canon-proposal'] as const;
export const SUB_ACTOR_VALUES = ['code-author', 'auditor-actor'] as const;

export type Scope = (typeof SCOPE_VALUES)[number];
export type BlastRadius = (typeof BLAST_RADIUS_VALUES)[number];
export type SubActor = (typeof SUB_ACTOR_VALUES)[number];

const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;
// Same upper bound the CLI enforces, lifted from
// `scripts/lib/intend.mjs#MAX_EXPIRES_HOURS`. 72 hours is the standing
// operator-intent expiry ceiling per the autonomous-intent substrate
// design (intents older than this are stale relative to in-flight code
// churn); a Console-side request asking for more should be rejected at
// the boundary, not silently clamped.
export const MAX_EXPIRES_HOURS = 72;

// ---------------------------------------------------------------------------
// Validated args shape.
// ---------------------------------------------------------------------------

export interface FileIntentArgs {
  readonly request: string;
  readonly scope: Scope;
  readonly blastRadius: BlastRadius;
  readonly subActors: ReadonlyArray<SubActor>;
  readonly minConfidence: number;
  readonly expiresIn: string;
  readonly trigger: boolean;
}

export type FileIntentValidationResult =
  | { readonly ok: true; readonly args: FileIntentArgs }
  | { readonly ok: false; readonly field: string; readonly reason: string };

// ---------------------------------------------------------------------------
// Pure validators.
// ---------------------------------------------------------------------------

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isStringArray(v: unknown): v is ReadonlyArray<string> {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Validate a raw body for /api/intents.file. Returns a discriminated
 * union so the route layer can map an invalid `field` directly to a
 * `400 missing-<field>` / `400 invalid-<field>` response without
 * hand-rolling a second translation layer.
 *
 * Pre-fix the route copied the CLI's positional parsing which is wrong
 * for an HTTP boundary -- a missing string field is a 400, not a 500.
 */
export function validateFileIntentInput(body: unknown): FileIntentValidationResult {
  if (body === null || typeof body !== 'object') {
    return { ok: false, field: 'body', reason: 'request body must be a JSON object' };
  }
  const obj = body as Record<string, unknown>;
  const request = obj['request'];
  if (!isString(request) || request.trim().length === 0) {
    return { ok: false, field: 'request', reason: 'request is required and must be a non-empty string' };
  }
  const scope = obj['scope'];
  if (!isString(scope) || !(SCOPE_VALUES as ReadonlyArray<string>).includes(scope)) {
    return { ok: false, field: 'scope', reason: `scope must be one of ${SCOPE_VALUES.join(', ')}` };
  }
  const blastRadius = obj['blast_radius'];
  if (!isString(blastRadius) || !(BLAST_RADIUS_VALUES as ReadonlyArray<string>).includes(blastRadius)) {
    return { ok: false, field: 'blast_radius', reason: `blast_radius must be one of ${BLAST_RADIUS_VALUES.join(', ')}` };
  }
  const subActorsRaw = obj['sub_actors'];
  if (!isStringArray(subActorsRaw) || subActorsRaw.length === 0) {
    return { ok: false, field: 'sub_actors', reason: 'sub_actors is required and must be a non-empty array of strings' };
  }
  for (const sa of subActorsRaw) {
    if (!(SUB_ACTOR_VALUES as ReadonlyArray<string>).includes(sa)) {
      return { ok: false, field: 'sub_actors', reason: `sub_actors entry ${JSON.stringify(sa)} is not in the v1 allowlist (${SUB_ACTOR_VALUES.join(', ')})` };
    }
  }
  const minConfidenceRaw = obj['min_confidence'];
  const minConfidence = minConfidenceRaw === undefined ? 0.75 : minConfidenceRaw;
  if (typeof minConfidence !== 'number' || !Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
    return { ok: false, field: 'min_confidence', reason: 'min_confidence must be a finite number in [0, 1]' };
  }
  const expiresIn = obj['expires_in'];
  if (expiresIn !== undefined && (!isString(expiresIn) || !/^(\d+)([hm])$/.test(expiresIn))) {
    return { ok: false, field: 'expires_in', reason: 'expires_in must match the pattern Nh or Nm (e.g. 24h, 90m)' };
  }
  // Safety cap: even though the regex above bounds the form, total ms
  // can still exceed MAX_EXPIRES_HOURS for large N. Compute against a
  // fixed reference clock so the check is deterministic.
  if (isString(expiresIn)) {
    const m = /^(\d+)([hm])$/.exec(expiresIn);
    if (m) {
      const n = Number(m[1]);
      const unit = m[2];
      const totalMs = unit === 'h' ? n * HOUR_MS : n * MIN_MS;
      if (totalMs > MAX_EXPIRES_HOURS * HOUR_MS) {
        return { ok: false, field: 'expires_in', reason: `expires_in exceeds safety cap of ${MAX_EXPIRES_HOURS}h` };
      }
    }
  }
  const triggerRaw = obj['trigger'];
  const trigger = triggerRaw === undefined ? false : triggerRaw;
  if (typeof trigger !== 'boolean') {
    return { ok: false, field: 'trigger', reason: 'trigger must be a boolean when present' };
  }
  return {
    ok: true,
    args: {
      request: request.trim(),
      scope: scope as Scope,
      blastRadius: blastRadius as BlastRadius,
      subActors: subActorsRaw as ReadonlyArray<SubActor>,
      minConfidence,
      expiresIn: isString(expiresIn) ? expiresIn : '24h',
      trigger,
    },
  };
}

/**
 * Compute the ISO timestamp for atom.metadata.expires_at given the
 * validated expires_in token and a reference clock. Pulled out of the
 * atom builder so the test suite can pin both halves (parse-and-cap +
 * absolute-time computation) without time-mocking the global Date.
 */
export function computeExpiresAt(expiresIn: string, now: Date): string {
  const m = /^(\d+)([hm])$/.exec(expiresIn);
  if (!m) {
    throw new Error(`computeExpiresAt: invalid expiresIn ${JSON.stringify(expiresIn)} (expected Nh or Nm)`);
  }
  const n = Number(m[1]);
  const unit = m[2];
  const totalMs = unit === 'h' ? n * HOUR_MS : n * MIN_MS;
  if (totalMs > MAX_EXPIRES_HOURS * HOUR_MS) {
    throw new Error(`computeExpiresAt: ${expiresIn} exceeds safety cap of ${MAX_EXPIRES_HOURS}h`);
  }
  return new Date(now.getTime() + totalMs).toISOString();
}

// ---------------------------------------------------------------------------
// Canon allowlist check.
// ---------------------------------------------------------------------------

interface MinAtom {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly layer?: unknown;
  readonly taint?: unknown;
  readonly superseded_by?: unknown;
  readonly metadata?: unknown;
}

/**
 * Walk a canon snapshot and return true when `principalId` is in the
 * pol-operator-intent-creation allowlist.
 *
 * Mirrors the runtime tick at
 * `src/runtime/actor-message/intent-approve.ts#readIntentCreationPolicy`:
 *   - type === 'directive', layer === 'L3'
 *   - taint === 'clean' (omitted is treated as clean)
 *   - superseded_by empty / missing
 *   - metadata.policy.subject === 'operator-intent-creation'
 *   - metadata.policy.allowed_principal_ids includes principalId
 *
 * Fail-closed: an absent policy atom (canon not seeded yet, or removed
 * deliberately to disable the Console intent path) returns false. The
 * Console route maps that to 403 `principal-not-allowed`.
 *
 * The check accepts an array of atoms rather than a query callback so
 * the unit test can drive every branch without standing up the file
 * host; the route layer feeds it `readAllAtoms()`.
 */
export function isPrincipalAllowedToFileIntent(
  atoms: ReadonlyArray<MinAtom>,
  principalId: string,
): boolean {
  for (const atom of atoms) {
    if (atom.type !== 'directive') continue;
    if (atom.layer !== 'L3') continue;
    if (atom.taint !== undefined && atom.taint !== 'clean') continue;
    const supersededBy = atom.superseded_by;
    if (Array.isArray(supersededBy) && supersededBy.length > 0) continue;
    const meta = atom.metadata;
    if (meta === null || typeof meta !== 'object') continue;
    const policy = (meta as Record<string, unknown>)['policy'];
    if (policy === null || typeof policy !== 'object') continue;
    const p = policy as Record<string, unknown>;
    if (p['subject'] !== 'operator-intent-creation') continue;
    const allowed = p['allowed_principal_ids'];
    if (!Array.isArray(allowed)) continue;
    if (allowed.includes(principalId)) return true;
    // Only one operator-intent-creation policy can win at L3; if we
    // matched the subject but the principal is absent, surface deny
    // without scanning further atoms (cheaper + clearer semantics).
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Atom builder.
// ---------------------------------------------------------------------------

/**
 * Operator-intent atom shape that matches
 * `scripts/lib/intend.mjs#buildIntentAtom` field-for-field. Drift
 * between CLI and Console atom shapes is what breaks intent-approve
 * (its readers assume specific keys); pinning the shape in code and
 * asserting it in the unit test keeps the two paths interchangeable.
 */
export interface OperatorIntentAtom {
  readonly schema_version: 1;
  readonly id: string;
  readonly type: 'operator-intent';
  readonly layer: 'L1';
  readonly principal_id: string;
  readonly provenance: {
    readonly kind: 'operator-seeded';
    readonly source: { readonly tool: 'lag-console-file-intent' };
    readonly derived_from: ReadonlyArray<string>;
  };
  readonly confidence: 1;
  readonly scope: Scope;
  readonly content: string;
  readonly metadata: {
    readonly kind: 'autonomous-solve';
    readonly request: string;
    readonly trust_envelope: {
      readonly max_blast_radius: BlastRadius;
      readonly max_plans: 5;
      readonly min_plan_confidence: number;
      readonly allowed_sub_actors: ReadonlyArray<SubActor>;
      readonly require_ci_green: true;
      readonly require_cr_approve: true;
      readonly require_auditor_observation: true;
    };
    readonly expires_at: string;
    readonly consumed_by_plans: ReadonlyArray<string>;
    readonly consumed_by_questions: ReadonlyArray<string>;
  };
  readonly created_at: string;
  readonly last_reinforced_at: string;
  readonly expires_at: string | null;
  readonly supersedes: ReadonlyArray<string>;
  readonly superseded_by: ReadonlyArray<string>;
  readonly taint: 'clean';
  readonly signals: {
    readonly agrees_with: ReadonlyArray<string>;
    readonly conflicts_with: ReadonlyArray<string>;
    readonly validation_status: 'unchecked';
    readonly last_validated_at: null;
  };
}

export interface BuildOperatorIntentAtomSpec {
  readonly args: FileIntentArgs;
  readonly operatorPrincipalId: string;
  readonly now: Date;
  readonly nonce: string;
}

/**
 * Build the operator-intent atom that lands in `.lag/atoms/<id>.json`.
 * Identical shape to `scripts/lib/intend.mjs#buildIntentAtom` modulo
 * provenance.source.tool (`lag-console-file-intent` vs `intend-cli`) so
 * a post-hoc audit can tell which surface authored the intent without
 * conflating the two flows.
 */
export function buildOperatorIntentAtom(spec: BuildOperatorIntentAtomSpec): OperatorIntentAtom {
  if (typeof spec.operatorPrincipalId !== 'string' || spec.operatorPrincipalId.length === 0) {
    throw new Error('buildOperatorIntentAtom: operatorPrincipalId is required');
  }
  if (typeof spec.nonce !== 'string' || spec.nonce.length === 0) {
    throw new Error('buildOperatorIntentAtom: nonce is required');
  }
  const createdAt = spec.now.toISOString();
  const expiresAt = computeExpiresAt(spec.args.expiresIn, spec.now);
  const id = `intent-${spec.nonce}-${createdAt.replace(/[:.]/g, '-')}`;
  return {
    schema_version: 1,
    id,
    type: 'operator-intent',
    layer: 'L1',
    principal_id: spec.operatorPrincipalId,
    provenance: {
      kind: 'operator-seeded',
      source: { tool: 'lag-console-file-intent' },
      derived_from: [],
    },
    confidence: 1,
    scope: spec.args.scope,
    content: spec.args.request,
    metadata: {
      kind: 'autonomous-solve',
      request: spec.args.request,
      trust_envelope: {
        max_blast_radius: spec.args.blastRadius,
        max_plans: 5,
        min_plan_confidence: spec.args.minConfidence,
        allowed_sub_actors: spec.args.subActors,
        require_ci_green: true,
        require_cr_approve: true,
        require_auditor_observation: true,
      },
      expires_at: expiresAt,
      consumed_by_plans: [],
      consumed_by_questions: [],
    },
    created_at: createdAt,
    last_reinforced_at: createdAt,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    taint: 'clean',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
  };
}
