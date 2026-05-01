import { CheckCircle2, AlertCircle } from 'lucide-react';
import { AtomRef } from '@/components/atom-ref/AtomRef';
import { Section, AttrRow } from '../Section';
import { asString, asNumber, asStringArray, asRecord } from './helpers';
import styles from '../AtomDetailView.module.css';
import type { AtomRendererProps } from './types';

/**
 * Auditor-plan-check renderer. The auditor stage emits a verdict
 * observation atom (`type: observation`, `metadata.kind:
 * 'auditor-plan-check'`) carrying:
 *   verdict       : pass | fail | warn
 *   reason        : envelope explanation
 *   diff_files    : files that changed
 *   diff_radius   : the actual blast radius observed (docs|tooling|...)
 *   envelope_max  : the operator-allowed ceiling
 *   pr_number     : the PR observed
 *   plan_id       : the plan being audited
 *   intent_id     : the operator-intent that authorized the plan
 */
export function AuditorPlanCheckRenderer({ atom }: AtomRendererProps) {
  const meta = asRecord(atom.metadata) ?? {};
  const verdict = asString(meta['verdict']);
  const reason = asString(meta['reason']);
  const diffFiles = asStringArray(meta['diff_files']);
  const diffRadius = asString(meta['diff_radius']);
  const envelopeMax = asString(meta['envelope_max']);
  const prNumber = asNumber(meta['pr_number']);
  const planId = asString(meta['plan_id']);
  const intentId = asString(meta['intent_id']);

  const verdictVariant: 'success' | 'danger' | 'warning' = verdict === 'pass'
    ? 'success'
    : verdict === 'fail'
      ? 'danger'
      : 'warning';

  return (
    <>
      <Section title="Auditor verdict" testId="atom-detail-auditor-verdict">
        <div className={styles.metaRow}>
          {verdict && (
            <span
              className={styles.statusPill}
              data-variant={verdictVariant}
              data-testid="atom-detail-auditor-verdict-pill"
            >
              {verdict === 'pass'
                ? <CheckCircle2 size={14} strokeWidth={2} aria-hidden="true" />
                : <AlertCircle size={14} strokeWidth={2} aria-hidden="true" />}
              {verdict}
            </span>
          )}
          {reason && (
            <span className={styles.sectionBody} data-testid="atom-detail-auditor-reason">
              {reason}
            </span>
          )}
        </div>
        <dl className={styles.attrs}>
          {diffRadius && <AttrRow label="Diff radius" value={diffRadius} testId="atom-detail-auditor-diff-radius" />}
          {envelopeMax && <AttrRow label="Envelope max" value={envelopeMax} />}
          {prNumber !== null && (
            <AttrRow label="PR" value={`#${prNumber}`} />
          )}
          {planId && (
            <AttrRow label="Plan" value={<AtomRef id={planId} />} />
          )}
          {intentId && (
            <AttrRow label="Intent" value={<AtomRef id={intentId} />} />
          )}
        </dl>
      </Section>

      {diffFiles.length > 0 && (
        <Section
          title={`Diff files (${diffFiles.length})`}
          testId="atom-detail-auditor-diff-files"
        >
          <ul className={styles.bulletList}>
            {diffFiles.map((p) => (
              <li key={p}><code>{p}</code></li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}
