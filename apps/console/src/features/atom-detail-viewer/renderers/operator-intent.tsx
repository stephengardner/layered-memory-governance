import { Section, AttrRow } from '../Section';
import { asString, asNumber, asStringArray, asRecord, formatDate } from './helpers';
import styles from '../AtomDetailView.module.css';
import type { AtomRendererProps } from './types';

/**
 * Operator-intent renderer. The intent atom is the substrate's
 * authorized-by-operator authorization slip. Its trust_envelope
 * (min_plan_confidence + max_blast_radius + allowed_sub_actors +
 * expires_at) defines what plans derived from it can be
 * autonomously approved per pol-plan-autonomous-intent-approve.
 *
 * Surfacing the envelope explicitly is operator-critical: it answers
 * "what did the operator actually authorize?" without grepping JSON.
 */
export function OperatorIntentRenderer({ atom }: AtomRendererProps) {
  const meta = asRecord(atom.metadata) ?? {};
  const envelope = asRecord(meta['trust_envelope']);
  const minPlanConfidence = envelope ? asNumber(envelope['min_plan_confidence']) : null;
  const maxBlastRadius = envelope ? asString(envelope['max_blast_radius']) : null;
  const allowedSubActors = envelope ? asStringArray(envelope['allowed_sub_actors']) : [];
  const expiresAt = envelope ? asString(envelope['expires_at']) : null;

  return (
    <>
      <Section title="Operator intent" testId="atom-detail-intent-content">
        <pre className={styles.proseBody}>{atom.content || '(no intent body)'}</pre>
      </Section>

      {envelope && (
        <Section title="Trust envelope" testId="atom-detail-intent-envelope">
          <dl className={styles.attrs}>
            {minPlanConfidence !== null && (
              <AttrRow
                label="Min plan confidence"
                value={minPlanConfidence.toFixed(2)}
                testId="atom-detail-intent-min-plan-confidence"
              />
            )}
            {maxBlastRadius && (
              <AttrRow
                label="Max blast radius"
                value={<code>{maxBlastRadius}</code>}
                testId="atom-detail-intent-blast-radius"
              />
            )}
            {expiresAt && (
              <AttrRow
                label="Expires"
                value={formatDate(expiresAt)}
                testId="atom-detail-intent-expires"
              />
            )}
          </dl>
          {allowedSubActors.length > 0 && (
            <div>
              <h4 className={styles.attrLabel}>{`Allowed sub-actors (${allowedSubActors.length})`}</h4>
              <ul className={styles.refList} data-testid="atom-detail-intent-allowed-sub-actors">
                {allowedSubActors.map((id) => (
                  <li key={id} className={styles.refItem}><code>{id}</code></li>
                ))}
              </ul>
            </div>
          )}
        </Section>
      )}
    </>
  );
}
