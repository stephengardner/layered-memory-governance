/**
 * Canon service: reads L3 atoms (directives, decisions, preferences,
 * references) from the backend. Backend reads actual `.lag/atoms/`
 * JSON files.
 *
 * Components call `useQuery` hooks that call this service; they do
 * NOT call transport directly, and they do NOT fetch directly.
 */

import { transport } from './transport';

export type AtomLayer = 'L0' | 'L1' | 'L2' | 'L3';
export type AtomType =
  | 'directive'
  | 'decision'
  | 'preference'
  | 'reference'
  | 'observation'
  | 'actor-message'
  | 'plan'
  | 'question'
  | (string & {});

/*
 * Alternatives_rejected in real canon atoms shows up in two shapes:
 *   - ReadonlyArray<string>           — seed atoms, /decide short-form
 *   - ReadonlyArray<{option,reason}>  — newer structured entries
 * The frontend accepts both; renderers normalize via `asAlternative()`.
 */
export type Alternative = string | { readonly option: string; readonly reason: string };

export interface CanonAtom {
  readonly id: string;
  readonly type: AtomType;
  readonly layer: AtomLayer;
  readonly content: string;
  readonly principal_id: string;
  readonly confidence: number;
  readonly created_at: string;
  readonly scope?: string;
  readonly taint?: string;
  readonly superseded_by?: ReadonlyArray<string>;
  readonly supersedes?: ReadonlyArray<string>;
  readonly expires_at?: string | null;
  readonly last_reinforced_at?: string;
  readonly metadata?: {
    readonly alternatives_rejected?: ReadonlyArray<Alternative>;
    readonly what_breaks_if_revisited?: string;
    readonly source_plan?: string;
    readonly [k: string]: unknown;
  };
  readonly provenance?: {
    readonly kind?: string;
    readonly source?: unknown;
    readonly derived_from?: ReadonlyArray<string>;
  };
}

export function asAlternative(raw: Alternative): { option: string; reason?: string } {
  if (typeof raw === 'string') return { option: raw };
  return { option: raw.option, reason: raw.reason };
}

export interface ListCanonParams {
  readonly types?: ReadonlyArray<AtomType>;
  readonly search?: string;
}

export interface CanonStats {
  readonly total: number;
  readonly byType: Readonly<Record<string, number>>;
}

export async function listCanonAtoms(
  params?: ListCanonParams,
  signal?: AbortSignal,
): Promise<ReadonlyArray<CanonAtom>> {
  const call = transport.call<ReadonlyArray<CanonAtom>>(
    'canon.list',
    params as Record<string, unknown> | undefined,
    signal ? { signal } : undefined,
  );
  return call;
}

export async function getCanonStats(signal?: AbortSignal): Promise<CanonStats> {
  const call = transport.call<CanonStats>(
    'canon.stats',
    undefined,
    signal ? { signal } : undefined,
  );
  return call;
}

/**
 * Reverse refs — every atom that points AT `id` via derived_from,
 * supersedes, superseded_by, or metadata.source_plan. Render under
 * "Referenced by" on any atom's detail view to make the graph
 * bidirectional.
 */
export async function listReferencers(
  id: string,
  signal?: AbortSignal,
): Promise<ReadonlyArray<CanonAtom>> {
  return transport.call<ReadonlyArray<CanonAtom>>(
    'atoms.references',
    { id },
    signal ? { signal } : undefined,
  );
}

/**
 * Provenance chain — the transitive derived_from ancestors of `id`,
 * depth-limited. Used by the "Why this atom exists" trace.
 */
export async function listAtomChain(
  id: string,
  depth = 5,
  signal?: AbortSignal,
): Promise<ReadonlyArray<CanonAtom>> {
  return transport.call<ReadonlyArray<CanonAtom>>(
    'atoms.chain',
    { id, depth },
    signal ? { signal } : undefined,
  );
}

/**
 * Taint cascade — transitive set of atoms that would inherit taint if
 * `id` were compromised. Walks reverse direction of derived_from.
 */
