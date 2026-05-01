import type { MouseEvent as ReactMouseEvent } from 'react';
import { ExternalLink } from 'lucide-react';
import { Section, AttrRow } from '../Section';
import { asString, asNumber, asRecord, formatDate } from './helpers';
import { routeHref, setRoute } from '@/state/router.store';
import styles from '../AtomDetailView.module.css';
import type { AtomRendererProps } from './types';

/**
 * Pipeline renderer. The pipeline atom is the ROOT of a deep-planning
 * chain (brainstorm -> spec -> plan -> review -> dispatch). The
 * dedicated /pipelines/<id> view renders the full chain projection;
 * this atom-detail page is per-atom, so we expose the root metadata
 * plus a one-click jump to the dedicated detail view.
 *
 * Pipeline_state surfaces in the page header pill via the parent
 * AtomDetailView's status-aware metadata strip.
 */
export function PipelineRenderer({ atom }: AtomRendererProps) {
  const meta = asRecord(atom.metadata) ?? {};
  const mode = asString(meta['mode']);
  const stagePolicyAtomId = asString(meta['stage_policy_atom_id']);
  const startedAt = asString(meta['started_at']);
  const completedAt = asString(meta['completed_at']);
  const totalCostUsd = asNumber(meta['total_cost_usd']);
  const currentStage = asString(meta['current_stage']);
  const currentStageIndex = asNumber(meta['current_stage_index']);

  return (
    <>
      <Section title="Pipeline" testId="atom-detail-pipeline-summary">
        <dl className={styles.attrs}>
          {mode && <AttrRow label="Mode" value={mode} />}
          {currentStage && <AttrRow label="Current stage" value={currentStage} />}
          {currentStageIndex !== null && (
            <AttrRow label="Stage index" value={String(currentStageIndex)} />
          )}
          {startedAt && <AttrRow label="Started at" value={formatDate(startedAt)} />}
          {completedAt && <AttrRow label="Completed at" value={formatDate(completedAt)} />}
          {totalCostUsd !== null && (
            <AttrRow label="Total cost" value={`$${totalCostUsd.toFixed(2)}`} />
          )}
          {stagePolicyAtomId && (
            <AttrRow label="Stage policy" value={<code>{stagePolicyAtomId}</code>} />
          )}
        </dl>
        <div className={styles.actionsRow}>
          <a
            href={routeHref('pipelines', atom.id)}
            data-testid="atom-detail-pipeline-open-detail"
            onClick={(e: ReactMouseEvent<HTMLAnchorElement>) => {
              if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              setRoute('pipelines', atom.id);
            }}
          >
            <ExternalLink size={12} strokeWidth={2} aria-hidden="true" />
            {'\u00A0'}Open full pipeline view
          </a>
        </div>
      </Section>
    </>
  );
}
