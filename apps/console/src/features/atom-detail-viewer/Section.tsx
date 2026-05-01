import type { ReactNode } from 'react';
import styles from './AtomDetailView.module.css';

/**
 * Section primitive shared across every renderer in the atom-detail
 * viewer. Each renderer composes one or more Sections; the surrounding
 * shell adds provenance + supersedes + raw-json sections automatically.
 *
 * Why one primitive: keeps the visual rhythm consistent across
 * renderer-specific bodies. A type-specific renderer is responsible
 * for the SHAPE of the data inside the section, never the chrome.
 */
export function Section({
  title,
  children,
  testId,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly testId?: string;
}) {
  return (
    <section className={styles.section} {...(testId ? { 'data-testid': testId } : {})}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      {children}
    </section>
  );
}

export function AttrRow({
  label,
  value,
  mono,
  testId,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly mono?: boolean;
  readonly testId?: string;
}) {
  return (
    <>
      <dt className={styles.attrLabel}>{label}</dt>
      <dd
        className={mono ? styles.attrValueMono : styles.attrValue}
        {...(testId ? { 'data-testid': testId } : {})}
      >
        {value}
      </dd>
    </>
  );
}
