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
    const e = err as Error;
    if (e.name === 'atom-not-found' || e.message.startsWith('atom-not-found')) {
      return null;
    }
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
