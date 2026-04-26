/**
 * Deliberation service.
 *
 * The CTO actor's reasoning trail is already on the plan atom -- the
 * planning-actor schema (cto-actor skill) emits plan atoms with:
 *
 *   metadata.alternatives_rejected   ReadonlyArray<Alternative>
 *   metadata.principles_applied      ReadonlyArray<string>
 *   metadata.what_breaks_if_revisit  string
 *   provenance.derived_from          ReadonlyArray<string>  (citations)
 *
 * V1 derives the deliberation projection in-browser from `plans.list`.
 * No new endpoint is needed: the existing read-only API already
 * carries every field the deliberation view renders. If we later add
 * a distinct deliberation atom type (option-considered, branch-taken,
 * etc.), the substrate change lands first; this service then swaps
 * its source from a derived projection to a backend-stitched one,
 * leaving the component contract unchanged.
 *
 * Substrate purity: we do NOT introduce a new atom type or widen
 * `src/` schemas. The view is a pure projection over what the
 * planning-actor already writes today. See the cto-actor skill for
 * the schema producer.
 */

import { listPlans } from './plans.service';
import { asAlternative, type Alternative, type CanonAtom } from './canon.service';

/**
 * Hard cap on the number of cards rendered in the list. The atom
 * store is unbounded over time; rendering thousands of cards in a
 * single document blocks the main thread on a force-redraw.
 * Operators searching for a specific plan use the existing /plans
 * filter UX; the deliberation-trail list is a "last 200 by recency"
 * window and that's enough for trust-monitoring at org-ceiling
 * scale.
 */
export const DELIBERATION_LIST_CAP = 200;

export interface DeliberationCitation {
  readonly atom_id: string;
}

export interface DeliberationAlternative {
  readonly option: string;
  readonly reason?: string;
}

export interface DeliberationSummary {
  readonly plan_id: string;
  readonly title: string;
  readonly principal_id: string;
  readonly created_at: string;
  readonly plan_state: string | null;
  readonly alternatives_count: number;
  readonly citations_count: number;
  readonly principles_count: number;
}

export interface DeliberationDetail {
  readonly plan: {
    readonly id: string;
    readonly title: string;
    readonly content: string;
    readonly principal_id: string;
    readonly layer: string;
    readonly created_at: string;
    readonly plan_state: string | null;
    readonly confidence: number;
  };
  readonly alternatives: ReadonlyArray<DeliberationAlternative>;
  readonly principles_applied: ReadonlyArray<string>;
  readonly citations: ReadonlyArray<DeliberationCitation>;
  readonly what_breaks_if_revisit: string | null;
}

/*
 * Plan content begins with `# <title>` on the first non-empty line in
 * the cto-actor skill output. Pull it for the card label so the row
 * surfaces a human title instead of the slugged atom id.
 *
 * Returns null when the content has no leading heading; callers fall
 * back to the atom id.
 */
export function extractPlanTitle(content: string): string | null {
  const lines = content.split('\n');
  for (const line of lines) {
    const m = line.match(/^#{1,3}\s+(.+)$/);
    if (m && m[1]) return m[1].trim();
    if (line.trim().length > 0) return null;
  }
  return null;
}

interface PlanLikeMetadata {
  readonly alternatives_rejected?: ReadonlyArray<Alternative>;
  readonly principles_applied?: ReadonlyArray<string>;
  readonly what_breaks_if_revisit?: string;
  readonly what_breaks_if_revisited?: string;
  readonly title?: string;
  readonly [k: string]: unknown;
}

interface PlanLikeAtom extends CanonAtom {
  readonly plan_state?: string | null;
}

function readMeta(atom: PlanLikeAtom): PlanLikeMetadata {
  return (atom.metadata ?? {}) as PlanLikeMetadata;
}

function alternativesOf(atom: PlanLikeAtom): ReadonlyArray<DeliberationAlternative> {
  const raw = readMeta(atom).alternatives_rejected ?? [];
  return raw.map((entry) => {
    const norm = asAlternative(entry);
    if (norm.reason && norm.reason.length > 0) {
      return { option: norm.option, reason: norm.reason };
    }
    return { option: norm.option };
  });
}

function citationsOf(atom: PlanLikeAtom): ReadonlyArray<DeliberationCitation> {
  const raw = atom.provenance?.derived_from ?? [];
  // Dedupe while preserving order (the planning-actor sometimes lists
  // the same intent twice as both an entry and a tail-anchor).
  const seen = new Set<string>();
  const out: DeliberationCitation[] = [];
  for (const id of raw) {
    if (typeof id !== 'string' || id.length === 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ atom_id: id });
  }
  return out;
}

