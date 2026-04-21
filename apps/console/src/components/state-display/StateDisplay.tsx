import type { ReactNode } from 'react';
import styles from './StateDisplay.module.css';

/**
 * Unified loading / error / empty state primitive. Each view's fetch
 * lifecycle rendered the same shape three times with slight copy
 * variation; this collapses all of them into three small components.
 *
 * Why a shared primitive: every view had a near-identical `state` +
 * `spinner` + `errorTitle` + `errorDetail` + `emptyTitle` +
 * `emptyDetail` set of CSS rules. Duplication across four views was
 * load-bearing nothing. One primitive, one set of rules, easier
 * later to swap the spinner for skeleton loaders or a mascot.
 */
interface BaseProps {
  readonly testId?: string;
  readonly children?: ReactNode;
}

export function LoadingState({ label = 'Loading…', testId }: { label?: string; testId?: string }) {
  return (
    <div className={styles.state} data-testid={testId}>
      <div className={styles.spinner} aria-hidden="true" />
      <p className={styles.emptyDetail}>{label}</p>
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  testId,
}: {
  title?: string;
  message: string;
  testId?: string;
}) {
  return (
    <div className={styles.state} data-testid={testId}>
      <p className={styles.errorTitle}>{title}</p>
      <code className={styles.errorDetail}>{message}</code>
    </div>
  );
}

export function EmptyState({
  title,
  detail,
  action,
  testId,
  children,
}: BaseProps & { title: string; detail?: ReactNode; action?: ReactNode }) {
  return (
    <div className={styles.state} data-testid={testId}>
      <p className={styles.emptyTitle}>{title}</p>
      {detail && <p className={styles.emptyDetail}>{detail}</p>}
      {children}
      {action}
    </div>
  );
}
