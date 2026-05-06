/**
 * Generic atom service. The canonical AtomStore-projection read for
 * the atom-detail viewer route at `/atom/<id>`.
 *
 * canon.service.ts speaks `CanonAtom` (the L3-shaped subset). This
 * service speaks `AnyAtom`: the wider shape that covers every atom
 * type the substrate writes (plan, pipeline, pipeline-stage-event,
 * brainstorm-output, spec-output, review-report, dispatch-record,
 * actor-message, agent-session, agent-turn, operator-intent,
 * observation, pr-fix-observation, pipeline-audit-finding, ...).
 *
 * Per canon `arch-canonical-http-api-surface`, the UI never reads
 * `.lag/atoms/` directly; it calls `/api/atoms.get` which projects the
 * in-memory atomIndex (the canonical projection per
 * `arch-atomstore-source-of-truth`). The endpoint returns 404
 * `atom-not-found` when the id is unknown so the caller can show a
 * targeted empty state.
 */

import { transport } from './transport';
import type { CanonAtom } from './canon.service';

/**
 * Predicate: is `err` the canonical "atom-not-found" envelope error?
 *
 * The backend emits a 404 with envelope `{ ok: false, error: { code:
 * 'atom-not-found' } }`. The transport surfaces it as either
 * `Error.name = 'atom-not-found'` (current shape) OR a plain Error
 * whose `.message` starts with `'atom-not-found'` (legacy shape).
 *
 * Extracted at N=2 callers (getAtomById + getAuditChain) per canon
 * `dev-extract-at-n-equals-two` so a future shape change happens in
 * one place rather than drifting between the two services.
 */
export function isAtomNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'atom-not-found' || err.message.startsWith('atom-not-found');
}

/**
 * Generic atom shape: wider than `CanonAtom` because it carries the
 * full metadata bag for non-canon types. Every field on `CanonAtom`
 * is preserved (so renderers can reuse canon helpers like
 * `asAlternative`); the metadata bag is `Record<string, unknown>` so
 * type-specific renderers narrow it via runtime guards.
 */
export interface AnyAtom extends CanonAtom {
  readonly type: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /*
   * Plan atoms surface plan_state at the top level (per canon
   * `arch-plan-state-top-level-field`). Pipeline atoms similarly
   * surface pipeline_state at the top level. Both are optional on
   * the generic shape.
   */
  readonly plan_state?: string;
  readonly pipeline_state?: string;
  readonly schema_version?: number;
  readonly signals?: {
    readonly agrees_with?: ReadonlyArray<string>;
    readonly conflicts_with?: ReadonlyArray<string>;
    readonly validation_status?: string;
    readonly last_validated_at?: string | null;
  };
}

/**
 * Fetch a single atom by id. Returns `null` when the backend reports
 * `atom-not-found` (404) so the caller can render a targeted empty
 * state; rethrows any other transport error.
 */
export async function getAtomById(
  id: string,
  signal?: AbortSignal,
): Promise<AnyAtom | null> {
  try {
    return await transport.call<AnyAtom>(
      'atoms.get',
      { id },
      signal ? { signal } : undefined,
    );
  } catch (err) {
    if (isAtomNotFoundError(err)) return null;
    throw err;
  }
}

/**
 * Reverse refs - every atom (ANY type, not just canon) whose
 * provenance.derived_from, supersedes, superseded_by, or
 * metadata.source_plan points AT `id`. The substrate handler at
 * `/api/atoms.references` returns any-shape atoms; this is the
 * atom-wide projection the generic atom-detail viewer needs so plans,
 * pipeline outputs, intents, observations, and other non-canon
 * referencers all surface under "Referenced by".
 *
 * The L3-canon-narrowed sibling lives in `canon.service.ts` for
 * canon-only views (CanonViewer's reverse-link block); this version
 * is the wider type.
 */
export async function listReferencers(
  id: string,
  signal?: AbortSignal,
): Promise<ReadonlyArray<AnyAtom>> {
  return transport.call<ReadonlyArray<AnyAtom>>(
    'atoms.references',
    { id },
    signal ? { signal } : undefined,
  );
}

/**
 * Wire shape for the /api/atoms.audit-chain endpoint. Returns the
 * seed atom (at index 0) plus its transitive ancestors along
 * provenance.derived_from edges, depth-limited and cycle-safe.
 *
 * The shape mirrors the server contract in `audit-chain.ts`. It is
 * INTENTIONALLY wider than CanonAtom here -- the audit chain crosses
 * canon, plan, pipeline, agent-session, dispatch-record, and any
 * other substrate type, so we type the entries as AnyAtom.
 */
export interface AuditChainEdge {
  readonly from: string;
  readonly to: string;
}

export interface AuditChainResult {
  readonly atoms: ReadonlyArray<AnyAtom>;
  readonly edges: ReadonlyArray<AuditChainEdge>;
  readonly truncated: {
    readonly depth_reached: boolean;
    readonly missing_ancestors: number;
  };
}

/**
 * Fetch the audit-chain projection for `atomId`: the atom plus its
 * transitive ancestors along provenance.derived_from edges.
 *
 * Returns null when the backend reports atom-not-found (404) so the
 * caller can render a targeted empty state. Other transport errors
 * rethrow.
 *
 * `max_depth` defaults to 10 server-side per the audit-chain canon
 * shape; pass an explicit depth to override (clamped to [1, 25] on
 * the server).
 */
export async function getAuditChain(
  atomId: string,
  options?: { readonly max_depth?: number; readonly signal?: AbortSignal },
): Promise<AuditChainResult | null> {
  const payload: Record<string, unknown> = { atom_id: atomId };
  if (options?.max_depth !== undefined) payload['max_depth'] = options.max_depth;
  try {
    return await transport.call<AuditChainResult>(
      'atoms.audit-chain',
      payload,
      options?.signal ? { signal: options.signal } : undefined,
    );
  } catch (err) {
    if (isAtomNotFoundError(err)) return null;
    throw err;
  }
}
