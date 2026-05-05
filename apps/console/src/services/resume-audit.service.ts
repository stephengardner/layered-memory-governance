/**
 * Resume audit service: wraps /api/resume.summary, /api/resume.recent,
 * /api/resume.resets.
 *
 * One service per surface so the data-fetching contract for each view
 * stays small + auditable. Mirrors `pipelines.service.ts` shape;
 * consumers call the exported functions inside TanStack Query hooks
 * rather than going direct to the transport.
 *
 * Wire-shape types are re-exported from `server/resume-audit-types.ts`
 * (the authoritative source). Re-exporting rather than duplicating
 * the shapes eliminates the silent client/server drift hazard.
 *
 * Read-only contract: every call here is a query; no write surface
 * exists for resume-audit yet (the substrate writes resume-related
 * fields; the UI observes them).
 */

import { transport } from './transport';

export type {
  ResumeAttemptKind,
  ResumeAuditPrincipalStats,
  ResumeAuditRecentResponse,
  ResumeAuditRecentSession,
  ResumeAuditResetRecord,
  ResumeAuditResetsResponse,
  ResumeAuditSummary,
} from '../../server/resume-audit-types';

import type {
  ResumeAuditRecentResponse,
  ResumeAuditResetsResponse,
  ResumeAuditSummary,
} from '../../server/resume-audit-types';

export async function getResumeSummary(
  windowHours?: number,
  signal?: AbortSignal,
): Promise<ResumeAuditSummary> {
  const params = windowHours !== undefined ? { window_hours: windowHours } : undefined;
  return transport.call<ResumeAuditSummary>(
    'resume.summary',
    params,
    signal ? { signal } : undefined,
  );
}

export async function getResumeRecent(
  limit?: number,
  signal?: AbortSignal,
): Promise<ResumeAuditRecentResponse> {
  const params = limit !== undefined ? { limit } : undefined;
  return transport.call<ResumeAuditRecentResponse>(
    'resume.recent',
    params,
    signal ? { signal } : undefined,
  );
}

export async function getResumeResets(
  limit?: number,
  signal?: AbortSignal,
): Promise<ResumeAuditResetsResponse> {
  const params = limit !== undefined ? { limit } : undefined;
  return transport.call<ResumeAuditResetsResponse>(
    'resume.resets',
    params,
    signal ? { signal } : undefined,
  );
}
