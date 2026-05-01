import { Section } from '../Section';
import styles from '../AtomDetailView.module.css';
import type { AtomRendererProps } from './types';

/**
 * Generic fallback renderer. Used when no type-specific renderer
 * matches `atom.type`. Renders the atom's raw `content` as
 * pre-wrapped prose plus a metadata block as JSON; provenance,
 * supersedes, references, and the raw-JSON button are all rendered
 * by the surrounding AtomDetailView shell, so this renderer's only
 * job is the "what's inside this atom" portion that's type-specific.
 *
 * For every UNKNOWN type the substrate ever introduces, this renderer
 * is the safety net: the operator always sees the content + metadata
 * even for a freshly-shipped type that doesn't have a custom renderer
 * yet. Adding a real renderer later is purely additive.
 */
export function GenericRenderer({ atom }: AtomRendererProps) {
  const hasMetadata
    = atom.metadata
    && typeof atom.metadata === 'object'
    && Object.keys(atom.metadata).length > 0;

  return (
    <>
      <Section title="Content" testId="atom-detail-content">
        <pre className={styles.proseBody}>{atom.content || '(no content)'}</pre>
      </Section>

      {hasMetadata && (
        <Section title="Metadata" testId="atom-detail-metadata">
          <pre className={styles.codeBlock}>
            {JSON.stringify(atom.metadata, null, 2)}
          </pre>
        </Section>
      )}
    </>
  );
}
