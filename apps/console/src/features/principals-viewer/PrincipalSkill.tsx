import { useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getPrincipalSkill, type PrincipalCategory } from '@/services/principals.service';
import { toErrorMessage } from '@/services/errors';
import { ErrorState } from '@/components/state-display/StateDisplay';
import styles from './PrincipalSkill.module.css';

/**
 * Surfaces the principal's "soul" content: the markdown skill doc
 * paired at .claude/skills/<id>/SKILL.md, fetched via the API.
 *
 * Rendered only in focus mode (/principals/<id>) so the grid view
 * stays compact. The empty-state surface is split four ways by the
 * server-side classifier (`response.category`) so the operator sees
 * the actual reason for an empty surface, not a single ambiguous
 * "no skill yet" line:
 *
 *   - authority-root: apex authority (apex-agent). By design no
 *     playbook.
 *   - authority-anchor: agent that signs other principals
 *     (claude-agent). By design no playbook.
 *   - actor-with-skill: SKILL.md present; renders the markdown.
 *   - actor-skill-debt: leaf actor without a SKILL.md. Real authoring
 *     debt; the surface flags it as such.
 *
 * The rendering uses an inline switch (one statement, four branches)
 * rather than a registry or polymorphic shell. Indirection is
 * introduced only when shared structure is observed across the
 * branches; for now the four blocks are one-screen each.
 *
 * The fetch is cheap (single principal-list scan + single file read
 * on the server) so we re-fetch per principal navigation; no
 * aggressive caching, no shared store.
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
   * Treat empty/whitespace-only content as no-content for rendering
   * purposes. The server already factored this in when computing
   * `category`, but the client narrowing on content is what selects
   * markdown vs the empty-state branch; the two checks must agree.
   */
  const raw = query.data?.content ?? null;
  const content = raw !== null && raw.trim().length > 0 ? raw : null;
  const category = query.data?.category ?? 'actor-skill-debt';

  if (content !== null) {
    /*
     * actor-with-skill is the only category that reaches a content
     * render; the other three always have content === null.
     */
    return (
      <section
        className={styles.section}
        data-testid="principal-skill-content"
        data-category="actor-with-skill"
      >
        <h3 className={styles.heading}>Skill</h3>
        <div className={styles.markdown}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      </section>
    );
  }

  return renderEmpty(category, principalId);
}

/**
 * Render the category-specific empty state. Pulled into a helper so
 * the main component stays under one screen and so each branch can
 * be navigated independently in the diff. The wrapping section uses
 * the same `principal-skill-empty` testId for legacy locator parity
 * AND a `data-category` attribute so Playwright can assert each
 * variant independently of the visible copy.
 */
function renderEmpty(category: PrincipalCategory, principalId: string): JSX.Element {
  switch (category) {
    case 'authority-root':
      return (
        <section
          className={styles.section}
          data-testid="principal-skill-empty"
          data-category="authority-root"
        >
          <h3 className={styles.heading}>Skill</h3>
          <p className={styles.empty}>
            <code>{principalId}</code> is the authority root. The empty surface here is
            by design: apex principals are the trust anchor for the principal hierarchy,
            not executors with a playbook.
          </p>
        </section>
      );
    case 'authority-anchor':
      return (
        <section
          className={styles.section}
          data-testid="principal-skill-empty"
          data-category="authority-anchor"
        >
          <h3 className={styles.heading}>Skill</h3>
          <p className={styles.empty}>
            <code>{principalId}</code> is a trust-relay principal that signs other
            principals. The empty surface here is by design: anchor principals do not own
            an execution playbook of their own; the actors they sign do.
          </p>
        </section>
      );
    case 'actor-skill-debt':
      return (
        <section
          className={styles.section}
          data-testid="principal-skill-empty"
          data-category="actor-skill-debt"
        >
          <h3 className={styles.heading}>Skill</h3>
          <p className={styles.empty}>
            No <code>.claude/skills/{principalId}/SKILL.md</code> yet. This actor is a
            leaf principal in the hierarchy, so the empty surface represents real
            authoring debt: a SKILL.md has not been written.
          </p>
        </section>
      );
    case 'actor-with-skill':
      /*
       * Defensive: the renderer SHOULD have taken the content branch
       * before reaching here. If the server claims actor-with-skill
       * but content is null, the contract has drifted; render a
       * neutral placeholder rather than mis-classifying the principal.
       */
      return (
        <section
          className={styles.section}
          data-testid="principal-skill-empty"
          data-category="actor-with-skill"
        >
          <h3 className={styles.heading}>Skill</h3>
          <p className={styles.empty}>
            Skill content is unavailable. Reload to retry.
          </p>
        </section>
      );
    default: {
      /*
       * Compile-time exhaustiveness guard. If a fifth literal is ever
       * added to PrincipalCategory (the "out of scope" attribution-only
       * category called out in the spec atom is the obvious candidate),
       * TypeScript fails this assignment and the build refuses to ship
       * a renderer that silently returns undefined for the new branch.
       * Throws at runtime as a defensive fallback if the type system
       * is bypassed (e.g. an `as unknown` cast).
       */
      const _exhaustive: never = category;
      throw new Error(`unhandled principal category: ${_exhaustive as string}`);
    }
  }
}
