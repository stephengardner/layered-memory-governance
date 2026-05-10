/**
 * Per-stage expansion state persistence.
 *
 * Inline-expanded stage cards on /pipelines/<id> survive a reload so an
 * operator who scrolls back to a partly-expanded pipeline finds the
 * same cards open. Per apps/console principle 10
 * (`dev-web-no-direct-platform-storage`) all persistence routes through
 * `storage.service.ts` — never `localStorage` direct.
 *
 * Key shape: `pipeline.stage-expanded.<pipelineId>.<stageName>` — one
 * boolean per stage, scoped per pipeline so two pipelines opened in
 * separate tabs do not cross-contaminate. Bucketing per pipeline (vs
 * one map per app) also keeps a runaway operator's expansion history
 * from accumulating into a single multi-MB blob: closed pipelines stop
 * collecting writes the moment the operator stops scrolling them.
 *
 * Pure helpers (`stageExpansionStorageKey`, `normalizeStageExpanded`)
 * are exported alongside the storage-bound `read`/`write` so unit tests
 * cover the contract that survives reload (the key shape, the
 * default-false-on-anything-not-true normalization) without standing
 * up jsdom.
 */

import { storage } from '@/services/storage.service';

/**
 * Storage key contract. The exact shape is the load-bearing piece a
 * reload depends on; renaming it silently breaks restoration for every
 * operator who had cards expanded before the version bump. Tests pin
 * the format so a rename has to update tests deliberately.
 */
export function stageExpansionStorageKey(
  pipelineId: string,
  stageName: string,
): string {
  return `pipeline.stage-expanded.${pipelineId}.${stageName}`;
}

/**
 * Coerce a raw storage value into the boolean we paint with. Strict
 * `=== true` so a corrupted entry (string 'true', 0/1, JSON object,
 * undefined, null) reads as the default-collapsed posture instead of
 * throwing. Mirrors the defensive normalize pattern in
 * `activities-viewer/reapedToggle.ts`.
 */
export function normalizeStageExpanded(value: unknown): boolean {
  return value === true;
}

export function readStageExpanded(
  pipelineId: string,
  stageName: string,
): boolean {
  const raw = storage.get<unknown>(stageExpansionStorageKey(pipelineId, stageName));
  return normalizeStageExpanded(raw);
}

export function writeStageExpanded(
  pipelineId: string,
  stageName: string,
  expanded: boolean,
): void {
  const key = stageExpansionStorageKey(pipelineId, stageName);
  if (expanded) {
    storage.set<boolean>(key, true);
  } else {
    storage.remove(key);
  }
}
