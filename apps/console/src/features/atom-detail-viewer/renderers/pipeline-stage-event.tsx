import { AtomRef } from '@/components/atom-ref/AtomRef';
import { Section, AttrRow } from '../Section';
import {
  asString,
  asNumber,
  asRecord,
  formatDurationMs,
  formatUsd,
} from './helpers';
import styles from '../AtomDetailView.module.css';
import type { AtomRendererProps } from './types';

/**
 * Pipeline-stage-event renderer. Each stage emits an `enter` and
 * `exit` event atom (and `pause`/`resume` variants for HIL gates).
 * The metadata bag carries pipeline_id + stage_name + transition +
 * duration_ms + cost_usd which together define the lifecycle slice.
 */
export function PipelineStageEventRenderer({ atom }: AtomRendererProps) {
  const meta = asRecord(atom.metadata) ?? {};
  const pipelineId = asString(meta['pipeline_id']);
  const stageName = asString(meta['stage_name']);
  const transition = asString(meta['transition']);
  const durationMs = asNumber(meta['duration_ms']);
  const costUsd = asNumber(meta['cost_usd']);

  return (
    <Section title="Stage event" testId="atom-detail-stage-event">
      <dl className={styles.attrs}>
        {stageName && <AttrRow label="Stage" value={stageName} />}
        {transition && (
          <AttrRow
            label="Transition"
            value={<code data-testid="atom-detail-stage-event-transition">{transition}</code>}
          />
        )}
        {durationMs !== null && (
          <AttrRow label="Duration" value={formatDurationMs(durationMs)} />
        )}
        {costUsd !== null && (
          <AttrRow label="Cost" value={formatUsd(costUsd)} />
        )}
        {pipelineId && (
          <AttrRow
            label="Pipeline"
            value={<AtomRef id={pipelineId} />}
          />
        )}
      </dl>
    </Section>
  );
}
