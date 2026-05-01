import { AtomRef } from '@/components/atom-ref/AtomRef';
import { asString, asStringArray, asRecord, readStageOutput, formatUsd, asNumber } from './helpers';
import { StageOutputShell } from './stage-output-shell';
import styles from '../AtomDetailView.module.css';
import type { AtomRendererProps } from './types';

/**
 * Brainstorm-output renderer. The brainstorm stage emits open
 * questions, surveyed alternatives (with rejection reasons), decision
 * points, and a cost ledger. Each piece is a structured block; we
 * render them as labeled sections rather than dumping raw JSON.
 */
export function BrainstormOutputRenderer(props: AtomRendererProps) {
  const so = readStageOutput(props.atom.metadata, props.atom.content);
  const openQuestions = asStringArray(so?.['open_questions']);
  const decisionPoints = asStringArray(so?.['decision_points']);
  const alternativesRaw = Array.isArray(so?.['alternatives_surveyed'])
    ? (so?.['alternatives_surveyed'] as ReadonlyArray<unknown>)
    : [];
  const costUsd = asNumber(so?.['cost_usd']);

  const body = (
    <>
      {openQuestions.length > 0 && (
        <div data-testid="atom-detail-brainstorm-open-questions">
          <h4 className={styles.attrLabel}>{`Open questions (${openQuestions.length})`}</h4>
          <ul className={styles.bulletList}>
            {openQuestions.map((q, i) => (<li key={i}>{q}</li>))}
          </ul>
        </div>
      )}

      {alternativesRaw.length > 0 && (
        <div data-testid="atom-detail-brainstorm-alternatives">
          <h4 className={styles.attrLabel}>{`Alternatives surveyed (${alternativesRaw.length})`}</h4>
          <ul className={styles.optionList}>
            {alternativesRaw.map((raw, i) => {
              const obj = asRecord(raw);
              const option = obj ? asString(obj['option']) : null;
              const reason = obj ? asString(obj['rejection_reason']) ?? asString(obj['reason']) : null;
              return (
                <li key={i} className={styles.option}>
                  <span className={styles.optionTitle}>{option ?? (typeof raw === 'string' ? raw : '(unnamed option)')}</span>
                  {reason && <span className={styles.optionReason}>{reason}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {decisionPoints.length > 0 && (
        <div data-testid="atom-detail-brainstorm-decision-points">
          <h4 className={styles.attrLabel}>{`Decision points (${decisionPoints.length})`}</h4>
          <ul className={styles.bulletList}>
            {decisionPoints.map((d, i) => (<li key={i}>{d}</li>))}
          </ul>
        </div>
      )}

      {costUsd !== null && (
        <p className={styles.sectionBody} data-testid="atom-detail-brainstorm-cost">
          Cost: {formatUsd(costUsd)}
        </p>
      )}

      {!so && (
        <pre className={styles.proseBody}>{props.atom.content}</pre>
      )}
    </>
  );

  return <StageOutputShell {...props} bodyTitle="Brainstorm output" body={body} />;
}

/**
 * Spec-output renderer. Each spec atom carries goal + body + cited
 * atoms + cited paths + alternatives_rejected + cost. The body is the
 * primary read; everything else surfaces as labeled blocks.
 */
export function SpecOutputRenderer(props: AtomRendererProps) {
  const so = readStageOutput(props.atom.metadata, props.atom.content);
  const goal = asString(so?.['goal']);
  const specBody = asString(so?.['body']);
  const citedAtomIds = asStringArray(so?.['cited_atom_ids']);
  const citedPaths = asStringArray(so?.['cited_paths']);
  const alternativesRaw = Array.isArray(so?.['alternatives_rejected'])
    ? (so?.['alternatives_rejected'] as ReadonlyArray<unknown>)
    : [];
  const costUsd = asNumber(so?.['cost_usd']);

  const body = (
    <>
      {goal && (
        <div data-testid="atom-detail-spec-goal">
          <h4 className={styles.attrLabel}>Goal</h4>
          <p className={styles.sectionBody}>{goal}</p>
        </div>
      )}

      {specBody && (
        <div data-testid="atom-detail-spec-body">
          <h4 className={styles.attrLabel}>Body</h4>
          <pre className={styles.proseBody}>{specBody}</pre>
        </div>
      )}

      {alternativesRaw.length > 0 && (
        <div data-testid="atom-detail-spec-alternatives">
          <h4 className={styles.attrLabel}>{`Alternatives rejected (${alternativesRaw.length})`}</h4>
          <ul className={styles.optionList}>
            {alternativesRaw.map((raw, i) => {
              if (typeof raw === 'string') {
                return <li key={i} className={styles.option}><span className={styles.optionTitle}>{raw}</span></li>;
              }
              const obj = asRecord(raw);
              const option = obj ? asString(obj['option']) : null;
              const reason = obj ? asString(obj['reason']) : null;
              return (
                <li key={i} className={styles.option}>
                  <span className={styles.optionTitle}>{option ?? '(unnamed option)'}</span>
                  {reason && <span className={styles.optionReason}>{reason}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {citedAtomIds.length > 0 && (
        <div data-testid="atom-detail-spec-cited-atoms">
          <h4 className={styles.attrLabel}>{`Cited atoms (${citedAtomIds.length})`}</h4>
          <ul className={styles.refList}>
            {citedAtomIds.map((id) => (
              <li key={id} className={styles.refItem}><AtomRef id={id} /></li>
            ))}
          </ul>
        </div>
      )}

      {citedPaths.length > 0 && (
        <div data-testid="atom-detail-spec-cited-paths">
          <h4 className={styles.attrLabel}>{`Cited paths (${citedPaths.length})`}</h4>
          <ul className={styles.bulletList}>
            {citedPaths.map((p) => (<li key={p}><code>{p}</code></li>))}
          </ul>
        </div>
      )}

      {costUsd !== null && (
        <p className={styles.sectionBody} data-testid="atom-detail-spec-cost">
          Cost: {formatUsd(costUsd)}
        </p>
      )}

      {!so && (
        <pre className={styles.proseBody}>{props.atom.content}</pre>
      )}
    </>
  );

  return <StageOutputShell {...props} bodyTitle="Specification" body={body} />;
}

/**
 * Review-report renderer. The review stage emits an audit_status
 * (clean | findings) plus a findings list (each pointing at a
 * pipeline-audit-finding atom) and a cost ledger. The clean case is
 * the common path; the findings case is the substrate-fail-loud path.
 */
export function ReviewReportRenderer(props: AtomRendererProps) {
  const so = readStageOutput(props.atom.metadata, props.atom.content);
  const auditStatus = asString(so?.['audit_status']);
  const findingsRaw = Array.isArray(so?.['findings']) ? (so?.['findings'] as ReadonlyArray<unknown>) : [];
  const totalBytes = asNumber(so?.['total_bytes_read']);
  const costUsd = asNumber(so?.['cost_usd']);

  const body = (
    <>
      <div data-testid="atom-detail-review-status">
        <h4 className={styles.attrLabel}>Audit status</h4>
        <p className={styles.sectionBody}>
          <span
            className={styles.statusPill}
            data-variant={auditStatus === 'clean' ? 'success' : 'warning'}
          >
            {auditStatus ?? 'unknown'}
          </span>
        </p>
      </div>

      {findingsRaw.length > 0 && (
        <div data-testid="atom-detail-review-findings">
          <h4 className={styles.attrLabel}>{`Findings (${findingsRaw.length})`}</h4>
          <ul className={styles.optionList}>
            {findingsRaw.map((raw, i) => {
              const obj = asRecord(raw);
              const findingId = obj ? asString(obj['atom_id']) ?? asString(obj['id']) : null;
              const severity = obj ? asString(obj['severity']) : null;
              const message = obj ? asString(obj['message']) : null;
              return (
                <li key={i} className={styles.option}>
                  {severity && <span className={styles.optionTitle}>{severity}</span>}
                  {message && <span className={styles.optionReason}>{message}</span>}
                  {findingId && <AtomRef id={findingId} />}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <dl className={styles.attrs}>
        {totalBytes !== null && (
          <>
            <dt className={styles.attrLabel}>Bytes read</dt>
            <dd className={styles.attrValue} data-testid="atom-detail-review-bytes">{totalBytes}</dd>
          </>
        )}
        {costUsd !== null && (
          <>
            <dt className={styles.attrLabel}>Cost</dt>
            <dd className={styles.attrValue} data-testid="atom-detail-review-cost">{formatUsd(costUsd)}</dd>
          </>
        )}
      </dl>

      {!so && (
        <pre className={styles.proseBody}>{props.atom.content}</pre>
      )}
    </>
  );

  return <StageOutputShell {...props} bodyTitle="Review report" body={body} />;
}

/**
 * Dispatch-record renderer. The dispatch stage emits a status +
 * scanned/dispatched/failed counts + cost. Often the totals are zero
 * (sandbox runs); rendering them explicitly is the right operator UX
 * because "zero" is meaningful (the dispatch ran and decided not to
 * dispatch any sub-actor).
 */
export function DispatchRecordRenderer(props: AtomRendererProps) {
  const so = readStageOutput(props.atom.metadata, props.atom.content);
  const dispatchStatus = asString(so?.['dispatch_status']);
  const scanned = asNumber(so?.['scanned']);
  const dispatched = asNumber(so?.['dispatched']);
  const failed = asNumber(so?.['failed']);
  const costUsd = asNumber(so?.['cost_usd']);

  const body = (
    <>
      <div data-testid="atom-detail-dispatch-status">
        <h4 className={styles.attrLabel}>Dispatch status</h4>
        <p className={styles.sectionBody}>
          <span
            className={styles.statusPill}
            data-variant={dispatchStatus === 'completed' ? 'success' : 'info'}
          >
            {dispatchStatus ?? 'unknown'}
          </span>
        </p>
      </div>

      <dl className={styles.attrs}>
        {scanned !== null && (
          <>
            <dt className={styles.attrLabel}>Scanned</dt>
            <dd className={styles.attrValue} data-testid="atom-detail-dispatch-scanned">{scanned}</dd>
          </>
        )}
        {dispatched !== null && (
          <>
            <dt className={styles.attrLabel}>Dispatched</dt>
            <dd className={styles.attrValue} data-testid="atom-detail-dispatch-dispatched">{dispatched}</dd>
          </>
        )}
        {failed !== null && (
          <>
            <dt className={styles.attrLabel}>Failed</dt>
            <dd className={styles.attrValue} data-testid="atom-detail-dispatch-failed">{failed}</dd>
          </>
        )}
        {costUsd !== null && (
          <>
            <dt className={styles.attrLabel}>Cost</dt>
            <dd className={styles.attrValue}>{formatUsd(costUsd)}</dd>
          </>
        )}
      </dl>

      {!so && (
        <pre className={styles.proseBody}>{props.atom.content}</pre>
      )}
    </>
  );

  return <StageOutputShell {...props} bodyTitle="Dispatch record" body={body} />;
}
