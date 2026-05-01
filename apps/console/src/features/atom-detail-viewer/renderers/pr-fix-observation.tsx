import { ExternalLink } from 'lucide-react';
import { AtomRef } from '@/components/atom-ref/AtomRef';
import { Section, AttrRow } from '../Section';
import { asString, asNumber, asStringArray, asRecord, formatDate } from './helpers';
import styles from '../AtomDetailView.module.css';
import type { AtomRendererProps } from './types';

/**
 * Pr-fix-observation renderer. Used for both `pr-fix-observation` and
 * the broader `observation` atoms emitted by pr-landing-agent for PR
 * status snapshots (kind: pr-observation in metadata). The metadata
 * carries pr identity, head sha, mergeable + merge_state_status, and
 * counts (line comments / nits / submitted reviews / check runs /
 * legacy statuses) that summarize the PR's review surfaces at a
 * single observed_at instant.
 *
 * Selecting this renderer also for `observation` is intentional when
 * `metadata.kind === 'pr-observation'`; the picker reads metadata.kind
 * before falling back to the generic observation path.
 */
export function PrFixObservationRenderer({ atom }: AtomRendererProps) {
  const meta = asRecord(atom.metadata) ?? {};
  const pr = asRecord(meta['pr']);
  const owner = pr ? asString(pr['owner']) : null;
  const repo = pr ? asString(pr['repo']) : null;
  const number = pr ? asNumber(pr['number']) : null;
  const headSha = asString(meta['head_sha']);
  const observedAt = asString(meta['observed_at']);
  const mergeable = asString(meta['mergeable']);
  const mergeState = asString(meta['merge_state_status']);
  const prState = asString(meta['pr_state']);
  const planId = asString(meta['plan_id']);
  const counts = asRecord(meta['counts']);
  const partial = meta['partial'] === true;
  const partialSurfaces = asStringArray(meta['partial_surfaces']);

  const ghUrl = owner && repo && number !== null
    ? `https://github.com/${owner}/${repo}/pull/${number}`
    : null;

  return (
    <>
      <Section title="PR observation" testId="atom-detail-pr-observation-summary">
        <dl className={styles.attrs}>
          {owner && repo && number !== null && (
            <AttrRow
              label="PR"
              value={
                <span data-testid="atom-detail-pr-observation-pr">
                  {`${owner}/${repo}#${number}`}
                  {ghUrl && (
                    <a
                      href={ghUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      style={{ marginLeft: '0.5rem' }}
                      aria-label="Open PR on GitHub"
                    >
                      <ExternalLink size={12} strokeWidth={2} aria-hidden="true" />
                    </a>
                  )}
                </span>
              }
            />
          )}
          {prState && <AttrRow label="State" value={prState} />}
          {mergeable && <AttrRow label="Mergeable" value={mergeable} />}
          {mergeState && (
            <AttrRow
              label="Merge state"
              value={<code data-testid="atom-detail-pr-observation-merge-state">{mergeState}</code>}
            />
          )}
          {headSha && (
            <AttrRow label="Head SHA" value={<code>{headSha.slice(0, 12)}</code>} mono />
          )}
          {observedAt && (
            <AttrRow label="Observed at" value={formatDate(observedAt)} />
          )}
          {planId && (
            <AttrRow label="Plan" value={<AtomRef id={planId} />} />
          )}
          {partial && (
            <AttrRow
              label="Partial"
              value={
                <span className={styles.statusPill} data-variant="warning">
                  partial: {partialSurfaces.length > 0 ? partialSurfaces.join(', ') : 'unknown surfaces'}
                </span>
              }
            />
          )}
        </dl>
      </Section>

      {counts && (
        <Section title="Review surfaces" testId="atom-detail-pr-observation-counts">
          <dl className={styles.attrs}>
            {Object.entries(counts).map(([k, v]) => (
              <AttrRow
                key={k}
                label={k.replace(/_/g, ' ')}
                value={typeof v === 'number' ? String(v) : '--'}
              />
            ))}
          </dl>
        </Section>
      )}

      {atom.content && (
        <Section title="Body" testId="atom-detail-pr-observation-body">
          <pre className={styles.proseBody}>{atom.content}</pre>
        </Section>
      )}
    </>
  );
}
