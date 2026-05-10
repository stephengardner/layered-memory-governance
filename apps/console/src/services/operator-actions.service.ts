/**
 * Operator-actions service: wraps `/api/operator-actions.list`.
 *
 * One service per surface so the data-fetching contract for the view
 * stays small + auditable. Mirrors `resume-audit.service.ts` shape;
 * consumers call the exported function inside TanStack Query hooks
 * rather than going direct to the transport.
 *
 * Wire-shape types are re-exported from
 * `server/operator-actions-types.ts` (the authoritative source).
 * Re-exporting rather than duplicating the shapes eliminates the
 * silent client/server drift hazard.
 *
 * Read-only contract: every call here is a query; the substrate
 * wrappers (`gh-as.mjs`, `git-as.mjs`, `cr-trigger.mjs`,
 * `resolve-outdated-threads.mjs`) write the source atoms; this UI
 * observes them.
 */

import { transport } from './transport';

export type {
  OperatorActionKind,
  OperatorActionRow,
  OperatorActionsListResponse,
} from '../../server/operator-actions-types';

import type {
  OperatorActionKind,
  OperatorActionsListResponse,
} from '../../server/operator-actions-types';

export interface OperatorActionsListParams {
  readonly limit?: number;
  readonly actor?: string | null;
  readonly actionType?: OperatorActionKind | null;
}

export async function listOperatorActions(
  params: OperatorActionsListParams = {},
  signal?: AbortSignal,
): Promise<OperatorActionsListResponse> {
  const body: Record<string, unknown> = {};
  if (params.limit !== undefined) body['limit'] = params.limit;
  if (params.actor) body['actor'] = params.actor;
  if (params.actionType) body['action_type'] = params.actionType;
  return transport.call<OperatorActionsListResponse>(
    'operator-actions.list',
    body,
    signal ? { signal } : undefined,
  );
}
