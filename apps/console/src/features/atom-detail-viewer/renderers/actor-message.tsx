import { AtomRef } from '@/components/atom-ref/AtomRef';
import { Section, AttrRow } from '../Section';
import { asString, asStringArray, asRecord, formatDate } from './helpers';
import styles from '../AtomDetailView.module.css';
import type { AtomRendererProps } from './types';

/**
 * Actor-message renderer. The Inbox V1 primitive: actors mail each
 * other with sender/recipient + topic + body + (optional) deadline +
 * urgency tier. Messages route to a recipient principal's inbox via
 * the Scheduler-driven pickup loop. Acks (`actor-message-ack`) share
 * the same renderer because their fields are a subset.
 */
export function ActorMessageRenderer({ atom }: AtomRendererProps) {
  const meta = asRecord(atom.metadata) ?? {};
  const sender = asString(meta['sender'])
    ?? asString(meta['sender_principal_id'])
    ?? atom.principal_id;
  const recipient = asString(meta['recipient'])
    ?? asString(meta['recipient_principal_id']);
  const topic = asString(meta['topic']);
  const urgency = asString(meta['urgency']);
  const deadline = asString(meta['deadline']) ?? asString(meta['deadline_at']);
  const correlationId = asString(meta['correlation_id']);
  const ackOf = asString(meta['ack_of']) ?? asString(meta['acknowledges']);
  const replyTo = asString(meta['in_reply_to']);
  const attachments = asStringArray(meta['attachments']);

  return (
    <>
      <Section title="Message" testId="atom-detail-message-summary">
        <dl className={styles.attrs}>
          {sender && (
            <AttrRow label="From" value={<code data-testid="atom-detail-message-sender">{sender}</code>} />
          )}
          {recipient && (
            <AttrRow label="To" value={<code data-testid="atom-detail-message-recipient">{recipient}</code>} />
          )}
          {topic && <AttrRow label="Topic" value={topic} testId="atom-detail-message-topic" />}
          {urgency && <AttrRow label="Urgency" value={urgency} />}
          {deadline && <AttrRow label="Deadline" value={formatDate(deadline)} />}
          {correlationId && (
            <AttrRow label="Correlation" value={correlationId} mono />
          )}
          {ackOf && (
            <AttrRow label="Ack of" value={<AtomRef id={ackOf} />} />
          )}
          {replyTo && (
            <AttrRow label="In reply to" value={<AtomRef id={replyTo} />} />
          )}
        </dl>
      </Section>

      {atom.content && (
        <Section title="Body" testId="atom-detail-message-body">
          <pre className={styles.proseBody}>{atom.content}</pre>
        </Section>
      )}

      {attachments.length > 0 && (
        <Section
          title={`Attachments (${attachments.length})`}
          testId="atom-detail-message-attachments"
        >
          <ul className={styles.refList}>
            {attachments.map((id) => (
              <li key={id} className={styles.refItem}>
                <AtomRef id={id} />
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}
