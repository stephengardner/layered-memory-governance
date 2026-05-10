/*
 * Reaped-atoms toggle state for the activities feed.
 *
 * The pipeline reaper (PR #377) marks stale pipeline / pipeline-stage
 * / agent-session / agent-turn atoms with `metadata.reaped_at`. The
 * Console projection layer (`apps/console/server/reaped-filter.ts`)
 * hides those atoms from the activities feed by default; this module
 * holds the opt-in toggle state on the client.
 *
 * Hide-by-default is the canonical posture per the operator's mental
 * model of a live activities feed: reaping turns a 30k-atom dump
 * (stale stage events, exhausted pipelines) into a manageable view of
 * the recent live work. The toggle still exists so an audit operator
 * who needs the historical record (e.g. dogfeed-22 forensic walk
 * over reaped pipelines) can flip it inline without leaving the page.
 *
 * Persistence: the choice rides through `storage.service` so a
 * triage session that flipped the toggle remembers across reloads.
 * Mirrors the plans-viewer bucket-filter pattern in scope and
 * persistence so adding the third toggle stays consistent rather
 * than each feature inventing its own key shape.
 */

export const REAPED_TOGGLE_STORAGE_KEY = 'activities-include-reaped';
export const DEFAULT_INCLUDE_REAPED = false;

/**
 * Coerce an arbitrary persisted value back to a boolean. Anything we
 * do not recognise (missing key, corrupted localStorage, an old
 * pre-toggle deployment) falls back to the default rather than
 * throwing, so the view stays live across version skew.
 */
export function normalizeIncludeReaped(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  return DEFAULT_INCLUDE_REAPED;
}
