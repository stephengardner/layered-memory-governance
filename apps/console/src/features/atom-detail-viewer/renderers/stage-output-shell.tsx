import { ReactNode } from 'react';
import { AtomRef } from '@/components/atom-ref/AtomRef';
import { Section, AttrRow } from '../Section';
import { asString, asRecord } from './helpers';
import styles from '../AtomDetailView.module.css';
import type { AtomRendererProps } from './types';

/**
 * Shared shell used by every per-stage stage-output renderer
 * (brainstorm-output, spec-output, review-report, dispatch-record).
 *
 * Every stage-output atom carries:
 *   metadata.pipeline_id : the root pipeline atom id
 *   metadata.stage_name  : the stage that produced this output
 *   metadata.stage_output : the structured output object
 *
 * The shell renders pipeline + stage attribution; renderers pass a
 * `body` block that interprets `stage_output` for that specific stage.
 *
 * Per canon `dev-extract-at-n-equals-two` this shell extracts the
 * common section before the second copy lands; the four stage-output
 * renderers share the same chrome but diverge in body shape.
 */
export function StageOutputShell({
  atom,
  bodyTitle,
  body,
}: AtomRendererProps & {
  readonly bodyTitle: string;
  readonly body: ReactNode;
}) {
  const meta = asRecord(atom.metadata) ?? {};
  const pipelineId = asString(meta['pipeline_id']);
  const stageName = asString(meta['stage_name']);

  return (
    <>
      <Section title="Stage output" testId="atom-detail-stage-output-summary">
        <dl className={styles.attrs}>
          {stageName && <AttrRow label="Stage" value={stageName} />}
          {pipelineId && (
            <AttrRow label="Pipeline" value={<AtomRef id={pipelineId} />} />
          )}
        </dl>
      </Section>

      <Section title={bodyTitle} testId="atom-detail-stage-output-body">
        {body}
      </Section>
    </>
  );
}
