import { useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getPrincipalSkill } from '@/services/principals.service';
import { toErrorMessage } from '@/services/errors';
import { ErrorState } from '@/components/state-display/StateDisplay';
import styles from './PrincipalSkill.module.css';

/**
 * Surfaces the principal's "soul" content: the markdown skill doc
 * paired at .claude/skills/<id>/SKILL.md, fetched via the API.
 *
 * Rendered only in focus mode (/principals/<id>) so the grid view
 * stays compact. Three states are explicit:
 *   - Loading: skeleton-style placeholder, no spinner.
 *   - No skill yet: a small empty-state prompt explaining what's
 *     missing, so the absence is informative rather than mysterious.
 *   - Has skill: full markdown render under a section heading.
 *
 * The fetch is cheap (single file read on the server) so we re-fetch
 * per principal navigation; no aggressive caching, no shared store.
 */
interface Props {
  readonly principalId: string;
}

export function PrincipalSkill({ principalId }: Props) {
  const query = useQuery({
    queryKey: ['principal-skill', principalId],
    queryFn: ({ signal }) => getPrincipalSkill(principalId, signal),
  });

  if (query.isPending) {
    return (
      <section className={styles.section} data-testid="principal-skill-loading">
        <h3 className={styles.heading}>Skill</h3>
        <div className={styles.skeleton} aria-hidden="true" />
      </section>
    );
  }

  if (query.isError) {
    /*
     * ErrorState is the canonical primitive for query failures.
     * Earlier this rendered a bespoke <p className={styles.error}>
     * that drifted from the shared design - a flat error string
     * instead of the title + monospace-detail card pattern used
     * by every other view in the console.
     */
    return (
      <section className={styles.section} data-testid="principal-skill-error">
        <h3 className={styles.heading}>Skill</h3>
        <ErrorState
          title="Failed to load skill content"
          message={toErrorMessage(query.error)}
          testId="principal-skill-error-state"
        />
      </section>
    );
  }

  /*
   * Treat empty/whitespace-only content as "no skill yet" so a
   * zero-byte SKILL.md (a half-finished edit, or `touch` placeholder)
   * doesn't render an empty markdown block. The empty-state copy is
   * informative; an empty render is just confusing.
   */
  const raw = query.data?.content ?? null;
  const content = raw !== null && raw.trim().length > 0 ? raw : null;
  if (content === null) {
    return (
      <section className={styles.section} data-testid="principal-skill-empty">
        <h3 className={styles.heading}>Skill</h3>
        <p className={styles.empty}>
          No <code>.claude/skills/{principalId}/SKILL.md</code> yet. The principal's
          authority and goals/constraints are defined; their lens prose has not been authored.
        </p>
      </section>
    );
  }

  return (
    <section className={styles.section} data-testid="principal-skill-content">
      <h3 className={styles.heading}>Skill</h3>
      <div className={styles.markdown}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    </section>
  );
}
