import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileWarning,
  ShieldAlert,
  Skull,
  StopCircle,
} from 'lucide-react';
import { AtomRef } from '@/components/atom-ref/AtomRef';
import {
  fetchPipelineErrorState,
  type PipelineErrorAction,
  type PipelineErrorCategory,
  type PipelineErrorState,
} from '@/services/pipelines.service';
import { storage } from '@/services/storage.service';
import { setRoute } from '@/state/router.store';
import {
  categoryIconKind,
  errorBlockExpansionStorageKey,
  normalizeErrorBlockExpanded,
  severityToToneToken,
} from './pipelineErrorBlock.helpers';
import styles from './PipelineErrorBlock.module.css';

/**
 * PipelineErrorBlock -- categorized error surface for /pipelines/<id>.
 *
 * Fetches the projection at /api/pipeline.error-state and renders it as
 * an inline block above the stage timeline. Hidden when the projection
 * reports `state: 'ok'` (running / completed / hil-paused). Auto-
 * expanded for terminal-negative states; the operator can collapse via
 * the chevron and the preference is persisted per pipeline so a reload
 * restores their last view.
 *
 * Behaviors baked in:
 *   - Polls every 5s while the pipeline is non-terminal so a write
 *     that flips the pipeline into failed/halted lights up the block
 *     within seconds even without the SSE channel.
 *   - 44px touch-target floor on every action button per canon
 *     dev-web-mobile-first-touch-target.
 *   - Mobile-first single-column layout; desktop spans actions in a
 *     wrap-friendly flex row.
 *   - Severity-driven background tone (critical / warning / info).
 *   - Quick actions navigate via the SPA router (no full-page reload).
 *   - "Raw cause" disclosure surfaces the verbatim substrate string so
 *     the operator can read what the categorizer interpreted.
 *
 * Read-only contract: actions navigate to other Console surfaces;
 * abandon dispatches the 'pipeline-error-abandon' DOM custom event
 * which the parent PipelineDetailView listens for to open its existing
 * AbandonControl modal. The block itself never writes.
 */
export function PipelineErrorBlock({ pipelineId }: { pipelineId: string }) {
  const query = useQuery({
    queryKey: ['pipeline-error-state', pipelineId],
    queryFn: ({ signal }) => fetchPipelineErrorState(pipelineId, signal),
    /*
     * Match the detail view's polling cadence so the two queries
     * settle into the same heartbeat. Stop once the pipeline reaches
     * a terminal state -- the projection won't flip back from failed
     * to running.
     */
    refetchInterval: (queryState) => {
      const state = queryState.state.data?.state;
      if (!state || state === 'ok') return 5000;
      return false;
    },
    refetchOnWindowFocus: true,
  });

  if (!query.data || query.data.state === 'ok') return null;
  /*
   * key={pipelineId} forces React to remount PipelineErrorBody when
   * the surface navigates to a different pipeline. The body's
   * `useState(() => readExpanded(pipelineId))` initializer only runs
   * on mount, so without the key a same-component-instance update
   * would keep the previous pipeline's expansion state. CR PR #404
   * finding.
   */
  return <PipelineErrorBody key={pipelineId} data={query.data} pipelineId={pipelineId} />;
}

function readExpanded(pipelineId: string): boolean {
  const raw = storage.get<unknown>(errorBlockExpansionStorageKey(pipelineId));
  return normalizeErrorBlockExpanded(raw);
}

function writeExpanded(pipelineId: string, expanded: boolean): void {
  const key = errorBlockExpansionStorageKey(pipelineId);
  if (!expanded) {
    storage.set<boolean>(key, false);
  } else {
    storage.remove(key);
  }
}

