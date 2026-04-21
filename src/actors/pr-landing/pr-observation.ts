/**
 * pr-observation atom builders + renderer.
 *
 * Extracted from the run-pr-landing.mjs --observe-only code path so
 * the shape can be unit-tested without spawning the script. The .mjs
 * script imports from the compiled dist; tests import directly from
 * TS.
 *
 * Canon chain: `arch-pr-state-observation-via-actor-only` is the
 * architectural decision this atom shape serves. The observer writes
 * one atom per (owner, repo, pr, head_sha), chained via
 * provenance.derived_from to the prior observation for the same PR
 * so history is traceable without scanning the whole store.
 *
 * Framework boundary: `pr-observation` is NOT a new AtomType. The
 * framework's AtomType union is closed (src/types.ts). We use
 * `type: 'observation'` with `metadata.kind: 'pr-observation'` as the
 * discriminator, matching the convention the auditor already uses
 * for its findings observations. This preserves
 * `dev-substrate-not-prescription`: widening a core union for one
 * instance would push instance shape into framework.
 */

import type {
  Atom,
  AtomId,
  Principal,
  Time,
} from '../../types.js';
import type { PrReviewStatus } from '../pr-review/adapter.js';

export interface PrObservationInputs {
  readonly atomId: AtomId;
  readonly principal: Principal;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly headSha: string;
  readonly status: PrReviewStatus;
  readonly body: string;
  readonly observedAt: Time;
  readonly origin?: string;
  readonly priorId?: string | null;
}

/**
 * Deterministic id keyed on head SHA. Same SHA -> same atom (write is
 * a no-op when the atom already exists). New SHA -> new atom with a
 * derived_from link to the prior observation so history chains
 * without scanning.
 */
export function mkPrObservationAtomId(
  owner: string,
  repo: string,
  number: number,
  headSha: string,
): AtomId {
  const shaSuffix = String(headSha).slice(0, 12);
  return `pr-observation-${owner}-${repo}-${number}-${shaSuffix}` as AtomId;
}

export function mkPrObservationAtom(inputs: PrObservationInputs): Atom {
  const {
    atomId,
    principal,
    owner,
    repo,
    number,
    headSha,
    status,
    body,
    observedAt,
    origin,
    priorId,
  } = inputs;

  const derivedFrom = priorId ? [priorId as AtomId] : [];

  return {
    schema_version: 1,
    id: atomId,
    content: body,
    type: 'observation',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: {
        agent_id: String(principal.id),
        tool: 'run-pr-landing-observe-only',
        ...(origin !== undefined ? { session_id: origin } : {}),
      },
      derived_from: derivedFrom,
    },
    confidence: status.partial ? 0.7 : 1.0,
    created_at: observedAt,
    last_reinforced_at: observedAt,
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
    principal_id: principal.id,
    taint: 'clean',
    metadata: {
      kind: 'pr-observation',
      pr: { owner, repo, number },
      head_sha: headSha,
      observed_at: observedAt,
      mergeable: status.mergeable,
      merge_state_status: status.mergeStateStatus,
      counts: {
        line_comments: status.lineComments.length,
        body_nits: status.bodyNits.length,
        submitted_reviews: status.submittedReviews.length,
        check_runs: status.checkRuns.length,
        legacy_statuses: status.legacyStatuses.length,
      },
      partial: status.partial,
      partial_surfaces: status.partialSurfaces,
    },
  };
}

/**
 * Human-readable summary that goes into both the atom's `content`
 * field and the PR comment body. Single render so the two surfaces
 * cannot drift.
 */
export function renderPrObservationBody(args: {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly status: PrReviewStatus;
  readonly headSha: string;
  readonly observedAt: Time;
}): string {
  const { owner, repo, number, status, headSha, observedAt } = args;
  const lines: string[] = [];
  lines.push(`**pr-observation for ${owner}/${repo}#${number}**`);
  lines.push('');
  lines.push(`observed_at: ${observedAt}`);
  lines.push(`head_sha: \`${headSha}\``);
  lines.push(`mergeable: ${status.mergeable === null ? 'UNKNOWN' : status.mergeable}`);
  lines.push(`mergeStateStatus: \`${status.mergeStateStatus ?? '?'}\``);
  if (status.partial) {
    lines.push(`partial: ${status.partialSurfaces.length} surfaces failed - ${status.partialSurfaces.join(', ')}`);
  }
  lines.push('');
  lines.push(`submitted reviews: ${status.submittedReviews.length}`);
  for (const r of status.submittedReviews) {
    lines.push(`  - ${r.author} ${r.state} at ${r.submittedAt}`);
  }
  lines.push(`check-runs: ${status.checkRuns.length}`);
  for (const c of status.checkRuns) {
    lines.push(`  - ${c.name}: ${c.conclusion ?? c.status}`);
  }
  lines.push(`legacy statuses: ${status.legacyStatuses.length}`);
  for (const s of status.legacyStatuses) {
    lines.push(`  - ${s.context}: ${s.state}`);
  }
  lines.push(`unresolved line comments: ${status.lineComments.length}`);
  lines.push(`body-scoped nits: ${status.bodyNits.length}`);
  lines.push('');
  lines.push('_Emitted by run-pr-landing.mjs --observe-only. Session agents read this atom (via pr-status.mjs) rather than polling GitHub directly, per canon `arch-pr-state-observation-via-actor-only`._');
  return lines.join('\n');
}

/**
 * The failure observation. Written when getPrReviewStatus itself
 * throws, so the failure has a durable atom surface per
 * inv-governance-before-autonomy. Distinguished by
 * `metadata.kind: 'pr-observation-failed'`.
 */
export function mkPrObservationFailedAtom(args: {
  readonly atomId: AtomId;
  readonly principal: Principal;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly reason: string;
  readonly observedAt: Time;
  readonly origin?: string;
}): Atom {
  const { atomId, principal, owner, repo, number, reason, observedAt, origin } = args;
  return {
    schema_version: 1,
    id: atomId,
    content: `pr-observation failed for ${owner}/${repo}#${number}: ${reason}`,
    type: 'observation',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: {
        agent_id: String(principal.id),
        tool: 'run-pr-landing-observe-only',
        ...(origin !== undefined ? { session_id: origin } : {}),
      },
      derived_from: [],
    },
    confidence: 1.0,
    created_at: observedAt,
    last_reinforced_at: observedAt,
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
    principal_id: principal.id,
    taint: 'clean',
    metadata: {
      kind: 'pr-observation-failed',
      pr: { owner, repo, number },
      reason,
    },
  };
}
