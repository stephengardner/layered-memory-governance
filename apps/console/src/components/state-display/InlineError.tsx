import { AlertCircle } from 'lucide-react';
import styles from './InlineError.module.css';

/**
 * Compact, single-line error hint for sub-block useQuery callsites
 * that previously silent-absorbed failures because they only rendered
 * on `query.data?.length > 0`. Where ErrorState is the centered card
 * for a top-level view ("the screen could not load"), InlineError is
 * the quieter sibling for a section inside an already-loaded surface
 * ("this auxiliary block could not load; the rest of the page is
 * fine").
 *
 * Tone choices:
 *   - role="status" + aria-live="polite" (NOT role="alert"). The
 *     parent surface already mounted; an in-card hint should not
 *     interrupt screen readers as if the page itself failed.
 *   - subdued opacity + status-danger ink. Caught at glance but does
 *     not dominate over the section's primary content surrounding it.
 *   - inline flex layout, single line. No card chrome, no spinner,
 *     no centered padding stack -- those belong to ErrorState.
 *
 * Follow-up to PR #300, which unified the canonical ErrorState across
 * top-level views. The five sub-block callsites (CanonCard.ReferencedBy,
 * WhyThisAtom, CascadeIfTainted, AtomDetailView.ReferencedByBlock,
 * PrincipalsView.statsQuery) all need a quieter shape than ErrorState
 * because they render inside an expanded card or beside a primary
 * count; a centered danger-toned card would visually dominate the
 * surface they sit inside.
 */
interface Props {
  readonly message: string;
  readonly testId?: string;
}

export function InlineError({ message, testId }: Props) {
  return (
    <p
      className={styles.inlineError}
      role="status"
      aria-live="polite"
      data-testid={testId}
    >
      <AlertCircle
        size={12}
        strokeWidth={2.25}
        aria-hidden="true"
        className={styles.icon}
      />
      <span className={styles.label}>Failed to load:</span>
      <code className={styles.detail}>{message}</code>
    </p>
  );
}
