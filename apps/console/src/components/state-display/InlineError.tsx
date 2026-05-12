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
 * `label` overrides the default "Failed to load:" prefix so the same
 * primitive can carry mutation-failure semantics ("Could not file the
 * intent:") without forking the visual chrome. The label is the
 * sole textual seam; the icon + status-danger ink + single-line shape
 * stay identical so a forms-error and a query-error read alike.
 */
interface Props {
  readonly message: string;
  readonly testId?: string;
  /**
   * Optional label that replaces the default "Failed to load:" prefix.
   * Use for mutation failures whose copy reads "Could not <verb>:" or
   * similar. Pure cosmetic; the rest of the visual shape is preserved.
   */
  readonly label?: string;
}

export function InlineError({ message, testId, label = 'Failed to load:' }: Props) {
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
      <span className={styles.label}>{label}</span>
      <code className={styles.detail}>{message}</code>
    </p>
  );
}