function PipelineErrorBody({
  data,
  pipelineId,
}: {
  data: PipelineErrorState;
  pipelineId: string;
}) {
  const [expanded, setExpanded] = useState<boolean>(() => readExpanded(pipelineId));
  const toggleExpand = () => {
    setExpanded((prev) => {
      const next = !prev;
      writeExpanded(pipelineId, next);
      return next;
    });
  };
  const panelId = `pipeline-error-body-${pipelineId}`;
  const severity = data.severity ?? 'info';
  const tone = severityToToneToken(severity);

  return (
    <section
      className={styles.block}
      data-testid="pipeline-error-block"
      data-pipeline-state={data.state}
      data-severity={severity}
      data-category={data.category ?? ''}
      role="region"
      aria-label={`Pipeline error: ${data.category_label ?? 'failure'}`}
    >
      <div className={styles.head}>
        <div className={styles.headLead} style={{ color: tone }}>
          <span
            className={styles.severityBadge}
            data-testid="pipeline-error-severity-badge"
            data-severity={severity}
          >
            {categoryIcon(data.category)}
            <span>{data.category_label ?? data.state}</span>
          </span>
        </div>
        {data.failed_stage_name && (
          <span className={styles.categoryLabel} data-testid="pipeline-error-stage">
            at <code>{data.failed_stage_name}</code>
            {data.failed_stage_index !== null && ` (#${data.failed_stage_index + 1})`}
          </span>
        )}
        <button
          type="button"
          className={styles.toggle}
          data-testid="pipeline-error-toggle"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={toggleExpand}
        >
          {expanded
            ? <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
            : <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />}
          <span>{expanded ? 'Collapse' : 'Expand'}</span>
        </button>
      </div>
      {expanded && (
        <div className={styles.body} id={panelId}>
          {data.suggested_action && (
            <p className={styles.suggested} data-testid="pipeline-error-suggested">
              {data.suggested_action}
            </p>
          )}
          {data.cited_atom_ids.length > 0 && (
            <div className={styles.citationBlock} data-testid="pipeline-error-cited-atoms">
              <span className={styles.citationLabel}>Cited atoms</span>
              <ul className={styles.citationList}>
                {data.cited_atom_ids.map((id) => (
                  <li key={id}><AtomRef id={id} variant="chip" /></li>
                ))}
              </ul>
            </div>
          )}
          {data.raw_cause && (
            <details className={styles.rawCauseDetails} data-testid="pipeline-error-raw-cause">
              <summary>Raw cause</summary>
              <pre className={styles.rawCausePre}>{data.raw_cause}</pre>
            </details>
          )}
          {data.actions.length > 0 && (
            <div className={styles.actions} data-testid="pipeline-error-actions">
              {data.actions.map((action, idx) => (
                <ActionButton
                  key={`${action.kind}-${idx}`}
                  action={action}
                  pipelineId={pipelineId}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ActionButton({
  action,
  pipelineId,
}: {
  action: PipelineErrorAction;
  pipelineId: string;
}) {
  const onClick = (e: React.MouseEvent) => {
    e.preventDefault();
    switch (action.kind) {
      case 'view-atom':
      case 'view-output':
      case 'view-policy':
        if (action.atom_id) {
          setRoute('atom', action.atom_id);
        }
        return;
      case 'view-canon':
        if (action.canon_id) {
          setRoute('canon', action.canon_id);
        }
        return;
      case 'abandon':
        /*
         * Dispatch a DOM custom event the parent listens for so the
         * existing AbandonControl modal opens. Keeps the block
         * read-only by construction: it never calls the write API
         * directly. The parent owns the actor-id preflight + the
         * audit-trail reason input.
         */
        window.dispatchEvent(
          new CustomEvent('pipeline-error-abandon', {
            detail: { pipelineId },
          }),
        );
        return;
    }
  };

  return (
    <button
      type="button"
      className={styles.actionButton}
      data-testid={`pipeline-error-action-${action.kind}`}
      data-kind={action.kind}
      data-atom-id={action.atom_id ?? ''}
      data-canon-id={action.canon_id ?? ''}
      onClick={onClick}
    >
      {actionIcon(action.kind)}
      <span>{action.label}</span>
      {action.kind !== 'abandon' && (
        <ExternalLink size={12} strokeWidth={2} aria-hidden="true" />
      )}
    </button>
  );
}

function categoryIcon(category: PipelineErrorCategory | null): React.ReactNode {
  switch (categoryIconKind(category)) {
    case 'stop-circle':
      return <StopCircle size={12} strokeWidth={2.25} aria-hidden="true" />;
    case 'skull':
      return <Skull size={12} strokeWidth={2.25} aria-hidden="true" />;
    case 'shield-alert':
      return <ShieldAlert size={12} strokeWidth={2.25} aria-hidden="true" />;
    case 'file-warning':
      return <FileWarning size={12} strokeWidth={2.25} aria-hidden="true" />;
    case 'alert-triangle':
    default:
      return <AlertTriangle size={12} strokeWidth={2.25} aria-hidden="true" />;
  }
}

function actionIcon(kind: PipelineErrorAction['kind']): React.ReactNode {
  switch (kind) {
    case 'abandon':
      return <Skull size={12} strokeWidth={2} aria-hidden="true" />;
    case 'view-canon':
      return <ShieldAlert size={12} strokeWidth={2} aria-hidden="true" />;
    case 'view-output':
    case 'view-policy':
    case 'view-atom':
    default:
      return null;
  }
}
