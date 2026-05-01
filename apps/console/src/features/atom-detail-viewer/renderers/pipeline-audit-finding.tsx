import { AlertTriangle, AlertCircle, Info } from 'lucide-react';
import { AtomRef } from '@/components/atom-ref/AtomRef';
import { Section, AttrRow } from '../Section';
import { asString, asStringArray, asRecord } from './helpers';
import styles from '../AtomDetailView.module.css';
import type { AtomRendererProps } from './types';

/**
 * Pipeline-audit-finding renderer. The auditor stage emits one atom
 * per finding with severity (critical|major|minor) + category +
 * cited atom ids + cited paths + a remediation message. This is the
 * substrate-level closure of dev-drafter-citation-verification-required:
 * every cited atom-id and source-path the upstream plan named is
 * re-walked and validated, with mismatches surfaced here as auditable
 * atoms.
 */
function severityIcon(severity: string | null) {
  if (severity === 'critical') {
    return <AlertCircle size={14} strokeWidth={2} aria-hidden="true" />;
  }
  if (severity === 'major' || severity === 'warning') {
    return <AlertTriangle size={14} strokeWidth={2} aria-hidden="true" />;
  }
  return <Info size={14} strokeWidth={2} aria-hidden="true" />;
}

function severityVariant(severity: string | null): 'danger' | 'warning' | 'info' {
  if (severity === 'critical') return 'danger';
  if (severity === 'major' || severity === 'warning') return 'warning';
  return 'info';
}

export function PipelineAuditFindingRenderer({ atom }: AtomRendererProps) {
  const meta = asRecord(atom.metadata) ?? {};
  const pipelineId = asString(meta['pipeline_id']);
  const stageName = asString(meta['stage_name']);
  const severity = asString(meta['severity']);
  const category = asString(meta['category']);
  const message = asString(meta['message']);
  const citedAtomIds = asStringArray(meta['cited_atom_ids']);
  const citedPaths = asStringArray(meta['cited_paths']);

  return (
    <>
      <Section title="Audit finding" testId="atom-detail-audit-finding">
        <div className={styles.metaRow}>
          {severity && (
            <span
              className={styles.statusPill}
              data-variant={severityVariant(severity)}
              data-testid="atom-detail-audit-finding-severity"
            >
              {severityIcon(severity)}
              {severity}
            </span>
          )}
          {category && (
            <code data-testid="atom-detail-audit-finding-category">{category}</code>
          )}
        </div>
        <dl className={styles.attrs}>
          {stageName && <AttrRow label="Stage" value={stageName} />}
          {pipelineId && (
            <AttrRow label="Pipeline" value={<AtomRef id={pipelineId} />} />
          )}
        </dl>
        {message && (
          <div>
            <h4 className={styles.attrLabel}>Remediation</h4>
            <p className={styles.sectionBody} data-testid="atom-detail-audit-finding-message">
              {message}
            </p>
          </div>
        )}
      </Section>

      {citedAtomIds.length > 0 && (
        <Section
          title={`Cited atoms (${citedAtomIds.length})`}
          testId="atom-detail-audit-finding-cited-atoms"
        >
          <ul className={styles.refList}>
            {citedAtomIds.map((id) => (
              <li key={id} className={styles.refItem}>
                <AtomRef id={id} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      {citedPaths.length > 0 && (
        <Section
          title={`Cited paths (${citedPaths.length})`}
          testId="atom-detail-audit-finding-cited-paths"
        >
          <ul className={styles.bulletList}>
            {citedPaths.map((p) => (
              <li key={p}><code>{p}</code></li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}