function principlesOf(atom: PlanLikeAtom): ReadonlyArray<string> {
  const raw = readMeta(atom).principles_applied ?? [];
  return raw.filter((s): s is string => typeof s === 'string' && s.length > 0);
}

function whatBreaksOf(atom: PlanLikeAtom): string | null {
  const meta = readMeta(atom);
  // Tolerate both spellings the substrate has produced over time.
  return meta.what_breaks_if_revisit ?? meta.what_breaks_if_revisited ?? null;
}

function titleOf(atom: PlanLikeAtom): string {
  const meta = readMeta(atom);
  if (typeof meta.title === 'string' && meta.title.length > 0) return meta.title;
  return extractPlanTitle(atom.content) ?? atom.id;
}

/**
 * List view: one summary per plan atom, sorted by recency,
 * capped to DELIBERATION_LIST_CAP.
 *
 * Plans without ANY deliberation signal (no alternatives, no
 * principles, no citations) are filtered out -- the trail view is
 * specifically for plans where reasoning was captured. Surfacing an
 * empty card teaches the operator the wrong thing about coverage.
 */
export async function listDeliberations(
  signal?: AbortSignal,
): Promise<ReadonlyArray<DeliberationSummary>> {
  const plans = (await listPlans(signal)) as ReadonlyArray<PlanLikeAtom>;
  const summaries: DeliberationSummary[] = [];
  for (const plan of plans) {
    const alternatives = alternativesOf(plan);
    const citations = citationsOf(plan);
    const principles = principlesOf(plan);
    if (alternatives.length === 0 && citations.length === 0 && principles.length === 0) continue;
    summaries.push({
      plan_id: plan.id,
      title: titleOf(plan),
      principal_id: plan.principal_id,
      created_at: plan.created_at,
      plan_state: plan.plan_state ?? null,
      alternatives_count: alternatives.length,
      citations_count: citations.length,
      principles_count: principles.length,
    });
  }
  summaries.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  return summaries.slice(0, DELIBERATION_LIST_CAP);
}

/**
 * Detail view: full deliberation projection for a single plan atom.
 * Returns null when no plan with that id is found in the store.
 */
export async function getDeliberation(
  planId: string,
  signal?: AbortSignal,
): Promise<DeliberationDetail | null> {
  const plans = (await listPlans(signal)) as ReadonlyArray<PlanLikeAtom>;
  const plan = plans.find((p) => p.id === planId);
  if (!plan) return null;
  return {
    plan: {
      id: plan.id,
      title: titleOf(plan),
      content: plan.content,
      principal_id: plan.principal_id,
      layer: plan.layer,
      created_at: plan.created_at,
      plan_state: plan.plan_state ?? null,
      confidence: plan.confidence,
    },
    alternatives: alternativesOf(plan),
    principles_applied: principlesOf(plan),
    citations: citationsOf(plan),
    what_breaks_if_revisit: whatBreaksOf(plan),
  };
}

// Test surface: the helpers below are pure functions over a single
// atom. We export them so the unit suite can drive them with fixture
// atoms without round-tripping through the transport layer.
export const _internal = {
  alternativesOf,
  citationsOf,
  principlesOf,
  whatBreaksOf,
  titleOf,
};
