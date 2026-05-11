/**
 * File-intent service: POSTs to /api/intents.file to write an
 * operator-intent atom from the Console UI.
 *
 * Mirrors the canon-service shape (canon.service.ts): a single
 * typed transport call, no fetch leakage, ready for the Tauri
 * swap. The principal_id the atom gets attributed to lives on the
 * server (LAG_CONSOLE_ACTOR_ID); the UI never passes it on the
 * wire (canon `dev-framework-mechanism-only` -- a browser tab
 * cannot self-identify).
 */

import { transport } from '@/services/transport';

export const SCOPE_VALUES = ['tooling', 'docs', 'framework', 'canon'] as const;
export const BLAST_RADIUS_VALUES = ['none', 'docs', 'tooling', 'framework', 'l3-canon-proposal'] as const;
export const SUB_ACTOR_VALUES = ['code-author', 'auditor-actor'] as const;

export type Scope = (typeof SCOPE_VALUES)[number];
export type BlastRadius = (typeof BLAST_RADIUS_VALUES)[number];
export type SubActor = (typeof SUB_ACTOR_VALUES)[number];

export interface FileIntentRequest {
  readonly request: string;
  readonly scope: Scope;
  readonly blast_radius: BlastRadius;
  readonly sub_actors: ReadonlyArray<SubActor>;
  readonly min_confidence?: number;
  readonly expires_in?: string;
  readonly trigger?: boolean;
}

export interface FileIntentResponse {
  readonly intent_id: string;
  readonly expires_at: string;
  readonly triggered: boolean;
}

/**
 * File an operator-intent atom via the Console backend. The backend
 * validates against the canon `pol-operator-intent-creation` allowlist
 * before writing, so a non-whitelisted operator surfaces a typed 403
 * `principal-not-allowed` here.
 */
export async function fileIntent(
  params: FileIntentRequest,
  signal?: AbortSignal,
): Promise<FileIntentResponse> {
  return transport.call<FileIntentResponse>(
    'intents.file',
    params as unknown as Record<string, unknown>,
    signal ? { signal } : undefined,
  );
}

// ---------------------------------------------------------------------------
// Form helpers (pure, exported so the test suite can pin every branch
// without standing up the DOM).
// ---------------------------------------------------------------------------

export const EXPIRES_PRESETS: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: '1h', label: '1 hour' },
  { value: '4h', label: '4 hours' },
  { value: '24h', label: '24 hours' },
  { value: '72h', label: '72 hours (max)' },
];

export const DEFAULT_EXPIRES = '24h';
export const DEFAULT_MIN_CONFIDENCE = 0.75;

export interface FileIntentFormErrors {
  readonly request?: string;
  readonly subActors?: string;
}

/**
 * Pure form-level validator. Returns the same shape the form
 * renderer keys inline-error pills off so the component never
 * re-implements the rules.
 *
 * Web boundary: returning an empty object is the "submit-allowed"
 * signal; presence of any key is a block. Mirrors the React Hook
 * Form / Zod conventions used elsewhere in the console without
 * pulling either dep.
 */
export function validateFileIntentForm(form: {
  readonly request: string;
  readonly subActors: ReadonlyArray<string>;
}): FileIntentFormErrors {
  const errors: { request?: string; subActors?: string } = {};
  if (form.request.trim().length === 0) {
    errors.request = 'Describe the intent. The autonomous pipeline reads this verbatim.';
  } else if (form.request.trim().length < 12) {
    // A 12-char floor catches "fix it"-shaped intents that the pipeline
    // cannot ground into a plan; the CLI lets these through but the
    // Console is the friendlier surface so we surface the gap inline.
    errors.request = 'Intent text is too short; add enough detail for a plan to ground against (at least 12 characters).';
  }
  if (form.subActors.length === 0) {
    errors.subActors = 'Select at least one sub-actor that may carry out the plan.';
  }
  return errors;
}

export function isFormValid(errors: FileIntentFormErrors): boolean {
  return Object.keys(errors).length === 0;
}