export async function listAtomCascade(
  id: string,
  depth = 5,
  signal?: AbortSignal,
): Promise<ReadonlyArray<CanonAtom>> {
  return transport.call<ReadonlyArray<CanonAtom>>(
    'atoms.cascade',
    { id, depth },
    signal ? { signal } : undefined,
  );
}

export interface ArbitrationResult {
  readonly a: { readonly atom: CanonAtom | null; readonly rank: number; readonly breakdown: Record<string, number> };
  readonly b: { readonly atom: CanonAtom | null; readonly rank: number; readonly breakdown: Record<string, number> };
  readonly winner: 'a' | 'b' | 'tie';
}

export interface CanonDrift {
  readonly stale: ReadonlyArray<CanonAtom>;
  readonly expiring: ReadonlyArray<CanonAtom>;
  readonly lowConfidence: ReadonlyArray<CanonAtom>;
}

export async function getCanonDrift(signal?: AbortSignal): Promise<CanonDrift> {
  return transport.call<CanonDrift>(
    'canon.drift',
    undefined,
    signal ? { signal } : undefined,
  );
}

export interface ApplicableAtom extends CanonAtom {
  readonly _rank: number;
}

/**
 * Agent-consumable: given a principal + layer + scope, return the
 * canon that governs that position, ranked by source-rank. This is
 * the endpoint agents should use instead of reading .lag/atoms
 * directly. Contract stays stable across Tauri + browser runtimes.
 */
export async function listCanonApplicable(
  params: {
    principal_id: string;
    layer: 'L0' | 'L1' | 'L2' | 'L3';
    scope?: string;
    atomTypes?: ReadonlyArray<string>;
  },
  signal?: AbortSignal,
): Promise<ReadonlyArray<ApplicableAtom>> {
  return transport.call<ReadonlyArray<ApplicableAtom>>(
    'canon.applicable',
    params as unknown as Record<string, unknown>,
    signal ? { signal } : undefined,
  );
}

/**
 * Propose a new atom. Writes to .lag/atoms/ at L0 with
 * validation_status: pending_review. L3 promotion still requires
 * the existing human-approval flow; this is intake, not
 * auto-canonization.
 */
export async function proposeAtom(
  params: {
    content: string;
    type: AtomType;
    confidence: number;
    proposer_id: string;
    scope?: string;
  },
  signal?: AbortSignal,
): Promise<{ id: string; path: string }> {
  return transport.call<{ id: string; path: string }>(
    'atoms.propose',
    params as unknown as Record<string, unknown>,
    signal ? { signal } : undefined,
  );
}

/**
 * Operator maintenance: reinforce an atom ("yes, this still
 * applies"). Updates last_reinforced_at to now. Does NOT change
 * content, provenance, or confidence.
 */
export async function reinforceAtom(
  params: { id: string; actor_id: string },
  signal?: AbortSignal,
): Promise<{ id: string; last_reinforced_at: string }> {
  return transport.call<{ id: string; last_reinforced_at: string }>(
    'atoms.reinforce',
    params as unknown as Record<string, unknown>,
    signal ? { signal } : undefined,
  );
}

/**
 * Operator maintenance: mark an atom stale. Sets expires_at to now
 * and records the marker's id + optional reason in metadata. The
 * atom stays in canon — this is a FLAG, not a removal. Retirement
 * proper goes through supersession.
 */
export async function markAtomStale(
  params: { id: string; actor_id: string; reason?: string },
  signal?: AbortSignal,
): Promise<{ id: string; expires_at: string }> {
  return transport.call<{ id: string; expires_at: string }>(
    'atoms.mark-stale',
    params as unknown as Record<string, unknown>,
    signal ? { signal } : undefined,
  );
}

export async function compareArbitration(
  aId: string,
  bId: string,
  signal?: AbortSignal,
): Promise<ArbitrationResult> {
  return transport.call<ArbitrationResult>(
    'arbitration.compare',
    { a: aId, b: bId },
    signal ? { signal } : undefined,
  );
}
